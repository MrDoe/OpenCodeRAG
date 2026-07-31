import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KeywordIndex, tokenize } from "../../retriever/keyword-index.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Chunk } from "../../core/interfaces.js";

function makeChunk(id: string, content: string, filePath = "test.ts", startLine = 1, endLine = 10): Chunk {
  return {
    id,
    content,
    metadata: { filePath, startLine, endLine, language: "typescript" },
  };
}

describe("tokenize", () => {
  it("splits on non-alphanumeric characters", () => {
    const tokens = tokenize("hello world foo-bar");
    assert.ok(tokens.includes("hello"));
    assert.ok(tokens.includes("world"));
    assert.ok(tokens.includes("foo"));
    assert.ok(tokens.includes("bar"));
  });

  it("extracts camelCase parts", () => {
    const tokens = tokenize("getUserById");
    assert.ok(tokens.includes("getuserbyid"));
    assert.ok(tokens.includes("get"));
    assert.ok(tokens.includes("user"));
    assert.ok(tokens.includes("by"));
    assert.ok(tokens.includes("id"));
  });

  it("extracts snake_case parts", () => {
    const tokens = tokenize("get_user_by_id");
    assert.ok(tokens.includes("get_user_by_id"));
    assert.ok(tokens.includes("get"));
    assert.ok(tokens.includes("user"));
    assert.ok(tokens.includes("by"));
    assert.ok(tokens.includes("id"));
  });

  it("filters tokens shorter than 2 characters", () => {
    const tokens = tokenize("a b c");
    assert.equal(tokens.length, 0);
  });

  it("returns unique tokens", () => {
    const tokens = tokenize("hello hello hello");
    assert.equal(tokens.length, 1);
  });

  it("handles empty string", () => {
    assert.deepStrictEqual(tokenize(""), []);
  });

  it("handles code with dots and special chars", () => {
    const tokens = tokenize("console.log(foo.bar)");
    assert.ok(tokens.includes("console"));
    assert.ok(tokens.includes("log"));
    assert.ok(tokens.includes("foo"));
    assert.ok(tokens.includes("bar"));
  });

  it("stems plural forms for keyword matching", () => {
    const tokens = tokenize("images screenshots diagrams");
    assert.ok(tokens.includes("image"), "should stem 'images' to 'image'");
    assert.ok(tokens.includes("screenshot"), "should stem 'screenshots' to 'screenshot'");
    assert.ok(tokens.includes("diagram"), "should stem 'diagrams' to 'diagram'");
  });

  it("stems -ing suffix", () => {
    const tokens = tokenize("indexing searching");
    assert.ok(tokens.includes("index"), "should stem 'indexing' to 'index'");
    assert.ok(tokens.includes("search"), "should stem 'searching' to 'search'");
  });

  it("stems -ed suffix", () => {
    const tokens = tokenize("indexed searched");
    assert.ok(tokens.includes("index"), "should stem 'indexed' to 'index'");
    assert.ok(tokens.includes("search"), "should stem 'searched' to 'search'");
  });

  it("preserves original tokens alongside stemmed forms", () => {
    const tokens = tokenize("images");
    assert.ok(tokens.includes("images"), "should keep original 'images'");
    assert.ok(tokens.includes("image"), "should also have stemmed 'image'");
  });
});

