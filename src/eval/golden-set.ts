/**
 * @fileoverview Shared golden-set types and ranking metrics. One implementation feeds
 * both the rerank A/B harness (`src/eval/rerank-eval.ts`) and the retrieval gate
 * (`eval:gate`), so the two tools can never report different Hit@k / MRR / nDCG@10
 * numbers for the same labels.
 *
 * Ground truth is a list of queries mapped to **file paths** (plus an optional symbol) —
 * never chunk IDs, which do not survive re-indexing.
 */
import { existsSync, readFileSync } from "node:fs";
import type { SearchResult } from "../core/interfaces.js";

/** One labelled query in the golden set. */
export interface GoldenLabel {
  id: string;
  category: string;
  query: string;
  files: string[];
  symbol?: string;
  note?: string;
}

/** Serialized label file (`src/eval/rerank-labels.json`). */
export interface GoldenLabelFile {
  version: number;
  labels: GoldenLabel[];
}

/**
 * Load and validate a golden-set label file.
 *
 * @param labelsPath - Absolute path to the JSON label file.
 * @returns The validated labels.
 * @throws When the file is missing, has no labels, or a label lacks id/query/files.
 */
export function loadGoldenLabels(labelsPath: string): GoldenLabel[] {
  if (!existsSync(labelsPath)) {
    throw new Error(`Label file not found: ${labelsPath}`);
  }
  const parsed = JSON.parse(readFileSync(labelsPath, "utf-8")) as GoldenLabelFile;
  if (!Array.isArray(parsed.labels) || parsed.labels.length === 0) {
    throw new Error(`Label file has no labels: ${labelsPath}`);
  }
  for (const label of parsed.labels) {
    if (!label.id || !label.query || !Array.isArray(label.files) || label.files.length === 0) {
      throw new Error(`Malformed label (needs id, query, files[]): ${JSON.stringify(label)}`);
    }
  }
  return parsed.labels;
}

/** Make a result path relative to the workspace root, lower-cased for comparison. */
export function toRepoRelative(root: string, filePath: string): string {
  let p = filePath.replace(/\\/g, "/");
  const normalizedRoot = root.replace(/\\/g, "/").toLowerCase();
  const idx = p.toLowerCase().indexOf(normalizedRoot);
  if (idx >= 0) p = p.slice(idx + normalizedRoot.length);
  return p.replace(/^\/+/, "").toLowerCase();
}

/** Ranking metrics for one labelled query. */
export interface GoldenMetrics {
  firstHitRank: number | null;
  hitAt1: number;
  hitAt3: number;
  hitAt5: number;
  hitAt10: number;
  precision5: number;
  recall10: number;
  rr: number;
  ndcg10: number;
  symbolHitRank: number | null;
  topFiles: string[];
  /** True when the rerank stage actually reordered (scoreBreakdown.rerankScore present). */
  rerankRan: boolean;
}

/**
 * Score one label against a ranked result list.
 *
 * @param root - Workspace root used to relativize result paths.
 * @param label - The labelled query (expected files + optional symbol).
 * @param results - Ranked retrieval results.
 * @returns Hit@1/3/5/10, Precision@5, Recall@10, reciprocal rank, nDCG@10, symbol rank.
 */
