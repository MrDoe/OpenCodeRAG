/**
 * @fileoverview Golden-set-driven retrieval hyperparameter tuner.
 *
 * The retrieval fusion weights shipped in the config (`keywordWeight`,
 * `symbolKeywordWeight`, …) are a single hardcoded default, but the optimum
 * depends on the embedder, the corpus and the query mix — a code embedder
 * ranks identifiers well through the vector half alone, while a general
 * embedder leans on the keyword half. This module sweeps a small grid of
 * candidates against the labelled golden set and reports which one wins.
 *
 * The metric implementation is shared with `eval:gate` (and therefore with
 * the rerank A/B harness) so the tuner can never report different numbers
 * than the gate for the same labels.
 */
import type { RagConfig } from "../core/config.js";
import type { SearchResult } from "../core/interfaces.js";
import {
  runGoldenGate,
  type GoldenGateRunOptions,
} from "./golden-gate.js";
import type { GoldenLabel, GoldenOutcome, GoldenSummary } from "./golden-set.js";

/** One point in the retrieval search space. */
export interface TuningCandidate {
  /** RRF keyword weight: 0 = pure vector ranking, 1 = pure keyword ranking. */
  keywordWeight: number;
  /** Keyword weight for bare-identifier queries. Defaults to `keywordWeight`. */
  symbolKeywordWeight?: number;
  /** Minimum fused score a result must reach. */
  minScore: number;
  /** Number of results requested from the pipeline. */
  topK: number;
}

/** A candidate together with its measured quality. */
export interface TuningResult extends TuningCandidate {
  /** Aggregate metrics over the whole label set. */
  summary: GoldenSummary;
  /** Per-label outcomes, for drill-down. */
  outcomes: GoldenOutcome[];
  /** Wall-clock duration of the candidate run in milliseconds. */
  durationMs: number;
}

/** Options for {@link buildCandidateGrid}. */
export interface CandidateGridOptions {
  /** Keyword weights to try. Defaults to `[0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6]`. */
  keywordWeights?: number[];
  /** Symbol keyword weights to try. Defaults to the keyword weights. */
  symbolKeywordWeights?: number[];
  /** Minimum scores to try. Defaults to `[base.minScore]`. */
  minScores?: number[];
  /** Top-K values to try. Defaults to `[base.topK]`. */
  topKs?: number[];
  /** Hard cap on the number of candidates (default 64). */
  maxCandidates?: number;
}

/** Metrics a candidate can be ranked by. */
export type TuningMetric = "ndcg10" | "hit5" | "hit1" | "mrr";

/** The metric used to pick the winner, and the tie-breakers after it. */
const METRIC_ORDER: Record<TuningMetric, (s: GoldenSummary) => number> = {
  ndcg10: (s) => s.ndcg10,
  hit5: (s) => s.hit5,
  hit1: (s) => s.hit1,
  mrr: (s) => s.mrr,
};

/**
 * Build the candidate grid.
 *
 * The base candidate is always included so the sweep can be compared against
 * the configuration that is actually running. Duplicates (same weights, same
 * minScore, same topK) are removed, and the grid is capped so a wide sweep
 * cannot turn into an accidental benchmark.
 *
 * @param base - The candidate describing the current configuration.
 * @param options - Grid overrides.
 * @returns The candidate list, base candidate first.
 */
