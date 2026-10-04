/**
 * Live tev1 integration test — exercises Ollama's `/v1/systemone` endpoint
 * with a real decision model.
 *
 * Skipped by default. To run:
 *
 *   ollama pull tev1:0.8b          # requires Ollama >= 0.35
 *   OPENCODE_RAG_TEST_TEV1=1 node --import tsx --test src/__tests__/decision/tev1.integration.test.ts
 *
 * Override the endpoint/model with OPENCODE_RAG_TEV1_BASE_URL and
 * OPENCODE_RAG_TEV1_MODEL.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { OllamaDecisionProvider } from "../../decision/systemone.js";
import type { DecisionConfig } from "../../core/config.js";

const ENABLED = process.env.OPENCODE_RAG_TEST_TEV1 === "1";
const BASE_URL = process.env.OPENCODE_RAG_TEV1_BASE_URL ?? "http://127.0.0.1:11434/api";
const MODEL = process.env.OPENCODE_RAG_TEV1_MODEL ?? "tev1:0.8b";

let available = false;

/** Probe `/api/tags` for a pulled tev1 model. */
async function hasTev1Model(): Promise<boolean> {
  const root = BASE_URL.replace(/\/+$/, "").replace(/\/api$/, "");
  try {
    const response = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return false;
    const json = (await response.json()) as { models?: Array<{ name?: string }> };
    return (json.models ?? []).some((model) => typeof model.name === "string" && model.name.toLowerCase().includes("tev1"));
  } catch {
    return false;
  }
}

function makeConfig(): DecisionConfig {
  return {
    enabled: true,
    provider: "ollama",
    baseUrl: BASE_URL,
    model: MODEL,
    timeoutMs: 180000,
    keepAlive: "5m",
    retryMax: 0,
  };
}

describe("tev1 live integration", () => {
  before(async () => {
    available = ENABLED && (await hasTev1Model());
  });

  it("answers a noul question about a greeting", async (t) => {
    if (!available) return t.skip("set OPENCODE_RAG_TEST_TEV1=1 and pull tev1:0.8b to run this test");
    const provider = new OllamaDecisionProvider(makeConfig());
    const result = await provider.decide({
      state: "Hello World",
      questions: [
        { id: "says_hello", type: "noul", instructions: "Does the state text contain a greeting?" },
      ],
    });

    const probability = result.answers[0]?.noul;
    assert.equal(typeof probability, "number");
    assert.ok((probability ?? 0) > 0.5, `expected a greeting to score > 0.5, got ${probability}`);
  });

  it("selects a choice from a support message", async (t) => {
    if (!available) return t.skip("set OPENCODE_RAG_TEST_TEV1=1 and pull tev1:0.8b to run this test");
    const provider = new OllamaDecisionProvider(makeConfig());
    const result = await provider.decide({
      state:
        "Customer message: I checked my statement and your company charged my card twice for the October subscription. " +
        "The amounts are both $19.99 on the same day.",
      questions: [
        {
          id: "intent",
          type: "choice",
          instructions: "Which listed support intent best matches the customer message?",
          criteria: {
            duplicate_charge: "The customer reports being charged more than once.",
            cancel_subscription: "The customer wants to end or downgrade a subscription.",
            none: "None of the listed intents matches.",
          },
        },
      ],
    });

    assert.equal(result.answers[0]?.choice, "duplicate_charge");
    assert.ok(result.answers[0]?.probabilities !== undefined, "expected probabilities in the answer");
  });
});
