import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { retrieve } from "../../retriever/retriever.js";
import type {
  Chunk,
  EmbeddingProvider,
  RerankProvider,
  VectorStore,
  SearchResult,
} from "../../core/interfaces.js";

function makeEmbedder(): EmbeddingProvider {
  return {
    name: "mock",
    async embed(): Promise<number[][]> {
      return [[0.1, 0.2, 0.3]];
    },
  };
}

function makeStore(results: SearchResult[]): VectorStore {
  return {
    async addChunks(): Promise<void> {},
    async search(): Promise<SearchResult[]> { return results; },
    async searchWithFilter(_embedding: number[], topK: number): Promise<SearchResult[]> {
      return results.slice(0, topK);
    },
    async count(): Promise<number> { return results.length; },
    async clear(): Promise<void> {},
    async deleteByFilePath(): Promise<void> {},
    async close(): Promise<void> {},
    async getFilePaths(): Promise<string[]> { return []; },
    async getChunks(): Promise<[]> { return []; },
    async listFiles(): Promise<[]> { return []; },
    async getChunksByFilePath(): Promise<[]> { return []; },
  };
}

function chunk(id: string, content: string, description?: string): Chunk {
  return {
    id,
    content,
    description,
    metadata: { filePath: `src/${id}.ts`, startLine: 1, endLine: 5, language: "typescript" },
  };
}

/** Deterministic fake: scores docs by substring matches against a spec map. */
function makeFakeReranker(
  scoreFor: (query: string, doc: string) => number,
  options: { available?: boolean; fail?: boolean } = {},
): RerankProvider & { calls: { query: string; docs: string[] }[]; failures: number; successes: number } {
  const provider = {
    name: "fake",
    model: "fake-model",
    calls: [] as { query: string; docs: string[] }[],
    failures: 0,
    successes: 0,
    available: () => options.available ?? true,
    rerank: async (query: string, docs: string[]) => {
      if (options.fail) throw new Error("provider down");
      provider.calls.push({ query, docs });
      return docs.map((d) => scoreFor(query, d));
    },
    noteFailure: () => { provider.failures += 1; },
    noteSuccess: () => { provider.successes += 1; },
  };
  return provider;
}

const store = () => makeStore([
  { score: 0.9, chunk: chunk("a", "alpha content") },
  { score: 0.8, chunk: chunk("b", "beta content", "beta description") },
  { score: 0.7, chunk: chunk("c", "gamma content") },
]);

