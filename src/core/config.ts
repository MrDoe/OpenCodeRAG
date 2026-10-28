/**
 * @fileoverview Configuration types and defaults for OpenCodeRAG. Defines RagConfig,
 * all sub-config interfaces, DEFAULT_CONFIG, validateConfig, and loadConfig.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { env } from "node:process";
import type { EmbeddingProvider, Chunker, VectorStore } from "./interfaces.js";
import { normalizeParserOverrides } from "./parser-overrides.js";

/** Registration of a custom chunker module for a set of file extensions. */
export interface ChunkerConfig {
  /** Module path or name exporting a Chunker implementation. */
  module: string;
  /** File extensions this chunker should handle. */
  extensions: string[];
}

/** HTTP proxy configuration for outbound API calls. */
export interface ProxyConfig {
  /** Proxy URL (e.g. "http://proxy:8080"). */
  url?: string;
  /** Optional proxy authentication username. */
  username?: string;
  /** Optional proxy authentication password. */
  password?: string;
  /** Comma-separated list of hosts that bypass the proxy. */
  noProxy?: string;
}

/**
 * ClickHouse vector-store settings (used when `vectorStore.provider` is
 * `"clickhouse"`). The local `vectorStore.path` remains a disposable cache
 * for manifest/keyword-index/quirks files; the durable copies live in the
 * project's `state_<namespace>` table.
 */
export interface ClickHouseConfig {
  /** HTTP(S) endpoint of the ClickHouse server (default `http://localhost:8123`). */
  url: string;
  /** Database that holds the per-project tables; created on first use. */
  database: string;
  /** ClickHouse user name. */
  username: string;
  /** Password. Prefer `passwordEnv` so the secret stays out of the repo file. */
  password?: string;
  /** Name of the environment variable holding the password (wins over `password` when set). */
  passwordEnv?: string;
  /**
   * Project namespace appended to the table names (`chunks_<ns>`, `state_<ns>`).
   * Defaults to a sanitized workspace directory name plus a short path hash;
   * set it explicitly when several machines must share one project index.
   */
  namespace?: string;
  /** Request timeout in milliseconds (default 30 000). */
  requestTimeoutMs?: number;
  /** Maximum HTTP connections in the client pool (default 10). */
  maxOpenConnections?: number;
  /** Enable gzip request/response compression (default true). */
  compression?: boolean;
  /** Durable workspace state bundled into `state_<ns>`. */
  state?: {
    /** Also sync `.desc-cache.json`. It is only a cache, so this defaults to false. */
    syncDescCache?: boolean;
  };
  /** Advisory single-writer lease shared by all machines using this namespace. */
  lease?: {
    /** Default true. */
    enabled?: boolean;
    /** Lease lifetime; renewed at a third of the TTL (default 90 seconds). */
    ttlSeconds?: number;
  };
  /** Refuse a full rebuild when the server has less free space than this (default 5 GiB). */
  diskFreeFloorBytes?: number;
  /**
   * Vector index mode. `"off"` (default) uses exact `cosineDistance` scans.
   * `"hnsw"` creates a `vector_similarity` index — requires ClickHouse >= 25.8
   * (26.x is verified). The index is bound to the dimension it was created
   * with; changing the embedding model then requires dropping the project
   * tables and re-indexing.
   */
  ann?: "off" | "hnsw";
  /** Over-fetch factor for filtered ANN searches (default 4, max 1000). */
  annFetchMultiplier?: number;
  /** Recompute final distances from the full-precision vectors (default true). */
  annWithRescoring?: boolean;
}

/** Configuration for automatic background re-indexing on file changes. */
export interface AutoIndexConfig {
  /** Whether auto-indexing is enabled. */
  enabled: boolean;
  /** Debounce delay in ms after a file change before triggering an index pass. */
  debounceMs: number;
  /** Periodic full index interval in ms (only used by git backend). */
  intervalMs: number;
  /** Change-detection backend: "chokidar" (FS events, default) or "git" (poll-based). */
  watcher?: WatcherBackend;
}

/** Handling of long-running shell commands in OpenCode sessions. */
export interface OpenCodeShellConfig {
  /** Inject guidance telling the agent to background long commands (default true). */
  backgroundGuidance?: boolean;
  /** Threshold (ms) above which a command is "long" (default 30000). */
  longRunningThresholdMs?: number;
  /** Default foreground timeout (ms) to recommend for shell calls (default 120000). */
  foregroundTimeoutMs?: number;
  /** Record a quirk when a foreground command exceeds the threshold (default true). */
  captureLongRunningQuirk?: boolean;
}

/** Behavior when a read tool query returns no results. */
export type ReadNoResultsBehavior = "hint" | "empty" | "error";

/** Supported file-change watcher backends. */
export type WatcherBackend = "chokidar" | "git";

/** Configuration for LLM-powered chunk description generation. */
export interface DescriptionConfig {
  /** Whether description generation is enabled. */
  enabled: boolean;
  /** LLM provider name ("ollama" or "openai"). */
  provider: string;
  /** Base URL of the LLM API. */
  baseUrl: string;
  /** Model name for descriptions. */
  model: string;
  /** API key for providers that require authentication. */
  apiKey?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Proxy configuration for API calls. */
  proxy?: ProxyConfig;
  /** System prompt instructing the LLM how to describe code. */
  systemPrompt: string;
  /**
   * EXPERIMENTAL: enable multi-chunk batch description requests (Ollama
   * provider only). Off by default — each chunk is described with its own
   * request. When enabled, up to `batchMaxChunks` chunks share one request
   * using ordinal labels ([CHUNK 1] ... reply "1: <desc>"); small models can
   * mangle the structured output, so batches that fail to parse fall back to
   * individual requests and batching auto-disables after 2 consecutive
   * failures. Part of the description manifest fingerprint — toggling it
   * re-describes files.
   */
  batchEnabled?: boolean;
  /** Maximum chunks per batch request. Only applies when `batchEnabled` is true. */
  batchMaxChunks?: number;
  /** Timeout per batch request in milliseconds. */
  batchTimeoutMs?: number;
  /** Number of concurrent batch requests. */
  batchConcurrency?: number;
  /** Maximum retry attempts on failure. */
  retryMax?: number;
  /** Base delay in ms between retries (exponential backoff). */
  retryBaseDelayMs?: number;
  /**
   * Whether the model may emit chain-of-thought tokens before the answer.
   * For the Ollama provider this sets the `think` request field. For
   * OpenAI-compatible providers `false` forwards
   * `chat_template_kwargs.enable_thinking=false` (llama.cpp / vLLM
   * convention); without it, reasoning models spend thousands of extra
   * tokens per description and indexing runs ~50x slower.
   */
  think?: boolean;
  /** Context window size for the LLM. */
  numCtx?: number;
  /** Ollama keep_alive value (e.g. "-1" for keep-in-memory) sent with /api/chat requests. */
  keepAlive?: string;
  /** Maximum content characters sent to the LLM. Chunks exceeding this use fallback descriptions. */
  maxContentChars?: number;
}

/** Configuration for vision-model-based image description generation. */
/**
 * Optional overrides for on-demand `describe_image` calls (OpenCode plugin
 * tool, MCP server, CLI `describe-image`). Fields omitted here fall back to
 * the indexing settings in {@link ImageDescriptionConfig}; the indexing
 * pipeline itself always uses the base settings.
 */
export interface ImageDescriptionOnDemandConfig {
  /** Vision provider name ("ollama", "openai", "anthropic", "google"). */
  provider?: string;
  /** Vision model name. */
  model?: string;
  /** Base URL of the vision API. */
  baseUrl?: string;
  /** API key for providers that require authentication. */
  apiKey?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Prompt template sent to the vision model. */
  prompt?: string;
  /** Whether to include chain-of-thought tokens. */
  think?: boolean;
  /** Context window size. */
  numCtx?: number;
  /** Ollama keep_alive value (e.g. "-1" for keep-in-memory) sent with /api/chat requests. */
  keepAlive?: string;
  /** Proxy configuration. */
  proxy?: ProxyConfig;
  /** Maximum image dimension (pixels) — larger images are resized before sending. */
  resizeMaxDimension?: number;
}

export interface ImageDescriptionConfig {
  /** Whether image description is enabled. */
  enabled: boolean;
  /** Vision provider name. */
  provider: string;
  /** Vision model name. */
  model: string;
  /** Base URL of the vision API. */
  baseUrl: string;
  /** API key for providers that require authentication. */
  apiKey?: string;
  /** Request timeout in milliseconds. */
  timeoutMs: number;
  /** Prompt template sent to the vision model. */
  prompt: string;
  /** Whether to include chain-of-thought tokens. */
  think?: boolean;
  /** Context window size. */
  numCtx?: number;
  /** Ollama keep_alive value (e.g. "-1" for keep-in-memory) sent with /api/chat requests. */
  keepAlive?: string;
  /** Proxy configuration. */
  proxy?: ProxyConfig;
  /** Maximum image dimension (pixels) — larger images are resized before sending. */
  resizeMaxDimension?: number;
  /**
   * Optional overrides for on-demand `describe_image` calls (OpenCode plugin
   * tool, MCP server, CLI `describe-image`). Omitted fields fall back to the
   * indexing settings above. The indexing pipeline ignores this section.
   */
  onDemand?: ImageDescriptionOnDemandConfig;
}

/**
 * Configuration for decision-model (tev1) calls via Ollama's
 * `/v1/systemone` endpoint — classification, routing, policy checks, and
 * rubrics.
 */
export interface DecisionConfig {
  /**
   * Whether the `make_decision` tool is available. Default false: tev1
   * requires Ollama >= 0.35 and an explicitly pulled model (`ollama pull tev1`).
   */
  enabled: boolean;
  /** Decision provider name. Only "ollama" is supported for now. */
  provider: string;
  /**
   * Base URL of the Ollama server. Both root URLs (`http://127.0.0.1:11434`)
   * and the `/api`-suffixed convention used by the other sections are
   * accepted — `/api` is stripped because decision models are served at
   * `/v1/systemone`.
   */
  baseUrl: string;
  /** Decision model name (`tev1`/`tev1:4b` or `tev1:0.8b`). */
  model: string;
  /** Request timeout in milliseconds. The first call may load the model. */
  timeoutMs: number;
  /** Ollama keep_alive value (e.g. "30m", "-1" for keep-in-memory). */
  keepAlive?: string;
  /** Proxy configuration. */
  proxy?: ProxyConfig;
  /**
   * When enabled, agent guidance instructs the agent to route choices through
   * `make_decision` before asking the user (proceed on a confident answer;
   * ask only when the model is undecided or the choice is preference-based).
   * Default false — asking the user stays the default behavior.
   */
  routeBeforeAsking?: boolean;
  /**
   * Maximum characters accepted for `state`. The decision context is small
   * (~2k tokens), so oversized states are rejected instead of truncated.
   */
  maxStateChars?: number;
  /** Maximum retry attempts on retryable failures. */
  retryMax?: number;
  /** Base delay in ms between retries (exponential backoff). */
  retryBaseDelayMs?: number;
}

