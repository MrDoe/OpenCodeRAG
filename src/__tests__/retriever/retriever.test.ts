import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { retrieve } from "../../retriever/retriever.js";
import { KeywordIndex } from "../../retriever/keyword-index.js";
import type {
  EmbeddingProvider,
  KeywordIndex as KeywordIndexInterface,
  VectorStore,
  SearchResult,
  Chunk,
} from "../../core/interfaces.js";

function makeEmbedder(vectors: number[][]): EmbeddingProvider {
  return {
    name: "mock",
    async embed(_texts: string[], _purpose?: "query" | "document"): Promise<number[][]> {
      return vectors;
    },
  };
}

function makeStore(results: SearchResult[]): VectorStore {
  return {
    async addChunks(_chunks: Chunk[]): Promise<void> {},
    async search(_embedding: number[], _topK: number): Promise<SearchResult[]> {
      return results;
    },
    async searchWithFilter(_embedding: number[], topK: number, filter?: any): Promise<SearchResult[]> {
      let filtered = results;
      if (filter?.kinds?.length) {
        filtered = filtered.filter((r) => filter.kinds.includes(r.chunk.metadata.kind ?? ""));
      }
      return filtered.slice(0, topK);
    },
    async count(): Promise<number> {
      return results.length;
    },
    async clear(): Promise<void> {},
    async deleteByFilePath(_filePath: string): Promise<void> {},
    async close(): Promise<void> {},
    async getFilePaths(): Promise<string[]> { return []; },
    async getChunks(): Promise<[]> { return []; },
    async listFiles(): Promise<[]> { return []; },
    async getChunksByFilePath(): Promise<[]> { return []; },
  };
}

