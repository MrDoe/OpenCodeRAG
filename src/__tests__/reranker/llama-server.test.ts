import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { RerankProviderBase } from "../../reranker/base.js";
import { LlamaServerReranker } from "../../reranker/llama-server.js";
import { destroyAllPooledConnections } from "../../embedder/http.js";

interface RecordedRequest {
  body: { model?: string; query?: string; documents?: string[] };
  auth?: string;
}

/** Start a mock /v1/rerank server; `handler` decides the response per request. */
async function startRerankServer(
  handler: (req: RecordedRequest, callIndex: number) => unknown,
): Promise<{ server: Server; url: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const parsed: RecordedRequest = {
        body: raw ? JSON.parse(raw) : { body: {} as never },
        auth: req.headers.authorization,
      };
      requests.push(parsed);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(handler(parsed, requests.length - 1)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}/v1`, requests };
}

describe("LlamaServerReranker", () => {
  after(() => { destroyAllPooledConnections(); });

  it("maps relevance scores index-aligned", async () => {
    const { server, url, requests } = await startRerankServer((req) => ({
      results: (req.body.documents ?? []).map((doc, i) => ({
        index: i,
        relevance_score: doc === "second" ? 0.9 : 0.1,
      })),
    }));
    try {
      const provider = new LlamaServerReranker({ baseUrl: url, model: "test-reranker" });
      const scores = await provider.rerank("q", ["first", "second", "third"]);
      assert.deepEqual(scores, [0.1, 0.9, 0.1]);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.body.model, "test-reranker");
      assert.equal(requests[0]!.body.query, "q");
      assert.deepEqual(requests[0]!.body.documents, ["first", "second", "third"]);
    } finally {
      server.close();
    }
  });

  it("sends the bearer token when an apiKey is configured", async () => {
    const { server, url, requests } = await startRerankServer((req) => ({
      results: (req.body.documents ?? []).map((_: string, i: number) => ({ index: i, relevance_score: 0.5 })),
    }));
    try {
      const provider = new LlamaServerReranker({ baseUrl: url, model: "m", apiKey: "sk-test" });
      await provider.rerank("q", ["doc"]);
      assert.equal(requests[0]!.auth, "Bearer sk-test");
    } finally {
      server.close();
    }
  });

  it("serves repeat queries from cache without a second request", async () => {
    let calls = 0;
    const { server, url, requests } = await startRerankServer((req) => {
      calls++;
      return { results: (req.body.documents ?? []).map((_: string, i: number) => ({ index: i, relevance_score: 0.42 })) };
    });
    try {
      const provider = new LlamaServerReranker({ baseUrl: url, model: "cache-model" });
      const first = await provider.rerank("same", ["doc a", "doc b"]);
      const second = await provider.rerank("same", ["doc a", "doc b"]);
      assert.deepEqual(second, first);
      assert.equal(calls, 1);
      assert.equal(requests.length, 1);

      // Different document set with one overlap: only the unknown doc is fetched.
      await provider.rerank("same", ["doc a", "doc c"]);
      assert.equal(calls, 2);
      assert.deepEqual(requests[1]!.body.documents, ["doc c"]);
    } finally {
      server.close();
    }
  });

  it("splits large document sets into batches", async () => {
    const { server, url, requests } = await startRerankServer((req) => ({
      results: (req.body.documents ?? []).map((_: string, i: number) => ({ index: i, relevance_score: 0.25 })),
    }));
    try {
      const provider = new LlamaServerReranker(
        { baseUrl: url, model: "batch-model" },
        { maxDocsPerRequest: 2 },
      );
      const docs = ["d1", "d2", "d3", "d4", "d5"];
      const scores = await provider.rerank("q", docs);
      assert.equal(scores.length, 5);
      assert.ok(scores.every((s) => Math.abs(s - 0.25) < 1e-9));
      assert.equal(requests.length, 3);
      assert.deepEqual(requests.map((r) => r.body.documents?.length ?? 0), [2, 2, 1]);
    } finally {
      server.close();
    }
  });

  it("throws on non-ok responses so callers can degrade", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const provider = new LlamaServerReranker({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "m" });
      await assert.rejects(() => provider.rerank("q", ["doc"]), /rerank failed \(404\)/);
    } finally {
      server.close();
    }
  });

  it("throws when the response has no usable relevance scores", async () => {
    const { server, url } = await startRerankServer(() => ({ results: [{ index: 99, relevance_score: 1 }] }));
    try {
      const provider = new LlamaServerReranker({ baseUrl: url, model: "m" });
      await assert.rejects(() => provider.rerank("q", ["doc"]), /no usable relevance_score/);
    } finally {
      server.close();
    }
  });
});

describe("RerankProviderBase cooldown", () => {
  class StubReranker extends RerankProviderBase {
    readonly name = "stub";
    async rerank(_query: string, documents: string[]): Promise<number[]> {
      return documents.map(() => 0.5);
    }
  }

  it("trips the cooldown after the configured failure streak and resets on success", () => {
    const provider = new StubReranker("stub-model", { cooldownThreshold: 3, cooldownMs: 60_000 });
    assert.equal(provider.available(), true);

    provider.noteFailure();
    provider.noteFailure();
    assert.equal(provider.available(), true, "two failures must not trip the cooldown yet");

    provider.noteFailure();
    assert.equal(provider.available(), false, "the third failure trips the cooldown");

    // A new provider is unaffected; success on a fresh streak prevents tripping.
    const other = new StubReranker("stub-model", { cooldownThreshold: 3, cooldownMs: 60_000 });
    other.noteFailure();
    other.noteSuccess();
    other.noteFailure();
    other.noteFailure();
    assert.equal(other.available(), true);
  });
});