/**
 * Configuration for the optional shell-command safety guard.
 *
 * Every `shell`/`bash` command is classified by a local decision model
 * (tev1 / Clef / Jev via `/v1/systemone`) before it runs. A command whose
 * `destructive` or `malicious` probability reaches `threshold` is escalated to
 * OpenCode's permission prompt; a clean command executes unchanged.
 *
 * The guard reuses the `decision` backend unless `provider`/`baseUrl`/`model`
 * override it here. It is applied through OpenCode V2's permission
 * `evaluate` hook, so it needs no rule changes in `opencode.json`.
 */
export interface ShellGuardConfig {
  /**
   * Master gate. Default false — the guard is opt-in because every shell
   * command then waits for the local decision model.
   */
  enabled: boolean;
  /** Decision provider override (defaults to `decision.provider`). */
  provider?: string;
  /** Endpoint override (defaults to `decision.baseUrl`). */
  baseUrl?: string;
  /** Model override (defaults to `decision.model`). */
  model?: string;
  /**
   * Flag a command when `p(destructive)` or `p(malicious)` reaches this
   * probability (0-1). Default 0.5. Lower = more prompts; tune against the
   * `shell.guard` debug-log lines.
   */
  threshold: number;
  /**
   * Abort a classification after this many ms and apply `onError`. Default
   * 10000. Kept short because the check sits on the critical path of every
   * shell command.
   */
  timeoutMs: number;
  /**
   * What to do when the classifier fails (timeout, endpoint down, malformed
   * answer). `"allow"` (default) executes the command and logs a warning;
   * `"ask"` escalates to the confirmation prompt.
   */
  onError?: "allow" | "ask";
  /**
   * Verdict cache TTL in ms. Default 600000 (10 min). 0 disables the cache.
   * Repeated identical commands are answered instantly.
   */
  cacheTtlMs: number;
  /** Maximum cached verdicts before the oldest are evicted. Default 256. */
  maxCacheEntries?: number;
}

export interface UiConfig {
  /** HTTP port for the UI server. */
  port: number;
  /** Whether to automatically open the browser on startup. */
  openBrowser: boolean;
}

/** Configuration for the automated documentation mode that adds JSDoc/TSDoc to source files. */
export interface DocumentationModeConfig {
  /** Whether documentation mode is available. */
  enabled: boolean;
  /** Whether to start documentation mode automatically on launch. */
  autoStart: boolean;
  /** Number of files to process per batch. */
  batchSize: number;
  /** System prompt for the documentation agent. */
  systemPrompt: string;
}

/** Configuration for the wiki mode that instructs the AI agent to maintain a persistent knowledge wiki. */
export interface WikiModeConfig {
  /** Whether wiki mode is enabled. */
  enabled: boolean;
  /** System prompt for the wiki maintainer agent. */
  systemPrompt: string;
}

/** Configuration for the quirk/experiential memory system. */
export interface MemoryConfig {
  /** Whether quirk memory is enabled. */
  enabled: boolean;
  /** Whether relevant quirks should be auto-injected into the prompt during retrieval. */
  autoInject: boolean;
  /** Minimum confidence (0-1) for a quirk to be returned. */
  minConfidence: number;
  /** Minimum raw vector similarity (0-1, cosine mapped to [0,1]) for a quirk to be recalled by manual `recall_quirks` calls. */
  recallMinScore: number;
  /** Minimum raw vector similarity (0-1, cosine mapped to [0,1]) for quirks to
   *  be AUTO-injected into the prompt (both the system-prompt transform and the
   *  user message). Deliberately a high bar: injected quirks occupy context on
   *  every turn, so only strongly related ones should reach the prompt - e.g.
   *  0.85 admits only strongly related notes. Manual `recall_quirks` calls use
   *  `recallMinScore` instead. */
  autoInjectMinScore: number;
  /** Maximum latency budget (ms) for auto-inject quirk recall. If exceeded, injection is skipped. */
  autoInjectLatencyBudgetMs: number;
  /** Max quirks to auto-inject per turn (default 1). */
  autoInjectTopK: number;
  /**
   * Minimum number of shared word tokens (≥3 chars) between a candidate quirk's
   * content and the user's *current* message for the quirk to be auto-injected
   * (default 2). Acts as a relevance gate against meta-quirks that match only
   * the prior assistant text in the combined recall query. Set to `0` to disable.
   */
  autoInjectMinTokenOverlap: number;
  /** Automatically extract quirks from each completed agent turn. */
  passiveCapture: boolean;
  /** Upgrade the system-prompt nudge into a mandatory trigger. */
  promptEnforcement: boolean;
  /** Summarize the full session transcript into quirks at session end. */
  sessionEndExtraction: boolean;
  /** Max quirks to auto-capture per turn/session-end pass. */
  autoCaptureMaxPerTurn: number;
  /** Lexical similarity threshold (0-1) above which a candidate is considered a duplicate and skipped. */
  autoCaptureDedupThreshold: number;
  /**
   * Inject matching quirks into the next model request after a FAILED tool call
   * (default true). Failed calls are also appended to the auto-capture pipeline,
   * so recurring errors can become quirks.
   */
  injectOnToolError: boolean;
  /** Minimum raw vector similarity (0-1, cosine mapped to [0,1]) for a quirk to be injected after a tool error (default 0.7). */
  toolErrorMinScore: number;
  /** Max quirks injected per tool error (default 2). */
  toolErrorTopK: number;
  /** Minimum shared word tokens (>=3 chars) between a quirk and the error text; 0 disables (default 1). */
  toolErrorMinTokenOverlap: number;
  /** Cooldown per normalized tool-error signature in ms (default 60000). */
  toolErrorCooldownMs: number;
  /** Max tool-error quirk injections per session (default 3). */
  toolErrorMaxPerSession: number;
  /** Latency budget (ms) for tool-error quirk recall; exceeded -> no injection (default 1500). */
  toolErrorLatencyBudgetMs: number;
  /**
   * Automatically create and persist a quirk when a failed tool call has no
   * matching quirk memory (default true). The new quirk is a deterministic
   * template built from the tool name and the error text — no LLM involved.
   * It is recorded for FUTURE sessions; it is not injected into the turn that
   * produced the failure (see `toolErrorInjectCreated`).
   */
  autoCreateOnToolError: boolean;
  /** Max tool-error quirks CREATED per session (default 2). */
  toolErrorCreateMaxPerSession: number;
  /** Cooldown per normalized tool-error signature for creation in ms (default 600000 = 10 min). */
  toolErrorCreateCooldownMs: number;
  /**
   * Minimum raw similarity (0-1) for an existing quirk to count as "an
   * equivalent quirk already exists" and therefore suppress creation
   * (default 0.7). Deliberately EQUAL to `toolErrorMinScore`: measured on a
   * real workspace, an error query scores 0.55-0.63 against arbitrary stored
   * quirks, so a lower floor sits inside the noise band and matches unrelated
   * quirks — which suppressed creation on every real failure. The exact
   * duplicate check (same tool + same cause class) is done by metadata.
   */
  toolErrorCreateMinScore: number;
  /** Latency budget (ms) for the tool-error creation path (embed + store write); default 2000. */
  toolErrorCreateLatencyBudgetMs: number;
  /**
   * Inject a freshly created tool-error quirk into the turn that produced the
   * failure (default false). The agent already saw the raw error, so the
   * created quirk carries no new information for that turn.
   */
  toolErrorInjectCreated: boolean;
  /**
   * Surface known tool gotchas in the system prompt BEFORE the model picks a
   * tool (default true). A failure that already happened in an earlier
   * session is injected as a "known tool gotcha", so the model does not repeat
   * it. Only gotchas whose tool is in the session's tool catalog are injected.
   */
  toolErrorProactiveInject: boolean;
  /** Max tool gotchas injected into the system prompt per request (default 5). */
  toolErrorProactiveMaxItems: number;
  /**
   * Intercept failures the host does NOT report as tool errors (default true).
   * A command that exits non-zero, a script that raises, a file that cannot be
   * read, a failed model call — the host reports all of them as SUCCESS, so
   * without this the quirk path never saw them. Detection is
   * high-precision on purpose: a false positive costs a recall, a possible
   * quirk write, and an injected block in the next model request.
   */
  interceptAllErrors: boolean;
  /**
   * Allow a failure detected this way to CREATE a quirk (default true). The
   * exact duplicate check (same tool + same cause class) keeps it bounded to
   * one quirk per failure kind, so a command that fails differently each time
   * still yields a single entry.
   */
  autoCreateOnInterceptedError: boolean;
  /** Decay settings for aging quirks. */
  decay: {
    /** Whether confidence decays over time. */
    enabled: boolean;
    /** Number of days after which confidence halves. */
    halfLifeDays: number;
  };
}

/** Configuration for the terminal UI (TUI) keybindings. */
export interface TuiConfig {
  /** Keybinding to toggle the file list panel. */
  fileListKeybinding: string;
  /** Keybinding to toggle the chunk viewer panel. */
  chunksKeybinding: string;
  /**
   * Keybinding to open the RAG settings dialog. Defaults to `alt+s`, which
   * every terminal delivers (ESC + `s`), including VS Code's PowerShell
   * terminal. A `ctrl+shift+<letter>` chord only works where the Kitty
   * keyboard protocol is negotiated; when one is configured, the TUI also
   * registers `ctrl+alt+s` / `alt+s` fallbacks (see docs).
   */
  settingsKeybinding: string;
}

/** Configuration for the standalone MCP (Model Context Protocol) server. */
export interface McpConfig {
  /** Whether to auto-start the MCP server on plugin load. Default false — agent tools run in-process regardless. Set true only when an external MCP client needs to connect via `opencode-rag mcp`. */
  enabled: boolean;
}

/** Configuration for workspace setup behaviour. */
export interface SetupConfig {
  /**
   * Create missing workspace files (config, skills, AGENTS.md) when the plugin
   * loads in a repository that has not been set up yet. Create-only: existing
   * files are never overwritten. Default true.
   */
  autoScaffold: boolean;
}

