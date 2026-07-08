import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { Chunk } from "../../core/interfaces.js";
import type { DescriptionConfig } from "../../core/config.js";
import { LlmDescriptionProvider } from "../../describer/describer.js";

import { createDescriptionProvider } from "../../describer/factory.js";

function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    id: "chunk-1",
    content: "export function hello() { return 'world'; }",
    metadata: {
      filePath: "src/hello.ts",
      startLine: 1,
      endLine: 3,
      language: "typescript",
      ...overrides.metadata,
    },
    ...overrides,
  };
}

function makeConfig(overrides: Partial<DescriptionConfig> = {}): DescriptionConfig {
  return {
    enabled: true,
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434/api",
    model: "test-model",
    timeoutMs: 5000,
    systemPrompt: "Describe the code.",
    retryMax: 0,
    retryBaseDelayMs: 10,
    ...overrides,
  };
}

function startMockServer(
  handler: (body: Record<string, unknown>) => { status: number; body: unknown }
): Promise<{ server: Server; baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk; });
      req.on("end", () => {
        const body = JSON.parse(data) as Record<string, unknown>;
        const result = handler(body);
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res()))
          ),
      });
    });
  });
}

describe("LlmDescriptionProvider", () => {
  it("generates description using Ollama API format", async () => {
    const { baseUrl, close } = await startMockServer((body) => {
      assert.equal(body.model, "test-model");
      assert.ok(Array.isArray(body.messages));
      const messages = body.messages as Array<{ role: string; content: string }>;
      assert.equal(messages[0]!.role, "system");
      assert.equal(messages[0]!.content, "Describe the code.");
      assert.equal(messages[1]!.role, "user");
      assert.ok(messages[1]!.content.includes("src/hello.ts"));
      assert.ok(messages[1]!.content.includes("typescript"));
      assert.ok(messages[1]!.content.includes("export function hello"));
      assert.ok(body.stream === false);

      return {
        status: 200,
        body: { message: { content: "A function that returns the string 'world'." } },
      };
    });

    try {
      const provider = new LlmDescriptionProvider(
        makeConfig({ baseUrl: `${baseUrl}/api` })
      );
      const description = await provider.generateDescription(makeChunk());
      assert.equal(description, "A function that returns the string 'world'.");
    } finally {
      await close();
    }
  });

  it("generates description using OpenAI API format", async () => {
    const { baseUrl, close } = await startMockServer((body) => {
      assert.equal(body.model, "openai-model");
      assert.ok(Array.isArray(body.messages));
      assert.ok(body.stream === undefined);

      return {
        status: 200,
        body: {
          choices: [{ message: { content: "A greeting function." } }],
        },
      };
    });

    try {
      const provider = new LlmDescriptionProvider(
        makeConfig({
          provider: "openai",
          model: "openai-model",
          baseUrl: `${baseUrl}/v1`,
        })
      );
      const description = await provider.generateDescription(makeChunk());
      assert.equal(description, "A greeting function.");
    } finally {
      await close();
    }
  });

  it("includes file path and language in user message", async () => {
    let capturedBody: Record<string, unknown> = {};
    const { baseUrl, close } = await startMockServer((body) => {
      capturedBody = body;
      return {
        status: 200,
        body: { message: { content: "Description." } },
      };
    });

    try {
      const provider = new LlmDescriptionProvider(
        makeConfig({ baseUrl: `${baseUrl}/api` })
      );
      await provider.generateDescription(
        makeChunk({
          content: "def foo(): pass",
          metadata: {
            filePath: "src/foo.py",
            startLine: 10,
            endLine: 20,
            language: "python",
          },
        })
      );

      const messages = capturedBody.messages as Array<{ role: string; content: string }>;
      const userMsg = messages[1]!.content;
      assert.ok(userMsg.includes("File: src/foo.py"));
      assert.ok(userMsg.includes("Language: python"));
      assert.ok(userMsg.includes("Lines: 10-20"));
      assert.ok(userMsg.includes("def foo(): pass"));
    } finally {
      await close();
    }
  });

  it("uses custom system prompt from config", async () => {
    let capturedBody: Record<string, unknown> = {};
    const { baseUrl, close } = await startMockServer((body) => {
      capturedBody = body;
      return {
        status: 200,
        body: { message: { content: "Custom description." } },
      };
    });

    try {
      const provider = new LlmDescriptionProvider(
        makeConfig({
          baseUrl: `${baseUrl}/api`,
          systemPrompt: "You are a Python expert. Describe this code briefly.",
        })
      );
      await provider.generateDescription(makeChunk());

      const messages = capturedBody.messages as Array<{ role: string; content: string }>;
      assert.equal(
        messages[0]!.content,
        "You are a Python expert. Describe this code briefly."
      );
    } finally {
      await close();
    }
  });

  it("sends API key as Bearer token for OpenAI provider", async () => {
    const { baseUrl, close } = await startMockServer((_body) => {
      return {
        status: 200,
        body: { choices: [{ message: { content: "Desc." } }] },
      };
    });

    try {
      const provider = new LlmDescriptionProvider(
        makeConfig({
          provider: "openai",
          baseUrl: `${baseUrl}/v1`,
          apiKey: "test-api-key",
        })
      );
      const desc = await provider.generateDescription(makeChunk());
      assert.equal(desc, "Desc.");
    } finally {
      await close();
    }
  });

  it("throws on empty LLM response", async () => {
    const { baseUrl, close } = await startMockServer(() => ({
      status: 200,
      body: { message: { content: "" } },
    }));

    try {
      const provider = new LlmDescriptionProvider(
        makeConfig({ baseUrl: `${baseUrl}/api` })
      );
      await assert.rejects(
        () => provider.generateDescription(makeChunk()),
        (err: Error) => {
          assert.ok(err.message.includes("empty response"));
          return true;
        }
      );
    } finally {
      await close();
    }
  });

  it("throws on HTTP error status", async () => {
    const { baseUrl, close } = await startMockServer(() => ({
      status: 500,
      body: { error: "internal error" },
    }));

    try {
      const provider = new LlmDescriptionProvider(
        makeConfig({ baseUrl: `${baseUrl}/api` })
      );
      await assert.rejects(
        () => provider.generateDescription(makeChunk()),
        (err: Error) => {
          assert.ok(err.message.includes("500"));
          return true;
        }
      );
    } finally {
      await close();
    }
  });

  it("uses Ollama chat endpoint", async () => {
    const { baseUrl, close } = await startMockServer((_body) => {
      return {
        status: 200,
        body: { message: { content: "Desc." } },
      };
    });

    try {
      const provider = new LlmDescriptionProvider(
        makeConfig({ baseUrl: `${baseUrl}/api` })
      );
      const desc = await provider.generateDescription(makeChunk());
      assert.equal(desc, "Desc.");
    } finally {
      await close();
    }
  });

  it("uses OpenAI chat completions endpoint", async () => {
    const { baseUrl, close } = await startMockServer(() => ({
      status: 200,
      body: { choices: [{ message: { content: "Desc." } }] },
    }));

    try {
      const provider = new LlmDescriptionProvider(
        makeConfig({
          provider: "openai",
          baseUrl: `${baseUrl}/v1`,
        })
      );
      const desc = await provider.generateDescription(makeChunk());
      assert.equal(desc, "Desc.");
    } finally {
      await close();
    }
  });
});

