import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, type DecisionConfig, type RagConfig } from "../../core/config.js";
import { createMakeDecisionTool } from "../../opencode/tools.js";
import type { DecisionProvider, DecisionQuestion, DecisionRequest } from "../../core/interfaces.js";

type ToolResult = string | {
  title?: string;
  output: string;
  metadata?: Record<string, unknown>;
};

function makeConfig(overrides: Partial<DecisionConfig> = {}): RagConfig {
  return {
    ...DEFAULT_CONFIG,
    decision: {
      ...DEFAULT_CONFIG.decision!,
      enabled: true,
      model: "tev1:test",
      ...overrides,
    },
  } as RagConfig;
}

function makeFakeProvider(onCall?: (request: DecisionRequest) => void): DecisionProvider {
  return {
    name: "fake",
    async decide(request) {
      onCall?.(request);
      return {
        answers: [
          {
            id: "intent",
            type: "choice",
            choice: "duplicate_charge",
            probabilities: { duplicate_charge: 0.86, none: 0.14 },
            confidence: 0.74,
          },
          { id: "refund", type: "noul", noul: 0.91 },
        ],
      };
    },
  };
}

function asObject(r: ToolResult): NonNullable<Exclude<ToolResult, string>> {
  assert.notEqual(typeof r, "string");
  return r as NonNullable<Exclude<ToolResult, string>>;
}

const VALID_QUESTIONS: DecisionQuestion[] = [
  { id: "intent", type: "choice", instructions: "Which intent?", criteria: { duplicate_charge: "Charged twice", none: "None" } },
  { id: "refund", type: "noul", instructions: "Refund requested?" },
];

describe("createMakeDecisionTool", () => {
  it("returns formatted answers with provider/model metadata", async () => {
    const tool = createMakeDecisionTool({ config: makeConfig(), provider: makeFakeProvider() });
    const exec = (tool as { execute: Function }).execute;
    const r = asObject(await exec({ state: "Customer says they were charged twice.", questions: VALID_QUESTIONS }));

    assert.match(r.title ?? "", /Decision \(2 questions\)/);
    assert.match(r.output, /fake\/tev1:test/);
    assert.match(r.output, /- \*\*intent\*\* = `duplicate_charge` \(confidence 0\.74\)/);
    assert.match(r.output, /duplicate_charge=0\.86/);
    assert.match(r.output, /- \*\*refund\*\* = true \(p=0\.91\)/);
    assert.equal(r.metadata?.tool, "make_decision");
    assert.equal(r.metadata?.provider, "fake");
    assert.equal(r.metadata?.model, "tev1:test");
  });

  it("forwards state and questions to the provider", async () => {
    let seen: DecisionRequest | undefined;
    const tool = createMakeDecisionTool({ config: makeConfig(), provider: makeFakeProvider((request) => { seen = request; }) });
    const exec = (tool as { execute: Function }).execute;
    await exec({ state: "some state", questions: VALID_QUESTIONS });

    assert.equal(seen?.state, "some state");
    assert.equal(seen?.questions.length, 2);
    assert.deepEqual(seen?.questions[0]?.criteria, { duplicate_charge: "Charged twice", none: "None" });
  });

  it("returns a disabled error when decision.enabled is false", async () => {
    const tool = createMakeDecisionTool({ config: makeConfig({ enabled: false }), provider: makeFakeProvider() });
    const exec = (tool as { execute: Function }).execute;
    const r = asObject(await exec({ state: "s", questions: VALID_QUESTIONS }));

    assert.equal(r.metadata?.error, "disabled");
    assert.match(r.output, /not enabled/i);
  });

  it("rejects a choice question with fewer than 2 options", async () => {
    const tool = createMakeDecisionTool({ config: makeConfig(), provider: makeFakeProvider() });
    const exec = (tool as { execute: Function }).execute;
    const r = asObject(await exec({
      state: "s",
      questions: [{ id: "q", type: "choice", instructions: "?", criteria: { only: "Only option" } }],
    }));

    assert.equal(r.metadata?.error, "invalid_request");
    assert.match(r.output, /2-24 options/);
  });

  it("rejects duplicate question ids", async () => {
    const tool = createMakeDecisionTool({ config: makeConfig(), provider: makeFakeProvider() });
    const exec = (tool as { execute: Function }).execute;
    const r = asObject(await exec({
      state: "s",
      questions: [
        { id: "dup", type: "noul", instructions: "?" },
        { id: "dup", type: "noul", instructions: "?" },
      ],
    }));

    assert.equal(r.metadata?.error, "invalid_request");
    assert.match(r.output, /Duplicate question id/);
  });

  it("rejects an oversized state against maxStateChars", async () => {
    const tool = createMakeDecisionTool({ config: makeConfig({ maxStateChars: 10 }), provider: makeFakeProvider() });
    const exec = (tool as { execute: Function }).execute;
    const r = asObject(await exec({ state: "x".repeat(11), questions: VALID_QUESTIONS }));

    assert.equal(r.metadata?.error, "invalid_request");
    assert.match(r.output, /limit is 10/);
  });

  it("returns a clear error when the provider fails", async () => {
    const failing: DecisionProvider = {
      name: "fake",
      async decide() {
        throw new Error("endpoint not found");
      },
    };
    const tool = createMakeDecisionTool({ config: makeConfig(), provider: failing });
    const exec = (tool as { execute: Function }).execute;
    const r = asObject(await exec({ state: "s", questions: VALID_QUESTIONS }));

    assert.match(r.output, /Decision failed: endpoint not found/);
    assert.equal(r.metadata?.error, "Error: endpoint not found");
  });
});
