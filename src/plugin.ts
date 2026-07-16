/**
 * @fileoverview OpenCode plugin integration for OpenCodeRAG. Registers semantic search,
 * file skeleton, find usages, and describe image tools; hooks into chat messages for
 * automatic context injection and documentation mode.
 */

import type { Plugin, PluginInput, Hooks, ToolDefinition } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";
import type { EmbeddingProvider, DescriptionProvider, KeywordIndex, VectorStore, SearchResult } from "./core/interfaces.js";
import { loadConfig, findConfigFile, DEFAULT_CONFIG, resolveLogConfig, persistProbedDimension, type RagConfig } from "./core/config.js";
import { createEmbedder } from "./embedder/factory.js";
import { createDescriptionProvider } from "./describer/factory.js";
import { createVectorStore } from "./vectorstore/factory.js";
import { retrieve } from "./retriever/retriever.js";
import { optimizeContext, DEFAULT_CONTEXT_OPTIMIZATION } from "./retriever/context-optimizer.js";
import { loadChunkersFromConfig } from "./chunker/loader.js";
import { appendDebugLog } from "./core/fileLogger.js";
import { loadRuntimeOverrides, applyRuntimeOverrides } from "./core/runtime-overrides.js";
import { createBackgroundIndexer } from "./watcher.js";
import { createRagReadTool } from "./opencode/create-read-tool.js";
import {
  createFileSkeletonTool,
  createFindUsagesTool,
  createDescribeImageTool,
} from "./opencode/tools.js";
import { resolveApiKey } from "./core/resolve-api-key.js";
import { consumePendingRagInjection } from "./core/rag-injection-flag.js";
import { loadDocProgress, markSubdirectoryDocumented } from "./core/doc-progress.js";
import { loadManifest } from "./core/manifest.js";
import { createSessionLogger, type SessionLogger } from "./eval/session-logger.js";
import { countTokens } from "./eval/token-counter.js";
import { checkForUpdate, type UpdateInfo } from "./core/version-check.js";
import { destroyAllPooledConnections } from "./embedder/http.js";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";
import { tmpdir } from "node:os";

/** Maximum entries per session map before oldest entries are evicted. */
const MAX_SESSION_MAP_SIZE = 50;

/** Cache of loaded RAG configurations keyed by workspace directory. */
const configCache = new Map<string, RagConfig>();
/** Active background indexer instances keyed by workspace directory. */
const backgroundIndexers = new Map<string, { close: () => Promise<void> }>();
/** Active MCP server instances keyed by workspace directory. */
const mcpServers = new Map<string, { close: () => Promise<void> }>();
/** Pending update notifications keyed by workspace directory. */
const pendingUpdateInfo = new Map<string, UpdateInfo>();

/** Guard flag to prevent re-entrant shutdown. */
let shutdownRegistered = false;

/** Close all active background indexers and MCP servers, then destroy idle sockets. */
async function shutdownPluginResources(): Promise<void> {
  for (const [dir, indexer] of backgroundIndexers) {
    try { await indexer.close(); } catch { /* best-effort */ }
    backgroundIndexers.delete(dir);
  }
  for (const [dir, server] of mcpServers) {
    try { await server.close(); } catch { /* best-effort */ }
    mcpServers.delete(dir);
  }
  configCache.clear();
  pendingUpdateInfo.clear();
  destroyAllPooledConnections();
}

/** Register a process.beforeExit handler so that resources are cleaned up
 *  when the OpenCode process exits (rather than only on plugin reload). */
function registerShutdownHandler(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  process.once("beforeExit", () => {
    void shutdownPluginResources();
  });
}

registerShutdownHandler();

/** Set a bounded Map entry, evicting the oldest key if the map exceeds maximum size. */
function boundedSet<V>(map: Map<string, V>, key: string, value: V, maxSize: number): void {
  if (map.has(key)) {
    map.set(key, value);
    return;
  }
  if (map.size >= maxSize) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** Name of the semantic search tool as exposed to the LLM. */
const CONTEXT_TOOL_NAME = "search_semantic";
/** Marker string injected into context output to identify RAG-sourced content. */
const CONTEXT_MARKER = "search_semantic retrieved context";

/** Hints that refine a semantic retrieval query. */
type RetrievalQueryHints = {
  /** The natural language search query. */
  query: string;
  /** Optional directory/file path patterns to narrow results. */
  pathHints?: string[];
  /** Optional language identifiers to filter results. */
  languageHints?: string[];
  /** Maximum number of results to return. */
  topK?: number;
};

/**
 * Append a verbose log entry with an optional structured payload.
 * The payload is serialised using formatLogPayload for readability.
 */
function appendVerboseLog(
  logFilePath: string,
  scope: string,
  message: string,
  payload?: unknown,
  logLevel?: string,
): void {
  appendDebugLog(logFilePath, {
    scope,
    message: payload
      ? `${message}\n${formatLogPayload(payload)}`
      : message,
  }, logLevel);
}

/**
 * Format an arbitrary value as a human-readable indented string
 * for debug logging. Handles null, primitives, arrays, and nested objects.
 */
function formatLogPayload(value: unknown, indent = 0): string {
  const prefix = "  ".repeat(indent);

  if (value === null) {
    return `${prefix}null`;
  }

  if (typeof value === "string") {
    return indentMultiline(value, indent);
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${prefix}${String(value)}`;
  }

  if (typeof value === "undefined") {
    return `${prefix}undefined`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${prefix}[]`;
    }

    return value
      .map((item) => {
        if (item === null || typeof item === "number" || typeof item === "boolean" || typeof item === "bigint") {
          return `${prefix}- ${String(item)}`;
        }

        if (typeof item === "undefined") {
          return `${prefix}- undefined`;
        }

        if (typeof item === "string") {
          return `${prefix}- ${item.includes("\n") ? `\n${indentMultiline(item, indent + 1)}` : item}`;
        }

        return `${prefix}-\n${formatLogPayload(item, indent + 1)}`;
      })
      .join("\n");
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return `${prefix}{}`;
    }

    return entries
      .map(([key, nested]) => {
        if (nested === null || typeof nested === "number" || typeof nested === "boolean" || typeof nested === "bigint") {
          return `${prefix}${key}: ${String(nested)}`;
        }

        if (typeof nested === "undefined") {
          return `${prefix}${key}: undefined`;
        }

        if (typeof nested === "string") {
          return `${prefix}${key}:\n${indentMultiline(nested, indent + 1)}`;
        }

        return `${prefix}${key}:\n${formatLogPayload(nested, indent + 1)}`;
      })
      .join("\n");
  }

  return `${prefix}${String(value)}`;
}

/**
 * Indent every line of a multi-line string by the given number of
 * two-space indentation levels.
 */
