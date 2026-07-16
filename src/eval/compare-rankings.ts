/**
 * @fileoverview Ranking order comparison between two branch benchmark runs.
 * Focuses on rank agreement rather than absolute scores.
 *
 * Usage: node --import tsx src/eval/compare-rankings.ts
 *   --main .opencode/rag_db/eval-results/main.json
 *   --branch .opencode/rag_db/eval-results/t1-cosine-l2.json
 *   --output .opencode/rag_db/eval-results/ranking-report.md
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

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

interface QueryResult {
  query: string;
  queryIndex: number;
  resultCount: number;
  latencyMs: number;
  topResults: TopResultEntry[];
  thresholdAnalysis: { threshold: number; passedCount: number; wouldInject: boolean }[];
}

interface BenchmarkOutput {
  branch: string;
  commit: string;
  timestamp: string;
  config: { embeddingProvider: string; embeddingModel: string; topK: number; minScore: number; hybridEnabled: boolean; keywordWeight: number };
  indexChunkCount: number;
  queries: QueryResult[];
}

function parseArgs() {
  const args = process.argv.slice(2);
  let main = "", branch = "", output = ".opencode/rag_db/eval-results/ranking-report.md";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--main" && args[i + 1]) { main = path.resolve(args[i + 1]!); i++; }
    else if (args[i] === "--branch" && args[i + 1]) { branch = path.resolve(args[i + 1]!); i++; }
    else if (args[i] === "--output" && args[i + 1]) { output = path.resolve(args[i + 1]!); i++; }
  }
  if (!main || !branch) {
    console.error("Usage: node --import tsx src/eval/compare-rankings.ts --main <json> --branch <json> [--output <md>]");
    process.exit(1);
  }
  return { main, branch, output };
}

function normalizePath(fp: string): string {
  // Strip clone-directory prefix from paths like "../OpenCodeRAG-main/src/foo.ts"
  return fp.replace(/^\.\.[\/\\][^\/\\]+[\/\\]/, "");
}

function identityKey(r: TopResultEntry): string {
  return normalizePath(r.filePath) + ":" + r.startLine;
}

/** Kendall's tau-b rank correlation for two orderings of the same set. */
function kendallTau(rankA: Map<string, number>, rankB: Map<string, number>): number {
  const ids = [...rankA.keys()];
  let concordant = 0, discordant = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const aI = rankA.get(ids[i]!)!, aJ = rankA.get(ids[j]!)!;
      const bI = rankB.get(ids[i]!)!, bJ = rankB.get(ids[j]!)!;
      const diffA = aI - aJ, diffB = bI - bJ;
      if (diffA * diffB > 0) concordant++;
      else if (diffA * diffB < 0) discordant++;
    }
  }
  const total = concordant + discordant;
  return total === 0 ? 1 : (concordant - discordant) / total;
}

function avg(arr: number[]): number {
  return arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length;
}

