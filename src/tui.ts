/**
 * @fileoverview OpenCode TUI (Terminal UI) plugin: renders a sidebar with RAG status,
 * settings dialog for editing config values, and model selection picker.
 */

import type { JSX } from "@opentui/solid";
import { createElement, insert, setProp } from "@opentui/solid";
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Provider } from "@opencode-ai/sdk/v2";
import { loadRuntimeOverrides, saveRuntimeOverride } from "./core/runtime-overrides.js";
import { PROVIDER_DEFAULTS } from "./core/provider-defaults.js";
import { loadConfig, updateConfigValue } from "./core/config.js";
import { setPendingRagInjection } from "./core/rag-injection-flag.js";

/**
 * Lazy CommonJS require — this file is ESM ("type": "module"), so a bare
 * `require()` throws ReferenceError. Used by `readTokenStats` to keep
 * `./eval/storage.js` out of the TUI startup path (same pattern as
 * `src/eval/token-counter.ts`).
 */
const _require = createRequire(import.meta.url);

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
  tuiConfig?: { fileListKeybinding: string; chunksKeybinding: string; settingsKeybinding: string },
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
  const settingsKey = tuiConfig?.settingsKeybinding ?? "ctrl+shift+r";

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
      text({ fg: theme.textMuted }, [`${formatKeybinding(settingsKey)} → Settings`]),
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
  updateConfigValue(configPath, [section, "provider"], ragProvider);
  saveRuntimeOverride(storePath, [section, "model"], modelId);
  updateConfigValue(configPath, [section, "model"], modelId);
  if (baseUrl) {
    saveRuntimeOverride(storePath, [section, "baseUrl"], baseUrl);
    updateConfigValue(configPath, [section, "baseUrl"], baseUrl);
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
          label: "Manual recall min score",
          type: "number",
          currentValue: (memoryRo.recallMinScore as number) ?? (memoryCfg.recallMinScore as number) ?? 0.72,
        },
        {
          path: ["memory", "autoInjectMinScore"],
          label: "Auto-inject min score",
          type: "number",
          currentValue: (memoryRo.autoInjectMinScore as number) ?? (memoryCfg.autoInjectMinScore as number) ?? 0.75,
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
          path: ["tui", "settingsKeybinding"],
          label: "Open settings",
          type: "string",
          currentValue: (tuiRo.settingsKeybinding as string) ?? (tuiCfg.settingsKeybinding as string) ?? "ctrl+shift+r",
        },
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

// ── OpenCode V2 setup ─────────────────────────────────────────────

/**
 * Structural subset of the OpenCode V2 TUI plugin context
 * (`@opencode/plugin/tui`). Declared locally so this module compiles
 * without depending on V2 type resolution; see `src/v2/v2-adapter.ts`
 * for the server-side equivalent.
 */
type V2TuiContext = {
  location?: { directory?: string } | undefined;
  app?: { version?: string } | undefined;
  theme?: unknown;
  renderer?: unknown;
  data?: {
    provider?: { list?: () => readonly unknown[] | undefined };
    model?: { list?: () => readonly unknown[] | undefined };
  } | undefined;
  ui?: {
    slot: (claim: {
      append: string;
      render: (input: { sessionID?: string }) => JSX.Element;
    }) => () => void;
    dialog: {
      select: <Value>(options: {
        title: string;
        placeholder?: string;
        options: readonly { title: string; value: Value; description?: string }[];
      }) => Promise<Value | undefined>;
      prompt: (options: {
        title: string;
        placeholder?: string;
        value?: string;
      }) => Promise<string | undefined>;
      clear: () => void;
    };
    toast: { show: (options: { title?: string; message: string; variant?: string }) => void };
  } | undefined;
  keymap?: {
    layer: (input: () => {
      mode?: string;
      priority?: number;
      commands: readonly {
        id: string;
        title?: string;
        bind?: string;
        run: (input?: string) => void;
      }[];
      bindings: readonly string[];
    }) => void;
    dispatch: (id: string, input?: string) => void;
  } | undefined;
};

/** Map a V2 ResolvedTheme onto the legacy `{accent,text,textMuted}` shape `renderSidebar` expects. */
function v2Theme(theme: unknown): { accent: unknown; text: unknown; textMuted: unknown } {
  const t = theme as Record<string, any> | undefined;
  return {
    accent: t?.accent ?? t?.primary?.base ?? t?.primary ?? t?.border?.accent ?? "#7c9aff",
    text: t?.text?.base ?? t?.text ?? t?.foreground ?? "#cdd6f4",
    textMuted: t?.text?.muted ?? t?.text?.dim ?? t?.muted ?? t?.subtle ?? "#6c7086",
  };
}