export function buildCandidateGrid(
  base: TuningCandidate,
  options: CandidateGridOptions = {},
): TuningCandidate[] {
  const keywordWeights = options.keywordWeights ?? [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
  const symbolKeywordWeights = options.symbolKeywordWeights ?? keywordWeights;
  const minScores = options.minScores ?? [base.minScore];
  const topKs = options.topKs ?? [base.topK];
  const maxCandidates = options.maxCandidates ?? 64;

  const seen = new Set<string>();
  const candidates: TuningCandidate[] = [];
  const push = (candidate: TuningCandidate): void => {
    const key = [
      candidate.keywordWeight,
      candidate.symbolKeywordWeight ?? "unset",
      candidate.minScore,
      candidate.topK,
    ].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  push({ ...base });
  for (const topK of topKs) {
    for (const minScore of minScores) {
      for (const keywordWeight of keywordWeights) {
        for (const symbolKeywordWeight of symbolKeywordWeights) {
          push({ keywordWeight, symbolKeywordWeight, minScore, topK });
          if (candidates.length >= maxCandidates) return candidates;
        }
      }
    }
  }
  return candidates;
}

/** Options for {@link runTuner}. */
export interface RunTunerOptions {
  /** The labelled queries to measure. */
  labels: GoldenLabel[];
  /** Workspace root used to relativize result paths. */
  root: string;
  /**
   * Retrieve closure for one candidate. The caller owns the embedder/store
   * wiring and maps the candidate onto the production retrieval options.
   */
  retrieve: (label: GoldenLabel, candidate: TuningCandidate) => Promise<SearchResult[]>;
  /** The candidates to evaluate. */
  candidates: TuningCandidate[];
  /** Progress line callback (defaults to console.log). */
  log?: (line: string) => void;
}

/**
 * Evaluate every candidate against the golden set.
 *
 * @param opts - Labels, root, retrieve closure, candidates, logger.
 * @returns One result per candidate, in the order the candidates were given.
 */
export async function runTuner(opts: RunTunerOptions): Promise<TuningResult[]> {
  const log = opts.log ?? (() => {});
  const results: TuningResult[] = [];

  for (const candidate of opts.candidates) {
    const started = performance.now();
    const gateOpts: GoldenGateRunOptions = {
      labels: opts.labels,
      root: opts.root,
      retrieve: (label) => opts.retrieve(label, candidate),
      log: () => {},
    };
    const { summary, outcomes } = await runGoldenGate(gateOpts);
    const durationMs = performance.now() - started;
    results.push({ ...candidate, summary, outcomes, durationMs });
    log(
      `    kw=${candidate.keywordWeight} skw=${candidate.symbolKeywordWeight ?? "-"} ` +
      `minScore=${candidate.minScore} topK=${candidate.topK}  ` +
      `Hit@5 ${(summary.hit5 * 100).toFixed(1)}%  MRR ${summary.mrr.toFixed(3)}  ` +
      `nDCG@10 ${summary.ndcg10.toFixed(3)}  (${durationMs.toFixed(0)}ms)`,
    );
  }
  return results;
}

/**
 * Pick the best candidate.
 *
 * Ranked by the primary metric, then by Hit@5, MRR and Hit@1 so a tie on the
 * primary metric still resolves to the more useful configuration.
 *
 * @param results - The measured candidates.
 * @param metric - The primary metric (default `ndcg10`).
 * @returns The winning result, or `undefined` when there are no results.
 */
export function selectBestTuning(
  results: TuningResult[],
  metric: TuningMetric = "ndcg10",
): TuningResult | undefined {
  if (results.length === 0) return undefined;
  const primary = METRIC_ORDER[metric];
  const score = (r: TuningResult): number[] => [
    primary(r.summary),
    r.summary.hit5,
    r.summary.mrr,
    r.summary.hit1,
  ];
  return [...results].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) {
      if (sb[i]! !== sa[i]!) return sb[i]! - sa[i]!;
    }
    return 0;
  })[0];
}

/**
 * Compare the winner against the candidate that describes the current config.
 *
 * @param best - The winning candidate.
 * @param current - The candidate describing the running configuration.
 * @returns The per-metric deltas (winner minus current).
 */
export function tuningDelta(
  best: TuningResult,
  current: TuningResult | undefined,
): Record<string, number> {
  if (!current) return {};
  return {
    hit1: best.summary.hit1 - current.summary.hit1,
    hit3: best.summary.hit3 - current.summary.hit3,
    hit5: best.summary.hit5 - current.summary.hit5,
    hit10: best.summary.hit10 - current.summary.hit10,
    mrr: best.summary.mrr - current.summary.mrr,
    ndcg10: best.summary.ndcg10 - current.summary.ndcg10,
  };
}

/**
 * Write the winning weights into a copy of the configuration.
 *
 * The input config is not mutated — the caller decides whether to persist the
 * result. Only the retrieval section is touched.
 *
 * @param config - The configuration to base the result on.
 * @param best - The winning candidate.
 * @returns A new config with the winning fusion weights applied.
 */
export function applyTuningToConfig(
  config: RagConfig,
  best: TuningCandidate,
): RagConfig {
  const hybrid = config.retrieval.hybridSearch ?? { enabled: true, keywordWeight: best.keywordWeight };
  return {
    ...config,
    retrieval: {
      ...config.retrieval,
      topK: best.topK,
      minScore: best.minScore,
      hybridSearch: {
        ...hybrid,
        enabled: hybrid.enabled ?? true,
        keywordWeight: best.keywordWeight,
        symbolKeywordWeight: best.symbolKeywordWeight ?? hybrid.symbolKeywordWeight,
      },
    },
  };
}
