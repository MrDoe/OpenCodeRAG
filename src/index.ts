/**
 * @fileoverview Main package entry point. Re-exports all public API symbols:
 * low-level building blocks (chunkers, embedders, vector stores, retrieval),
 * high-level convenience API (search, index, getContext), and plugin entry.
 */

export { chunkFile, getChunker, registerChunker } from "./chunker/factory.js";
export { createEmbedder, embedBatch } from "./embedder/factory.js";
export { createDescriptionProvider } from "./describer/factory.js";
export { createVectorStore } from "./vectorstore/factory.js";
export { LanceDbStore } from "./vectorstore/lancedb.js";
export { InMemoryVectorStore } from "./vectorstore/memory.js";
export { retrieve } from "./retriever/retriever.js";
export { optimizeContext, DEFAULT_CONTEXT_OPTIMIZATION } from "./retriever/context-optimizer.js";
export { loadConfig, DEFAULT_CONFIG } from "./core/config.js";
export { createBackgroundIndexer } from "./watcher.js";
export { createWatchIgnore } from "./indexer.js";
export { ImageChunker, createImageVisionProvider, getMimeType, SUPPORTED_IMAGE_EXTENSIONS } from "./chunker/image.js";
export { DescriptionCache } from "./core/desc-cache.js";
export type { RagConfig, DescriptionConfig, ImageDescriptionConfig } from "./core/config.js";
export type { Chunk, SearchResult, OptimizedSearchResult, Chunker, DescriptionProvider, EmbeddingProvider, VectorStore } from "./core/interfaces.js";
export type { ContextOptimizationConfig, ContextOptimizationOptions } from "./retriever/context-optimizer.js";

/**
 * High-level convenience API — search, index, and retrieve context in a single function call.
 * @module
 */
export { search, indexWorkspace, getContext, validateConfig, scanWorkspace, getIndexStatusSummary } from "./api.js";
export type { SearchOptions, IndexOptions, ContextResult, ConfigValidationResult, WorkspaceFile, IndexRunStats } from "./api.js";

/** Version check and self-update API. */
export { checkForUpdate, getCurrentVersion, installLatestUpdate, compareVersions } from "./core/version-check.js";
export type { UpdateInfo, InstallUpdateResult } from "./core/version-check.js";

/** Plugin entry — only importable inside OpenCode's runtime. */
import { ragPlugin } from "./plugin.js";

/** The plugin server configuration object, used to register OpenCodeRAG as an OpenCode plugin. */
export const server = ragPlugin;

/** Unique identifier for the OpenCodeRAG plugin. */
export const id = "opencode-rag-plugin";

/** Default export conforming to OpenCode's plugin module signature. */
export default { id, server: ragPlugin };