/** Translate a V1 keybinding string (`ctrl+enter`) to V2 key syntax (`ctrl+return`). */
function v2Bind(key: string): string {
  return key.replace(/\benter\b/g, "return");
}

/** Read token usage statistics from eval session logs (shared by the V2 path). */
function readTokenStats(
  worktree: string,
): { inputTokens: number; ragCtxTokens: number; reads: number; ragTools: number; queries: number } | undefined {
  try {
    const configPath = getConfigPath(worktree);
    if (!configPath) return undefined;
    const cfg = loadConfig(configPath);
    const vs = cfg.vectorStore as Record<string, unknown> | undefined;
    const storeRelPath = (vs?.path as string) ?? ".opencode/rag_db";
    const storePath = resolve(worktree, storeRelPath);
    const { listSessions } = _require("./eval/storage.js") as typeof import("./eval/storage.js");
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

/** Rebuild legacy sdk `Provider` shapes (model picker / base URL / API key) from V2 data domains. */
function v2LegacyProviders(context: V2TuiContext): readonly Provider[] {
  try {
    const providers = (context.data?.provider?.list?.() ?? []) as {
      id?: string;
      name?: string;
      settings?: { baseURL?: string };
      options?: { baseURL?: string; apiKey?: string };
    }[];
    const models = (context.data?.model?.list?.() ?? []) as {
      providerID?: string;
      modelID?: string;
      id?: string;
      name?: string;
    }[];
    return providers.map((p) => {
      const id = String(p.id ?? "");
      const modelMap: Record<string, { name?: string }> = {};
      for (const m of models) {
        if ((m.providerID ?? "") !== id) continue;
        const modelId = String(m.modelID ?? m.id ?? "");
        if (modelId) modelMap[modelId] = { name: m.name };
      }
      return {
        id,
        name: p.name ?? id,
        models: modelMap,
        options: { baseURL: p.settings?.baseURL ?? p.options?.baseURL, apiKey: p.options?.apiKey },
      } as unknown as Provider;
    });
  } catch {
    return [];
  }
}

/**
 * V2 settings dialog — promise-based port of {@link openSettingsDialog}
 * (category menu → setting menu → value editors) onto `context.ui.dialog`.
 */
async function openSettingsDialogV2(
  context: V2TuiContext,
  worktree: string,
  providers: readonly Provider[],
  onSettingsChanged?: () => void,
): Promise<void> {
  const ui = context.ui;
  if (!ui) return;
  const { dialog, toast } = ui;
  const settingsToast = (variant: string, message: string) => toast.show({ variant, title: "Settings", message });

  const configPath = getConfigPath(worktree);
  if (!configPath) {
    settingsToast("error", "No config file found");
    return;
  }
  const cfgRaw = readJsonFile(configPath);
  if (!cfgRaw) {
    settingsToast("error", "Cannot read config");
    return;
  }
  const cfg: Record<string, unknown> = cfgRaw;
  const vs = cfg.vectorStore as Record<string, unknown> | undefined;
  const storeRelPath = (vs?.path as string) ?? ".opencode/rag_db";
  const storePath = resolve(worktree, storeRelPath);

  const refreshCats = (): SettingCategory[] =>
    buildSettingCategories(cfg, loadRuntimeOverrides(storePath) as unknown as Record<string, unknown>, providers);
  const warnReindex = (path: string[]): void => {
    if (path[0] === "indexing" || path[0] === "chunking") settingsToast("warning", "Chunking changed. Re-index required.");
  };

  categoryLoop: for (;;) {
    const cats = refreshCats();
    const catId = await dialog.select<string>({
      title: "OpenCodeRAG Settings",
      placeholder: "Select a category",
      options: [
        ...cats.map((c) => ({ title: c.label, value: c.id, description: c.description })),
        { title: "Done", value: "__done__", description: "Close settings" },
      ],
    });
    if (!catId || catId === "__done__") return;
    const cat = cats.find((c) => c.id === catId);
    if (!cat) continue;

    settingLoop: for (;;) {
      // Rebuild so toggled values reflect immediately (matches the V1 dialog).
      const fresh = refreshCats().find((c) => c.id === cat.id) ?? cat;
      const picked = await dialog.select<string>({
        title: fresh.label,
        placeholder: "Select a setting",
        options: [
          ...fresh.entries.map((s) => ({
            title: `${s.label}: ${s.type === "boolean" ? (s.currentValue ? "Yes" : "No") : s.type === "json" ? JSON.stringify(s.currentValue) : String(s.currentValue)}`,
            value: s.path.join("."),
            description: s.options ? "Select to open model picker" : s.type === "boolean" ? "Select to toggle" : "Select to edit",
          })),
          { title: "\u2190 Back", value: "__back__", description: "Return to categories" },
        ],
      });
      if (!picked || picked === "__back__") continue categoryLoop;
      const entry = fresh.entries.find((s) => s.path.join(".") === picked);
      if (!entry) continue;

      if (entry.options) {
        const modelPick = await dialog.select<string>({
          title: `Select ${entry.label}`,
          placeholder: "Search models\u2026",
          options: entry.options,
        });
        if (!modelPick) continue;
        let value = modelPick;
        if (modelPick === "__custom__") {
          const custom = await dialog.prompt({
            title: `Custom ${entry.label}`,
            placeholder: "e.g. ollama/my-model or openai/custom-model",
            value: typeof entry.currentValue === "string" ? entry.currentValue : "",
          });
          if (custom === undefined) continue;
          value = custom;
        }
        const saved = saveModelSelection(storePath, configPath, value, entry.path, providers);
        if (saved) {
          entry.currentValue = saved;
          settingsToast("success", `${entry.label}: ${saved}`);
          if (entry.path[0] === "embedding") {
            settingsToast("warning", "Embedding changed. Re-index may be required. Restart OpenCode for changes.");
          }
        } else if (value) {
          saveRuntimeOverride(storePath, entry.path, value);
          updateConfigValue(configPath, entry.path, value);
          entry.currentValue = value;
        }
        onSettingsChanged?.();
        continue;
      }

      if (entry.type === "boolean") {
        const newVal = !entry.currentValue;
        saveRuntimeOverride(storePath, entry.path, newVal);
        updateConfigValue(configPath, entry.path, newVal);
        settingsToast("success", `${entry.label}: ${newVal ? "Yes" : "No"}`);
        warnReindex(entry.path);
        if (entry.path.join(".") === "openCode.autoIndex.enabled") {
          syncWatcherStatusFile(storePath, newVal);
          settingsToast("warning", "Watcher changes take effect after an OpenCode restart");
        }
        entry.currentValue = newVal;
        onSettingsChanged?.();
        continue;
      }

      const raw = await dialog.prompt({
        title: `Edit ${entry.label}`,
        placeholder: entry.type === "json" ? "JSON" : "Enter new value",
        value: entry.type === "json" ? JSON.stringify(entry.currentValue, null, 2) : String(entry.currentValue),
      });
      if (raw === undefined) continue;
      if (entry.type === "number") {
        const num = parseFloat(raw);
        if (isNaN(num)) {
          settingsToast("error", "Enter a valid number");
          continue;
        }
        saveRuntimeOverride(storePath, entry.path, num);
        updateConfigValue(configPath, entry.path, num);
        settingsToast("success", `${entry.label}: ${num}`);
        warnReindex(entry.path);
        entry.currentValue = num;
        onSettingsChanged?.();
      } else if (entry.type === "json") {
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            settingsToast("error", "Value must be a JSON object");
            continue;
          }
          saveRuntimeOverride(storePath, entry.path, parsed as Record<string, unknown>);
          updateConfigValue(configPath, entry.path, parsed);
          settingsToast("success", `${entry.label}: updated`);
          warnReindex(entry.path);
          entry.currentValue = parsed as Record<string, unknown>;
          onSettingsChanged?.();
        } catch {
          settingsToast("error", "Invalid JSON");
        }
      } else {
        saveRuntimeOverride(storePath, entry.path, raw);
        updateConfigValue(configPath, entry.path, raw);
        settingsToast("success", `${entry.label}: ${raw}`);
        entry.currentValue = raw;
        onSettingsChanged?.();
      }
    }
  }
}

