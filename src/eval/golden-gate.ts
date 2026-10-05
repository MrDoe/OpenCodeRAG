/**
 * @fileoverview Retrieval golden-set gate. Runs the labelled queries through the real
 * retrieval pipeline (fusion only — the rerank stage stays out of the measurement) and
 * fails when headline ranking metrics drop below documented floors. Meant as a release
 * check with a live embedder and an indexed workspace; `eval:gate` is the CLI entry.
 *
 * Motivation (XERJ's "link the harness or drop the number"): a documented metric is only
 * trustworthy when a command reproduces it and a gate notices when it regresses.
 */
import type { SearchResult } from "../core/interfaces.js";
import {
  evaluateGoldenResults,
  summarizeGoldenOutcomes,
  type GoldenLabel,
  type GoldenOutcome,
  type GoldenSummary,
} from "./golden-set.js";

/** Minimum metric floors the gate checks (values in [0,1]; undefined = not checked). */
export interface GateThresholds {
  /** Minimum mean Hit@5. */
  hit5?: number;
  /** Minimum mean reciprocal rank. */
  mrr?: number;
  /** Minimum mean nDCG@10. */
  ndcg10?: number;
}

/**
 * Default floors, calibrated against the reference setup (Qwen3-Embedding:8B, 48 labels)
 * with headroom below the measured fusion baseline (Hit@5 47.9%, MRR 0.339, nDCG@10 0.428
 * on 2026-10-02) so a small wobble does not false-fail a release but a real regression does.
 */
export const DEFAULT_GATE_THRESHOLDS: Required<GateThresholds> = {
  hit5: 0.35,
  mrr: 0.25,
  ndcg10: 0.32,
};

/** One checked metric row. */
export interface GateRow {
  metric: string;
  actual: number;
  required: number;
  pass: boolean;
}

/**
 * Compare a summary against the thresholds.
 *
 * @param summary - Aggregated golden-set metrics.
 * @param thresholds - Floors to check; omitted metrics are not gated.
 * @returns `pass` plus one row per checked metric.
 */
export function evaluateGate(
  summary: GoldenSummary,
  thresholds: GateThresholds,
): { pass: boolean; rows: GateRow[] } {
  const checks: Array<[string, number, number | undefined]> = [
    ["Hit@5", summary.hit5, thresholds.hit5],
    ["MRR", summary.mrr, thresholds.mrr],
    ["nDCG@10", summary.ndcg10, thresholds.ndcg10],
  ];
  const rows: GateRow[] = [];
  for (const [metric, actual, required] of checks) {
    if (required === undefined) continue;
    rows.push({ metric, actual, required, pass: actual + 1e-9 >= required });
  }
  return { pass: rows.every((row) => row.pass), rows };
}

/** Options for {@link runGoldenGate}. */
export interface GoldenGateRunOptions {
  /** Labels to run (already filtered). */
  labels: GoldenLabel[];
  /** Workspace root used to relativize result paths. */
  root: string;
  /** Retrieve closure built by the caller (owns embedder/store/config wiring). */
  retrieve: (label: GoldenLabel) => Promise<SearchResult[]>;
  /** Progress line callback (defaults to console.log). */
  log?: (line: string) => void;
}

/**
 * Run every label through the supplied retrieve closure and aggregate the metrics.
 *
 * @param opts - Labels, root, retrieve closure, logger.
 * @returns The aggregate summary plus the per-query outcomes.
 */
export async function runGoldenGate(
  opts: GoldenGateRunOptions,
): Promise<{ summary: GoldenSummary; outcomes: GoldenOutcome[] }> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const outcomes: GoldenOutcome[] = [];
  for (const label of opts.labels) {
    const t0 = performance.now();
    let results: SearchResult[] = [];
    let failure: string | undefined;
    try {
      results = await opts.retrieve(label);
    } catch (err) {
      failure = (err as Error).message;
    }
    const latencyMs = performance.now() - t0;
    const metrics = evaluateGoldenResults(opts.root, label, results);
    outcomes.push({ label, latencyMs, ...metrics });
    const rankText = metrics.firstHitRank !== null ? `rank ${metrics.firstHitRank}` : "miss";
    log(
      `    ${label.id.padEnd(12)} ${rankText.padEnd(8)} ${latencyMs.toFixed(0)}ms` +
        (failure ? `  ERROR: ${failure}` : ""),
    );
  }
  return { summary: summarizeGoldenOutcomes(outcomes), outcomes };
}
