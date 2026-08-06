import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryVectorStore } from "../../vectorstore/memory.js";

function makeChunk(id: string, filePath: string, startLine: number) {
  return {
    id,
    content: `content ${id}`,
    embedding: new Array(8).fill(0.1),
    metadata: { filePath, startLine, endLine: startLine + 1, language: "typescript" },
  };
}

describe("InMemoryVectorStore", () => {
  it("dedups prior revision on re-add by default", async () => {
    const store = new InMemoryVectorStore();
    await store.addChunks([makeChunk("old-1", "a.ts", 1), makeChunk("old-2", "a.ts", 2)]);
    await store.addChunks([makeChunk("new-1", "a.ts", 1), makeChunk("new-3", "a.ts", 3)]);

    const ids = (await store.getChunksByFilePath("a.ts")).map((c) => c.id).sort();
    assert.deepEqual(ids, ["new-1", "new-3"]);
  });

  it("appends without dedup when dedup: false", async () => {
    const store = new InMemoryVectorStore();
    await store.addChunks([makeChunk("v1", "a.ts", 1)]);
    await store.addChunks([makeChunk("v2", "a.ts", 1)], { dedup: false });
    assert.equal(await store.count(), 2);
  });

  it("addChunksBulk applies per-file dedup flags", async () => {
    const store = new InMemoryVectorStore();
    await store.addChunks([makeChunk("m-old", "m.ts", 1)]);
    await store.addChunksBulk([
      { chunks: [makeChunk("m-new", "m.ts", 1)], dedup: true },
      { chunks: [makeChunk("n-1", "n.ts", 1)], dedup: false },
    ]);

    assert.deepEqual(
      (await store.getChunksByFilePath("m.ts")).map((c) => c.id),
      ["m-new"],
    );
    assert.deepEqual(
      (await store.getChunksByFilePath("n.ts")).map((c) => c.id),
      ["n-1"],
    );
  });
});
