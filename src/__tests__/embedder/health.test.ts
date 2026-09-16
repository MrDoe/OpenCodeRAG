import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { checkProviderHealth, pullOllamaModels } from "../../embedder/health.js";
import type { RagConfig } from "../../core/config.js";

function baseConfig(overrides: Partial<RagConfig["embedding"]> = {}): RagConfig {
  return {
    embedding: {
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434/api",
      model: "test-model",
      timeoutMs: 5000,
      ...overrides,
    },
    indexing: {
      includeExtensions: [".ts"],
      excludeDirs: ["node_modules"],
      chunkOverlap: 0,
      concurrency: 1,
      embedBatchSize: 10,
    },
    vectorStore: { path: "./.opencode/rag_db" },
    retrieval: { topK: 20, minScore: 0.1 },
    openCode: { enabled: false, maxContextChunks: 10 },
    description: undefined,
    tui: { fileListKeybinding: "", chunksKeybinding: "", settingsKeybinding: "" },
    logging: { level: "none", logFilePath: "" },
  };
}

function startMockServer(
  handler: (req: { url?: string; method?: string; body: string }, res: { writeHead: (s: number, h?: Record<string, string>) => void; write: (d: string | Buffer) => boolean; end: (b?: string) => void }) => void
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += String(chunk); });
      req.on("end", () => {
        handler(
          { url: req.url, method: req.method, body },
          res as unknown as { writeHead: (s: number, h?: Record<string, string>) => void; write: (d: string | Buffer) => boolean; end: (b?: string) => void }
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) throw new Error("failed to start server");
      resolve({ server, port: address.port });
    });
  });
}

