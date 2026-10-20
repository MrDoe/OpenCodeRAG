import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildToolErrorQuery,
  createToolErrorInjectionState,
  formatToolErrorQuirkBlock,
  normalizeToolErrorSignature,
  recallToolErrorQuirks,
  selectToolErrorQuirks,
  toToolErrorCaptureEntry,
  TOOL_ERROR_DEFAULTS,
  type ToolErrorInfo,
  type ToolErrorRecallHit,
} from "../../quirks/tool-error-recall.js";

function hit(id: string, content: string, score: number, quirkType?: string): ToolErrorRecallHit {
  return { chunk: { id, content, metadata: quirkType ? { quirkType } : {} }, score };
}

const WRITE_ERROR: ToolErrorInfo = { tool: "write", error: "Unknown tool 'write'. Did you mean something else?" };

describe("tool-error-recall", () => {
  describe("normalizeToolErrorSignature", () => {
    it("lowercases, collapses whitespace, and digit-masks the error", () => {
      const sig = normalizeToolErrorSignature({ tool: "Write", error: "Error   42\noccurred 7 times" });
      assert.equal(sig, "write|error # occurred # times");
    });

    it("truncates very long errors", () => {
      const sig = normalizeToolErrorSignature({ tool: "t", error: "x".repeat(500) });
      assert.ok(sig.length <= "t|".length + 160);
    });
  });

  describe("buildToolErrorQuery", () => {
    it("includes the tool name and error text", () => {
      const q = buildToolErrorQuery(WRITE_ERROR);
      assert.match(q, /Tool "write" failed/);
      assert.match(q, /Unknown tool/);
    });

    it("truncates the error to maxErrorChars", () => {
      const q = buildToolErrorQuery({ tool: "t", error: "y".repeat(1000) });
      assert.ok(q.length <= 40 + TOOL_ERROR_DEFAULTS.maxErrorChars);
    });
  });

  describe("createToolErrorInjectionState", () => {
    it("blocks the same signature during the cooldown and allows it after", () => {
      const state = createToolErrorInjectionState({ cooldownMs: 10_000, maxPerSession: 5 });
      const t0 = 1_000_000;
      assert.equal(state.shouldInject(WRITE_ERROR, t0), true);
      state.record(WRITE_ERROR, [], t0);
      assert.equal(state.shouldInject(WRITE_ERROR, t0 + 5_000), false);
      assert.equal(state.shouldInject(WRITE_ERROR, t0 + 10_001), true);
    });

    it("does not consume the budget for attempts without quirks", () => {
      const state = createToolErrorInjectionState({ cooldownMs: 0, maxPerSession: 1 });
      state.record(WRITE_ERROR, [], 0);
      assert.equal(state.injectionCount(), 0);
      assert.equal(state.shouldInject({ tool: "other", error: "boom" }, 0), true);
    });

    it("stops after maxPerSession injections", () => {
      const state = createToolErrorInjectionState({ cooldownMs: 0, maxPerSession: 2 });
      state.record({ tool: "a", error: "one" }, ["q1"], 0);
      state.record({ tool: "b", error: "two" }, ["q2"], 0);
      assert.equal(state.injectionCount(), 2);
      assert.equal(state.shouldInject({ tool: "c", error: "three" }, 0), false);
    });
  });

  describe("selectToolErrorQuirks", () => {
    it("passes minScore/topK to recall and returns ranked hits", async () => {
      const calls: { query: string; topK: number; minScore: number }[] = [];
      const recall = async (query: string, options: { topK: number; minScore: number }) => {
        calls.push({ query, ...options });
        return [hit("q1", "write needs a path argument, not filePath", 0.91, "gotcha"), hit("q2", "write tool requires path", 0.83)];
      };
      const state = createToolErrorInjectionState();
      const hits = await selectToolErrorQuirks(recall, WRITE_ERROR, state, { topK: 2, minScore: 0.75 });

      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.minScore, 0.75);
      assert.ok(calls[0]!.topK >= 2);
      assert.equal(hits.length, 2);
      assert.equal(hits[0]!.id, "q1");
      assert.equal(hits[0]!.quirkType, "gotcha");
      assert.equal(state.injectionCount(), 1);
      assert.ok(state.injectedQuirkIds.has("q1"));
      assert.ok(state.injectedQuirkIds.has("q2"));
    });

    it("drops lexically unrelated quirks", async () => {
      const recall = async () => [
        hit("q-good", "write requires path, not filePath", 0.9),
        hit("q-bad", "completely unrelated database migration note", 0.95),
      ];
      const hits = await selectToolErrorQuirks(recall, WRITE_ERROR, createToolErrorInjectionState());
      assert.deepEqual(hits.map((h) => h.id), ["q-good"]);
    });

    it("skips quirk ids already injected in this session", async () => {
      const state = createToolErrorInjectionState({ cooldownMs: 0 });
      state.record(WRITE_ERROR, ["q1"], 0);
      const recall = async () => [hit("q1", "write requires path", 0.9), hit("q2", "write path hint", 0.8)];
      const hits = await selectToolErrorQuirks(recall, { tool: "write", error: "write: path is missing" }, state);
      assert.deepEqual(hits.map((h) => h.id), ["q2"]);
    });

    it("slices to topK after sorting by score", async () => {
      const recall = async () => [
        hit("a", "write path low", 0.2),
        hit("b", "write path high", 0.99),
        hit("c", "write path mid", 0.5),
      ];
      // minScore 0 so the mock's sub-threshold hits are not filtered out —
      // this test is about the sort-then-slice order.
      const hits = await selectToolErrorQuirks(recall, WRITE_ERROR, createToolErrorInjectionState(), { topK: 2, minScore: 0 });
      assert.deepEqual(hits.map((h) => h.id), ["b", "c"]);
    });

    it("records the attempt (cooldown) even when recall returns nothing", async () => {
      let calls = 0;
      const recall = async () => {
        calls += 1;
        return [];
      };
      const state = createToolErrorInjectionState({ cooldownMs: 60_000 });
      const first = await selectToolErrorQuirks(recall, WRITE_ERROR, state, { minTokenOverlap: 0 });
      const second = await selectToolErrorQuirks(recall, WRITE_ERROR, state, { minTokenOverlap: 0 });
      assert.equal(first.length, 0);
      assert.equal(second.length, 0);
      assert.equal(calls, 1, "second attempt must be blocked by cooldown");
      assert.equal(state.injectionCount(), 0);
    });

    it("returns [] and records when recall throws", async () => {
      const recall = async () => {
        throw new Error("embedder down");
      };
      const state = createToolErrorInjectionState({ cooldownMs: 60_000 });
      const hits = await selectToolErrorQuirks(recall, WRITE_ERROR, state, { minTokenOverlap: 0 });
      assert.equal(hits.length, 0);
      assert.equal(state.shouldInject(WRITE_ERROR), false, "failed recall must still cool down");
    });

    it("can disable the lexical gate with minTokenOverlap 0", async () => {
      const recall = async () => [hit("q", "totally different words", 0.9)];
      const hits = await selectToolErrorQuirks(recall, WRITE_ERROR, createToolErrorInjectionState(), { minTokenOverlap: 0 });
      assert.deepEqual(hits.map((h) => h.id), ["q"]);
    });
  });

  describe("recallToolErrorQuirks", () => {
    it("tiers hits by RAW similarity, not the confidence-discounted score", async () => {
      // score 0.57 is a 0.95 similarity discounted by a 0.6 confidence —
      // a confident-only comparison would wrongly reject it.
      const recall = async () => [
        { chunk: { id: "q1", content: "write requires path" }, score: 0.57, rawSimilarity: 0.95 },
      ];
      const result = await recallToolErrorQuirks(recall, WRITE_ERROR, createToolErrorInjectionState(), {
        minScore: 0.6,
        injectMinScore: 0.7,
        minTokenOverlap: 0,
      });
      assert.equal(result.inject.length, 1);
      assert.equal(result.inject[0]!.id, "q1");
      assert.equal(result.inject[0]!.rawSimilarity, 0.95);
    });

    it("keeps a probable match in candidates but out of the inject set", async () => {
      const recall = async () => [
        { chunk: { id: "q1", content: "write requires path" }, score: 0.65, rawSimilarity: 0.65 },
      ];
      const result = await recallToolErrorQuirks(recall, WRITE_ERROR, createToolErrorInjectionState(), {
        minScore: 0.6,
        injectMinScore: 0.7,
        minTokenOverlap: 0,
      });
      assert.equal(result.inject.length, 0, "0.65 is below the 0.7 injection bar");
      assert.equal(result.candidates.length, 1, "but it is still a candidate — creation must be suppressed");
    });

    it("reports an empty candidate set when nothing covers the failure", async () => {
      const recall = async () => [];
      const result = await recallToolErrorQuirks(recall, WRITE_ERROR, createToolErrorInjectionState(), {
        minScore: 0.6,
        injectMinScore: 0.7,
      });
      assert.equal(result.inject.length, 0);
      assert.equal(result.candidates.length, 0);
      assert.equal(result.blocked, false);
    });

    it("keeps already-injected quirks in the candidate set so creation stays suppressed", async () => {
      const state = createToolErrorInjectionState({ cooldownMs: 0 });
      state.record(WRITE_ERROR, ["q1"], 0);
      const recall = async () => [
        { chunk: { id: "q1", content: "write requires path" }, score: 0.9, rawSimilarity: 0.9 },
      ];
      const result = await recallToolErrorQuirks(recall, WRITE_ERROR, state, { minScore: 0.6, injectMinScore: 0.7 });
      assert.equal(result.inject.length, 0, "already injected — do not inject again");
      assert.equal(result.candidates.length, 1, "but a quirk does exist — do not create a duplicate");
    });

    it("marks the attempt as blocked when the cooldown forbids it", async () => {
      const state = createToolErrorInjectionState({ cooldownMs: 60_000 });
      state.record(WRITE_ERROR, [], Date.now());
      const recall = async () => [];
      const result = await recallToolErrorQuirks(recall, WRITE_ERROR, state, { minScore: 0.6 });
      assert.equal(result.blocked, true);
    });

    it("returns empty candidates when the recall throws", async () => {
      const recall = async () => {
        throw new Error("embedder down");
      };
      const result = await recallToolErrorQuirks(recall, WRITE_ERROR, createToolErrorInjectionState(), { minScore: 0.6 });
      assert.equal(result.inject.length, 0);
      assert.equal(result.candidates.length, 0);
      assert.equal(result.blocked, false);
    });

    it("still recalls when the injection budget is spent, if enforceBudget is false", async () => {
      const state = createToolErrorInjectionState({ cooldownMs: 0, maxPerSession: 1 });
      state.record(WRITE_ERROR, ["q1"], 0);
      assert.equal(state.hasBudget(), false);

      const recall = async () => [hit("q2", "write requires path", 0.9)];
      const blocked = await recallToolErrorQuirks(recall, WRITE_ERROR, state, { minScore: 0.6 });
      assert.equal(blocked.blocked, true, "the budget blocks the recall by default");

      const allowed = await recallToolErrorQuirks(recall, WRITE_ERROR, state, { minScore: 0.6, enforceBudget: false });
      assert.equal(allowed.blocked, false);
      assert.equal(allowed.candidates.length, 1, "the candidate list is still needed");
      assert.equal(allowed.inject.length, 0, "but nothing may be injected without budget");
    });

    it("keeps the cooldown blocking even when enforceBudget is false", async () => {
      const state = createToolErrorInjectionState({ cooldownMs: 60_000, maxPerSession: 5 });
      state.record(WRITE_ERROR, [], Date.now());
      const recall = async () => [hit("q1", "write requires path", 0.9)];
      const result = await recallToolErrorQuirks(recall, WRITE_ERROR, state, { minScore: 0.6, enforceBudget: false });
      assert.equal(result.blocked, true);
      assert.equal(result.candidates.length, 0);
    });
  });

  describe("formatToolErrorQuirkBlock", () => {
    it("returns an empty string without hits", () => {
      assert.equal(formatToolErrorQuirkBlock(WRITE_ERROR, []), "");
    });

    it("formats the tool and typed quirk content", () => {
      const block = formatToolErrorQuirkBlock(WRITE_ERROR, [
        { id: "q1", content: "write requires path", quirkType: "gotcha", score: 0.9, rawSimilarity: 0.9 },
      ]);
      assert.match(block, /Tool error/);
      assert.match(block, /`write`/);
      assert.match(block, /\[`gotcha`\] write requires path/);
    });
  });

  describe("toToolErrorCaptureEntry", () => {
    it("marks the tool as an error and truncates the output", () => {
      const entry = toToolErrorCaptureEntry({ tool: "write", error: "z".repeat(900) });
      assert.equal(entry.tool, "write (error)");
      assert.ok(entry.output.length <= TOOL_ERROR_DEFAULTS.maxCaptureChars);
    });
  });
});
