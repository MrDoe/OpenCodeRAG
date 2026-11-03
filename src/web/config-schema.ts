/**
 * @fileoverview Declarative schema for the Web UI Configuration page.
 *
 * The browser never derives setting names or types on its own: this module is
 * the single server-owned description of what is editable, where it may be
 * written (project vs. machine-global provider options), how it is validated,
 * and what a change implies (live, reindex, restart).
 *
 * Keeping the schema on the server also lets the redaction layer work from
 * known secret paths instead of guessing from key names — the old regex
 * redacted numeric settings such as `memory.autoInjectMinTokenOverlap`.
 */

import { isProviderScopedPath } from "../core/config.js";

/** Control rendered for a setting. */
export type SettingType =
  | "boolean"
  | "number"
  | "string"
  | "enum"
  | "string[]"
  | "stringMap"
  | "stringArrayMap"
  | "json";

/** What applying a change implies for the running system. */
export type SettingImpact = "live" | "reindex" | "restart";

/** Config layer a setting may be written to. */
export type SettingScope = "project" | "global";

/** One editable configuration value. */
export interface SettingField {
  /** Dotted path segments into the config object (`["retrieval", "topK"]`). */
  path: string[];
  /** Short human label. */
  label: string;
  /** One-line hint shown under the control. */
  description?: string;
  /** Control type. */
  type: SettingType;
  /** Allowed values for `type: "enum"`. */
  enumValues?: string[];
  /** Inclusive minimum for `type: "number"`. */
  minimum?: number;
  /** Inclusive maximum for `type: "number"`. */
  maximum?: number;
  /** Step for `type: "number"` inputs. */
  step?: number;
  /** Placeholder for text inputs. */
  placeholder?: string;
  /** Render a textarea instead of a single-line input. */
  multiline?: boolean;
  /** Secret: never sent to the browser, only `secretSet` booleans are. */
  secret?: boolean;
  /** Shown only when the page's Advanced toggle is on. */
  advanced?: boolean;
  /** Writer layer. `global` settings are rejected by a project-layer write. */
  scope: SettingScope;
  /** Post-save guidance. */
  impact: SettingImpact;
}

/** A group of related settings. */
export interface SettingSection {
  id: string;
  label: string;
  description?: string;
  fields: SettingField[];
}

/** Secret leaf names, used for fields the schema has not enumerated yet. */
const SECRET_LEAVES = new Set(["apiKey", "password", "passwd", "secret", "token", "authorization"]);

/** Provider sections whose proxy/onDemand blocks are machine-global too. */
const PROVIDER_SECTIONS = new Set(["embedding", "description", "imageDescription", "decision", "reranking"]);

/** Resolve the writer scope for a path (explicit override wins). */
function scopeFor(path: string[], explicit?: SettingScope): SettingScope {
  if (explicit) return explicit;
  if (isProviderScopedPath(path)) return "global";
  const section = path[0];
  if (section && PROVIDER_SECTIONS.has(section) && (path.includes("proxy") || path.includes("onDemand"))) {
    return "global";
  }
  return "project";
}

/** True when a path's leaf is a credential name. */
function isSecretPath(path: string[]): boolean {
  const leaf = path[path.length - 1];
  return leaf !== undefined && SECRET_LEAVES.has(leaf);
}

interface FieldOptions extends Partial<Omit<SettingField, "path" | "label" | "type">> {}

/** Build a field, deriving scope and secret-ness from its path. */
function field(path: string[], label: string, type: SettingType, options: FieldOptions = {}): SettingField {
  const { scope, secret, impact, ...rest } = options;
  return {
    path,
    label,
    type,
    ...rest,
    scope: scopeFor(path, scope),
    secret: secret ?? isSecretPath(path),
    impact: impact ?? "live",
  };
}

const boolean = (path: string[], label: string, options?: FieldOptions) =>
  field(path, label, "boolean", options);
const number = (path: string[], label: string, options?: FieldOptions) =>
  field(path, label, "number", options);
const string = (path: string[], label: string, options?: FieldOptions) =>
  field(path, label, "string", options);
const enumField = (path: string[], label: string, values: string[], options?: FieldOptions) =>
  field(path, label, "enum", { enumValues: values, ...options });
const strings = (path: string[], label: string, options?: FieldOptions) =>
  field(path, label, "string[]", options);