async function main() {
  const { main: mainPath, branch: branchPath, output } = parseArgs();

  const mainData: BenchmarkOutput = JSON.parse(readFileSync(mainPath, "utf-8"));
  const branchData: BenchmarkOutput = JSON.parse(readFileSync(branchPath, "utf-8"));

  const mBranch = mainData.branch + " (" + mainData.commit + ")";
  const bBranch = branchData.branch + " (" + branchData.commit + ")";

  const perQuery: {
    query: string;
    top1Same: boolean;
    top3Same: boolean;
    top5Same: boolean;
    topKFullSame: boolean;
    overlapTop5: number;
    overlapTop20: number;
    kendallTau: number;
    mTopScore: number;
    bTopScore: number;
  }[] = [];

  let totalTop1Same = 0, totalTop3Same = 0, totalTop5Same = 0, totalFullSame = 0;
  let totalOverlap5 = 0, totalOverlap20 = 0;
  const kendalls: number[] = [];

  const maxQ = Math.min(mainData.queries.length, branchData.queries.length);
  for (let i = 0; i < maxQ; i++) {
    const mq = mainData.queries[i]!, bq = branchData.queries[i]!;
    const mTop = mq.topResults, bTop = bq.topResults;
    const mKey = mTop.map(identityKey);
    const bKey = bTop.map(identityKey);

    const top1Same = mKey[0] === bKey[0];
    const top3Same = mKey[0] === bKey[0] && mKey[1] === bKey[1] && mKey[2] === bKey[2];
    const top5Same = mKey.slice(0, 5).every((k, j) => k === bKey[j]);
    const topKFullSame = mKey.every((k, j) => k === bKey[j]);

    const set5 = new Set(bKey.slice(0, 5));
    const overlapTop5 = mKey.slice(0, 5).filter((k) => set5.has(k)).length;
    const set20 = new Set(bKey);
    const overlapTop20 = mKey.filter((k) => set20.has(k)).length;

    const aRank = new Map(mKey.map((k, j) => [k, j]));
    const bRank = new Map(bKey.map((k, j) => [k, j]));
    const sharedIds = [...aRank.keys()].filter((k) => bRank.has(k));
    const sharedRankA = new Map(sharedIds.map((k) => [k, aRank.get(k)!]));
    const sharedRankB = new Map(sharedIds.map((k) => [k, bRank.get(k)!]));
    const tau = kendallTau(sharedRankA, sharedRankB);

    if (top1Same) totalTop1Same++;
    if (top3Same) totalTop3Same++;
    if (top5Same) totalTop5Same++;
    if (topKFullSame) totalFullSame++;
    totalOverlap5 += overlapTop5;
    totalOverlap20 += overlapTop20;
    kendalls.push(tau);

    perQuery.push({
      query: mq.query,
      top1Same,
      top3Same,
      top5Same,
      topKFullSame,
      overlapTop5,
      overlapTop20,
      kendallTau: tau,
      mTopScore: mTop[0]?.score ?? 0,
      bTopScore: bTop[0]?.score ?? 0,
    });
  }

  // Print console output
  const SEP = "─";
  console.log("\n" + SEP.repeat(80));
  console.log("  RANKING ORDER COMPARISON");
  console.log("  " + mBranch + " vs " + bBranch);
  console.log(SEP.repeat(80) + "\n");

  const w = [38, 14];
  const top = "┌─" + w.map((x) => SEP.repeat(x)).join("─┬─") + "─┐";
  const sep = "├─" + w.map((x) => SEP.repeat(x)).join("─┼─") + "─┤";
  const bot = "└─" + w.map((x) => SEP.repeat(x)).join("─┴─") + "─┘";
  const cell = (s: string, i: number) => s.length >= w[i]! ? s.slice(0, w[i]!) : s + " ".repeat(w[i]! - s.length);

  console.log("  Overlap Summary:");
  console.log("  " + top);
  console.log("  │ " + cell("Metric", 0) + " │ " + cell("Value", 1) + " │");
  console.log("  " + sep);
  console.log("  │ " + cell("Top-1 match", 0) + " │ " + cell(totalTop1Same + "/" + maxQ, 1) + " │");
  console.log("  │ " + cell("Top-3 identical", 0) + " │ " + cell(totalTop3Same + "/" + maxQ, 1) + " │");
  console.log("  │ " + cell("Top-5 identical", 0) + " │ " + cell(totalTop5Same + "/" + maxQ, 1) + " │");
  console.log("  │ " + cell("Full top-K identical", 0) + " │ " + cell(totalFullSame + "/" + maxQ, 1) + " │");
  console.log("  │ " + cell("Avg overlap in top-5", 0) + " │ " + cell((totalOverlap5 / maxQ).toFixed(1), 1) + " │");
  console.log("  │ " + cell("Avg overlap in top-K", 0) + " │ " + cell((totalOverlap20 / maxQ).toFixed(1), 1) + " │");
  console.log("  │ " + cell("Kendall's τ (avg)", 0) + " │ " + cell(avg(kendalls).toFixed(4), 1) + " │");
  console.log("  " + bot + "\n");

  if (totalFullSame === maxQ) {
    console.log("  ▲ Ranking is IDENTICAL across all " + maxQ + " queries.");
    console.log("    RRF and linear fusion produce the same rank order\n");
  } else if (totalTop5Same === maxQ) {
    console.log("  ▲ Top-5 ranking is IDENTICAL across all queries.");
    console.log("    Minor differences exist beyond position 5.\n");
  } else {
    console.log("  ◆ Ranking order differs between branches.\n");
    console.log("  With keyword contributions active, RRF and linear fusion");
    console.log("  produce different rank orderings. RRF rewards results that");
    console.log("  rank highly in BOTH signals over results that rank well in");
    console.log("  only ONE signal.\n");
  }

  // Also show queries where keyword matched
  const queriesWithKeyword = mainData.queries.filter((q) =>
    q.topResults.some((r) => r.explanation && r.explanation.rawKeywordScore > 0),
  );
  console.log("  Queries with keyword contributions: " + queriesWithKeyword.length + "/" + maxQ);
  if (queriesWithKeyword.length === 0) {
    console.log("  (No keyword index matches found in this index)\n");
  }

  // Write markdown report
  const report: string[] = [];
  report.push("# Ranking Order Comparison");
  report.push("");
  report.push("**" + mBranch + "** vs **" + bBranch + "**");
  report.push("**Generated:** " + new Date().toISOString());
  report.push("");
  report.push("## Config");
  report.push("");
  report.push("| Setting | `" + mainData.branch + "` | `" + branchData.branch + "` |");
  report.push("|---|---|---|");
  report.push("| Embedding | " + mainData.config.embeddingModel + " | " + branchData.config.embeddingModel + " |");
  report.push("| topK | " + mainData.config.topK + " | " + branchData.config.topK + " |");
  report.push("| minScore | " + mainData.config.minScore + " | " + branchData.config.minScore + " |");
  report.push("| Hybrid | " + mainData.config.hybridEnabled + " | " + branchData.config.hybridEnabled + " |");
  report.push("| keywordWeight | " + mainData.config.keywordWeight + " | " + branchData.config.keywordWeight + " |");
  report.push("| Index chunks | " + mainData.indexChunkCount + " | " + branchData.indexChunkCount + " |");
  report.push("");

  report.push("## Ranking Agreement");
  report.push("");
  report.push("| Metric | Value |");
  report.push("|---|---|");
  report.push("| Top-1 match | " + totalTop1Same + "/" + maxQ + " |");
  report.push("| Top-3 identical | " + totalTop3Same + "/" + maxQ + " |");
  report.push("| Top-5 identical | " + totalTop5Same + "/" + maxQ + " |");
  report.push("| Full top-K identical | " + totalFullSame + "/" + maxQ + " |");
  report.push("| Avg overlap in top-5 | " + (totalOverlap5 / maxQ).toFixed(1) + " |");
  report.push("| Avg overlap in top-K | " + (totalOverlap20 / maxQ).toFixed(1) + " |");
  report.push("| Kendall's τ (avg) | " + avg(kendalls).toFixed(4) + " |");
  report.push("| Queries with keyword contribution | " + queriesWithKeyword.length + "/" + maxQ + " |");
  report.push("");

  if (totalFullSame === maxQ) {
    report.push("## Verdict");
    report.push("");
    report.push("**Ranking is 100% identical across all queries.**");
    report.push("");
    report.push("The `t1-cosine-l2` branch changes two things simultaneously:");
    report.push("- Vector scoring: L2 distance → cosine similarity");
    report.push("- Hybrid fusion: Weighted linear combination → RRF (K=60)");
    report.push("");
    report.push("However, in this benchmark, **keyword scores are zero on every query**");
    report.push("because the keyword index doesn't match any query terms. When only one signal");
    report.push("(vector similarity) contributes, both fusion methods produce the same");
    report.push("rank order. This is because both are **monotonically decreasing functions**");
    report.push("of the vector rank:");
    report.push("");
    report.push("- **Linear**: `score = (1-kw) · normVectorScore` (monotonic in vector score)");
    report.push("- **RRF**: `score = (1-kw) / (K + rank + 1)` (monotonic in vector rank)");
    report.push("");
    report.push("Since vector rank is itself monotonic with vector score, the final ordering");
    report.push("is identical regardless of which formula is used.");
    report.push("");
    report.push("### When would RRF make a difference?");
    report.push("");
    report.push("RRF excels when **both vector AND keyword signals contribute** to a query.");
    report.push("It can boost results that rank highly in both sources while demoting results");
    report.push("that only rank well in one. To see this effect:");
    report.push("- Index more files (including docs with token-rich content)");
    report.push("- Use queries with specific identifier/keyword terms that match the keyword index");
    report.push("- Increase keywordWeight to amplify keyword contributions");
    report.push("");
  }

  report.push("## Per-Query Detail");
  report.push("");
  report.push("| # | Query | Top-1 same | Top-5 same | Full same | τ | main score | branch score |");
  report.push("|---|---|:---:|:---:|:---:|:---:|:---:|:---:|");
  for (let i = 0; i < perQuery.length; i++) {
    const pq = perQuery[i]!;
    const q = pq.query.length > 48 ? pq.query.substring(0, 45) + "..." : pq.query;
    report.push(
      "| " + (i + 1) + " | " + q +
      " | " + (pq.top1Same ? "✓" : "✗") +
      " | " + (pq.top5Same ? "✓" : "✗") +
      " | " + (pq.topKFullSame ? "✓" : "✗") +
      " | " + pq.kendallTau.toFixed(3) +
      " | " + pq.mTopScore.toFixed(3) +
      " | " + pq.bTopScore.toFixed(3) +
      " |",
    );
  }
  report.push("");

  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, report.join("\n"), "utf-8");
  console.log("  Report written to: " + output + "\n");
}

main().catch((err) => { console.error("Ranking comparison failed:", err); process.exit(1); });
