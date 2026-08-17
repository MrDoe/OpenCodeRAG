import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LanceDbStore, l2Normalize, countIndexVersionDirs } from "../../vectorstore/lancedb.js";
import { normalizeFilePath } from "../../core/manifest.js";

describe("LanceDbStore (memory)", () => {
  let store: LanceDbStore;

  before(async () => {
    store = new LanceDbStore("memory://");
  });

  after(async () => {
    await store.clear({ noBackup: true });
  });

  it("starts with zero count", async () => {
    const count = await store.count();
    assert.equal(count, 0);
  });

  it("adds chunks and returns correct count", async () => {
    const chunks = [
      {
        id: "chunk-1",
        content: "function hello() { return 'world'; }",
        embedding: new Array(384).fill(0).map((_, i) => (i % 2 === 0 ? 0.1 : -0.1)),
        metadata: {
          filePath: "src/hello.ts",
          startLine: 1,
          endLine: 5,
          language: "typescript",
        },
      },
      {
        id: "chunk-2",
        content: "function goodbye() { return 'farewell'; }",
        embedding: new Array(384).fill(0).map((_, i) => (i % 2 === 0 ? -0.1 : 0.1)),
        metadata: {
          filePath: "src/goodbye.ts",
          startLine: 1,
          endLine: 5,
          language: "typescript",
        },
      },
    ];

    await store.addChunks(chunks);
    const count = await store.count();
    assert.equal(count, 2);
  });

  it("searches and returns results with scores", async () => {
    // Search with a vector similar to chunk-1
    const queryVector = new Array(384).fill(0).map((_, i) =>
      i % 2 === 0 ? 0.1 : -0.1
    );

    const results = await store.search(queryVector, 2);
    assert.ok(results.length > 0, "Should return at least one result");
    assert.ok(results[0]!.score > 0, "Score should be positive");
    assert.ok(results[0]!.score <= 1, "Score should be <= 1");
    assert.equal(typeof results[0]!.chunk.id, "string");
    assert.equal(typeof results[0]!.chunk.content, "string");
  });

  it("respects topK parameter", async () => {
    const queryVector = new Array(384).fill(0.1);
    const results = await store.search(queryVector, 1);
    assert.equal(results.length, 1);
  });

  it("clears all chunks", async () => {
    await store.clear({ noBackup: true });
    const count = await store.count();
    assert.equal(count, 0);
  });

  it("can re-add chunks after clear", async () => {
    const chunks = [
      {
        id: "chunk-3",
        content: "new content",
        embedding: new Array(384).fill(0.05),
        metadata: {
          filePath: "src/new.ts",
          startLine: 1,
          endLine: 3,
          language: "typescript",
        },
      },
    ];

    await store.addChunks(chunks);
    const count = await store.count();
    assert.equal(count, 1);
  });

  it("filters out chunks without embeddings in addChunks", async () => {
    await store.clear({ noBackup: true });

    const chunks = [
      {
        id: "no-embed",
        content: "no embedding",
        embedding: undefined as unknown as number[],
        metadata: {
          filePath: "test.ts",
          startLine: 1,
          endLine: 1,
          language: "typescript",
        },
      },
      {
        id: "empty-embed",
        content: "empty embedding",
        embedding: [],
        metadata: {
          filePath: "test.ts",
          startLine: 2,
          endLine: 2,
          language: "typescript",
        },
      },
    ];

    await store.addChunks(chunks);
    const count = await store.count();
    assert.equal(count, 0, "Chunks without embeddings should not be stored");
  });

  it("deletes all chunks for a specific file path", async () => {
    await store.clear({ noBackup: true });

    await store.addChunks([
      {
        id: "delete-1",
        content: "alpha",
        embedding: new Array(384).fill(0.1),
        metadata: {
          filePath: "src/delete-me.ts",
          startLine: 1,
          endLine: 1,
          language: "typescript",
        },
      },
      {
        id: "delete-2",
        content: "beta",
        embedding: new Array(384).fill(0.2),
        metadata: {
          filePath: "src/keep-me.ts",
          startLine: 1,
          endLine: 1,
          language: "typescript",
        },
      },
      {
        id: "delete-3",
        content: "gamma",
        embedding: new Array(384).fill(0.3),
        metadata: {
          filePath: "src/delete-me.ts",
          startLine: 2,
          endLine: 2,
          language: "typescript",
        },
      },
    ]);

    await store.deleteByFilePath("src/delete-me.ts");

    const count = await store.count();
    assert.equal(count, 1);

    const results = await store.search(new Array(384).fill(0.2), 5);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.chunk.metadata.filePath, normalizeFilePath("src/keep-me.ts"));
  });

  it("stores and retrieves description field", async () => {
    await store.clear({ noBackup: true });

    const chunks = [
      {
        id: "desc-1",
        content: "function hello() { return 'world'; }",
        description: "A function that returns the greeting 'world'.",
        embedding: new Array(384).fill(0).map((_, i) => (i % 2 === 0 ? 0.1 : -0.1)),
        metadata: {
          filePath: "src/hello.ts",
          startLine: 1,
          endLine: 3,
          language: "typescript",
        },
      },
      {
        id: "desc-2",
        content: "function noDesc() { return 42; }",
        embedding: new Array(384).fill(0).map((_, i) => (i % 2 === 0 ? -0.1 : 0.1)),
        metadata: {
          filePath: "src/no-desc.ts",
          startLine: 1,
          endLine: 3,
          language: "typescript",
        },
      },
    ];

    await store.addChunks(chunks);
    const count = await store.count();
    assert.equal(count, 2);

    const results = await store.search(new Array(384).fill(0).map((_, i) => (i % 2 === 0 ? 0.1 : -0.1)), 2);
    assert.equal(results.length, 2);

    const withDesc = results.find((r) => r.chunk.id === "desc-1");
    const withoutDesc = results.find((r) => r.chunk.id === "desc-2");

    assert.ok(withDesc);
    assert.equal(withDesc.chunk.description, "A function that returns the greeting 'world'.");
    assert.equal(withDesc.chunk.content, "function hello() { return 'world'; }");

    assert.ok(withoutDesc);
    assert.equal(withoutDesc.chunk.description, "");
  });

  it("lists files with chunk counts", async () => {
    await store.clear({ noBackup: true });

    await store.addChunks([
      {
        id: "lf-1",
        content: "a",
        embedding: new Array(384).fill(0.1),
        metadata: { filePath: "src/a.ts", startLine: 1, endLine: 1, language: "typescript" },
      },
      {
        id: "lf-2",
        content: "b",
        embedding: new Array(384).fill(0.2),
        metadata: { filePath: "src/a.ts", startLine: 2, endLine: 2, language: "typescript" },
      },
      {
        id: "lf-3",
        content: "c",
        embedding: new Array(384).fill(0.3),
        metadata: { filePath: "src/b.py", startLine: 1, endLine: 1, language: "python" },
      },
    ]);

    const files = await store.listFiles();
    assert.equal(files.length, 2);

    assert.equal(files[0]!.filePath, normalizeFilePath("src/a.ts"));
    assert.equal(files[0]!.language, "typescript");
    assert.equal(files[0]!.chunkCount, 2);

    assert.equal(files[1]!.filePath, normalizeFilePath("src/b.py"));
    assert.equal(files[1]!.language, "python");
    assert.equal(files[1]!.chunkCount, 1);
  });

  it("returns empty array for listFiles on empty store", async () => {
    await store.clear({ noBackup: true });
    const files = await store.listFiles();
    assert.deepEqual(files, []);
  });

  it("retrieves chunks by file path sorted by startLine", async () => {
    await store.clear({ noBackup: true });

    await store.addChunks([
      {
        id: "gbfp-2",
        content: "second chunk",
        embedding: new Array(384).fill(0.2),
        metadata: { filePath: "src/target.ts", startLine: 10, endLine: 20, language: "typescript" },
      },
      {
        id: "gbfp-1",
        content: "first chunk",
        embedding: new Array(384).fill(0.1),
        metadata: { filePath: "src/target.ts", startLine: 1, endLine: 9, language: "typescript" },
      },
      {
        id: "gbfp-other",
        content: "other file",
        embedding: new Array(384).fill(0.3),
        metadata: { filePath: "src/other.ts", startLine: 1, endLine: 1, language: "typescript" },
      },
    ]);

    const chunks = await store.getChunksByFilePath("src/target.ts");
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0]!.id, "gbfp-1");
    assert.equal(chunks[0]!.metadata.startLine, 1);
    assert.equal(chunks[1]!.id, "gbfp-2");
    assert.equal(chunks[1]!.metadata.startLine, 10);
  });

  it("returns empty array for getChunksByFilePath with no match", async () => {
    await store.clear({ noBackup: true });
    const chunks = await store.getChunksByFilePath("nonexistent.ts");
    assert.deepEqual(chunks, []);
  });

  it("retrieves chunks with pagination via getChunks", async () => {
    await store.clear({ noBackup: true });

    await store.addChunks([
      {
        id: "gc-1",
        content: "one",
        embedding: new Array(384).fill(0.1),
        metadata: { filePath: "a.ts", startLine: 1, endLine: 1, language: "typescript" },
      },
      {
        id: "gc-2",
        content: "two",
        embedding: new Array(384).fill(0.2),
        metadata: { filePath: "b.ts", startLine: 1, endLine: 1, language: "python" },
      },
      {
        id: "gc-3",
        content: "three",
        embedding: new Array(384).fill(0.3),
        metadata: { filePath: "c.ts", startLine: 1, endLine: 1, language: "go" },
      },
    ]);

    const page1 = await store.getChunks(0, 2);
    assert.equal(page1.length, 2);

    const page2 = await store.getChunks(2, 2);
    assert.equal(page2.length, 1);

    const allIds = new Set([...page1.map((c) => c.filePath), page2[0]!.filePath]);
    assert.equal(allIds.size, 3);
  });

  it("returns empty array for getChunks beyond range", async () => {
    await store.clear({ noBackup: true });
    const chunks = await store.getChunks(100, 10);
    assert.deepEqual(chunks, []);
  });

  it("getFilePaths returns all unique file paths", async () => {
    await store.clear({ noBackup: true });

    await store.addChunks([
      {
        id: "gfp-1",
        content: "a",
        embedding: new Array(384).fill(0.1),
        metadata: { filePath: "src/a.ts", startLine: 1, endLine: 1, language: "typescript" },
      },
      {
        id: "gfp-2",
        content: "b",
        embedding: new Array(384).fill(0.2),
        metadata: { filePath: "src/a.ts", startLine: 2, endLine: 2, language: "typescript" },
      },
      {
        id: "gfp-3",
        content: "c",
        embedding: new Array(384).fill(0.3),
        metadata: { filePath: "src/b.py", startLine: 1, endLine: 1, language: "python" },
      },
    ]);

    const paths = await store.getFilePaths();
    assert.equal(paths.length, 2);
    assert.ok(paths.some((p) => p.includes("src/a.ts")));
    assert.ok(paths.some((p) => p.includes("src/b.py")));
  });

  it("getFilePaths returns empty array on empty store", async () => {
    await store.clear({ noBackup: true });
    const paths = await store.getFilePaths();
    assert.deepEqual(paths, []);
  });

  it("handles concurrent writes without conflicts", async () => {
    await store.clear({ noBackup: true });

    const DIM = 384;
    const workers = 10;
    const results = await Promise.allSettled(
      Array.from({ length: workers }, (_, i) =>
        store.addChunks([
          {
            id: `concurrent-${i}`,
            content: `worker ${i} content`,
            embedding: new Array(DIM).fill(i * 0.1 + 0.01),
            metadata: { filePath: `src/worker-${i}.ts`, startLine: i, endLine: i + 5, language: "typescript" },
          },
        ])
      ),
    );

    for (const r of results) {
      assert.equal(r.status, "fulfilled", `concurrent addChunks failed: ${r.status === "rejected" ? r.reason : ""}`);
    }

    const count = await store.count();
    assert.equal(count, workers, "all concurrent chunks should be stored");

    // Concurrent reads while writes are in flight
    const searchTasks = Array.from({ length: 20 }, (_, i) =>
      store.search(new Array(DIM).fill(i * 0.05 + 0.01), 3),
    );
    const searchResults = await Promise.allSettled(searchTasks);
    for (const r of searchResults) {
      assert.equal(r.status, "fulfilled", `concurrent search failed: ${r.status === "rejected" ? r.reason : ""}`);
    }

    // Concurrent deletes (targeting nonexistent paths, should be safe)
    const deleteTasks = Array.from({ length: 5 }, (_, i) =>
      store.deleteByFilePath(`src/nonexistent-${i}.ts`),
    );
    const deleteResults = await Promise.allSettled(deleteTasks);
    for (const r of deleteResults) {
      assert.equal(r.status, "fulfilled", `concurrent delete failed: ${r.status === "rejected" ? r.reason : ""}`);
    }

    // Verify data integrity
    const finalCount = await store.count();
    assert.equal(finalCount, workers, "all chunks preserved after concurrent deletes");
  });

  const makeChunk = (
    id: string,
    filePath: string,
    startLine: number,
    content: string,
  ) => ({
    id,
    content,
    embedding: new Array(384).fill(0.1).map((_, i) => (i % 2 === 0 ? 0.1 : -0.1)),
    metadata: { filePath, startLine, endLine: startLine + 4, language: "typescript" },
  });

  it("dedups prior revision on re-add (single-delete semantics)", async () => {
    await store.clear({ noBackup: true });

    // Revision 1 of the file: chunks at lines 1, 2, 3
    await store.addChunks([
      makeChunk("rev1-1", "src/re.ts", 1, "old line 1"),
      makeChunk("rev1-2", "src/re.ts", 2, "old line 2"),
      makeChunk("rev1-3", "src/re.ts", 3, "old line 3"),
    ]);
    assert.equal(await store.count(), 3);

    // Revision 2: same startLines 1-2 with new IDs, stale line 3 gone, new line 5
    await store.addChunks([
      makeChunk("rev2-1", "src/re.ts", 1, "new line 1"),
      makeChunk("rev2-2", "src/re.ts", 2, "new line 2"),
      makeChunk("rev2-5", "src/re.ts", 5, "new line 5"),
    ]);

    const chunks = await store.getChunksByFilePath("src/re.ts");
    assert.equal(chunks.length, 3, "stale chunks from the prior revision must be removed");
    const ids = chunks.map((c) => c.id).sort();
    assert.deepEqual(ids, ["rev2-1", "rev2-2", "rev2-5"]);

    // Unrelated files must be untouched
    await store.addChunks([makeChunk("other-1", "src/other.ts", 1, "keep")]);
    assert.equal((await store.getChunksByFilePath("src/other.ts")).length, 1);
  });

  it("keeps multiple new chunks sharing a startLine while removing the old revision", async () => {
    await store.clear({ noBackup: true });

    await store.addChunks([
      makeChunk("a-1", "src/share.ts", 1, "one"),
      makeChunk("a-2", "src/share.ts", 1, "two"),
    ]);
    assert.equal(await store.count(), 2);

    // Re-add with DIFFERENT new IDs at the same startLine — the single
    // per-file delete must remove the old revision without letting the new
    // IDs sharing startLine 1 delete each other.
    await store.addChunks([
      makeChunk("b-1", "src/share.ts", 1, "one"),
      makeChunk("b-2", "src/share.ts", 1, "two"),
    ]);
    const chunks = await store.getChunksByFilePath("src/share.ts");
    assert.equal(chunks.length, 2, "new IDs sharing a startLine must not delete each other");
    assert.deepEqual(chunks.map((c) => c.id).sort(), ["b-1", "b-2"]);
  });

  it("appends without dedup when dedup: false", async () => {
    await store.clear({ noBackup: true });

    await store.addChunks([makeChunk("v1", "src/append.ts", 1, "first")]);
    await store.addChunks([makeChunk("v2", "src/append.ts", 1, "second")], { dedup: false });

    // Append-only: both rows coexist (duplicates allowed by design)
    assert.equal(await store.count(), 2);
  });

  it("addChunksBulk writes multiple files with per-file dedup", async () => {
    await store.clear({ noBackup: true });

    // Pre-existing revision of a modified file
    await store.addChunks([makeChunk("m-old", "src/modified.ts", 1, "old")]);

    await store.addChunksBulk([
      { chunks: [makeChunk("m-new", "src/modified.ts", 1, "new")], dedup: true },
      { chunks: [makeChunk("n-1", "src/newfile.ts", 1, "brand new")], dedup: false },
    ]);

    const modified = await store.getChunksByFilePath("src/modified.ts");
    assert.deepEqual(
      modified.map((c) => c.id),
      ["m-new"],
      "bulk dedup must remove the prior revision of the modified file",
    );
    const newfile = await store.getChunksByFilePath("src/newfile.ts");
    assert.deepEqual(newfile.map((c) => c.id), ["n-1"]);
    assert.equal(await store.count(), 2);
  });
});

