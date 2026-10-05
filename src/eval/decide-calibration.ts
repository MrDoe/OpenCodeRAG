/**
 * @fileoverview Decision-model calibration harness (tev1 via Ollama `/v1/systemone`).
 *
 * Answers a small labelled set of `noul` / `choice` / `score` questions, compares the
 * model's answers with the expected labels, and reports **accuracy, ECE (expected
 * calibration error, 10 bins) and Brier score** over the predicted answer's confidence.
 * Motivation (XERJ's model-card discipline): our docs say `confidence` is probability
 * concentration, NOT the chance the answer is right — this harness measures how far off
 * that distinction is in practice. `eval:decide` is the CLI entry.
 */
import { existsSync, readFileSync } from "node:fs";
import type { DecisionAnswer, DecisionProvider } from "../core/interfaces.js";

/** One question in a calibration item. */
export interface DecideCalibrationQuestion {
  type: "noul" | "choice" | "score";
  instructions: string;
  criteria?: Record<string, string> | string[] | { true?: string; false?: string };
}

/** One labelled decision task. */
export interface DecideCalibrationItem {
  id: string;
  category: string;
  state: string;
  question: DecideCalibrationQuestion;
  /**
   * Expected answer: `"true"`/`"false"` for `noul`, an option key for `choice`,
   * a level label for `score`.
   */
  expected: string;
  note?: string;
}

/** Serialized calibration file (`src/eval/decide-labels.json`). */
export interface DecideCalibrationFile {
  version: number;
  labels: DecideCalibrationItem[];
}

/**
 * Load and validate a decision calibration label file.
 *
 * @param labelsPath - Absolute path to the JSON label file.
 * @returns The validated items.
 * @throws When the file is missing, has no labels, or an item lacks id/state/question/expected.
 */
export function loadDecideCalibration(labelsPath: string): DecideCalibrationItem[] {
  if (!existsSync(labelsPath)) {
    throw new Error(`Decision label file not found: ${labelsPath}`);
  }
  const parsed = JSON.parse(readFileSync(labelsPath, "utf-8")) as DecideCalibrationFile;
  if (!Array.isArray(parsed.labels) || parsed.labels.length === 0) {
    throw new Error(`Decision label file has no labels: ${labelsPath}`);
  }
  for (const item of parsed.labels) {
    if (!item.id || !item.state || !item.question?.type || !item.question?.instructions || !item.expected) {
      throw new Error(`Malformed decision label (needs id, state, question, expected): ${JSON.stringify(item)}`);
    }
  }
  return parsed.labels;
}

/** One scored calibration item. */
export interface ScoredDecisionItem {
  item: DecideCalibrationItem;
  /** Normalized prediction (`"true"`/`"false"`, option key, or level label), or undefined. */
  predicted: string | undefined;
  correct: boolean;
  /** Probability assigned to the predicted answer (0.5 fallback when the model reports none). */
  confidence: number;
  /** Probability assigned to the expected answer, when derivable (choice/noul). */
  pExpected: number | null;
  latencyMs: number;
}

/** Argmax over a probability record (stable for ties: first key wins). */
function argmaxRecord(probs: Record<string, number>): string | undefined {
  let best: string | undefined;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (const [key, value] of Object.entries(probs)) {
    if (value > bestValue) {
      best = key;
      bestValue = value;
    }
  }
  return best;
}

/**
 * Score one model answer against the expected label.
 *
 * Pure function — no provider needed, which is what makes the math unit-testable.
 *
 * @param item - The labelled item.
 * @param answer - The model's answer (may be undefined when the provider skipped it).
 * @param latencyMs - Measured call latency.
 * @returns Prediction, correctness, prediction confidence, expected-class probability.
 */
export function scoreDecisionAnswer(
  item: DecideCalibrationItem,
  answer: DecisionAnswer | undefined,
  latencyMs: number,
): ScoredDecisionItem {
  const base = { item, latencyMs };
  if (!answer) {
    return { ...base, predicted: undefined, correct: false, confidence: 0, pExpected: null };
  }

  if (item.question.type === "noul") {
    const pTrue = answer.noul;
    if (typeof pTrue !== "number" || !Number.isFinite(pTrue)) {
      return { ...base, predicted: undefined, correct: false, confidence: 0, pExpected: null };
    }
    const predictedBool = pTrue >= 0.5;
    const predicted = predictedBool ? "true" : "false";
    const expectedBool = item.expected.trim().toLowerCase() === "true";
    return {
      ...base,
      predicted,
      correct: predictedBool === expectedBool,
      confidence: predictedBool ? pTrue : 1 - pTrue,
      pExpected: expectedBool ? pTrue : 1 - pTrue,
    };
  }

  // choice / score: prefer the explicit choice, else argmax of the probability map.
  const probs = answer.probabilities;
  const probRecord =
    probs !== null && typeof probs === "object" && !Array.isArray(probs)
      ? (probs as Record<string, number>)
      : undefined;

  let predicted: string | undefined = answer.choice;
  if (item.question.type === "score") {
    const levels = answer.legend ?? (Array.isArray(item.question.criteria) ? item.question.criteria : undefined);
    if (typeof answer.score === "number" && levels && levels.length > 0) {
      const idx = Math.min(levels.length - 1, Math.max(0, Math.round(answer.score)));
      predicted = levels[idx];
    }
  }
  if (!predicted && probRecord) {
    predicted = argmaxRecord(probRecord);
  }

  const predictedProbability = predicted !== undefined && probRecord ? probRecord[predicted] : undefined;
  const confidence = typeof predictedProbability === "number"
    ? predictedProbability
    : (typeof answer.confidence === "number" ? answer.confidence : 0.5);
  const expectedProbability = probRecord ? probRecord[item.expected] : undefined;
  const pExpected = typeof expectedProbability === "number" ? expectedProbability : null;

  return {
    ...base,
    predicted,
    correct: predicted !== undefined && predicted === item.expected,
    confidence,
    pExpected,
  };
}

