import type { Plugin, PluginInput, Hooks, ToolDefinition } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";
import type { EmbeddingProvider, DescriptionProvider, KeywordIndex, VectorStore, SearchResult } from "./core/interfaces.js";
import { loadConfig, findConfigFile, DEFAULT_CONFIG, resolveLogConfig, type RagConfig } from "./core/config.js";
import { createEmbedder } from "./embedder/factory.js";
import { createDescriptionProvider } from "./describer/factory.js";
import { createVectorStore } from "./vectorstore/factory.js";
import { retrieve } from "./retriever/retriever.js";
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
import { loadDocProgress, markFileDocumented } from "./core/doc-progress.js";
import { loadManifest } from "./core/manifest.js";
import { createSessionLogger, type SessionLogger } from "./eval/session-logger.js";
import { countTokens, estimateContextTokensFormatted } from "./eval/token-counter.js";
import { checkForUpdate, type UpdateInfo } from "./updater.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";
import { tmpdir } from "node:os";

/** Cache of loaded RAG configurations keyed by workspace directory. */
const configCache = new Map<string, RagConfig>();
/** Active background indexer instances keyed by workspace directory. */
const backgroundIndexers = new Map<string, { close: () => Promise<void> }>();
/** Active MCP server instances keyed by workspace directory. */
const mcpServers = new Map<string, { close: () => Promise<void> }>();
/** Pending update notifications keyed by workspace directory. */
const pendingUpdateInfo = new Map<string, UpdateInfo>();

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

/**
 * Format auto-injected context results, trimming to a token budget.
 * Results are sorted by relevance and included up to maxChunks.
 */
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
 * Remove duplicate results based on file path + line range + content.
 * Keeps the first occurrence of each unique result.
 */
function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];

  for (const result of results) {
    const chunk = result.chunk;
    const key = [
      chunk.metadata.filePath,
      chunk.metadata.startLine,
      chunk.metadata.endLine,
      chunk.content,
    ].join(":");

    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(result);
  }

  return deduped;
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
  explain = false
): Promise<SearchResult[]> {
  if (query.trim().length === 0) return [];
  return retrieveFn(query, embedder, store, { topK, minScore, keywordIndex, keywordWeight, queryPrefix, explain });
}

