/**
 * @fileoverview Dynamic loading and registration of pluggable chunker modules from configuration.
 */
import { registerChunker, validateParserOverrides } from "./factory.js";
import type { RagConfig, ChunkerConfig } from "../core/config.js";
import { ImageChunker, SUPPORTED_IMAGE_EXTENSIONS } from "./image.js";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Dynamically import a single pluggable chunker module and register it.
 *
 * The module is resolved relative to `configDir`.  It must export a default
 * or named object with a `.chunk()` method conforming to {@link Chunker}.
 *
 * @param entry - Chunker configuration entry from `opencode-rag.json`.
 * @param configDir - Base directory for resolving relative module paths.
 */
async function loadSingleChunker(
  entry: ChunkerConfig,
  configDir: string
): Promise<void> {
  const resolved = path.resolve(configDir, entry.module);
  const moduleUrl = pathToFileURL(resolved).href;
  try {
    const mod = await import(moduleUrl);

    const chunker = mod.default ?? mod;
    if (typeof chunker.chunk !== "function") {
      console.warn(
        `[opencode-rag] Module "${entry.module}" does not export a valid Chunker (no .chunk() method) — skipping`
      );
      return;
    }

    registerChunker(chunker, entry.extensions);
  } catch (err) {
    console.warn(
      `[opencode-rag] Failed to load chunker module "${entry.module}":`,
      (err as Error).message
    );
  }
}

/**
 * Load and register all pluggable chunkers from the RAG configuration.
 *
 * If image description is enabled in the config, an {@link ImageChunker} is
 * registered first for all supported image extensions.  User-defined chunkers
 * listed in `config.chunkers` are then loaded and registered in order.
 *
 * @param config - The full RAG configuration object.
 * @param configDir - Base directory for resolving relative module paths in
 *   chunker config entries.
 */
export async function loadChunkersFromConfig(
  config: RagConfig,
  configDir: string
): Promise<void> {
  if (config.imageDescription?.enabled) {
    const chunker = new ImageChunker([...SUPPORTED_IMAGE_EXTENSIONS]);
    registerChunker(chunker, [...SUPPORTED_IMAGE_EXTENSIONS]);
  }

  if (config.chunkers && config.chunkers.length > 0) {
    for (const entry of config.chunkers) {
      await loadSingleChunker(entry, configDir);
    }
  }

  // Validate AFTER registration so overrides targeting a pluggable chunker's
  // language are recognized. (Known-parser lookup needs the full registry.)
  for (const warning of validateParserOverrides(config.chunking?.parsers)) {
    console.warn(`[opencode-rag] ${warning}`);
  }
}
