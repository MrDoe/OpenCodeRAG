/**
 * @fileoverview OpenCode plugin entry point.
 *
 * Dual export shape so one package serves both OpenCode generations:
 * - OpenCode V2 (server API): default export `Plugin.define({ id, setup })` —
 *   `setup(ctx)` registers the RAG tools/hooks through the V2 context adapter.
 * - OpenCode V1 (≥1.18.29): the same default export carries `server` — the
 *   legacy `(input, options) => Hooks` factory.
 *
 * The V1 `ragPlugin` factory remains the single source of truth for RAG
 * logic (config, store, embedder, indexer, auto-update); see src/v2/v2-adapter.ts.
 */

import { Plugin } from "@opencode/plugin";
import { ragPlugin } from "./plugin.js";
import { registerRagPluginV2 } from "./v2/v2-adapter.js";

/** Unique identifier for the OpenCodeRAG plugin. */
export const id = "opencode-rag-plugin";

/** V1 plugin factory — retained for OpenCode V1 compatibility. */
export const server = ragPlugin;

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
 * it returns the object unchanged); the extra `server` member keeps the
 * object valid as a V1 entrypoint (`{ id, server }`).
 */
const definition: Record<string, unknown> = { id, setup, server };
export default Plugin.define(definition as never);