describe("l2Normalize", () => {
  it("normalizes vectors to unit length", () => {
    const v = [3, 4];
    const result = l2Normalize(v);
    assert.deepStrictEqual(result, [0.6, 0.8]);
  });

  it("makes same-direction vectors identical regardless of magnitude", () => {
    const a = l2Normalize([3, 4]);
    const b = l2Normalize([6, 8]);
    assert.deepStrictEqual(a, b);
  });

  it("returns original vector when norm is zero", () => {
    const v = [0, 0, 0];
    const result = l2Normalize(v);
    assert.deepStrictEqual(result, [0, 0, 0]);
  });
});

describe("LanceDbStore (disk corruption recovery)", () => {
  it("handles non-existent table gracefully", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "opencode-rag-test-"));
    try {
      const store = new LanceDbStore(tmpDir);
      const results = await store.search(new Array(384).fill(0.1), 10);
      assert.equal(results.length, 0);
      const count = await store.count();
      assert.equal(count, 0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("countIndexVersionDirs", () => {
  it("counts only directories under _indices", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "opencode-rag-idx-"));
    try {
      mkdirSync(join(tmpDir, "_indices"), { recursive: true });
      for (let i = 0; i < 3; i++) mkdirSync(join(tmpDir, "_indices", `idx-${i}`));
      writeFileSync(join(tmpDir, "_indices", "stray.txt"), "x");
      assert.equal(countIndexVersionDirs(tmpDir), 3);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns 0 when the directory does not exist", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "opencode-rag-idx-"));
    try {
      assert.equal(countIndexVersionDirs(tmpDir), 0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("LanceDbStore index-repair hardening", () => {
  it("skips index creation when many stale index versions accumulated", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "opencode-rag-idx-"));
    try {
      const store = new LanceDbStore(tmpDir, 4);
      const repair = (warn?: (m: string) => void) =>
        (store as unknown as {
          repairIndexMetricOnce: (warn?: (m: string) => void) => Promise<void>;
        }).repairIndexMetricOnce(warn);
      const warns: string[] = [];
      await repair((m) => warns.push(m));
      assert.equal(warns.length, 0, "healthy empty store must not warn");

      // Simulate the accumulation left behind by index commits that never
      // registered (the state that caused constant index retraining).
      const indicesDir = join(tmpDir, "chunks.lance", "_indices");
      mkdirSync(indicesDir, { recursive: true });
      for (let i = 0; i < 45; i++) mkdirSync(join(indicesDir, `idx-${i}`));

      await repair((m) => warns.push(m));
      assert.ok(
        warns.some((w) => w.includes("stale index versions")),
        `expected stale-index warning, got: ${warns.join(" | ")}`,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("gives up after repeated index-repair failures instead of retraining forever", async () => {
    const store = new LanceDbStore("memory://", 4);
    let indexStatsCalls = 0;
    let createIndexCalls = 0;
    const fakeTable = {
      optimize: async () => {},
      countRows: async () => 1500,
      listIndices: async () => [],
      indexStats: async () => {
        indexStatsCalls++;
        throw new Error("boom");
      },
      createIndex: async () => {
        createIndexCalls++;
      },
    };
    (store as unknown as { table: unknown }).table = fakeTable;

    const warns: string[] = [];
    for (let i = 0; i < 5; i++) {
      await store.optimize({ logger: (m) => warns.push(m) });
    }

    assert.equal(indexStatsCalls, 3, "repair must be attempted at most MAX_INDEX_REPAIR_ATTEMPTS times");
    assert.equal(createIndexCalls, 0, "createIndex must never run when indexStats throws");
    assert.ok(
      warns.some((w) => w.includes("giving up")),
      `expected give-up warning, got: ${warns.join(" | ")}`,
    );
  });

  it("skipIndex skips index creation during optimize", async () => {
    let createIndexCalls = 0;
    const makeStore = (): LanceDbStore => {
      const store = new LanceDbStore("memory://", 4);
      (store as unknown as { table: unknown }).table = {
        optimize: async () => {},
        countRows: async () => 1500,
        listIndices: async () => [],
        indexStats: async () => undefined,
        createIndex: async () => {
          createIndexCalls++;
        },
      };
      return store;
    };

    await makeStore().optimize({ skipIndex: true });
    assert.equal(createIndexCalls, 0, "skipIndex must suppress the index build");

    await makeStore().optimize({});
    assert.equal(createIndexCalls, 1, "regular optimize must build the missing index");
  });
});
