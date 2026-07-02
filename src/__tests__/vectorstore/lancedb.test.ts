import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LanceDbStore, l2Normalize } from "../../vectorstore/lancedb.js";
import { normalizeFilePath } from "../../core/manifest.js";

describe("LanceDbStore (memory)", () => {
  let store: LanceDbStore;

  before(async () => {
    store = new LanceDbStore("memory://");
  });

  after(async () => {
    await store.clear();
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
    await store.clear();
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
    await store.clear();

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
    await store.clear();

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
    await store.clear();

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
    await store.clear();

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
    await store.clear();
    const files = await store.listFiles();
    assert.deepEqual(files, []);
  });

  it("retrieves chunks by file path sorted by startLine", async () => {
    await store.clear();

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
    await store.clear();
    const chunks = await store.getChunksByFilePath("nonexistent.ts");
    assert.deepEqual(chunks, []);
  });

  it("retrieves chunks with pagination via getChunks", async () => {
    await store.clear();

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
    await store.clear();
    const chunks = await store.getChunks(100, 10);
    assert.deepEqual(chunks, []);
  });

  it("getFilePaths returns all unique file paths", async () => {
    await store.clear();

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
    await store.clear();
    const paths = await store.getFilePaths();
    assert.deepEqual(paths, []);
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
  it("recovers gracefully from missing data files", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "opencode-rag-test-"));
    try {
      const store = new LanceDbStore(tmpDir);

      const emb1 = new Array(384).fill(0.1);
      const emb2 = new Array(384).fill(0.2);

      await store.addChunks([
        { id: "r1", content: "alpha", embedding: emb1, metadata: { filePath: "a.ts", startLine: 1, endLine: 1, language: "ts" } },
      ]);
      await store.addChunks([
        { id: "r2", content: "beta", embedding: emb2, metadata: { filePath: "b.ts", startLine: 1, endLine: 1, language: "ts" } },
      ]);

      const countBefore = await store.count();
      assert.ok(countBefore > 0, "should have data before corruption");

      const dataDir = join(tmpDir, "chunks.lance", "data");
      if (existsSync(dataDir)) {
        for (const f of readdirSync(dataDir)) {
          if (f.endsWith(".lance")) {
            unlinkSync(join(dataDir, f));
          }
        }
      }

      const results = await store.search(emb1, 10);
      assert.ok(Array.isArray(results), "should return an array without throwing");

      const finalCount = await store.count();
      assert.equal(typeof finalCount, "number", "count should return a number without throwing");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

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