describe("LlmDescriptionProvider.generateBatchDescriptions", () => {
  it("returns single-element map when chunks.length === 1", async () => {
    const { baseUrl, close } = await startMockServer((_body) => {
      return {
        status: 200,
        body: { message: { content: "Single description." } },
      };
    });

    try {
      const provider = new LlmDescriptionProvider(
        makeConfig({ baseUrl: `${baseUrl}/api` })
      );
      const chunk = makeChunk({ id: "c1" });
      const result = await provider.generateBatchDescriptions([chunk]);
      assert.equal(result.size, 1);
      assert.equal(result.get("c1"), "Single description.");
    } finally {
      await close();
    }
  });

  it("makes one individual request per chunk", async () => {
    const requests: Array<{ body: Record<string, unknown>; chunkId: string }> = [];
    const { baseUrl, close } = await startMockServer((body) => {
      const userMsg = (body.messages as Array<{ role: string; content: string }>)[1]?.content ?? "";
      const idMatch = userMsg.match(/File: src\/(\S+)/);
      const chunkId = idMatch ? idMatch[1]!.replace(".ts", "") : "unknown";
      requests.push({ body: body as Record<string, unknown>, chunkId });
      return {
        status: 200,
        body: {
          message: {
            content: `Description for ${chunkId}.`,
          },
        },
      };
    });

    try {
      const provider = new LlmDescriptionProvider(
        makeConfig({ baseUrl: `${baseUrl}/api` })
      );
      const chunks = [
        makeChunk({ id: "c0", content: "function first() {}", metadata: { filePath: "src/first.ts", startLine: 1, endLine: 2, language: "typescript" } }),
        makeChunk({ id: "c1", content: "function second() {}", metadata: { filePath: "src/second.ts", startLine: 4, endLine: 5, language: "typescript" } }),
      ];
      const result = await provider.generateBatchDescriptions(chunks);

      assert.equal(requests.length, 2);
      assert.equal(result.size, 2);
      assert.equal(result.get("c0"), "Description for first.");
      assert.equal(result.get("c1"), "Description for second.");
    } finally {
      await close();
    }
  });

  it("collects descriptions despite individual failures", async () => {
    let callIndex = 0;
    const { baseUrl, close } = await startMockServer(() => {
      callIndex++;
      if (callIndex === 1) {
        return { status: 500, body: { error: "internal error" } };
      }
      return { status: 200, body: { message: { content: "Second desc." } } };
    });

    try {
      const provider = new LlmDescriptionProvider(
        makeConfig({ baseUrl: `${baseUrl}/api` })
      );
      const chunks = [
        makeChunk({ id: "c0", metadata: { filePath: "src/a.ts", startLine: 1, endLine: 2, language: "typescript" } }),
        makeChunk({ id: "c1", metadata: { filePath: "src/a.ts", startLine: 4, endLine: 5, language: "typescript" } }),
      ];

      const result = await provider.generateBatchDescriptions(chunks);
      assert.equal(result.size, 1);
      assert.equal(result.get("c1"), "Second desc.");
    } finally {
      await close();
    }
  });

});