function indentMultiline(text: string, indent: number): string {
  const prefix = "  ".repeat(indent);
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

/**
 * Load the RAG configuration for a directory, searching in order:
 * opencode-rag.json, .opencode/opencode-rag.json, .opencode/rag.json.
 * Caches the result per directory.
 */
async function getConfig(directory: string): Promise<RagConfig> {
  const cached = configCache.get(directory);
  if (cached) return cached;

  const configPath = findConfigFile(directory);
  if (configPath) {
    try {
      const cfg = loadConfig(configPath);
      await loadChunkersFromConfig(cfg, path.dirname(configPath));
      configCache.set(directory, cfg);
      return cfg;
    } catch (err) {
      appendDebugLog(path.resolve(directory, ".opencode", "opencode-rag.log"), {
        scope: "config",
        message: `Failed to load config from ${configPath}`,
        error: err,
      });
    }
  }

  configCache.set(directory, DEFAULT_CONFIG);
  return DEFAULT_CONFIG;
}

/**
 * Format retrieval results into a Markdown context block for LLM injection.
 * Includes per-chunk file paths, line numbers, relevance scores, and descriptions.
 */
function formatContext(
  results: Awaited<ReturnType<typeof retrieve>>
): string {
  if (results.length === 0) return "";

  const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;

  const parts: string[] = [];
  parts.push(`\n**${CONTEXT_MARKER}** _(context: ${results.length} chunks, avg relevance: ${avgScore.toFixed(2)})_\n`);
  parts.push("---\n");

  for (const r of results) {
    const m = r.chunk.metadata;
    parts.push(
      `[${m.filePath}:${m.startLine}-${m.endLine}] (${m.language}, score: ${r.score.toFixed(2)})`
    );
    if (r.chunk.description) {
      parts.push(`> ${r.chunk.description}`);
    }
    parts.push("```" + m.language);
    parts.push(r.chunk.content);
    parts.push("```\n");
  }

  parts.push("---\n");
  return parts.join("\n");
}

/** Format retrieved code chunks for injection into a user message (used by hotkey "chunks" mode). */
function formatAutoInjectContext(
  results: SearchResult[],
  worktree: string,
  maxTokens: number,
  maxChunks: number
): string {
  if (results.length === 0) return "";

  const sorted = [...results].sort((a, b) => b.score - a.score);
  const included = sorted.slice(0, maxChunks);

  const buildString = (items: SearchResult[]): string => {
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const uniqueFiles = new Set(items.map((r) => r.chunk.metadata.filePath));
    const minScore = last.score;
    const maxScore = first.score;

    const lines: string[] = [];
    lines.push(`\n**Auto-retrieved code context** _(context: ${items.length} chunk${items.length === 1 ? "" : "s"}, ${uniqueFiles.size} file${uniqueFiles.size === 1 ? "" : "s"}, relevance ${minScore.toFixed(2)}–${maxScore.toFixed(2)})_\n`);
    lines.push("---\n");

    for (const r of items) {
      const m = r.chunk.metadata;
      const relPath = path.relative(worktree, m.filePath).replace(/\\/g, "/");
      lines.push(`[${relPath}:${m.startLine}-${m.endLine}] (${m.language}, score: ${r.score.toFixed(2)})`);
      if (r.chunk.description) {
        lines.push(`> ${r.chunk.description}`);
      }
      lines.push("```" + m.language);
      lines.push(r.chunk.content);
      lines.push("```\n");
    }

    lines.push("---");
    return lines.join("\n");
  };

  let formatted = buildString(included);
  while (countTokens(formatted) > maxTokens && included.length > 1) {
    included.pop();
    formatted = buildString(included);
  }

  return formatted;
}

/**
 * Build the effective query string from a RetrievalQueryHints object,
 * appending path and language hints as additional context.
 */
function buildRetrievalQuery(hints: RetrievalQueryHints): string {
  const parts: string[] = [hints.query.trim()];

  const pathHints = hints.pathHints?.map((hint) => hint.trim()).filter((hint) => hint.length > 0) ?? [];
  if (pathHints.length > 0) {
    parts.push(`Path hints: ${pathHints.join(", ")}`);
  }

  const languageHints = hints.languageHints?.map((hint) => hint.trim()).filter((hint) => hint.length > 0) ?? [];
  if (languageHints.length > 0) {
    parts.push(`Language hints: ${languageHints.join(", ")}`);
  }

  return parts.join("\n").trim();
}

/**
 * Perform a retrieval query against the vector store with the given parameters.
 * Returns an empty array for blank queries.
 */
async function retrieveContext(
  query: string,
  embedder: EmbeddingProvider,
  store: VectorStore,
  topK: number,
  retrieveFn: typeof retrieve = retrieve,
  minScore = 0,
  keywordIndex?: KeywordIndex,
  keywordWeight?: number,
  queryPrefix?: string,
  explain = false,
  hybridEnabled?: boolean
): Promise<SearchResult[]> {
  if (query.trim().length === 0) return [];
  return retrieveFn(query, embedder, store, { topK, minScore, keywordIndex, keywordWeight, hybridEnabled, queryPrefix, explain });
}

/**
 * Load results from one or two queries (primary + optional extra), optimize
 * them via context optimization (adjacent merge, similarity dedup, file cap),
 * sort by descending score, and limit to maxContextChunks from config.
 */
async function loadRetrievedResults(
  query: string,
  embedder: EmbeddingProvider,
  store: VectorStore,
  cfg: RagConfig,
  retrieveFn: typeof retrieve = retrieve,
  topK = cfg.retrieval.topK,
  extraQuery?: string,
  keywordIndex?: KeywordIndex,
  queryPrefix?: string,
  explain = false
): Promise<SearchResult[]> {
  const minScore = cfg.retrieval.minScore;
  const kw = cfg.retrieval.hybridSearch?.keywordWeight;
  const hybridEnabled = cfg.retrieval.hybridSearch?.enabled;
  const primaryResults = await retrieveContext(query, embedder, store, topK, retrieveFn, minScore, keywordIndex, kw, queryPrefix, explain, hybridEnabled);
  const extraResults = extraQuery
    ? await retrieveContext(extraQuery, embedder, store, topK, retrieveFn, minScore, keywordIndex, kw, queryPrefix, explain, hybridEnabled)
    : [];

  const optCfg = cfg.retrieval.contextOptimization ?? DEFAULT_CONTEXT_OPTIMIZATION;
  return optimizeContext([...primaryResults, ...extraResults], { topK, config: optCfg })
    .sort((a, b) => b.score - a.score)
    .slice(0, cfg.openCode.maxContextChunks);
}

/** Internal dependencies that can be overridden for testing. */
type RagPluginDependencies = {
  createEmbedder: typeof createEmbedder;
  createStore: (storePath: string, dimension: number, config: RagConfig) => VectorStore;
  retrieve: typeof retrieve;
};

/** Default set of plugin dependencies using the real implementations. */
const defaultDependencies: RagPluginDependencies = {
  createEmbedder,
  createStore: (storePath, dimension, config) => createVectorStore(config, storePath, dimension),
  retrieve,
};

/** Options for constructing the RAG hooks object. */
type CreateRagHooksOptions = {
  /** Loaded RAG configuration. */
  cfg: RagConfig;
  /** Absolute path to the vector store directory. */
  storePath: string;
  /** Path to the debug log file. */
  logFilePath: string;
  /** Log level for controlling verbosity. */
  logLevel?: string;
  /** The workspace root directory. */
  worktree: string;
  /** Optional dependency overrides (for testing). */
  dependencies?: Partial<RagPluginDependencies>;
  /** Pre-created vector store instance. */
  store?: VectorStore;
  /** Pre-created embedding provider instance. */
  embedder?: EmbeddingProvider;
  /** Pre-loaded keyword index for hybrid search. */
  keywordIndex?: KeywordIndex;
  /** Pre-created description provider for chunk descriptions. */
  descriptionProvider?: DescriptionProvider;
};

/**
 * Format a list of relevant files (aggregated from chunks) for display.
 * Groups chunks by file path and sorts by maximum relevance score.
 * Includes an AGENTS.md-style tool usage reminder at the end.
 */
function formatFileList(results: SearchResult[], worktree: string, maxFiles = 10): string {
  const fileMap = new Map<string, { lines: number[]; scores: number[] }>();

  for (const r of results) {
    const m = r.chunk.metadata;
    const existing = fileMap.get(m.filePath);
    if (existing) {
      existing.lines.push(m.startLine, m.endLine);
      existing.scores.push(r.score);
    } else {
      fileMap.set(m.filePath, {
        lines: [m.startLine, m.endLine],
        scores: [r.score],
      });
    }
  }

  const sorted = [...fileMap.entries()]
    .sort((a, b) => Math.max(...b[1].scores) - Math.max(...a[1].scores))
    .slice(0, maxFiles);

  if (sorted.length === 0) return "";

  const lines: string[] = [];
  lines.push("Relevant files:");
  for (const [filePath, info] of sorted) {
    const relPath = path.relative(worktree, filePath).replace(/\\/g, "/");
    const minLine = Math.min(...info.lines);
    const maxLine = Math.max(...info.lines);
    const relevance = Math.max(...info.scores).toFixed(2);
    const lang = results.find((r) => r.chunk.metadata.filePath === filePath)?.chunk.metadata.language ?? "";
    lines.push(`${relPath} (${lang}, lines ${minLine}-${maxLine}, relevance ${relevance})`);
  }
  lines.push("\nFor more context, use: `search_semantic` for code search, `find_usages` before editing, `get_file_skeleton` to orient in files.");
  let linesReturn = lines.join("\n");
  return linesReturn;
}

/**
 * Extract the user message text from chat.message hook input/output.
 *
 * Attempts to find the user's message content from output.message first
 * (via parts/text), then falls back to input fields.
 *
 * @param input - The incoming hook input containing session and message metadata.
 * @param output - The output object potentially containing the user's message parts.
 * @returns The extracted user message text, or an empty string if not found.
 */
function extractUserMessageText(
  _input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string }; messageID?: string; variant?: string },
  output?: { message?: unknown; parts?: unknown[] }
): string {
  // Try to extract from output.parts first (most common path)
  if (output?.message) {
    const msg = output.message as Record<string, unknown>;
    // Check for parts array in message
    const parts = (Array.isArray(msg.parts) ? msg.parts : undefined) ?? output.parts;
    if (parts) {
      const textParts = parts
        .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
        .map((p) => (typeof p.text === "string" ? p.text : ""))
        .filter((t) => t.length > 0);
      if (textParts.length > 0) {
        return textParts.join(" ");
      }
    }
    // Check for content string in message
    if (typeof msg.content === "string" && msg.content.length > 0) {
      return msg.content;
    }
  }
  return "";
}

