/**
 * @fileoverview Compare two branch benchmark JSON outputs and produce a side-by-side
 * analysis report (console table + markdown file).
 *
 * Usage: node --import tsx src/eval/compare-merge.ts
 *   --main doc/eval-results-main.json
 *   --branch doc/eval-results-t1-cosine-l2.json
 *   --output doc/eval-branch-compare-report.md
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Types duplicated here so the script can be copied to the main branch
// without depending on run-branch-compare.ts imports.
interface TopResultEntry {
  rank: number;
  score: number;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  explanation?: {
    vectorScore: number;
    keywordScore: number;
    rawVectorScore: number;
    rawKeywordScore: number;
    keywordWeight: number;
    vectorRank?: number;
    keywordRank?: number;
    matchedTerms?: string[];
  };
}

interface ThresholdResult {
  threshold: number;
  passedCount: number;
  wouldInject: boolean;
}

interface QueryResult {
  query: string;
  queryIndex: number;
  resultCount: number;
  latencyMs: number;
  topResults: TopResultEntry[];
  thresholdAnalysis: ThresholdResult[];
}

interface BenchmarkOutput {
  branch: string;
  commit: string;
  timestamp: string;
  config: {
    embeddingProvider: string;
    embeddingModel: string;
    topK: number;
    minScore: number;
    hybridEnabled: boolean;
    keywordWeight: number;
  };
  indexChunkCount: number;
  queries: QueryResult[];
}

function parseArgs(): { main: string; branch: string; output: string } {
  const args = process.argv.slice(2);
  let main = "";
  let branch = "";
  let output = "doc/eval-branch-compare-report.md";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--main" && args[i + 1]) {
      main = path.resolve(args[i + 1]!);
      i++;
    } else if (args[i] === "--branch" && args[i + 1]) {
      branch = path.resolve(args[i + 1]!);
      i++;
    } else if (args[i] === "--output" && args[i + 1]) {
      output = path.resolve(args[i + 1]!);
      i++;
    }
  }

  if (!main || !branch) {
    console.error("Usage: node --import tsx src/eval/compare-merge.ts --main <json> --branch <json> [--output <md>]");
    process.exit(1);
  }

  return { main, branch, output };
}

// ---- Statistics helpers ----

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!;
}

function stdev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = avg(arr);
  const sqDiffs = arr.map((v) => (v - m) ** 2);
  return Math.sqrt(sqDiffs.reduce((s, v) => s + v, 0) / (arr.length - 1));
}

function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 1 : intersection.size / union.size;
}

// ---- Formatting helpers ----

function fmt(n: number, decimals = 3): string {
  return n.toFixed(decimals);
}

function deltaStr(a: number, b: number, decimals = 3): string {
  const diff = b - a;
  const sign = diff >= 0 ? "+" : "";
  return `${sign}${fmt(diff, decimals)}`;
}

function deltaStrPct(a: number, b: number): string {
  if (a === 0) return b === 0 ? "±0" : "∞";
  const pct = ((b - a) / Math.abs(a)) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

// ---- Table rendering ----

const SEP = "─";
function cell(s: string, width: number, align: "left" | "right" = "left"): string {
  if (s.length >= width) return s.slice(0, width);
  return align === "left" ? s + " ".repeat(width - s.length) : " ".repeat(width - s.length) + s;
}

function tableRow(cols: string[], widths: number[], aligns: ("left" | "right")[]): string {
  return "│ " + cols.map((c, i) => cell(c, widths[i]!, aligns[i]!)).join(" │ ") + " │";
}

function tableSep(widths: number[]): string {
  return "├─" + widths.map((w) => SEP.repeat(w)).join("─┼─") + "─┤";
}

function tableTop(widths: number[]): string {
  return "┌─" + widths.map((w) => SEP.repeat(w)).join("─┬─") + "─┐";
}

function tableBot(widths: number[]): string {
  return "└─" + widths.map((w) => SEP.repeat(w)).join("─┴─") + "─┘";
}

// ---- Main comparison logic ----

interface ComparisonResult {
  main: BenchmarkOutput;
  branch: BenchmarkOutput;
  perQuery: {
    query: string;
    index: number;
    main: { count: number; topScore: number; latencyMs: number; top3Files: string[] };
    branch: { count: number; topScore: number; latencyMs: number; top3Files: string[] };
  }[];
  stats: {
    topScore: { main: number[]; branch: number[] };
    resultCount: { main: number[]; branch: number[] };
    latency: { main: number[]; branch: number[] };
    jaccardTop3: number[];
  };
  thresholdAnalysis: {
    threshold: number;
    mainInject: number;
    branchInject: number;
  }[];
}

function compare(main: BenchmarkOutput, branch: BenchmarkOutput): ComparisonResult {
  const perQuery: ComparisonResult["perQuery"] = [];
  const topScoreMain: number[] = [];
  const topScoreBranch: number[] = [];
  const countMain: number[] = [];
  const countBranch: number[] = [];
  const latencyMain: number[] = [];
  const latencyBranch: number[] = [];
  const jaccards: number[] = [];

  const maxQueries = Math.max(main.queries.length, branch.queries.length);

  for (let i = 0; i < maxQueries; i++) {
    const mq = main.queries[i];
    const bq = branch.queries[i];
    const query = (mq ?? bq)?.query ?? `[query ${i}]`;

    const mCount = mq?.resultCount ?? 0;
    const bCount = bq?.resultCount ?? 0;
    const mTop = mq?.topResults[0]?.score ?? 0;
    const bTop = bq?.topResults[0]?.score ?? 0;
    const mLat = mq?.latencyMs ?? 0;
    const bLat = bq?.latencyMs ?? 0;

    const mTop3 = (mq?.topResults ?? []).slice(0, 3).map((r) => r.filePath);
    const bTop3 = (bq?.topResults ?? []).slice(0, 3).map((r) => r.filePath);

    topScoreMain.push(mTop);
    topScoreBranch.push(bTop);
    countMain.push(mCount);
    countBranch.push(bCount);
    latencyMain.push(mLat);
    latencyBranch.push(bLat);

    if (mTop3.length > 0 || bTop3.length > 0) {
      jaccards.push(jaccardSimilarity(mTop3, bTop3));
    }

    perQuery.push({
      query,
      index: i,
      main: { count: mCount, topScore: mTop, latencyMs: mLat, top3Files: mTop3 },
      branch: { count: bCount, topScore: bTop, latencyMs: bLat, top3Files: bTop3 },
    });
  }

  // Threshold analysis
  const thresholds = [0.85, 0.75, 0.65, 0.50, 0.35];
  const thresholdAnalysis = thresholds.map((t) => {
    const mainInject = main.queries.filter((q) =>
      q.thresholdAnalysis.find((ta) => ta.threshold === t)?.wouldInject,
    ).length;
    const branchInject = branch.queries.filter((q) =>
      q.thresholdAnalysis.find((ta) => ta.threshold === t)?.wouldInject,
    ).length;
    return { threshold: t, mainInject, branchInject };
  });

  return {
    main,
    branch,
    perQuery,
    stats: {
      topScore: { main: topScoreMain, branch: topScoreBranch },
      resultCount: { main: countMain, branch: countBranch },
      latency: { main: latencyMain, branch: latencyBranch },
      jaccardTop3: jaccards,
    },
    thresholdAnalysis,
  };
}

function printConsole(result: ComparisonResult): void {
  const { main, branch, stats, perQuery, thresholdAnalysis } = result;

  // ── Header ──
  console.log("\n" + SEP.repeat(80));
  console.log(
    `  BRANCH COMPARISON: ${main.branch} (${main.commit}) vs ${branch.branch} (${branch.commit})`,
  );
  console.log(SEP.repeat(80) + "\n");

  // ── Config table ──
  const cfgCols = ["", "main", branch.branch];
  const cfgW = [18, 24, 24];
  const cfgA: ("left" | "right")[] = ["left", "right", "right"];

  console.log("  Config:");
  console.log("  " + tableTop(cfgW));
  console.log("  " + tableRow(cfgCols, cfgW, cfgA));
  console.log("  " + tableSep(cfgW));
  console.log("  " + tableRow(["minScore", fmt(main.config.minScore, 2), fmt(branch.config.minScore, 2)], cfgW, cfgA));
  console.log("  " + tableRow(["keywordWeight", fmt(main.config.keywordWeight, 2), fmt(branch.config.keywordWeight, 2)], cfgW, cfgA));
  console.log("  " + tableRow(["topK", String(main.config.topK), String(branch.config.topK)], cfgW, cfgA));
  console.log("  " + tableRow(["hybrid", String(main.config.hybridEnabled), String(branch.config.hybridEnabled)], cfgW, cfgA));
  console.log("  " + tableRow(["embedding", main.config.embeddingModel, branch.config.embeddingModel], cfgW, cfgA));
  console.log("  " + tableRow(["index chunks", String(main.indexChunkCount), String(branch.indexChunkCount)], cfgW, cfgA));
  console.log("  " + tableBot(cfgW));
  console.log();

  // ── Score quality ──
  const scoreCols = ["", "avg", "median", "p95", "p5", "stdev"];
  const scoreW = [12, 10, 10, 10, 10, 10];
  const scoreA: ("left" | "right")[] = ["left", "right", "right", "right", "right", "right"];

  console.log("  Score Quality (top-1 per query):");
  console.log("  " + tableTop(scoreW));
  console.log("  " + tableRow(scoreCols, scoreW, scoreA));
  console.log("  " + tableSep(scoreW));

  const mScores = stats.topScore.main;
  const bScores = stats.topScore.branch;
  console.log("  " + tableRow([main.branch, fmt(avg(mScores)), fmt(median(mScores)), fmt(percentile(mScores, 95)), fmt(percentile(mScores, 5)), fmt(stdev(mScores))], scoreW, scoreA));
  console.log("  " + tableRow([branch.branch, fmt(avg(bScores)), fmt(median(bScores)), fmt(percentile(bScores, 95)), fmt(percentile(bScores, 5)), fmt(stdev(bScores))], scoreW, scoreA));
  console.log("  " + tableRow(["Δ", deltaStr(avg(mScores), avg(bScores)), deltaStr(median(mScores), median(bScores)), deltaStr(percentile(mScores, 95), percentile(bScores, 95)), deltaStr(percentile(mScores, 5), percentile(bScores, 5)), ""], scoreW, scoreA));
  console.log("  " + tableBot(scoreW));
  console.log();

  // ── Result count ──
  console.log("  Result Count (per query):");
  console.log("  " + tableTop(scoreW));
  console.log("  " + tableRow(scoreCols, scoreW, scoreA));
  console.log("  " + tableSep(scoreW));

  const mCount = stats.resultCount.main;
  const bCount = stats.resultCount.branch;
  console.log("  " + tableRow([main.branch, fmt(avg(mCount), 1), fmt(median(mCount), 1), fmt(percentile(mCount, 95), 1), fmt(percentile(mCount, 5), 1), fmt(stdev(mCount), 1)], scoreW, scoreA));
  console.log("  " + tableRow([branch.branch, fmt(avg(bCount), 1), fmt(median(bCount), 1), fmt(percentile(bCount, 95), 1), fmt(percentile(bCount, 5), 1), fmt(stdev(bCount), 1)], scoreW, scoreA));
  console.log("  " + tableRow(["Δ", deltaStr(avg(mCount), avg(bCount), 1), deltaStr(median(mCount), median(bCount), 1), "", "", ""], scoreW, scoreA));
  console.log("  " + tableBot(scoreW));
  console.log();

  // ── Latency ──
  console.log("  Latency (ms per query):");
  console.log("  " + tableTop(scoreW));
  console.log("  " + tableRow(scoreCols, scoreW, scoreA));
  console.log("  " + tableSep(scoreW));

  const mLat = stats.latency.main;
  const bLat = stats.latency.branch;
  console.log("  " + tableRow([main.branch, fmt(avg(mLat), 1), fmt(median(mLat), 1), fmt(percentile(mLat, 95), 1), fmt(percentile(mLat, 5), 1), fmt(stdev(mLat), 1)], scoreW, scoreA));
  console.log("  " + tableRow([branch.branch, fmt(avg(bLat), 1), fmt(median(bLat), 1), fmt(percentile(bLat, 95), 1), fmt(percentile(bLat, 5), 1), fmt(stdev(bLat), 1)], scoreW, scoreA));
  console.log("  " + tableRow(["Δ", deltaStr(avg(mLat), avg(bLat), 1), deltaStr(median(mLat), median(bLat), 1), "", "", ""], scoreW, scoreA));
  console.log("  " + tableBot(scoreW));
  console.log();

  // ── Threshold coverage ──
  const thCols = ["threshold", main.branch, branch.branch, "Δ"];
  const thW = [12, 12, 16, 10];
  const thA: ("left" | "right")[] = ["left", "right", "right", "right"];

  console.log("  Threshold Coverage (queries that would inject):");
  console.log("  " + tableTop(thW));
  console.log("  " + tableRow(thCols, thW, thA));
  console.log("  " + tableSep(thW));
  for (const ta of thresholdAnalysis) {
    const diff = ta.branchInject - ta.mainInject;
    const d = diff >= 0 ? `+${diff}` : `${diff}`;
    console.log(
      "  " + tableRow(
        [fmt(ta.threshold, 2), `${ta.mainInject}/${perQuery.length}`, `${ta.branchInject}/${perQuery.length}`, d],
        thW,
        thA,
      ),
    );
  }
  console.log("  " + tableBot(thW));
  console.log();

  // ── Rank stability ──
  const jaccard = stats.jaccardTop3;
  console.log(`  Rank Stability (Jaccard top-3 files per query):`);
  console.log(`    avg:    ${fmt(avg(jaccard), 3)}`);
  console.log(`    median: ${fmt(median(jaccard), 3)}`);
  console.log(`    min:    ${fmt(Math.min(...jaccard), 3)}`);
  console.log(`    max:    ${fmt(Math.max(...jaccard), 3)}`);
  console.log();

  // ── Per-query table ──
  const pqCols = ["#", "Query (truncated)", `${main.branch} score`, `${branch.branch} score`, "Δ", `${main.branch} files`, `${branch.branch} files`];
  const pqW = [3, 42, 14, 16, 10, 28, 28];
  const pqA: ("left" | "right")[] = ["right", "left", "right", "right", "right", "left", "left"];

  console.log("  Per-Query Summary:");
  console.log("  " + tableTop(pqW));
  console.log("  " + tableRow(pqCols, pqW, pqA));
  console.log("  " + tableSep(pqW));

  for (const pq of perQuery) {
    const q = pq.query.length > 39 ? pq.query.substring(0, 36) + "..." : pq.query;
    const mFiles = pq.main.top3Files.map((f) => f.split("/").pop() ?? f).join(", ");
    const bFiles = pq.branch.top3Files.map((f) => f.split("/").pop() ?? f).join(", ");
    console.log(
      "  " + tableRow(
        [
          String(pq.index + 1),
          q,
          fmt(pq.main.topScore),
          fmt(pq.branch.topScore),
          deltaStr(pq.main.topScore, pq.branch.topScore),
          mFiles.length > 27 ? mFiles.substring(0, 24) + "..." : mFiles,
          bFiles.length > 27 ? bFiles.substring(0, 24) + "..." : bFiles,
        ],
        pqW,
        pqA,
      ),
    );
  }
  console.log("  " + tableBot(pqW));
  console.log();
}

function generateReport(result: ComparisonResult): string {
  const { main, branch, stats, perQuery, thresholdAnalysis } = result;
  const lines: string[] = [];

  lines.push("# Branch Comparison Report");
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Main branch:** \`${main.branch}\` @ \`${main.commit}\` (${main.timestamp.split("T")[0]})`);
  lines.push(`**Feature branch:** \`${branch.branch}\` @ \`${branch.commit}\` (${branch.timestamp.split("T")[0]})`);
  lines.push("");

  // ── Configuration ──
  lines.push("## Configuration");
  lines.push("");
  lines.push("| Setting | `" + main.branch + "` | `" + branch.branch + "` |");
  lines.push("|---|---|---|");
  lines.push(`| Embedding provider | ${main.config.embeddingProvider} | ${branch.config.embeddingProvider} |`);
  lines.push(`| Embedding model | ${main.config.embeddingModel} | ${branch.config.embeddingModel} |`);
  lines.push(`| topK | ${main.config.topK} | ${branch.config.topK} |`);
  lines.push(`| minScore | ${main.config.minScore} | ${branch.config.minScore} |`);
  lines.push(`| Hybrid search | ${main.config.hybridEnabled} | ${branch.config.hybridEnabled} |`);
  lines.push(`| Keyword weight | ${main.config.keywordWeight} | ${branch.config.keywordWeight} |`);
  lines.push(`| Indexed chunks | ${main.indexChunkCount} | ${branch.indexChunkCount} |`);
  lines.push("");

  // ── Scoring method ──
  lines.push("## Scoring Method Differences");
  lines.push("");
  lines.push("| Aspect | `" + main.branch + "` | `" + branch.branch + "` |");
  lines.push("|---|---|---|");
  lines.push("| Vector scoring | `1 / (1 + L2 distance)` | Cosine similarity via L2-normalized vectors |");
  lines.push("| Hybrid fusion | Weighted linear: `(1-kw)*normV + kw*normK` | Reciprocal Rank Fusion (RRF, K=60) |");
  lines.push("| Default minScore | " + main.config.minScore + " | " + branch.config.minScore + " |");
  lines.push("| Metadata filter | Not supported | `MetadataFilter` support added |");
  lines.push("");

  // ── Score quality ──
  const mScores = stats.topScore.main;
  const bScores = stats.topScore.branch;
  lines.push("## Top-1 Score Quality");
  lines.push("");
  lines.push("| Metric | `" + main.branch + "` | `" + branch.branch + "` | Δ | Δ% |");
  lines.push("|---|---|---|---|---|");
  lines.push(`| Average | ${fmt(avg(mScores))} | ${fmt(avg(bScores))} | ${deltaStr(avg(mScores), avg(bScores))} | ${deltaStrPct(avg(mScores), avg(bScores))} |`);
  lines.push(`| Median | ${fmt(median(mScores))} | ${fmt(median(bScores))} | ${deltaStr(median(mScores), median(bScores))} | ${deltaStrPct(median(mScores), median(bScores))} |`);
  lines.push(`| P95 | ${fmt(percentile(mScores, 95))} | ${fmt(percentile(bScores, 95))} | ${deltaStr(percentile(mScores, 95), percentile(bScores, 95))} | ${deltaStrPct(percentile(mScores, 95), percentile(bScores, 95))} |`);
  lines.push(`| P5 | ${fmt(percentile(mScores, 5))} | ${fmt(percentile(bScores, 5))} | ${deltaStr(percentile(mScores, 5), percentile(bScores, 5))} | ${deltaStrPct(percentile(mScores, 5), percentile(bScores, 5))} |`);
  lines.push(`| Std Dev | ${fmt(stdev(mScores))} | ${fmt(stdev(bScores))} | ${deltaStr(stdev(mScores), stdev(bScores))} | — |`);
  lines.push("");

  lines.push("> **Interpretation:** Cosine similarity produces scores in a tighter 0-1 range.");
  lines.push("> RRF further shifts scores based on rank rather than raw similarity, so comparing");
  lines.push("> absolute scores across branches is misleading. The key metric is **whether the same");
  lines.push("> relevant files appear in the top results** (see Rank Stability below).");
  lines.push("");

  // ── Result count ──
  const mCount = stats.resultCount.main;
  const bCount = stats.resultCount.branch;
  lines.push("## Result Count (per query)");
  lines.push("");
  lines.push("| Metric | `" + main.branch + "` | `" + branch.branch + "` | Δ |");
  lines.push("|---|---|---|---|");
  lines.push(`| Average | ${fmt(avg(mCount), 1)} | ${fmt(avg(bCount), 1)} | ${deltaStr(avg(mCount), avg(bCount), 1)} |`);
  lines.push(`| Median | ${fmt(median(mCount), 1)} | ${fmt(median(bCount), 1)} | ${deltaStr(median(mCount), median(bCount), 1)} |`);
  lines.push(`| P95 | ${fmt(percentile(mCount, 95), 1)} | ${fmt(percentile(bCount, 95), 1)} | — |`);
  lines.push(`| Zero-result queries | ${mCount.filter((c) => c === 0).length} | ${bCount.filter((c) => c === 0).length} | — |`);
  lines.push("");

  // ── Latency ──
  const mLat = stats.latency.main;
  const bLat = stats.latency.branch;
  lines.push("## Latency (ms per query)");
  lines.push("");
  lines.push("| Metric | `" + main.branch + "` | `" + branch.branch + "` | Δ |");
  lines.push("|---|---|---|---|");
  lines.push(`| Average | ${fmt(avg(mLat), 1)} | ${fmt(avg(bLat), 1)} | ${deltaStr(avg(mLat), avg(bLat), 1)} |`);
  lines.push(`| Median | ${fmt(median(mLat), 1)} | ${fmt(median(bLat), 1)} | ${deltaStr(median(mLat), median(bLat), 1)} |`);
  lines.push(`| P95 | ${fmt(percentile(mLat, 95), 1)} | ${fmt(percentile(bLat, 95), 1)} | — |`);
  lines.push("");

  // ── Threshold coverage ──
  lines.push("## Threshold Coverage");
  lines.push("");
  lines.push("Shows how many queries would trigger RAG context injection at each `minScore` threshold.");
  lines.push("");
  lines.push("| Threshold | `" + main.branch + "` | `" + branch.branch + "` | Δ |");
  lines.push("|---|---|---|---|");
  for (const ta of thresholdAnalysis) {
    const diff = ta.branchInject - ta.mainInject;
    const d = diff >= 0 ? `+${diff}` : `${diff}`;
    lines.push(`| ${fmt(ta.threshold, 2)} | ${ta.mainInject}/${perQuery.length} | ${ta.branchInject}/${perQuery.length} | ${d} |`);
  }
  lines.push("");

  // ── Rank stability ──
  const jaccard = stats.jaccardTop3;
  lines.push("## Rank Stability (Jaccard Similarity)");
  lines.push("");
  lines.push("For each query, computes the Jaccard similarity of the top-3 file paths between branches.");
  lines.push("1.0 = identical top-3 files, 0.0 = completely different.");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| Average | ${fmt(avg(jaccard), 3)} |`);
  lines.push(`| Median | ${fmt(median(jaccard), 3)} |`);
  lines.push(`| Minimum | ${fmt(Math.min(...jaccard), 3)} |`);
  lines.push(`| Maximum | ${fmt(Math.max(...jaccard), 3)} |`);
  lines.push("");

  // ── Per-query detailed results ──
  lines.push("## Per-Query Results");
  lines.push("");
  lines.push("| # | Query | `" + main.branch + "` results | `" + main.branch + "` top score | `" + branch.branch + "` results | `" + branch.branch + "` top score | Δ score | Jaccard (top-3) |");
  lines.push("|---|---|---|---|---|---|---|---|");

  for (const pq of perQuery) {
    const q = pq.query.length > 50 ? pq.query.substring(0, 47) + "..." : pq.query;
    const jac = jaccardSimilarity(pq.main.top3Files, pq.branch.top3Files);
    lines.push(
      `| ${pq.index + 1} | ${q} | ${pq.main.count} | ${fmt(pq.main.topScore)} | ${pq.branch.count} | ${fmt(pq.branch.topScore)} | ${deltaStr(pq.main.topScore, pq.branch.topScore)} | ${fmt(jac, 3)} |`,
    );
  }
  lines.push("");

  // ── Raw top-5 outputs side by side ──
  lines.push("## Raw Top-5 Results by Query");
  lines.push("");
  lines.push("Each query shows the top-5 file paths and scores for both branches side by side.");
  lines.push("");

  for (const pq of perQuery) {
    const mq = main.queries[pq.index];
    const bq = branch.queries[pq.index];
    if (!mq && !bq) continue;

    lines.push(`### Query ${pq.index + 1}: ${pq.query}`);
    lines.push("");

    if (mq && mq.topResults.length > 0) {
      lines.push("**`" + main.branch + "`**  ");
      lines.push("| Rank | Score | File | Lines | Language |");
      lines.push("|------|-------|------|-------|----------|");
      for (const tr of mq.topResults) {
        lines.push(`| ${tr.rank + 1} | ${fmt(tr.score)} | \`${tr.filePath}\` | ${tr.startLine}-${tr.endLine} | ${tr.language} |`);
      }
    } else {
      lines.push("**`" + main.branch + "`** — no results");
    }
    lines.push("");

    if (bq && bq.topResults.length > 0) {
      lines.push("**`" + branch.branch + "`**  ");
      lines.push("| Rank | Score | File | Lines | Language |");
      lines.push("|------|-------|------|-------|----------|");
      for (const tr of bq.topResults) {
        lines.push(`| ${tr.rank + 1} | ${fmt(tr.score)} | \`${tr.filePath}\` | ${tr.startLine}-${tr.endLine} | ${tr.language} |`);
      }
    } else {
      lines.push("**`" + branch.branch + "`** — no results");
    }
    lines.push("");
  }

  // ── Explanation comparison (first 3 queries) ──
  lines.push("## Explanation / Score Breakdown (Sample)");
  lines.push("");
  lines.push("First 3 queries with explanation details when available.");
  lines.push("");

  for (let i = 0; i < Math.min(3, perQuery.length); i++) {
    const pq = perQuery[i]!;
    const mq = main.queries[pq.index];
    const bq = branch.queries[pq.index];

    lines.push(`### Query ${pq.index + 1}: ${pq.query}`);
    lines.push("");

    const mExp = mq?.topResults[0]?.explanation;
    const bExp = bq?.topResults[0]?.explanation;

    if (mExp) {
      lines.push("**`" + main.branch + "`** (top-1 explanation)  ");
      lines.push("| Component | Value |");
      lines.push("|-----------|-------|");
      lines.push(`| vectorScore | ${fmt(mExp.vectorScore)} |`);
      lines.push(`| keywordScore | ${fmt(mExp.keywordScore)} |`);
      lines.push(`| rawVectorScore | ${fmt(mExp.rawVectorScore)} |`);
      lines.push(`| rawKeywordScore | ${fmt(mExp.rawKeywordScore)} |`);
      lines.push(`| keywordWeight | ${fmt(mExp.keywordWeight)} |`);
      if (mExp.vectorRank !== undefined) lines.push(`| vectorRank | ${mExp.vectorRank} |`);
      if (mExp.keywordRank !== undefined) lines.push(`| keywordRank | ${mExp.keywordRank} |`);
      if (mExp.matchedTerms?.length) lines.push(`| matchedTerms | ${mExp.matchedTerms.join(", ")} |`);
      lines.push("");
    }

    if (bExp) {
      lines.push("**`" + branch.branch + "`** (top-1 explanation)  ");
      lines.push("| Component | Value |");
      lines.push("|-----------|-------|");
      lines.push(`| vectorScore | ${fmt(bExp.vectorScore)} |`);
      lines.push(`| keywordScore | ${fmt(bExp.keywordScore)} |`);
      lines.push(`| rawVectorScore | ${fmt(bExp.rawVectorScore)} |`);
      lines.push(`| rawKeywordScore | ${fmt(bExp.rawKeywordScore)} |`);
      lines.push(`| keywordWeight | ${fmt(bExp.keywordWeight)} |`);
      if (bExp.vectorRank !== undefined) lines.push(`| vectorRank | ${bExp.vectorRank} |`);
      if (bExp.keywordRank !== undefined) lines.push(`| keywordRank | ${bExp.keywordRank} |`);
      if (bExp.matchedTerms?.length) lines.push(`| matchedTerms | ${bExp.matchedTerms.join(", ")} |`);
      lines.push("");
    }
  }

  // ── Verdict ──
  lines.push("## Verdict");
  lines.push("");

  const mAvg = avg(mScores);
  const bAvg = avg(bScores);
  const mji = thresholdAnalysis.find((t) => t.threshold === 0.75)?.mainInject ?? 0;
  const bji = thresholdAnalysis.find((t) => t.threshold === 0.75)?.branchInject ?? 0;
  const mZero = mCount.filter((c) => c === 0).length;
  const bZero = bCount.filter((c) => c === 0).length;
  const avgJac = avg(jaccard);

  const improvements: string[] = [];
  if (bAvg > mAvg) improvements.push(`higher top-1 scores (avg ${fmt(bAvg)} vs ${fmt(mAvg)})`);
  if (bji > mji) improvements.push(`better threshold coverage (${bji}/${perQuery.length} vs ${mji}/${perQuery.length} at minScore 0.75)`);
  if (bZero < mZero) improvements.push(`fewer zero-result queries (${bZero} vs ${mZero})`);
  if (avgJac > 0.5) improvements.push("high rank stability with main (Jaccard " + fmt(avgJac, 3) + ")");
  else improvements.push("notable rank shift (Jaccard " + fmt(avgJac, 3) + ")");

  lines.push("The `" + branch.branch + "` branch shows:");
  lines.push("");
  for (const imp of improvements) {
    lines.push(`- **${imp}**`);
  }
  lines.push("");
  lines.push("### Caveats");
  lines.push("");
  lines.push("- Cosine similarity + RRF produce fundamentally different score distributions than L2 + linear fusion.");
  lines.push("  **Absolute scores are not directly comparable** between the two approaches.");
  lines.push("- The key quality indicator is **whether relevant files rank highly**, not the raw score value.");
  lines.push("- RRF de-emphasizes raw similarity magnitude and focuses on rank agreement between vector and keyword signals.");
  lines.push("- This means an RRF score of 0.05 can be just as meaningful as an L2 score of 0.85 — they are different scales.");
  lines.push("");
  lines.push("### Recommendation");
  lines.push("");
  lines.push("Review the raw top-5 results per query above to confirm that the cosine+RRF approach");
  lines.push("retrieves the same or better files. If rank stability is high (Jaccard > 0.5) and");
  lines.push("threshold coverage improves, the new scoring is likely a net positive.");
  lines.push("");

  return lines.join("\n");
}

async function main() {
  const { main: mainPath, branch: branchPath, output } = parseArgs();

  const mainData: BenchmarkOutput = JSON.parse(readFileSync(mainPath, "utf-8"));
  const branchData: BenchmarkOutput = JSON.parse(readFileSync(branchPath, "utf-8"));

  console.log(`  Main:   ${mainPath}`);
  console.log(`  Branch: ${branchPath}`);
  console.log(`  Output: ${output}\n`);

  const result = compare(mainData, branchData);

  printConsole(result);

  const report = generateReport(result);
  const dir = path.dirname(output);
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
  } catch {
    // dir exists
  }
  writeFileSync(output, report, "utf-8");
  console.log(`  Report written to: ${output}\n`);
}

main().catch((err) => {
  console.error("Compare failed:", err);
  process.exit(1);
});
