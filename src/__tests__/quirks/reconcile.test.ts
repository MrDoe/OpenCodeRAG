import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LanceDbStore } from "../../vectorstore/lancedb.js";
import { KeywordIndex } from "../../retriever/keyword-index.js";
import { addQuirk, listQuirks, reconcileQuirks, type QuirkReconcileDeps } from "../../quirks/quirk-store.js";
import type { EmbeddingProvider, Chunk } from "../../core/interfaces.js";
import type { RagConfig } from "../../core/config.js";
import type { QuirkStoreDeps } from "../../quirks/quirk-store.js";

const DIM = 8;

/** Embedder that counts invocations — reconcile must batch and must not embed
 *  for keyword-index-only healing. */
function makeEmbedder(): EmbeddingProvider & { calls: number } {
  return {
    name: "mock",
    calls: 0,
    async embed(texts: string[]): Promise<number[][]> {
      this.calls++;
      return texts.map(() => new Array(DIM).fill(0).map(() => Math.random() * 2 - 1));
    },
  };
}

const MINIMAL_CFG = {
  embedding: { provider: "mock", baseUrl: "", model: "mock", documentPrefix: "", queryPrefix: "" },
  indexing: { includeExtensions: [], excludeDirs: [], chunkOverlap: 0, concurrency: 1, embedBatchSize: 1 },
  retrieval: { topK: 10, minScore: 0, hybridSearch: { enabled: false, keywordWeight: 0 }, contextOptimization: { enabled: false, maxPerFile: 0, mergeAdjacent: false, adjacentGapThreshold: 0, similarityThreshold: 0 } },
  openCode: { enabled: false, maxContextChunks: 5 },
  tui: { fileListKeybinding: "", chunksKeybinding: "", settingsKeybinding: "" },
  logging: { level: "none" as const, logFilePath: "" },
  memory: { enabled: true, autoInject: false, minConfidence: 0.3, recallMinScore: 0, autoInjectMinScore: 0.6, autoInjectTopK: 2, autoInjectMinTokenOverlap: 1, autoInjectLatencyBudgetMs: 2000, decay: { enabled: false, halfLifeDays: 30 } },
} as unknown as RagConfig;

interface Env {
  dir: string;
  store: LanceDbStore;
  ki: KeywordIndex;
  embedder: ReturnType<typeof makeEmbedder>;
  deps: QuirkStoreDeps;
  reconcileDeps: QuirkReconcileDeps;
}

const dirs: string[] = [];

async function makeEnv(): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "rag-reconcile-"));
  dirs.push(dir);
  const store = new LanceDbStore(dir, DIM);
  const ki = new KeywordIndex(dir);
  const embedder = makeEmbedder();
  const deps: QuirkStoreDeps = { embedder, store, keywordIndex: ki, cfg: MINIMAL_CFG, storePath: dir };
  const reconcileDeps: QuirkReconcileDeps = { ...deps };
  return { dir, store, ki, embedder, deps, reconcileDeps };
}

/** A raw quirk chunk written straight to the store — simulates rows whose
 *  jsonl entry situation we control (in-flight add, legacy backup, wipe). */
function rawQuirkChunk(id: string, lastObserved: string): Chunk {
  return {
    id,
    content: `raw quirk ${id} for reconcile tests`,
    description: "",
    embedding: new Array(DIM).fill(0).map(() => Math.random() * 2 - 1),
    metadata: {
      filePath: `quirk:${id}`,
      startLine: 0,
      endLine: 0,
      language: "quirk",
      kind: "quirk",
      tags: [],
      confidence: 1,
      lastObserved,
    },
  } as unknown as Chunk;
}