/** Configuration for automatic self-updates. */
export interface AutoUpdateConfig {
  /** Whether update checking is enabled (defaults to true). */
  enabled: boolean;
  /** When true, automatically install a newer release on startup (default false). */
  autoInstall?: boolean;
  /** Cooldown window (ms) before re-attempting the same version (default 3 600 000 = 1h). */
  cooldownMs?: number;
  /** Back off after this many consecutive failures (default 3). */
  maxConsecutiveFailures?: number;
}

/** Configuration for post-retrieval context window optimization (adjacent merge, similarity dedup, file diversity cap). */
export interface ContextOptimizationConfig {
  /** Whether context window optimization is enabled. */
  enabled: boolean;
  /** Maximum number of chunks to keep per file (0 = unlimited). */
  maxPerFile: number;
  /** Whether to merge adjacent chunks from the same file. */
  mergeAdjacent: boolean;
  /** Maximum line gap between adjacent chunks that can still be merged. */
  adjacentGapThreshold: number;
  /** Jaccard similarity threshold (0-1) for same-file dedup. */
  similarityThreshold: number;
}

/**
 * Optional cross-encoder rerank stage (opt-in, default OFF).
 *
 * After hybrid fusion the top candidates are re-scored by a cross-encoder
 * (e.g. Qwen3-Reranker served by llama-server's `/v1/rerank`). The stage is a
 * pure reorder (+ optional gate); the fusion `minScore` gate runs unchanged
 * BEFORE reranking, so disabling reranking reproduces today's behavior
 * exactly. Provider errors/timeouts always degrade to the fusion order —
 * retrieval never fails because of the reranker.
 */
export interface RerankingConfig {
  /** Master switch — when false (default) no reranker is created. */
  enabled: boolean;
  /** Rerank provider implementation. @default "llama-server" */
  provider?: "llama-server";
  /** Base URL of the rerank endpoint (e.g. http://127.0.0.1:8080/v1). The stage POSTs to {baseUrl}/rerank. */
  baseUrl: string;
  /** Optional bearer token (e.g. llama-swap auth). */
  apiKey?: string;
  /** Reranker model name passed to the server. */
  model: string;
  /** How many fused candidates to send per query (after the fusion minScore gate). @default 20 */
  candidates?: number;
  /** Each candidate's document text is truncated to this many characters. @default 1200 */
  maxDocChars?: number;
  /** Additional gate on the rerank score itself (0 = pure reorder, default). NOT comparable to retrieval.minScore — rerank scores are provider-scaled, not calibrated. */
  minScore?: number;
  /** Per-call timeout in ms; on expiry the fusion order is kept. @default 4000 */
  // The 2026-10-02 eval measured p50 ≈ 3.0 s / p95 ≈ 3.8 s for 20 candidates on a local
  // 0.6B reranker — the old 1500 ms default degraded nearly every query to fusion order.
  timeoutMs?: number;
  /**
   * Query template applied before scoring. With a `{query}` placeholder the
   * query is substituted, otherwise the template is used as a prefix.
   * Use this for instruct-style rerankers (e.g. Qwen3-Reranker) — do NOT
   * reuse embedding.queryPrefix here. @default ""
   */
  queryTemplate?: string;
  /**
   * Document text: raw content, or description + content.
   * `"content+description"` was the best arm in the 2026-10-02 eval (Hit@1 29.2 % vs 22.9 %,
   * MRR 0.466 vs 0.414) — descriptions carry signal the raw code text misses.
   * @default "content+description"
   */
  docField?: "content" | "content+description";
  /** Proxy configuration for the rerank endpoint. */
  proxy?: ProxyConfig;
}

/** Complete configuration for the OpenCodeRAG pipeline. */
export interface RagConfig {
  /** Embedding provider settings (model, endpoint, prefixes). */
  embedding: {
    /** Provider name: "ollama", "openai", or "cohere". */
    provider: string;
    /** Base URL of the embedding API. */
    baseUrl: string;
    /** API key for authenticated providers. */
    apiKey?: string;
    /** Model name for embeddings. */
    model: string;
    /** Request timeout in milliseconds. */
    timeoutMs?: number;
    /** Proxy configuration. */
    proxy?: ProxyConfig;
    /** Prefix prepended to documents before embedding (e.g. "search_document:"). */
    documentPrefix?: string;
    /** Prefix prepended to queries before embedding (e.g. "search_query:"). */
    queryPrefix?: string;
    /** Cached embedding vector dimension. Probed once on first startup, then persisted to config. */
    vectorDimension?: number;
    /** Ollama keep_alive value (e.g. "-1" for keep-in-memory) sent with /api/embed requests. */
    keepAlive?: string;
  };
  /** Indexing pipeline controls: what to index, concurrency, batch sizes. */
  indexing: {
    /** File extensions to include in indexing. */
    includeExtensions: string[];
    /**
     * Directory/file name patterns to exclude.
     *
     * Semantics (same for `excludeFiles`):
     * - Plain name (no path separator, no glob chars `* ? [ { (`):
     *   matches that **basename** at **any depth** (case-insensitive).
     * - Basename glob (glob chars, no separator):
     *   matches the segment at any depth via glob.
     * - Path pattern (contains a separator or `**`):
     *   **anchored to the workspace root** — matched as a glob against each
     *   ancestor prefix (so it excludes the matched directory and all contents).
     *
     * Supports standard wildcards: `*`, `?`, `[...]`, `{a,b}`, `(pattern)`.
     * Use `/` as path separator (converted automatically). Matching is
     * case-insensitive and dot-inclusive.
     */
    excludeDirs: string[];
    /**
     * File-name patterns to exclude (same semantics as `excludeDirs`).
     * Plain names match any file with that basename at any depth; path
     * patterns are anchored to the workspace root.
     */
    excludeFiles?: string[];
    /**
     * Workspace-relative folder paths to **restrict indexing to**.
     *
     * When non-empty, only files inside these folders (and their
     * subfolders) are indexed; files directly in the workspace root are
     * NOT indexed. `excludeDirs`/`excludeFiles` still apply inside the
     * included folders. Empty or omitted = whole workspace (default).
     *
     * Semantics:
     * - Entries are **anchored to the workspace root** (unlike
     *   `excludeDirs`, plain names do NOT match at any depth).
     * - Supports globs (`docs/**`, `src/{a,b}`); use `/` as separator
     *   (converted automatically). Matching is case-insensitive.
     */
    includeDirs?: string[];
    /** Number of overlapping lines between adjacent chunks. */
    chunkOverlap: number;
    /** Maximum lines per chunk — oversized chunks are split into windows with
     *  `chunkOverlap` lines of context between them. 0 = no limit (whole AST node). */
    maxChunkSize?: number;
    /** Minimum file size in bytes to index (0 = no minimum). */
    minFileSizeBytes?: number;
    /** Maximum concurrent file processing tasks. */
    concurrency: number;
    /** Number of texts sent per embedding batch. */
    embedBatchSize: number;
    /** Maximum concurrent embedding batch requests. */
    embedConcurrency?: number;
    /** Maximum batch size for Ollama's /embed endpoint. */
    ollamaMaxBatchSize?: number;
    /** Maximum concurrent description generation requests. */
    descriptionConcurrency?: number;
    /**
     * Include LLM-generated chunk descriptions in the text that gets embedded.
     *
     * Descriptions help general-purpose embedding models align natural-language
     * queries with raw code. Code-specialized models (e.g. jina-code-embeddings,
     * trained for NL→code retrieval with instruction prefixes) do not need the
     * crutch — and their passage prompt expects a code snippet, not prose.
     * When false, descriptions are still generated and stored (search results,
     * web UI), but only path/meta header/content are embedded.
     * @default true
     */
    embedDescriptions?: boolean;
    /**
     * Maximum file size in bytes for SVG/XML files before chunking is skipped.
     * Large SVGs can cause tree-sitter to hang. Set to 0 for no limit.
     * @default 1_048_576 (1 MB)
     */
    maxSvgSizeBytes?: number;
    /**
     * Run vector-store compaction + version pruning every N windows during a
     * long index pass. LanceDB keeps every committed version on disk, so
     * without periodic maintenance the store phase slows down as the index
     * grows (version-manifest accumulation). 0 disables mid-run optimization
     * (the store is still optimized once at the end of a pass).
     * @default 8
     */
    optimizeIntervalWindows?: number;
  };
  /** Vector storage backend configuration. */
  vectorStore: {
    /**
     * Filesystem path or `memory://` URI for a local vector database. With
     * `provider: "clickhouse"` this is only a **disposable local cache** for
     * the manifest, keyword index, quirks and other workspace state — the
     * durable copies live in ClickHouse.
     */
    path: string;
    /** Backend provider ("lancedb", "memory", or "clickhouse"). */
    provider?: "lancedb" | "memory" | "clickhouse";
    /** ClickHouse connection settings (required when provider is "clickhouse"). */
    clickhouse?: ClickHouseConfig;
  };
  /** Retrieval settings for query-time search. */
  retrieval: {
    /** Default number of results to return. */
    topK: number;
    /** Minimum relevance score threshold (0-1). */
    minScore: number;
    /**
     * How `minScore` reads the score (default `"fused"`).
     *
     * The fused hybrid score's scale depends on `hybridSearch.keywordWeight`:
     * a vector-only hit can never exceed `1 - kw`, so at `kw = 0.4` a fixed
     * `minScore` of 0.65 silently demands a DUAL hit (13.5 of 20 results
     * survive vs 17.7 at `kw = 0`). `"normalized"` divides the score by the
     * maximum that result could reach, so the threshold keeps its meaning at
     * every keyword weight. `"fused"` keeps today's behaviour — the default
     * does not change silently; a default flip needs a bigger golden set.
     */
    minScoreMode?: "fused" | "normalized";
    /** Hybrid search (vector + keyword) configuration. */
    hybridSearch?: {
      /** Whether hybrid search is enabled. */
      enabled: boolean;
      /** Weight for keyword scores in fusion (0 = vector only, 1 = keyword only). */
      keywordWeight: number;
      /** Keyword weight for symbol-style queries (a bare identifier like
       *  `cosineSimilarity`). Keyword search nails exact symbol matches, so these
       *  get a higher weight than natural-language queries. Defaults to keywordWeight. */
      symbolKeywordWeight?: number;
      /** Multiplier (0-1) on the keyword contribution of documentation chunks.
       *  Docs name concepts literally and otherwise outrank the implementation. */
      docKeywordDemotion?: number;
      /** Multiplier (0-1) on the keyword contribution of test chunks. */
      testKeywordDemotion?: number;
    };
    /** Context window optimization settings for post-retrieval quality filtering. */
    contextOptimization?: ContextOptimizationConfig;
  };
  /** Optional cross-encoder rerank stage (opt-in; absent = disabled). */
  reranking?: RerankingConfig;
  /** OpenCode plugin integration settings. */
  openCode: {
    /** Whether the OpenCode plugin is active. */
    enabled: boolean;
    /** Maximum chunks to include in context tool responses. */
    maxContextChunks: number;
    /** Auto-indexing behavior on file changes. */
    autoIndex?: AutoIndexConfig;
    /** Whether to override the built-in read tool with RAG-enhanced version. */
    readOverride?: boolean;
    /** Maximum characters returned by the overridden read tool. */
    maxReadOutputChars?: number;
    /** Behavior when read returns no results. */
    readNoResultsBehavior?: ReadNoResultsBehavior;
    /** Maximum related files shown when read results are empty. */
    readRelatedFilesMax?: number;
    /** Whether to inject RAG tool guidance into system prompts when the session's tool catalog exposes the RAG tools (default true). */
    injectSystemPrompt?: boolean;
    /** Whether to grant the read-only RAG tools to the built-in `explore` agent (default true). */
    exploreAgentTools?: boolean;
    /** Handling of long-running shell commands (backgrounding guidance + measurement). */
    shell?: OpenCodeShellConfig;
  };
  /** Custom chunker module registrations. */
  chunkers?: ChunkerConfig[];
  /** Per-language chunking overrides (e.g. node type filters). */
  chunking?: {
    /** Map of language to allowed/blocked AST node type patterns. */
    nodeTypes?: Record<string, string[]>;
    /**
     * Map of file extension to parser (chunker) language, overriding the
     * built-in mapping. Both new extensions and existing entries can be
     * remapped:
     *
     * ```json
     * { "chunking": { "parsers": { ".c": "cpp", ".cu": "cpp" } } }
     * ```
     *
     * Keys are normalized (lowercased, leading dot added); values must be a
     * registered parser language (`typescript`, `cpp`, `python`, … or `text`
     * for the fallback parser). Applied consistently to indexing/chunking,
     * `get_file_skeleton` (tool + MCP), and read-tool language labels.
     * Mapped extensions are implicitly added to the scanned set — no need to
     * repeat them in `indexing.includeExtensions`.
     *
     * Changing a mapping changes chunk boundaries: re-run
     * `opencode-rag index --force` afterwards.
     */
    parsers?: Record<string, string>;
  };
  /** LLM-based chunk description generation config. */
  description?: DescriptionConfig;
  /** Vision-model-based image description config. */
  imageDescription?: ImageDescriptionConfig;
  /** Decision-model (tev1) config for the `make_decision` tool. */
  decision?: DecisionConfig;
  /** Optional shell-command safety guard (decision-model vetting + confirmation prompt). */
  shellGuard?: ShellGuardConfig;
  /** Automated documentation mode config. */
  documentationMode?: DocumentationModeConfig;
  /** Wiki mode config that instructs the AI agent to maintain a persistent knowledge wiki. */
  wikiMode?: WikiModeConfig;
  /** MCP server integration config. */
  mcp?: McpConfig;
  /** Workspace setup behaviour (auto-scaffold). */
  setup?: SetupConfig;
  /** Auto-update checking config. */
  autoUpdate?: AutoUpdateConfig;
  /** Quirk memory config for experiential agent memory. */
  memory?: MemoryConfig;
  /** Web dashboard UI config. */
  ui?: UiConfig;
  /** Terminal UI keybinding config. */
  tui: TuiConfig;
  /** Logging config. */
  logging: LoggingConfig;
}

