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
      description: "HTTP(S) proxy for outbound provider requests.",
    }),
    string([section, "proxy", "username"], "Proxy username", {
      advanced: true,
      description: "Username for proxy authentication.",
    }),
    string([section, "proxy", "password"], "Proxy password", {
      advanced: true,
      description: "Password for proxy authentication; stored machine-globally.",
    }),
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
      ], {
        impact: "reindex",
        description: "Service that turns text into vectors. Ollama runs locally; the others are hosted APIs. Changing it requires a full re-index.",
      }),
      string(["embedding", "model"], "Model", {
        impact: "reindex",
        description: "Embedding model at the provider (e.g. nomic-embed-text for Ollama). It defines the vector dimension, so changing it requires a re-index.",
      }),
      string(["embedding", "baseUrl"], "Base URL", {
        impact: "reindex",
        description: "Endpoint of the embedding server, e.g. http://127.0.0.1:11434 for a local Ollama. Empty uses the provider default.",
      }),
      string(["embedding", "apiKey"], "API key", {
        impact: "reindex",
        description: "Credential for hosted providers. Stored in the machine-global config only, never in a repository file.",
      }),
      number(["embedding", "vectorDimension"], "Vector dimension", {
        advanced: true,
        minimum: 1,
        impact: "reindex",
        description: "Probed automatically; set only when the probe cannot reach the provider. Must match the model, otherwise the index cannot be used.",
      }),
      number(["embedding", "timeoutMs"], "Request timeout (ms)", {
        minimum: 1,
        description: "Maximum wait for one embedding request. Raise it for slow local models or large batches.",
      }),
      string(["embedding", "documentPrefix"], "Document prefix", {
        advanced: true,
        impact: "reindex",
        description: "Text prepended to every chunk before embedding (some models need e.g. a passage prefix). Requires a re-index.",
      }),
      string(["embedding", "queryPrefix"], "Query prefix", {
        advanced: true,
        description: "Text prepended to search queries before embedding (e.g. a query prefix). Must match the model convention.",
      }),
      string(["embedding", "keepAlive"], "Ollama keep-alive", {
        advanced: true,
        placeholder: "30m",
        description: "How long Ollama keeps the model in memory between requests (e.g. 30m, -1 = forever).",
      }),
      ...proxyFields("embedding"),
    ],
  },
  {
    id: "description",
    label: "Descriptions",
    description: "LLM-generated summaries embedded alongside code chunks.",
    fields: [
      boolean(["description", "enabled"], "Generate descriptions", {
        impact: "reindex",
        description: "Write a one-sentence summary for every chunk and embed it alongside the code. Improves semantic search quality and requires a re-index.",
      }),
      enumField(["description", "provider"], "Provider", ["ollama", "openai", "anthropic", "google"], {
        impact: "reindex",
        description: "Model service that writes the summaries: a local Ollama instance or a hosted API.",
      }),
      string(["description", "model"], "Model", {
        impact: "reindex",
        description: "Model used for the summaries. Smaller models are cheaper and usually sufficient for one-sentence descriptions.",
      }),
      string(["description", "baseUrl"], "Base URL", {
        impact: "reindex",
        description: "Endpoint of the description model, e.g. a local Ollama or an OpenAI-compatible server. Empty uses the provider default.",
      }),
      string(["description", "apiKey"], "API key", {
        impact: "reindex",
        description: "Credential for hosted providers. Stored in the machine-global config only.",
      }),
      number(["description", "timeoutMs"], "Request timeout (ms)", {
        minimum: 1,
        description: "Maximum wait for one description request. Raise it for slow or remote models.",
      }),
      string(["description", "keepAlive"], "Ollama keep-alive", {
        advanced: true,
        description: "How long Ollama keeps the description model loaded between requests (e.g. 30m).",
      }),
      string(["description", "systemPrompt"], "System prompt", {
        advanced: true,
        multiline: true,
        impact: "reindex",
        description: "Instruction sent to the model for every chunk. Edit it to change summary style, language, or length.",
      }),
      boolean(["description", "think"], "Allow reasoning tokens", {
        advanced: true,
        description: "Let reasoning models think before answering. Slower and usually unnecessary for short summaries.",
      }),
      number(["description", "numCtx"], "Context window", {
        advanced: true,
        minimum: 1,
        description: "Context window of the description model in tokens. Larger values allow bigger chunks per request.",
      }),
      number(["description", "maxContentChars"], "Max content chars", {
        advanced: true,
        minimum: 1,
        description: "Truncate chunk content to this many characters before sending it to the model; keeps requests small.",
      }),
      boolean(["description", "batchEnabled"], "Batch requests", {
        advanced: true,
        impact: "reindex",
        description: "Bundle several chunks into one request (OpenAI-style batch endpoints). Fewer calls, but one failure affects the whole batch.",
      }),
      number(["description", "batchMaxChunks"], "Batch size", {
        advanced: true,
        minimum: 1,
        description: "Maximum number of chunks per batch request.",
      }),
      number(["description", "batchTimeoutMs"], "Batch timeout (ms)", {
        advanced: true,
        minimum: 1,
        description: "Maximum wait for one batch request before it counts as failed.",
      }),
      number(["description", "batchConcurrency"], "Batch concurrency", {
        advanced: true,
        minimum: 1,
        description: "Number of batch requests sent in parallel.",
      }),
      number(["description", "retryMax"], "Max retries", {
        advanced: true,
        minimum: 0,
        description: "How often a failed description request is retried before the chunk is left without a summary.",
      }),
      number(["description", "retryBaseDelayMs"], "Retry base delay (ms)", {
        advanced: true,
        minimum: 0,
        description: "Initial delay between retries; doubles after each attempt.",
      }),
      ...proxyFields("description"),
    ],
  },
  {
    id: "imageDescription",
    label: "Image Descriptions",
    description: "Vision model used to describe images during indexing.",
    fields: [
      boolean(["imageDescription", "enabled"], "Describe images", {
        impact: "reindex",
        description: "Describe images during indexing so screenshots, diagrams, and photos become searchable text. Requires a vision model and a re-index.",
      }),
      enumField(["imageDescription", "provider"], "Provider", [
        "ollama",
        "openai",
        "anthropic",
        "google",
        "opencode",
        "opencode-go",
      ], {
        impact: "reindex",
        description: "Vision model service: a local Ollama instance or a hosted API, including OpenCode Zen.",
      }),
      string(["imageDescription", "model"], "Model", {
        impact: "reindex",
        description: "Vision model used to describe images, e.g. a Qwen-VL or MiniCPM-V variant.",
      }),
      string(["imageDescription", "baseUrl"], "Base URL", {
        impact: "reindex",
        description: "Endpoint of the vision model. Empty uses the provider default.",
      }),
      string(["imageDescription", "apiKey"], "API key", {
        impact: "reindex",
        description: "Credential for hosted vision providers. Stored in the machine-global config only.",
      }),
      number(["imageDescription", "timeoutMs"], "Request timeout (ms)", {
        minimum: 1,
        description: "Maximum wait for one image description. Raise it for large images or slow models.",
      }),
      string(["imageDescription", "prompt"], "Prompt", {
        multiline: true,
        impact: "reindex",
        description: "Instruction used for every image. Shape it to capture what matters, e.g. UI elements, diagram labels, or visible text.",
      }),
      boolean(["imageDescription", "think"], "Allow reasoning tokens", {
        advanced: true,
        description: "Let reasoning models think before answering. Slower and rarely needed for short captions.",
      }),
      number(["imageDescription", "numCtx"], "Context window", {
        advanced: true,
        minimum: 1,
        description: "Context window of the vision model in tokens.",
      }),
      string(["imageDescription", "keepAlive"], "Ollama keep-alive", {
        advanced: true,
        description: "How long Ollama keeps the vision model in memory between requests.",
      }),
      number(["imageDescription", "resizeMaxDimension"], "Max image dimension", {
        advanced: true,
        minimum: 1,
        description: "Downscale images so the longest side fits this pixel size before sending. Reduces cost and latency.",
      }),
      ...proxyFields("imageDescription"),
      enumField(["imageDescription", "onDemand", "provider"], "On-demand provider", [
        "ollama",
        "openai",
        "anthropic",
        "google",
        "opencode",
        "opencode-go",
      ], {
        advanced: true,
        description: "Separate provider for query-time image questions. Falls back to the indexing vision model when unset.",
      }),
      string(["imageDescription", "onDemand", "model"], "On-demand model", {
        advanced: true,
        description: "Vision model for on-demand descriptions; may differ from the indexing model.",
      }),
      string(["imageDescription", "onDemand", "baseUrl"], "On-demand base URL", {
        advanced: true,
        description: "Endpoint for the on-demand vision model. Empty uses the provider default.",
      }),
      string(["imageDescription", "onDemand", "apiKey"], "On-demand API key", {
        advanced: true,
        description: "Credential for the on-demand vision provider; stored machine-globally.",
      }),
      number(["imageDescription", "onDemand", "timeoutMs"], "On-demand timeout (ms)", {
        advanced: true,
        minimum: 1,
        description: "Maximum wait for one on-demand image description.",
      }),
      string(["imageDescription", "onDemand", "prompt"], "On-demand prompt", {
        advanced: true,
        description: "Prompt used for on-demand descriptions. It may ask a different question than the indexing prompt.",
      }),
      boolean(["imageDescription", "onDemand", "think"], "On-demand reasoning tokens", {
        advanced: true,
        description: "Allow reasoning tokens for on-demand descriptions.",
      }),
      number(["imageDescription", "onDemand", "numCtx"], "On-demand context window", {
        advanced: true,
        minimum: 1,
        description: "Context window in tokens for on-demand descriptions.",
      }),
      string(["imageDescription", "onDemand", "keepAlive"], "On-demand keep-alive", {
        advanced: true,
        description: "How long Ollama keeps the on-demand model loaded.",
      }),
      number(["imageDescription", "onDemand", "resizeMaxDimension"], "On-demand max dimension", {
        advanced: true,
        minimum: 1,
        description: "Downscale images for on-demand descriptions so the longest side fits this pixel size.",
      }),
    ],
  },
  {
    id: "decision",
    label: "Decision Model",
    description: "Local decision model behind the make_decision tool (Ollama /v1/systemone or a compatible server such as llama-swap).",
    fields: [
      boolean(["decision", "enabled"], "Enable make_decision", {
        description: "Expose the make_decision tool that answers classification, routing, and scoring questions with a small local model.",
      }),
      enumField(["decision", "provider"], "Provider", ["ollama"], {
        description: "Decision backend. Only ollama is implemented; it also works with any server exposing POST /v1/systemone, e.g. a llama-swap router.",
      }),
      string(["decision", "model"], "Model", {
        description: "Model name passed to the endpoint (tev1 for Ollama, or e.g. Clef-Flash on llama-swap).",
      }),
      string(["decision", "baseUrl"], "Base URL", {
        description: "Decision server URL. Root, /api, or /v1 suffixes are accepted; the request is sent to <root>/v1/systemone.",
      }),
      string(["decision", "apiKey"], "API key", {
        description: "Bearer key sent as the Authorization header. Required by key-protected servers such as llama-swap.",
      }),
      number(["decision", "timeoutMs"], "Request timeout (ms)", {
        minimum: 1,
        description: "Maximum wait for one decision call. The first call can be slow because the server may load the model.",
      }),
      string(["decision", "keepAlive"], "Ollama keep-alive", {
        advanced: true,
        description: "How long the server keeps the decision model in memory between calls (e.g. 30m).",
      }),
      boolean(["decision", "routeBeforeAsking"], "Route choices before asking", {
        description: "Instruct the agent to resolve option choices through make_decision before asking you; you are asked only when the answer is uncertain or preference-based.",
      }),
      number(["decision", "maxStateChars"], "Max state chars", {
        advanced: true,
        minimum: 1,
        description: "Reject longer state texts instead of truncating them. The model context is small (~2k tokens).",
      }),
      number(["decision", "retryMax"], "Max retries", {
        advanced: true,
        minimum: 0,
        description: "How often retryable failures (rate limit, server error, network) are retried.",
      }),
      number(["decision", "retryBaseDelayMs"], "Retry base delay (ms)", {
        advanced: true,
        minimum: 0,
        description: "Initial delay between retries; doubles after each attempt.",
      }),
      ...proxyFields("decision"),
    ],
  },
  {
    id: "reranking",
    label: "Reranking",
    description: "Optional cross-encoder rerank stage after hybrid fusion.",
    fields: [
      boolean(["reranking", "enabled"], "Enable reranking", {
        description: "Rescore the fused candidate list with a cross-encoder before returning results. Better ordering, slightly slower queries.",
      }),
      enumField(["reranking", "provider"], "Provider", ["llama-server"], {
        description: "Rerank backend. llama-server works with llama.cpp and llama-swap.",
      }),
      string(["reranking", "model"], "Model", {
        description: "Cross-encoder model name, e.g. a Qwen3-Reranker variant.",
      }),
      string(["reranking", "baseUrl"], "Base URL", {
        description: "Rerank server endpoint (OpenAI-compatible /v1 API).",
      }),
      string(["reranking", "apiKey"], "API key", {
        description: "Bearer key for key-protected rerank servers such as llama-swap.",
      }),
      number(["reranking", "candidates"], "Candidates", {
        minimum: 1,
        description: "How many fused candidates are scored. More candidates improve recall but add latency.",
      }),
      number(["reranking", "maxDocChars"], "Max document chars", {
        advanced: true,
        minimum: 1,
        description: "Truncate each candidate document before scoring; keeps requests small.",
      }),
      number(["reranking", "minScore"], "Rerank min score", {
        advanced: true,
        minimum: 0,
        maximum: 1,
        step: 0.01,
        description: "Drop reranked results below this score. 0 keeps everything.",
      }),
      number(["reranking", "timeoutMs"], "Timeout (ms)", {
        minimum: 1,
        description: "Maximum wait for one rerank request.",
      }),
      string(["reranking", "queryTemplate"], "Query template", {
        advanced: true,
        description: "Optional template applied to the query; use {query} as the placeholder.",
      }),
      enumField(["reranking", "docField"], "Document field", ["content", "content+description"], {
        advanced: true,
        description: "Which text is scored as the document: the code content alone or content plus its generated description.",
      }),
      ...proxyFields("reranking"),
    ],
  },
  {
    id: "shellGuard",
    label: "Shell Guard",
    description: "Decision-model vetting of shell commands before they run.",
    fields: [
      boolean(["shellGuard", "enabled"], "Enable Shell Guard", {
        description: "Classify every shell command for destructive or malicious intent before it runs and escalate suspicious ones to a confirmation prompt.",
      }),
      number(["shellGuard", "threshold"], "Flag threshold", {
        minimum: 0,
        maximum: 1,
        step: 0.01,
        description: "Probability (0-1) at which a command is flagged. Lower values mean more prompts.",
      }),
      enumField(["shellGuard", "onError"], "On classifier error", ["allow", "ask"], {
        description: "What happens when the classifier fails or times out: allow runs the command (fail-open), ask requires confirmation.",
      }),
      number(["shellGuard", "timeoutMs"], "Classification timeout (ms)", {
        minimum: 1,
        description: "Maximum wait for the classification. Keep it short because every command waits for the verdict.",
      }),
      string(["shellGuard", "provider"], "Provider override", {
        advanced: true,
        description: "Override the decision backend for shell vetting (default: the decision section).",
      }),
      string(["shellGuard", "baseUrl"], "Base URL override", {
        advanced: true,
        description: "Override the decision endpoint for shell vetting.",
      }),
      string(["shellGuard", "model"], "Model override", {
        advanced: true,
        description: "Override the decision model for shell vetting, e.g. Clef-Flash.",
      }),
      string(["shellGuard", "apiKey"], "API key override", {
        advanced: true,
        scope: "global",
        description: "Bearer key for a key-protected decision endpoint such as llama-swap. Stored machine-globally.",
      }),
      number(["shellGuard", "cacheTtlMs"], "Verdict cache TTL (ms)", {
        advanced: true,
        minimum: 0,
        description: "Reuse identical verdicts for this long. 0 disables the cache.",
      }),
      number(["shellGuard", "maxCacheEntries"], "Max cached verdicts", {
        advanced: true,
        minimum: 1,
        description: "Upper bound of cached verdicts before the oldest are dropped.",
      }),
    ],
  },
  {
    id: "indexing",
    label: "Indexing",
    description: "What gets scanned and how indexing is tuned.",
    fields: [
      strings(["indexing", "includeExtensions"], "Included extensions", {
        impact: "reindex",
        description: "File extensions that are indexed. Empty uses the built-in default list.",
      }),
      strings(["indexing", "includeDirs"], "Included folders", {
        impact: "reindex",
        description: "Only index these folders. Empty = whole workspace. Paths are anchored to the workspace root.",
      }),
      strings(["indexing", "excludeDirs"], "Excluded folders", {
        impact: "reindex",
        description: "Folders that are never scanned, e.g. node_modules or .git.",
      }),
      strings(["indexing", "excludeFiles"], "Excluded files", {
        impact: "reindex",
        description: "Individual files or glob patterns to skip.",
      }),
      number(["indexing", "chunkOverlap"], "Chunk overlap (lines)", {
        minimum: 0,
        impact: "reindex",
        description: "Lines of overlap between adjacent chunks; helps when a definition spans a chunk boundary.",
      }),
      number(["indexing", "maxChunkSize"], "Max chunk size (lines)", {
        minimum: 0,
        impact: "reindex",
        description: "0 = no limit (whole AST node). Smaller values produce more, smaller chunks.",
      }),
      number(["indexing", "minFileSizeBytes"], "Minimum file size (bytes)", {
        minimum: 0,
        impact: "reindex",
        description: "Skip files smaller than this. Filters empty or trivial files; 0 = no minimum.",
      }),
      number(["indexing", "concurrency"], "File concurrency", {
        minimum: 1,
        description: "Files parsed in parallel. Higher values speed up indexing at the cost of CPU and memory.",
      }),
      number(["indexing", "embedBatchSize"], "Embedding batch size", {
        minimum: 1,
        description: "Chunks per embedding request sent to the provider.",
      }),
      number(["indexing", "embedConcurrency"], "Embedding concurrency", {
        minimum: 1,
        description: "Embedding requests in flight at the same time.",
      }),
      number(["indexing", "ollamaMaxBatchSize"], "Ollama max batch size", {
        advanced: true,
        minimum: 1,
        description: "Upper bound for one Ollama embedding request. Ollama handles smaller batches more reliably.",
      }),
      number(["indexing", "descriptionConcurrency"], "Description concurrency", {
        advanced: true,
        minimum: 1,
        description: "Description requests in flight at the same time.",
      }),
      boolean(["indexing", "embedDescriptions"], "Embed descriptions", {
        impact: "reindex",
        description: "Embed generated summaries as vectors instead of only storing them as text. Requires a re-index.",
      }),
      number(["indexing", "maxSvgSizeBytes"], "Max SVG size (bytes)", {
        advanced: true,
        minimum: 0,
        impact: "reindex",
        description: "SVGs above this size are skipped to avoid huge diagram payloads; 0 = no limit.",
      }),
      number(["indexing", "optimizeIntervalWindows"], "Optimize every N windows", {
        advanced: true,
        minimum: 0,
        description: "Run a store optimization after every N indexing windows during a pass. 8 is the default; the store is optimized once more at the end.",
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
        description: "Override the parser per file extension, e.g. {.ssl: ssl}. Useful when a language needs a different splitter.",
      }),
      stringArrayMap(["chunking", "nodeTypes"], "Language → node types", {
        advanced: true,
        impact: "reindex",
        description: "Restrict which syntax-tree node types become chunks per language, e.g. only function declarations.",
      }),
      json(["chunkers"], "Custom chunker modules", {
        advanced: true,
        impact: "restart",
        description: "Pluggable custom chunker modules (JSON). They are loaded at startup, so a change requires a restart.",
      }),
    ],
  },
  {
    id: "retrieval",
    label: "Retrieval",
    description: "Query-time ranking and context shaping.",
    fields: [
      number(["retrieval", "topK"], "Top K", {
        minimum: 1,
        maximum: 1000,
        description: "Chunks returned per search. Higher values give more context but consume more tokens.",
      }),
      number(["retrieval", "minScore"], "Minimum score", {
        minimum: 0,
        maximum: 1,
        step: 0.01,
        description: "Drop results scoring below this threshold. How the value is applied depends on the min-score mode.",
      }),
      enumField(["retrieval", "minScoreMode"], "Min-score mode", ["fused", "normalized"], {
        description: "How the threshold is interpreted: fused compares the combined score as-is; normalized rescales it so the same value behaves the same across keyword weights.",
      }),
      boolean(["retrieval", "hybridSearch", "enabled"], "Hybrid search", {
        description: "Combine vector similarity with keyword matching so exact identifiers and rare terms are found reliably.",
      }),
      number(["retrieval", "hybridSearch", "keywordWeight"], "Keyword weight", {
        minimum: 0,
        maximum: 1,
        step: 0.01,
        description: "Weight of keyword matches in the fused score (0-1). 0 disables the keyword contribution.",
      }),
      number(["retrieval", "hybridSearch", "symbolKeywordWeight"], "Symbol keyword weight", {
        minimum: 0,
        maximum: 1,
        step: 0.01,
        description: "Keyword weight for symbol-style queries (a bare identifier). Defaults to the general keyword weight; raise it to favor exact symbol hits.",
      }),
      number(["retrieval", "hybridSearch", "docKeywordDemotion"], "Document demotion", {
        advanced: true,
        minimum: 0,
        maximum: 1,
        step: 0.01,
        description: "Multiplier (0-1) on keyword scores of documentation chunks so prose does not outrank code.",
      }),
      number(["retrieval", "hybridSearch", "testKeywordDemotion"], "Test demotion", {
        advanced: true,
        minimum: 0,
        maximum: 1,
        step: 0.01,
        description: "Multiplier (0-1) on keyword scores of test chunks so tests do not outrank the implementation.",
      }),
      boolean(["retrieval", "contextOptimization", "enabled"], "Context optimization", {
        description: "Post-process retrieved chunks: merge adjacent pieces and drop near-duplicates before returning them.",
      }),
      number(["retrieval", "contextOptimization", "maxPerFile"], "Max chunks per file", {
        advanced: true,
        minimum: 0,
        description: "Maximum chunks taken from a single file. 0 = unlimited.",
      }),
      boolean(["retrieval", "contextOptimization", "mergeAdjacent"], "Merge adjacent chunks", {
        advanced: true,
        description: "Merge chunks that touch or nearly touch into one continuous block.",
      }),
      number(["retrieval", "contextOptimization", "adjacentGapThreshold"], "Adjacent gap", {
        advanced: true,
        minimum: 0,
        description: "Maximum line gap at which two chunks are still merged.",
      }),
      number(["retrieval", "contextOptimization", "similarityThreshold"], "Similarity threshold", {
        advanced: true,
        minimum: 0,
        maximum: 1,
        step: 0.01,
        description: "Drop a chunk when it is at least this similar (0-1) to a higher-ranked chunk.",
      }),
    ],
  },
  {
    id: "vectorStore",
    label: "Vector Store",
    description: "Where the index lives. Most changes need a restart.",
    fields: [
      string(["vectorStore", "path"], "Store path", {
        impact: "restart",
        description: "Directory for the local index (LanceDB) or the disposable local cache. Relative paths resolve against the workspace.",
      }),
      enumField(["vectorStore", "provider"], "Backend", ["lancedb", "memory", "clickhouse"], {
        impact: "restart",
        description: "Storage backend: lancedb (local default), memory (tests only, not persistent), clickhouse (shared server).",
      }),
      string(["vectorStore", "clickhouse", "url"], "ClickHouse URL", {
        advanced: true,
        impact: "restart",
        description: "ClickHouse HTTP endpoint, e.g. http://pat06:8123.",
      }),
      string(["vectorStore", "clickhouse", "database"], "ClickHouse database", {
        advanced: true,
        impact: "restart",
        description: "Database that holds the index tables.",
      }),
      string(["vectorStore", "clickhouse", "username"], "ClickHouse user", {
        advanced: true,
        impact: "restart",
        description: "Login user for ClickHouse.",
      }),
      string(["vectorStore", "clickhouse", "password"], "ClickHouse password", {
        advanced: true,
        impact: "restart",
        description: "Login password. Prefer the env var option so no secret lands in a committed file.",
      }),
      string(["vectorStore", "clickhouse", "passwordEnv"], "Password env var", {
        advanced: true,
        impact: "restart",
        description: "Name of the environment variable that holds the password; preferred over a password in a committed file.",
      }),
      string(["vectorStore", "clickhouse", "namespace"], "Namespace", {
        advanced: true,
        impact: "restart",
        description: "Logical index name inside the database; isolates workspaces that share one server.",
      }),
      number(["vectorStore", "clickhouse", "requestTimeoutMs"], "Request timeout (ms)", {
        advanced: true,
        minimum: 1,
        impact: "restart",
        description: "Maximum wait for one ClickHouse request.",
      }),
      number(["vectorStore", "clickhouse", "maxOpenConnections"], "Max connections", {
        advanced: true,
        minimum: 1,
        impact: "restart",
        description: "Connection pool size for ClickHouse.",
      }),
      boolean(["vectorStore", "clickhouse", "compression"], "Compression", {
        advanced: true,
        impact: "restart",
        description: "Compress HTTP traffic to ClickHouse. Lower bandwidth, slightly more CPU.",
      }),
      boolean(["vectorStore", "clickhouse", "state", "syncDescCache"], "Sync description cache", {
        advanced: true,
        impact: "restart",
        description: "Mirror the description cache to ClickHouse so other machines reuse generated summaries.",
      }),
      boolean(["vectorStore", "clickhouse", "lease", "enabled"], "Single-writer lease", {
        advanced: true,
        impact: "restart",
        description: "Allow only one process to write the shared index at a time, preventing concurrent-write corruption.",
      }),
      number(["vectorStore", "clickhouse", "lease", "ttlSeconds"], "Lease TTL (s)", {
        advanced: true,
        minimum: 10,
        impact: "restart",
        description: "How long a writer lease stays valid without renewal.",
      }),
      number(["vectorStore", "clickhouse", "diskFreeFloorBytes"], "Disk free floor (bytes)", {
        advanced: true,
        minimum: 0,
        impact: "restart",
        description: "Refuse a full rebuild when the server has less free disk than this. Default is 5 GiB.",
      }),
      enumField(["vectorStore", "clickhouse", "ann"], "ANN index", ["off", "hnsw"], {
        advanced: true,
        impact: "restart",
        description: "Approximate nearest-neighbour index: off uses exact search, hnsw is faster on large indexes.",
      }),
      number(["vectorStore", "clickhouse", "annFetchMultiplier"], "ANN fetch multiplier", {
        advanced: true,
        minimum: 1,
        impact: "restart",
        description: "How many extra candidates the ANN search fetches before rescoring. Higher = better recall, slower.",
      }),
      boolean(["vectorStore", "clickhouse", "annWithRescoring"], "ANN rescoring", {
        advanced: true,
        impact: "restart",
        description: "Rescore ANN candidates with exact vector distance for better accuracy.",
      }),
    ],
  },
  {
    id: "openCode",
    label: "OpenCode Integration",
    description: "Tools, prompt injection, and background indexing.",
    fields: [
      boolean(["openCode", "enabled"], "Plugin enabled", {
        description: "Activate the plugin in OpenCode sessions: RAG tools, quirk memory, and prompt injection.",
      }),
      number(["openCode", "maxContextChunks"], "Max context chunks", {
        minimum: 1,
        description: "Maximum number of chunks included in one tool response.",
      }),
      boolean(["openCode", "readOverride"], "Override read tool", {
        description: "Replace the built-in read tool with a RAG-aware version that appends related snippets.",
      }),
      number(["openCode", "maxReadOutputChars"], "Max read output chars", {
        advanced: true,
        minimum: 1,
        description: "Character budget for the overridden read tool output.",
      }),
      enumField(["openCode", "readNoResultsBehavior"], "Read with no results", [
        "hint",
        "empty",
        "error",
      ], {
        advanced: true,
        description: "What the read tool reports when nothing matches: a hint with suggestions, an empty result, or an error.",
      }),
      number(["openCode", "readRelatedFilesMax"], "Related files shown", {
        advanced: true,
        minimum: 0,
        description: "How many related files the read tool may list alongside a result.",
      }),
      boolean(["openCode", "injectSystemPrompt"], "Inject RAG guidance", {
        description: "Add a short block describing the RAG tools and their intended workflow to the system prompt.",
      }),
      boolean(["openCode", "exploreAgentTools"], "Give explore agent RAG tools", {
        description: "Grant the built-in explore agent access to the RAG tools so it can search semantically.",
      }),
      boolean(["openCode", "autoIndex", "enabled"], "Auto-index file changes", {
        description: "Re-index changed files automatically in the background while you work.",
      }),
      number(["openCode", "autoIndex", "debounceMs"], "Auto-index debounce (ms)", {
        minimum: 0,
        description: "Wait this long after the last change before re-indexing, to batch rapid edits.",
      }),
      number(["openCode", "autoIndex", "intervalMs"], "Git poll interval (ms)", {
        advanced: true,
        minimum: 0,
        description: "How often the git watcher checks for changes.",
      }),
      enumField(["openCode", "autoIndex", "watcher"], "Watcher backend", ["chokidar", "git"], {
        advanced: true,
        description: "Change detector: chokidar watches the filesystem, git polls git status (more robust on network drives).",
      }),
      boolean(["openCode", "shell", "backgroundGuidance"], "Background guidance", {
        advanced: true,
        description: "Tell the agent to run long commands in the background instead of blocking.",
      }),
      number(["openCode", "shell", "longRunningThresholdMs"], "Long command threshold (ms)", {
        advanced: true,
        minimum: 0,
        description: "Commands expected to run longer than this count as long-running.",
      }),
      number(["openCode", "shell", "foregroundTimeoutMs"], "Foreground timeout (ms)", {
        advanced: true,
        minimum: 1,
        description: "Default timeout for shell commands running in the foreground.",
      }),
      boolean(["openCode", "shell", "captureLongRunningQuirk"], "Capture long-command quirks", {
        advanced: true,
        description: "Record a quirk when a foreground command exceeds the long-running threshold, so sessions learn from it.",
      }),
    ],
  },
  {
    id: "memory",
    label: "Quirk Memory",
    description: "Experiential memory captured across sessions.",
    fields: [
      boolean(["memory", "enabled"], "Memory enabled", {
        description: "Persist quirks (gotchas, preferences, decisions, environment facts) across sessions.",
      }),
      boolean(["memory", "autoInject"], "Auto-inject quirks", {
        description: "Automatically inject matching quirks into prompts when the request touches known knowledge.",
      }),
      number(["memory", "minConfidence"], "Min confidence", {
        minimum: 0,
        maximum: 1,
        step: 0.01,
        description: "Minimum confidence a quirk needs to be recalled at all. Lower-confidence memories fade out.",
      }),
      number(["memory", "recallMinScore"], "Manual recall min score", {
        minimum: 0,
        maximum: 1,
        step: 0.01,
        description: "Minimum similarity for explicit recall_quirks calls.",
      }),
      number(["memory", "autoInjectMinScore"], "Auto-inject min score", {
        minimum: 0,
        maximum: 1,
        step: 0.01,
        description: "Minimum similarity for automatic injection into a turn.",
      }),
      number(["memory", "autoInjectTopK"], "Auto-inject top K", {
        minimum: 0,
        description: "Maximum number of quirks injected automatically per turn.",
      }),
      number(["memory", "autoInjectMinTokenOverlap"], "Auto-inject token overlap", {
        advanced: true,
        minimum: 0,
        description: "Minimum shared meaningful words between request and quirk. Blocks vector-only false positives.",
      }),
      number(["memory", "autoInjectLatencyBudgetMs"], "Auto-inject latency budget (ms)", {
        advanced: true,
        minimum: 0,
        description: "Skip auto-injection when recall takes longer than this. 0 = no budget.",
      }),
      boolean(["memory", "passiveCapture"], "Passive capture", {
        advanced: true,
        description: "Extract quirks from each completed agent turn automatically.",
      }),
      boolean(["memory", "promptEnforcement"], "Mandatory capture prompt", {
        advanced: true,
        description: "Upgrade the system-prompt nudge into a mandatory capture instruction.",
      }),
      boolean(["memory", "sessionEndExtraction"], "Session-end extraction", {
        advanced: true,
        description: "Summarize the full session transcript into quirks when the session ends.",
      }),
      number(["memory", "autoCaptureMaxPerTurn"], "Max captures per turn", {
        advanced: true,
        minimum: 0,
        description: "Cap on quirks captured from a single turn.",
      }),
      number(["memory", "autoCaptureDedupThreshold"], "Capture dedup threshold", {
        advanced: true,
        minimum: 0,
        maximum: 1,
        step: 0.01,
        description: "Similarity above which a new capture counts as a duplicate and is skipped.",
      }),
      boolean(["memory", "injectOnToolError"], "Inject after tool errors", {
        advanced: true,
        description: "After a failed tool call, recall matching quirks and inject them into the next request.",
      }),
      number(["memory", "toolErrorMinScore"], "Tool-error min score", {
        advanced: true,
        minimum: 0,
        maximum: 1,
        step: 0.01,
        description: "Minimum similarity for tool-error quirk injection.",
      }),
      number(["memory", "toolErrorTopK"], "Tool-error top K", {
        advanced: true,
        minimum: 0,
        description: "Maximum number of tool-error quirks injected at once.",
      }),
      number(["memory", "toolErrorMinTokenOverlap"], "Tool-error token overlap", {
        advanced: true,
        minimum: 0,
        description: "Minimum shared words for a tool-error quirk to qualify for injection.",
      }),
      number(["memory", "toolErrorCooldownMs"], "Tool-error cooldown (ms)", {
        advanced: true,
        minimum: 0,
        description: "Do not re-attempt the same error signature within this window.",
      }),
      number(["memory", "toolErrorMaxPerSession"], "Tool-error injections / session", {
        advanced: true,
        minimum: 0,
        description: "Cap on tool-error quirk injections per session.",
      }),
      number(["memory", "toolErrorLatencyBudgetMs"], "Tool-error latency budget (ms)", {
        advanced: true,
        minimum: 0,
        description: "Skip tool-error recall when it takes longer than this.",
      }),
      boolean(["memory", "autoCreateOnToolError"], "Create quirks from tool errors", {
        advanced: true,
        description: "Create a new quirk when a tool error has no matching memory.",
      }),
      number(["memory", "toolErrorCreateMaxPerSession"], "Creations / session", {
        advanced: true,
        minimum: 0,
        description: "Cap on quirks created from tool errors per session.",
      }),
      number(["memory", "toolErrorCreateCooldownMs"], "Creation cooldown (ms)", {
        advanced: true,
        minimum: 0,
        description: "Minimum time between creations of the same error signature.",
      }),
      number(["memory", "toolErrorCreateMinScore"], "Creation min score", {
        advanced: true,
        minimum: 0,
        maximum: 1,
        step: 0.01,
        description: "Highest similarity at which an error still counts as having no matching quirk.",
      }),
      number(["memory", "toolErrorCreateLatencyBudgetMs"], "Creation latency budget (ms)", {
        advanced: true,
        minimum: 0,
        description: "Skip creation when the lookup takes longer than this.",
      }),
      boolean(["memory", "toolErrorInjectCreated"], "Inject created quirk", {
        advanced: true,
        description: "Inject a freshly created quirk into the next request so the lesson is visible immediately.",
      }),
      boolean(["memory", "toolErrorProactiveInject"], "Proactive tool gotchas", {
        advanced: true,
        description: "Warn about known tool gotchas before the tool is called.",
      }),
      number(["memory", "toolErrorProactiveMaxItems"], "Max proactive gotchas", {
        advanced: true,
        minimum: 0,
        description: "Maximum proactive gotchas injected per prompt.",
      }),
      boolean(["memory", "interceptAllErrors"], "Intercept all failures", {
        advanced: true,
        description: "Also treat failures reported inside successful tool output (non-zero exit code, stack traces) as errors.",
      }),
      boolean(["memory", "autoCreateOnInterceptedError"], "Create from intercepted failures", {
        advanced: true,
        description: "Create quirks from those intercepted failures too, not just from remembered ones.",
      }),
      boolean(["memory", "decay", "enabled"], "Confidence decay", {
        advanced: true,
        description: "Slowly reduce quirk confidence over time so stale knowledge fades away.",
      }),
      number(["memory", "decay", "halfLifeDays"], "Decay half-life (days)", {
        advanced: true,
        minimum: 1,
        description: "Days after which a quirk's confidence halves.",
      }),
    ],
  },
  {
    id: "documentationMode",
    label: "Documentation Mode",
    description: "Agent mode that adds doc comments to undocumented code.",
    fields: [
      boolean(["documentationMode", "enabled"], "Documentation mode enabled", {
        description: "Turn the agent into a documentation maintainer that adds doc comments to undocumented code.",
      }),
      boolean(["documentationMode", "autoStart"], "Start automatically", {
        description: "Start documentation mode automatically in new sessions.",
      }),
      number(["documentationMode", "batchSize"], "Files per batch", {
        minimum: 1,
        description: "Files processed per documentation pass.",
      }),
      string(["documentationMode", "systemPrompt"], "System prompt", {
        advanced: true,
        multiline: true,
        description: "Instruction that defines the documentation behaviour. Edit it to change style and scope.",
      }),
    ],
  },
  {
    id: "wikiMode",
    label: "Wiki Mode",
    description: "Agent instruction that maintains a knowledge wiki.",
    fields: [
      boolean(["wikiMode", "enabled"], "Wiki mode enabled", {
        description: "Turn the agent into a wiki maintainer that keeps a structured knowledge wiki under .opencode/wiki.",
      }),
      string(["wikiMode", "systemPrompt"], "System prompt", {
        advanced: true,
        multiline: true,
        description: "Instruction that defines the wiki layout and operations. Edit it to change the workflow.",
      }),
    ],
  },
  {
    id: "mcp",
    label: "MCP Server",
    description: "Standalone Model Context Protocol server.",
    fields: [
      boolean(["mcp", "enabled"], "Auto-start MCP server", {
        impact: "restart",
        description: "Run the standalone MCP server at startup so other MCP clients can use the RAG tools.",
      }),
    ],
  },
  {
    id: "setup",
    label: "Workspace Setup",
    description: "Scaffolding behaviour for repositories without a config.",
    fields: [
      boolean(["setup", "autoScaffold"], "Auto-scaffold new workspaces", {
        advanced: true,
        description: "Create config, skills, and AGENTS.md snippets automatically in workspaces that have none.",
      }),
    ],
  },
  {
    id: "autoUpdate",
    label: "Auto Update",
    description: "Update checks and optional automatic installs.",
    fields: [
      boolean(["autoUpdate", "enabled"], "Check for updates", {
        description: "Check npm for newer plugin versions.",
      }),
      boolean(["autoUpdate", "autoInstall"], "Install updates automatically", {
        advanced: true,
        description: "Install newer versions automatically when one is found.",
      }),
      number(["autoUpdate", "cooldownMs"], "Retry cooldown (ms)", {
        advanced: true,
        minimum: 0,
        description: "Minimum time between update checks.",
      }),
      number(["autoUpdate", "maxConsecutiveFailures"], "Max consecutive failures", {
        advanced: true,
        minimum: 1,
        description: "Disable automatic installs after this many failed attempts in a row.",
      }),
    ],
  },
  {
    id: "ui",
    label: "Web UI",
    description: "This dashboard's own server settings.",
    fields: [
      number(["ui", "port"], "Port", {
        minimum: 1,
        maximum: 65535,
        impact: "restart",
        description: "HTTP port of this dashboard. Changing it requires a restart.",
      }),
      boolean(["ui", "openBrowser"], "Open browser on start", {
        impact: "restart",
        description: "Open the dashboard in the default browser when the server starts.",
      }),
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
      string(["tui", "settingsKeybinding"], "Open settings", {
        impact: "restart",
        description: "Key chord that opens the RAG settings dialog in the OpenCode terminal UI.",
      }),
      string(["tui", "fileListKeybinding"], "Add file list", {
        impact: "restart",
        description: "Key chord that inserts the indexed file list into the prompt.",
      }),
      string(["tui", "chunksKeybinding"], "Add chunks", {
        impact: "restart",
        description: "Key chord that inserts the chunk overview into the prompt.",
      }),
    ],
  },
  {
    id: "logging",
    label: "Logging",
    description: "Plugin log verbosity and destination.",
    fields: [
      enumField(["logging", "level"], "Level", ["debug", "info", "error", "none"], {
        description: "Log verbosity: debug = everything, info = normal operation, error = failures only, none = silent.",
      }),
      string(["logging", "logFilePath"], "Log file path", {
        advanced: true,
        description: "Where the plugin writes its log. Relative paths resolve against the workspace.",
      }),
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
