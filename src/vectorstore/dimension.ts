/**
 * @fileoverview Backend-neutral dimension probe.
 *
 * The pipeline needs the dimension of an existing store before it can decide
 * whether to rebuild. LanceDB keeps it in the table schema; ClickHouse keeps
 * it in the project's `_meta` state row. Both probes are read-only.
 */
import type { RagConfig } from "../core/config.js";
import { readStoreDimension } from "./lancedb.js";
import { ClickHouseStore, resolveClickHouseOptions } from "./clickhouse.js";

/**
 * Read the embedding dimension of the configured store.
 *
 * @param config - Resolved RAG configuration.
 * @param storePath - Local store directory (LanceDB only).
 * @param workspaceDir - Workspace root (used to derive the ClickHouse namespace).
 * @returns The stored dimension, or undefined when the store does not exist yet.
 */
export async function readConfiguredStoreDimension(
  config: RagConfig,
  storePath: string,
  workspaceDir: string,
): Promise<number | undefined> {
  const provider = config.vectorStore.provider ?? "lancedb";
  if (provider === "lancedb") {
    return readStoreDimension(storePath);
  }
  if (provider === "clickhouse") {
    return readClickHouseDimension(config, workspaceDir);
  }
  return undefined;
}

/** Read the dimension from a ClickHouse store without creating any schema. */
export async function readClickHouseDimension(
  config: RagConfig,
  workspaceDir: string,
): Promise<number | undefined> {
  const options = resolveClickHouseOptions(config, workspaceDir);
  const store = new ClickHouseStore(options, config.embedding.vectorDimension ?? 384);
  try {
    return await store.peekDimension();
  } catch (err) {
    console.warn(`[bootstrap] Could not read ClickHouse store dimension: ${(err as Error).message}`);
    return undefined;
  } finally {
    await store.close().catch(() => {});
  }
}