const stringMap = (path: string[], label: string, options?: FieldOptions) =>
  field(path, label, "stringMap", options);
const stringArrayMap = (path: string[], label: string, options?: FieldOptions) =>
  field(path, label, "stringArrayMap", options);
const json = (path: string[], label: string, options?: FieldOptions) =>
  field(path, label, "json", options);

/** Proxy helper: one global block per provider section. */
function proxyFields(section: string): SettingField[] {
  return [
    string([section, "proxy", "url"], "Proxy URL", {
      advanced: true,
      placeholder: "http://proxy:8080",
    }),
    string([section, "proxy", "username"], "Proxy username", { advanced: true }),
    string([section, "proxy", "password"], "Proxy password", { advanced: true }),
    string([section, "proxy", "noProxy"], "Proxy bypass list", {
      advanced: true,
      description: "Comma-separated hosts that skip the proxy.",
    }),
  ];
}

/** The complete settings schema, in page order. */
export const SETTINGS_SECTIONS: SettingSection[] = [
  {
    id: "embedding",
    label: "Embedding",
    description: "Model used to vectorise code and queries.",
    fields: [
      enumField(["embedding", "provider"], "Provider", [
        "ollama",
        "openai",
        "cohere",
        "nvidia",
        "azure",
        "mistral",
        "together",
        "fireworks",
      ], { impact: "reindex" }),
      string(["embedding", "model"], "Model", { impact: "reindex" }),
      string(["embedding", "baseUrl"], "Base URL", { impact: "reindex" }),
      string(["embedding", "apiKey"], "API key", { impact: "reindex" }),
      number(["embedding", "vectorDimension"], "Vector dimension", {
        advanced: true,
        minimum: 1,
        impact: "reindex",
        description: "Probed automatically; set only when the probe cannot reach the provider.",
      }),
      number(["embedding", "timeoutMs"], "Request timeout (ms)", { minimum: 1 }),
      string(["embedding", "documentPrefix"], "Document prefix", {
        advanced: true,
        impact: "reindex",
      }),
      string(["embedding", "queryPrefix"], "Query prefix", { advanced: true }),
      string(["embedding", "keepAlive"], "Ollama keep-alive", {
        advanced: true,
        placeholder: "30m",
      }),
      ...proxyFields("embedding"),
    ],
  },
  {
    id: "description",
    label: "Descriptions",
    description: "LLM-generated summaries embedded alongside code chunks.",
    fields: [
      boolean(["description", "enabled"], "Generate descriptions", { impact: "reindex" }),
      enumField(["description", "provider"], "Provider", ["ollama", "openai", "anthropic", "google"], {
        impact: "reindex",
      }),
      string(["description", "model"], "Model", { impact: "reindex" }),
      string(["description", "baseUrl"], "Base URL", { impact: "reindex" }),
      string(["description", "apiKey"], "API key", { impact: "reindex" }),
      number(["description", "timeoutMs"], "Request timeout (ms)", { minimum: 1 }),
      string(["description", "keepAlive"], "Ollama keep-alive", { advanced: true }),
      string(["description", "systemPrompt"], "System prompt", {
        advanced: true,
        multiline: true,
        impact: "reindex",
      }),
      boolean(["description", "think"], "Allow reasoning tokens", { advanced: true }),
      number(["description", "numCtx"], "Context window", { advanced: true, minimum: 1 }),
      number(["description", "maxContentChars"], "Max content chars", {
        advanced: true,
        minimum: 1,
      }),
      boolean(["description", "batchEnabled"], "Batch requests", { advanced: true, impact: "reindex" }),
      number(["description", "batchMaxChunks"], "Batch size", { advanced: true, minimum: 1 }),
      number(["description", "batchTimeoutMs"], "Batch timeout (ms)", { advanced: true, minimum: 1 }),
      number(["description", "batchConcurrency"], "Batch concurrency", { advanced: true, minimum: 1 }),
      number(["description", "retryMax"], "Max retries", { advanced: true, minimum: 0 }),
      number(["description", "retryBaseDelayMs"], "Retry base delay (ms)", {
        advanced: true,
        minimum: 0,
      }),
      ...proxyFields("description"),
    ],
  },
  {
    id: "imageDescription",
    label: "Image Descriptions",
    description: "Vision model used to describe images during indexing.",
    fields: [
      boolean(["imageDescription", "enabled"], "Describe images", { impact: "reindex" }),
      enumField(["imageDescription", "provider"], "Provider", [
        "ollama",
        "openai",
        "anthropic",
        "google",
        "opencode",
        "opencode-go",
      ], { impact: "reindex" }),
      string(["imageDescription", "model"], "Model", { impact: "reindex" }),
      string(["imageDescription", "baseUrl"], "Base URL", { impact: "reindex" }),
      string(["imageDescription", "apiKey"], "API key", { impact: "reindex" }),
      number(["imageDescription", "timeoutMs"], "Request timeout (ms)", { minimum: 1 }),
      string(["imageDescription", "prompt"], "Prompt", { multiline: true, impact: "reindex" }),
      boolean(["imageDescription", "think"], "Allow reasoning tokens", { advanced: true }),
      number(["imageDescription", "numCtx"], "Context window", { advanced: true, minimum: 1 }),
      string(["imageDescription", "keepAlive"], "Ollama keep-alive", { advanced: true }),
      number(["imageDescription", "resizeMaxDimension"], "Max image dimension", {
        advanced: true,
        minimum: 1,
      }),
      ...proxyFields("imageDescription"),
      enumField(["imageDescription", "onDemand", "provider"], "On-demand provider", [
        "ollama",
        "openai",
        "anthropic",
        "google",
        "opencode",
        "opencode-go",
      ], { advanced: true }),
      string(["imageDescription", "onDemand", "model"], "On-demand model", { advanced: true }),
      string(["imageDescription", "onDemand", "baseUrl"], "On-demand base URL", { advanced: true }),
      string(["imageDescription", "onDemand", "apiKey"], "On-demand API key", { advanced: true }),
      number(["imageDescription", "onDemand", "timeoutMs"], "On-demand timeout (ms)", {
        advanced: true,
        minimum: 1,
      }),
      string(["imageDescription", "onDemand", "prompt"], "On-demand prompt", { advanced: true }),
      boolean(["imageDescription", "onDemand", "think"], "On-demand reasoning tokens", {
        advanced: true,
      }),
      number(["imageDescription", "onDemand", "numCtx"], "On-demand context window", {
        advanced: true,
        minimum: 1,
      }),
      string(["imageDescription", "onDemand", "keepAlive"], "On-demand keep-alive", {
        advanced: true,
      }),
      number(["imageDescription", "onDemand", "resizeMaxDimension"], "On-demand max dimension", {
        advanced: true,
        minimum: 1,
      }),
    ],
  },
  {
    id: "decision",
    label: "Decision Model",
    description: "Local tev1 model behind the make_decision tool.",
    fields: [
      boolean(["decision", "enabled"], "Enable make_decision"),
      enumField(["decision", "provider"], "Provider", ["ollama"]),
      string(["decision", "model"], "Model"),
      string(["decision", "baseUrl"], "Base URL"),
      number(["decision", "timeoutMs"], "Request timeout (ms)", { minimum: 1 }),
      string(["decision", "keepAlive"], "Ollama keep-alive", { advanced: true }),
      boolean(["decision", "routeBeforeAsking"], "Route choices before asking"),
      number(["decision", "maxStateChars"], "Max state chars", { advanced: true, minimum: 1 }),
      number(["decision", "retryMax"], "Max retries", { advanced: true, minimum: 0 }),
      number(["decision", "retryBaseDelayMs"], "Retry base delay (ms)", {
        advanced: true,
        minimum: 0,
      }),
      ...proxyFields("decision"),
    ],
  },
  {
    id: "reranking",
    label: "Reranking",
    description: "Optional cross-encoder rerank stage after hybrid fusion.",
    fields: [
      boolean(["reranking", "enabled"], "Enable reranking"),
      enumField(["reranking", "provider"], "Provider", ["llama-server"]),
      string(["reranking", "model"], "Model"),
      string(["reranking", "baseUrl"], "Base URL"),
      string(["reranking", "apiKey"], "API key"),
      number(["reranking", "candidates"], "Candidates", { minimum: 1 }),
      number(["reranking", "maxDocChars"], "Max document chars", { advanced: true, minimum: 1 }),
      number(["reranking", "minScore"], "Rerank min score", {
        advanced: true,
        minimum: 0,
        maximum: 1,
        step: 0.01,
      }),
      number(["reranking", "timeoutMs"], "Timeout (ms)", { minimum: 1 }),
      string(["reranking", "queryTemplate"], "Query template", { advanced: true }),
      enumField(["reranking", "docField"], "Document field", ["content", "content+description"], {
        advanced: true,
      }),
      ...proxyFields("reranking"),
    ],
  },
  {
    id: "shellGuard",
    label: "Shell Guard",
    description: "Decision-model vetting of shell commands before they run.",
    fields: [
      boolean(["shellGuard", "enabled"], "Enable Shell Guard"),
      number(["shellGuard", "threshold"], "Flag threshold", {
        minimum: 0,
        maximum: 1,
        step: 0.01,
      }),
      enumField(["shellGuard", "onError"], "On classifier error", ["allow", "ask"]),
      number(["shellGuard", "timeoutMs"], "Classification timeout (ms)", { minimum: 1 }),
      string(["shellGuard", "provider"], "Provider override", { advanced: true }),
      string(["shellGuard", "baseUrl"], "Base URL override", { advanced: true }),
      string(["shellGuard", "model"], "Model override", { advanced: true }),
      number(["shellGuard", "cacheTtlMs"], "Verdict cache TTL (ms)", {
        advanced: true,
        minimum: 0,
      }),
      number(["shellGuard", "maxCacheEntries"], "Max cached verdicts", {
        advanced: true,
        minimum: 1,
      }),
    ],
  },
  {
    id: "indexing",
    label: "Indexing",
    description: "What gets scanned and how indexing is tuned.",
    fields: [
      strings(["indexing", "includeExtensions"], "Included extensions", { impact: "reindex" }),
      strings(["indexing", "includeDirs"], "Included folders", {
        impact: "reindex",
        description: "Empty = whole workspace. Paths are anchored to the workspace root.",
      }),
      strings(["indexing", "excludeDirs"], "Excluded folders", { impact: "reindex" }),
      strings(["indexing", "excludeFiles"], "Excluded files", { impact: "reindex" }),
      number(["indexing", "chunkOverlap"], "Chunk overlap (lines)", {
        minimum: 0,
        impact: "reindex",
      }),
      number(["indexing", "maxChunkSize"], "Max chunk size (lines)", {
        minimum: 0,
        impact: "reindex",
        description: "0 = no limit (whole AST node).",
      }),
      number(["indexing", "minFileSizeBytes"], "Minimum file size (bytes)", {
        minimum: 0,
        impact: "reindex",
      }),
      number(["indexing", "concurrency"], "File concurrency", { minimum: 1 }),
      number(["indexing", "embedBatchSize"], "Embedding batch size", { minimum: 1 }),
      number(["indexing", "embedConcurrency"], "Embedding concurrency", { minimum: 1 }),
      number(["indexing", "ollamaMaxBatchSize"], "Ollama max batch size", {
        advanced: true,
        minimum: 1,
      }),
      number(["indexing", "descriptionConcurrency"], "Description concurrency", {
        advanced: true,
        minimum: 1,
      }),
      boolean(["indexing", "embedDescriptions"], "Embed descriptions", { impact: "reindex" }),
      number(["indexing", "maxSvgSizeBytes"], "Max SVG size (bytes)", {
        advanced: true,
        minimum: 0,
        impact: "reindex",
      }),
      number(["indexing", "optimizeIntervalWindows"], "Optimize every N windows", {
        advanced: true,
        minimum: 0,
      }),
    ],
  },
  {
    id: "chunking",
    label: "Chunking",
    description: "Per-language parser overrides.",
    fields: [
      stringMap(["chunking", "parsers"], "Extension → parser", {
        advanced: true,
        impact: "reindex",
      }),
      stringArrayMap(["chunking", "nodeTypes"], "Language → node types", {
        advanced: true,
        impact: "reindex",
      }),
      json(["chunkers"], "Custom chunker modules", { advanced: true, impact: "restart" }),
    ],
  },
  {
    id: "retrieval",
    label: "Retrieval",
    description: "Query-time ranking and context shaping.",
    fields: [
      number(["retrieval", "topK"], "Top K", { minimum: 1, maximum: 1000 }),
      number(["retrieval", "minScore"], "Minimum score", {
        minimum: 0,
        maximum: 1,
        step: 0.01,
      }),
      enumField(["retrieval", "minScoreMode"], "Min-score mode", ["fused", "normalized"]),
      boolean(["retrieval", "hybridSearch", "enabled"], "Hybrid search"),
      number(["retrieval", "hybridSearch", "keywordWeight"], "Keyword weight", {
        minimum: 0,
        maximum: 1,
        step: 0.01,
      }),
      number(["retrieval", "hybridSearch", "symbolKeywordWeight"], "Symbol keyword weight", {
        minimum: 0,
        maximum: 1,
        step: 0.01,
      }),
      number(["retrieval", "hybridSearch", "docKeywordDemotion"], "Document demotion", {
        advanced: true,
        minimum: 0,
        maximum: 1,
        step: 0.01,
      }),
      number(["retrieval", "hybridSearch", "testKeywordDemotion"], "Test demotion", {
        advanced: true,
        minimum: 0,
        maximum: 1,
        step: 0.01,
      }),
      boolean(["retrieval", "contextOptimization", "enabled"], "Context optimization"),
      number(["retrieval", "contextOptimization", "maxPerFile"], "Max chunks per file", {
        advanced: true,
        minimum: 0,
      }),
      boolean(["retrieval", "contextOptimization", "mergeAdjacent"], "Merge adjacent chunks", {
        advanced: true,
      }),
      number(["retrieval", "contextOptimization", "adjacentGapThreshold"], "Adjacent gap", {
        advanced: true,
        minimum: 0,
      }),
      number(["retrieval", "contextOptimization", "similarityThreshold"], "Similarity threshold", {
        advanced: true,
        minimum: 0,
        maximum: 1,
        step: 0.01,
      }),
    ],
  },
  {
    id: "vectorStore",
    label: "Vector Store",
    description: "Where the index lives. Most changes need a restart.",
    fields: [
      string(["vectorStore", "path"], "Store path", { impact: "restart" }),
      enumField(["vectorStore", "provider"], "Backend", ["lancedb", "memory", "clickhouse"], {
        impact: "restart",
      }),
      string(["vectorStore", "clickhouse", "url"], "ClickHouse URL", {
        advanced: true,
        impact: "restart",
      }),
      string(["vectorStore", "clickhouse", "database"], "ClickHouse database", {
        advanced: true,
        impact: "restart",
      }),
      string(["vectorStore", "clickhouse", "username"], "ClickHouse user", {
        advanced: true,
        impact: "restart",
      }),
      string(["vectorStore", "clickhouse", "password"], "ClickHouse password", {
        advanced: true,
        impact: "restart",
      }),
      string(["vectorStore", "clickhouse", "passwordEnv"], "Password env var", {
        advanced: true,
        impact: "restart",
        description: "Preferred over a password in a committed file.",
      }),
      string(["vectorStore", "clickhouse", "namespace"], "Namespace", {
        advanced: true,
        impact: "restart",
      }),
      number(["vectorStore", "clickhouse", "requestTimeoutMs"], "Request timeout (ms)", {
        advanced: true,
        minimum: 1,
        impact: "restart",
      }),
      number(["vectorStore", "clickhouse", "maxOpenConnections"], "Max connections", {
        advanced: true,
        minimum: 1,
        impact: "restart",
      }),
      boolean(["vectorStore", "clickhouse", "compression"], "Compression", {
        advanced: true,
        impact: "restart",
      }),
      boolean(["vectorStore", "clickhouse", "state", "syncDescCache"], "Sync description cache", {
        advanced: true,
        impact: "restart",
      }),
      boolean(["vectorStore", "clickhouse", "lease", "enabled"], "Single-writer lease", {
        advanced: true,
        impact: "restart",
      }),
      number(["vectorStore", "clickhouse", "lease", "ttlSeconds"], "Lease TTL (s)", {
        advanced: true,
        minimum: 10,
        impact: "restart",
      }),
      number(["vectorStore", "clickhouse", "diskFreeFloorBytes"], "Disk free floor (bytes)", {
        advanced: true,
        minimum: 0,
        impact: "restart",
      }),
      enumField(["vectorStore", "clickhouse", "ann"], "ANN index", ["off", "hnsw"], {
        advanced: true,
        impact: "restart",
      }),
      number(["vectorStore", "clickhouse", "annFetchMultiplier"], "ANN fetch multiplier", {
        advanced: true,
        minimum: 1,
        impact: "restart",
      }),
      boolean(["vectorStore", "clickhouse", "annWithRescoring"], "ANN rescoring", {
        advanced: true,
        impact: "restart",
      }),
    ],
  },
  {
    id: "openCode",
    label: "OpenCode Integration",
    description: "Tools, prompt injection, and background indexing.",
    fields: [
      boolean(["openCode", "enabled"], "Plugin enabled"),
      number(["openCode", "maxContextChunks"], "Max context chunks", { minimum: 1 }),
      boolean(["openCode", "readOverride"], "Override read tool"),
      number(["openCode", "maxReadOutputChars"], "Max read output chars", {
        advanced: true,
        minimum: 1,
      }),
      enumField(["openCode", "readNoResultsBehavior"], "Read with no results", [
        "hint",
        "empty",
        "error",
      ], { advanced: true }),
      number(["openCode", "readRelatedFilesMax"], "Related files shown", {
        advanced: true,
        minimum: 0,
      }),
      boolean(["openCode", "injectSystemPrompt"], "Inject RAG guidance"),
      boolean(["openCode", "exploreAgentTools"], "Give explore agent RAG tools"),
      boolean(["openCode", "autoIndex", "enabled"], "Auto-index file changes"),
      number(["openCode", "autoIndex", "debounceMs"], "Auto-index debounce (ms)", {
        minimum: 0,
      }),
      number(["openCode", "autoIndex", "intervalMs"], "Git poll interval (ms)", {
        advanced: true,
        minimum: 0,
      }),
      enumField(["openCode", "autoIndex", "watcher"], "Watcher backend", ["chokidar", "git"], {
        advanced: true,
      }),
      boolean(["openCode", "shell", "backgroundGuidance"], "Background guidance", {
        advanced: true,
      }),
      number(["openCode", "shell", "longRunningThresholdMs"], "Long command threshold (ms)", {
        advanced: true,
        minimum: 0,
      }),
      number(["openCode", "shell", "foregroundTimeoutMs"], "Foreground timeout (ms)", {
        advanced: true,
        minimum: 1,
      }),
      boolean(["openCode", "shell", "captureLongRunningQuirk"], "Capture long-command quirks", {
        advanced: true,
      }),
    ],
  },
  {
    id: "memory",
    label: "Quirk Memory",
    description: "Experiential memory captured across sessions.",
    fields: [
      boolean(["memory", "enabled"], "Memory enabled"),
      boolean(["memory", "autoInject"], "Auto-inject quirks"),
      number(["memory", "minConfidence"], "Min confidence", {
        minimum: 0,
        maximum: 1,
        step: 0.01,
      }),
      number(["memory", "recallMinScore"], "Manual recall min score", {
        minimum: 0,
        maximum: 1,
        step: 0.01,
      }),
      number(["memory", "autoInjectMinScore"], "Auto-inject min score", {
        minimum: 0,
        maximum: 1,
        step: 0.01,
      }),
      number(["memory", "autoInjectTopK"], "Auto-inject top K", { minimum: 0 }),
      number(["memory", "autoInjectMinTokenOverlap"], "Auto-inject token overlap", {
        advanced: true,
        minimum: 0,
      }),
      number(["memory", "autoInjectLatencyBudgetMs"], "Auto-inject latency budget (ms)", {
        advanced: true,
        minimum: 0,
      }),
      boolean(["memory", "passiveCapture"], "Passive capture", { advanced: true }),
      boolean(["memory", "promptEnforcement"], "Mandatory capture prompt", { advanced: true }),
      boolean(["memory", "sessionEndExtraction"], "Session-end extraction", { advanced: true }),
      number(["memory", "autoCaptureMaxPerTurn"], "Max captures per turn", {
        advanced: true,
        minimum: 0,
      }),
      number(["memory", "autoCaptureDedupThreshold"], "Capture dedup threshold", {
        advanced: true,
        minimum: 0,
        maximum: 1,
        step: 0.01,
      }),
      boolean(["memory", "injectOnToolError"], "Inject after tool errors", { advanced: true }),
      number(["memory", "toolErrorMinScore"], "Tool-error min score", {
        advanced: true,
        minimum: 0,
        maximum: 1,
        step: 0.01,
      }),
      number(["memory", "toolErrorTopK"], "Tool-error top K", { advanced: true, minimum: 0 }),
      number(["memory", "toolErrorMinTokenOverlap"], "Tool-error token overlap", {
        advanced: true,
        minimum: 0,
      }),
      number(["memory", "toolErrorCooldownMs"], "Tool-error cooldown (ms)", {
        advanced: true,
        minimum: 0,
      }),
      number(["memory", "toolErrorMaxPerSession"], "Tool-error injections / session", {
        advanced: true,
        minimum: 0,
      }),
      number(["memory", "toolErrorLatencyBudgetMs"], "Tool-error latency budget (ms)", {
        advanced: true,
        minimum: 0,
      }),
      boolean(["memory", "autoCreateOnToolError"], "Create quirks from tool errors", {
        advanced: true,
      }),
      number(["memory", "toolErrorCreateMaxPerSession"], "Creations / session", {
        advanced: true,
        minimum: 0,
      }),
      number(["memory", "toolErrorCreateCooldownMs"], "Creation cooldown (ms)", {
        advanced: true,
        minimum: 0,
      }),
      number(["memory", "toolErrorCreateMinScore"], "Creation min score", {
        advanced: true,
        minimum: 0,
        maximum: 1,
        step: 0.01,
      }),
      number(["memory", "toolErrorCreateLatencyBudgetMs"], "Creation latency budget (ms)", {
        advanced: true,
        minimum: 0,
      }),
      boolean(["memory", "toolErrorInjectCreated"], "Inject created quirk", { advanced: true }),
      boolean(["memory", "toolErrorProactiveInject"], "Proactive tool gotchas", { advanced: true }),
      number(["memory", "toolErrorProactiveMaxItems"], "Max proactive gotchas", {
        advanced: true,
        minimum: 0,
      }),
      boolean(["memory", "interceptAllErrors"], "Intercept all failures", { advanced: true }),
      boolean(["memory", "autoCreateOnInterceptedError"], "Create from intercepted failures", {
        advanced: true,
      }),
      boolean(["memory", "decay", "enabled"], "Confidence decay", { advanced: true }),
      number(["memory", "decay", "halfLifeDays"], "Decay half-life (days)", {
        advanced: true,
        minimum: 1,
      }),
    ],
  },
  {
    id: "documentationMode",
    label: "Documentation Mode",
    description: "Agent mode that adds doc comments to undocumented code.",
    fields: [
      boolean(["documentationMode", "enabled"], "Documentation mode enabled"),
      boolean(["documentationMode", "autoStart"], "Start automatically"),
      number(["documentationMode", "batchSize"], "Files per batch", { minimum: 1 }),
      string(["documentationMode", "systemPrompt"], "System prompt", {
        advanced: true,
        multiline: true,
      }),
    ],
  },
  {
    id: "wikiMode",
    label: "Wiki Mode",
    description: "Agent instruction that maintains a knowledge wiki.",
    fields: [
      boolean(["wikiMode", "enabled"], "Wiki mode enabled"),
      string(["wikiMode", "systemPrompt"], "System prompt", {
        advanced: true,
        multiline: true,
      }),
    ],
  },
  {
    id: "mcp",
    label: "MCP Server",
    description: "Standalone Model Context Protocol server.",
    fields: [boolean(["mcp", "enabled"], "Auto-start MCP server", { impact: "restart" })],
  },
  {
    id: "setup",
    label: "Workspace Setup",
    description: "Scaffolding behaviour for repositories without a config.",
    fields: [boolean(["setup", "autoScaffold"], "Auto-scaffold new workspaces", { advanced: true })],
  },
  {
    id: "autoUpdate",
    label: "Auto Update",
    description: "Update checks and optional automatic installs.",
    fields: [
      boolean(["autoUpdate", "enabled"], "Check for updates"),
      boolean(["autoUpdate", "autoInstall"], "Install updates automatically", { advanced: true }),
      number(["autoUpdate", "cooldownMs"], "Retry cooldown (ms)", {
        advanced: true,
        minimum: 0,
      }),
      number(["autoUpdate", "maxConsecutiveFailures"], "Max consecutive failures", {
        advanced: true,
        minimum: 1,
      }),
    ],
  },
  {
    id: "ui",
    label: "Web UI",
    description: "This dashboard's own server settings.",
    fields: [
      number(["ui", "port"], "Port", { minimum: 1, maximum: 65535, impact: "restart" }),
      boolean(["ui", "openBrowser"], "Open browser on start", { impact: "restart" }),
      enumField(["ui", "theme"], "Theme", ["dark", "light", "plasma", "drama"], {
        scope: "global",
        description: "Dashboard color theme. A machine-wide preference, saved to the global config.",
      }),
    ],
  },
  {
    id: "tui",
    label: "Terminal UI",
    description: "Keybindings for the OpenCode terminal plugin.",
    fields: [
      string(["tui", "settingsKeybinding"], "Open settings", { impact: "restart" }),
      string(["tui", "fileListKeybinding"], "Add file list", { impact: "restart" }),
      string(["tui", "chunksKeybinding"], "Add chunks", { impact: "restart" }),
    ],
  },
  {
    id: "logging",
    label: "Logging",
    description: "Plugin log verbosity and destination.",
    fields: [
      enumField(["logging", "level"], "Level", ["debug", "info", "error", "none"]),
      string(["logging", "logFilePath"], "Log file path", { advanced: true }),
    ],
  },
];

