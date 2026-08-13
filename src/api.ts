/**
 * @fileoverview High-level public API for OpenCodeRAG: search, indexWorkspace, getContext,
 * scanWorkspace, and related types.
 */

import { resolveRagContext } from "./core/bootstrap.js";
import { retrieve } from "./retriever/retriever.js";
import type { RetrieveOptions } from "./retriever/retriever.js";
import { optimizeContext, DEFAULT_CONTEXT_OPTIMIZATION } from "./retriever/context-optimizer.js";
import { runIndexPass, type IndexRunStats } from "./indexer.js";
import { scanWorkspaceFiles, type WorkspaceFile } from "./content/reader.js";
import { CODE_SEARCH_FILTER, type SearchResult } from "./core/interfaces.js";
import { destroyAllPooledConnections } from "./embedder/http.js";

/** Options controlling a semantic search query. */
export interface SearchOptions {
  /** Working directory to resolve relative paths against. */
  cwd?: string;
  /** Path to the opencode-rag.json config file. */
  configPath?: string;
  /** Maximum number of results to return (1-25). */
  topK?: number;
  /** Minimum relevance score threshold (0-1). */
  minScore?: number;
  /** Weight for hybrid keyword search (0-1). */
  keywordWeight?: number;
  /** Filter results to files matching these path patterns. */
  pathHints?: string[];
  /** Filter results to files matching these language identifiers. */
  languageHints?: string[];
  /** Filter results to files matching these dot-prefixed extensions (e.g. [".ts"]). */
  fileExtensions?: string[];
  /** Include explanation metadata in results. */
  explain?: boolean;
}

/** Options controlling workspace indexing. */
export interface IndexOptions {
  /** Path to the opencode-rag.json config file. */
  configPath?: string;
  /** Force re-indexing even if already up to date. */
  force?: boolean;
  /** Callback invoked with progress messages during indexing. */
  onProgress?: (message: string) => void;
}

/** The result of a context retrieval — matched chunks plus formatted text. */
export interface ContextResult {
  /** Individual search results with chunk and score data. */
  chunks: SearchResult[];
  /** Formatted markdown text combining all results. */
  text: string;
}

/**
 * Format a list of search results into a human-readable markdown block.
 * Each result is rendered as a code block with metadata header.
 */
function formatContextResults(results: SearchResult[]): string {
  if (results.length === 0) return "No matching chunks found.";

  const lines: string[] = [];
  for (const r of results) {
    const { filePath, startLine, endLine, language } = r.chunk.metadata;
    lines.push(`#### ${filePath}:${startLine}-${endLine} (score: ${r.score.toFixed(3)})`);
    lines.push("```" + language);
    lines.push(r.chunk.content);
    lines.push("```");
    if (r.chunk.description) {
      lines.push(`> ${r.chunk.description}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Perform a semantic search against the indexed workspace.
 * Bootstraps the RAG context (config, embedder, store) automatically.
 *
 * @param query - Natural language search query describing what to find.
 * @param options - Optional search parameters (topK, filters, etc.).
 * @returns An ordered array of search results with relevance scores.
 */
export async function search(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const ctx = await resolveRagContext({
    cwd: options.cwd,
    configPath: options.configPath,
  });

  try {
    const topK = options.topK ?? ctx.config.retrieval.topK;
    const rawResults = await retrieve(query, ctx.embedder, ctx.store, {
      topK,
      minScore: options.minScore ?? ctx.config.retrieval.minScore,
      keywordIndex: ctx.keywordIndex,
      keywordWeight: options.keywordWeight ?? ctx.config.retrieval.hybridSearch?.keywordWeight ?? 0.4,
      hybridEnabled: ctx.config.retrieval.hybridSearch?.enabled,
      queryPrefix: ctx.config.embedding.queryPrefix,
      explain: options.explain,
      filter: {
        pathPatterns: options.pathHints,
        languages: options.languageHints,
        fileExtensions: options.fileExtensions,
        kinds: CODE_SEARCH_FILTER.kinds,
      },
    } satisfies RetrieveOptions);

    const optCfg = ctx.config.retrieval.contextOptimization ?? DEFAULT_CONTEXT_OPTIMIZATION;
    return optimizeContext(rawResults, { topK, config: optCfg });
  } finally {
    await ctx.store.close();
    ctx.keywordIndex.close();
    destroyAllPooledConnections();
  }
}

/**
 * Index (or re-index) the workspace files into the vector store.
 * Reads the config, chunks all source files, embeds them, and writes to the store.
 *
 * @param cwd - Working directory to index (defaults to process.cwd()).
 * @param options - Optional indexing parameters.
 * @returns Statistics about the indexing run (files, chunks, etc.).
 */
export async function indexWorkspace(
  cwd?: string,
  options: IndexOptions = {}
): Promise<IndexRunStats> {
  const workDir = cwd ?? process.cwd();
  const ctx = await resolveRagContext({
    cwd: workDir,
    configPath: options.configPath,
  });

  try {
    if (options.onProgress) {
      options.onProgress(`Indexing ${workDir}...`);
    }

    const stats = await runIndexPass({
      cwd: workDir,
      storePath: ctx.storePath,
      config: ctx.config,
      store: ctx.store,
      embedder: ctx.embedder,
      force: options.force ?? false,
      keywordIndex: ctx.keywordIndex,
      descriptionProvider: ctx.descriptionProvider,
    });

    return stats;
  } finally {
    await ctx.store.close();
    ctx.keywordIndex.close();
    destroyAllPooledConnections();
  }
}

/**
 * Retrieve and format context chunks for a query in one call.
 * Combines `search()` with automatic formatting into a markdown block.
 *
 * @param query - Natural language query to search for.
 * @param options - Optional search parameters.
 * @returns A ContextResult with both raw chunks and formatted text.
 */
export async function getContext(
  query: string,
  options: SearchOptions = {}
): Promise<ContextResult> {
  const results = await search(query, options);
  return {
    chunks: results,
    text: formatContextResults(results),
  };
}

/** Validate an opencode-rag.json configuration file. */
export { validateConfig } from "./core/config.js";
export type { ConfigValidationResult } from "./core/config.js";
/** Scan workspace files and return a summary of indexing status. */
export { getIndexStatusSummary } from "./indexer.js";
export type { IndexRunStats } from "./indexer.js";
export type { WorkspaceFile } from "./content/reader.js";

import type { Logger } from "./indexer/pipeline.js";

/**
 * Scan the workspace directory for indexable files according to the configuration.
 * @param cwd - Root directory to scan.
 * @param config - Workspace RAG configuration.
 * @param logger - Optional logger.
 */
export async function scanWorkspace(
  cwd: string,
  config: import("./core/config.js").RagConfig,
  logger?: Logger,
): Promise<WorkspaceFile[]> {
  return scanWorkspaceFiles(cwd, config, logger);
}
