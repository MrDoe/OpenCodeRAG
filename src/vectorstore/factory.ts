/**
 * @fileoverview Factory function to create the configured VectorStore instance
 * (LanceDB, in-memory, or ClickHouse).
 */
import type { VectorStore } from "../core/interfaces.js";
import type { RagConfig } from "../core/config.js";
import { LanceDbStore } from "./lancedb.js";
import { InMemoryVectorStore } from "./memory.js";
import { ClickHouseStore, resolveClickHouseOptions } from "./clickhouse.js";

/**
 * Create a VectorStore instance based on the configured provider.
 *
 * Supported providers:
 * - `"lancedb"`: Persistent LanceDB-backed store (default).
 * - `"memory"`: Ephemeral in-memory store.
 * - `"clickhouse"`: Central ClickHouse-backed store; `storePath` is only a
 *   local cache directory for workspace state.
 *
 * @param config - The RAG configuration containing the vector store provider setting.
 * @param storePath - The filesystem path for persistent local stores (LanceDB)
 *   and for the disposable state cache when ClickHouse is active.
 * @param dimension - The embedding vector dimension.
 * @param workspaceDir - Workspace root, used to derive the default ClickHouse
 *   namespace. Defaults to `process.cwd()`.
 * @returns A VectorStore instance matching the configured provider.
 * @throws If the provider name is unknown.
 */
export function createVectorStore(
  config: RagConfig,
  storePath: string,
  dimension: number,
  workspaceDir: string = process.cwd(),
): VectorStore {
  const provider = config.vectorStore.provider ?? "lancedb";

  if (provider === "lancedb") {
    return new LanceDbStore(storePath, dimension);
  }

  if (provider === "memory") {
    return new InMemoryVectorStore();
  }

  if (provider === "clickhouse") {
    return new ClickHouseStore(resolveClickHouseOptions(config, workspaceDir), dimension);
  }

  throw new Error(`Unknown vector store provider: ${provider}`);
}