describe("retrieve", () => {
  it("returns search results from store", async () => {
    const embedder = makeEmbedder([[0.1, 0.2, 0.3]]);
    const store = makeStore([
      {
        score: 0.95,
        chunk: {
          id: "chunk-1",
          content: "test content",
          metadata: {
            filePath: "test.ts",
            startLine: 1,
            endLine: 10,
            language: "typescript",
          },
        },
      },
    ]);

    const results = await retrieve("test query", embedder, store);
    assert.equal(results.length, 1);
    // Raw vector score from store (no keyword results — no RRF applied)
    assert.ok(Math.abs(results[0]!.score - 0.95) < 1e-10);
    assert.equal(results[0]!.chunk.id, "chunk-1");
  });

  it("returns empty array when embedding is empty", async () => {
    const embedder = makeEmbedder([[]]);
    const store = makeStore([]);

    const results = await retrieve("test query", embedder, store);
    assert.deepStrictEqual(results, []);
  });

  it("returns empty array when embeddings are empty array", async () => {
    const embedder = makeEmbedder([]);
    const store = makeStore([]);

    const results = await retrieve("test query", embedder, store);
    assert.deepStrictEqual(results, []);
  });

  it("passes custom topK to store", async () => {
    let receivedTopK = 0;
    const embedder = makeEmbedder([[0.1, 0.2]]);
    const store: VectorStore = {
      async addChunks(): Promise<void> {},
      async search(_embedding: number[], topK: number): Promise<SearchResult[]> {
        receivedTopK = topK;
        return [];
      },
      async searchWithFilter(embedding: number[], topK: number, _filter?: any): Promise<SearchResult[]> {
        return this.search(embedding, topK);
      },
      async count(): Promise<number> {
        return 0;
      },
      async clear(): Promise<void> {},
      async deleteByFilePath(_filePath: string): Promise<void> {},
      async close(): Promise<void> {},
      async getFilePaths(): Promise<string[]> { return []; },
      async getChunks(): Promise<[]> { return []; },
      async listFiles(): Promise<[]> { return []; },
      async getChunksByFilePath(): Promise<[]> { return []; },
    };

    await retrieve("query", embedder, store, { topK: 5 });
    // retrieve() multiplies topK by vectorFactor (3) for the store search
    assert.equal(receivedTopK, 15);
  });

  it("uses default topK of 10", async () => {
    let receivedTopK = 0;
    const embedder = makeEmbedder([[0.1, 0.2]]);
    const store: VectorStore = {
      async addChunks(): Promise<void> {},
      async search(_embedding: number[], topK: number): Promise<SearchResult[]> {
        receivedTopK = topK;
        return [];
      },
      async searchWithFilter(embedding: number[], topK: number, _filter?: any): Promise<SearchResult[]> {
        return this.search(embedding, topK);
      },
      async count(): Promise<number> {
        return 0;
      },
      async clear(): Promise<void> {},
      async deleteByFilePath(_filePath: string): Promise<void> {},
      async close(): Promise<void> {},
      async getFilePaths(): Promise<string[]> { return []; },
      async getChunks(): Promise<[]> { return []; },
      async listFiles(): Promise<[]> { return []; },
      async getChunksByFilePath(): Promise<[]> { return []; },
    };

    await retrieve("query", embedder, store);
    // retrieve() multiplies topK by vectorFactor (3) for the store search
    assert.equal(receivedTopK, 30);
  });

  it("filters results below minScore", async () => {
    const embedder = makeEmbedder([[0.1, 0.2, 0.3]]);
    const store = makeStore([
      { score: 0.9, chunk: { id: "a", content: "high", metadata: { filePath: "a.ts", startLine: 1, endLine: 2, language: "ts" } } },
      { score: 0.4, chunk: { id: "b", content: "low", metadata: { filePath: "b.ts", startLine: 1, endLine: 2, language: "ts" } } },
      { score: 0.7, chunk: { id: "c", content: "mid", metadata: { filePath: "c.ts", startLine: 1, endLine: 2, language: "ts" } } },
    ]);

    const results = await retrieve("query", embedder, store, { minScore: 0.59 });
    assert.equal(results.length, 2);
    // Raw vector scores from store (no keyword results — no RRF applied)
    const expectedScores = [0.9, 0.7];
    assert.ok(Math.abs(results[0]!.score - expectedScores[0]!) < 1e-10);
    assert.ok(Math.abs(results[1]!.score - expectedScores[1]!) < 1e-10);
  });

  it("returns all results when minScore is 0", async () => {
    const embedder = makeEmbedder([[0.1, 0.2, 0.3]]);
    const store = makeStore([
      { score: 0.9, chunk: { id: "a", content: "high", metadata: { filePath: "a.ts", startLine: 1, endLine: 2, language: "ts" } } },
      { score: 0.4, chunk: { id: "b", content: "low", metadata: { filePath: "b.ts", startLine: 1, endLine: 2, language: "ts" } } },
    ]);

    const results = await retrieve("query", embedder, store, { minScore: 0 });
    assert.equal(results.length, 2);
  });

  describe("hybrid search", () => {
    function makeKeywordIndex(results: SearchResult[]): KeywordIndexInterface {
      const ki = new KeywordIndex();
      ki.addChunks(results.map((r) => r.chunk));
      return ki;
    }

    it("falls back to vector-only when no keywordIndex provided", async () => {
      const embedder = makeEmbedder([[0.1, 0.2, 0.3]]);
      const store = makeStore([
        { score: 0.9, chunk: { id: "a", content: "function foo", metadata: { filePath: "a.ts", startLine: 1, endLine: 2, language: "ts" } } },
      ]);
      const results = await retrieve("query", embedder, store, { keywordIndex: undefined });
      assert.equal(results.length, 1);
    });

    it("falls back to vector-only when keywordIndex has no matches", async () => {
      const embedder = makeEmbedder([[0.1, 0.2, 0.3]]);
      const store = makeStore([
        { score: 0.9, chunk: { id: "a", content: "function foo", metadata: { filePath: "a.ts", startLine: 1, endLine: 2, language: "ts" } } },
      ]);
      const ki = new KeywordIndex();
      ki.addChunks([{ id: "b", content: "unrelated data", metadata: { filePath: "b.ts", startLine: 1, endLine: 2, language: "ts" } }]);
      const results = await retrieve("query with no keyword match", embedder, store, { keywordIndex: ki });
      assert.equal(results.length, 1);
    });

    it("combines vector and keyword results with default weight", async () => {
      const embedder = makeEmbedder([[0.1, 0.2, 0.3]]);
      const store = makeStore([
        { score: 0.8, chunk: { id: "a", content: "apple banana", metadata: { filePath: "a.ts", startLine: 1, endLine: 2, language: "ts" } } },
      ]);
      const ki = makeKeywordIndex([
        { score: 0, chunk: { id: "b", content: "apple banana cherry", metadata: { filePath: "b.ts", startLine: 1, endLine: 2, language: "ts" } } },
      ]);
      const results = await retrieve("apple banana", embedder, store, { keywordIndex: ki, keywordWeight: 0.4, minScore: 0 });
      assert.equal(results.length, 2);
      // With RRF and kw=0.4, vector-only (a) at rank 0 contributes (1-0.4)/(60+1) = 0.6/61
      // vs keyword-only (b) at rank 0 contributes 0.4/(60+1) = 0.4/61
      // vector-only ranks higher since vWeight > kWeight for equal ranks
      assert.equal(results[0]!.chunk.id, "a");
    });

    it("respects keywordWeight parameter", async () => {
      const embedder = makeEmbedder([[0.1, 0.2, 0.3]]);
      const store = makeStore([
        { score: 0.9, chunk: { id: "a", content: "some code", metadata: { filePath: "a.ts", startLine: 1, endLine: 2, language: "ts" } } },
      ]);
      const ki = makeKeywordIndex([
        { score: 0, chunk: { id: "b", content: "specific keyword match content here", metadata: { filePath: "b.ts", startLine: 1, endLine: 2, language: "ts" } } },
      ]);
      const kwResults = await retrieve("keyword match", embedder, store, { keywordIndex: ki, keywordWeight: 0.9, minScore: 0 });
      const vecResults = await retrieve("keyword match", embedder, store, { keywordIndex: ki, keywordWeight: 0.1, minScore: 0 });
      assert.equal(kwResults.length, 2);
      assert.equal(vecResults.length, 2);
    });

    it("applies minScore filter on combined scores", async () => {
      const embedder = makeEmbedder([[0.1, 0.2, 0.3]]);
      const store = makeStore([
        { score: 0.1, chunk: { id: "a", content: "low relevance", metadata: { filePath: "a.ts", startLine: 1, endLine: 2, language: "ts" } } },
      ]);
      const ki = makeKeywordIndex([]);
      const results = await retrieve("test", embedder, store, { keywordIndex: ki, minScore: 0.7 });
      assert.equal(results.length, 0);
    });

    it("skips keyword search when hybridEnabled is false", async () => {
      const embedder = makeEmbedder([[0.1, 0.2, 0.3]]);
      const store = makeStore([
        { score: 0.8, chunk: { id: "a", content: "apple banana", metadata: { filePath: "a.ts", startLine: 1, endLine: 2, language: "ts" } } },
        { score: 0.5, chunk: { id: "b", content: "unrelated content", metadata: { filePath: "b.ts", startLine: 1, endLine: 2, language: "ts" } } },
      ]);
      const ki = makeKeywordIndex([
        { score: 0, chunk: { id: "c", content: "apple banana cherry", metadata: { filePath: "c.ts", startLine: 1, endLine: 2, language: "ts" } } },
      ]);
      const results = await retrieve("apple banana", embedder, store, {
        keywordIndex: ki,
        keywordWeight: 0.4,
        hybridEnabled: false,
        minScore: 0,
      });
      // Only vector results returned, keyword chunk "c" is not in results
      assert.equal(results.length, 2);
      assert.ok(!results.some((r) => r.chunk.id === "c"));
    });

    it("normalizes vector scores in hybrid fusion", async () => {
      const embedder = makeEmbedder([[0.1, 0.2, 0.3]]);
      const store = makeStore([
        { score: 0.8, chunk: { id: "a", content: "apple banana", metadata: { filePath: "a.ts", startLine: 1, endLine: 2, language: "ts" } } },
        { score: 0.4, chunk: { id: "b", content: "apple", metadata: { filePath: "b.ts", startLine: 1, endLine: 2, language: "ts" } } },
      ]);
      const ki = makeKeywordIndex([
        { score: 0, chunk: { id: "a", content: "apple banana", metadata: { filePath: "a.ts", startLine: 1, endLine: 2, language: "ts" } } },
      ]);
      const results = await retrieve("apple banana", embedder, store, {
        keywordIndex: ki,
        keywordWeight: 0.4,
        minScore: 0,
      });
      assert.equal(results.length, 2);
      // With RRF, chunk "a" (hybrid, rank 0 in both) gets score = (1-0.4)/(60+1) + 0.4/(60+1)
      // Chunk "b" (vector-only, rank 1) gets score = (1-0.4)/(60+2)
      const chunkA = results.find((r) => r.chunk.id === "a");
      const chunkB = results.find((r) => r.chunk.id === "b");
      assert.notEqual(chunkA, undefined);
      assert.notEqual(chunkB, undefined);
      assert.ok(chunkA!.score > chunkB!.score, "hybrid result should rank above vector-only");
    });
  });

  describe("explain", () => {
    function makeKI(chunks: SearchResult[]): KeywordIndexInterface {
      const ki = new KeywordIndex();
      ki.addChunks(chunks.map((r) => r.chunk));
      return ki;
    }

    it("omits explanation when explain is not set", async () => {
      const embedder = makeEmbedder([[0.1, 0.2, 0.3]]);
      const store = makeStore([
        { score: 0.9, chunk: { id: "a", content: "apple banana", metadata: { filePath: "a.ts", startLine: 1, endLine: 2, language: "ts" } } },
      ]);
      const results = await retrieve("apple", embedder, store);
      assert.equal(results.length, 1);
      assert.equal(results[0]!.explanation, undefined);
    });

    it("omits explanation when explain is false", async () => {
      const embedder = makeEmbedder([[0.1, 0.2, 0.3]]);
      const store = makeStore([
        { score: 0.9, chunk: { id: "a", content: "apple banana", metadata: { filePath: "a.ts", startLine: 1, endLine: 2, language: "ts" } } },
      ]);
      const results = await retrieve("apple", embedder, store, { explain: false });
      assert.equal(results.length, 1);
      assert.equal(results[0]!.explanation, undefined);
    });

    it("populates explanation when explain is true (vector-only)", async () => {
      const embedder = makeEmbedder([[0.1, 0.2, 0.3]]);
      const store = makeStore([
        { score: 0.8, chunk: { id: "a", content: "test content", metadata: { filePath: "a.ts", startLine: 1, endLine: 2, language: "ts" } } },
      ]);
      const results = await retrieve("test", embedder, store, { explain: true, minScore: 0 });
      assert.equal(results.length, 1);
      const exp = results[0]!.explanation;
      assert.notEqual(exp, undefined);
      assert.equal(exp!.scoreBreakdown.rawVectorScore, 0.8);
      assert.equal(exp!.scoreBreakdown.keywordScore, 0);
      assert.equal(exp!.scoreBreakdown.rawKeywordScore, 0);
      assert.equal(exp!.scoreBreakdown.keywordWeight, 0.4);
      assert.equal(exp!.matchedTerms, undefined);
      // Raw vector score from store (no keyword results — no RRF applied)
      assert.equal(exp!.scoreBreakdown.vectorScore, 0.8);
      // vectorRank omitted in no-keyword path (only set in hybrid path)
    });

    it("populates explanation with keyword scores when keywordIndex provided", async () => {
      const embedder = makeEmbedder([[0.1, 0.2, 0.3]]);
      const store = makeStore([
        { score: 0.8, chunk: { id: "a", content: "apple banana", metadata: { filePath: "a.ts", startLine: 1, endLine: 2, language: "ts" } } },
      ]);
      const ki = makeKI([
        { score: 0, chunk: { id: "b", content: "apple banana cherry", metadata: { filePath: "b.ts", startLine: 1, endLine: 2, language: "ts" } } },
      ]);
      const results = await retrieve("apple banana", embedder, store, { keywordIndex: ki, keywordWeight: 0.4, explain: true, minScore: 0 });
      assert.ok(results.length >= 1);
      const chunkA = results.find((r) => r.chunk.id === "a");
      assert.notEqual(chunkA, undefined);
      const exp = chunkA!.explanation;
      assert.notEqual(exp, undefined);
      assert.equal(exp!.scoreBreakdown.rawVectorScore, 0.8);
      assert.equal(exp!.scoreBreakdown.keywordWeight, 0.4);
      assert.ok(typeof exp!.scoreBreakdown.keywordScore === "number");
      assert.ok(typeof exp!.scoreBreakdown.rawKeywordScore === "number");
      // RRF: chunk "a" is vector-only at rank 0, no keyword match
      assert.equal(exp!.scoreBreakdown.vectorRank, 0);
      assert.equal(exp!.scoreBreakdown.keywordRank, undefined);
      const expectedVScore = (1 - 0.4);
      assert.ok(Math.abs(exp!.scoreBreakdown.vectorScore - expectedVScore) < 1e-10);
    });
    it("includes matchedTerms when keywordIndex matches the chunk", async () => {
      const embedder = makeEmbedder([[0.1, 0.2, 0.3]]);
      const store = makeStore([
        { score: 0.8, chunk: { id: "a", content: "apple banana", metadata: { filePath: "a.ts", startLine: 1, endLine: 2, language: "ts" } } },
      ]);
      const ki = makeKI([
        { score: 0, chunk: { id: "a", content: "apple banana", metadata: { filePath: "a.ts", startLine: 1, endLine: 2, language: "ts" } } },
      ]);
      const results = await retrieve("apple banana", embedder, store, { keywordIndex: ki, keywordWeight: 0.4, explain: true, minScore: 0 });
      const chunkA = results.find((r) => r.chunk.id === "a");
      assert.notEqual(chunkA, undefined);
      const exp = chunkA!.explanation;
      assert.notEqual(exp, undefined);
      assert.ok(Array.isArray(exp!.matchedTerms));
      assert.ok(exp!.matchedTerms!.length > 0);
      assert.ok(exp!.matchedTerms!.includes("apple"));
      assert.ok(exp!.matchedTerms!.includes("banana"));
    });

    it("omits matchedTerms when keywordIndex has no matches for chunk", async () => {
      const embedder = makeEmbedder([[0.1, 0.2, 0.3]]);
      const store = makeStore([
        { score: 0.8, chunk: { id: "a", content: "unrelated content", metadata: { filePath: "a.ts", startLine: 1, endLine: 2, language: "ts" } } },
      ]);
      const ki = makeKI([
        { score: 0, chunk: { id: "b", content: "apple banana", metadata: { filePath: "b.ts", startLine: 1, endLine: 2, language: "ts" } } },
      ]);
      const results = await retrieve("apple banana", embedder, store, { keywordIndex: ki, keywordWeight: 0.4, explain: true, minScore: 0 });
      const chunkA = results.find((r) => r.chunk.id === "a");
      assert.notEqual(chunkA, undefined);
      const exp = chunkA!.explanation;
      assert.notEqual(exp, undefined);
      assert.equal(exp!.matchedTerms, undefined);
    });

    it("omits matchedTerms when no keywordIndex provided", async () => {
      const embedder = makeEmbedder([[0.1, 0.2, 0.3]]);
      const store = makeStore([
        { score: 0.8, chunk: { id: "a", content: "apple banana", metadata: { filePath: "a.ts", startLine: 1, endLine: 2, language: "ts" } } },
      ]);
      const results = await retrieve("apple banana", embedder, store, { explain: true, minScore: 0 });
      const exp = results[0]!.explanation;
      assert.notEqual(exp, undefined);
      assert.equal(exp!.matchedTerms, undefined);
    });

    it("computes correct combined score in explanation", async () => {
      const embedder = makeEmbedder([[0.1, 0.2, 0.3]]);
      const store = makeStore([
        { score: 0.6, chunk: { id: "a", content: "apple banana", metadata: { filePath: "a.ts", startLine: 1, endLine: 2, language: "ts" } } },
      ]);
      const ki = makeKI([
        { score: 0, chunk: { id: "a", content: "apple banana", metadata: { filePath: "a.ts", startLine: 1, endLine: 2, language: "ts" } } },
      ]);
      const results = await retrieve("apple banana", embedder, store, { keywordIndex: ki, keywordWeight: 0.4, explain: true, minScore: 0 });
      const r = results[0]!;
      const exp = r.explanation!;
      // With RRF, the combined score is the sum of RRF contributions
      const expectedCombined = exp.scoreBreakdown.vectorScore + exp.scoreBreakdown.keywordScore;
      assert.ok(Math.abs(r.score - expectedCombined) < 1e-10, `expected ${expectedCombined}, got ${r.score}`);
    });
  });

  describe("kinds filter", () => {
    it("filters by kind when passed in retrieve options", async () => {
      const embedder = makeEmbedder([[0.1, 0.2, 0.3]]);
      const store = makeStore([
        { score: 0.9, chunk: { id: "q1", content: "quirk content", metadata: { filePath: "q1", startLine: 0, endLine: 0, language: "quirk", kind: "quirk", quirkType: "gotcha", tags: ["test"] } } },
        { score: 0.8, chunk: { id: "c1", content: "code content", metadata: { filePath: "c1.ts", startLine: 1, endLine: 5, language: "typescript" } } },
      ]);
      const ki = new KeywordIndex();
      ki.addChunks([
        { id: "q1", content: "quirk content", metadata: { filePath: "q1", startLine: 0, endLine: 0, language: "quirk", kind: "quirk" } },
        { id: "c1", content: "code content", metadata: { filePath: "c1.ts", startLine: 1, endLine: 5, language: "typescript" } },
      ]);
      // Filter by kinds: only quirks
      const results = await retrieve("content", embedder, store, {
        keywordIndex: ki,
        keywordWeight: 0.4,
        minScore: 0,
        filter: { kinds: ["quirk"] },
      });
      assert.equal(results.length, 1, "should return only the quirk chunk");
      assert.equal(results[0]!.chunk.id, "q1");
    });

    it("returns empty when no chunks match the filter", async () => {
      const embedder = makeEmbedder([[0.1, 0.2, 0.3]]);
      const store = makeStore([
        { score: 0.9, chunk: { id: "c1", content: "code", metadata: { filePath: "c1.ts", startLine: 1, endLine: 5, language: "typescript" } } },
      ]);
      const results = await retrieve("code", embedder, store, { filter: { kinds: ["quirk"] } });
      assert.equal(results.length, 0, "should return no results when filter excludes all");
    });
  });
});
