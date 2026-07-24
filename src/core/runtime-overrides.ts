/**
 * @fileoverview Live-configuration overrides that take precedence over the on-disk config file.
 * Supports per-key overrides stored as JSON, loaded at runtime.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RagConfig } from "./config.js";
import { DEFAULT_CONFIG } from "./config.js";

/** Live-configuration overrides that take precedence over the on-disk config file. */
export interface RuntimeOverrides {
  retrieval?: {
    topK?: number;
    minScore?: number;
    hybridSearch?: {
      enabled?: boolean;
      keywordWeight?: number;
    };
  };
  openCode?: {
    autoIndex?: {
      enabled?: boolean;
      debounceMs?: number;
      watcher?: string;
    };
    autoInject?: {
      enabled?: boolean;
      minScore?: number;
      maxChunks?: number;
      contentType?: string;
    };
  };
  embedding?: {
    provider?: string;
    model?: string;
    baseUrl?: string;
  };
  description?: {
    enabled?: boolean;
    provider?: string;
    model?: string;
    baseUrl?: string;
  };
  imageDescription?: {
    enabled?: boolean;
    model?: string;
    provider?: string;
  };
  memory?: {
    passiveCapture?: boolean;
    promptEnforcement?: boolean;
    sessionEndExtraction?: boolean;
    autoCaptureMaxPerTurn?: number;
    autoCaptureDedupThreshold?: number;
    autoInjectMinScore?: number;
    autoInjectLatencyBudgetMs?: number;
    autoInjectTopK?: number;
  };
  tui?: {
    fileListKeybinding?: string;
    chunksKeybinding?: string;
  };
}

/** Load runtime overrides from the store directory. Returns empty object if none exist. */
export function loadRuntimeOverrides(storePath: string): RuntimeOverrides {
  const overridePath = join(storePath, "runtime-overrides.json");
  if (!existsSync(overridePath)) return {};
  try {
    const raw = readFileSync(overridePath, "utf-8");
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return JSON.parse(stripped) as RuntimeOverrides;
  } catch {
    return {};
  }
}

/** Save a single runtime override value at a dotted path. Creates intermediate objects as needed. */
export function saveRuntimeOverride(
  storePath: string,
  path: string[],
  value: boolean | number | string | Record<string, unknown>
): void {
  const overridePath = join(storePath, "runtime-overrides.json");
  const overrides = loadRuntimeOverrides(storePath);

  let target: Record<string, unknown> = overrides as unknown as Record<string, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    if (!target[key] || typeof target[key] !== "object") {
      target[key] = {};
    }
    target = target[key] as Record<string, unknown>;
  }
  target[path[path.length - 1]!] = value;

  try {
    const dir = dirname(overridePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(overridePath, JSON.stringify(overrides, null, 2), "utf-8");
  } catch {
    // silently ignore write errors
  }
}