/** Flattened path→field index. */
const FIELD_BY_PATH = new Map<string, SettingField>();
for (const section of SETTINGS_SECTIONS) {
  for (const entry of section.fields) {
    FIELD_BY_PATH.set(entry.path.join("."), entry);
  }
}

/** Dotted form of a config path. */
export function dottedPath(path: readonly string[]): string {
  return path.join(".");
}

/** Look up a schema field by path. */
export function findSettingField(path: readonly string[]): SettingField | undefined {
  return FIELD_BY_PATH.get(dottedPath(path));
}

/** True when every segment is a safe object key (no prototype pollution). */
export function isSafeConfigPath(path: readonly string[]): boolean {
  if (path.length === 0 || path.length > 12) return false;
  return path.every(
    (segment) =>
      typeof segment === "string" &&
      segment.length > 0 &&
      segment.length <= 120 &&
      segment !== "__proto__" &&
      segment !== "prototype" &&
      segment !== "constructor",
  );
}

/**
 * Secret-ness of a path for redaction purposes.
 *
 * Schema fields win. For paths the schema does not know (custom or future
 * keys) only an EXACT credential leaf name counts — never a substring match,
 * which is what wrongly redacted `autoInjectMinTokenOverlap`.
 */
export function isSecretConfigPath(path: readonly string[]): boolean {
  const declared = findSettingField(path);
  if (declared) return declared.secret === true;
  const leaf = path[path.length - 1];
  return leaf !== undefined && SECRET_LEAVES.has(leaf);
}

