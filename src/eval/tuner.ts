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
import {
  evaluateGoldenResults,
  mean,
  type GoldenLabel,
  type GoldenMetrics,
  type GoldenOutcome,
  type GoldenSummary,
} from "./golden-set.js";

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
 * The argmax alone is NOT evidence — on a small label set it is often within
 * noise of the runner-up. Use {@link comparePaired} for the confidence
 * interval before changing anything.
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

/** Per-label value of a tuning metric. */
function metricValue(outcome: GoldenOutcome, metric: TuningMetric): number {
  switch (metric) {
    case "hit5": return outcome.hitAt5;
    case "hit1": return outcome.hitAt1;
    case "mrr": return outcome.rr;
    default: return outcome.ndcg10;
  }
}

/** Paired comparison of two candidates measured on the same labels. */
export interface PairedComparison {
  /** The metric the comparison is based on. */
  metric: TuningMetric;
  /** Mean per-label difference (first candidate minus second). */
  meanDelta: number;
  /** Lower bound of the 95% bootstrap confidence interval. */
  ciLow: number;
  /** Upper bound of the 95% bootstrap confidence interval. */
  ciHigh: number;
  /** Share of bootstrap resamples in which the first candidate wins. */
  pBetter: number;
  /** Labels where the first candidate scored higher. */
  improved: number;
  /** Labels where the second candidate scored higher. */
  regressed: number;
  /** Labels where both scored the same. */
  unchanged: number;
  /** True when the confidence interval includes 0 — the difference is within noise. */
  withinNoise: boolean;
  /**
   * Two-sided exact sign-test p-value over the discordant labels.
   *
   * The bootstrap CI is the optimistic bound: it weights a label by how much it
   * moved. The sign test only asks "how many labels flipped?", which is the
   * conservative reading of a small label set — a 19-vs-11 split is still
   * p ≈ 0.20. Report both.
   */
  signTestP: number;
}

/**
 * Two-sided exact sign-test p-value for `wins` successes out of `wins + losses`
 * trials under a 0.5 null.
 *
 * @param wins - Labels where the first candidate scored higher.
 * @param losses - Labels where the second candidate scored higher.
 * @returns The p-value in [0, 1]; 1 when there are no discordant labels.
 */
export function signTestP(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.max(wins, losses);
  let tail = 0;
  for (let i = k; i <= n; i++) {
    tail += binomial(n, i);
  }
  const p = (tail * 2) / Math.pow(2, n);
  return Math.min(1, p);
}

/** Binomial coefficient C(n, k). */
function binomial(n: number, k: number): number {
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return Math.round(result);
}

/**
 * Compare two candidates with a paired bootstrap over the labels.
 *
 * The label set is small (48 by default), so a point estimate on its own is
 * not evidence: a 10-point Hit@5 gap is a handful of labels, and a sign test
 * on the discordant labels is the honest lower bound. This returns the
 * confidence interval, the win/loss counts, and an explicit `withinNoise`
 * flag so a caller can refuse to recommend a change the data does not support.
 *
 * @param better - The candidate to test.
 * @param other - The candidate to compare against (usually the current config).
 * @param metric - The metric to compare on (default `ndcg10`).
 * @param iterations - Bootstrap resamples (default 20000).
 * @param rng - Random source (injectable for deterministic tests).
 * @returns The paired comparison, or `undefined` when there is nothing to compare.
 */
export function comparePaired(
  better: TuningResult,
  other: TuningResult | undefined,
  metric: TuningMetric = "ndcg10",
  iterations = 20_000,
  rng: () => number = Math.random,
): PairedComparison | undefined {
  if (!other) return undefined;
  const n = Math.min(better.outcomes.length, other.outcomes.length);
  if (n === 0) return undefined;

  const diffs: number[] = [];
  let improved = 0;
  let regressed = 0;
  let unchanged = 0;
  for (let i = 0; i < n; i++) {
    const d = metricValue(better.outcomes[i]!, metric) - metricValue(other.outcomes[i]!, metric);
    diffs.push(d);
    if (d > 1e-9) improved++;
    else if (d < -1e-9) regressed++;
    else unchanged++;
  }

  const meanDelta = diffs.reduce((s, d) => s + d, 0) / n;
  const boots: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += diffs[Math.floor(rng() * n)]!;
    boots.push(sum / n);
  }
  boots.sort((a, b) => a - b);
  const at = (p: number): number => boots[Math.min(boots.length - 1, Math.max(0, Math.floor(p * (boots.length - 1))))]!;
  const ciLow = at(0.025);
  const ciHigh = at(0.975);
  const pBetter = boots.filter((b) => b > 0).length / boots.length;

  return {
    metric,
    meanDelta,
    ciLow,
    ciHigh,
    pBetter,
    improved,
    regressed,
    unchanged,
    withinNoise: ciLow <= 0 && ciHigh >= 0,
    signTestP: signTestP(improved, regressed),
  };
}

/** Aggregate file-level quality of one retrieval signal. */
export interface SignalQuality {
  /** Mean Hit@1 over the labels. */
  hit1: number;
  /** Mean Hit@5 over the labels. */
  hit5: number;
  /** Mean Hit@10 over the labels. */
  hit10: number;
  /** Labels where the expected file was not found at all. */
  misses: number;
}

/** Per-signal quality: the keyword half and the vector half measured apart. */
export interface SignalComparison {
  /** Quality of the keyword (BM25) signal alone. */
  keyword: SignalQuality;
  /** Quality of the vector signal alone. */
  vector: SignalQuality;
  /** Quality of the fused pipeline. */
  fused: SignalQuality;
}

/**
 * Measure each retrieval signal on its own, so a fused number can be
 * interpreted instead of just believed.
 *
 * A fused ranking can only be as good as the mix of its parts: when the
 * keyword half answers far fewer queries than the vector half, any weight
 * given to it dilutes the result. This measures the parts.
 *
 * @param opts - Labels, root, and one retrieve closure per signal.
 * @returns The per-signal quality.
 */
export async function measureSignalQuality(opts: {
  labels: GoldenLabel[];
  root: string;
  /** Retrieve with the keyword signal only. */
  retrieveKeyword: (label: GoldenLabel) => Promise<SearchResult[]>;
  /** Retrieve with the vector signal only. */
  retrieveVector: (label: GoldenLabel) => Promise<SearchResult[]>;
  /** Retrieve with the full pipeline. */
  retrieveFused: (label: GoldenLabel) => Promise<SearchResult[]>;
}): Promise<SignalComparison> {
  const summarize = async (
    retrieve: (label: GoldenLabel) => Promise<SearchResult[]>,
  ): Promise<SignalQuality> => {
    const metrics: GoldenMetrics[] = [];
    for (const label of opts.labels) {
      const results = await retrieve(label);
      metrics.push(evaluateGoldenResults(opts.root, label, results));
    }
    return {
      hit1: mean(metrics.map((m) => m.hitAt1)),
      hit5: mean(metrics.map((m) => m.hitAt5)),
      hit10: mean(metrics.map((m) => m.hitAt10)),
      misses: metrics.filter((m) => m.firstHitRank === null).length,
    };
  };
  return {
    keyword: await summarize(opts.retrieveKeyword),
    vector: await summarize(opts.retrieveVector),
    fused: await summarize(opts.retrieveFused),
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