describe("reconcileQuirks", () => {
  before(() => {
    // per-test temp dirs are created lazily by makeEnv()
  });

  after(() => {
    for (const dir of dirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it("restores jsonl quirks missing from the vector store (simulated rebuild wipe)", async () => {
    const env = await makeEnv();
    const a = await addQuirk(env.deps, { content: "reconcile alpha: quirk that a rebuild will drop" });
    const b = await addQuirk(env.deps, { content: "reconcile beta: second quirk that a rebuild will drop" });
    const fpA = `quirk:${a.id}`;
    const fpB = `quirk:${b.id}`;

    // Simulate swapStoreDirectories' effect on the table: quirks.jsonl survives,
    // the quirk chunks are gone.
    await env.store.deleteByFilePath(fpA);
    await env.store.deleteByFilePath(fpB);
    env.ki.removeByFilePath(fpA);
    env.ki.removeByFilePath(fpB);
    const callsBefore = env.embedder.calls;

    const rec = await reconcileQuirks(env.reconcileDeps);

    assert.equal(rec.restoredToStore, 2);
    assert.equal(rec.addedToKeywordIndex, 2);
    assert.equal(rec.removedOrphans, 0);
    // One batched embed call for both missing quirks.
    assert.equal(env.embedder.calls, callsBefore + 1);

    const paths = await env.store.getFilePaths();
    assert.equal((await env.store.getChunksByFilePath(fpA)).length, 1, "quirk A restored to store");
    assert.equal((await env.store.getChunksByFilePath(fpB)).length, 1, "quirk B restored to store");
    assert.ok(paths.length >= 2, "store still reports file paths");
    assert.ok(env.ki.hasChunk(a.id), "quirk A back in keyword index");
    assert.ok(env.ki.hasChunk(b.id), "quirk B back in keyword index");
    // jsonl untouched — still the source of truth, exactly 2 entries.
    assert.equal((await listQuirks(env.deps)).length, 2);
    // The reconciled keyword index was persisted for the next process.
    assert.ok(existsSync(join(env.dir, "keyword-index.json")), "keyword index saved");

    // Idempotent: a second run finds nothing to do.
    const again = await reconcileQuirks(env.reconcileDeps);
    assert.deepEqual(again, { restoredToStore: 0, addedToKeywordIndex: 0, removedOrphans: 0 });
    await env.store.close();
  });

  it("heals a keyword index that lacks store-present quirks, without embedding", async () => {
    const env = await makeEnv();
    const q = await addQuirk(env.deps, { content: "reconcile gamma: present in store, absent in another process' keyword index" });

    // Simulates a second process whose loaded keyword index predates the quirk
    // (addQuirk never persisted the index; a pass-end save may have clobbered it).
    const foreignKi = new KeywordIndex(env.dir);
    const callsBefore = env.embedder.calls;

    const rec = await reconcileQuirks({ ...env.reconcileDeps, keywordIndex: foreignKi });

    assert.equal(rec.restoredToStore, 0, "store already complete");
    assert.equal(rec.addedToKeywordIndex, 1);
    assert.equal(env.embedder.calls, callsBefore, "keyword-index healing must not embed");
    assert.ok(foreignKi.hasChunk(q.id));
    await env.store.close();
  });

  it("removes store orphans only after two sightings across the grace window", async () => {
    const env = await makeEnv();
    const keep = await addQuirk(env.deps, { content: "reconcile delta: legit quirk that must survive" });
    const now = Date.now();
    await env.store.addChunks([
      rawQuirkChunk("quirk:orphan-stale", new Date(now - 2 * 60 * 60 * 1000).toISOString()),
      rawQuirkChunk("quirk:orphan-fresh", new Date(now).toISOString()),
    ]);
    const suspectsPath = join(env.dir, "quirk-orphans.json");

    // First sighting: both orphans are recorded, neither deleted (an orphan
    // this young may be an in-flight addQuirk — store write precedes jsonl append).
    const first = await reconcileQuirks(env.reconcileDeps);
    assert.equal(first.removedOrphans, 0, "first sighting must never delete");
    assert.ok(existsSync(suspectsPath), "orphan state recorded for the next process/run");

    // Fast-forward: the stale one was first seen > grace ago, the fresh one just now.
    writeFileSync(suspectsPath, JSON.stringify({
      "quirk:orphan-stale": now - 2 * 60 * 60 * 1000,
      "quirk:orphan-fresh": now,
    }));

    const second = await reconcileQuirks(env.reconcileDeps);
    assert.equal(second.removedOrphans, 1, "only the stale orphan is removed");
    assert.equal((await env.store.getChunksByFilePath("quirk:quirk:orphan-stale")).length, 0, "stale orphan deleted");
    assert.equal((await env.store.getChunksByFilePath("quirk:quirk:orphan-fresh")).length, 1, "fresh orphan kept (within grace)");
    assert.equal((await env.store.getChunksByFilePath(`quirk:${keep.id}`)).length, 1, "jsonl quirk untouched");
    assert.ok(env.ki.hasChunk(keep.id));
    await env.store.close();
  });

  it("never deletes store quirks when quirks.jsonl is missing (missing means unknown, not empty)", async () => {
    const env = await makeEnv();
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await env.store.addChunks([rawQuirkChunk("quirk:legacy", stale)]);

    const rec = await reconcileQuirks(env.reconcileDeps);

    assert.equal(rec.removedOrphans, 0);
    assert.equal(rec.restoredToStore, 0);
    assert.equal((await env.store.getChunksByFilePath("quirk:quirk:legacy")).length, 1, "store quirk survives");
    await env.store.close();
  });

  it("is a no-op for memory stores (nothing on disk to drift)", async () => {
    const store = new LanceDbStore("memory://", DIM);
    const rec = await reconcileQuirks({
      embedder: makeEmbedder(),
      store,
      keywordIndex: new KeywordIndex(),
      cfg: MINIMAL_CFG,
      storePath: "memory://",
    });
    assert.deepEqual(rec, { restoredToStore: 0, addedToKeywordIndex: 0, removedOrphans: 0 });
    await store.clear({ noBackup: true });
  });
});
