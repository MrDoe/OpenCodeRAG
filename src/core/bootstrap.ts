/**
 * @fileoverview Bootstraps the full RAG pipeline context: loads config, resolves API keys,
 * creates embedder, vector store, keyword index, and description provider.
 */

import path from "node:path";
import { loadConfig, findConfigFile, resolveLogConfig, DEFAULT_CONFIG, type RagConfig } from "./config.js";
import { resolveApiKey } from "./resolve-api-key.js";
import { loadChunkersFromConfig } from "../chunker/loader.js";
import { createEmbedder, probeEmbeddingDimension } from "../embedder/factory.js";
import { createDescriptionProvider } from "../describer/factory.js";
import { createVectorStore } from "../vectorstore/factory.js";
import { readStoreDimension } from "../vectorstore/lancedb.js";
import { KeywordIndex } from "../retriever/keyword-index.js";
import type {
  EmbeddingProvider,
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
  /** Detected embedding dimension. */
  dimension: number;
  /** Resolved path to the debug log file. */
  logFilePath: string;
  /** Resolved path to the config file, or undefined when built-in defaults are used. */
  configPath?: string;
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
  configured?: number,
): Promise<number> {
  if (configured && configured > 0) {
    return configured;
  }

  if (!skipProbe) {
    const probe = await probeEmbeddingDimension(embedder);
    if (probe.dimension !== undefined) {
      return probe.dimension;
    }
    const storeDimension = await readStoreDimension(storePath);
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

  return (await readStoreDimension(storePath)) ?? 384;
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

  if (opts.configPath) {
    configPath = path.resolve(workDir, opts.configPath);
  } else {
    configPath = findConfigFile(workDir);
  }

  let cfg: RagConfig;
  if (configPath) {
    cfg = loadConfig(configPath);
    resolveApiKey(cfg, workDir);
    await loadChunkersFromConfig(cfg, path.dirname(configPath));
  } else {
    // Deep-clone so resolveApiKey (below) cannot mutate the shared
    // DEFAULT_CONFIG singleton.
    cfg = structuredClone(DEFAULT_CONFIG);
    resolveApiKey(cfg, workDir);
  }

  const logFilePath = path.resolve(
    workDir,
    resolveLogConfig(cfg).logFilePath,
  );

  const embedder = createEmbedder(cfg);
  const storePath = path.resolve(workDir, cfg.vectorStore.path);
  const dimension = await resolveDimension(
    embedder,
    storePath,
    opts.skipProbe ?? false,
    cfg.embedding.vectorDimension,
  );

  // Warn (but do not block) when the existing store schema disagrees with the
  // resolved dimension: the next index pass rebuilds automatically, and search
  // callers would otherwise see only cryptic LanceDB errors.
  const storeDimension = await readStoreDimension(storePath);
  if (storeDimension !== undefined && storeDimension !== dimension) {
    console.warn(
      `[bootstrap] Store was built with vector dimension ${storeDimension} but the current embedder produces ${dimension} — ` +
      "run 'opencode-rag index' to rebuild the index with the current model.",
    );
  }

  const store = createVectorStore(cfg, storePath, dimension);
  const keywordIndex = opts.skipKeywordIndex
    ? new KeywordIndex(storePath)
    : await loadKeywordIndex(storePath);

  const descriptionConfig = cfg.description;
  const descriptionProvider =
    descriptionConfig?.enabled
      ? createDescriptionProvider(descriptionConfig)
      : undefined;

  return {
    config: cfg,
    embedder,
    store,
    storePath,
    keywordIndex,
    descriptionProvider,
    dimension,
    logFilePath,
    configPath,
  };
}