/**
 * Create the RAG plugin hook implementations for an OpenCode workspace.
 *
 * Wires together the vector store, embedder, keyword index, and description
 * provider into OpenCode's hook system. Handles:
 * - Automatic context injection on chat messages
 * - Documentation mode auto-kickoff
 * - Tool registration (semantic search, file skeleton, find usages, describe image)
 * - Session-level caching and evaluation logging
 *
 * @param options - Configuration and dependencies for building the hooks.
 * @returns A complete set of OpenCode hooks for RAG functionality.
 */
export function createRagHooks(options: CreateRagHooksOptions): Hooks {
  const dependencies: RagPluginDependencies = {
    ...defaultDependencies,
    ...options.dependencies,
  };
  const embedder = options.embedder ?? dependencies.createEmbedder(options.cfg);
  const store = options.store ?? dependencies.createStore(options.storePath, 384, options.cfg);
  const keywordIndex = options.keywordIndex;

  // Runtime overrides for live config editing from TUI
  let cachedOverrides = loadRuntimeOverrides(options.storePath);
  let overridesLastCheck = 0;
  const OVERRIDES_TTL_MS = Number(process.env.OPENCODE_RAG_OVERRIDES_TTL_MS) || 3600000;
  let lastEffectiveCfg: RagConfig | null = null;
  let lastEffectiveCfgTime = 0;

  function getEffectiveCfg(): RagConfig {
    if (Date.now() - overridesLastCheck > OVERRIDES_TTL_MS) {
      cachedOverrides = loadRuntimeOverrides(options.storePath);
      overridesLastCheck = Date.now();
      lastEffectiveCfg = null;
    }
    if (lastEffectiveCfg && Date.now() - lastEffectiveCfgTime < 1000) {
      return lastEffectiveCfg;
    }
    lastEffectiveCfg = applyRuntimeOverrides(options.cfg, cachedOverrides);
    lastEffectiveCfgTime = Date.now();
    return lastEffectiveCfg;
  }

  // Session-level caches for lazy retrieval
  const sessionLastMessage = new Map<string, string>();
  const sessionRetrievalCache = new Map<string, { messageText: string; rawResults: SearchResult[] }>();
  // Track the current assistant message text per session for 2-message search queries.
  const sessionAssistantMessageId = new Map<string, string>();
  const sessionAssistantText = new Map<string, string>();

  // Evaluation session logger — captures OpenCode events for analysis
  const sessionLogger: SessionLogger = createSessionLogger(options.storePath);

  appendDebugLog(options.logFilePath, {
    scope: "plugin",
    message: "OpenCode plugin initialized",
  });

  const readOverride = getEffectiveCfg().openCode.readOverride === true;

  const retrievalTool = tool({
    description:
      "Search the indexed codebase by meaning, not just keywords. " +
      "ESSENTIAL before any code task — replaces blind reading with targeted retrieval. " +
      "Call when the user asks 'how does X work?', 'where is Y?', references files/functions you haven't read, " +
      "or you need to understand code behavior. Returns the most relevant code snippets with file paths, line numbers, and relevance scores.",
    args: {
      query: tool.schema.string().min(1, "A retrieval query is required."),
      pathHints: tool.schema.array(tool.schema.string().min(1)).max(10).optional(),
      languageHints: tool.schema.array(tool.schema.string().min(1)).max(10).optional(),
      topK: tool.schema.number().int().min(1).max(25).optional(),
      explain: tool.schema.boolean().optional(),
    },
    async execute(args) {
      try {
        const count = await store.count();
        if (count === 0) {
          appendVerboseLog(options.logFilePath, CONTEXT_TOOL_NAME, "retrieval requested but no chunks are indexed", {
            query: args.query,
            pathHints: args.pathHints ?? [],
            languageHints: args.languageHints ?? [],
            topK: args.topK ?? getEffectiveCfg().retrieval.topK,
          });

          return {
            title: "Semantic search",
            output:
              "No indexed chunks are available yet. Run indexing first, then try your search again.",
            metadata: {
              query: args.query,
              chunks: 0,
              indexed: false,
            },
          };
        }

        const effectiveCfg = getEffectiveCfg();
        const query = buildRetrievalQuery({
          query: args.query,
          pathHints: args.pathHints,
          languageHints: args.languageHints,
        });
        const topK = args.topK ?? effectiveCfg.retrieval.topK;
        const explain = args.explain ?? false;
        const results = await loadRetrievedResults(query, embedder, store, effectiveCfg, dependencies.retrieve, topK, undefined, keywordIndex, effectiveCfg.embedding.queryPrefix, explain);

        if (results.length === 0) {
          appendVerboseLog(options.logFilePath, CONTEXT_TOOL_NAME, "retrieval completed with no matching chunks", {
            query,
            pathHints: args.pathHints ?? [],
            languageHints: args.languageHints ?? [],
            topK,
          });

          return {
            title: "Semantic search",
            output: `No indexed code matched your query. Try different terms or broaden the search.`,
            metadata: {
              query: args.query,
              chunks: 0,
              indexed: true,
            },
          };
        }

        const output = formatContext(results);

        appendVerboseLog(options.logFilePath, CONTEXT_TOOL_NAME, "retrieval completed successfully", {
          query,
          pathHints: args.pathHints ?? [],
          languageHints: args.languageHints ?? [],
          topK,
          results: results.map((result) => ({
            filePath: result.chunk.metadata.filePath,
            startLine: result.chunk.metadata.startLine,
            endLine: result.chunk.metadata.endLine,
            language: result.chunk.metadata.language,
            score: result.score,
          })),
          output,
        });

        return {
          title: `Semantic search (${results.length} chunk${results.length === 1 ? "" : "s"})`,
          output,
          metadata: {
            query: args.query,
            topK,
            chunks: results.length,
            indexed: true,
            pathHints: args.pathHints ?? [],
            languageHints: args.languageHints ?? [],
          },
        };
      } catch (err) {
        appendDebugLog(options.logFilePath, {
          scope: CONTEXT_TOOL_NAME,
          message: "chunk retrieval tool error",
          error: err,
        });

        return {
          title: "Semantic search",
          output:
            "Search failed. The index may need to be rebuilt.",
          metadata: {
            query: args.query,
            chunks: 0,
            indexed: false,
          },
        };
      }
    },
  });

  // ── Register tools ─────────────────────────────────────────────────────
  const tools: Record<string, ToolDefinition> = {
    [CONTEXT_TOOL_NAME]: retrievalTool,
  };

  const effectiveCfg = getEffectiveCfg();

  try {
    const fileSkeletonTool = createFileSkeletonTool({
      worktree: options.worktree,
    });
    tools["get_file_skeleton"] = fileSkeletonTool;
  } catch (err) {
    appendDebugLog(options.logFilePath, {
      scope: "plugin",
      message: "Failed to register get_file_skeleton tool",
      error: err,
    });
  }

  try {
    const findUsagesTool = createFindUsagesTool({
      store,
      embedder,
      cfg: effectiveCfg,
      keywordIndex,
      retrieveFn: dependencies.retrieve,
    });
    tools["find_usages"] = findUsagesTool;
  } catch (err) {
    appendDebugLog(options.logFilePath, {
      scope: "plugin",
      message: "Failed to register find_usages tool",
      error: err,
    });
  }

  try {
    const describeImageTool = createDescribeImageTool({
      worktree: options.worktree,
      config: effectiveCfg,
    });
    tools["describe_image"] = describeImageTool;
  } catch (err) {
    appendDebugLog(options.logFilePath, {
      scope: "plugin",
      message: "Failed to register describe_image tool",
      error: err,
    });
  }

  if (readOverride) {
    const readTool = createRagReadTool({
      worktree: options.worktree,
      config: options.cfg,
      embedder,
      store,
      logFilePath: options.logFilePath,
      sessionLastMessage,
      sessionRetrievalCache,
      keywordIndex,
      maxSessionCacheSize: MAX_SESSION_MAP_SIZE,
    });
    tools["read"] = readTool;
    appendDebugLog(options.logFilePath, {
      scope: "plugin",
      message: "Read override enabled — RAG-backed read tool registered",
    });
  }

  const toolNames = Object.keys(tools).join(", ");
  appendDebugLog(options.logFilePath, {
    scope: "plugin",
    message: `Registered tools: ${toolNames}`,
  });

  return {
    async event({ event }) {
      sessionLogger.onEvent(event as Parameters<typeof sessionLogger.onEvent>[0]);

      // Accumulate the most recent assistant message's text via streaming deltas.
      // Used to build the 2-message retrieval query in chat.message.
      try {
        if (event.type === "message.updated") {
          const info = (event as Record<string, unknown>).properties as
            | Record<string, unknown>
            | undefined;
          const msgInfo = info?.info as Record<string, unknown> | undefined;
          if (
            msgInfo?.role === "assistant" &&
            typeof msgInfo.sessionID === "string" &&
            typeof msgInfo.id === "string"
          ) {
            boundedSet(sessionAssistantMessageId, msgInfo.sessionID, msgInfo.id, MAX_SESSION_MAP_SIZE);
            boundedSet(sessionAssistantText, msgInfo.sessionID, "", MAX_SESSION_MAP_SIZE);
          }
        } else if (event.type === "message.part.updated") {
          const props = (event as Record<string, unknown>).properties as
            | Record<string, unknown>
            | undefined;
          const part = props?.part as Record<string, unknown> | undefined;
          const delta = props?.delta;
          if (
            part?.type === "text" &&
            typeof part.sessionID === "string" &&
            typeof part.messageID === "string" &&
            typeof delta === "string"
          ) {
            const assistantMsgId = sessionAssistantMessageId.get(part.sessionID);
            if (assistantMsgId && part.messageID === assistantMsgId) {
              const existing = sessionAssistantText.get(part.sessionID) ?? "";
              boundedSet(sessionAssistantText, part.sessionID, existing + delta, MAX_SESSION_MAP_SIZE);
            }
          }
        }
      } catch {
        // Non-critical — must never throw
      }
    },
    tool: tools,
    async "experimental.chat.system.transform"(_input, output) {
      appendDebugLog(options.logFilePath, {
        scope: "experimental.chat.system.transform",
        message: "system guidance injected",
      });

      const cfg = getEffectiveCfg();
      if (cfg.openCode.injectSystemPrompt !== false) {
        const guidance = [
          "MANDATORY: OpenCodeRAG tools MUST be used before any code task:",
          "- `search_semantic(query)`: retrieve relevant code chunks. Call BEFORE planning, editing, or answering. Accepts `pathHints` and `languageHints`.",
          "- `get_file_skeleton(filePath)`: structural overview of a file. Call BEFORE reading any file.",
          "- `find_usages(symbolName)`: find all references. Call BEFORE editing any function, class, or variable.",
          "- `describe_image(filePath)`: describe an image file using a vision model. Call when user refers to a screenshot, diagram, or image.",
          "",
          "Decision tree — ALWAYS follow this order:",
          "1. User mentions code behavior/architecture → `search_semantic(query)`",
          "2. User mentions a file path → `get_file_skeleton(filePath)` THEN `read` on specific lines",
          "3. User mentions a function/class/variable to edit → `find_usages(symbolName)` THEN `search_semantic` THEN `edit`",
          "4. User asks a code question → `search_semantic` to gather context before answering",
          "5. User asks about an image or visual asset → `describe_image(filePath)` to retrieve its generated description, then optionally `search_semantic` for related code",
          "",
          "Proactive triggers — you MUST call these tools when:",
          "- User asks about code behavior, architecture, or implementation details",
          "- User asks to edit, refactor, or fix code — call `find_usages` first",
          "- User references files or functions you haven't read yet",
          "- User says \"find\", \"search\", \"look up\", \"where is\", \"how does\"",
          "- User refers to an image, screenshot, diagram, or visual asset",
          "- Before answering ANY code-related question, retrieve context first",
          "- Before reading ANY file, call `get_file_skeleton` to orient first",
          "",
          "Anti-patterns — NEVER do these:",
          "- Reading full files without calling `get_file_skeleton` first (wastes tokens)",
          "- Editing a function without calling `find_usages` first (breaks call sites)",
          "- Answering code questions without calling `search_semantic` first (you guess at behavior)",
          "- Using `grep`/`glob` when `search_semantic` would find the answer faster",
          "- Treating image files as text — use `describe_image` instead of reading raw bytes",
        ];
        output.system.unshift(guidance.join("\n"));
      }

      // Inject update notification if available
      const updateInfo = pendingUpdateInfo.get(options.worktree);
      if (updateInfo) {
        output.system.unshift(
          `OpenCodeRAG update available: ${updateInfo.currentVersion} → ${updateInfo.latestVersion}. ` +
          `Run \`npm update -g opencode-rag-plugin && opencode-rag setup\` to install.`,
        );
      }

      // Inject documentation mode system prompt if enabled
      const docMode = getEffectiveCfg().documentationMode;
      if (docMode?.enabled && docMode.systemPrompt) {
        output.system.unshift(docMode.systemPrompt);
      }

      // Inject wiki mode system prompt if enabled
      const wikiMode = getEffectiveCfg().wikiMode;
      if (wikiMode?.enabled && wikiMode.systemPrompt) {
        output.system.unshift(wikiMode.systemPrompt);
      }
    },
    async "chat.message"(input, output) {
      try {
        const hasMsgParts = !!((output?.message as Record<string, unknown>)?.parts);
        const samePartsRef = (output?.message as Record<string, unknown>)?.parts === output?.parts;
        appendDebugLog(options.logFilePath, {
          scope: "chat.message",
          message: `hook invoked (hasOutput=${!!output}, hasMessage=${!!output?.message}, hasParts=${!!output?.parts}, hasMsgParts=${hasMsgParts}, sameRef=${samePartsRef})`,
        });
        const text = extractUserMessageText(input, output);
        appendDebugLog(options.logFilePath, {
          scope: "chat.message",
          message: `extracted text="${text}" (length=${text.length})`,
        });
        if (text.length === 0) return;

        boundedSet(sessionLastMessage, input.sessionID, text, MAX_SESSION_MAP_SIZE);

        // Handle /doc slash command
        if (text.startsWith("/doc")) {
          const docMode = getEffectiveCfg().documentationMode;
          if (!docMode?.enabled) {
            const parts = output?.parts ?? (output?.message as Record<string, unknown>)?.parts;
            if (Array.isArray(parts) && parts.length > 0) {
              const first = parts[0] as Record<string, unknown>;
              if (typeof first.text === "string") {
                parts[0] = { ...first, text: "Documentation mode is not enabled. Set `documentationMode.enabled` to `true` in opencode-rag.json." } as typeof parts[0];
              }
            }
            return;
          }

          const arg = text.slice(4).trim();

          try {
            const manifest = await loadManifest(options.storePath);
            const allFiles = Object.keys(manifest.manifest.files);
            if (allFiles.length === 0) {
              const parts = output?.parts ?? (output?.message as Record<string, unknown>)?.parts;
              if (Array.isArray(parts) && parts.length > 0) {
                const first = parts[0] as Record<string, unknown>;
                if (typeof first.text === "string") {
                  parts[0] = { ...first, text: "No indexed files found. Run indexing first, then use `/doc`." } as typeof parts[0];
                }
              }
              return;
            }

            if (arg) {
              markSubdirectoryDocumented(options.storePath, arg, allFiles);
            }

            const progress = loadDocProgress(options.storePath);
            const remaining = allFiles.filter((f) => !progress.documented.includes(f));

            let docMsg: string;
            if (remaining.length === 0) {
              docMsg = `**All ${allFiles.length} indexed files have been documented.** No remaining files.`;
            } else {
              const grouped: Record<string, string[]> = {};
              for (const f of remaining) {
                const dir = path.dirname(f);
                (grouped[dir] ??= []).push(f);
              }

              const lines = [
                "## Documentation",
                "",
                "Pick a subdirectory and document ALL files within it using Google JSDoc style.",
                `When done, type \`/doc <subdirectory>\` to mark it complete and see what's left.`,
                "",
              ];

              for (const [dir, files] of Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b))) {
                lines.push(`### ${dir} (${files.length} file${files.length === 1 ? "" : "s"})`);
                for (const f of files) {
                  lines.push(`- \`${f}\``);
                }
                lines.push("");
              }

              lines.push(`Progress: ${progress.documented.length} / ${allFiles.length} files documented.`);
              lines.push(`Remaining: ${remaining.length} files.`);
              docMsg = lines.join("\n");
            }

            const parts = output?.parts ?? (output?.message as Record<string, unknown>)?.parts;
            if (Array.isArray(parts) && parts.length > 0) {
              const first = parts[0] as Record<string, unknown>;
              if (typeof first.text === "string") {
                parts[0] = { ...first, text: docMsg } as typeof parts[0];
              }
            }
          } catch (err) {
            appendDebugLog(options.logFilePath, {
              scope: "chat.message",
              message: "Failed to handle /doc command",
              error: err,
            });
            const parts = output?.parts ?? (output?.message as Record<string, unknown>)?.parts;
            if (Array.isArray(parts) && parts.length > 0) {
              const first = parts[0] as Record<string, unknown>;
              if (typeof first.text === "string") {
                parts[0] = { ...first, text: "Failed to start documentation. Ensure the workspace is indexed." } as typeof parts[0];
              }
            }
          }
          return;
        }

        // Handle /wiki slash command
        if (text.startsWith("/wiki")) {
          const wikiMode = getEffectiveCfg().wikiMode;
          if (!wikiMode?.enabled) {
            const parts = output?.parts ?? (output?.message as Record<string, unknown>)?.parts;
            if (Array.isArray(parts) && parts.length > 0) {
              const first = parts[0] as Record<string, unknown>;
              if (typeof first.text === "string") {
                parts[0] = { ...first, text: "Wiki mode is not enabled. Set `wikiMode.enabled` to `true` in opencode-rag.json." } as typeof parts[0];
              }
            }
            return;
          }

          const arg = text.slice(5).trim().toLowerCase();
          const wikiDir = path.join(options.worktree, ".opencode", "wiki");
          const lines: string[] = [];

          if (arg === "lint") {
            lines.push(
              "## Wiki Lint",
              "",
              "Run a health check on the wiki. Check for:",
              "- Orphan pages with no inbound [[links]]",
              "- Stale pages whose sourceRefs files changed since lastReviewed",
              "- Contradictions between pages",
              "- Important concepts mentioned but lacking their own page",
              "",
              "Append findings to .opencode/wiki/log.md and fix any issues found.",
            );
          } else if (arg === "seed") {
            lines.push(
              "## Wiki Seed",
              "",
              "Generate the initial wiki from existing sources:",
              "1. Read README and top-level docs for project overview → create overview page",
              "2. Scan file structure with get_file_skeleton for major modules → create entity pages",
              "3. Identify common conventions from code patterns → create concept pages",
              "4. Create .opencode/wiki/index.md listing all pages",
              "5. Create .opencode/wiki/log.md with initial entry",
              "6. Keep pages focused — one concept per page, short prose, cross-referenced with [[links]]",
            );
          } else {
            if (existsSync(wikiDir)) {
              const entries = readdirSync(wikiDir);
              const pages = entries.filter((e) => e.endsWith(".md") && e !== "log.md").length;
              const hasIndex = entries.includes("index.md");
              const hasLog = entries.includes("log.md");
              const dirs = entries.filter((e) => !e.includes(".")).length;
              let lastLogEntry = "";
              const logPath = path.join(wikiDir, "log.md");
              if (hasLog && existsSync(logPath)) {
                const logContent = readFileSync(logPath, "utf-8");
                const logLines = logContent.trim().split("\n").filter((l) => l.startsWith("## ["));
                if (logLines.length > 0) {
                  lastLogEntry = logLines[logLines.length - 1] ?? "";
                }
              }

              lines.push(
                "## Wiki Status",
                "",
                `Wiki: \`.opencode/wiki/\``,
                `Pages: ~${pages} (.md files)`,
                `Subdirectories: \`${dirs}\``,
                `Index: ${hasIndex ? "yes" : "no"} | Log: ${hasLog ? "yes" : "no"}`,
              );
              if (lastLogEntry) {
                lines.push(`Latest log: \`${lastLogEntry}\``);
              }
              lines.push(
                "",
                "Commands:",
                "- `/wiki` — show this status",
                "- `/wiki lint` — health-check the wiki",
                "- `/wiki seed` — generate initial wiki pages from the codebase",
              );
            } else {
              lines.push(
                "## Wiki Status",
                "",
                "No wiki yet at `.opencode/wiki/`.",
                "Use `/wiki seed` to generate the initial wiki from existing sources.",
              );
            }
          }

          const wikiMsg = lines.join("\n");
          const parts = output?.parts ?? (output?.message as Record<string, unknown>)?.parts;
          if (Array.isArray(parts) && parts.length > 0) {
            const first = parts[0] as Record<string, unknown>;
            if (typeof first.text === "string") {
              parts[0] = { ...first, text: wikiMsg } as typeof parts[0];
            }
          }
          return;
        }

        // Handle hotkey-triggered RAG injection (Ctrl+Enter / Ctrl+Alt+Enter)
        const pendingInjection = consumePendingRagInjection(options.storePath);
        if (pendingInjection) {
          appendDebugLog(options.logFilePath, {
            scope: "chat.message",
            message: `pending injection: ${pendingInjection}`,
          });

          const count = await store.count();
          if (count === 0) return;

          const effectiveCfg = getEffectiveCfg();
          const hybridCfg = effectiveCfg.retrieval.hybridSearch;
          const retrievalStart = Date.now();

          // Build 2-message query: previous assistant response + current user prompt.
          // Falls back to user-only text on the first turn (no prior assistant message).
          const assistantText = sessionAssistantText.get(input.sessionID);
          const searchQuery = assistantText ? assistantText + "\n" + text : text;

          const results = await dependencies.retrieve(searchQuery, embedder, store, {
            topK: effectiveCfg.retrieval.topK,
            minScore: 0,
            keywordIndex,
            keywordWeight: hybridCfg?.keywordWeight,
            queryPrefix: effectiveCfg.embedding.queryPrefix,
          });
          const retrievalTimeMs = Date.now() - retrievalStart;

          if (results.length > 0) {
            let ragContext: string;
            if (pendingInjection === "files") {
              ragContext = formatFileList(results, options.worktree, effectiveCfg.retrieval.topK);
            } else {
              ragContext = formatAutoInjectContext(
                results,
                options.worktree,
                3000,
                effectiveCfg.retrieval.topK
              );
            }

            if (ragContext) {
              const parts = output?.parts ?? (output?.message as Record<string, unknown>)?.parts;
              if (Array.isArray(parts) && parts.length > 0) {
                const first = parts[0] as Record<string, unknown>;
                if (typeof first.text === "string") {
                  // Append RAG context directly to the user's text part instead of
                  // pushing a new part. Matches the /doc handler pattern — avoids the
                  // duplicate-output bug caused by parts.push() in some render paths.
                  parts[0] = { ...first, text: first.text + "\n\n" + ragContext } as typeof parts[0];
                }

                const msgParts = (output?.message as Record<string, unknown>)?.parts;
                if (Array.isArray(msgParts) && msgParts !== parts) {
                  const mfirst = msgParts[0] as Record<string, unknown>;
                  if (typeof mfirst.text === "string") {
                    msgParts[0] = { ...mfirst, text: mfirst.text + "\n\n" + ragContext } as typeof msgParts[0];
                  }
                }

                appendDebugLog(options.logFilePath, {
                  scope: "chat.message",
                  message: `injected ${pendingInjection} context into parts[0].text (text.length=${ragContext.length})`,
                });
              }
            }
          }

          appendDebugLog(options.logFilePath, {
            scope: "chat.message",
            message: `injected ${pendingInjection} context (results=${results.length}, retrieval=${retrievalTimeMs}ms)`,
          });

          const postParts = output?.parts;
          const postMsgParts = (output?.message as Record<string, unknown>)?.parts;
          const postPartsText = Array.isArray(postParts) ? (postParts[0] as Record<string, unknown>)?.text : undefined;
          const postMsgPartsText = Array.isArray(postMsgParts) ? (postMsgParts[0] as Record<string, unknown>)?.text : undefined;
          appendDebugLog(options.logFilePath, {
            scope: "chat.message",
            message: `post-injection parts[0].text="${typeof postPartsText === 'string' ? postPartsText.substring(0, 80) : 'n/a'}" msgParts[0].text="${typeof postMsgPartsText === 'string' ? postMsgPartsText.substring(0, 80) : 'n/a'}"`,
          });
          return;
        }

      } catch (err) {
        appendDebugLog(options.logFilePath, {
          scope: "chat.message",
          message: "failed to suggest related files",
          error: err,
        });
      }
    },
  };
}

