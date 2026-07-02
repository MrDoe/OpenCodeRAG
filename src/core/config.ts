/**
 * @fileoverview Configuration types and defaults for OpenCodeRAG. Defines RagConfig,
 * all sub-config interfaces, DEFAULT_CONFIG, validateConfig, and loadConfig.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { env } from "node:process";
import type { EmbeddingProvider, Chunker, VectorStore } from "./interfaces.js";

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
  /** Maximum chunks per batch request. */
  batchMaxChunks?: number;
  /** Timeout per batch request in milliseconds. */
  batchTimeoutMs?: number;
  /** Number of concurrent batch requests. */
  batchConcurrency?: number;
  /** Maximum retry attempts on failure. */
  retryMax?: number;
  /** Base delay in ms between retries (exponential backoff). */
  retryBaseDelayMs?: number;
  /** Whether to include chain-of-thought tokens in the response. */
  think?: boolean;
  /** Context window size for the LLM. */
  numCtx?: number;
  /** Maximum content characters sent to the LLM. Chunks exceeding this use fallback descriptions. */
  maxContentChars?: number;
}

/** Configuration for vision-model-based image description generation. */
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
  /** Proxy configuration. */
  proxy?: ProxyConfig;
  /** Maximum image dimension (pixels) — larger images are resized before sending. */
  resizeMaxDimension?: number;
}

/** Configuration for the built-in web dashboard UI. */
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

/** Configuration for the terminal UI (TUI) keybindings. */
export interface TuiConfig {
  /** Keybinding to toggle the file list panel. */
  fileListKeybinding: string;
  /** Keybinding to toggle the chunk viewer panel. */
  chunksKeybinding: string;
}

/** Configuration for MCP (Model Context Protocol) server integration. */
export interface McpConfig {
  /** Whether the MCP server is enabled. */
  enabled: boolean;
}

/** Configuration for automatic self-updates. */
export interface AutoUpdateConfig {
  /** Whether auto-update checking is enabled. */
  enabled: boolean;
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
  };
  /** Indexing pipeline controls: what to index, concurrency, batch sizes. */
  indexing: {
    /** File extensions to include in indexing. */
    includeExtensions: string[];
    /** Directory name patterns to exclude. */
    excludeDirs: string[];
    /** Specific filenames (basenames, case-insensitive) to exclude from indexing. */
    excludeFiles?: string[];
    /** Number of overlapping lines between adjacent chunks. */
    chunkOverlap: number;
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
     * Maximum file size in bytes for SVG/XML files before chunking is skipped.
     * Large SVGs can cause tree-sitter to hang. Set to 0 for no limit.
     * @default 1_048_576 (1 MB)
     */
    maxSvgSizeBytes?: number;
  };
  /** Vector storage backend configuration. */
  vectorStore: {
    /** Filesystem path or memory:// URI for the vector database. */
    path: string;
    /** Backend provider ("lancedb" or "memory"). */
    provider?: "lancedb" | "memory";
  };
  /** Retrieval settings for query-time search. */
  retrieval: {
    /** Default number of results to return. */
    topK: number;
    /** Minimum relevance score threshold (0-1). */
    minScore: number;
    /** Hybrid search (vector + keyword) configuration. */
    hybridSearch?: {
      /** Whether hybrid search is enabled. */
      enabled: boolean;
      /** Weight for keyword scores in fusion (0 = vector only, 1 = keyword only). */
      keywordWeight: number;
    };
    /** Context window optimization settings for post-retrieval quality filtering. */
    contextOptimization?: ContextOptimizationConfig;
  };
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
  };
  /** Custom chunker module registrations. */
  chunkers?: ChunkerConfig[];
  /** Per-language chunking overrides (e.g. node type filters). */
  chunking?: {
    /** Map of language to allowed/blocked AST node type patterns. */
    nodeTypes?: Record<string, string[]>;
  };
  /** LLM-based chunk description generation config. */
  description?: DescriptionConfig;
  /** Vision-model-based image description config. */
  imageDescription?: ImageDescriptionConfig;
  /** Automated documentation mode config. */
  documentationMode?: DocumentationModeConfig;
  /** MCP server integration config. */
  mcp?: McpConfig;
  /** Auto-update checking config. */
  autoUpdate?: AutoUpdateConfig;
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
    timeoutMs: 30000,
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
    ],
    excludeFiles: [
      "package-lock.json",
    ],
    chunkOverlap: 0,
    minFileSizeBytes: 0,
    concurrency: 8,
    embedBatchSize: 100,
    embedConcurrency: 6,
    ollamaMaxBatchSize: 4000,
    descriptionConcurrency: 4,
    maxSvgSizeBytes: 1_048_576,
  },
  vectorStore: {
    path: "./.opencode/rag_db",
    provider: "lancedb",
  },
  retrieval: {
    topK: 20,
    minScore: 0.35,
    hybridSearch: {
      enabled: true,
      keywordWeight: 0.4,
    },
    contextOptimization: {
      enabled: true,
      maxPerFile: 3,
      mergeAdjacent: true,
      adjacentGapThreshold: 5,
      similarityThreshold: 0.8,
    },
  },
  openCode: {
    enabled: true,
    maxContextChunks: 10,
    readOverride: true,
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
    prompt: "Describe this image 10-20 comma-separated keywords.",
    think: false,
    numCtx: 2048,
    resizeMaxDimension: 1024,
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
      "Describe this code in 10-20 comma-separated keywords.",
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
  mcp: {
    enabled: true,
  },
  autoUpdate: {
    enabled: false,
  },
  ui: {
    port: 3210,
    openBrowser: true,
  },
  tui: {
    fileListKeybinding: "ctrl+enter",
    chunksKeybinding: "ctrl+alt+enter",
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
    "embedding", "indexing", "vectorStore", "retrieval",
    "openCode", "chunkers", "chunking", "description",
    "imageDescription", "documentationMode", "mcp", "autoUpdate", "ui", "tui", "logging",
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
  }

  if (config.openCode.maxContextChunks <= 0) {
    warnings.push("openCode.maxContextChunks must be > 0");
  }

  if (config.openCode.autoIndex?.watcher && !["chokidar", "git"].includes(config.openCode.autoIndex.watcher)) {
    warnings.push(`openCode.autoIndex.watcher "${config.openCode.autoIndex.watcher}" — expected "chokidar" or "git"`);
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
  }

  if (config.imageDescription) {
    if (config.imageDescription.enabled) {
      if (config.imageDescription.timeoutMs <= 0) {
        warnings.push("imageDescription.timeoutMs must be > 0");
      }
    }
  }

  return { valid: warnings.length === 0, warnings };
}