describe("KeywordIndex", () => {
  describe("addChunks", () => {
    it("indexes chunk content tokens", () => {
      const index = new KeywordIndex();
      index.addChunks([makeChunk("c1", "function getUserById")]);
      const results = index.search("getUser", 10);
      assert.equal(results.length, 1);
      assert.equal(results[0]!.chunk.id, "c1");
    });

    it("indexes multiple chunks", () => {
      const index = new KeywordIndex();
      index.addChunks([
        makeChunk("c1", "function renderDashboard", "a.ts"),
        makeChunk("c2", "function deleteUserById", "b.ts"),
      ]);
      assert.equal(index.count(), 2);
      const results = index.search("deleteUser", 10);
      assert.equal(results.length, 1);
      assert.equal(results[0]!.chunk.id, "c2");
    });

    it("handles empty chunks array", () => {
      const index = new KeywordIndex();
      index.addChunks([]);
      assert.equal(index.count(), 0);
    });
  });

  describe("removeByFilePath", () => {
    it("removes all chunks for a file path", () => {
      const index = new KeywordIndex();
      index.addChunks([
        makeChunk("c1", "function foo", "/project/a.ts"),
        makeChunk("c2", "function bar", "/project/a.ts"),
        makeChunk("c3", "function baz", "/project/b.ts"),
      ]);
      assert.equal(index.count(), 3);
      index.removeByFilePath("/project/a.ts");
      assert.equal(index.count(), 1);
      const results = index.search("foo", 10);
      assert.equal(results.length, 0);
    });

    it("handles non-existent file path gracefully", () => {
      const index = new KeywordIndex();
      index.addChunks([makeChunk("c1", "function foo")]);
      index.removeByFilePath("/nonexistent.ts");
      assert.equal(index.count(), 1);
    });

    it("matches paths with different separators/casing (Windows)", () => {
      const index = new KeywordIndex();
      // Chunks are stored with native separators; removal uses normalized
      // (forward-slash) paths — both must resolve to the same file.
      index.addChunks([
        makeChunk("c1", "function foo", "C:\\work\\project\\a.ts"),
        makeChunk("c2", "function bar", "C:\\work\\project\\b.ts"),
      ]);
      index.removeByFilePath("C:/work/project/a.ts");
      assert.equal(index.count(), 1);
      assert.equal(index.search("foo", 10).length, 0);
      assert.equal(index.search("bar", 10).length, 1);
    });

    it("removes stale entries after re-index (new UUIDs, same path)", () => {
      const index = new KeywordIndex();
      index.addChunks([makeChunk("old-id-1", "function oldVersion", "/p/a.ts")]);
      // Re-index of the same file produces NEW chunk IDs — the old ones must
      // be removed before the new ones are added.
      index.removeByFilePath("/p/a.ts");
      index.addChunks([makeChunk("new-id-1", "function newVersion", "/p/a.ts")]);
      assert.equal(index.count(), 1);
      // "oldversion" exists only in the stale revision's tokens
      const staleHits = index.search("oldversion", 10);
      assert.equal(staleHits.length, 0, "stale revision must not be searchable");
      assert.equal(index.search("newversion", 10).length, 1);
    });
  });

  describe("search", () => {
    it("returns empty array for empty index", () => {
      const index = new KeywordIndex();
      const results = index.search("query", 10);
      assert.deepStrictEqual(results, []);
    });

    it("returns empty array for empty query", () => {
      const index = new KeywordIndex();
      index.addChunks([makeChunk("c1", "function foo")]);
      const results = index.search("", 10);
      assert.deepStrictEqual(results, []);
    });

    it("returns results sorted by relevance (TF-IDF)", () => {
      const index = new KeywordIndex();
      index.addChunks([
        makeChunk("c1", "apple banana cherry", "a.ts"),
        makeChunk("c2", "apple banana", "b.ts"),
        makeChunk("c3", "apple", "c.ts"),
      ]);
      const results = index.search("apple banana cherry", 10);
      assert.equal(results.length, 3);
      assert.equal(results[0]!.chunk.id, "c1");
      assert.equal(results[1]!.chunk.id, "c2");
      assert.equal(results[2]!.chunk.id, "c3");
    });

    it("respects topK limit", () => {
      const index = new KeywordIndex();
      index.addChunks([
        makeChunk("c1", "apple banana", "a.ts"),
        makeChunk("c2", "apple cherry", "b.ts"),
        makeChunk("c3", "apple date", "c.ts"),
      ]);
      const results = index.search("apple", 2);
      assert.equal(results.length, 2);
    });

    it("returns chunk metadata in results", () => {
      const index = new KeywordIndex();
      index.addChunks([makeChunk("c1", "function foo", "/project/test.ts", 5, 15)]);
      const results = index.search("foo", 10);
      assert.equal(results.length, 1);
      assert.equal(results[0]!.chunk.metadata.filePath, "/project/test.ts");
      assert.equal(results[0]!.chunk.metadata.startLine, 5);
      assert.equal(results[0]!.chunk.metadata.endLine, 15);
      assert.equal(results[0]!.chunk.metadata.language, "typescript");
    });

    it("matches plural queries via stemming", () => {
      const index = new KeywordIndex();
      index.addChunks([
        makeChunk("c1", "[image] [png] [doc/assets/eval.png] Image of a dashboard"),
        makeChunk("c2", "[image] [png] [doc/assets/webui.png] Image of a web interface"),
      ]);
      const results = index.search("find all images", 10);
      assert.ok(results.length >= 2, "should find image chunks via stemming");
    });
  });

  describe("clear", () => {
    it("removes all indexed data", () => {
      const index = new KeywordIndex();
      index.addChunks([makeChunk("c1", "function foo")]);
      assert.equal(index.count(), 1);
      index.clear();
      assert.equal(index.count(), 0);
      const results = index.search("foo", 10);
      assert.equal(results.length, 0);
    });
  });

  describe("serialization", () => {
    it("saves and loads index data", async () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), "keyword-index-test-"));
      const storePath = path.join(tmpDir, "rag_db");

      const index = new KeywordIndex(storePath);
      index.addChunks([makeChunk("c1", "function getUserById", "/project/a.ts", 1, 5)]);
      await index.save();

      const loaded = await KeywordIndex.load(storePath);
      assert.equal(loaded.count(), 1);
      const results = loaded.search("getUser", 10);
      assert.equal(results.length, 1);
      assert.equal(results[0]!.chunk.id, "c1");
    });

    it("returns empty index when no saved data exists", async () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), "keyword-index-test-"));
      const storePath = path.join(tmpDir, "nonexistent");
      const loaded = await KeywordIndex.load(storePath);
      assert.equal(loaded.count(), 0);
    });

    it("handles version mismatch gracefully", async () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), "keyword-index-test-"));
      const storePath = path.join(tmpDir, "rag_db");
      mkdirSync(path.join(tmpDir, "rag_db"), { recursive: true });
      writeFileSync(
        path.join(tmpDir, "rag_db", "keyword-index.json"),
        JSON.stringify({ version: 999, tokens: [], chunkMap: {} }),
        "utf-8"
      );

      const loaded = await KeywordIndex.load(storePath);
      assert.equal(loaded.count(), 0);
    });
  });

  describe("clearFile static", () => {
    it("writes empty index to disk", async () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), "keyword-index-test-"));
      const storePath = path.join(tmpDir, "rag_db");

      const index = new KeywordIndex(storePath);
      index.addChunks([makeChunk("c1", "function foo")]);
      await index.save();
      assert.equal((await KeywordIndex.load(storePath)).count(), 1);

      await KeywordIndex.clearFile(storePath);
      const loaded = await KeywordIndex.load(storePath);
      assert.equal(loaded.count(), 0);
    });
  });
});
