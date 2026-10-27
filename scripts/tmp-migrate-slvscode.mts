/**
 * One-off: migrate the SLVSCODE workspace RAG store to ClickHouse.
 *
 * Same embedding model/dimension (Qwen3-Embedding:8B @ 4096) as the other
 * migrated workspaces, so every LanceDB row (content, metadata, per-chunk +
 * image descriptions, embeddings) is copied directly — no re-embedding, no
 * LLM calls. Unlike the ClickSphere/starlimsvscode run, quirks are NOT yet in
 * ClickHouse here, so quirk chunks are copied too and quirks.jsonl is flushed
 * with the rest of the state bundle (manifest, keyword index, desc cache).
 *
 * After this script: run it prints the namespace and counts; the workspace
 * config then moves vectorStore.path to a fresh cache dir (rag_ch) and
 * rag_db stays untouched as the rollback backup.
 */
import fs from "node:fs";
import path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { Chunk } from "../src/core/interfaces.js";
import { loadWorkspaceConfig, type RagConfig } from "../src/core/config.js";
import { StateSync } from "../src/core/state-sync.js";
import { createVectorStore } from "../src/vectorstore/factory.js";
import { deriveNamespace } from "../src/vectorstore/clickhouse.js";

const WORKSPACE = "C:/Daten/SLVSCODE";

function rowToChunk(row: Record<string, unknown>): Chunk {
  let tags: string[] | undefined;
  try {
    tags = typeof row.tags === "string" && row.tags ? (JSON.parse(row.tags) as string[]) : undefined;
  } catch {
    tags = undefined;
  }
  const role = row.role;
  return {
    id: row.id as string,
    content: row.content as string,
    description: (row.description as string) ?? "",
    embedding: Array.from(row.embedding as Iterable<number>),
    metadata: {
      filePath: row.filePath as string,
      startLine: row.startLine as number,
      endLine: row.endLine as number,
      language: row.language as string,
      kind: (row.kind as string) || undefined,
      role: role === "source" || role === "test" || role === "doc" ? role : undefined,
      quirkType: (row.quirkType as string) || undefined,
      tags,
    },
  };
}

async function flushState(workspace: string, cfg: RagConfig, storePath: string): Promise<void> {
  const store = createVectorStore(cfg, storePath, cfg.embedding.vectorDimension ?? 4096, workspace);
  try {
    const sync = new StateSync({ store, storePath, config: cfg });
    await sync.flush([
      "manifest",
      "keyword-index",
      "quirks",
      "runtime-overrides",
      "doc-progress",
      ".desc-cache",
    ]);
  } finally {
    await store.close().catch(() => {});
  }
}

const cfg = loadWorkspaceConfig(WORKSPACE);
if (cfg.vectorStore.provider !== "clickhouse") {
  throw new Error(`provider resolved to "${cfg.vectorStore.provider}" — expected clickhouse`);
}
const storePath = path.resolve(WORKSPACE, cfg.vectorStore.path);
const dimension = cfg.embedding.vectorDimension ?? 4096;
const namespace = deriveNamespace(WORKSPACE);

const db = await lancedb.connect(path.join(WORKSPACE, ".opencode", "rag_db"));
const table = await db.openTable("chunks");
const rows = (await table.query().toArray()) as Record<string, unknown>[];
const chunks = rows.map(rowToChunk);
const quirkChunks = chunks.filter((chunk) => (chunk.metadata.kind ?? "") === "quirk");

const store = createVectorStore(cfg, storePath, dimension, WORKSPACE);
try {
  for (let index = 0; index < chunks.length; index += 500) {
    await store.addChunks(chunks.slice(index, index + 500), { dedup: false });
  }
  const files = await store.listFiles();
  await flushState(WORKSPACE, cfg, storePath);

  console.log(JSON.stringify({
    workspace: "SLVSCODE",
    namespace,
    dimension,
    copiedChunks: chunks.length,
    quirkChunks: quirkChunks.length,
    describedChunks: chunks.filter((chunk) => (chunk.description ?? "").length > 0).length,
    filesInStore: files.length,
    cacheDir: storePath,
  }));
} finally {
  await store.close().catch(() => {});
}