/**
 * Load the persistent keyword index from disk, falling back to an empty
 * index if loading fails.
 */
async function loadKeywordIndex(storePath: string, logFilePath: string, logLevel?: string): Promise<KeywordIndex> {
  const { KeywordIndex } = await import("./retriever/keyword-index.js");
  try {
    const index = await KeywordIndex.load(storePath);
    appendDebugLog(logFilePath, {
      scope: "plugin",
      message: `Keyword index loaded (${index.count()} chunks)`,
    }, logLevel);
    return index;
  } catch (err) {
    appendDebugLog(logFilePath, {
      scope: "plugin",
      message: "Failed to load keyword index, creating empty",
      error: err,
    }, logLevel);
    return new KeywordIndex(storePath);
  }
}



let _cachedNodeExecutable: string | null | undefined;

/**
 * Resolve the path to the Node.js executable, caching the result.
 * Checks `process.execPath` first, then falls back to `where`/`which`.
 */
function resolveNodeExecutable(): string | null {
  if (_cachedNodeExecutable !== undefined) return _cachedNodeExecutable;

  const execPath = process.execPath;
  const basename = path.basename(execPath).toLowerCase();

  if (basename === "node" || basename === "node.exe") {
    _cachedNodeExecutable = execPath;
    return _cachedNodeExecutable;
  }

  const tryCmd = (cmd: string): string | null => {
    try {
      const result = execSync(cmd, { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).trim();
      return result.split("\n")[0]?.trim() || null;
    } catch {
      return null;
    }
  };

  const found = process.platform === "win32"
    ? tryCmd("where node")
    : tryCmd("which node");

  _cachedNodeExecutable = found;
  return _cachedNodeExecutable;
}

/**
 * Resolve the MCP CLI entry point script path.
 * Checks `dist/cli.js` first, then falls back to `src/cli.ts`.
 */
function resolveMcpCliEntry(): string | null {
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(selfDir, "..");

  const distCli = path.join(packageRoot, "dist", "cli.js");
  if (existsSync(distCli)) return distCli;

  const srcCli = path.join(packageRoot, "src", "cli.ts");
  if (existsSync(srcCli)) return srcCli;

  return null;
}

/**
 * Start an MCP server process for the given workspace directory.
 * Spawns the CLI in MCP mode as a child process and wires stdout/stderr
 * to the debug log. Returns a handle for graceful shutdown.
 */
function startMcpServerProcess(
  cwd: string,
  logFilePath: string,
  logLevel?: string
): { close: () => Promise<void> } {
  const cliEntry = resolveMcpCliEntry();
  if (!cliEntry) {
    appendDebugLog(logFilePath, {
      scope: "mcp",
      message: "Could not resolve MCP CLI entry point; skipping autostart",
    }, logLevel);
    return { close: async () => {} };
  }

  const nodeExec = resolveNodeExecutable();
  if (!nodeExec) {
    appendDebugLog(logFilePath, {
      scope: "mcp",
      message: "Could not resolve Node.js executable; skipping MCP autostart",
    }, logLevel);
    return { close: async () => {} };
  }

  const args = cliEntry.endsWith(".ts")
    ? ["--import", "tsx", cliEntry, "mcp"]
    : [cliEntry, "mcp"];

  appendDebugLog(logFilePath, {
    scope: "mcp",
    message: `Starting MCP server: ${nodeExec} ${args.join(" ")}`,
  }, logLevel);

  const child = spawn(nodeExec, args, {
    cwd,
    stdio: "pipe",
    detached: false,
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    appendDebugLog(logFilePath, {
      scope: "mcp",
      message: `stdout: ${chunk.toString().trim()}`,
    }, logLevel);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    appendDebugLog(logFilePath, {
      scope: "mcp",
      message: `stderr: ${chunk.toString().trim()}`,
    }, logLevel);
  });

  child.on("error", (err) => {
    appendDebugLog(logFilePath, {
      scope: "mcp",
      message: "MCP server process error",
      error: err,
    }, logLevel);
  });

  child.on("exit", (code, signal) => {
    appendDebugLog(logFilePath, {
      scope: "mcp",
      message: `MCP server exited (code=${code}, signal=${signal})`,
    });
    mcpServers.delete(cwd);
  });

  return {
    close: async () => {
      if (child.exitCode !== null || child.killed) return;
      appendDebugLog(logFilePath, {
        scope: "mcp",
        message: "Shutting down MCP server",
      });
      child.kill("SIGTERM");
    },
  };
}

/**
 * OpenCodeRAG plugin factory — invoked by OpenCode's plugin system for each workspace.
 *
 * Bootstraps the full RAG pipeline: loads config, probes vector dimensions,
 * creates embedder/store, starts the background auto-indexer (if enabled),
 * launches the MCP server (if enabled), checks for updates, and returns
 * the RAG hooks that power tools and automatic context injection.
 *
 * @param input - Plugin input containing the workspace directory and runtime context.
 * @param _options - Optional additional plugin options (unused).
 * @returns A complete set of OpenCode hooks for RAG functionality.
 */
export const ragPlugin: Plugin = async (
  input: PluginInput,
  _options?: Record<string, unknown>
): Promise<Hooks> => {
  const cfg = await getConfig(input.directory);
  const logFilePath = path.resolve(input.directory, resolveLogConfig(cfg).logFilePath);
  const logLevel = resolveLogConfig(cfg).level;

  if (!cfg.openCode.enabled) {
    return {};
  }

  const storePath = path.resolve(input.directory, cfg.vectorStore.path);

  // Apply runtime overrides before creating services
  const overrides = loadRuntimeOverrides(storePath);
  const effectiveCfg = applyRuntimeOverrides(cfg, overrides);

  // Resolve API keys from env vars or OpenCode provider config if not set in opencode-rag.json
  const hadEmbeddingKey = !!effectiveCfg.embedding.apiKey;
  const hadDescriptionKey = !!effectiveCfg.description?.apiKey;
  resolveApiKey(effectiveCfg, input.directory);
  if (!hadEmbeddingKey && effectiveCfg.embedding.apiKey) {
    appendDebugLog(logFilePath, {
      scope: "plugin",
      message: `Resolved OpenAI API key for embedding from ${process.env.OPENAI_API_KEY ? "OPENAI_API_KEY env var" : "OpenCode provider config"}`,
    }, logLevel);
  }
  if (!hadDescriptionKey && effectiveCfg.description?.apiKey) {
    appendDebugLog(logFilePath, {
      scope: "plugin",
      message: `Resolved OpenAI API key for description from ${process.env.OPENAI_API_KEY ? "OPENAI_API_KEY env var" : "OpenCode provider config"}`,
    }, logLevel);
  }

  // Close existing indexer for this directory if one exists (e.g. on plugin reload)
  const existingIndexer = backgroundIndexers.get(input.directory);
  if (existingIndexer) {
    try {
      await existingIndexer.close();
    } catch (err) {
      appendDebugLog(logFilePath, {
        scope: "plugin",
        message: "Failed to close existing background indexer",
        error: err,
      }, logLevel);
    }
    backgroundIndexers.delete(input.directory);
  }

  // Close existing MCP server for this directory if one exists (e.g. on plugin reload)
  const existingMcp = mcpServers.get(input.directory);
  if (existingMcp) {
    try {
      await existingMcp.close();
    } catch (err) {
      appendDebugLog(logFilePath, {
        scope: "plugin",
        message: "Failed to close existing MCP server",
        error: err,
      }, logLevel);
    }
    mcpServers.delete(input.directory);
  }

  // Clean up stale config cache and pending update info for this directory
  configCache.delete(input.directory);
  pendingUpdateInfo.delete(input.directory);
  // Clean up idle HTTP sockets from previous provider connections
  destroyAllPooledConnections();

  appendDebugLog(logFilePath, {
    scope: "plugin",
    message: `OpenCode plugin enabled for ${input.directory}`,
  }, logLevel);

  // Use cached dimension from config if available (avoids blocking startup with an API call)
  // If not set, probe the embedding provider once and persist the result.
  const embedder = createEmbedder(effectiveCfg);
  let vectorDimension = effectiveCfg.embedding.vectorDimension;
  if (vectorDimension && vectorDimension > 0) {
    appendDebugLog(logFilePath, {
      scope: "plugin",
      message: `Vector dimension: ${vectorDimension} (cached in config)`,
    }, logLevel);
  } else {
    vectorDimension = 384;
    try {
      const probe = await embedder.embed(["dimension-probe"], "query");
      if (probe && probe[0] && probe[0].length > 0 && typeof probe[0][0] === "number") {
        vectorDimension = (probe[0] as number[]).length;
        const configPath = findConfigFile(input.directory);
        if (configPath) {
          try { persistProbedDimension(configPath, vectorDimension); } catch { /* best-effort */ }
        }
      }
      appendDebugLog(logFilePath, {
        scope: "plugin",
        message: `Vector dimension: ${vectorDimension}`,
      }, logLevel);
    } catch (err) {
      appendDebugLog(logFilePath, {
        scope: "plugin",
        message: `Dimension probe failed, falling back to ${vectorDimension}`,
        error: err,
      }, logLevel);
    }
  }

  const store = createVectorStore(effectiveCfg, storePath, vectorDimension);

  // Load or create keyword index for hybrid search
  const keywordIndex = await loadKeywordIndex(storePath, logFilePath, logLevel);

  // Create description provider (enabled by default)
  const descriptionConfig = effectiveCfg.description ?? { enabled: true, provider: "ollama" as const, baseUrl: "http://127.0.0.1:11434/api", model: "qwen2.5:3b", systemPrompt: "" };
  const descriptionProvider = descriptionConfig.enabled
    ? createDescriptionProvider(descriptionConfig)
    : undefined;

  const hooks = createRagHooks({
    cfg: effectiveCfg,
    storePath,
    logFilePath,
    logLevel,
    worktree: input.directory,
    embedder,
    store,
    keywordIndex,
    descriptionProvider,
  });

  // Start background auto-indexer if enabled
  const autoIndexCfg = effectiveCfg.openCode.autoIndex ?? { enabled: false, debounceMs: 5000, intervalMs: 300000 };
  if (autoIndexCfg.enabled) {
    const indexer = createBackgroundIndexer({
      cwd: input.directory,
      storePath,
      config: effectiveCfg,
      store,
      embedder,
      logFilePath,
      logLevel,
      keywordIndex,
      descriptionProvider,
      dimension: vectorDimension,
    });

    backgroundIndexers.set(input.directory, indexer);
  } else {
    // Clean up stale watcher status from a previous session (e.g. after a crash
    // while the watcher was running). Without this the TUI would keep showing
    // "Watcher running…" even though auto-index is disabled.
    const statusPath = path.join(storePath, "watcher-status.json");
    if (existsSync(statusPath)) {
      try { unlinkSync(statusPath); } catch { /* ignore */ }
    }
  }

  // Auto-start MCP server if enabled (skip in temp dirs / test environments)
  const mcpCfg = effectiveCfg.mcp ?? { enabled: true };
  const isTempDir = path.resolve(input.directory).startsWith(tmpdir());
  if (mcpCfg.enabled && !isTempDir) {
    const mcpInstance = startMcpServerProcess(input.directory, logFilePath, logLevel);
    mcpServers.set(input.directory, mcpInstance);
  }

  // Auto-update check (non-blocking, best-effort)
  const autoUpdateCfg = effectiveCfg.autoUpdate;
  if (autoUpdateCfg?.enabled) {
    const currentVersion = (() => {
      try {
        const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
        return JSON.parse(readFileSync(pkgPath, "utf-8") as string).version as string;
      } catch {
        return "0.0.0";
      }
    })();
    checkForUpdate(currentVersion)
      .then((info: UpdateInfo) => {
        if (info.updateAvailable) {
          pendingUpdateInfo.set(input.directory, info);
          appendDebugLog(logFilePath, {
            scope: "updater",
            message: `Update available: ${info.currentVersion} → ${info.latestVersion}`,
          }, logLevel);
        }
      })
      .catch(() => { /* best-effort */ });
  }

  return hooks;
};

export default ragPlugin;