export function evaluateGoldenResults(
  root: string,
  label: GoldenLabel,
  results: SearchResult[],
): GoldenMetrics {
  const expected = new Set(label.files.map((f) => f.toLowerCase()));
  const fileRank = new Map<string, number>();
  for (const [i, r] of results.entries()) {
    const file = toRepoRelative(root, r.chunk.metadata.filePath);
    if (!fileRank.has(file)) fileRank.set(file, i + 1);
  }

  let firstHitRank: number | null = null;
  for (const [file, rank] of fileRank) {
    if (!expected.has(file)) continue;
    firstHitRank = firstHitRank === null ? rank : Math.min(firstHitRank, rank);
  }

  const foundInK = (k: number): number => {
    let found = 0;
    for (const file of expected) {
      const rank = fileRank.get(file);
      if (rank !== undefined && rank <= k) found += 1;
    }
    return found;
  };
  const hitAt = (k: number): number => (foundInK(k) > 0 ? 1 : 0);

  // nDCG@10 with binary gains, deduplicated per expected file.
  let dcg = 0;
  const gained = new Set<string>();
  for (const [i, r] of results.slice(0, 10).entries()) {
    const file = toRepoRelative(root, r.chunk.metadata.filePath);
    if (expected.has(file) && !gained.has(file)) {
      gained.add(file);
      dcg += 1 / Math.log2(i + 2);
    }
  }
  const idealCount = Math.min(expected.size, 10);
  let idcg = 0;
  for (let i = 0; i < idealCount; i++) idcg += 1 / Math.log2(i + 2);
  const ndcg10 = idcg > 0 ? dcg / idcg : 0;

  let symbolHitRank: number | null = null;
  if (label.symbol) {
    for (const [i, r] of results.entries()) {
      const file = toRepoRelative(root, r.chunk.metadata.filePath);
      if (expected.has(file) && r.chunk.content.includes(label.symbol)) {
        symbolHitRank = i + 1;
        break;
      }
    }
  }

  const rerankRan = results.some((r) => {
    const breakdown = r.explanation?.scoreBreakdown as Record<string, unknown> | undefined;
    return typeof breakdown?.rerankScore === "number";
  });

  return {
    firstHitRank,
    hitAt1: hitAt(1),
    hitAt3: hitAt(3),
    hitAt5: hitAt(5),
    hitAt10: hitAt(10),
    precision5: foundInK(5) / 5,
    recall10: foundInK(10) / Math.max(expected.size, 1),
    rr: firstHitRank !== null ? 1 / firstHitRank : 0,
    ndcg10,
    symbolHitRank,
    topFiles: results.slice(0, 5).map((r) => toRepoRelative(root, r.chunk.metadata.filePath)),
    rerankRan,
  };
}

/** Percentile from a pre-sorted ascending array (`q` in [0,1]). */
export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[idx] ?? 0;
}

/** Arithmetic mean; 0 for an empty list. */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** One scored query: metrics plus the label and the measured latency. */
export interface GoldenOutcome extends GoldenMetrics {
  label: GoldenLabel;
  latencyMs: number;
}

/** Aggregated ranking metrics over a set of scored queries. */
export interface GoldenSummary {
  hit1: number;
  hit3: number;
  hit5: number;
  hit10: number;
  precision5: number;
  recall10: number;
  mrr: number;
  ndcg10: number;
  symbolRate: number;
  latencyAvg: number;
  latencyP50: number;
  latencyP95: number;
}

/**
 * Aggregate per-query metrics into mean Hit@k, MRR, nDCG@10, symbol rate, and latency.
 *
 * @param outcomes - Scored queries.
 * @returns The aggregate summary.
 */
export function summarizeGoldenOutcomes(outcomes: GoldenOutcome[]): GoldenSummary {
  const latencies = outcomes.map((o) => o.latencyMs).sort((a, b) => a - b);
  const withSymbol = outcomes.filter((o) => o.label.symbol);
  return {
    hit1: mean(outcomes.map((o) => o.hitAt1)),
    hit3: mean(outcomes.map((o) => o.hitAt3)),
    hit5: mean(outcomes.map((o) => o.hitAt5)),
    hit10: mean(outcomes.map((o) => o.hitAt10)),
    precision5: mean(outcomes.map((o) => o.precision5)),
    recall10: mean(outcomes.map((o) => o.recall10)),
    mrr: mean(outcomes.map((o) => o.rr)),
    ndcg10: mean(outcomes.map((o) => o.ndcg10)),
    symbolRate: withSymbol.length > 0 ? mean(withSymbol.map((o) => (o.symbolHitRank !== null ? 1 : 0))) : 0,
    latencyAvg: mean(latencies),
    latencyP50: percentile(latencies, 0.5),
    latencyP95: percentile(latencies, 0.95),
  };
}
