/**
 * @fileoverview Bootstraps the full RAG pipeline context: loads config, resolves API keys,
 * creates embedder, vector store, keyword index, and description provider.
 */

import path from "node:path";
import { loadConfig, loadWorkspaceConfig, resolveConfigPaths, resolveLogConfig, type RagConfig } from "./config.js";
import { resolveApiKey } from "./resolve-api-key.js";
import { loadChunkersFromConfig } from "../chunker/loader.js";
import { createEmbedder, probeEmbeddingDimension } from "../embedder/factory.js";
import { createDescriptionProvider } from "../describer/factory.js";
import { createVectorStore } from "../vectorstore/factory.js";
import { getRerankerFor } from "../reranker/factory.js";
import { readConfiguredStoreDimension } from "../vectorstore/dimension.js";
import { loadRuntimeOverrides, applyRuntimeOverrides } from "./runtime-overrides.js";
import { StateSync } from "./state-sync.js";
import { KeywordIndex } from "../retriever/keyword-index.js";
import { reconcileQuirks } from "../quirks/quirk-store.js";
import type {
  EmbeddingProvider,
  RerankProvider,
  VectorStore,
  KeywordIndex as IKeywordIndex,
  DescriptionProvider,
} from "./interfaces.js";

/** Options for bootstrapping the RAG pipeline context. */
export interface BootstrapOptions {
  /** Working directory for resolving config and store paths. Defaults to process.cwd(). */
  cwd?: string;
  /** Explicit path to the config file. Auto-detected if omitted. */
  configPath?: string;
  /** If true, throw if no description provider is available. */
  requireDescriptionProvider?: boolean;
  /** Skip the embedding dimension probe — use default 384 instead. Safe for read-only commands like `status` that don't need the store. */
  skipProbe?: boolean;
  /** Skip loading the keyword index from disk. Safe for read-only commands that only need store metadata. */
  skipKeywordIndex?: boolean;
}

/** Resolved runtime context with all pipeline components wired together. */
export interface RagContext {
  /** Fully resolved pipeline configuration. */
  config: RagConfig;
  /** Configured embedding provider. */
  embedder: EmbeddingProvider;
  /** Configured vector store. */
  store: VectorStore;
  /** Resolved path to the vector store directory. */
  storePath: string;
  /** Loaded keyword index for hybrid search. */
  keywordIndex: IKeywordIndex;
  /** Optional LLM-based description provider. */
  descriptionProvider?: DescriptionProvider;
  /** Cross-encoder reranker for the retrieval stage (undefined when disabled). */
  reranker?: RerankProvider;
  /** Detected embedding dimension. */
  dimension: number;
  /** Resolved path to the debug log file. */
  logFilePath: string;
  /** Resolved path to the config file, or undefined when built-in defaults are used. */
  configPath?: string;
  /**
   * Durable-state synchronizer. For ClickHouse this hydrates the local cache
   * from `state_<namespace>` and flushes changes back; for LanceDB it is a
   * no-op, so the local directory stays the source of truth.
   */
  stateSync?: StateSync;
}

/**
 * Resolve the embedding dimension for the store.
 *
 * Precedence: an explicit `embedding.vectorDimension` in the config wins (it
 * is persisted after the first successful probe), then a live probe of the
 * provider, then the dimension of an existing store table, then the 384
 * fallback. The old behavior always probed and fell back to 384 — which
 * silently created 384-dimensional stores whenever the provider was down,
 * even though the config declared the real dimension.
 *
 * @param embedder - Configured embedding provider (probed only when needed).
 * @param storePath - Vector store path, used to read an existing schema.
 * @param skipProbe - When true, never call the provider (read-only commands).
 * @returns The resolved dimension.
 */
async function resolveDimension(
  embedder: EmbeddingProvider,
  storePath: string,
  skipProbe: boolean,
  configured: number | undefined,
  config: RagConfig,
  workspaceDir: string,
): Promise<number> {
  if (configured && configured > 0) {
    return configured;
  }

  if (!skipProbe) {
    const probe = await probeEmbeddingDimension(embedder);
    if (probe.dimension !== undefined) {
      return probe.dimension;
    }
    const storeDimension = await readConfiguredStoreDimension(config, storePath, workspaceDir);
    if (storeDimension !== undefined) {
      console.warn(
        `[bootstrap] Could not probe embedding dimension (${probe.error?.message ?? "unknown error"}) — ` +
        `using the existing store's dimension ${storeDimension}.`,
      );
      return storeDimension;
    }
    console.warn(
      `[bootstrap] Could not probe embedding dimension (${probe.error?.message ?? "unknown error"}) — ` +
      "falling back to 384. Set embedding.vectorDimension explicitly if the provider produces a different size.",
    );
    return 384;
  }

  return (await readConfiguredStoreDimension(config, storePath, workspaceDir)) ?? 384;
}

/** Load the keyword index from disk, or create a new empty one if loading fails. */
async function loadKeywordIndex(storePath: string): Promise<IKeywordIndex> {
  try {
    const idx = await KeywordIndex.load(storePath);
    return idx;
  } catch {
    return new KeywordIndex(storePath);
  }
}