/** Severity levels for logging output. */
export type LogLevel = "debug" | "info" | "error" | "none";

/** Configuration for structured file logging. */
export interface LoggingConfig {
  /** Minimum severity level to record. */
  level: LogLevel;
  /** Path to the log file. */
  logFilePath: string;
}

export const DEFAULT_CONFIG: RagConfig = {
  embedding: {
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434/api",
    model: "qwen3-embedding:0.6b",
    timeoutMs: 120000,
  },
  indexing: {
    includeExtensions: [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".py",
      ".java",
      ".go",
      ".md",
      ".mdx",
      ".c",
      ".h",
      ".cpp",
      ".cc",
      ".cxx",
      ".hpp",
      ".hxx",
      ".cs",
      ".aspx",
      ".razor",
      ".cshtml",
      ".json",
      ".html",
      ".htm",
      ".css",
      ".xml",
      ".csproj",
      ".sln",
      ".rs",
      ".rb",
      ".kt",
      ".kts",
      ".swift",
      ".tex",
      ".pdf",
      ".docx",
      ".doc",
      ".xls",
      ".xlsx",
      ".sh",
      ".bash",
      ".zsh",
      ".png",
      ".php",
      ".ps1",
      ".psm1",
      ".psd1",
      ".ini",
      ".cfg",
      ".yaml",
      ".yml",
      ".toml",
      ".sql",
      ".ssl",
      ".jpg",
      ".jpeg",
      ".gif",
      ".bmp",
      ".svg",
      ".webp",      
      "dockerfile",
      "containerfile",
      ".dockerfile",
      ".containerfile",
    ],
    excludeDirs: [
      "node_modules",
      ".git",
      ".opencode",
      "dist",
      "build",
      "__pycache__",
      ".venv",
      ".claude",
      ".github",
      "memory:",
      "wasm",
      ".commandcode",
      ".agents",
      "graphify-out",
      ".vscode",
      ".vs",
      ".idea",
      ".next",
      ".nuxt",
      ".turbo",
      ".angular",
      ".svelte-kit",
      ".gradle",
      ".dart_tool",
      ".cache",
    ],
    excludeFiles: [
      "package-lock.json",
    ],
    chunkOverlap: 0,
    maxChunkSize: 0,
    minFileSizeBytes: 0,
    concurrency: 8,
    embedBatchSize: 100,
    embedConcurrency: 3,
    ollamaMaxBatchSize: 100,
    descriptionConcurrency: 4,
    embedDescriptions: true,
    maxSvgSizeBytes: 1_048_576,
    optimizeIntervalWindows: 8,
  },
  vectorStore: {
    path: "./.opencode/rag_db",
    provider: "lancedb",
    clickhouse: {
      url: "http://localhost:8123",
      database: "OpenCodeRAG",
      username: "default",
      password: "",
      passwordEnv: "OPENCODERAG_CLICKHOUSE_PASSWORD",
      namespace: "",
      requestTimeoutMs: 30_000,
      maxOpenConnections: 10,
      compression: true,
      state: { syncDescCache: false },
      lease: { enabled: true, ttlSeconds: 90 },
      diskFreeFloorBytes: 5 * 1024 * 1024 * 1024,
      ann: "off",
      annFetchMultiplier: 4,
      annWithRescoring: true,
    },
  },
  retrieval: {
    topK: 20,
    minScore: 0.35,
    minScoreMode: "fused",
    hybridSearch: {
      enabled: true,
      keywordWeight: 0.4,
      symbolKeywordWeight: 0.6,
      docKeywordDemotion: 0.5,
      testKeywordDemotion: 0.6,
    },
    contextOptimization: {
      enabled: true,
      maxPerFile: 3,
      mergeAdjacent: true,
      adjacentGapThreshold: 5,
      similarityThreshold: 0.8,
    },
  },
  reranking: {
    enabled: false,
    provider: "llama-server",
    // llama-server's default port; llama-swap users typically point this at
    // their swap proxy (which routes v1/rerank) instead.
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "qwen3-reranker-0.6b",
    candidates: 20,
    maxDocChars: 1200,
    minScore: 0,
    timeoutMs: 4000,
    queryTemplate: "",
    docField: "content+description",
  },
  openCode: {
    enabled: true,
    maxContextChunks: 10,
    readOverride: true,
    injectSystemPrompt: true,
    exploreAgentTools: true,
    shell: {
      backgroundGuidance: true,
      longRunningThresholdMs: 30000,
      foregroundTimeoutMs: 120000,
      captureLongRunningQuirk: true,
    },
    autoIndex: {
      enabled: false,
      debounceMs: 2000,
      intervalMs: 300000,
      watcher: "chokidar",
    },
  },
  imageDescription: {
    enabled: true,
    provider: "ollama",
    model: "minicpm-v4.6:latest",
    baseUrl: "http://127.0.0.1:11434/api",
    timeoutMs: 60000,
    prompt: "Describe this image in 1-2 sentences: what it shows, its purpose, and key visual elements.",
    think: false,
    numCtx: 2048,
    resizeMaxDimension: 1024,
  },
  decision: {
    enabled: false,
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434/api",
    model: "tev1:4b",
    timeoutMs: 120000,
    keepAlive: "30m",
    maxStateChars: 8000,
    routeBeforeAsking: false,
    retryMax: 2,
    retryBaseDelayMs: 500,
  },
  shellGuard: {
    enabled: false,
    threshold: 0.5,
    timeoutMs: 10000,
    onError: "allow",
    cacheTtlMs: 600000,
    maxCacheEntries: 256,
  },
  description: {
    enabled: true,
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434/api",
    model: "qwen2.5:3b",
    think: false,
    numCtx: 4096,
    timeoutMs: 60000,
    systemPrompt:
      "Describe this code in ONE concise sentence (max 20 words): purpose, key inputs/outputs. No code repetition.",
    batchEnabled: false,
    batchMaxChunks: 25,
    batchTimeoutMs: 120000,
    batchConcurrency: 1,
    retryMax: 3,
    retryBaseDelayMs: 1000,
    maxContentChars: 4000,
  },
  documentationMode: {
    enabled: false,
    autoStart: true,
    batchSize: 5,
    systemPrompt:
      "You are a code documentation expert. Your task is to document any existing, undocumented codebase.\n\n" +
      "## Instructions\n\n" +
      "For each file in this codebase:\n\n" +
      "1. **Read the full file** to understand its structure and logic.\n" +
      "2. **Document every public symbol**: classes, interfaces, types, methods, functions, properties, and exported constants.\n" +
      "3. **Use the codebase's existing style** — look at neighboring files for conventions (JSDoc, TSDoc, etc.).\n" +
      "4. **Write descriptions that explain *what* and *why*, not *how*** — the code already shows *how*.\n" +
      "5. **Include `@param`** (with types and descriptions), **`@returns`**, and **`@throws`** where applicable.\n" +
      "6. **Do NOT change any implementation code** — only add/update doc comments.\n" +
      "7. **Do NOT add comments that restate the obvious** (e.g., `// increment i` on `i++`).\n" +
      "8. **For private/internal symbols**, add concise inline comments only when the logic is non-obvious.\n" +
      "9. **Preserve any existing comments** — update them only if they are incorrect.\n\n" +
      "## Output format\n\n" +
      "Return your changes as a list of file paths with the full new content of the comment block for each modified symbol. Do NOT output the entire file unless asked.",
  },
  wikiMode: {
    enabled: true,
    systemPrompt:
      "You are a wiki maintainer for this codebase. You incrementally build and maintain " +
      "a persistent knowledge wiki at `.opencode/wiki/` — a structured, interlinked collection " +
      "of markdown files that synthesizes knowledge from the codebase, documentation, and your conversations.\n\n" +
      "## Three layers\n\n" +
      "- **Raw sources**: code, docs, READMEs (immutable — read with `search_semantic`, `get_file_skeleton`, `find_usages`, `read`)\n" +
      "- **Wiki**: `.opencode/wiki/*.md` (you own this layer — create, update, and maintain ALL pages)\n" +
      "- **Schema**: this prompt (the protocol you follow)\n\n" +
      "## Wiki layout\n\n" +
      "`.opencode/wiki/`\n" +
      "- `index.md` — content catalog: every page listed with a link and one-line summary\n" +
      "- `log.md` — append-only timeline: `## [date] op | title`\n" +
      "- `entities/` — pages for modules, services, key classes, components\n" +
      "- `concepts/` — pages for patterns, conventions, architectural decisions, gotchas\n" +
      "- `sources/` — summaries of external sources (articles, specs, discussions)\n\n" +
      "## Page frontmatter\n\n" +
      "Every page should start with:\n" +
      "```\n" +
      "---\n" +
      "title: <page title>\n" +
      "tags: [relevant tags]\n" +
      "sourceRefs: [file paths or URLs this page synthesizes]\n" +
      "lastReviewed: <date>\n" +
      "---\n" +
      "```\n\n" +
      "## Operations\n\n" +
      "### Ingest (when you learn something new)\n" +
      "1. Read the source (code, doc, external article)\n" +
      "2. Extract key information — what it does, why it exists, how it connects to existing knowledge\n" +
      "3. Create or update relevant entity/concept pages\n" +
      "4. Add cross-references with `[[wiki/page-name]]` links between related pages\n" +
      "5. Update `index.md` with any new pages\n" +
      "6. Append to `log.md`: `## [date] ingest | page title`\n\n" +
      "### Query (when the user asks a question)\n" +
      "1. Read `index.md` first to find relevant wiki pages\n" +
      "2. Read those pages with the `read` tool\n" +
      "3. If the wiki is insufficient, use `search_semantic` for code-level retrieval\n" +
      "4. Synthesize an answer citing wiki pages where possible\n" +
      "5. If the answer produced valuable analysis, file it back as a new wiki page\n\n" +
      "### Lint (periodically, or when `/wiki lint` is invoked)\n" +
      "Check for:\n" +
      "- Orphan pages with no inbound `[[links]]`\n" +
      "- Stale pages whose `sourceRefs` files changed since `lastReviewed`\n" +
      "- Contradictions between pages\n" +
      "- Important concepts mentioned but lacking their own page\n" +
      "Append findings to `log.md`.\n\n" +
      "### Seed (when `/wiki seed` is invoked)\n" +
      "Generate initial wiki from existing sources:\n" +
      "1. Read README and top-level docs for project overview → create overview page\n" +
      "2. Scan file structure with `get_file_skeleton` for major modules → create entity pages\n" +
      "3. Identify common conventions from code patterns → create concept pages\n" +
      "4. Create `index.md` listing all pages\n" +
      "5. Create `log.md` with initial entry\n" +
      "6. Keep pages focused — one concept per page, short prose\n\n" +
      "## Principles\n\n" +
      "- You write and maintain ALL wiki pages — never ask the user to do it\n" +
      "- Good answers and analyses get filed back as new pages — explorations compound\n" +
      "- One concept per page — short, focused, cross-referenced\n" +
      "- The wiki is git-trackable in `.opencode/` — every edit is a diff",
  },
  mcp: {
    enabled: false,
  },
  setup: {
    autoScaffold: true,
  },
  autoUpdate: {
    enabled: true,
    autoInstall: false,
    cooldownMs: 3_600_000,
    maxConsecutiveFailures: 3,
  },
  memory: {
    enabled: true,
    autoInject: true,
    minConfidence: 0.5,
    recallMinScore: 0.72,
    autoInjectMinScore: 0.75,
    autoInjectLatencyBudgetMs: 2000,
    autoInjectTopK: 1,
    autoInjectMinTokenOverlap: 2,
    passiveCapture: true,
    promptEnforcement: true,
    sessionEndExtraction: true,
    autoCaptureMaxPerTurn: 2,
    autoCaptureDedupThreshold: 0.85,
    injectOnToolError: true,
    toolErrorMinScore: 0.7,
    toolErrorTopK: 2,
    toolErrorMinTokenOverlap: 1,
    toolErrorCooldownMs: 60_000,
    toolErrorMaxPerSession: 3,
    toolErrorLatencyBudgetMs: 1500,
    autoCreateOnToolError: true,
    toolErrorCreateMaxPerSession: 2,
    toolErrorCreateCooldownMs: 600_000,
    toolErrorCreateMinScore: 0.7,
    toolErrorCreateLatencyBudgetMs: 2000,
    toolErrorInjectCreated: false,
    toolErrorProactiveInject: true,
    interceptAllErrors: true,
    autoCreateOnInterceptedError: true,
    toolErrorProactiveMaxItems: 5,
    decay: {
      enabled: false,
      halfLifeDays: 30,
    },
  },
  ui: {
    port: 3210,
    openBrowser: true,
  },
  tui: {
    fileListKeybinding: "ctrl+enter",
    chunksKeybinding: "ctrl+alt+enter",
    settingsKeybinding: "alt+s",
  },
  logging: {
    level: "info",
    logFilePath: "./.opencode/opencode-rag.log",
  },
};

