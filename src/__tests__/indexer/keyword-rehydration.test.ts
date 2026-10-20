import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KeywordIndex } from "../../retriever/keyword-index.js";
import { InMemoryVectorStore } from "../../vectorstore/memory.js";
import {
  findKeywordIndexGaps,
  rehydrateKeywordIndex,
} from "../../indexer/keyword-rehydration.js";
import type { Chunk } from "../../core/interfaces.js";

function chunk(id: string, content: string, filePath: string, startLine = 1, endLine = 5): Chunk {
  return {
    id,
    content,
    description: `description of ${id}`,
    // The store only keeps chunks that carry an embedding.
    embedding: [0.1, 0.2, 0.3],
    metadata: { filePath, startLine, endLine, language: "typescript" },
  };
}

/** A store with two source files plus one quirk row. */
function makeStore(): InMemoryVectorStore {
  const store = new InMemoryVectorStore();
  void store.addChunks([
    chunk("a1", "function resolveRagContext() {}", "/repo/src/a.ts"),
    chunk("b1", "function ensureCosineIndex() {}", "/repo/src/b.ts"),
    chunk("q1", "npm install needs --legacy-peer-deps", "/repo/quirk:abc"),
  ]);
  return store;
}

describe("rehydrateKeywordIndex", () => {
  it("restores files the store has but the keyword index lacks", async () => {
    const store = makeStore();
    const index = new KeywordIndex();
    index.addChunks([chunk("a1", "function resolveRagContext() {}", "/repo/src/a.ts")]);

    const result = await rehydrateKeywordIndex({ store, keywordIndex: index });

    assert.equal(result.missingFiles, 1, "only the uncovered file is missing");
    assert.equal(result.rehydratedFiles, 1);
    assert.equal(result.rehydratedChunks, 1);
    assert.equal(result.failedFiles.length, 0);
    assert.equal(index.count(), 2, "both files are now searchable by keyword");
    assert.equal(index.search("ensureCosineIndex", 10).length, 1);
  });

  it("leaves a complete index untouched", async () => {
    const store = makeStore();
    const index = new KeywordIndex();
    index.addChunks([
      chunk("a1", "function resolveRagContext() {}", "/repo/src/a.ts"),
      chunk("b1", "function ensureCosineIndex() {}", "/repo/src/b.ts"),
    ]);

    const result = await rehydrateKeywordIndex({ store, keywordIndex: index });

    assert.equal(result.missingFiles, 0);
    assert.equal(result.rehydratedFiles, 0);
    assert.equal(index.count(), 2);
  });

  it("skips quirk rows — quirks.jsonl owns them", async () => {
    const store = makeStore();
    const index = new KeywordIndex();
    index.addChunks([
      chunk("a1", "function resolveRagContext() {}", "/repo/src/a.ts"),
      chunk("b1", "function ensureCosineIndex() {}", "/repo/src/b.ts"),
    ]);

    const result = await rehydrateKeywordIndex({ store, keywordIndex: index });

    assert.equal(result.missingFiles, 0, "the quirk row must not count as a gap");
    assert.equal(index.search("legacy-peer-deps", 10).length, 0);
  });

  it("is idempotent — a second run adds nothing and does not inflate BM25 scores", async () => {
    const store = makeStore();
    const index = new KeywordIndex();

    const first = await rehydrateKeywordIndex({ store, keywordIndex: index });
    assert.equal(first.rehydratedFiles, 2, "both source files are restored (the quirk row is skipped)");
    const countAfterFirst = index.count();
    const scoreAfterFirst = index.search("ensureCosineIndex", 10)[0]!.score;

    const second = await rehydrateKeywordIndex({ store, keywordIndex: index });

    assert.equal(second.missingFiles, 0);
    assert.equal(second.rehydratedFiles, 0);
    assert.equal(second.skippedChunks, 0, "the file is covered now — nothing to skip");
    assert.equal(index.count(), countAfterFirst, "no chunk was added twice");
    assert.equal(
      index.search("ensureCosineIndex", 10)[0]!.score,
      scoreAfterFirst,
      "BM25 score must not change after a repeated run",
    );
  });

  it("reports a failing file without aborting the rest", async () => {
    const broken = {
      getFilePaths: async () => ["/repo/src/broken.ts", "/repo/src/b.ts"],
      getChunksByFilePath: async (filePath: string) => {
        if (filePath.endsWith("broken.ts")) throw new Error("boom");
        return [chunk("b1", "function ensureCosineIndex() {}", "/repo/src/b.ts")];
      },
    } as unknown as InMemoryVectorStore;

    const index = new KeywordIndex();
    const result = await rehydrateKeywordIndex({ store: broken, keywordIndex: index });

    assert.equal(result.failedFiles.length, 1);
    assert.equal(result.failedFiles[0], "/repo/src/broken.ts");
    assert.equal(result.rehydratedFiles, 1, "the healthy file is still restored");
    assert.equal(index.search("ensureCosineIndex", 10).length, 1);
  });

  it("honours the maxFiles cap", async () => {
    const store = new InMemoryVectorStore();
    void store.addChunks([
      chunk("a1", "aaa", "/repo/src/a.ts"),
      chunk("b1", "bbb", "/repo/src/b.ts"),
      chunk("c1", "ccc", "/repo/src/c.ts"),
    ]);
    const index = new KeywordIndex();

    const result = await rehydrateKeywordIndex({ store, keywordIndex: index, maxFiles: 2 });

    assert.equal(result.missingFiles, 3);
    assert.equal(result.rehydratedFiles, 2);
    assert.equal(index.count(), 2);
  });

  it("survives a store that cannot list its files", async () => {
    const broken = {
      getFilePaths: async () => {
        throw new Error("store is gone");
      },
    } as unknown as InMemoryVectorStore;
    const index = new KeywordIndex();

    const result = await rehydrateKeywordIndex({ store: broken, keywordIndex: index });

    assert.equal(result.missingFiles, 0);
    assert.equal(result.rehydratedFiles, 0);
  });
});

describe("findKeywordIndexGaps", () => {
  it("lists the files the store has that the keyword index does not cover", async () => {
    const store = makeStore();
    const index = new KeywordIndex();
    index.addChunks([chunk("a1", "function resolveRagContext() {}", "/repo/src/a.ts")]);

    const gaps = await findKeywordIndexGaps(store, index);

    assert.deepEqual(gaps, ["/repo/src/b.ts"], "quirk rows are not gaps");
  });

  it("returns an empty list for a complete index", async () => {
    const store = makeStore();
    const index = new KeywordIndex();
    index.addChunks([
      chunk("a1", "function resolveRagContext() {}", "/repo/src/a.ts"),
      chunk("b1", "function ensureCosineIndex() {}", "/repo/src/b.ts"),
    ]);

    assert.deepEqual(await findKeywordIndexGaps(store, index), []);
  });
});