describe("checkProviderHealth", () => {
  describe("Ollama embedding model", () => {
    it("returns ok when Ollama responds successfully", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ embedding: [1, 2, 3] }));
      });

      try {
        const config = baseConfig({ baseUrl: `http://127.0.0.1:${port}/api` });
        const results = await checkProviderHealth(config);
        assert.equal(results.length, 1);
        assert.equal(results[0]!.status, "ok");
        assert.equal(results[0]!.provider, "ollama");
        assert.equal(results[0]!.type, "embedding");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("returns missing when model not found", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end('Ollama: model "missing-model" not found');
      });

      try {
        const config = baseConfig({ baseUrl: `http://127.0.0.1:${port}/api` });
        const results = await checkProviderHealth(config);
        assert.equal(results.length, 1);
        assert.equal(results[0]!.status, "missing");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("returns error when connection refused", async () => {
      const config = baseConfig({ baseUrl: "http://127.0.0.1:19999/api", timeoutMs: 1000 });
      const results = await checkProviderHealth(config);
      assert.equal(results.length, 1);
      assert.equal(results[0]!.status, "error");
      assert.ok(results[0]!.error!.includes("Connection refused"));
    });

    it("returns error on timeout", async () => {
      const { server, port } = await startMockServer(() => {
        // Never responds — server hangs
      });

      try {
        const config = baseConfig({ baseUrl: `http://127.0.0.1:${port}/api`, timeoutMs: 200 });
        const results = await checkProviderHealth(config);
        assert.equal(results.length, 1);
        assert.equal(results[0]!.status, "error");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe("Ollama description model", () => {
    it("checks description model when enabled", async () => {
      let callCount = 0;
      const { server, port } = await startMockServer((req, res) => {
        callCount++;
        if (req.url?.includes("/chat")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: { content: "ok" } }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ embedding: [1] }));
        }
      });

      try {
        const config = baseConfig({ baseUrl: `http://127.0.0.1:${port}/api` });
        config.description = {
          enabled: true,
          provider: "ollama",
          baseUrl: `http://127.0.0.1:${port}/api`,
          model: "desc-model",
          systemPrompt: "test",
          timeoutMs: 5000,
        };
        const results = await checkProviderHealth(config);
        assert.equal(results.length, 2);
        assert.equal(results[0]!.type, "embedding");
        assert.equal(results[1]!.type, "description");
        assert.equal(results[1]!.status, "ok");
        assert.equal(callCount, 2);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("skips description check when disabled", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ embedding: [1] }));
      });

      try {
        const config = baseConfig({ baseUrl: `http://127.0.0.1:${port}/api` });
        config.description = {
          enabled: false,
          provider: "ollama",
          baseUrl: `http://127.0.0.1:${port}/api`,
          model: "desc-model",
          systemPrompt: "test",
        };
        const results = await checkProviderHealth(config);
        assert.equal(results.length, 1);
        assert.equal(results[0]!.type, "embedding");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("returns missing for description model not found", async () => {
      const { server, port } = await startMockServer((req, res) => {
        if (req.url?.includes("/chat")) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end('Ollama: model "missing-desc" not found');
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ embedding: [1] }));
        }
      });

      try {
        const config = baseConfig({ baseUrl: `http://127.0.0.1:${port}/api` });
        config.description = {
          enabled: true,
          provider: "ollama",
          baseUrl: `http://127.0.0.1:${port}/api`,
          model: "missing-desc",
          systemPrompt: "test",
          timeoutMs: 5000,
        };
        const results = await checkProviderHealth(config);
        assert.equal(results.length, 2);
        assert.equal(results[0]!.status, "ok");
        assert.equal(results[1]!.status, "missing");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe("Ollama image description model", () => {
    it("checks image description model when enabled", async () => {
      let callCount = 0;
      const { server, port } = await startMockServer((req, res) => {
        callCount++;
        if (req.url?.includes("/chat")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: { content: "ok" } }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ embedding: [1] }));
        }
      });

      try {
        const config = baseConfig({ baseUrl: `http://127.0.0.1:${port}/api` });
        config.imageDescription = {
          enabled: true,
          provider: "ollama",
          baseUrl: `http://127.0.0.1:${port}/api`,
          model: "vision-model",
          timeoutMs: 5000,
          prompt: "Describe this image",
        };
        const results = await checkProviderHealth(config);
        assert.equal(results.length, 2);
        assert.equal(results[0]!.type, "embedding");
        assert.equal(results[1]!.type, "image_description");
        assert.equal(results[1]!.status, "ok");
        assert.equal(results[1]!.provider, "ollama");
        assert.equal(callCount, 2);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("skips image description check when disabled", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ embedding: [1] }));
      });

      try {
        const config = baseConfig({ baseUrl: `http://127.0.0.1:${port}/api` });
        config.imageDescription = {
          enabled: false,
          provider: "ollama",
          baseUrl: `http://127.0.0.1:${port}/api`,
          model: "vision-model",
          timeoutMs: 5000,
          prompt: "Describe this image",
        };
        const results = await checkProviderHealth(config);
        assert.equal(results.length, 1);
        assert.equal(results[0]!.type, "embedding");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("returns missing for image description model not found", async () => {
      const { server, port } = await startMockServer((req, res) => {
        if (req.url?.includes("/chat")) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end('Ollama: model "missing-vision" not found');
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ embedding: [1] }));
        }
      });

      try {
        const config = baseConfig({ baseUrl: `http://127.0.0.1:${port}/api` });
        config.imageDescription = {
          enabled: true,
          provider: "ollama",
          baseUrl: `http://127.0.0.1:${port}/api`,
          model: "missing-vision",
          timeoutMs: 5000,
          prompt: "Describe this image",
        };
        const results = await checkProviderHealth(config);
        assert.equal(results.length, 2);
        assert.equal(results[0]!.status, "ok");
        assert.equal(results[1]!.type, "image_description");
        assert.equal(results[1]!.status, "missing");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("checks all three models when description and image description both enabled", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: { content: "ok" } }));
      });

      try {
        const config = baseConfig({ baseUrl: `http://127.0.0.1:${port}/api` });
        config.description = {
          enabled: true,
          provider: "ollama",
          baseUrl: `http://127.0.0.1:${port}/api`,
          model: "desc-model",
          systemPrompt: "test",
          timeoutMs: 5000,
        };
        config.imageDescription = {
          enabled: true,
          provider: "ollama",
          baseUrl: `http://127.0.0.1:${port}/api`,
          model: "vision-model",
          timeoutMs: 5000,
          prompt: "Describe this image",
        };
        const results = await checkProviderHealth(config);
        assert.equal(results.length, 3);
        assert.equal(results[0]!.type, "embedding");
        assert.equal(results[1]!.type, "description");
        assert.equal(results[2]!.type, "image_description");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("checks the on-demand vision model when onDemand overrides it", async () => {
      const chatModels: string[] = [];
      const { server, port } = await startMockServer((req, res) => {
        if (req.url?.includes("/chat")) {
          const body = JSON.parse(req.body) as { model?: string };
          chatModels.push(body.model ?? "");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: { content: "ok" } }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ embedding: [1] }));
        }
      });

      try {
        const config = baseConfig({ baseUrl: `http://127.0.0.1:${port}/api` });
        config.imageDescription = {
          enabled: true,
          provider: "ollama",
          baseUrl: `http://127.0.0.1:${port}/api`,
          model: "vision-model",
          timeoutMs: 5000,
          prompt: "Describe this image",
          onDemand: { model: "on-demand-vision" },
        };
        const results = await checkProviderHealth(config);
        assert.equal(results.length, 3);
        assert.equal(results[1]!.type, "image_description");
        assert.equal(results[1]!.model, "vision-model");
        assert.equal(results[2]!.type, "image_description_on_demand");
        assert.equal(results[2]!.model, "on-demand-vision");
        assert.deepEqual([...chatModels].sort(), ["on-demand-vision", "vision-model"]);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("skips the on-demand check when onDemand matches the indexing provider/model", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: { content: "ok" } }));
      });

      try {
        const config = baseConfig({ baseUrl: `http://127.0.0.1:${port}/api` });
        config.imageDescription = {
          enabled: true,
          provider: "ollama",
          baseUrl: `http://127.0.0.1:${port}/api`,
          model: "vision-model",
          timeoutMs: 5000,
          prompt: "Describe this image",
          onDemand: { prompt: "on-demand prompt" },
        };
        const results = await checkProviderHealth(config);
        assert.equal(results.length, 2);
        assert.equal(results[1]!.type, "image_description");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe("OpenAI-compatible provider", () => {
    it("returns ok when /models endpoint succeeds", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
      });

      try {
        const config = baseConfig({
          provider: "openai",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "test-key",
        });
        const results = await checkProviderHealth(config);
        assert.equal(results.length, 1);
        assert.equal(results[0]!.status, "ok");
        assert.equal(results[0]!.provider, "openai");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("returns error when API key is invalid", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid key" }));
      });

      try {
        const config = baseConfig({
          provider: "openai",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "bad-key",
        });
        const results = await checkProviderHealth(config);
        assert.equal(results.length, 1);
        assert.equal(results[0]!.status, "error");
        assert.ok(results[0]!.error!.includes("Invalid API key"));
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("returns error when no API key configured", async () => {
      const config = baseConfig({
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: undefined,
      });
      const results = await checkProviderHealth(config);
      assert.equal(results.length, 1);
      assert.equal(results[0]!.status, "error");
      assert.ok(results[0]!.error!.includes("No API key"));
    });
  });

  describe("Cohere provider", () => {
    it("returns ok when embed endpoint succeeds", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ embeddings: [[1, 2, 3]] }));
      });

      try {
        const config = baseConfig({
          provider: "cohere",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "test-key",
        });
        const results = await checkProviderHealth(config);
        assert.equal(results.length, 1);
        assert.equal(results[0]!.status, "ok");
        assert.equal(results[0]!.provider, "cohere");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("returns error when no API key configured", async () => {
      const config = baseConfig({
        provider: "cohere",
        baseUrl: "https://api.cohere.ai/v1",
        apiKey: undefined,
      });
      const results = await checkProviderHealth(config);
      assert.equal(results.length, 1);
      assert.equal(results[0]!.status, "error");
      assert.ok(results[0]!.error!.includes("No API key"));
    });
  });

  describe("Anthropic description provider", () => {
    it("returns ok when messages endpoint succeeds", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
      });

      try {
        const config = baseConfig();
        config.description = {
          enabled: true,
          provider: "anthropic",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "claude-haiku",
          apiKey: "test-key",
          systemPrompt: "test",
          timeoutMs: 5000,
        };
        const results = await checkProviderHealth(config);
        assert.equal(results.length, 2);
        assert.equal(results[1]!.status, "ok");
        assert.equal(results[1]!.provider, "anthropic");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe("Unknown provider", () => {
    it("returns error for unknown embedding provider", async () => {
      const config = baseConfig({ provider: "unknown-provider" as string });
      const results = await checkProviderHealth(config);
      assert.equal(results.length, 1);
      assert.equal(results[0]!.status, "error");
      assert.ok(results[0]!.error!.includes("Unknown provider"));
    });
  });
});

