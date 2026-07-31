/**
 * @fileoverview OpenCode TUI (Terminal UI) plugin: renders a sidebar with RAG status,
 * settings dialog for editing config values, and model selection picker.
 */

import type { TuiPluginModule, TuiDialogSelectProps, TuiDialogPromptProps, TuiToast, TuiState } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { createElement, insert, setProp } from "@opentui/solid";
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Provider } from "@opencode-ai/sdk/v2";
import { loadRuntimeOverrides, saveRuntimeOverride } from "./core/runtime-overrides.js";
import { PROVIDER_DEFAULTS } from "./core/provider-defaults.js";
import { loadConfig } from "./core/config.js";
import { setPendingRagInjection } from "./core/rag-injection-flag.js";

/** Cached plugin version string from package.json. */
let _version: string | undefined;

/** Read the plugin version from package.json, caching the result. */
function getVersion(): string {
  if (_version !== undefined) return _version;
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
    _version = pkg.version ?? "dev";
  } catch {
    _version = "dev";
  }
  return _version!;
}

/** The running state of the background file watcher. */
type WatcherState = {
  /** Whether the watcher is currently performing an index pass. */
  running: boolean;
  /** Timestamp of the last completed watcher run, or undefined. */
  lastRunAt: number | undefined;
  /** Whether the watcher is disabled (no status file — not started). */
  disabled?: boolean;
};

/** Aggregate status of the RAG index displayed in the sidebar. */
type RagStatus = {
  /** Total number of indexed chunks across all files. */
  chunkCount: number;
  /** Name of the embedding provider (e.g. "ollama", "openai"). */
  provider: string;
  /** Name of the embedding model. */
  model: string;
  /** Timestamp of the last indexing operation, or undefined. */
  lastIndexedAt: number | undefined;
  /** Whether the workspace has been indexed (chunkCount > 0). */
  indexed: boolean;
  /** Status of the background file watcher. */
  watcher: WatcherState;
};

/** Default status shown when no RAG index exists yet. */
const DEFAULT_STATUS: RagStatus = {
  chunkCount: 0,
  provider: "ollama",
  model: "",
  lastIndexedAt: undefined,
  indexed: false,
  watcher: { running: false, lastRunAt: undefined },
};

/** Load the watcher running state from the persisted status file. */
function loadWatcherStatus(storePath: string): WatcherState {
  const statusPath = join(storePath, "watcher-status.json");
  if (!existsSync(statusPath)) return { running: false, lastRunAt: undefined, disabled: true };
  try {
    const raw: Record<string, unknown> = JSON.parse(readFileSync(statusPath, "utf-8"));
    return {
      running: raw.running === true,
      lastRunAt: typeof raw.lastRunAt === "number" ? raw.lastRunAt : undefined,
    };
  } catch {
    return { running: false, lastRunAt: undefined, disabled: true };
  }
}

/**
 * Load the full RAG status for a workspace by reading its config and
 * vector store manifest.
 */
function loadRagStatus(worktree: string): RagStatus {
  const status = { ...DEFAULT_STATUS };

  for (const loc of ["opencode-rag.json", ".opencode/opencode-rag.json", ".opencode/rag.json"]) {
    const configPath = join(worktree, loc);
    if (!existsSync(configPath)) continue;
    try {
      const cfg: Record<string, unknown> = JSON.parse(readFileSync(configPath, "utf-8"));
      const embedding = cfg.embedding as Record<string, unknown> | undefined;
      if (embedding) {
        status.provider = (embedding.provider as string) ?? status.provider;
        status.model = (embedding.model as string) ?? status.model;
      }
      const vs = cfg.vectorStore as Record<string, unknown> | undefined;
      const storeRelPath = (vs?.path as string) ?? ".opencode/rag_db";
      const storePath = resolve(worktree, storeRelPath);

      const manifestPath = join(storePath, "manifest.json");
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
        const files = manifest.files as Record<string, { chunkCount?: number }> | undefined;
        if (files && typeof files === "object") {
          status.chunkCount = Object.values(files).reduce(
            (sum: number, entry) => sum + (entry.chunkCount ?? 0),
            0
          );
        }
        status.lastIndexedAt = manifest.lastIndexedAt as number | undefined;
        status.indexed = status.chunkCount > 0;
      }

      status.watcher = loadWatcherStatus(storePath);
      break;
    } catch {
      continue;
    }
  }

  return status;
}

/**
 * Format a timestamp as a human-friendly relative time string
 * (e.g. "just now", "5m ago", "2h ago", "3d ago").
 */
function formatRelativeTime(timestamp: number | undefined): string {
  if (timestamp === undefined) return "never";
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Format a keybinding string for display (e.g. "ctrl+enter" → "Ctrl+Enter").
 */
function formatKeybinding(key: string): string {
  return key
    .split("+")
    .map((k) => k.charAt(0).toUpperCase() + k.slice(1))
    .join("+");
}

/** A valid child node for the TUI element tree. */
type Child = JSX.Element | string | number | null | undefined | false;

const PLUGIN_NAME = "opencode-rag-plugin";

/**
 * Create a TUI element node with the given tag, props, and children.
 * Wraps the low-level @opentui/solid createElement/insert/setProp functions.
 */
function element(
  tag: string,
  props: Record<string, unknown>,
  children: Child[] = [],
): JSX.Element {
  const node = createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) setProp(node, key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    insert(node, child);
  }
  return node as unknown as JSX.Element;
}