/** True when a value is a plain JSON object. */
export function isPlainConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-clone a JSON-ish value. */
export function cloneConfigValue<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Strip secret values from a config object, in place.
 *
 * Known secret fields become the `***` sentinel (so the UI can show that a
 * value exists without receiving it); unknown credential-named leaves are
 * removed entirely.
 */
export function redactConfigSecrets(
  value: unknown,
  path: readonly string[] = [],
): void {
  if (!isPlainConfigObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (isPlainConfigObject(child)) {
      redactConfigSecrets(child, childPath);
      continue;
    }
    if (!isSecretConfigPath(childPath)) continue;
    const declared = findSettingField(childPath);
    if (declared?.secret) {
      value[key] = "***";
    } else {
      delete value[key];
    }
  }
}

/** Explicitly ignored leaves that are not user-editable settings. */
export const IGNORED_CONFIG_PATHS = new Set<string>([
  // `vectorStore.path` is editable, but the probe-derived dimension cache is
  // intentionally schema-managed only when the provider cannot be reached.
]);

/** Collect the dotted leaf paths of a config object (arrays are leaves). */
export function collectConfigLeafPaths(
  value: unknown,
  path: readonly string[] = [],
  out: string[] = [],
): string[] {
  if (isPlainConfigObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      if (path.length > 0) out.push(dottedPath(path));
      return out;
    }
    for (const [key, child] of Object.entries(value)) {
      collectConfigLeafPaths(child, [...path, key], out);
    }
    return out;
  }
  if (path.length > 0) out.push(dottedPath(path));
  return out;
}
