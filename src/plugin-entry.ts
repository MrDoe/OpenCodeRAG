/**
 * @fileoverview OpenCode plugin entry point.
 *
 * OpenCode V2 entrypoint: default export `Plugin.define({ id, setup })` —
 * `setup(ctx)` registers the RAG tools/hooks through the V2 context adapter
 * and returns a cleanup function for plugin unload. OpenCode 1.x support has
 * been dropped (v2.0.0); the V1 `ragPlugin` factory remains the single source
 * of truth for RAG logic (config, store, embedder, indexer, auto-update) and is
 * re-registered as V2 transforms/hooks by src/v2/v2-adapter.ts.
 */

import { Plugin } from "@opencode/plugin";
import { registerRagPluginV2 } from "./v2/v2-adapter.js";

/** Unique identifier for the OpenCodeRAG plugin. */
export const id = "opencode-rag-plugin";

/**
 * V2 `setup`: run the V1 factory for this location and re-register the
 * returned hooks as V2 transforms/hooks. Returns a cleanup function for
 * plugin unload.
 */
async function setup(ctx: Plugin.Context): Promise<() => Promise<void>> {
  return registerRagPluginV2(ctx);
}

/**
 * Default export. `Plugin.define` is the documented V2 entrypoint (identity —
 * it returns the object unchanged).
 */
const definition: Record<string, unknown> = { id, setup };
export default Plugin.define(definition as never);