/** Deep-merge runtime overrides into a config object. Returns a new object without mutating the original. */
export function applyRuntimeOverrides(
  cfg: RagConfig,
  overrides: RuntimeOverrides
): RagConfig {
  if (!overrides || Object.keys(overrides).length === 0) return cfg;

  const merged: RagConfig = structuredClone(cfg);

  if (overrides.retrieval) {
    if (overrides.retrieval.topK !== undefined) merged.retrieval.topK = overrides.retrieval.topK;
    if (overrides.retrieval.minScore !== undefined) merged.retrieval.minScore = overrides.retrieval.minScore;
    if (overrides.retrieval.hybridSearch) {
      if (!merged.retrieval.hybridSearch) merged.retrieval.hybridSearch = { enabled: true, keywordWeight: 0.4 };
      if (overrides.retrieval.hybridSearch.enabled !== undefined) merged.retrieval.hybridSearch.enabled = overrides.retrieval.hybridSearch.enabled;
      if (overrides.retrieval.hybridSearch.keywordWeight !== undefined) merged.retrieval.hybridSearch.keywordWeight = overrides.retrieval.hybridSearch.keywordWeight;
    }
  }

  if (overrides.openCode) {
    if (overrides.openCode.autoIndex) {
      if (!merged.openCode.autoIndex) merged.openCode.autoIndex = { enabled: true, debounceMs: 2000, intervalMs: 300000, watcher: "chokidar" };
      if (overrides.openCode.autoIndex.enabled !== undefined) merged.openCode.autoIndex.enabled = overrides.openCode.autoIndex.enabled;
      if (overrides.openCode.autoIndex.debounceMs !== undefined) merged.openCode.autoIndex.debounceMs = overrides.openCode.autoIndex.debounceMs;
      if (overrides.openCode.autoIndex.watcher !== undefined) merged.openCode.autoIndex.watcher = overrides.openCode.autoIndex.watcher as "chokidar" | "git";
    }
  }

  if (overrides.embedding) {
    if (overrides.embedding.provider !== undefined) merged.embedding.provider = overrides.embedding.provider;
    if (overrides.embedding.model !== undefined) merged.embedding.model = overrides.embedding.model;
    if (overrides.embedding.baseUrl !== undefined) merged.embedding.baseUrl = overrides.embedding.baseUrl;
  }

  if (overrides.description) {
    const defaultDesc = DEFAULT_CONFIG.description!;
    if (overrides.description.enabled !== undefined) {
      if (!merged.description) merged.description = { ...defaultDesc };
      merged.description.enabled = overrides.description.enabled;
    }
    if (overrides.description.provider !== undefined) {
      if (!merged.description) merged.description = { ...defaultDesc };
      merged.description.provider = overrides.description.provider;
    }
    if (overrides.description.model !== undefined) {
      if (!merged.description) merged.description = { ...defaultDesc };
      merged.description.model = overrides.description.model;
    }
    if (overrides.description.baseUrl !== undefined) {
      if (!merged.description) merged.description = { ...defaultDesc };
      merged.description.baseUrl = overrides.description.baseUrl;
    }
  }

  if (overrides.imageDescription) {
    const defaultImg = DEFAULT_CONFIG.imageDescription!;
    if (overrides.imageDescription.enabled !== undefined) {
      if (!merged.imageDescription) merged.imageDescription = { ...defaultImg };
      merged.imageDescription.enabled = overrides.imageDescription.enabled;
    }
    if (overrides.imageDescription.provider !== undefined) {
      if (!merged.imageDescription) merged.imageDescription = { ...defaultImg };
      merged.imageDescription.provider = overrides.imageDescription.provider;
    }
    if (overrides.imageDescription.model !== undefined) {
      if (!merged.imageDescription) merged.imageDescription = { ...defaultImg };
      merged.imageDescription.model = overrides.imageDescription.model;
    }
  }

  if (overrides.memory) {
    if (!merged.memory) merged.memory = { ...DEFAULT_CONFIG.memory } as unknown as import("./config.js").MemoryConfig;
    const m: import("./config.js").MemoryConfig = merged.memory;
    if (overrides.memory.passiveCapture !== undefined) m.passiveCapture = overrides.memory.passiveCapture;
    if (overrides.memory.promptEnforcement !== undefined) m.promptEnforcement = overrides.memory.promptEnforcement;
    if (overrides.memory.sessionEndExtraction !== undefined) m.sessionEndExtraction = overrides.memory.sessionEndExtraction;
    if (overrides.memory.autoCaptureMaxPerTurn !== undefined) m.autoCaptureMaxPerTurn = overrides.memory.autoCaptureMaxPerTurn;
    if (overrides.memory.autoCaptureDedupThreshold !== undefined) m.autoCaptureDedupThreshold = overrides.memory.autoCaptureDedupThreshold;
    if (overrides.memory.autoInjectMinScore !== undefined) m.autoInjectMinScore = overrides.memory.autoInjectMinScore;
    if (overrides.memory.autoInjectLatencyBudgetMs !== undefined) m.autoInjectLatencyBudgetMs = overrides.memory.autoInjectLatencyBudgetMs;
    if (overrides.memory.autoInjectTopK !== undefined) m.autoInjectTopK = overrides.memory.autoInjectTopK;
  }

  if (overrides.tui) {
    merged.tui = {
      ...DEFAULT_CONFIG.tui,
      ...(merged.tui ?? {}),
      fileListKeybinding: overrides.tui.fileListKeybinding ?? merged.tui?.fileListKeybinding ?? DEFAULT_CONFIG.tui.fileListKeybinding,
      chunksKeybinding: overrides.tui.chunksKeybinding ?? merged.tui?.chunksKeybinding ?? DEFAULT_CONFIG.tui.chunksKeybinding,
    };
  }

  return merged;
}
