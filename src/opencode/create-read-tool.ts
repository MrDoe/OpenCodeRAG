/**
 * @fileoverview Creates the RAG-backed read tool that returns full file contents with supplementary semantic context.
 */

import fs from "node:fs/promises";
import { tool } from "@opencode-ai/plugin/tool";
import { CODE_SEARCH_FILTER, type EmbeddingProvider, type KeywordIndex, type VectorStore, type SearchResult } from "../core/interfaces.js";
import type { RagConfig } from "../core/config.js";
import { retrieve } from "../retriever/retriever.js";
import { normalizeReadArgs, resolveWorkspacePath } from "./tool-args.js";
import { buildReadQuery } from "./read-query.js";
import { formatHybridReadOutput } from "./read-format.js";
import { retrievalErrorMessage } from "./read-fallback.js";

export interface RagReadToolOptions {
  /** Workspace root directory. */
  worktree: string;
  /** Full RAG configuration. */
  config: RagConfig;
  /** Embedding provider for retrieval. */
  embedder: EmbeddingProvider;
  /** Vector store for retrieval. */
  store: VectorStore;
  /** Optional log file path for debug logging. */
  logFilePath?: string;
  /** Session-level store for last user message text (keyed by sessionID). */
  sessionLastMessage?: Map<string, string>;
  /** Session-level retrieval cache (keyed by sessionID). */
  sessionRetrievalCache?: Map<string, { messageText: string; rawResults: SearchResult[] }>;
  /** Optional keyword index for hybrid search. */
  keywordIndex?: KeywordIndex;
  /** Maximum number of sessions to retain in the retrieval cache. */
  maxSessionCacheSize?: number;
}

/**
 * Create the RAG-backed read tool for OpenCode plugin registration.
 *
 * The tool always returns full file contents. When RAG chunks are available
 * for the file, they are appended as supplementary context after the file.
 */