/** Bootstrap the full RAG pipeline context: load config, resolve API keys, create embedder, vector store, keyword index, and description provider. */
export async function resolveRagContext(
  opts: BootstrapOptions = {}
): Promise<RagContext> {
  const workDir = opts.cwd ?? process.cwd();
  let configPath: string | undefined;

  let cfg: RagConfig;
  if (opts.configPath) {
    configPath = path.resolve(workDir, opts.configPath);
    cfg = loadConfig(configPath);
    resolveApiKey(cfg, workDir);
    await loadChunkersFromConfig(cfg, path.dirname(configPath));
  } else {
    // Defaults < global (~/.config/opencode/opencode-rag.json) < workspace.
    const paths = resolveConfigPaths(workDir);
    configPath = paths.workspace;
    cfg = loadWorkspaceConfig(workDir);
    resolveApiKey(cfg, workDir);
    const baseDir = paths.workspace
      ? path.dirname(paths.workspace)
      : paths.global
        ? path.dirname(paths.global)
        : undefined;
    if (baseDir) await loadChunkersFromConfig(cfg, baseDir);
  }

  const logFilePath = path.resolve(
    workDir,
    resolveLogConfig(cfg).logFilePath,
  );

  // Apply runtime overrides (the store's runtime-overrides.json) BEFORE
  // building the embedder/store, exactly like the plugin does at startup.
  // Without this the CLI's effective config diverges from the plugin's:
  // `status` printed "off" while a live watcher ran, and `query` searched
  // with different retrieval settings than the agent's tools. vectorStore
  // has no override keys, so storePath is safe to resolve first.
  const storePath = path.resolve(workDir, cfg.vectorStore.path);
  try {
    const overrides = loadRuntimeOverrides(storePath);
    if (Object.keys(overrides).length > 0) {
      cfg = applyRuntimeOverrides(cfg, overrides);
      // Overrides can change embedding.baseUrl/provider — re-run the key
      // resolution in the same order the plugin uses (apply → resolve).
      resolveApiKey(cfg, workDir);
    }
  } catch {
    // Overrides are best-effort; a corrupt file must not break the CLI.
  }

  const embedder = createEmbedder(cfg);
  const dimension = await resolveDimension(
    embedder,
    storePath,
    opts.skipProbe ?? false,
    cfg.embedding.vectorDimension,
    cfg,
    workDir,
  );

  // Warn (but do not block) when the existing store schema disagrees with the
  // resolved dimension: the next index pass rebuilds automatically, and search
  // callers would otherwise see only cryptic backend errors.
  const storeDimension = await readConfiguredStoreDimension(cfg, storePath, workDir);
  if (storeDimension !== undefined && storeDimension !== dimension) {
    console.warn(
      `[bootstrap] Store was built with vector dimension ${storeDimension} but the current embedder produces ${dimension} — ` +
      "run 'opencode-rag index' to rebuild the index with the current model.",
    );
  }

  const store = createVectorStore(cfg, storePath, dimension, workDir);

  // Durable-state sync: no-op for LanceDB (the local directory is the source
  // of truth); for ClickHouse the local directory is a disposable cache that
  // is hydrated from `state_<namespace>` before anything reads it.
  const stateSync = new StateSync({ store, storePath, config: cfg });
  try {
    await stateSync.hydrate();
  } catch (err) {
    console.warn(`[bootstrap] State hydration failed: ${(err as Error).message}`);
  }

  const keywordIndex = opts.skipKeywordIndex
    ? new KeywordIndex(storePath)
    : await loadKeywordIndex(storePath);

  // Reconcile quirks.jsonl into the store + keyword index (best-effort).
  // Full rebuilds rebuild the table from workspace files only — the preserved
  // quirks.jsonl was never re-embedded, so recall would silently miss quirks
  // while `quirk list` still showed them. Skipped for read-only bootstraps
  // (skipProbe/skipKeywordIndex) — those must never write to the store.
  if (!(opts.skipProbe || opts.skipKeywordIndex)) {
    try {
      const rec = await reconcileQuirks({ embedder, store, keywordIndex, cfg, storePath });
      if (rec.restoredToStore > 0 || rec.removedOrphans > 0) {
        // Surface only store-level drift (the split-brain symptom). Keyword-index
        // healing is routine (addQuirk never persisted the index) and stays silent.
        console.warn(
          `[bootstrap] Quirk reconcile: restored ${rec.restoredToStore} to store, ` +
          `deduplicated ${rec.deduplicated}, ` +
          `removed ${rec.removedOrphans} orphans (keyword index: +${rec.addedToKeywordIndex})`,
        );
      }
    } catch (err) {
      console.warn(`[bootstrap] Quirk reconcile failed: ${(err as Error).message}`);
    }
  }

  const descriptionConfig = cfg.description;
  const descriptionProvider =
    descriptionConfig?.enabled
      ? createDescriptionProvider(descriptionConfig)
      : undefined;

  // Optional cross-encoder reranker (process-wide singleton per endpoint so
  // cooldown + score cache survive across retrievals). Null/disabled by default.
  const reranker = getRerankerFor(cfg.reranking) ?? undefined;

  return {
    config: cfg,
    embedder,
    store,
    storePath,
    keywordIndex,
    descriptionProvider,
    reranker,
    dimension,
    logFilePath,
    configPath,
    stateSync,
  };
}