/**
 * Load results from one or two queries (primary + optional extra), deduplicate,
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
  const primaryResults = await retrieveContext(query, embedder, store, topK, retrieveFn, minScore, keywordIndex, kw, queryPrefix, explain);
  const extraResults = extraQuery
    ? await retrieveContext(extraQuery, embedder, store, topK, retrieveFn, minScore, keywordIndex, kw, queryPrefix, explain)
    : [];

  return dedupeResults([...primaryResults, ...extraResults])
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
  input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string }; messageID?: string; variant?: string },
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

  function getEffectiveCfg(): RagConfig {
    if (Date.now() - overridesLastCheck > OVERRIDES_TTL_MS) {
      cachedOverrides = loadRuntimeOverrides(options.storePath);
      overridesLastCheck = Date.now();
    }
    return applyRuntimeOverrides(options.cfg, cachedOverrides);
  }

  // Session-level caches for lazy retrieval
  const sessionLastMessage = new Map<string, string>();
  const sessionRetrievalCache = new Map<string, { messageText: string; rawResults: SearchResult[] }>();

  // Session-level doc mode kickoff tracking
  const sessionDocKickoff = new Map<string, boolean>();



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

  try {
    const docMode = getEffectiveCfg().documentationMode;
    if (docMode?.enabled) {
      const markDocTool = tool({
        description:
          "Mark a file as documented after adding doc comments. Call this after you finish documenting each file.",
        args: {
          filePath: tool.schema.string().min(1, "File path is required."),
        },
        async execute(args: { filePath: string }) {
          markFileDocumented(options.storePath, args.filePath);
          appendDebugLog(options.logFilePath, {
            scope: "mark_documented",
            message: `Marked as documented: ${args.filePath}`,
          });
          return {
            title: "Documented",
            output: `${args.filePath} marked as documented.`,
            metadata: { tool: "mark_documented", filePath: args.filePath },
          };
        },
      });
      tools["mark_documented"] = markDocTool;
    }
  } catch (err) {
    appendDebugLog(options.logFilePath, {
      scope: "plugin",
      message: "Failed to register mark_documented tool",
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
    },
    tool: tools,
    async "experimental.chat.system.transform"(_input, output) {
      appendDebugLog(options.logFilePath, {
        scope: "experimental.chat.system.transform",
        message: "system guidance injected",
      });

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

      // Inject update notification if available
      const updateInfo = pendingUpdateInfo.get(options.worktree);
      if (updateInfo) {
        output.system.unshift(
          `OpenCodeRAG update available: ${updateInfo.currentVersion} → ${updateInfo.latestVersion}. ` +
          `Run \`opencode-rag update\` to install.`,
        );
      }

      // Inject documentation mode system prompt if enabled
      const docMode = getEffectiveCfg().documentationMode;
      if (docMode?.enabled) {
        const styleRules = docMode.style === "google" ? [
          "## Google JSDoc Style Rules (MANDATORY)",
          "",
          "- Use `/** ... */` block comments — never `//` or `/*`.",
          "- First line is a standalone summary sentence ending with a period.",
          "- Describe WHAT the symbol does and WHY, not HOW.",
          "- Blank line between summary and body (if body is needed).",
          "- For TypeScript: Omit `{type}` in @param/@returns — types are in code.",
          "- For JavaScript/Python/PHP: include `{type}` in @param and @returns.",
          "- `@param name - Description` — one line per param, dash before description.",
          "- `@returns Description` — describe the return value.",
          "- `@throws {ErrorType} Condition` — only when the code explicitly throws.",
          "- Do NOT add any comments inside function/method bodies.",
          "- Do NOT restate the obvious.",
          "- Be concise — ≤2 sentences per tag description.",
          "- Do NOT change any implementation code.",
        ] : [];

        if (docMode.autoStart) {
          const directivePrompt = [
            "## PRIMARY OBJECTIVE: Document this codebase",
            "",
            "Your primary task is to add/update JSDoc/TSDoc comments on every public symbol in this codebase.",
            "",
            ...(styleRules.length > 0 ? styleRules : []),
            "",
            "### Workflow",
            "",
            "When you receive a documentation kickoff message listing files to process:",
            "1. For each file in the batch:",
            "   a. Call `get_file_skeleton(filePath)` to see the structure",
            "   b. Call `read` to read the full file content",
            "   c. Add or update doc comments on EVERY public symbol: classes, interfaces, types, methods, functions, properties, and exported constants",
            "   d. Call `mark_documented(filePath)` to record completion",
            "2. Follow the Google JSDoc style rules above (strict, parseable format)",
            "3. Write descriptions that explain WHAT and WHY, not HOW",
            "4. Include @param, @returns, and @throws where applicable",
            "5. Do NOT change any implementation code — only add/update doc comments",
            "6. Do NOT add comments that restate the obvious",
            "7. Preserve any existing comments — update them only if incorrect",
            "",
            "After finishing a batch, report which files were documented and wait for the next batch.",
          ].join("\n");
          output.system.unshift(directivePrompt);
        } else {
          output.system.unshift(docMode.systemPrompt);
        }
      }
    },
    async "chat.message"(input, output) {
      try {
        const text = extractUserMessageText(input, output);
        if (text.length === 0) return;

        sessionLastMessage.set(input.sessionID, text);

        // Documentation mode auto-kickoff on first message
        const docModeCfg = getEffectiveCfg().documentationMode;
        if (docModeCfg?.enabled && docModeCfg.autoStart && !sessionDocKickoff.get(input.sessionID)) {
          sessionDocKickoff.set(input.sessionID, true);
          try {
            const manifest = await loadManifest(options.storePath);
            const allFiles = Object.keys(manifest.manifest.files);
            if (allFiles.length > 0) {
              const progress = loadDocProgress(options.storePath);
              const remaining = allFiles.filter((f) => !progress.documented.includes(f));

              if (remaining.length === 0) {
                const doneMsg = "\n\n**Documentation Mode: Complete** — All indexed files have been documented.";
                const parts = output?.parts ?? (output?.message as Record<string, unknown>)?.parts;
                if (Array.isArray(parts) && parts.length > 0) {
                  const first = parts[0] as Record<string, unknown>;
                  if (typeof first.text === "string") {
                    parts[0] = { ...first, text: `${first.text}${doneMsg}` } as typeof parts[0];
                  }
                }
              } else {
                const batch = remaining.slice(0, docModeCfg.batchSize);
                const kickoffMsg = [
                  "",
                  "## Documentation Mode: Auto-Kickoff",
                  "",
                  "Begin documenting the codebase. Process these files in order:",
                  ...batch.map((f) => `- \`${f}\``),
                  "",
                  `Progress: ${progress.documented.length} / ${allFiles.length} files documented.`,
                  `Remaining: ${remaining.length} files.`,
                  "",
                  "For each file: call `get_file_skeleton` → `read` → add doc comments → call `mark_documented`",
                ].join("\n");
                const parts = output?.parts ?? (output?.message as Record<string, unknown>)?.parts;
                if (Array.isArray(parts) && parts.length > 0) {
                  const first = parts[0] as Record<string, unknown>;
                  if (typeof first.text === "string") {
                    parts[0] = { ...first, text: `${first.text}${kickoffMsg}` } as typeof parts[0];
                  }
                }
              }
            }
          } catch {
            // silently ignore doc mode kickoff failures
          }
        }

        const pendingInjection = consumePendingRagInjection(options.storePath);

        const count = await store.count();
        if (count === 0) return;

        const effectiveCfg = getEffectiveCfg();
        const hybridCfg = effectiveCfg.retrieval.hybridSearch;
        const retrievalStart = Date.now();
        const results = await dependencies.retrieve(text, embedder, store, {
          topK: effectiveCfg.retrieval.topK,
          minScore: pendingInjection ? 0 : effectiveCfg.retrieval.minScore,
          keywordIndex,
          keywordWeight: hybridCfg?.keywordWeight,
          queryPrefix: effectiveCfg.embedding.queryPrefix,
        });
        const retrievalTimeMs = Date.now() - retrievalStart;

        if (results.length === 0) {
          sessionLogger.onRagContext(input.sessionID, input.messageID, {
            chunkCount: 0,
            uniqueFiles: 0,
            contextTokens: 0,
            topScore: 0,
            retrievalTimeMs,
          });
          return;
        }

        if (pendingInjection === "chunks") {
          const maxChunks = effectiveCfg.openCode.autoInject?.maxChunks ?? 5;
          const topChunks = results.slice(0, maxChunks);
          const chunkContext = formatAutoInjectContext(
            topChunks,
            options.worktree,
            effectiveCfg.openCode.autoInject?.maxTokens ?? 3000,
            maxChunks
          );
          sessionLogger.onRagContext(input.sessionID, input.messageID, {
            chunkCount: topChunks.length,
            uniqueFiles: new Set(topChunks.map((r) => r.chunk.metadata.filePath)).size,
            contextTokens: chunkContext ? countTokens(chunkContext) : 0,
            topScore: topChunks[0]?.score ?? 0,
            retrievalTimeMs,
          });
          if (!chunkContext) return;
          const parts = output?.parts ?? (output?.message as Record<string, unknown>)?.parts;
          if (Array.isArray(parts) && parts.length > 0) {
            const first = parts[0] as Record<string, unknown>;
            if (typeof first.text === "string") {
              parts[0] = { ...first, text: `${first.text}\n\n${chunkContext}` } as typeof parts[0];
            }
          }
          return;
        }

        if (pendingInjection === "files") {
          const fileList = formatFileList(results, options.worktree, effectiveCfg.retrieval.topK);
          sessionLogger.onRagContext(input.sessionID, input.messageID, {
            chunkCount: 0,
            uniqueFiles: 0,
            contextTokens: fileList ? countTokens(fileList) : 0,
            topScore: results[0]?.score ?? 0,
            retrievalTimeMs,
          });
          if (!fileList) return;
          const parts = output?.parts ?? (output?.message as Record<string, unknown>)?.parts;
          if (Array.isArray(parts) && parts.length > 0) {
            const first = parts[0] as Record<string, unknown>;
            if (typeof first.text === "string") {
              parts[0] = { ...first, text: `${first.text}\n\n${fileList}` } as typeof parts[0];
            }
          }
          return;
        }

        if (text.trim().split(/\s+/).length <= 1) {
          const spaceCount = (text.match(/ /g) ?? []).length;
          appendDebugLog(options.logFilePath, {
            scope: "chat.message",
            message: `single-word prompt detected, suppressed auto-injection (spaceCount=${spaceCount})`,
          });
          return;
        }

        const autoInjectCfg = effectiveCfg.openCode.autoInject;
        let suggestionList: string | undefined;
        let injectedChunks: SearchResult[] = [];

        if (autoInjectCfg?.enabled !== false) {
          const minScore = autoInjectCfg?.minScore ?? 0.85;
          const maxChunks = autoInjectCfg?.maxChunks ?? 5;
          const maxTokens = autoInjectCfg?.maxTokens ?? 3000;
          const contentType = autoInjectCfg?.contentType ?? "file_paths";
          const highConfidence = results.filter((r) => r.score >= minScore);

          if (highConfidence.length > 0) {
            injectedChunks = highConfidence.slice(0, maxChunks);
            suggestionList = contentType === "chunks"
              ? formatAutoInjectContext(highConfidence, options.worktree, maxTokens, maxChunks)
              : formatFileList(highConfidence, options.worktree, effectiveCfg.retrieval.topK);
          }
        }

        sessionLogger.onRagContext(input.sessionID, input.messageID, {
          chunkCount: injectedChunks.length,
          uniqueFiles: new Set(injectedChunks.map((r) => r.chunk.metadata.filePath)).size,
          contextTokens: suggestionList ? countTokens(suggestionList) : 0,
          topScore: injectedChunks[0]?.score ?? 0,
          retrievalTimeMs,
        });

        if (!suggestionList) return;

        const parts = output?.parts ?? (output?.message as Record<string, unknown>)?.parts;
        if (Array.isArray(parts) && parts.length > 0) {
          const first = parts[0] as Record<string, unknown>;
          if (typeof first.text === "string") {
            parts[0] = { ...first, text: `${first.text}\n\n${suggestionList}` } as typeof parts[0];
          }
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

  appendDebugLog(logFilePath, {
    scope: "plugin",
    message: `OpenCode plugin enabled for ${input.directory}`,
  }, logLevel);

  // Probe vector dimension and create store with correct dimension
  const embedder = createEmbedder(effectiveCfg);
  let vectorDimension = 384;
  try {
    const probe = await embedder.embed(["dimension-probe"], "query");
    if (probe && probe[0] && probe[0].length > 0 && typeof probe[0][0] === "number") {
      vectorDimension = (probe[0] as number[]).length;
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
    });

    backgroundIndexers.set(input.directory, indexer);
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