describe("createDescriptionProvider", () => {
  it("returns an LlmDescriptionProvider instance", () => {
    const provider = createDescriptionProvider(makeConfig());
    assert.ok(provider);
    assert.equal(typeof provider.generateDescription, "function");
    assert.equal(typeof provider.generateBatchDescriptions, "function");
  });
});

describe("LlmDescriptionProvider retry logic", () => {
  it("does not retry on 404 (bad request)", async () => {
    let callCount = 0;
    const { baseUrl, close } = await startMockServer(() => {
      callCount++;
      return { status: 404, body: "404 page not found" };
    });

    try {
      const provider = new LlmDescriptionProvider(
        makeConfig({ baseUrl: `${baseUrl}/api`, retryMax: 2, retryBaseDelayMs: 10 })
      );
      await assert.rejects(
        () => provider.generateDescription(makeChunk()),
        { message: /404/ }
      );
      assert.equal(callCount, 1);
    } finally {
      await close();
    }
  });

  it("retries on 500 and succeeds on third attempt", async () => {
    let callCount = 0;
    const { baseUrl, close } = await startMockServer(() => {
      callCount++;
      if (callCount <= 2) {
        return { status: 500, body: { error: "internal error" } };
      }
      return { status: 200, body: { message: { content: "Recovered." } } };
    });

    try {
      const provider = new LlmDescriptionProvider(
        makeConfig({ baseUrl: `${baseUrl}/api`, retryMax: 3, retryBaseDelayMs: 10 })
      );
      const desc = await provider.generateDescription(makeChunk());
      assert.equal(desc, "Recovered.");
      assert.equal(callCount, 3);
    } finally {
      await close();
    }
  });

  it("does not retry on 400 (bad request)", async () => {
    let callCount = 0;
    const { baseUrl, close } = await startMockServer(() => {
      callCount++;
      return { status: 400, body: { error: "bad request" } };
    });

    try {
      const provider = new LlmDescriptionProvider(
        makeConfig({ baseUrl: `${baseUrl}/api`, retryMax: 3, retryBaseDelayMs: 10 })
      );
      await assert.rejects(
        () => provider.generateDescription(makeChunk()),
        (err: Error) => {
          assert.ok(err.message.includes("400"));
          return true;
        }
      );
      assert.equal(callCount, 1);
    } finally {
      await close();
    }
  });

  it("does not retry on 401 (unauthorized)", async () => {
    let callCount = 0;
    const { baseUrl, close } = await startMockServer(() => {
      callCount++;
      return { status: 401, body: { error: "unauthorized" } };
    });

    try {
      const provider = new LlmDescriptionProvider(
        makeConfig({ baseUrl: `${baseUrl}/api`, retryMax: 3, retryBaseDelayMs: 10 })
      );
      await assert.rejects(
        () => provider.generateDescription(makeChunk()),
        (err: Error) => {
          assert.ok(err.message.includes("401"));
          return true;
        }
      );
      assert.equal(callCount, 1);
    } finally {
      await close();
    }
  });

  it("exhausts all retries and throws", async () => {
    let callCount = 0;
    const { baseUrl, close } = await startMockServer(() => {
      callCount++;
      return { status: 503, body: { error: "service unavailable" } };
    });

    try {
      const provider = new LlmDescriptionProvider(
        makeConfig({ baseUrl: `${baseUrl}/api`, retryMax: 2, retryBaseDelayMs: 10 })
      );
      await assert.rejects(
        () => provider.generateDescription(makeChunk()),
        (err: Error) => {
          assert.ok(err.message.includes("503"));
          return true;
        }
      );
      assert.equal(callCount, 3);
    } finally {
      await close();
    }
  });

  it("retries on 429 (rate limited) and succeeds", async () => {
    let callCount = 0;
    const { baseUrl, close } = await startMockServer(() => {
      callCount++;
      if (callCount === 1) {
        return { status: 429, body: { error: "rate limited" } };
      }
      return { status: 200, body: { message: { content: "OK after rate limit." } } };
    });

    try {
      const provider = new LlmDescriptionProvider(
        makeConfig({ baseUrl: `${baseUrl}/api`, retryMax: 2, retryBaseDelayMs: 10 })
      );
      const desc = await provider.generateDescription(makeChunk());
      assert.equal(desc, "OK after rate limit.");
      assert.equal(callCount, 2);
    } finally {
      await close();
    }
  });

});
