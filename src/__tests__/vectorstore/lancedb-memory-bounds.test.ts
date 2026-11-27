import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LanceDbStore } from "../../vectorstore/lancedb.js";

/**
 * Memory-bound behavior of LanceDbStore: bounded bulk inserts, projected
 * vector searches and the IVF opt-out (`vectorStore.lancedb.buildIndex:
 * false`). The fakes stand in for the native table so the tests stay fast and
 * deterministic; the real memory:// store is used for the Session smoke test.
 */

const DIM = 8;

function makeChunk(id: string, filePath: string, startLine: number) {
  return {
    id,
    content: `content ${id}`,
    embedding: new Array(DIM).fill(0.1),
    metadata: { filePath, startLine, endLine: startLine + 1, language: "typescript" },
  };
}

function fakeTable(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    add: async () => {},
    delete: async () => {},
    countRows: async () => 0,
    listIndices: async () => [],
    indexStats: async () => undefined,
    optimize: async () => {},
    ...overrides,
  };
}

describe("LanceDbStore memory bounds", () => {
  it("splits bulk writes into bounded add() slices", async () => {
    const store = new LanceDbStore("memory://", DIM, process.cwd(), { buildIndex: false });
    const adds: unknown[][] = [];
    (store as unknown as { table: unknown }).table = fakeTable({
      add: async (rows: unknown[]) => { adds.push(rows); },
    });

    const chunks = Array.from({ length: 2_100 }, (_, i) => makeChunk(`bulk-${i}`, `src/file-${i % 7}.ts`, i));
    await store.addChunksBulk([{ chunks, dedup: false }]);

    assert.equal(adds.length, 2, "2100 rows must be written as two bounded slices");
    assert.equal(adds[0]!.length, 2_000);
    assert.equal(adds[1]!.length, 100);
    await store.close();
  });

  it("does not dedup-delete files from insert-only items", async () => {
    const store = new LanceDbStore("memory://", DIM, process.cwd(), { buildIndex: false });
    const deletes: string[] = [];
    (store as unknown as { table: unknown }).table = fakeTable({
      delete: async (predicate: string) => { deletes.push(predicate); },
    });

    await store.addChunksBulk([{ chunks: [makeChunk("insert-only", "src/a.ts", 1)], dedup: false }]);
    assert.deepEqual(deletes, [], "insert-only items must never trigger dedup deletes");
    await store.close();
  });

  it("projects query columns (drops the embedding column) in vector searches", async () => {
    const store = new LanceDbStore("memory://", DIM, process.cwd(), { buildIndex: false });
    let selected: string[] | undefined;
    let repairAttempted = false;

    const row = {
      id: "hit-1",
      content: "hello",
      description: "",
      filePath: "src/hello.ts",
      startLine: 1,
      endLine: 2,
      language: "typescript",
      kind: "",
      role: "",
      quirkType: "",
      tags: "",
      _distance: 0.1,
    };
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      distanceType: () => chain,
      select: (columns: string[]) => { selected = columns; return chain; },
      where: () => chain,
      limit: () => chain,
      toArray: async () => [row],
    });

    (store as unknown as { db: unknown }).db = { tableNames: async () => ["chunks"] };
    (store as unknown as { table: unknown }).table = fakeTable({
      countRows: async () => 1,
      vectorSearch: () => chain,
      listIndices: async () => { repairAttempted = true; return []; },
    });

    const results = await store.searchWithFilter(new Array(DIM).fill(0.1), 3);
    assert.equal(results.length, 1);
    assert.ok(selected, "search must call select()");
    assert.ok(selected!.includes("_distance"), "the score column must be projected");
    assert.ok(selected!.includes("content"), "content must be projected for the caller");
    assert.equal(selected!.includes("embedding"), false, "the embedding column must not be fetched");
    assert.equal(repairAttempted, false, "buildIndex:false must skip the IVF repair path entirely");
    await store.close();
  });

  it("skips IVF index maintenance when buildIndex is false", async () => {
    const store = new LanceDbStore("memory://", DIM, process.cwd(), { buildIndex: false });
    let optimizeCalls = 0;
    let indexCalls = 0;
    (store as unknown as { table: unknown }).table = fakeTable({
      optimize: async () => { optimizeCalls++; },
      listIndices: async () => { indexCalls++; return []; },
    });

    await store.optimize({});
    assert.equal(optimizeCalls, 1, "compaction still runs");
    assert.equal(indexCalls, 0, "no index work when buildIndex is false");
    await store.close();
  });

  it("connects through a cache-bounded Session on the real memory store", async () => {
    const store = new LanceDbStore("memory://", DIM, process.cwd(), {
      indexCacheSizeBytes: 8 * 1024 * 1024,
      metadataCacheSizeBytes: 4 * 1024 * 1024,
    });
    // getDb() constructs the Session and connects; exercises the real native path.
    const db = await (store as unknown as { getDb: () => Promise<unknown> }).getDb();
    assert.ok(db, "connection must be established");
    assert.equal(await store.count(), 0);
    await store.close();
  });
});