/** Config file locations to search, in order of precedence. */
export const CONFIG_FILE_CANDIDATES = [
  "opencode-rag.json",
  ".opencode/opencode-rag.json",
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

/** Load and parse a JSON config file, deep-merge with defaults, optionally validate. */
export function loadConfig(filePath: string, validate: boolean = true): RagConfig {
  let raw: string;
  let parsed: Partial<RagConfig>;
  try {
    raw = readFileSync(filePath, "utf-8");
    parsed = JSON.parse(raw) as Partial<RagConfig>;
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
    vectorStore: {
      ...DEFAULT_CONFIG.vectorStore,
      ...parsed.vectorStore,
    },
    retrieval: {
      ...DEFAULT_CONFIG.retrieval,
      ...parsed.retrieval,
      hybridSearch: {
        ...DEFAULT_CONFIG.retrieval.hybridSearch,
        ...(safeObj<typeof DEFAULT_CONFIG.retrieval.hybridSearch>(
          (parsed.retrieval as Record<string, unknown> | undefined)?.hybridSearch
        ) ?? {}),
      } as { enabled: boolean; keywordWeight: number },
    },
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
      };
      return merged;
    })(),
    chunkers: parsed.chunkers ?? DEFAULT_CONFIG.chunkers,
    chunking: {
      nodeTypes: {
        ...((DEFAULT_CONFIG.chunking as Record<string, unknown>)?.nodeTypes as Record<string, string[]> | undefined ?? {}),
        ...((parsed.chunking as Record<string, unknown>)?.nodeTypes as Record<string, string[]> | undefined ?? {}),
      },
    },
    description: {
      ...DEFAULT_CONFIG.description,
      ...(safeObj<DescriptionConfig>((parsed as { description?: unknown }).description) ?? {}),
    } as DescriptionConfig,
    imageDescription: {
      ...DEFAULT_CONFIG.imageDescription,
      ...(safeObj<ImageDescriptionConfig>((parsed as { imageDescription?: unknown }).imageDescription) ?? {}),
    } as ImageDescriptionConfig,
    documentationMode: {
      ...DEFAULT_CONFIG.documentationMode,
      ...(safeObj<DocumentationModeConfig>((parsed as { documentationMode?: unknown }).documentationMode) ?? {}),
    } as DocumentationModeConfig,
    mcp: {
      ...DEFAULT_CONFIG.mcp,
      ...(safeObj<McpConfig>((parsed as { mcp?: unknown }).mcp) ?? {}),
    } as McpConfig,
    autoUpdate: {
      ...DEFAULT_CONFIG.autoUpdate,
      ...(safeObj<AutoUpdateConfig>((parsed as { autoUpdate?: unknown }).autoUpdate) ?? {}),
    } as AutoUpdateConfig,
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