/** Resolve effective logging config from a config object, falling back to defaults and env vars. */
export function resolveLogConfig(config: RagConfig): LoggingConfig {
  return {
    level: config.logging?.level ?? DEFAULT_CONFIG.logging.level,
    logFilePath: config.logging?.logFilePath ?? env.LOG_FILE_PATH ?? DEFAULT_CONFIG.logging.logFilePath,
  };
}

/** Runtime context passed through the indexing and retrieval pipeline. */
export interface RagContext {
  /** Resolved pipeline configuration. */
  config: RagConfig;
  /** Configured embedding provider instance. */
  embedder: EmbeddingProvider;
  /** Configured chunker instance. */
  chunker: Chunker;
  /** Configured vector store instance. */
  vectorStore: VectorStore;
}

/** Result of a configuration validation pass. */
export interface ConfigValidationResult {
  /** Whether the configuration is fully valid. */
  valid: boolean;
  /** Warning messages for suspicious or invalid settings. */
  warnings: string[];
}

/** Validate a configuration object and return any warnings. */
export function validateConfig(config: RagConfig): ConfigValidationResult {
  const warnings: string[] = [];

  const KNOWN_TOP_KEYS = new Set([
    "embedding", "indexing", "vectorStore", "retrieval", "reranking",
    "openCode", "chunkers", "chunking", "description",
    "imageDescription", "decision", "shellGuard", "documentationMode", "wikiMode", "mcp", "autoUpdate", "memory", "ui", "tui", "logging", "setup",
  ]);
  const topKeys = new Set(Object.keys(config as unknown as Record<string, unknown>));
  for (const key of topKeys) {
    if (!KNOWN_TOP_KEYS.has(key)) {
      warnings.push(`Unknown top-level config key "${key}" — possible typo`);
    }
  }

  const KNOWN_EMBEDDING_PROVIDERS = new Set(["ollama", "openai", "cohere", "nvidia", "azure", "mistral", "together", "groq", "deepseek", "fireworks"]);
  if (!KNOWN_EMBEDDING_PROVIDERS.has(config.embedding.provider)) {
    warnings.push(`embedding.provider "${config.embedding.provider}" — unknown provider`);
  }
  if (config.embedding.timeoutMs != null && config.embedding.timeoutMs <= 0) {
    warnings.push("embedding.timeoutMs must be > 0");
  }
  try { new URL(config.embedding.baseUrl); } catch {
    warnings.push(`embedding.baseUrl "${config.embedding.baseUrl}" is not a valid URL`);
  }

  const vectorProvider = config.vectorStore.provider ?? "lancedb";
  if (!["lancedb", "memory", "clickhouse"].includes(vectorProvider)) {
    warnings.push(`vectorStore.provider "${vectorProvider}" — expected "lancedb", "memory" or "clickhouse"`);
  }
  if (vectorProvider === "clickhouse") {
    const ch = config.vectorStore.clickhouse;
    if (!ch) {
      warnings.push("vectorStore.clickhouse settings are required when provider is \"clickhouse\"");
    } else {
      try { new URL(ch.url); } catch {
        warnings.push(`vectorStore.clickhouse.url "${ch.url}" is not a valid URL`);
      }
      if (!ch.database) warnings.push("vectorStore.clickhouse.database must not be empty");
      if (!ch.username) warnings.push("vectorStore.clickhouse.username must not be empty");
      if (ch.password && !ch.passwordEnv) {
        warnings.push("vectorStore.clickhouse.password is stored in plaintext — prefer passwordEnv");
      }
      if (ch.namespace && !/^[A-Za-z0-9_]{1,40}$/.test(ch.namespace)) {
        warnings.push("vectorStore.clickhouse.namespace may only contain letters, digits and underscores (max 40)");
      }
      if (ch.ann === "hnsw") {
        // The index is dimension-bound; the store refuses to switch dimensions
        // until its tables are dropped and rebuilt.
        if (ch.annFetchMultiplier != null && (ch.annFetchMultiplier < 1 || ch.annFetchMultiplier > 1000)) {
          warnings.push("vectorStore.clickhouse.annFetchMultiplier must be between 1 and 1000");
        }
      }
      if (ch.requestTimeoutMs != null && ch.requestTimeoutMs <= 0) {
        warnings.push("vectorStore.clickhouse.requestTimeoutMs must be > 0");
      }
      if (ch.lease?.ttlSeconds != null && ch.lease.ttlSeconds < 10) {
        warnings.push("vectorStore.clickhouse.lease.ttlSeconds must be >= 10");
      }
    }
  }

  if (config.indexing.chunkOverlap < 0) {
    warnings.push("indexing.chunkOverlap must be >= 0");
  }
  if (config.indexing.concurrency <= 0) {
    warnings.push("indexing.concurrency must be > 0");
  }
  if (config.indexing.embedBatchSize <= 0) {
    warnings.push("indexing.embedBatchSize must be > 0");
  }
  if (config.indexing.embedConcurrency != null && config.indexing.embedConcurrency <= 0) {
    warnings.push("indexing.embedConcurrency must be > 0");
  }
  if (config.indexing.descriptionConcurrency != null && config.indexing.descriptionConcurrency <= 0) {
    warnings.push("indexing.descriptionConcurrency must be > 0");
  }
  if (config.indexing.minFileSizeBytes != null && config.indexing.minFileSizeBytes < 0) {
    warnings.push("indexing.minFileSizeBytes must be >= 0");
  }

  if (config.retrieval.topK <= 0) {
    warnings.push("retrieval.topK must be > 0");
  }
  if (config.retrieval.minScore < 0 || config.retrieval.minScore > 1) {
    warnings.push("retrieval.minScore must be between 0 and 1");
  }
  if (config.retrieval.hybridSearch?.enabled) {
    const kw = config.retrieval.hybridSearch.keywordWeight;
    if (kw < 0 || kw > 1) {
      warnings.push("retrieval.hybridSearch.keywordWeight must be between 0 and 1");
    }
    const hs = config.retrieval.hybridSearch;
    if (hs.symbolKeywordWeight != null && (hs.symbolKeywordWeight < 0 || hs.symbolKeywordWeight > 1)) {
      warnings.push("retrieval.hybridSearch.symbolKeywordWeight must be between 0 and 1");
    }
    if (hs.docKeywordDemotion != null && (hs.docKeywordDemotion < 0 || hs.docKeywordDemotion > 1)) {
      warnings.push("retrieval.hybridSearch.docKeywordDemotion must be between 0 and 1");
    }
    if (hs.testKeywordDemotion != null && (hs.testKeywordDemotion < 0 || hs.testKeywordDemotion > 1)) {
      warnings.push("retrieval.hybridSearch.testKeywordDemotion must be between 0 and 1");
    }
  }

  if (config.indexing.maxChunkSize != null && config.indexing.maxChunkSize < 0) {
    warnings.push("indexing.maxChunkSize must be >= 0");
  }
  if (config.indexing.maxChunkSize && config.indexing.maxChunkSize <= config.indexing.chunkOverlap) {
    warnings.push("indexing.maxChunkSize must be greater than chunkOverlap (otherwise windows make no progress)");
  }

  if (config.memory?.recallMinScore != null) {
    const r = config.memory.recallMinScore;
    if (r < 0 || r > 1) warnings.push("memory.recallMinScore must be between 0 and 1");
  }
  if (config.memory?.autoInjectMinScore != null) {
    const r = config.memory.autoInjectMinScore;
    if (r < 0 || r > 1) warnings.push("memory.autoInjectMinScore must be between 0 and 1");
  }
  if (config.memory?.autoInjectLatencyBudgetMs != null) {
    const r = config.memory.autoInjectLatencyBudgetMs;
    if (r < 0) warnings.push("memory.autoInjectLatencyBudgetMs must be >= 0");
  }
  if (config.memory?.autoInjectTopK != null && config.memory.autoInjectTopK < 1) {
    warnings.push("memory.autoInjectTopK must be >= 1");
  }
  if (config.memory?.minConfidence != null) {
    const r = config.memory.minConfidence;
    if (r < 0 || r > 1) warnings.push("memory.minConfidence must be between 0 and 1");
  }
  if (config.memory?.autoCaptureDedupThreshold != null) {
    const t = config.memory.autoCaptureDedupThreshold;
    // > 1 would make dedup reject every candidate; < 0 disables it silently
    if (t < 0 || t > 1) warnings.push("memory.autoCaptureDedupThreshold must be between 0 and 1");
  }
  if (config.memory?.toolErrorMinScore != null) {
    const r = config.memory.toolErrorMinScore;
    if (r < 0 || r > 1) warnings.push("memory.toolErrorMinScore must be between 0 and 1");
  }
  if (config.memory?.toolErrorTopK != null && config.memory.toolErrorTopK < 1) {
    warnings.push("memory.toolErrorTopK must be >= 1");
  }
  if (config.memory?.toolErrorCooldownMs != null && config.memory.toolErrorCooldownMs < 0) {
    warnings.push("memory.toolErrorCooldownMs must be >= 0");
  }
  if (config.memory?.toolErrorMaxPerSession != null && config.memory.toolErrorMaxPerSession < 0) {
    warnings.push("memory.toolErrorMaxPerSession must be >= 0");
  }
  if (config.memory?.toolErrorLatencyBudgetMs != null && config.memory.toolErrorLatencyBudgetMs < 0) {
    warnings.push("memory.toolErrorLatencyBudgetMs must be >= 0");
  }
  if (config.memory?.toolErrorCreateMinScore != null) {
    const r = config.memory.toolErrorCreateMinScore;
    if (r < 0 || r > 1) warnings.push("memory.toolErrorCreateMinScore must be between 0 and 1");
  }
  if (config.memory?.toolErrorCreateMaxPerSession != null && config.memory.toolErrorCreateMaxPerSession < 0) {
    warnings.push("memory.toolErrorCreateMaxPerSession must be >= 0");
  }
  if (config.memory?.toolErrorCreateCooldownMs != null && config.memory.toolErrorCreateCooldownMs < 0) {
    warnings.push("memory.toolErrorCreateCooldownMs must be >= 0");
  }
  if (config.memory?.toolErrorCreateLatencyBudgetMs != null && config.memory.toolErrorCreateLatencyBudgetMs < 0) {
    warnings.push("memory.toolErrorCreateLatencyBudgetMs must be >= 0");
  }
  if (config.memory?.toolErrorProactiveMaxItems != null && config.memory.toolErrorProactiveMaxItems < 0) {
    warnings.push("memory.toolErrorProactiveMaxItems must be >= 0");
  }
  if (config.retrieval?.minScoreMode != null && !["fused", "normalized"].includes(config.retrieval.minScoreMode)) {
    warnings.push(`retrieval.minScoreMode "${config.retrieval.minScoreMode}" — expected "fused" or "normalized"`);
  }
  if (config.memory?.decay && config.memory.decay.halfLifeDays <= 0) {
    warnings.push("memory.decay.halfLifeDays must be > 0");
  }
  if (config.openCode.maxReadOutputChars != null && config.openCode.maxReadOutputChars <= 0) {
    warnings.push("openCode.maxReadOutputChars must be > 0");
  }

  if (config.openCode.maxContextChunks <= 0) {
    warnings.push("openCode.maxContextChunks must be > 0");
  }

  if (config.openCode.autoIndex?.watcher && !["chokidar", "git"].includes(config.openCode.autoIndex.watcher)) {
    warnings.push(`openCode.autoIndex.watcher "${config.openCode.autoIndex.watcher}" — expected "chokidar" or "git"`);
  }
  const shellCfg = config.openCode.shell;
  if (shellCfg) {
    if (shellCfg.longRunningThresholdMs != null && shellCfg.longRunningThresholdMs < 0) {
      warnings.push("openCode.shell.longRunningThresholdMs must be >= 0");
    }
    if (shellCfg.foregroundTimeoutMs != null && shellCfg.foregroundTimeoutMs <= 0) {
      warnings.push("openCode.shell.foregroundTimeoutMs must be > 0");
    }
  }

  if (config.retrieval.contextOptimization) {
    const co = config.retrieval.contextOptimization;
    if (co.maxPerFile < 0) warnings.push("retrieval.contextOptimization.maxPerFile must be >= 0");
    if (co.adjacentGapThreshold < 0) warnings.push("retrieval.contextOptimization.adjacentGapThreshold must be >= 0");
    if (co.similarityThreshold < 0 || co.similarityThreshold > 1) {
      warnings.push("retrieval.contextOptimization.similarityThreshold must be between 0 and 1");
    }
  }

  if (!["debug", "info", "error", "none"].includes(config.logging.level)) {
    warnings.push(`logging.level "${config.logging.level}" — expected "debug", "info", "error", or "none"`);
  }

  if (config.ui) {
    if (config.ui.port < 1 || config.ui.port > 65535) {
      warnings.push("ui.port must be between 1 and 65535");
    }
  }

  if (config.description) {
    const KNOWN_DESCRIPTION_PROVIDERS = new Set(["ollama", "openai", "anthropic", "google"]);
    if (!KNOWN_DESCRIPTION_PROVIDERS.has(config.description.provider)) {
      warnings.push(`description.provider "${config.description.provider}" — unknown provider`);
    }
    if (config.description.timeoutMs != null && config.description.timeoutMs <= 0) {
      warnings.push("description.timeoutMs must be > 0");
    }
    if (config.description.batchEnabled === true) {
      warnings.push(
        "description.batchEnabled is EXPERIMENTAL — batching several chunks into one LLM request (Ollama only) " +
        "is unreliable on small models; disable it if descriptions look wrong",
      );
    }
  }

  if (config.imageDescription) {
    if (config.imageDescription.enabled) {
      if (config.imageDescription.timeoutMs <= 0) {
        warnings.push("imageDescription.timeoutMs must be > 0");
      }
    }
    const onDemand = config.imageDescription.onDemand;
    if (onDemand?.timeoutMs !== undefined && onDemand.timeoutMs <= 0) {
      warnings.push("imageDescription.onDemand.timeoutMs must be > 0");
    }
  }

  if (config.decision) {
    if (config.decision.provider !== "ollama") {
      warnings.push(`decision.provider "${config.decision.provider}" is not supported yet — only "ollama" (tev1 via /v1/systemone)`);
    }
    if (config.decision.timeoutMs != null && config.decision.timeoutMs <= 0) {
      warnings.push("decision.timeoutMs must be > 0");
    }
    if (config.decision.maxStateChars != null && config.decision.maxStateChars <= 0) {
      warnings.push("decision.maxStateChars must be > 0");
    }
    try { new URL(config.decision.baseUrl); } catch {
      warnings.push(`decision.baseUrl "${config.decision.baseUrl}" is not a valid URL`);
    }
  }

  if (config.shellGuard) {
    const sg = config.shellGuard;
    if (typeof sg.threshold !== "number" || !Number.isFinite(sg.threshold) || sg.threshold < 0 || sg.threshold > 1) {
      warnings.push("shellGuard.threshold must be a number between 0 and 1");
    }
    if (typeof sg.timeoutMs !== "number" || !Number.isFinite(sg.timeoutMs) || sg.timeoutMs <= 0) {
      warnings.push("shellGuard.timeoutMs must be > 0");
    }
    if (sg.onError != null && sg.onError !== "allow" && sg.onError !== "ask") {
      warnings.push(`shellGuard.onError "${sg.onError}" — expected "allow" or "ask"`);
    }
    if (typeof sg.cacheTtlMs !== "number" || !Number.isFinite(sg.cacheTtlMs) || sg.cacheTtlMs < 0) {
      warnings.push("shellGuard.cacheTtlMs must be >= 0");
    }
    if (sg.maxCacheEntries != null && (typeof sg.maxCacheEntries !== "number" || !Number.isFinite(sg.maxCacheEntries) || sg.maxCacheEntries < 0)) {
      warnings.push("shellGuard.maxCacheEntries must be >= 0");
    }
    for (const key of ["provider", "baseUrl", "model"] as const) {
      if (sg[key] != null && typeof sg[key] !== "string") {
        warnings.push(`shellGuard.${key} must be a string when set`);
      }
    }
    if (sg.baseUrl != null) {
      try { new URL(sg.baseUrl); } catch {
        warnings.push(`shellGuard.baseUrl "${sg.baseUrl}" is not a valid URL`);
      }
    }
  }

  if (config.setup && typeof config.setup.autoScaffold !== "boolean") {
    warnings.push("setup.autoScaffold must be a boolean");
  }

  if (config.reranking?.enabled) {
    const rr = config.reranking;
    if (!rr.baseUrl) warnings.push("reranking.baseUrl must be set when reranking.enabled is true");
    if (!rr.model) warnings.push("reranking.model must be set when reranking.enabled is true");
    if (rr.candidates !== undefined && (rr.candidates < 1 || rr.candidates > 100)) {
      warnings.push("reranking.candidates should be between 1 and 100 (latency scales linearly with document count)");
    }
    if (rr.minScore !== undefined && (rr.minScore < 0 || rr.minScore > 1)) {
      warnings.push("reranking.minScore must be between 0 and 1");
    }
    if (rr.timeoutMs !== undefined && rr.timeoutMs <= 0) {
      warnings.push("reranking.timeoutMs must be > 0");
    }
    if (rr.maxDocChars !== undefined && rr.maxDocChars <= 0) {
      warnings.push("reranking.maxDocChars must be > 0");
    }
  }

  return { valid: warnings.length === 0, warnings };
}