/**
 * OpenCode V2 entrypoint — satisfies the V2 default-export schema
 * (`{id, setup}`), which the server-role loader validates (OpenCode ≥ 2.x
 * rejects `{id, tui}`-only modules with `err_*` "Plugin must export a default
 * definition with an id and an effect or setup function").
 *
 * The server role calls this with a server context (no `ui`/`keymap`) → no-op.
 * The TUI role calls it with the V2 TUI context → registers the sidebar slot,
 * keybindings, and the settings dialog. Returns a cleanup that unclaims the slot.
 */
async function setup(context: V2TuiContext): Promise<(() => void) | undefined> {
  const ui = context.ui;
  const keymap = context.keymap;
  if (!ui?.slot || !keymap) return undefined; // server-role load: nothing to register

  const version = context.app?.version ?? getVersion();
  const worktree = context.location?.directory;
  let cachedStatus: RagStatus = DEFAULT_STATUS;
  let lastRefresh = 0;
  const REFRESH_INTERVAL_MS = Number(process.env.OPENCODE_RAG_TUI_REFRESH_MS) || 30000;

  let tuiConfig: { fileListKeybinding: string; chunksKeybinding: string; settingsKeybinding: string } | undefined;
  const tuiConfigPath = worktree ? getConfigPath(worktree) : undefined;
  if (tuiConfigPath) {
    try {
      tuiConfig = loadConfig(tuiConfigPath).tui;
    } catch {
      // use defaults
    }
  }

  /** Refresh the cached RAG status from disk. */
  function refreshStatus(): void {
    if (worktree) {
      cachedStatus = loadRagStatus(worktree);
      lastRefresh = Date.now();
    }
  }
  refreshStatus();

  // Register sidebar slot (V2 slot tree; the V1 prompt slots are unnecessary
  // here — not claiming them leaves the host's default prompt intact).
  const unclaimSidebar = ui.slot({
    append: "sidebar.content",
    render: () => {
      if (Date.now() - lastRefresh > REFRESH_INTERVAL_MS) refreshStatus();
      const tokenStats = worktree ? readTokenStats(worktree) : undefined;
      return renderSidebar(v2Theme(context.theme), version, cachedStatus, tuiConfig, tokenStats);
    },
  });

  // Compute storePath for flag-based IPC with the server plugin.
  let flagStorePath: string | undefined;
  if (worktree) {
    try {
      const flagConfigPath = getConfigPath(worktree);
      if (flagConfigPath) {
        const flagCfg = loadConfig(flagConfigPath);
        const vs = flagCfg.vectorStore as Record<string, unknown> | undefined;
        const storeRelPath = (vs?.path as string) ?? ".opencode/rag_db";
        flagStorePath = resolve(worktree, storeRelPath);
      }
    } catch {
      // ignore
    }
  }

  const settingsKey = tuiConfig?.settingsKeybinding ?? "ctrl+shift+r";
  const fileListKey = tuiConfig?.fileListKeybinding ?? "ctrl+enter";
  const chunksKey = tuiConfig?.chunksKeybinding ?? "ctrl+alt+enter";
  try {
    keymap.layer(() => ({
      mode: "global",
      priority: 1000,
      commands: [
        {
          id: "opencode-rag:settings",
          title: "OpenCodeRAG Settings",
          bind: v2Bind(settingsKey),
          run: () => {
            if (worktree) {
              void openSettingsDialogV2(context, worktree, v2LegacyProviders(context), () => refreshStatus());
            }
          },
        },
        {
          id: "opencode-rag:show-file-list",
          title: "Add File List",
          bind: v2Bind(fileListKey),
          run: () => {
            if (flagStorePath) {
              setPendingRagInjection(flagStorePath, "files");
              setTimeout(() => keymap.dispatch("prompt.submit"), 0);
            }
          },
        },
        {
          id: "opencode-rag:add-chunks",
          title: "Add RAG Chunks",
          bind: v2Bind(chunksKey),
          run: () => {
            if (flagStorePath) {
              setPendingRagInjection(flagStorePath, "chunks");
              setTimeout(() => keymap.dispatch("prompt.submit"), 0);
            }
          },
        },
      ],
      bindings: ["opencode-rag:settings", "opencode-rag:show-file-list", "opencode-rag:add-chunks"],
    }));
  } catch {
    // Keymap registration failure must never break the sidebar slot.
  }

  return () => {
    try {
      unclaimSidebar();
    } catch {
      // ignore
    }
  };
}

// ── Plugin export ──────────────────────────────────────────────────

/**
 * The OpenCodeRAG TUI plugin module.
 * Registers sidebar panels, keybindings, and the settings dialog with OpenCode's
 * terminal UI framework.
 */
const plugin = {
  id: `${PLUGIN_NAME}:tui`,
  /** V2 entrypoint (schema `{id, setup}`); no-op under the server role, TUI registration under the TUI role. */
  setup,
};

export default plugin;