/** Shorthand to create a `<text>` TUI element. */
function text(props: Record<string, unknown>, children: Child[] = []): JSX.Element {
  return element("text", props, children);
}

/** Shorthand to create a `<box>` TUI element. */
function box(props: Record<string, unknown>, children: Child[] = []): JSX.Element {
  return element("box", props, children);
}

/**
 * Render the RAG sidebar showing index status, watcher state, keybindings,
 * and optional token usage statistics.
 */
function renderSidebar(
  theme: { accent: unknown; text: unknown; textMuted: unknown },
  version: string,
  status: RagStatus,
  tuiConfig?: { fileListKeybinding: string; chunksKeybinding: string },
  tokenStats?: { inputTokens: number; ragCtxTokens: number; reads: number; ragTools: number; queries: number },
): JSX.Element {
  const statusLine = status.indexed
    ? `${status.chunkCount} chunks \u00B7 ${status.provider}/${status.model}`
    : "Not indexed";
  const timeLine = `Indexed ${formatRelativeTime(status.lastIndexedAt)}`;

  const { watcher } = status;
  const watcherLine = watcher.disabled
    ? "Watcher disabled"
    : watcher.running
    ? "Watcher running\u2026"
    : `Watcher idle \u00B7 last ${formatRelativeTime(watcher.lastRunAt)}`;

  const fileListKey = tuiConfig?.fileListKeybinding ?? "ctrl+enter";
  const chunksKey = tuiConfig?.chunksKeybinding ?? "ctrl+alt+enter";

  return box(
    {
      width: "100%",
      flexDirection: "column",
      border: { type: "single" },
      borderColor: theme.accent,
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 1,
      paddingRight: 1,
    },
    [
      box(
        {
          width: "100%",
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
        },
        [
          box({ paddingLeft: 1, paddingRight: 1, backgroundColor: theme.accent }, [
            text({ fg: "#000000" }, ["OpenCodeRAG"]),
          ]),
          text({ fg: theme.textMuted }, [`v${version}`]),
        ],
      ),
      text({ fg: theme.text }, [statusLine]),
      text({ fg: theme.textMuted }, [timeLine]),
      text({ fg: watcher.running ? theme.accent : theme.textMuted }, [watcherLine]),
      text({ fg: theme.textMuted }, ["Ctrl+Shift+R → Settings"]),
      text({ fg: theme.textMuted }, [`${formatKeybinding(fileListKey)} → Add File List`]),
      text({ fg: theme.textMuted }, [`${formatKeybinding(chunksKey)} → Add Chunks`]),
      ...(tokenStats && tokenStats.queries > 0 ? [
        text({ fg: theme.textMuted }, [""]),
        text({ fg: theme.accent }, ["Token Usage"]),
        text({ fg: theme.text }, [`  Queries: ${tokenStats.queries}`]),
        text({ fg: theme.text }, [`  Input: ${tokenStats.inputTokens.toLocaleString()} tok`]),
        text({ fg: theme.text }, [`  RAG ctx: ${tokenStats.ragCtxTokens.toLocaleString()} tok`]),
        text({ fg: theme.text }, [`  Reads: ${tokenStats.reads}  RAG: ${tokenStats.ragTools}`]),
      ] : []),
    ],
  );
}

// ── Settings dialog ────────────────────────────────────────────────

