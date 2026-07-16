import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { embedBatch } from "../../embedder/factory.js";
import type { EmbeddingProvider } from "../../core/interfaces.js";

function mockEmbedder(): EmbeddingProvider & {
  calls: number;
  lastBatchSizes: number[];
} {
  const state = { calls: 0, lastBatchSizes: [] as number[] };
  return {
    name: "mock",
    get calls() { return state.calls; },
    get lastBatchSizes() { return [...state.lastBatchSizes]; },
    async embed(texts: string[], _purpose?: "query" | "document"): Promise<number[][]> {
      state.calls++;
      state.lastBatchSizes.push(texts.length);
      // Return embedding where first element encodes the call number and position
      return texts.map((_, i) => [state.calls * 100 + i]);
    },
  };
}

describe("embedBatch", () => {
  it("returns empty array for empty input", async () => {
    const m = mockEmbedder();
    const result = await embedBatch(m, []);
    assert.deepStrictEqual(result, []);
    assert.equal(m.calls, 0);
  });

  it("returns single embedding for single text", async () => {
    const m = mockEmbedder();
    const result = await embedBatch(m, ["hello"]);
    assert.equal(result.length, 1);
    assert.deepStrictEqual(result[0], [100]);
    assert.equal(m.calls, 1);
  });

  it("returns multiple embeddings for multiple texts (single batch)", async () => {
    const m = mockEmbedder();
    const result = await embedBatch(m, ["a", "b", "c"]);
    assert.equal(result.length, 3);
    assert.equal(m.calls, 1);
    assert.equal(m.lastBatchSizes[0], 3);
  });

  it("respects custom batchSize by calling embed multiple times", async () => {
    const m = mockEmbedder();
    const result = await embedBatch(m, ["a", "b", "c", "d", "e"], 2);
    assert.equal(result.length, 5);
    // 5 items / 2 = 3 batches (2, 2, 1)
    assert.equal(m.calls, 3);
    assert.deepStrictEqual(m.lastBatchSizes, [2, 2, 1]);
  });

  it("batch of exactly batchSize makes one call", async () => {
    const m = mockEmbedder();
    const result = await embedBatch(m, ["a", "b", "c"], 3);
    assert.equal(result.length, 3);
    assert.equal(m.calls, 1);
    assert.equal(m.lastBatchSizes[0], 3);
  });

  it("flattens results correctly across batches", async () => {
    const m = mockEmbedder();
    const result = await embedBatch(m, ["a", "b", "c", "d"], 2);
    assert.equal(result.length, 4);
    // Batch 1: [[100], [101]]  Batch 2: [[200], [201]]
    assert.deepStrictEqual(result, [[100], [101], [200], [201]]);
  });

  it("default batchSize is 10", async () => {
    const m = mockEmbedder();
    const texts = Array.from({ length: 25 }, (_, i) => `text-${i}`);
    const result = await embedBatch(m, texts);
    assert.equal(result.length, 25);
    // 25 items with default batchSize 10: 3 batches (10, 10, 5)
    assert.equal(m.calls, 3);
    assert.deepStrictEqual(m.lastBatchSizes, [10, 10, 5]);
  });

  it("handles single item larger than batchSize", async () => {
    const m = mockEmbedder();
    const result = await embedBatch(m, ["single"], 5);
    assert.equal(result.length, 1);
    assert.equal(m.calls, 1);
    assert.equal(m.lastBatchSizes[0], 1);
  });

  it("passes all texts in last batch even when smaller than batchSize", async () => {
    const m = mockEmbedder();
    const result = await embedBatch(m, ["a", "b", "c", "d"], 3);
    // Batch 1: 3 items, Batch 2: 1 item
    assert.equal(result.length, 4);
    assert.equal(m.calls, 2);
    assert.deepStrictEqual(m.lastBatchSizes, [3, 1]);
    // Verify last batch content: last item gets call=2 embedding
    assert.deepStrictEqual(result[3], [200]);
  });

  it("invokes onProgress after each batch with running completed count and total", async () => {
    const m = mockEmbedder();
    const progress: Array<{ completed: number; total: number }> = [];
    const result = await embedBatch(m, ["a", "b", "c", "d", "e"], 2, "document", 1, (completed, total) => {
      progress.push({ completed, total });
    });
    assert.equal(result.length, 5);
    assert.deepStrictEqual(progress, [
      { completed: 2, total: 5 },
      { completed: 4, total: 5 },
      { completed: 5, total: 5 },
    ]);
  });
});
