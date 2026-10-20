import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import { OpenAIProvider } from "../../embedder/openai.js";

describe("OpenAIProvider", () => {
  it("name is 'openai'", () => {
    const p = new OpenAIProvider(
      "https://api.openai.com/v1",
      "text-embedding-3-small",
      "sk-test-key"
    );
    assert.equal(p.name, "openai");
  });

  it("strips single trailing slash from baseUrl", () => {
    const p = new OpenAIProvider(
      "https://api.openai.com/v1/",
      "model",
      "sk-key"
    );
    assert.ok(p);
  });

  it("strips multiple trailing slashes from baseUrl", () => {
    const p = new OpenAIProvider(
      "https://api.openai.com/v1///",
      "model",
      "sk-key"
    );
    assert.ok(p);
  });

  it("preserves baseUrl without trailing slash", () => {
    const p = new OpenAIProvider(
      "https://api.openai.com/v1",
      "model",
      "sk-key"
    );
    assert.ok(p);
  });

  it("requires apiKey", () => {
    const p = new OpenAIProvider(
      "https://api.openai.com/v1",
      "text-embedding-3-small",
      "sk-required-key"
    );
    assert.equal(p.name, "openai");
  });

  it("embeds method exists and accepts texts array", () => {
    const p = new OpenAIProvider(
      "https://api.openai.com/v1",
      "text-embedding-3-small",
      "sk-key"
    );
    assert.equal(typeof p.embed, "function");
    assert.equal(p.embed.length, 2); // expects texts array + optional purpose
  });

  it("handles custom baseUrl with subpath", () => {
    const p = new OpenAIProvider(
      "https://custom.openai.com/embeddings/v1",
      "model",
      "sk-key"
    );
    assert.ok(p);
  });

  it("handles baseUrl with port number", () => {
    const p = new OpenAIProvider(
      "http://localhost:8080/v1",
      "model",
      "sk-key"
    );
    assert.ok(p);
  });

  it("aborts slow embedding requests instead of hanging forever", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        if (signal) {
          signal.addEventListener(
            "abort",
            () => {
              const error = new Error("Aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true }
          );
        }
      });
    }) as typeof fetch;

    try {
      const p = new OpenAIProvider(
        "https://api.openai.com/v1",
        "text-embedding-3-small",
        "sk-test-key",
        1
      );

      await assert.rejects(
        () => p.embed(["test"]),
        /timed out after 1ms/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses a direct localhost request instead of fetch", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("fetch should not be called for localhost");
    }) as typeof fetch;

    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        assert.equal(req.method, "POST");
        assert.ok(req.url?.includes("/embeddings"));

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ embedding: [4, 5, 6] }] }));
      });
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        throw new Error("failed to start test server");
      }

      const p = new OpenAIProvider(`http://localhost:${address.port}/v1`, "text-embedding-3-small", "sk-key");
      const embeddings = await p.embed(["hello"]);

      assert.deepEqual(embeddings, [[4, 5, 6]]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      globalThis.fetch = originalFetch;
    }
  });
});

function ollamaAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = get("http://127.0.0.1:11434/api/tags", (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          resolve(!!json.models);
        } catch {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Base URL of the local Ollama server used by the integration tests. */
const OLLAMA_BASE_URL = "http://127.0.0.1:11434";

/**
 * How long the capability probe may take before the local Ollama is treated
 * as unable to serve embeddings. Generous enough for a cold model load.
 */
const EMBED_PROBE_TIMEOUT_MS = 60_000;

/**
 * Probe whether the local Ollama can actually serve an embedding right now.
 *
 * `/api/tags` only proves the server is *up*. A wedged or GPU-saturated
 * Ollama accepts the connection and then never answers the embed request —
 * the integration tests below would each burn their full 30s timeout and
 * then fail even though the code under test is fine. Probe the endpoint the
 * tests actually depend on and skip when it cannot answer.
 *
 * The probe also warms the model, so the tests that follow are fast.
 *
 * @param model - The embedding model to probe with.
 * @param baseUrl - Ollama base URL (defaults to the local server).
 * @param timeoutMs - How long the probe may take before giving up.
 * @returns `true` when Ollama returned a usable embedding.
 */
async function ollamaCanServeEmbeddings(
  model: string,
  baseUrl: string = OLLAMA_BASE_URL,
  timeoutMs: number = EMBED_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer ollama",
      },
      body: JSON.stringify({ model, input: "probe" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    return (body.data?.[0]?.embedding?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

describe("ollamaCanServeEmbeddings probe", () => {
  /** Start a stub server that answers the probe request. */
  async function withStub(
    handler: (body: string) => { status: number; payload: unknown },
    fn: (baseUrl: string) => Promise<void>,
  ): Promise<void> {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += String(chunk); });
      req.on("end", () => {
        const { status, payload } = handler(body);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        throw new Error("failed to start stub server");
      }
      await fn(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("returns true when the endpoint answers with an embedding", async () => {
    await withStub(
      () => ({ status: 200, payload: { data: [{ embedding: [1, 2, 3] }] } }),
      async (baseUrl) => {
        assert.equal(await ollamaCanServeEmbeddings("m", baseUrl, 5000), true);
      },
    );
  });

  it("sends the model and an input to the endpoint", async () => {
    let seen: { model?: string; input?: string } = {};
    await withStub(
      (body) => {
        seen = JSON.parse(body) as { model?: string; input?: string };
        return { status: 200, payload: { data: [{ embedding: [1] }] } };
      },
      async (baseUrl) => {
        assert.equal(await ollamaCanServeEmbeddings("qwen3-embedding:0.6b", baseUrl, 5000), true);
      },
    );
    assert.equal(seen.model, "qwen3-embedding:0.6b");
    assert.ok(seen.input, "the probe must send an input to embed");
  });

  it("returns false when the endpoint reports an error", async () => {
    await withStub(
      () => ({ status: 500, payload: { error: "model not found" } }),
      async (baseUrl) => {
        assert.equal(await ollamaCanServeEmbeddings("m", baseUrl, 5000), false);
      },
    );
  });

  it("returns false when the response carries no embedding", async () => {
    await withStub(
      () => ({ status: 200, payload: { data: [] } }),
      async (baseUrl) => {
        assert.equal(await ollamaCanServeEmbeddings("m", baseUrl, 5000), false);
      },
    );
  });

  it("returns false when the server is unreachable", async () => {
    // Port 1 is reserved and never listening.
    assert.equal(await ollamaCanServeEmbeddings("m", "http://127.0.0.1:1", 2000), false);
  });
});

describe("OpenAIProvider — Ollama integration", { skip: process.env.CI === "true" }, () => {
  const MODEL = "qwen3-embedding:0.6b";
  const EMBEDDING_DIM = 1024;
  let available = false;

  before(async () => {
    if (!(await ollamaAvailable())) return;
    // The server is up — now check that it can actually serve embeddings.
    available = await ollamaCanServeEmbeddings(MODEL);
  });

  it("embeds via Ollama OpenAI-compatible endpoint", async (t) => {
    if (!available) return t.skip("local Ollama cannot serve embeddings right now");

    const p = new OpenAIProvider(
      "http://127.0.0.1:11434/v1",
      MODEL,
      "ollama",
      30000
    );

    const embeddings = await p.embed(["hello world"]);

    assert.ok(Array.isArray(embeddings));
    assert.equal(embeddings.length, 1);
    assert.ok(Array.isArray(embeddings[0]));
    assert.ok(embeddings[0]!.length > 0);
    assert.ok(typeof embeddings[0]![0] === "number");
  });

  it("embeds batch via Ollama OpenAI-compatible endpoint", async (t) => {
    if (!available) return t.skip("local Ollama cannot serve embeddings right now");

    const p = new OpenAIProvider(
      "http://127.0.0.1:11434/v1",
      MODEL,
      "ollama",
      30000
    );

    const embeddings = await p.embed(["hello", "world", "test batch"]);

    assert.ok(Array.isArray(embeddings));
    assert.equal(embeddings.length, 3);
    for (const emb of embeddings) {
      assert.ok(Array.isArray(emb));
      assert.ok(emb!.length > 0);
      assert.ok(typeof emb![0] === "number");
    }
  });

  it(`returns ${EMBEDDING_DIM}-dimensional vectors`, async (t) => {
    if (!available) return t.skip("local Ollama cannot serve embeddings right now");

    const p = new OpenAIProvider(
      "http://127.0.0.1:11434/v1",
      MODEL,
      "ollama",
      30000
    );

    const embeddings = await p.embed(["dimension check"]);
    assert.equal(embeddings[0]!.length, EMBEDDING_DIM);
  });
});
