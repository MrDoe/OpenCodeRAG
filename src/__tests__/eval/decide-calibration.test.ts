/**
 * @fileoverview Unit tests for the decision-model calibration math (accuracy, ECE, Brier)
 * and the calibration label file. No Ollama/tev1 needed — the provider is mocked.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  loadDecideCalibration,
  runDecideCalibration,
  scoreDecisionAnswer,
  summarizeCalibration,
  type DecideCalibrationItem,
  type ScoredDecisionItem,
} from "../../eval/decide-calibration.js";
import type { DecisionProvider } from "../../core/interfaces.js";

function item(overrides?: Partial<DecideCalibrationItem>): DecideCalibrationItem {
  return {
    id: "i1",
    category: "check",
    state: "state",
    question: { type: "noul", instructions: "Is it true?" },
    expected: "true",
    ...overrides,
  };
}

function scored(confidence: number, correct: boolean): ScoredDecisionItem {
  return { item: item(), predicted: "true", correct, confidence, pExpected: null, latencyMs: 1 };
}

describe("scoreDecisionAnswer", () => {
  it("maps noul probabilities to the predicted boolean and confidence", () => {
    const yes = scoreDecisionAnswer(item(), { id: "i1", type: "noul", noul: 0.9 }, 5);
    assert.equal(yes.predicted, "true");
    assert.equal(yes.correct, true);
    assert.equal(yes.confidence, 0.9);
    assert.ok(Math.abs((yes.pExpected ?? 0) - 0.9) < 1e-12);

    const no = scoreDecisionAnswer(item(), { id: "i1", type: "noul", noul: 0.2 }, 5);
    assert.equal(no.predicted, "false");
    assert.equal(no.correct, false);
    assert.equal(no.confidence, 0.8);
  });

  it("uses choice probabilities for confidence and p(expected)", () => {
    const outcome = scoreDecisionAnswer(
      item({ question: { type: "choice", instructions: "pick" }, expected: "b" }),
      { id: "i1", type: "choice", choice: "a", probabilities: { a: 0.7, b: 0.3 } },
      5,
    );
    assert.equal(outcome.predicted, "a");
    assert.equal(outcome.correct, false);
    assert.equal(outcome.confidence, 0.7);
    assert.equal(outcome.pExpected, 0.3);
  });

  it("falls back to argmax and reports unanswered items", () => {
    const outcome = scoreDecisionAnswer(
      item({ question: { type: "choice", instructions: "pick" }, expected: "b" }),
      { id: "i1", type: "choice", probabilities: { a: 0.2, b: 0.8 } },
      5,
    );
    assert.equal(outcome.predicted, "b");
    assert.equal(outcome.correct, true);
    assert.equal(outcome.confidence, 0.8);

    const missing = scoreDecisionAnswer(item(), undefined, 5);
    assert.equal(missing.predicted, undefined);
    assert.equal(missing.correct, false);
  });

  it("maps a score answer through the legend", () => {
    const outcome = scoreDecisionAnswer(
      item({ question: { type: "score", instructions: "rate", criteria: ["low", "mid", "high"] }, expected: "mid" }),
      { id: "i1", type: "score", score: 1.2, legend: ["low", "mid", "high"] },
      5,
    );
    assert.equal(outcome.predicted, "mid");
    assert.equal(outcome.correct, true);
  });
});

describe("summarizeCalibration", () => {
  it("computes accuracy, ECE, and Brier for a hand-checked case", () => {
    // 2 correct + 2 wrong, all with confidence 0.9.
    const summary = summarizeCalibration([
      scored(0.9, true),
      scored(0.9, true),
      scored(0.9, false),
      scored(0.9, false),
    ]);
    assert.equal(summary.accuracy, 0.5);
    assert.ok(Math.abs(summary.ece - 0.4) < 1e-12, `ECE ${summary.ece}`);
    assert.ok(Math.abs(summary.brier - 0.41) < 1e-12, `Brier ${summary.brier}`);
    const occupied = summary.bins.filter((bin) => bin.count > 0);
    assert.equal(occupied.length, 1);
    assert.equal(occupied[0]?.count, 4);
  });

  it("counts unanswered items against accuracy but not into bins", () => {
    const unanswered = scoreDecisionAnswer(item(), undefined, 1);
    const summary = summarizeCalibration([scored(0.8, true), unanswered]);
    assert.equal(summary.n, 2);
    assert.equal(summary.answered, 1);
    assert.equal(summary.accuracy, 0.5);
  });
});

describe("decide labels + runner", () => {
  it("loads the shipped calibration set with unique ids and expected values", () => {
    const labelsPath = fileURLToPath(new URL("../../eval/decide-labels.json", import.meta.url));
    const items = loadDecideCalibration(labelsPath);
    assert.ok(items.length >= 20, `expected a meaningful set, got ${items.length}`);
    const ids = new Set(items.map((entry) => entry.id));
    assert.equal(ids.size, items.length, "ids must be unique");
    for (const entry of items) {
      assert.ok(entry.expected.length > 0);
      assert.ok(["noul", "choice", "score"].includes(entry.question.type));
    }
  });

  it("runs items through a mocked provider and scores the answers", async () => {
    const provider: DecisionProvider = {
      name: "mock",
      decide: async (request) => ({
        answers: [{ id: request.questions[0]!.id, type: request.questions[0]!.type, noul: 0.95 }],
      }),
    };
    const lines: string[] = [];
    const { scored: results, summary } = await runDecideCalibration({
      items: [item({ id: "a" }), item({ id: "b", expected: "false" })],
      provider,
      log: (line) => lines.push(line),
    });
    assert.equal(results.length, 2);
    assert.equal(results[0]?.correct, true);
    assert.equal(results[1]?.correct, false);
    assert.equal(summary.accuracy, 0.5);
    assert.equal(lines.length, 2);
  });
});