/**
 * Config file locations to search, in order of precedence.
 *
 * `.opencode/opencode-rag.json` is the canonical workspace location — every
 * writer (TUI, `setup`, `clickhouse setup`, the Web UI) creates and updates it
 * there. The root-level `opencode-rag.json` is the legacy location, still read
 * for compatibility (and migrated into `.opencode/` by `opencode-rag setup`);
 * `.opencode/rag.json` is a legacy alias inside `.opencode/`.
 */
export const CONFIG_FILE_CANDIDATES = [
  ".opencode/opencode-rag.json",
  "opencode-rag.json",
  ".opencode/rag.json",
];

/**
 * Find the first existing config file in a directory.
 * @returns The absolute path to the config file, or undefined if none found.
 */
export function findConfigFile(directory: string): string | undefined {
  for (const loc of CONFIG_FILE_CANDIDATES) {
    const configPath = path.join(directory, loc);
    if (existsSync(configPath)) {
      return configPath;
    }
  }
  return undefined;
}

/**
 * Resolve the machine-wide config file path.
 *
 * `$XDG_CONFIG_HOME/opencode/opencode-rag.json`, falling back to
 * `~/.config/opencode/opencode-rag.json`. The global file is a BASE layer:
 * every workspace config is merged on top of it, so machine-wide defaults
 * (e.g. `shellGuard.enabled`) do not need to be repeated per project.
 */
