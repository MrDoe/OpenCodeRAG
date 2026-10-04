import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import {
  OllamaDecisionProvider,
  resolveSystemOneUrl,
  SYSTEMONE_MAX_REQUEST_BYTES,
} from "../../decision/systemone.js";
import type { DecisionConfig } from "../../core/config.js";

interface CapturedRequest {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

function makeConfig(overrides: Partial<DecisionConfig> = {}): DecisionConfig {
  return {
    enabled: true,
    provider: "ollama",
    baseUrl: "http://127.0.0.1:1/api",
    model: "tev1:test",
    timeoutMs: 5000,
    retryMax: 0,
    retryBaseDelayMs: 1,
    ...overrides,
  };
}

function startMockServer(
  handler: (body: Record<string, unknown>, req: IncomingMessage) => { status: number; body: unknown }
): Promise<{ baseUrl: string; requests: CapturedRequest[]; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const requests: CapturedRequest[] = [];
    const server = createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk; });
      req.on("end", () => {
        const body = data ? (JSON.parse(data) as Record<string, unknown>) : {};
        requests.push({ method: req.method ?? "", url: req.url ?? "", body });
        const result = handler(body, req);
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res()))
          ),
      });
    });
  });
}

describe("resolveSystemOneUrl", () => {
  it("accepts root and /api-suffixed base URLs", () => {
    assert.equal(resolveSystemOneUrl("http://127.0.0.1:11434"), "http://127.0.0.1:11434/v1/systemone");
    assert.equal(resolveSystemOneUrl("http://127.0.0.1:11434/"), "http://127.0.0.1:11434/v1/systemone");
    assert.equal(resolveSystemOneUrl("http://127.0.0.1:11434/api"), "http://127.0.0.1:11434/v1/systemone");
    assert.equal(resolveSystemOneUrl("http://127.0.0.1:11434/api/"), "http://127.0.0.1:11434/v1/systemone");
  });
});