describe("retrieve() rerank stage", () => {
  it("without a reranker behaves exactly as before (fusion order, sliced topK)", async () => {
    const results = await retrieve("q", makeEmbedder(), store(), { topK: 2, minScore: 0 });
    assert.equal(results.length, 2);
    assert.deepEqual(results.map((r) => r.chunk.id), ["a", "b"]);
    assert.ok(Math.abs(results[0]!.score - 0.9) < 1e-10);
  });

  it("reorders by rerank score and replaces result.score", async () => {
    const reranker = makeFakeReranker((_q, doc) => (doc.includes("gamma") ? 0.99 : 0.01));
    const results = await retrieve("q", makeEmbedder(), store(), {
      topK: 3, minScore: 0, reranker,
    });
    assert.deepEqual(results.map((r) => r.chunk.id), ["c", "a", "b"]);
    assert.ok(Math.abs(results[0]!.score - 0.99) < 1e-10);
    assert.equal(reranker.successes, 1);
  });

  it("records rerankScore in the explanation when explain is enabled", async () => {
    const reranker = makeFakeReranker((_q, doc) => (doc.includes("beta") ? 0.5 : 0.2));
    const results = await retrieve("q", makeEmbedder(), store(), {
      topK: 3, minScore: 0, explain: true, reranker,
    });
    const beta = results.find((r) => r.chunk.id === "b");
    assert.ok(beta?.explanation);
    assert.ok(Math.abs((beta.explanation.scoreBreakdown.rerankScore ?? 0) - 0.5) < 1e-10);
    // Fusion components remain untouched for attribution.
    assert.ok(beta.explanation.scoreBreakdown.rawVectorScore > 0);
  });

  it("uses description+content documents when docField asks for it", async () => {
    const reranker = makeFakeReranker((_q, doc) => (doc.includes("beta description") ? 1 : 0));
    await retrieve("q", makeEmbedder(), store(), {
      topK: 3, minScore: 0, reranker, reranking: { docField: "content+description" },
    });
    assert.ok(reranker.calls[0]!.docs.some((d) => d.includes("beta description")));
  });

  it("truncates documents to maxDocChars", async () => {
    const longChunk = chunk("long", "x".repeat(5000));
    const reranker = makeFakeReranker(() => 0.5);
    await retrieve("q", makeEmbedder(), makeStore([{ score: 0.9, chunk: longChunk }]), {
      topK: 1, minScore: 0, reranker, reranking: { maxDocChars: 100 },
    });
    assert.equal(reranker.calls[0]!.docs[0]!.length, 100);
  });

  it("applies the query template with {query} substitution", async () => {
    const reranker = makeFakeReranker(() => 0.5);
    await retrieve("find stuff", makeEmbedder(), store(), {
      topK: 3, minScore: 0, reranker,
      reranking: { queryTemplate: "Instruct: retrieve code\nQuery: {query}" },
    });
    assert.equal(reranker.calls[0]!.query, "Instruct: retrieve code\nQuery: find stuff");
  });

  it("applies the query template as a prefix without a placeholder", async () => {
    const reranker = makeFakeReranker(() => 0.5);
    await retrieve("find stuff", makeEmbedder(), store(), {
      topK: 3, minScore: 0, reranker,
      reranking: { queryTemplate: "PREFIX:" },
    });
    assert.equal(reranker.calls[0]!.query, "PREFIX:find stuff");
  });

  it("gates on the rerank score only when reranking.minScore > 0", async () => {
    const reranker = makeFakeReranker((_q, doc) => (doc.includes("gamma") ? 0.1 : 0.9));
    const gated = await retrieve("q", makeEmbedder(), store(), {
      topK: 3, minScore: 0, reranker, reranking: { minScore: 0.5 },
    });
    assert.deepEqual(gated.map((r) => r.chunk.id), ["a", "b"]);

    const ungated = await retrieve("q", makeEmbedder(), store(), {
      topK: 3, minScore: 0, reranker,
    });
    assert.deepEqual(ungated.map((r) => r.chunk.id), ["a", "b", "c"]);
  });

  it("caps the pool at candidates (never below topK) and never scores beyond it", async () => {
    const many = ["a", "b", "c", "d", "e"].map((id, i) => ({
      score: 1 - i * 0.1,
      chunk: chunk(id, `${id} content`),
    }));
    // candidates=4 with topK=3 → pool [a,b,c,d]; "e" is never sent to the
    // reranker even though it would hypothetically score highest.
    const reranker = makeFakeReranker((_q, doc) => (doc.includes("e content") ? 0.99 : 0.1));
    const results = await retrieve("q", makeEmbedder(), makeStore(many), {
      topK: 3, minScore: 0, reranker, reranking: { candidates: 4 },
    });
    assert.deepEqual(results.map((r) => r.chunk.id), ["a", "b", "c"]);
    assert.deepEqual(reranker.calls[0]!.docs.map((d) => d.split(" ")[0]), ["a", "b", "c", "d"]);
  });

  it("degrades to fusion order and notes failure when the provider throws", async () => {
    const reranker = makeFakeReranker(() => 0.5, { fail: true });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const results = await retrieve("q", makeEmbedder(), store(), {
        topK: 3, minScore: 0, reranker,
      });
      assert.deepEqual(results.map((r) => r.chunk.id), ["a", "b", "c"]);
      assert.equal(reranker.failures, 1);
      assert.equal(reranker.successes, 0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("skips the provider entirely while it is cooling down", async () => {
    const reranker = makeFakeReranker(() => 0.99, { available: false });
    const results = await retrieve("q", makeEmbedder(), store(), {
      topK: 3, minScore: 0, reranker,
    });
    assert.deepEqual(results.map((r) => r.chunk.id), ["a", "b", "c"]);
    assert.equal(reranker.calls.length, 0);
  });

  it("runs on the no-keyword-results early-return path too", async () => {
    // No keywordIndex → the early-return path. The reranker must still reorder.
    const reranker = makeFakeReranker((_q, doc) => (doc.includes("gamma") ? 1 : 0));
    const results = await retrieve("q", makeEmbedder(), store(), {
      topK: 3, minScore: 0, reranker, explain: true,
    });
    assert.deepEqual(results.map((r) => r.chunk.id), ["c", "a", "b"]);
    assert.ok(results.every((r) => r.explanation?.scoreBreakdown.rerankScore !== undefined));
  });
});