/** Resolve the path to the first existing RAG config file in the worktree. */
function getConfigPath(worktree: string): string | undefined {
  for (const loc of ["opencode-rag.json", ".opencode/opencode-rag.json", ".opencode/rag.json"]) {
    const p = join(worktree, loc);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Read and parse a JSON file, returning undefined on failure. */
function readJsonFile<T = Record<string, unknown>>(filePath: string): T | undefined {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return JSON.parse(stripped) as T;
  } catch {
    return undefined;
  }
}

/** A single editable setting entry in the TUI settings dialog. */
type SettingEntry = {
  /** Dot-delimited config path (e.g. ["retrieval", "topK"]). */
  path: string[];
  /** Human-readable label for the setting. */
  label: string;
  /** Data type of the setting value. */
  type: "boolean" | "number" | "string" | "json";
  /** Current effective value (merged from runtime overrides and file config). */
  currentValue: boolean | number | string | Record<string, unknown>;
  /** Optional list of selectable options (used for model pickers). */
  options?: { title: string; value: string; description?: string; category?: string }[];
};

/** A named category grouping related settings entries. */
type SettingCategory = {
  /** Unique category identifier. */
  id: string;
  /** Human-readable category name. */
  label: string;
  /** Short description of what this category controls. */
  description: string;
  /** Settings entries belonging to this category. */
  entries: SettingEntry[];
};

/**
 * Build a list of model selection options from the available OpenCode providers.
 * Each entry includes the provider name as a category for grouped display.
 * Appends a "Custom…" option at the end.
 */
function buildModelOptions(providers: readonly Provider[]): { title: string; value: string; description?: string; category?: string }[] {
  const options: { title: string; value: string; description?: string; category?: string }[] = [];
  for (const provider of providers) {
    if (!provider.models) continue;
    for (const [modelId, model] of Object.entries(provider.models)) {
      options.push({
        title: model.name ?? modelId,
        value: `${provider.id}/${modelId}`,
        description: provider.name,
        category: provider.name,
      });
    }
  }
  options.sort((a, b) => {
    if ((a.category ?? "") < (b.category ?? "")) return -1;
    if ((a.category ?? "") > (b.category ?? "")) return 1;
    return (a.title ?? "").localeCompare(b.title ?? "");
  });
  options.push({ title: "Custom\u2026", value: "__custom__", description: "Enter provider/model manually" });
  return options;
}

/** Map an OpenCode provider ID to the corresponding RAG provider name. */
function providerIdToRagProvider(providerId: string): string {
  if (providerId === "ollama") return "ollama";
  const defaults = PROVIDER_DEFAULTS[providerId];
  if (defaults) return providerId;
  return "openai";
}

/**
 * Resolve the API base URL for a provider, appending the "/api" suffix
 * for Ollama and using known defaults for other providers.
 */
function resolveProviderBaseUrl(provider: Provider): string {
  const baseUrl = (provider.options?.baseURL as string) ?? "";
  if (provider.id === "ollama") {
    const clean = baseUrl.replace(/\/+$/, "");
    return clean ? `${clean}/api` : PROVIDER_DEFAULTS.ollama!.defaultBaseUrl + "/api";
  }
  const defaults = PROVIDER_DEFAULTS[provider.id];
  return baseUrl || (defaults?.defaultBaseUrl ?? "https://api.openai.com/v1");
}

/**
 * Write a single config value at a dotted path into the opencode-rag.json file.
 * Creates intermediate objects as needed.
 */
function saveConfigValue(configPath: string, path: string[], value: unknown): void {
  try {
    let raw = readFileSync(configPath, "utf-8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const data: Record<string, unknown> = JSON.parse(raw);
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
  } catch {
  }
}

/**
 * Mirror the watcher status file that the server plugin maintains, so the
 * sidebar reflects a watcher toggle from the settings dialog immediately:
 * - enabled  → write the same initial status the background indexer writes on startup
 * - disabled → remove the file (same cleanup the plugin does when auto-index is off)
 */
function syncWatcherStatusFile(storePath: string, enabled: boolean): void {
  const statusPath = join(storePath, "watcher-status.json");
  try {
    if (enabled) {
      writeFileSync(statusPath, JSON.stringify({ running: false }, null, 2), "utf-8");
    } else if (existsSync(statusPath)) {
      unlinkSync(statusPath);
    }
  } catch {
    // best-effort mirror; the server plugin reconciles on its next load
  }
}

/**
 * Save a model selection to both runtime overrides and the config file.
 * Resolves the RAG provider name and API base URL automatically.
 *
 * @returns The composite "provider/model" string if saved, or undefined for custom.
 */
function saveModelSelection(
  storePath: string,
  configPath: string,
  selectionValue: string,
  path: string[],
  providers?: readonly Provider[]
): string | undefined {
  const section = path[0]!;
  if (selectionValue === "__custom__") return undefined;

  const parts = selectionValue.split("/");
  if (parts.length < 2) return undefined;

  const providerId = parts[0]!;
  const modelId = parts.slice(1).join("/");

  const provider = providers?.find((p) => p.id === providerId);
  const ragProvider = providerIdToRagProvider(providerId);
  const baseUrl = provider ? resolveProviderBaseUrl(provider) : "";

  saveRuntimeOverride(storePath, [section, "provider"], ragProvider);
  saveConfigValue(configPath, [section, "provider"], ragProvider);
  saveRuntimeOverride(storePath, [section, "model"], modelId);
  saveConfigValue(configPath, [section, "model"], modelId);
  if (baseUrl) {
    saveRuntimeOverride(storePath, [section, "baseUrl"], baseUrl);
    saveConfigValue(configPath, [section, "baseUrl"], baseUrl);
  }

  const apiKey = (provider?.options?.apiKey as string) ?? "";
  if (apiKey) {
    // Persist the key only in the store-dir overrides, never in the workspace
    // config file — `opencode-rag.json` is routinely committed to git.
    saveRuntimeOverride(storePath, [section, "apiKey"], apiKey);
  }

  return selectionValue;
}

/**
 * Build the full list of setting categories from config, runtime overrides,
 * and available providers. Each category contains editable entries used by
 * the TUI settings dialog.
 */
function buildSettingCategories(
  cfg: Record<string, unknown>,
  ro: Record<string, unknown>,
  providers?: readonly Provider[],
): SettingCategory[] {
  const retrievalCfg = (cfg.retrieval ?? {}) as Record<string, unknown>;
  const retrievalRo = (ro.retrieval ?? {}) as Record<string, unknown>;
  const retrievalHybridCfg = (retrievalCfg.hybridSearch ?? {}) as Record<string, unknown>;
  const retrievalHybridRo = (retrievalRo.hybridSearch ?? {}) as Record<string, unknown>;

  const openCodeCfg = (cfg.openCode ?? {}) as Record<string, unknown>;
  const openCodeRo = (ro.openCode ?? {}) as Record<string, unknown>;
  const aiCfg = (openCodeCfg.autoIndex ?? {}) as Record<string, unknown>;
  const aiRo = (openCodeRo.autoIndex ?? {}) as Record<string, unknown>;

  const descCfg = (cfg.description ?? {}) as Record<string, unknown>;
  const descRo = (ro.description ?? {}) as Record<string, unknown>;

  const docModeCfg = (cfg.documentationMode ?? {}) as Record<string, unknown>;
  const docModeRo = (ro.documentationMode ?? {}) as Record<string, unknown>;

  const wikiModeCfg = (cfg.wikiMode ?? {}) as Record<string, unknown>;
  const wikiModeRo = (ro.wikiMode ?? {}) as Record<string, unknown>;

  const memoryCfg = (cfg.memory ?? {}) as Record<string, unknown>;
  const memoryRo = (ro.memory ?? {}) as Record<string, unknown>;

  const embeddingCfg = (cfg.embedding ?? {}) as Record<string, unknown>;
  const embeddingRo = (ro.embedding ?? {}) as Record<string, unknown>;

  const tuiCfg = (cfg.tui ?? {}) as Record<string, unknown>;
  const tuiRo = (ro.tui ?? {}) as Record<string, unknown>;

  const indexingCfg = (cfg.indexing ?? {}) as Record<string, unknown>;
  const indexingRo = (ro.indexing ?? {}) as Record<string, unknown>;
  const chunkingCfg = (cfg.chunking ?? {}) as Record<string, unknown>;
  const chunkingRo = (ro.chunking ?? {}) as Record<string, unknown>;

  const modelOptions = providers ? buildModelOptions(providers) : undefined;

  function displayModel(roProvider: unknown, roModel: unknown, cfgProvider: unknown, cfgModel: unknown, defaultProvider: string, defaultModel: string): string {
    const p = (roProvider as string) ?? (cfgProvider as string) ?? defaultProvider;
    const m = (roModel as string) ?? (cfgModel as string) ?? defaultModel;
    return `${p}/${m}`;
  }

  return [
    {
      id: "retrieval",
      label: "Retrieval",
      description: "Configure the retrieval options",
      entries: [
        {
          path: ["retrieval", "topK"],
          label: "Top-K results",
          type: "number",
          currentValue: (retrievalRo.topK as number) ?? (retrievalCfg.topK as number) ?? 10,
        },
        {
          path: ["retrieval", "minScore"],
          label: "Min relevance score",
          type: "number",
          currentValue: (retrievalRo.minScore as number) ?? (retrievalCfg.minScore as number) ?? 0.5,
        },
        {
          path: ["retrieval", "hybridSearch", "enabled"],
          label: "Hybrid search",
          type: "boolean",
          currentValue: (retrievalHybridRo.enabled as boolean) ?? (retrievalHybridCfg.enabled as boolean) ?? true,
        },
        {
          path: ["retrieval", "hybridSearch", "keywordWeight"],
          label: "Keyword weight",
          type: "number",
          currentValue: (retrievalHybridRo.keywordWeight as number) ?? (retrievalHybridCfg.keywordWeight as number) ?? 0.4,
        },
      ],
    },
    {
      id: "autoindex",
      label: "Auto-Indexing",
      description: "Configure automatic indexing of your workspace",
      entries: [
        {
          path: ["openCode", "autoIndex", "enabled"],
          label: "Auto-index watcher",
          type: "boolean",
          currentValue: (aiRo.enabled as boolean) ?? (aiCfg.enabled as boolean) ?? false,
        },
        {
          path: ["openCode", "autoIndex", "debounceMs"],
          label: "Debounce (ms)",
          type: "number",
          currentValue: (aiRo.debounceMs as number) ?? (aiCfg.debounceMs as number) ?? 2000,
        },
        {
          path: ["openCode", "autoIndex", "watcher"],
          label: "Watcher backend",
          type: "string",
          options: [
            { title: "chokidar (FS events)", value: "chokidar", description: "Detect file changes via filesystem events (default)" },
            { title: "git (poll)", value: "git", description: "Poll `git diff-index HEAD` for working-tree changes" },
          ],
          currentValue: (aiRo.watcher as string) ?? (aiCfg.watcher as string) ?? "chokidar",
        },
      ],
    },
    {
      id: "chunking",
      label: "Chunking",
      description: "Configure how files are split into chunks",
      entries: [
        {
          path: ["indexing", "chunkOverlap"],
          label: "Chunk overlap (lines)",
          type: "number",
          currentValue: (indexingRo.chunkOverlap as number) ?? (indexingCfg.chunkOverlap as number) ?? 0,
        },
        {
          path: ["indexing", "maxSvgSizeBytes"],
          label: "Max SVG size (bytes)",
          type: "number",
          currentValue: (indexingRo.maxSvgSizeBytes as number) ?? (indexingCfg.maxSvgSizeBytes as number) ?? 1_048_576,
        },
        {
          path: ["chunking", "nodeTypes"],
          label: "Node types (JSON)",
          type: "json",
          currentValue: (chunkingRo.nodeTypes as Record<string, unknown>) ?? (chunkingCfg.nodeTypes as Record<string, unknown>) ?? {},
        },
      ],
    },
    {
      id: "embedding",
      label: "Embedding",
      description: "Configure the embedding model and provider",
      entries: [
        {
          path: ["embedding", "model"],
          label: "Model",
          type: "string",
          currentValue: displayModel(embeddingRo.provider, embeddingRo.model, embeddingCfg.provider, embeddingCfg.model, "ollama", "qwen2.5:3b:latest"),
          options: modelOptions,
        },
      ],
    },
    {
      id: "description",
      label: "LLM Descriptions",
      description: "Configure LLM-based chunk descriptions",
      entries: [
        {
          path: ["description", "enabled"],
          label: "LLM descriptions",
          type: "boolean",
          currentValue: (descRo.enabled as boolean) ?? (descCfg.enabled as boolean) ?? true,
        },
        {
          path: ["description", "model"],
          label: "Model",
          type: "string",
          currentValue: displayModel(descRo.provider, descRo.model, descCfg.provider, descCfg.model, "ollama", "qwen2.5:3b"),
          options: modelOptions,
        },
      ],
    },
    {
      id: "documentation",
      label: "Documentation Mode",
      description: "Configure automatic code documentation via JSDoc/TSDoc comment injection",
      entries: [
        {
          path: ["documentationMode", "enabled"],
          label: "Documentation mode",
          type: "boolean",
          currentValue: (docModeRo.enabled as boolean) ?? (docModeCfg.enabled as boolean) ?? false,
        },
        {
          path: ["documentationMode", "autoStart"],
          label: "Auto-start on session",
          type: "boolean",
          currentValue: (docModeRo.autoStart as boolean) ?? (docModeCfg.autoStart as boolean) ?? true,
        },
        {
          path: ["documentationMode", "batchSize"],
          label: "Files per batch",
          type: "number",
          currentValue: (docModeRo.batchSize as number) ?? (docModeCfg.batchSize as number) ?? 5,
        },
      ],
    },
    {
      id: "wiki",
      label: "Wiki Mode",
      description: "Configure the AI-maintained knowledge wiki that synthesizes codebase knowledge over time",
      entries: [
        {
          path: ["wikiMode", "enabled"],
          label: "Wiki mode",
          type: "boolean",
          currentValue: (wikiModeRo.enabled as boolean) ?? (wikiModeCfg.enabled as boolean) ?? false,
        },
      ],
    },
    {
      id: "memory",
      label: "Quirk Memory",
      description: "Configure experiential memory — gotchas, preferences, decisions recalled across sessions",
      entries: [
        {
          path: ["memory", "enabled"],
          label: "Quirk memory enabled",
          type: "boolean",
          currentValue: (memoryRo.enabled as boolean) ?? (memoryCfg.enabled as boolean) ?? true,
        },
        {
          path: ["memory", "autoInject"],
          label: "Auto-inject quirks",
          type: "boolean",
          currentValue: (memoryRo.autoInject as boolean) ?? (memoryCfg.autoInject as boolean) ?? false,
        },
        {
          path: ["memory", "recallMinScore"],
          label: "User prompt min score",
          type: "number",
          currentValue: (memoryRo.recallMinScore as number) ?? (memoryCfg.recallMinScore as number) ?? 0.72,
        },
        {
          path: ["memory", "autoInjectMinScore"],
          label: "System prompt min score",
          type: "number",
          currentValue: (memoryRo.autoInjectMinScore as number) ?? (memoryCfg.autoInjectMinScore as number) ?? 0.6,
        },
        {
          path: ["memory", "autoInjectLatencyBudgetMs"],
          label: "Latency budget (ms)",
          type: "number",
          currentValue: (memoryRo.autoInjectLatencyBudgetMs as number) ?? (memoryCfg.autoInjectLatencyBudgetMs as number) ?? 2000,
        },
        {
          path: ["memory", "minConfidence"],
          label: "Min confidence",
          type: "number",
          currentValue: (memoryRo.minConfidence as number) ?? (memoryCfg.minConfidence as number) ?? 0.5,
        },
        {
          path: ["memory", "passiveCapture"],
          label: "Passive capture",
          type: "boolean",
          currentValue: (memoryRo.passiveCapture as boolean) ?? (memoryCfg.passiveCapture as boolean) ?? false,
        },
        {
          path: ["memory", "promptEnforcement"],
          label: "Prompt enforcement",
          type: "boolean",
          currentValue: (memoryRo.promptEnforcement as boolean) ?? (memoryCfg.promptEnforcement as boolean) ?? true,
        },
        {
          path: ["memory", "sessionEndExtraction"],
          label: "Session-end extraction",
          type: "boolean",
          currentValue: (memoryRo.sessionEndExtraction as boolean) ?? (memoryCfg.sessionEndExtraction as boolean) ?? true,
        },
      ],
    },
    {
      id: "keybindings",
      label: "Keybindings",
      description: "Configure keyboard shortcuts",
      entries: [
        {
          path: ["tui", "fileListKeybinding"],
          label: "Add file list",
          type: "string",
          currentValue: (tuiRo.fileListKeybinding as string) ?? (tuiCfg.fileListKeybinding as string) ?? "ctrl+enter",
        },
        {
          path: ["tui", "chunksKeybinding"],
          label: "Add chunks",
          type: "string",
          currentValue: (tuiRo.chunksKeybinding as string) ?? (tuiCfg.chunksKeybinding as string) ?? "ctrl+alt+enter",
        },
      ],
    },
  ];
}

/**
 * Open the interactive settings dialog for OpenCodeRAG configuration.
 * Displays a cascading menu of categories → settings → value editors.
 */
async function openSettingsDialog(api: {
  ui: {
    dialog: { replace: (fn: () => JSX.Element, onClose?: () => void) => void; clear: () => void; };
    DialogSelect: <Value>(props: TuiDialogSelectProps<Value>) => JSX.Element;
    DialogPrompt: (props: TuiDialogPromptProps) => JSX.Element;
    toast: (input: TuiToast) => void;
  };
  state: Pick<TuiState, "path" | "provider">;
  /** Invoked after a setting is saved so the caller can refresh cached UI state. */
  onSettingsChanged?: () => void;
}): Promise<void> {
  const worktree = api.state.path.worktree;
  if (!worktree) return;

  const configPath = getConfigPath(worktree);
  if (!configPath) {
    api.ui.toast({ variant: "error", title: "Settings", message: "No config file found" });
    return;
  }

  const cfgRaw = readJsonFile(configPath);
  if (!cfgRaw) {
    api.ui.toast({ variant: "error", title: "Settings", message: "Cannot read config" });
    return;
  }

  const cfg: Record<string, unknown> = cfgRaw;
  const vs = cfg.vectorStore as Record<string, unknown> | undefined;
  const storeRelPath = (vs?.path as string) ?? ".opencode/rag_db";
  const storePath = resolve(worktree, storeRelPath);
  const providers = api.state.provider;

  function getCurrentOverrides(): Record<string, unknown> {
    return loadRuntimeOverrides(storePath) as unknown as Record<string, unknown>;
  }

  function showCategoryMenu(): void {
    const ro = getCurrentOverrides();
    const cats = buildSettingCategories(cfg, ro, providers);
    const options = [
      ...cats.map((c) => ({
        title: c.label,
        value: c.id,
        description: c.description,
      })),
      { title: "Done", value: "__done__", description: "Close settings" },
    ];

    api.ui.dialog.replace(
      () =>
        api.ui.DialogSelect({
          title: "OpenCodeRAG Settings",
          placeholder: "Select a category",
          options,
          onSelect: (option: { title: string; value: string }) => {
            if (option.value === "__done__") {
              api.ui.dialog.clear();
              return;
            }
            const cat = cats.find((c) => c.id === option.value);
            if (cat) showSettingMenu(cat);
          },
        }),
    );
  }

  function showSettingMenu(cat: SettingCategory): void {
    const options = [
      ...cat.entries.map((s) => ({
        title: `${s.label}: ${s.type === "boolean" ? (s.currentValue ? "Yes" : "No") : s.type === "json" ? JSON.stringify(s.currentValue) : String(s.currentValue)}`,
        value: s.path.join("."),
        description: s.options ? "Select to open model picker" : (s.type === "boolean" ? "Select to toggle" : "Select to edit"),
      })),
      { title: "\u2190 Back", value: "__back__", description: "Return to categories" },
    ];

    api.ui.dialog.replace(
      () =>
        api.ui.DialogSelect({
          title: cat.label,
          placeholder: "Select a setting",
          options,
          onSelect: (option: { title: string; value: string }) => {
            if (option.value === "__back__") {
              showCategoryMenu();
              return;
            }
            const entry = cat.entries.find((s) => s.path.join(".") === option.value);
            if (!entry) return;

            if (entry.options) {
              showModelPicker(entry, cat);
            } else if (entry.type === "boolean") {
              const newVal = !entry.currentValue;
              saveRuntimeOverride(storePath, entry.path, newVal);
              saveConfigValue(configPath!, entry.path, newVal);
              api.ui.toast({
                variant: "success",
                title: "Settings",
                message: `${entry.label}: ${newVal ? "Yes" : "No"}`,
              });
              if (entry.path[0] === "indexing" || entry.path[0] === "chunking") {
                api.ui.toast({ variant: "warning", title: "Settings", message: "Chunking changed. Re-index required." });
              }
              if (entry.path.join(".") === "openCode.autoIndex.enabled") {
                syncWatcherStatusFile(storePath, newVal);
                api.ui.toast({ variant: "warning", title: "Settings", message: "Watcher changes take effect after an OpenCode restart" });
              }
              entry.currentValue = newVal;
              api.onSettingsChanged?.();
              showSettingMenu(cat);
            } else if (entry.type === "number") {
              api.ui.dialog.replace(
                () =>
                  api.ui.DialogPrompt({
                    title: `Edit ${entry.label}`,
                    placeholder: "Enter new value",
                    value: String(entry.currentValue),
                    onConfirm: (input: string) => {
                      const num = parseFloat(input);
                      if (!isNaN(num)) {
                        saveRuntimeOverride(storePath, entry.path, num);
                        saveConfigValue(configPath!, entry.path, num);
                        api.ui.toast({
                          variant: "success",
                          title: "Settings",
                          message: `${entry.label}: ${num}`,
                        });
                        if (entry.path[0] === "indexing" || entry.path[0] === "chunking") {
                          api.ui.toast({ variant: "warning", title: "Settings", message: "Chunking changed. Re-index required." });
                        }
                        entry.currentValue = num;
                        api.onSettingsChanged?.();
                      }
                      showSettingMenu(cat);
                    },
                    onCancel: () => {
                      showSettingMenu(cat);
                    },
                  }),
              );
            } else if (entry.type === "json") {
              api.ui.dialog.replace(
                () =>
                  api.ui.DialogPrompt({
                    title: `Edit ${entry.label}`,
                    placeholder: "JSON",
                    value: JSON.stringify(entry.currentValue, null, 2),
                    onConfirm: (input: string) => {
                      try {
                        const parsed = JSON.parse(input);
                        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
                          api.ui.toast({ variant: "error", title: "Settings", message: "Value must be a JSON object" });
                          showSettingMenu(cat);
                          return;
                        }
                        saveRuntimeOverride(storePath, entry.path, parsed as Record<string, unknown>);
                        saveConfigValue(configPath!, entry.path, parsed);
                        api.ui.toast({
                          variant: "success",
                          title: "Settings",
                          message: `${entry.label}: updated`,
                        });
                        if (entry.path[0] === "indexing" || entry.path[0] === "chunking") {
                          api.ui.toast({ variant: "warning", title: "Settings", message: "Chunking changed. Re-index required." });
                        }
                        entry.currentValue = parsed as Record<string, unknown>;
                        api.onSettingsChanged?.();
                      } catch {
                        api.ui.toast({ variant: "error", title: "Settings", message: "Invalid JSON" });
                      }
                      showSettingMenu(cat);
                    },
                    onCancel: () => {
                      showSettingMenu(cat);
                    },
                  }),
              );
            } else {
              api.ui.dialog.replace(
                () =>
                  api.ui.DialogPrompt({
                    title: `Edit ${entry.label}`,
                    placeholder: "Enter new value",
                    value: String(entry.currentValue),
                    onConfirm: (input: string) => {
                      saveRuntimeOverride(storePath, entry.path, input);
                      saveConfigValue(configPath!, entry.path, input);
                      api.ui.toast({
                        variant: "success",
                        title: "Settings",
                        message: `${entry.label}: ${input}`,
                      });
                      entry.currentValue = input;
                      api.onSettingsChanged?.();
                      showSettingMenu(cat);
                    },
                    onCancel: () => {
                      showSettingMenu(cat);
                    },
                  }),
              );
            }
          },
        }),
    );
  }

  function showModelPicker(entry: SettingEntry, cat: SettingCategory): void {
    api.ui.dialog.replace(
      () =>
        api.ui.DialogSelect({
          title: `Select ${entry.label}`,
          placeholder: "Search models\u2026",
          options: entry.options ?? [],
          onSelect: (option: { title: string; value: string }) => {
            if (option.value === "__custom__") {
              api.ui.dialog.replace(
                () =>
                  api.ui.DialogPrompt({
                    title: `Custom ${entry.label}`,
                    placeholder: "e.g. ollama/my-model or openai/custom-model",
                    value: typeof entry.currentValue === "string" ? entry.currentValue : "",
                    onConfirm: (input: string) => {
                      const saved = saveModelSelection(storePath, configPath!, input, entry.path, providers);
                      if (saved) {
                        entry.currentValue = saved;
                      } else if (input) {
                        saveRuntimeOverride(storePath, entry.path, input);
                        saveConfigValue(configPath!, entry.path, input);
                        entry.currentValue = input;
                      }
                      api.onSettingsChanged?.();
                      showSettingMenu(cat);
                    },
                    onCancel: () => showSettingMenu(cat),
                  }),
              );
              return;
            }
            const saved = saveModelSelection(storePath, configPath!, option.value, entry.path, providers);
            if (saved) {
              entry.currentValue = saved;
              api.ui.toast({
                variant: "success",
                title: "Settings",
                message: `${entry.label}: ${saved}`,
              });
              const isEmbedding = entry.path[0] === "embedding";
              if (isEmbedding) {
                api.ui.toast({
                  variant: "warning",
                  title: "Settings",
                  message: "Embedding changed. Re-index may be required. Restart OpenCode for changes.",
                });
              }
              api.onSettingsChanged?.();
            }
            showSettingMenu(cat);
          },
        }),
    );
  }

  showCategoryMenu();
}

// ── Plugin export ──────────────────────────────────────────────────

/**
 * The OpenCodeRAG TUI plugin module.
 * Registers sidebar panels, keybindings, and the settings dialog with OpenCode's
 * terminal UI framework.
 */
const plugin: TuiPluginModule & { id: string } = {
  id: `${PLUGIN_NAME}:tui`,
  tui: async (api, _options, meta) => {
    const version = meta.version ?? getVersion();
    let cachedStatus: RagStatus = DEFAULT_STATUS;
    let lastRefresh = 0;
    const REFRESH_INTERVAL_MS = Number(process.env.OPENCODE_RAG_TUI_REFRESH_MS) || 30000;

    // Load tui config for keybinding display
    let tuiConfig: { fileListKeybinding: string; chunksKeybinding: string } | undefined;
    const worktree = api.state.path.worktree;
    if (worktree) {
      const configPath = getConfigPath(worktree);
      if (configPath) {
        try {
          const cfg = loadConfig(configPath);
          tuiConfig = cfg.tui;
        } catch {
          // use defaults
        }
      }
    }

    /** Refresh the cached RAG status from disk. */
    function refreshStatus() {
      const wt = api.state.path.worktree;
      if (wt) {
        cachedStatus = loadRagStatus(wt);
        lastRefresh = Date.now();
      }
    }

    refreshStatus();

    /** Load token usage statistics from eval session logs. */
    function loadTokenStats(): { inputTokens: number; ragCtxTokens: number; reads: number; ragTools: number; queries: number } | undefined {
      try {
        const wt = api.state.path.worktree;
        if (!wt) return undefined;
        const configPath = getConfigPath(wt);
        if (!configPath) return undefined;
        const cfg = loadConfig(configPath);
        const vs = cfg.vectorStore as Record<string, unknown> | undefined;
        const storeRelPath = (vs?.path as string) ?? ".opencode/rag_db";
        const storePath = resolve(wt, storeRelPath);
        const { listSessions } = require("./eval/storage.js") as typeof import("./eval/storage.js");
        const sessions = listSessions(storePath);
        if (sessions.length === 0) return undefined;
        const latest = sessions[0]!;
        return {
          inputTokens: latest.totalTokens.input,
          ragCtxTokens: latest.ragContextTokens,
          reads: Object.entries(latest.toolCallCounts).filter(([k]) => k === "read").reduce((s, [, v]) => s + v, 0),
          ragTools: latest.ragToolCalls,
          queries: latest.messageCount,
        };
      } catch {
        return undefined;
      }
    }

    // Register sidebar slot
    api.slots.register({
      order: 900,
      slots: {
        sidebar_content() {
          if (Date.now() - lastRefresh > REFRESH_INTERVAL_MS) {
            refreshStatus();
          }
          const tokenStats = loadTokenStats();
          return renderSidebar(api.theme.current, version, cachedStatus, tuiConfig, tokenStats);
        },
      },
    });

    // Register prompt slots — return null to let host render its default prompt.
    api.slots.register({
      order: 901,
      slots: {
        session_prompt() {
          return null;
        },
        home_prompt() {
          return null;
        },
      },
    });

    // Compute storePath for flag-based IPC with server plugin
    let flagStorePath: string | undefined;
    const worktreeForFlag = api.state.path.worktree;
    if (worktreeForFlag) {
      try {
        const flagConfigPath = getConfigPath(worktreeForFlag);
        if (flagConfigPath) {
          const flagCfg = loadConfig(flagConfigPath);
          const vs = flagCfg.vectorStore as Record<string, unknown> | undefined;
          const storeRelPath = (vs?.path as string) ?? ".opencode/rag_db";
          flagStorePath = resolve(worktreeForFlag, storeRelPath);
        }
      } catch {
        // ignore
      }
    }

    // Register keybinding for settings dialog
    try {
      api.keymap.registerLayer({
        bindings: [{ key: "ctrl+shift+r", cmd: "opencode-rag:settings" }],
        commands: [
          {
            name: "opencode-rag:settings",
            run: () => {
              openSettingsDialog({
                ui: api.ui,
                state: api.state,
                onSettingsChanged: () => {
                  refreshStatus();
                },
              });
              return undefined;
            },
          },
        ],
      });
    } catch (err) {
      // Keymap registration may fail in older OpenCode versions; silently skip
    }

    // Register keybinding for "Add File List" (configurable)
    try {
      const fileListKey = tuiConfig?.fileListKeybinding ?? "ctrl+enter";
      api.keymap.registerLayer({
        priority: 1000,
        bindings: [{ key: fileListKey, cmd: "opencode-rag:show-file-list" }],
        commands: [
          {
            name: "opencode-rag:show-file-list",
            run: () => {
              if (flagStorePath) {
                setPendingRagInjection(flagStorePath, "files");
                setTimeout(() => { api.keymap.dispatchCommand("prompt.submit"); }, 0);
              }
              return undefined;
            },
          },
        ],
      });
    } catch (err) {
      // Keymap registration may fail in older OpenCode versions; silently skip
    }

    // Register keybinding for "Add RAG Chunks" (configurable)
    try {
      const chunksKey = tuiConfig?.chunksKeybinding ?? "ctrl+alt+enter";
      api.keymap.registerLayer({
        priority: 1000,
        bindings: [{ key: chunksKey, cmd: "opencode-rag:add-chunks" }],
        commands: [
          {
            name: "opencode-rag:add-chunks",
            run: () => {
              if (flagStorePath) {
                setPendingRagInjection(flagStorePath, "chunks");
                setTimeout(() => { api.keymap.dispatchCommand("prompt.submit"); }, 0);
              }
              return undefined;
            },
          },
        ],
      });
    } catch (err) {
      // Keymap registration may fail in older OpenCode versions; silently skip
    }
  },
};

export default plugin;