/** One confidence bin of the reliability diagram. */
export interface CalibrationBin {
  lo: number;
  hi: number;
  count: number;
  /** Mean confidence of the predictions in this bin. */
  confidence: number;
  /** Share of correct predictions in this bin. */
  accuracy: number;
}

/** Aggregate calibration metrics. */
export interface CalibrationSummary {
  /** Total items. */
  n: number;
  /** Items the model actually answered (prediction present). */
  answered: number;
  accuracy: number;
  /** Expected calibration error over `bins` equal-width confidence bins. */
  ece: number;
  /** Mean squared error of confidence vs. correctness. */
  brier: number;
  meanConfidence: number;
  /** Mean probability assigned to the expected answer (noul/choice only, when derivable). */
  meanPExpected: number | null;
  bins: CalibrationBin[];
}

/**
 * Aggregate scored items into accuracy / ECE / Brier.
 *
 * @param items - Scored items (unanswered ones count against accuracy but not into bins).
 * @param binCount - Number of equal-width confidence bins (default 10).
 * @returns The calibration summary including the reliability bins.
 */
export function summarizeCalibration(items: ScoredDecisionItem[], binCount = 10): CalibrationSummary {
  const n = items.length;
  const answeredItems = items.filter((item) => item.predicted !== undefined);
  const accuracy = n > 0 ? items.filter((item) => item.correct).length / n : 0;

  const bins: CalibrationBin[] = [];
  for (let i = 0; i < binCount; i++) {
    const lo = i / binCount;
    const hi = (i + 1) / binCount;
    const inBin = answeredItems.filter((item) =>
      i === binCount - 1 ? item.confidence >= lo && item.confidence <= hi : item.confidence >= lo && item.confidence < hi,
    );
    bins.push({
      lo,
      hi,
      count: inBin.length,
      confidence: inBin.length > 0 ? inBin.reduce((s, item) => s + item.confidence, 0) / inBin.length : 0,
      accuracy: inBin.length > 0 ? inBin.filter((item) => item.correct).length / inBin.length : 0,
    });
  }

  let ece = 0;
  for (const bin of bins) {
    if (bin.count === 0) continue;
    ece += (bin.count / Math.max(answeredItems.length, 1)) * Math.abs(bin.accuracy - bin.confidence);
  }

  const brier = answeredItems.length > 0
    ? answeredItems.reduce((s, item) => s + (item.confidence - (item.correct ? 1 : 0)) ** 2, 0) / answeredItems.length
    : 0;
  const meanConfidence = answeredItems.length > 0
    ? answeredItems.reduce((s, item) => s + item.confidence, 0) / answeredItems.length
    : 0;
  const expectedProbs = items.map((item) => item.pExpected).filter((p): p is number => p !== null);
  const meanPExpected = expectedProbs.length > 0
    ? expectedProbs.reduce((s, p) => s + p, 0) / expectedProbs.length
    : null;

  return {
    n,
    answered: answeredItems.length,
    accuracy,
    ece,
    brier,
    meanConfidence,
    meanPExpected,
    bins,
  };
}

/** Options for {@link runDecideCalibration}. */
export interface DecideCalibrationRunOptions {
  items: DecideCalibrationItem[];
  provider: DecisionProvider;
  /** Progress line callback (defaults to console.log). */
  log?: (line: string) => void;
}

/**
 * Run every calibration item through the decision provider and score the answers.
 *
 * @param opts - Items, provider, logger.
 * @returns Scored items and the aggregate summary.
 * @throws When the provider fails for the very first item (e.g. Ollama down) — the
 *   caller should surface the provider error instead of a misleading 0% accuracy.
 */
export async function runDecideCalibration(
  opts: DecideCalibrationRunOptions,
): Promise<{ scored: ScoredDecisionItem[]; summary: CalibrationSummary }> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const scored: ScoredDecisionItem[] = [];
  for (const item of opts.items) {
    const t0 = performance.now();
    const result = await opts.provider.decide({
      state: item.state,
      questions: [{ id: item.id, type: item.question.type, instructions: item.question.instructions, criteria: item.question.criteria }],
    });
    const latencyMs = performance.now() - t0;
    const answer = result.answers.find((candidate) => candidate.id === item.id) ?? result.answers[0];
    const outcome = scoreDecisionAnswer(item, answer, latencyMs);
    scored.push(outcome);
    const mark = outcome.predicted === undefined ? "NO ANSWER" : outcome.correct ? "ok" : "WRONG";
    log(
      `    ${item.id.padEnd(16)} ${String(outcome.predicted ?? "-").padEnd(10)} conf ${outcome.confidence.toFixed(2)} ` +
      `(${mark}, ${latencyMs.toFixed(0)}ms)`,
    );
  }
  return { scored, summary: summarizeCalibration(scored) };
}