describe("OllamaDecisionProvider", () => {
  it("posts to /v1/systemone with model, state, and questions, and parses choice answers", async () => {
    const mock = await startMockServer((body) => {
      assert.equal(body.model, "tev1:test");
      assert.equal(body.state, "Hello World");
      const questions = body.questions as Record<string, Record<string, unknown>>;
      assert.equal(questions.intent!.type, "choice");
      assert.equal(questions.intent!.instructions, "Which intent?");
      assert.deepEqual(questions.intent!.criteria, { a: "Option A", none: "None" });
      return {
        status: 200,
        body: {
          answers: {
            intent: { choice: "a", probabilities: { a: 0.9, none: 0.1 }, confidence: 0.8 },
          },
        },
      };
    });

    try {
      const provider = new OllamaDecisionProvider(makeConfig({ baseUrl: mock.baseUrl }));
      const result = await provider.decide({
        state: "Hello World",
        questions: [{ id: "intent", type: "choice", instructions: "Which intent?", criteria: { a: "Option A", none: "None" } }],
      });

      assert.equal(mock.requests.length, 1);
      assert.equal(mock.requests[0]!.method, "POST");
      assert.equal(mock.requests[0]!.url, "/v1/systemone");
      assert.equal(result.answers.length, 1);
      assert.equal(result.answers[0]!.id, "intent");
      assert.equal(result.answers[0]!.type, "choice");
      assert.equal(result.answers[0]!.choice, "a");
      assert.deepEqual(result.answers[0]!.probabilities, { a: 0.9, none: 0.1 });
      assert.equal(result.answers[0]!.confidence, 0.8);
    } finally {
      await mock.close();
    }
  });

  it("parses noul and score answers", async () => {
    const mock = await startMockServer(() => ({
      status: 200,
      body: {
        answers: {
          refund: { noul: 0.91 },
          severity: {
            score: 2.4,
            legend: ["low", "medium", "high"],
            probabilities: [0.1, 0.4, 0.5],
            confidence: 0.6,
          },
        },
      },
    }));

    try {
      const provider = new OllamaDecisionProvider(makeConfig({ baseUrl: mock.baseUrl }));
      const result = await provider.decide({
        state: "state",
        questions: [
          { id: "refund", type: "noul", instructions: "Refund requested?" },
          { id: "severity", type: "score", instructions: "How severe?", criteria: ["low", "medium", "high"] },
        ],
      });

      assert.equal(result.answers[0]!.noul, 0.91);
      assert.equal(result.answers[1]!.score, 2.4);
      assert.deepEqual(result.answers[1]!.legend, ["low", "medium", "high"]);
      assert.deepEqual(result.answers[1]!.probabilities, [0.1, 0.4, 0.5]);
      assert.equal(result.answers[1]!.confidence, 0.6);
    } finally {
      await mock.close();
    }
  });

  it("normalizes keep_alive and forwards it", async () => {
    const mock = await startMockServer((body) => {
      assert.equal(body.keep_alive, -1);
      return { status: 200, body: { answers: { q: { noul: 1 } } } };
    });

    try {
      const provider = new OllamaDecisionProvider(makeConfig({ baseUrl: mock.baseUrl, keepAlive: "-1" }));
      await provider.decide({ state: "s", questions: [{ id: "q", type: "noul", instructions: "?" }] });
      assert.equal(mock.requests.length, 1);
    } finally {
      await mock.close();
    }
  });

  it("retries retryable failures with backoff", async () => {
    let calls = 0;
    const mock = await startMockServer(() => {
      calls++;
      if (calls === 1) return { status: 500, body: { error: "loading" } };
      return { status: 200, body: { answers: { q: { noul: 0.5 } } } };
    });

    try {
      const provider = new OllamaDecisionProvider(
        makeConfig({ baseUrl: mock.baseUrl, retryMax: 1, retryBaseDelayMs: 1 })
      );
      const result = await provider.decide({ state: "s", questions: [{ id: "q", type: "noul", instructions: "?" }] });
      assert.equal(calls, 2);
      assert.equal(result.answers[0]!.noul, 0.5);
    } finally {
      await mock.close();
    }
  });

  it("reports the Ollama version requirement when the route is missing (404)", async () => {
    const mock = await startMockServer(() => ({ status: 404, body: "404 page not found" }));
    try {
      const provider = new OllamaDecisionProvider(makeConfig({ baseUrl: mock.baseUrl }));
      await assert.rejects(
        () => provider.decide({ state: "s", questions: [{ id: "q", type: "noul", instructions: "?" }] }),
        /Decision endpoint not found \(404\) — tev1 requires Ollama >= 0\.35/
      );
    } finally {
      await mock.close();
    }
  });

  it("reports pull guidance when the model is missing (404)", async () => {
    const mock = await startMockServer(() => ({
      status: 404,
      body: { error: 'model "tev1:test" not found, try pulling it first' },
    }));
    try {
      const provider = new OllamaDecisionProvider(makeConfig({ baseUrl: mock.baseUrl }));
      await assert.rejects(
        () => provider.decide({ state: "s", questions: [{ id: "q", type: "noul", instructions: "?" }] }),
        (err: unknown) => {
          const message = (err as Error).message;
          assert.match(message, /Decision model "tev1:test" is not pulled \(404\)/);
          assert.match(message, /ollama pull tev1:test/);
          assert.ok(!message.includes("Ollama >= 0.35"), "a missing model must not blame the Ollama version");
          return true;
        }
      );
    } finally {
      await mock.close();
    }
  });

  it("falls back to both hints for an unclassified 404", async () => {
    const mock = await startMockServer(() => ({ status: 404, body: { error: "something odd" } }));
    try {
      const provider = new OllamaDecisionProvider(makeConfig({ baseUrl: mock.baseUrl }));
      await assert.rejects(
        () => provider.decide({ state: "s", questions: [{ id: "q", type: "noul", instructions: "?" }] }),
        /Decision request not found \(404\) — tev1 requires Ollama >= 0\.35 and the model must be pulled/
      );
    } finally {
      await mock.close();
    }
  });

  it("rejects responses without answers", async () => {
    const mock = await startMockServer(() => ({ status: 200, body: { message: "prose instead of answers" } }));
    try {
      const provider = new OllamaDecisionProvider(makeConfig({ baseUrl: mock.baseUrl }));
      await assert.rejects(
        () => provider.decide({ state: "s", questions: [{ id: "q", type: "noul", instructions: "?" }] }),
        /no answers/
      );
    } finally {
      await mock.close();
    }
  });

  it("rejects oversized requests before contacting the server", async () => {
    const provider = new OllamaDecisionProvider(makeConfig({ baseUrl: "http://127.0.0.1:1" }));
    await assert.rejects(
      () =>
        provider.decide({
          state: "x".repeat(SYSTEMONE_MAX_REQUEST_BYTES + 1),
          questions: [{ id: "q", type: "noul", instructions: "?" }],
        }),
      /64 KiB/
    );
  });
});
