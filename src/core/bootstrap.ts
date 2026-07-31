/**
 * @fileoverview Bootstraps the full RAG pipeline context: loads config, resolves API keys,
 * creates embedder, vector store, keyword index, and description provider.
 */

import path from "node:path";
import { loadConfig, findConfigFile, resolveLogConfig, DEFAULT_CONFIG, type RagConfig } from "./config.js";
import { resolveApiKey } from "./resolve-api-key.js";
import { loadChunkersFromConfig } from "../chunker/loader.js";
import { createEmbedder } from "../embedder/factory.js";
import { createDescriptionProvider } from "../describer/factory.js";
import { createVectorStore } from "../vectorstore/factory.js";
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
}

/** Probe the embedding provider to determine the vector dimension. Falls back to 384 on failure. */
async function probeDimension(embedder: EmbeddingProvider): Promise<number> {
  try {
    const probe = await embedder.embed(["dimension-probe"], "query");
    if (probe && probe[0] && probe[0].length > 0 && typeof probe[0][0] === "number") {
      return (probe[0] as number[]).length;
    }
  } catch {
    // fallback to 384
  }
  // A wrong dimension is only discovered later as cryptic LanceDB errors —
  // surface the fallback loudly so misconfigured providers are easy to spot.
  console.warn(
    "[bootstrap] Could not probe embedding dimension — falling back to 384. " +
    "If indexing later fails with dimension errors, set embedding.vectorDimension explicitly.",
  );
  return 384;
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
  const dimension = opts.skipProbe ? 384 : await probeDimension(embedder);
  const storePath = path.resolve(workDir, cfg.vectorStore.path);
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
  };
}
