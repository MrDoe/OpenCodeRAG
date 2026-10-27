/**
 * @fileoverview Integration test that runs real RAG queries against an indexed codebase and produces a token usage report.
 */
/**
 * Integration test: Run real RAG pipeline against indexed codebase
 * and produce a token usage report.
 *
 * Usage: node --import tsx src/eval/run-token-test.ts
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, findConfigFile, DEFAULT_CONFIG } from "../core/config.js";
import { createEmbedder } from "../embedder/factory.js";
import { createVectorStore } from "../vectorstore/factory.js";
import { retrieve } from "../retriever/retriever.js";
import { KeywordIndex } from "../retriever/keyword-index.js";
import { loadRuntimeOverrides, applyRuntimeOverrides } from "../core/runtime-overrides.js";
import { resolveApiKey } from "../core/resolve-api-key.js";
import type { SearchResult } from "../core/interfaces.js";
import { countTokens, tokenizerMethod } from "./token-counter.js";

const WORKTREE = process.cwd();
const STORE_PATH = path.join(WORKTREE, ".opencode", "rag_db");
const TOKENIZER = tokenizerMethod();

const QUERIES = [
  "How does the retrieval pipeline work end-to-end?",
  "How does the plugin interact with chat messages?",
  "How does the keyword index combine with vector search?",
  "Where is the embedder factory defined?",
  "Where is the LanceDB store implementation?",
  "Find all usages of the retrieve function",
  "Find all usages of SearchResult type",
  "How does the chunker factory register new languages?",
  "What is the default minScore configuration?",
  "How does the session logger capture token usage?",
];

function getConfig() {
  const configPath = findConfigFile(WORKTREE) ?? path.join(WORKTREE, "opencode-rag.json");
  let cfg;
  try { cfg = loadConfig(configPath); } catch { cfg = DEFAULT_CONFIG; }
  const overrides = loadRuntimeOverrides(STORE_PATH);
  cfg = applyRuntimeOverrides(cfg, overrides);
  resolveApiKey(cfg, WORKTREE);
  return cfg;
}

function formatFileList(results: SearchResult[], worktree: string, maxFiles = 10): string {
  const fileMap = new Map<string, { lines: number[]; scores: number[] }>();
  for (const r of results) {
    const m = r.chunk.metadata;
    const existing = fileMap.get(m.filePath);
    if (existing) { existing.lines.push(m.startLine, m.endLine); existing.scores.push(r.score); }
    else { fileMap.set(m.filePath, { lines: [m.startLine, m.endLine], scores: [r.score] }); }
  }
  const sorted = [...fileMap.entries()].sort((a, b) => Math.max(...b[1].scores) - Math.max(...a[1].scores)).slice(0, maxFiles);
  if (sorted.length === 0) return "";
  const lines = ["Relevant files:"];
  for (const [fp, info] of sorted) {
    const relPath = path.relative(worktree, fp).replace(/\\/g, "/");
    const lang = results.find((r) => r.chunk.metadata.filePath === fp)?.chunk.metadata.language ?? "";
    lines.push(`${relPath} (${lang}, lines ${Math.min(...info.lines)}-${Math.max(...info.lines)}, relevance ${Math.max(...info.scores).toFixed(2)})`);
  }
  return lines.join("\n");
}

async function main() {
  console.log("\n  OpenCodeRAG Token Usage Integration Test\n");
  console.log("  ─────────────────────────────────────────\n");

  const cfg = getConfig();
  const embedder = createEmbedder(cfg);
  const store = createVectorStore(cfg, STORE_PATH, 384);

  let keywordIndex: KeywordIndex | undefined;
  try { keywordIndex = await KeywordIndex.load(STORE_PATH); } catch { /* optional */ }

  const indexedCount = await store.count();
  console.log(`  Indexed chunks: ${indexedCount}`);
  console.log(`  Embedding model: ${cfg.embedding.provider}/${cfg.embedding.model}`);
  console.log(`  Retrieval: topK=${cfg.retrieval.topK}, minScore=${cfg.retrieval.minScore}, hybrid=${cfg.retrieval.hybridSearch?.enabled}`);
  console.log(`\n`);

  const results: {
    query: string;
    ragOn: { inputTokens: number; contextTokens: number; topScore: number; resultCount: number; contentType: string };
    ragOff: { inputTokens: number };
    savedReads: number;
  }[] = [];

  for (let i = 0; i < QUERIES.length; i++) {
    const query = QUERIES[i]!;
    process.stdout.write(`  [${i + 1}/${QUERIES.length}] ${query.substring(0, 50)}...`);

    const searchResults = await retrieve(query, embedder, store, {
      topK: cfg.retrieval.topK,
      minScore: cfg.retrieval.minScore,
      keywordIndex,
      keywordWeight: cfg.retrieval.hybridSearch?.keywordWeight,
      hybridEnabled: cfg.retrieval.hybridSearch?.enabled,
      queryPrefix: cfg.embedding.queryPrefix,
    });

    const inputTokens = countTokens(query);
    const minScore = 0.85;
    const highConfidence = searchResults.filter((r) => r.score >= minScore);

    let ragOnText = "";
    let contentType = "none";
    if (highConfidence.length > 0) {
      ragOnText = formatFileList(highConfidence, WORKTREE, cfg.retrieval.topK);
      contentType = "file_paths";
    }

    const contextTokens = countTokens(ragOnText);
    const topScore = searchResults.length > 0 ? searchResults[0]!.score : 0;
    const savedReads = highConfidence.length > 0 ? Math.min(3, highConfidence.length) : 0;

    results.push({
      query,
      ragOn: { inputTokens, contextTokens, topScore, resultCount: searchResults.length, contentType },
      ragOff: { inputTokens },
      savedReads,
    });

    console.log(` ✓ ${searchResults.length} results, top=${topScore.toFixed(2)}, inject=${contextTokens} tok`);
  }

  // Test with multiple thresholds to find the effective range
  const thresholds = [0.85, 0.75, 0.65, 0.50];
  const thresholdResults: { threshold: number; injected: number; avgContext: number; totalContext: number }[] = [];

  for (const threshold of thresholds) {
    for (const _r of results) {
      // Re-run filtering with this threshold
      // We stored the original search results — re-filter
    }
    // Re-retrieve for each threshold (cached by embedder)
    let tTotalCtx = 0;
    let tInjected = 0;
    for (let i = 0; i < QUERIES.length; i++) {
      const query = QUERIES[i]!;
      const searchResults = await retrieve(query, embedder, store, {
        topK: cfg.retrieval.topK,
        minScore: cfg.retrieval.minScore,
        keywordIndex,
        keywordWeight: cfg.retrieval.hybridSearch?.keywordWeight,
        queryPrefix: cfg.embedding.queryPrefix,
      });
      const highConf = searchResults.filter((r) => r.score >= threshold);
      if (highConf.length > 0) {
        const text = formatFileList(highConf, WORKTREE, cfg.retrieval.topK);
        const tokens = countTokens(text);
        tTotalCtx += tokens;
        tInjected++;
      }
    }
    thresholdResults.push({
      threshold,
      injected: tInjected,
      avgContext: tInjected > 0 ? Math.round(tTotalCtx / tInjected) : 0,
      totalContext: tTotalCtx,
    });
  }

  console.log("\n  Threshold analysis:");
  for (const t of thresholdResults) {
    console.log(`    minScore=${t.threshold}: ${t.injected}/${QUERIES.length} queries injected, avg ${t.avgContext} tok, total ${t.totalContext} tok`);
  }

  // Use the 0.75 threshold results for the report (most realistic)
  const effectiveThreshold = thresholdResults.find((t) => t.threshold === 0.75) ?? thresholdResults[0]!;

  const totalContextTokens = effectiveThreshold.totalContext;
  const avgContextTokens = effectiveThreshold.avgContext;
  const totalInputTokens = results.reduce((s, r) => s + r.ragOff.inputTokens, 0);
  const totalSavedReads = results.reduce((s, r) => s + r.savedReads, 0);
  const savedReadTokens = totalSavedReads * 1200;
  const netSavings = savedReadTokens - totalContextTokens;
  const avgTopScore = results.reduce((s, r) => s + r.ragOn.topScore, 0) / results.length;
  const queriesWithInjection = results.filter((r) => r.ragOn.contextTokens > 0).length;
  const systemGuidanceTokens = indexedCount > 0 ? 150 * results.length : 0;
  const netSavingsWithGuidance = netSavings - systemGuidanceTokens;

  const report: string[] = [];
  report.push("# OpenCodeRAG Token Usage Report\n");
  report.push(`**Date:** ${new Date().toISOString().split("T")[0]}`);
  report.push(`**Codebase:** ${WORKTREE}`);
  report.push(`**Indexed chunks:** ${indexedCount}`);
  report.push(`**Embedding model:** ${cfg.embedding.provider}/${cfg.embedding.model}`);
  report.push(`**Tokenizer:** ${TOKENIZER === "tiktoken" ? "tiktoken cl100k_base (BPE)" : "heuristic (characters / 4)"}`);
  report.push(`**Retrieval:** topK=${cfg.retrieval.topK}, minScore=${cfg.retrieval.minScore}, hybrid=${cfg.retrieval.hybridSearch?.enabled ?? false}`);
  report.push("");

  report.push("## Summary\n");
  report.push("| Metric | Value |");
  report.push("|--------|-------|");
  report.push(`| Queries tested | ${results.length} |`);
  report.push(`| Queries with injection | ${queriesWithInjection} / ${results.length} |`);
  report.push(`| Avg top relevance score | ${avgTopScore.toFixed(3)} |`);
  report.push(`| Total RAG context injected | ${totalContextTokens.toLocaleString()} tokens |`);
  report.push(`| Avg context per query | ${avgContextTokens.toLocaleString()} tokens |`);
  report.push(`| System guidance overhead | ${systemGuidanceTokens.toLocaleString()} tokens |`);
  report.push(`| Estimated reads saved | ${totalSavedReads} calls |`);
  report.push(`| Estimated read tokens saved | ${savedReadTokens.toLocaleString()} tokens |`);
  report.push(`| **Net token savings** | **${netSavings > 0 ? "+" : ""}${netSavings.toLocaleString()} tokens** |`);
  report.push(`| **Net savings (with guidance)** | **${netSavingsWithGuidance > 0 ? "+" : ""}${netSavingsWithGuidance.toLocaleString()} tokens** |`);
  report.push("");

  report.push("## Verdict\n");
  if (netSavings > 0) {
    report.push(`**RAG SAVES tokens overall.** The ${totalContextTokens.toLocaleString()} tokens of injected context are offset by an estimated ${savedReadTokens.toLocaleString()} tokens saved from ${totalSavedReads} fewer file reads. Net savings: **+${netSavings.toLocaleString()} tokens** (${((netSavings / (totalInputTokens + totalContextTokens)) * 100).toFixed(1)}%).`);
  } else {
    report.push(`**RAG COSTS tokens overall.** The ${totalContextTokens.toLocaleString()} tokens of injected context exceed the estimated ${savedReadTokens.toLocaleString()} tokens saved from fewer file reads. Net overhead: **${netSavings.toLocaleString()} tokens** (${((Math.abs(netSavings) / (totalInputTokens + totalContextTokens)) * 100).toFixed(1)}%).`);
  }
  report.push("");

  report.push("## Per-Query Results\n");
  report.push("| # | Query | Results | Top Score | Injected | Content Type |");
  report.push("|---|-------|---------|-----------|----------|--------------|");
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const q = r.query.length > 45 ? r.query.substring(0, 42) + "..." : r.query;
    report.push(`| ${i + 1} | ${q} | ${r.ragOn.resultCount} | ${r.ragOn.topScore.toFixed(3)} | ${r.ragOn.contextTokens} tok | ${r.ragOn.contentType} |`);
  }
  report.push("");

  report.push("## Token Breakdown\n");
  report.push("### Without RAG (estimated)\n");
  report.push("- Agent must read files to find relevant code: ~2-3 reads × ~1200 tokens = **~2400-3600 tokens per query**");
  report.push("- No injected context overhead");
  report.push("- No system guidance overhead");
  report.push("");
  report.push("### With RAG\n");
  report.push(`- Injected context: **${avgContextTokens} tokens per query** (avg)`);
  report.push(`- System guidance: **~150 tokens per query**`);
  report.push("- Agent reads fewer files: **~0-1 reads per query**");
  report.push("");

  report.push("## Notes\n");
  report.push("- Read token savings are **estimated** based on typical agent behavior (2-3 extra reads per query without RAG)");
  report.push("- Actual savings depend on query complexity, codebase size, and agent model");
  report.push("- RAG provides **qualitative benefits** beyond token savings: more targeted code context, fewer hallucinations, better grounding");
  report.push("- The `minScore` threshold (0.85) is conservative — lowering it injects more context but catches more relevant code");
  report.push("");

  const reportPath = path.join(WORKTREE, "doc", "eval-token-report.md");
  writeFileSync(reportPath, report.join("\n"), "utf-8");
  console.log(`\n  Report written to: ${reportPath}\n`);

  const sep = "─".repeat(70);
  console.log(sep);
  console.log("  SUMMARY");
  console.log(sep);
  console.log(`  Queries:              ${results.length}`);
  console.log(`  With injection:       ${queriesWithInjection}/${results.length}`);
  console.log(`  Avg context/query:    ${avgContextTokens} tokens`);
  console.log(`  Total context:        ${totalContextTokens} tokens`);
  console.log(`  System guidance:      ${systemGuidanceTokens} tokens`);
  console.log(`  Reads saved:          ${totalSavedReads} calls (~${savedReadTokens} tokens)`);
  const color = netSavings > 0 ? "\x1b[32m" : "\x1b[33m";
  const reset = "\x1b[0m";
  console.log(`  Net savings:          ${color}${netSavings > 0 ? "+" : ""}${netSavings} tokens${reset}`);
  console.log(sep);
  console.log();
}

main().catch((err) => { console.error("Test failed:", err); process.exit(1); });