export function globalConfigPath(
  envVars: NodeJS.ProcessEnv = env,
  homeDir: string = homedir(),
): string {
  const xdg = envVars.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length > 0 ? xdg : path.join(homeDir, ".config");
  return path.join(base, "opencode", "opencode-rag.json");
}

/** Return the global config path when that file exists. */
export function findGlobalConfigFile(
  envVars: NodeJS.ProcessEnv = env,
  homeDir: string = homedir(),
): string | undefined {
  const candidate = globalConfigPath(envVars, homeDir);
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * The canonical workspace config path `<directory>/.opencode/opencode-rag.json`.
 * Exists or not — this is where writers CREATE the workspace config, keeping
 * the project root clean. Use {@link findConfigFile} to read the effective one.
 */
export function projectConfigPath(directory: string): string {
  return path.join(directory, ".opencode", "opencode-rag.json");
}

/**
 * Move a legacy root-level `opencode-rag.json` into `.opencode/`.
 *
 * Only runs when the legacy file exists and the canonical file does not — an
 * existing `.opencode/opencode-rag.json` always wins, so the legacy file is
 * left alone rather than silently merged.
 *
 * @returns The new path when the file was moved, otherwise undefined.
 */
export function migrateLegacyProjectConfig(directory: string): string | undefined {
  const legacy = path.join(directory, "opencode-rag.json");
  const target = projectConfigPath(directory);
  if (!existsSync(legacy) || existsSync(target)) return undefined;
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    renameSync(legacy, target);
    return target;
  } catch {
    return undefined;
  }
}

/** Create an empty (`{}`) config file — and its parent directory — when absent. */
export function ensureConfigFile(filePath: string): void {
  if (existsSync(filePath)) return;
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "{}", "utf-8");
}

/**
 * Write a value into the machine-global config file, creating it on demand.
 *
 * Provider options (embedding/description/... provider, model, baseUrl,
 * apiKey) describe which models THIS MACHINE serves, not what the repository
 * is, so they belong here rather than in a per-project file — and the global
 * file is never committed, making it safe for API keys. The plugin re-reads
 * this layer by mtime, so changes apply without a restart.
 */
export function updateGlobalConfigValue(path_: readonly string[], value: unknown): boolean {
  try {
    ensureConfigFile(globalConfigPath());
  } catch {
    return false;
  }
  return updateConfigValue(globalConfigPath(), [...path_], value);
}

/** Config sections whose model/endpoint settings are machine-global provider options. */
const PROVIDER_OPTION_SECTIONS = new Set([
  "embedding",
  "description",
  "imageDescription",
  "decision",
  "reranking",
]);

/** Leaf keys that select or authenticate a provider/model. */
const PROVIDER_OPTION_LEAVES = new Set([
  "provider",
  "model",
  "baseUrl",
  "apiKey",
  "vectorDimension",
]);

/**
 * Whether a dotted config path is a machine-global provider option
 * (section ∈ {@link PROVIDER_OPTION_SECTIONS}, leaf ∈ {@link PROVIDER_OPTION_LEAVES};
 * `imageDescription.onDemand.*` counts via the `onDemand` group).
 *
 * Writers route these to {@link updateGlobalConfigValue} so provider/model/
 * key/baseUrl never land in a per-project config file; every other path stays
 * project-scoped.
 */
export function isProviderScopedPath(path_: readonly string[]): boolean {
  if (path_.length < 2) return false;
  if (!PROVIDER_OPTION_SECTIONS.has(path_[0]!)) return false;
  const segments = path_[0] === "imageDescription" && path_[1] === "onDemand" ? path_.slice(2) : path_.slice(1);
  const leaf = segments[segments.length - 1];
  return leaf !== undefined && segments.every((s) => PROVIDER_OPTION_LEAVES.has(s) || s === "onDemand")
    && PROVIDER_OPTION_LEAVES.has(leaf);
}

/** Config layers that apply to a workspace (lowest precedence first). */
export function resolveConfigPaths(directory: string): { global?: string; workspace?: string } {
  return { global: findGlobalConfigFile(), workspace: findConfigFile(directory) };
}

