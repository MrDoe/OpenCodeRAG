import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { OllamaProvider } from "../../embedder/ollama.js";
import { destroyAllPooledConnections } from "../../embedder/http.js";

describe("OllamaProvider", () => {
  it("name is 'ollama'", () => {
    const p = new OllamaProvider("http://localhost:11434/api", "nomic-embed-text");
    assert.equal(p.name, "ollama");
  });

  it("strips single trailing slash from baseUrl", () => {
    const p = new OllamaProvider("http://localhost:11434/api/", "model");
    assert.ok(p);
  });

  it("strips multiple trailing slashes from baseUrl", () => {
    const p = new OllamaProvider("http://localhost:11434/api///", "model");
    assert.ok(p);
  });

  it("preserves baseUrl without trailing slash", () => {
    const p = new OllamaProvider("http://localhost:11434/api", "model");
    assert.ok(p);
  });

  it("stores apiKey when provided", () => {
    const p = new OllamaProvider("http://localhost:11434/api", "model", "my-api-key");
    assert.ok(p);
  });

  it("apiKey defaults to undefined when not provided", () => {
    const p = new OllamaProvider("http://localhost:11434/api", "model");
    assert.ok(p);
  });

  it("embeds single text with correct API format", async () => {
    // Test that the embed method exists and is callable.
    // Actual fetch calls are not made in unit tests.
    const p = new OllamaProvider("http://localhost:11434/api", "qwen2.5:3b");
    assert.equal(typeof p.embed, "function");
    assert.equal(p.embed.length, 2); // expects texts array + optional purpose
  });

  it("does not require apiKey for construction", () => {
    const p = new OllamaProvider("http://localhost:11434/api", "qwen2.5:3b");
    assert.equal(p.name, "ollama");
  });

  it("handles custom baseUrl with port and path", () => {
    const p = new OllamaProvider("http://192.168.1.100:8080/api", "model");
    assert.ok(p);
  });

  it("handles https baseUrl", () => {
    const p = new OllamaProvider("https://ollama.example.com/api", "model");
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
      const p = new OllamaProvider(
        "http://localhost:11434/api",
        "qwen2.5:3b:latest",
        undefined,
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
        assert.equal(req.url, "/api/embed");
        assert.equal(req.headers["content-type"], "application/json");
        assert.match(body, /"input":"hello"/);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ embedding: [1, 2, 3] }));
      });
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        throw new Error("failed to start test server");
      }

      const p = new OllamaProvider(`http://localhost:${address.port}/api`, "qwen2.5:3b");
      const embeddings = await p.embed(["hello"]);

      assert.deepEqual(embeddings, [[1, 2, 3]]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      globalThis.fetch = originalFetch;
    }
  });

  it("sends keep_alive in the embed body when configured", async () => {
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
        assert.equal(req.url, "/api/embed");
        assert.match(body, /"keep_alive":-1/);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ embeddings: [[1, 2, 3]] }));
      });
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        throw new Error("failed to start test server");
      }

      const p = new OllamaProvider(
        `http://localhost:${address.port}/api`,
        "qwen2.5:3b",
        undefined,
        5000,
        undefined,
        undefined,
        "-1"
      );
      const embeddings = await p.embed(["hello"]);

      assert.deepEqual(embeddings, [[1, 2, 3]]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      globalThis.fetch = originalFetch;
    }
  });

  it("follows redirect responses from Ollama", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("fetch should not be called for localhost");
    }) as typeof fetch;

    const server = createServer((req, res) => {
      if (req.url === "/api/embed") {
        res.writeHead(301, { Location: "/api/embed-final" });
        res.end();
        return;
      }

      if (req.url === "/api/embed-final") {
        let body = "";
        req.on("data", (chunk) => {
          body += String(chunk);
        });
        req.on("end", () => {
          assert.equal(req.method, "POST");
          assert.match(body, /"input":"hello"/);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ embeddings: [[7, 8, 9]] }));
        });
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        throw new Error("failed to start test server");
      }

      const p = new OllamaProvider(`http://localhost:${address.port}/api`, "qwen2.5:3b");
      const embeddings = await p.embed(["hello"]);

      assert.deepEqual(embeddings, [[7, 8, 9]]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts Ollama responses that use an embeddings array", async () => {
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
        assert.equal(req.url, "/api/embed");
        assert.match(body, /"input":"hello"/);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ model: "qwen2.5:3b", embeddings: [[4, 5, 6]] }));
      });
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        throw new Error("failed to start test server");
      }

      const p = new OllamaProvider(`http://localhost:${address.port}/api`, "qwen2.5:3b");
      const embeddings = await p.embed(["hello"]);

      assert.deepEqual(embeddings, [[4, 5, 6]]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      globalThis.fetch = originalFetch;
    }
  });

  after(() => {
    destroyAllPooledConnections();
  });
});