export function createRagReadTool(
  options: RagReadToolOptions
): ReturnType<typeof tool> {
  const { worktree, config, embedder, store, sessionLastMessage, sessionRetrievalCache, keywordIndex } = options;
  const openCodeCfg = config.openCode;
  const maxContextChunks = openCodeCfg.maxContextChunks;
  const maxReadOutputChars = openCodeCfg.maxReadOutputChars ?? 20000;
  // Over-fetch by 4x so post-filtering (line range, minScore) still yields enough results
  const retrievalTopK = maxContextChunks * 4;
  const readRelatedFilesMax = openCodeCfg.readRelatedFilesMax ?? 5;

  return tool({
    description:
      "Read file contents from the workspace. Returns full file contents with " +
      "relevant RAG context appended when available. " +
      "Provide a file path and optionally a query/reason, line range, or both.",

    args: {
      filePath: tool.schema.string().optional(),
      path: tool.schema.string().optional(),
      absolutePath: tool.schema.string().optional(),
      offset: tool.schema.number().int().optional(),
      limit: tool.schema.number().int().optional(),
      startLine: tool.schema.number().int().optional(),
      endLine: tool.schema.number().int().optional(),
      query: tool.schema.string().optional(),
      reason: tool.schema.string().optional(),
    },

    async execute(args: Record<string, unknown>, ctx?: { sessionID?: string }) {
      let resolvedPath: string | undefined;
      let normalized: { filePath: string; startLine?: number; endLine?: number; query?: string } | undefined;
      try {
        // 1. Normalize and validate arguments
        normalized = normalizeReadArgs(args as never);

        // 2. Resolve workspace path
        resolvedPath = resolveWorkspacePath(worktree, normalized.filePath);

        // 3. Always read the full file from disk
        const fileContent = await fs.readFile(resolvedPath, "utf-8");

        // 4. Run retrieval (best-effort — RAG is supplementary)
        let ragChunks: SearchResult[] = [];
        let relatedFiles: { filePath: string; score: number }[] = [];

        try {
          const sessionID = ctx?.sessionID;
          const messageText = sessionID ? sessionLastMessage?.get(sessionID) ?? "" : "";

          const count = await store.count();
          if (count > 0) {
            let rawResults: SearchResult[];

            if (sessionID && sessionRetrievalCache) {
              const cached = sessionRetrievalCache.get(sessionID);

              // The cache key must include the FILE and line range: without
              // them, the first read of a message reused its retrieval results
              // for every later read of a DIFFERENT file in the same message.
              const cacheKey = `${messageText}::${resolvedPath}::${normalized.startLine ?? ""}-${normalized.endLine ?? ""}`;
              if (cached && cached.messageText === cacheKey) {
                rawResults = cached.rawResults;
              } else {
                const retrievalQuery = buildSessionQuery(messageText, resolvedPath, normalized);
                rawResults = await retrieve(retrievalQuery, embedder, store, { topK: retrievalTopK, keywordIndex, hybridEnabled: config.retrieval.hybridSearch?.enabled, queryPrefix: config.embedding.queryPrefix, filter: CODE_SEARCH_FILTER });
                const maxSize = options.maxSessionCacheSize ?? 50;
                if (!sessionRetrievalCache.has(sessionID) && sessionRetrievalCache.size >= maxSize) {
                  const oldest = sessionRetrievalCache.keys().next().value;
                  if (oldest !== undefined) sessionRetrievalCache.delete(oldest);
                }
                sessionRetrievalCache.set(sessionID, { messageText: cacheKey, rawResults });
              }
            } else {
              const retrievalQuery = buildReadQuery({
                query: normalized.query,
                filePath: resolvedPath,
                startLine: normalized.startLine,
                endLine: normalized.endLine,
              });
              rawResults = await retrieve(retrievalQuery, embedder, store, { topK: retrievalTopK, keywordIndex, hybridEnabled: config.retrieval.hybridSearch?.enabled, queryPrefix: config.embedding.queryPrefix, filter: CODE_SEARCH_FILTER });
            }

            // Collect related files from raw results (before filtering)
            relatedFiles = collectRelatedFiles(rawResults, resolvedPath, readRelatedFilesMax);

            // Filter to the requested file
            const filtered = rawResults.filter(
              (r) => r.chunk.metadata.filePath === resolvedPath
            );

            // Apply line-range overlap filtering
            const lineFiltered = applyLineRangeFilter(
              filtered,
              normalized.startLine,
              normalized.endLine
            );

            // Sort by score descending and limit
            lineFiltered.sort((a, b) => b.score - a.score);
            ragChunks = lineFiltered.slice(0, maxContextChunks);
          }
        } catch {
          // Retrieval failed — continue with just the file contents
        }

        // 5. Format output: full file + optional RAG context
        const output = formatHybridReadOutput({
          filePath: resolvedPath,
          fileContent,
          startLine: normalized.startLine,
          endLine: normalized.endLine,
          ragChunks,
          relatedFiles,
          maxChars: maxReadOutputChars,
        });

        // 6. Return
        return {
          title: `Read — ${resolvedPath}`,
          output,
          metadata: {
            tool: "read",
            filePath: resolvedPath,
            chunks: ragChunks.length,
            indexed: ragChunks.length > 0,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        // Distinguish path problems (ENOENT / outside workspace) from RAG
        // retrieval failures — "OpenCodeRAG retrieval failed" was misleading
        // for a simple missing file.
        const isPathProblem = code === "ENOENT" || code === "EACCES" || /ENOENT|outside the workspace|does not exist/i.test(message);
        return {
          title: "Read",
          output: isPathProblem
            ? `Could not read file: ${message}`
            : retrievalErrorMessage(message),
          metadata: {
            tool: "read",
            filePath: resolvedPath,
            error: message,
          },
        };
      }
    },
  });
}

/**
 * Filter search results by line-range overlap.
 *
 * A chunk overlaps the requested range when:
 *   chunk.startLine <= requestedEndLine && chunk.endLine >= requestedStartLine
 *
 * If only startLine is provided: chunk.endLine >= requestedStartLine
 * If only endLine is provided: chunk.startLine <= requestedEndLine
 */
function applyLineRangeFilter(
  results: SearchResult[],
  startLine?: number,
  endLine?: number
): SearchResult[] {
  if (startLine === undefined && endLine === undefined) {
    return results;
  }

  return results.filter((r) => {
    const cs = r.chunk.metadata.startLine;
    const ce = r.chunk.metadata.endLine;

    if (startLine !== undefined && endLine !== undefined) {
      return cs <= endLine && ce >= startLine;
    }
    if (startLine !== undefined) {
      return ce >= startLine;
    }
    if (endLine !== undefined) {
      return cs <= endLine;
    }
    return true;
  });
}

/** Arguments for building a session-level retrieval query. */
interface SessionQueryArgs {
  query?: string;
  startLine?: number;
  endLine?: number;
}

/**
 * Build a retrieval query from the session's user message plus file path hints.
 *
 * When message text is available, it becomes the primary semantic query with
 * the file path as a targeted hint. When no message text exists, falls back
 * to the standard file-path-based query.
 */
function buildSessionQuery(
  messageText: string,
  resolvedPath: string,
  normalized: SessionQueryArgs
): string {
  // Use message text as the semantic query if available
  if (messageText.length > 0) {
    // Include file path info so the embedding narrows to that file
    const parts = [
      messageText,
      `Looking for relevant code in file: ${resolvedPath}`,
    ];
    if (normalized.startLine !== undefined && normalized.endLine !== undefined) {
      parts.push(`Focus on lines ${normalized.startLine}-${normalized.endLine}.`);
    } else if (normalized.startLine !== undefined) {
      parts.push(`Focus on lines near ${normalized.startLine}.`);
    }
    return parts.join("\n");
  }

  // Fall back to standard query
  return buildReadQuery({
    query: normalized.query,
    filePath: resolvedPath,
    startLine: normalized.startLine,
    endLine: normalized.endLine,
  });
}

/** A collected related file entry. */
interface RelatedFileEntry {
  filePath: string;
  score: number;
}

/**
 * Collect unique related files from raw search results, excluding the
 * requested file. Keeps the best score per file path and returns at most
 * `maxRelated` entries sorted by score descending.
 */
function collectRelatedFiles(
  rawResults: SearchResult[],
  requestedFile: string,
  maxRelated: number
): RelatedFileEntry[] {
  if (maxRelated <= 0 || rawResults.length === 0) return [];

  const bestScore = new Map<string, number>();

  for (const r of rawResults) {
    const fp = r.chunk.metadata.filePath;
    if (fp === requestedFile) continue;
    const current = bestScore.get(fp);
    if (current === undefined || r.score > current) {
      bestScore.set(fp, r.score);
    }
  }

  return Array.from(bestScore.entries())
    .map(([filePath, score]) => ({ filePath, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxRelated);
}