/** Read and parse one config file (BOM-tolerant); throws a descriptive error. */
function parseConfigFile(filePath: string): Partial<RagConfig> {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw) as Partial<RagConfig>;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`Config file not found: ${filePath}`);
    }
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file ${filePath}: ${err.message}`);
    }
    throw err;
  }
}

/** True for plain JSON objects (arrays and `null` are replacements, not merges). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively merge `override` onto `base`; arrays and primitives replace. */
function mergeConfigObjects(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    merged[key] = isPlainObject(value) && isPlainObject(current)
      ? mergeConfigObjects(current, value)
      : value;
  }
  return merged;
}

/**
 * Load and parse a JSON config file, deep-merge with defaults, optionally validate.
 *
 * This is the single-file loader: the given file is authoritative. Workspace
 * loading with the global base layer goes through {@link loadWorkspaceConfig}.
 */
export function loadConfig(filePath: string, validate: boolean = true): RagConfig {
  return buildConfig(parseConfigFile(filePath), validate);
}

/**
 * Load several config files, later files overriding earlier ones.
 *
 * Raw JSON layers are deep-merged BEFORE the per-section defaults merge, so a
 * layer that omits a section cannot reset a value supplied by a lower layer.
 */
export function loadConfigLayers(filePaths: readonly string[], validate: boolean = true): RagConfig {
  let merged: Record<string, unknown> = {};
  for (const filePath of filePaths) {
    merged = mergeConfigObjects(merged, parseConfigFile(filePath) as Record<string, unknown>);
  }
  return buildConfig(merged as Partial<RagConfig>, validate);
}

/**
 * Load the effective config for a workspace: defaults < global < workspace.
 *
 * A workspace with no local config still gets the global layer; with neither
 * file present the result is `DEFAULT_CONFIG`. Explicit `--config` callers keep
 * using {@link loadConfig} so their chosen file stays authoritative.
 */
export function loadWorkspaceConfig(directory: string, validate: boolean = true): RagConfig {
  const { global, workspace } = resolveConfigPaths(directory);
  const layers = [global, workspace].filter((p): p is string => p !== undefined);
  return loadConfigLayers(layers, validate);
}

/**
 * Raw JSON layers (global < workspace) deep-merged WITHOUT defaults.
 *
 * For display surfaces (TUI sidebar/settings dialog) that must show what the
 * USER configured rather than what `DEFAULT_CONFIG` contains. Malformed
 * layers are skipped here — `loadWorkspaceConfig` reports the error elsewhere.
 */
export function loadWorkspaceRawConfig(directory: string): Record<string, unknown> {
  const { global, workspace } = resolveConfigPaths(directory);
  let merged: Record<string, unknown> = {};
  for (const filePath of [global, workspace]) {
    if (!filePath) continue;
    try {
      merged = mergeConfigObjects(merged, parseConfigFile(filePath) as Record<string, unknown>);
    } catch {
      // skip a malformed layer; keep whatever the healthy layers contributed
    }
  }
  return merged;
}

/**
 * Top-level sections that a workspace actually configures.
 *
 * Read from the raw JSON layers (global + workspace), NOT from the merged
 * config, so a section that exists only in `DEFAULT_CONFIG` is not reported.
 * Health checks use this to probe only the models a user asked for: the
 * default-on `description` / `imageDescription` models are not "configured"
 * just because defaults enable them.
 */
export function configuredSections(directory: string): Set<string> {
  const { global, workspace } = resolveConfigPaths(directory);
  const sections = new Set<string>();
  for (const filePath of [global, workspace]) {
    if (!filePath) continue;
    try {
      const parsed = parseConfigFile(filePath) as Record<string, unknown>;
      for (const key of Object.keys(parsed)) sections.add(key);
    } catch {
      // Malformed layer: loadConfig reports it; health checks stay best-effort.
    }
  }
  return sections;
}

/** Merge raw config layers onto DEFAULT_CONFIG and validate. */
function buildConfig(parsed: Partial<RagConfig>, validate: boolean): RagConfig {
  const safeObj = <T>(value: unknown): Partial<T> | undefined =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Partial<T>) : undefined;

  const cfg: RagConfig = {
    embedding: {
      ...DEFAULT_CONFIG.embedding,
      ...parsed.embedding,
    },
    indexing: {
      ...DEFAULT_CONFIG.indexing,
      ...parsed.indexing,
    },
    vectorStore: (() => {
      const base = DEFAULT_CONFIG.vectorStore;
      const user = (safeObj<Partial<typeof base>>(parsed.vectorStore) ?? {});
      const chBase = base.clickhouse!;
      const chUser = (safeObj<Partial<typeof chBase>>(user.clickhouse) ?? {});
      return {
        ...base,
        ...user,
        clickhouse: {
          ...chBase,
          ...chUser,
          state: {
            ...chBase.state,
            ...(safeObj<NonNullable<typeof chBase.state>>(chUser.state) ?? {}),
          },
          lease: {
            ...chBase.lease,
            ...(safeObj<NonNullable<typeof chBase.lease>>(chUser.lease) ?? {}),
          },
        },
      };
    })(),
    retrieval: {
      ...DEFAULT_CONFIG.retrieval,
      ...parsed.retrieval,
      hybridSearch: {
        ...DEFAULT_CONFIG.retrieval.hybridSearch,
        ...(safeObj<typeof DEFAULT_CONFIG.retrieval.hybridSearch>(
          (parsed.retrieval as Record<string, unknown> | undefined)?.hybridSearch
        ) ?? {}),
      } as { enabled: boolean; keywordWeight: number },
      // contextOptimization MUST be nested-merged too — a shallow spread
      // would replace the whole default object with a partial user object,
      // silently leaving maxPerFile/mergeAdjacent/similarityThreshold etc.
      // undefined (which disables the features via NaN comparisons).
      contextOptimization: {
        ...DEFAULT_CONFIG.retrieval.contextOptimization,
        ...(safeObj<typeof DEFAULT_CONFIG.retrieval.contextOptimization>(
          (parsed.retrieval as Record<string, unknown> | undefined)?.contextOptimization
        ) ?? {}),
      } as ContextOptimizationConfig,
    },
    // Flat section — no nested objects, a shallow spread merge is safe.
    reranking: {
      ...DEFAULT_CONFIG.reranking,
      ...(safeObj<RerankingConfig>((parsed as { reranking?: unknown }).reranking) ?? {}),
    } as RerankingConfig,
    openCode: (() => {
      const base = DEFAULT_CONFIG.openCode;
      const user: Partial<typeof base> = (parsed as { openCode?: Partial<typeof base> }).openCode ?? {};
      const merged: typeof base = {
        ...base,
        ...user,
        autoIndex: {
          ...base.autoIndex,
          ...(safeObj<AutoIndexConfig>(user.autoIndex) ?? {}),
        } as AutoIndexConfig,
        shell: {
          ...base.shell,
          ...(safeObj<OpenCodeShellConfig>(user.shell) ?? {}),
        } as OpenCodeShellConfig,
      };
      return merged;
    })(),
    chunkers: parsed.chunkers ?? DEFAULT_CONFIG.chunkers,
    chunking: {
      nodeTypes: {
        ...((DEFAULT_CONFIG.chunking as Record<string, unknown>)?.nodeTypes as Record<string, string[]> | undefined ?? {}),
        ...((parsed.chunking as Record<string, unknown>)?.nodeTypes as Record<string, string[]> | undefined ?? {}),
      },
      parsers: normalizeParserOverrides(
        safeObj<{ parsers?: Record<string, string> }>(parsed.chunking as unknown)?.parsers
      ),
    },
    description: {
      ...DEFAULT_CONFIG.description,
      ...(safeObj<DescriptionConfig>((parsed as { description?: unknown }).description) ?? {}),
    } as DescriptionConfig,
    imageDescription: {
      ...DEFAULT_CONFIG.imageDescription,
      ...(safeObj<ImageDescriptionConfig>((parsed as { imageDescription?: unknown }).imageDescription) ?? {}),
    } as ImageDescriptionConfig,
    decision: {
      ...DEFAULT_CONFIG.decision,
      ...(safeObj<DecisionConfig>((parsed as { decision?: unknown }).decision) ?? {}),
    } as DecisionConfig,
    shellGuard: {
      ...DEFAULT_CONFIG.shellGuard,
      ...(safeObj<ShellGuardConfig>((parsed as { shellGuard?: unknown }).shellGuard) ?? {}),
    } as ShellGuardConfig,
    documentationMode: {
      ...DEFAULT_CONFIG.documentationMode,
      ...(safeObj<DocumentationModeConfig>((parsed as { documentationMode?: unknown }).documentationMode) ?? {}),
    } as DocumentationModeConfig,
    wikiMode: {
      ...DEFAULT_CONFIG.wikiMode,
      ...(safeObj<WikiModeConfig>((parsed as { wikiMode?: unknown }).wikiMode) ?? {}),
    } as WikiModeConfig,
    mcp: {
      ...DEFAULT_CONFIG.mcp,
      ...(safeObj<McpConfig>((parsed as { mcp?: unknown }).mcp) ?? {}),
    } as McpConfig,
    setup: {
      ...DEFAULT_CONFIG.setup,
      ...(safeObj<SetupConfig>((parsed as { setup?: unknown }).setup) ?? {}),
    } as SetupConfig,
    autoUpdate: {
      ...DEFAULT_CONFIG.autoUpdate,
      ...(safeObj<AutoUpdateConfig>((parsed as { autoUpdate?: unknown }).autoUpdate) ?? {}),
    } as AutoUpdateConfig,
    memory: {
      ...DEFAULT_CONFIG.memory,
      ...(safeObj<MemoryConfig>((parsed as { memory?: unknown }).memory) ?? {}),
      // decay is a nested object — a user config with only
      // `memory.decay.enabled` must not lose the halfLifeDays default.
      decay: {
        ...(DEFAULT_CONFIG.memory as { decay: MemoryConfig["decay"] }).decay,
        ...(safeObj<MemoryConfig["decay"]>(
          (safeObj<MemoryConfig>((parsed as { memory?: unknown }).memory) ?? {})?.decay
        ) ?? {}),
      },
    } as MemoryConfig,
    ui: {
      ...DEFAULT_CONFIG.ui,
      ...(safeObj<UiConfig>((parsed as { ui?: unknown }).ui) ?? {}),
    } as UiConfig,
    tui: {
      ...DEFAULT_CONFIG.tui,
      ...(safeObj<TuiConfig>((parsed as { tui?: unknown }).tui) ?? {}),
    } as TuiConfig,
    logging: {
      ...DEFAULT_CONFIG.logging,
      ...(safeObj<LoggingConfig>(parsed.logging) ?? {}),
    } as LoggingConfig,
  };

  if (validate) {
    const result = validateConfig(cfg);
    for (const w of result.warnings) {
      console.warn(`[opencode-rag] Config warning: ${w}`);
    }
  }

  return cfg;
}

/**
 * Persist a probed embedding vector dimension into the config JSON file.
 * Sets `embedding.vectorDimension` so subsequent startups skip the probe.
 * This is a best-effort operation — failures are silently ignored.
 *
 * @param configPath - Absolute path to the config JSON file.
 * @param dimension - The vector dimension to persist.
 */
export function persistProbedDimension(configPath: string, dimension: number): void {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    return;
  }
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const embedding = (obj.embedding ??= {}) as Record<string, unknown>;
    if (embedding.vectorDimension === dimension) return; // already set
    embedding.vectorDimension = dimension;
    writeFileSync(configPath, JSON.stringify(obj, null, 2), "utf-8");
  } catch {
    // best-effort
  }
}

/**
 * Set a value at a dotted path inside the config JSON file, creating
 * intermediate objects as needed, and write it back with 2-space
 * indentation. Reads/writes the raw file, so comments or formatting of
 * unrelated keys are preserved as parsed (the file is re-serialized).
 *
 * @param configPath - Absolute path to the config JSON file.
 * @param path       - Dotted path segments, e.g. `["indexing", "includeDirs"]`.
 * @param value      - Value to write at the target path.
 * @returns `true` when the file was updated, `false` on any error.
 */
export function updateConfigValue(configPath: string, path: string[], value: unknown): boolean {
  try {
    let raw = readFileSync(configPath, "utf-8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const data = JSON.parse(raw) as Record<string, unknown>;
    let target = data;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i]!;
      if (!target[key] || typeof target[key] !== "object") {
        target[key] = {};
      }
      target = target[key] as Record<string, unknown>;
    }
    target[path[path.length - 1]!] = value;
    writeFileSync(configPath, JSON.stringify(data, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}