describe("pullOllamaModels", () => {
  it("throws when pull endpoint returns error", async () => {
    const { server, port } = await startMockServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("model not found");
    });

    try {
      await assert.rejects(
        () => pullOllamaModels([{ model: "nonexistent-model-xyz", baseUrl: `http://127.0.0.1:${port}/api` }]),
        /Failed to pull nonexistent-model-xyz/
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("streams progress and completes successfully", async () => {
    const { server, port } = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
      res.write(JSON.stringify({ status: "downloading", completed: 524288, total: 1048576 }) + "\n");
      res.write(JSON.stringify({ status: "downloading", completed: 1048576, total: 1048576 }) + "\n");
      res.write(JSON.stringify({ status: "success" }) + "\n");
      res.end();
    });

    try {
      const lines: Array<{ model: string; line: string }> = [];
      await pullOllamaModels(
        [{ model: "test-model", baseUrl: `http://127.0.0.1:${port}/api` }],
        (model, line) => lines.push({ model, line })
      );
      assert.ok(lines.length >= 3, `expected at least 3 progress lines, got ${lines.length}`);
      assert.equal(lines[0]!.model, "test-model");
      assert.equal(lines[0]!.line, "pulling manifest");
      assert.ok(lines[1]!.line.includes("50%"), `expected 50% in progress line: ${lines[1]!.line}`);
      assert.equal(lines[lines.length - 1]!.line, "success");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("throws on connection refused", async () => {
    await assert.rejects(
      () => pullOllamaModels([{ model: "model", baseUrl: "http://127.0.0.1:19999/api" }]),
      /Failed to pull model/
    );
  });
});
