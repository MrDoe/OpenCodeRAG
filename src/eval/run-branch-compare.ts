/**
 * @fileoverview Branch comparison benchmark — runs N queries against the indexed codebase
 * and outputs per-query results as JSON for later comparison.
 *
 * Usage: node --import tsx src/eval/run-branch-compare.ts --output .opencode/rag_db/eval-results/branch.json
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, DEFAULT_CONFIG } from "../core/config.js";
import { createEmbedder } from "../embedder/factory.js";
import { createVectorStore } from "../vectorstore/factory.js";
import { retrieve } from "../retriever/retriever.js";
import { KeywordIndex } from "../retriever/keyword-index.js";
import {
  loadRuntimeOverrides,
  applyRuntimeOverrides,
} from "../core/runtime-overrides.js";
import { resolveApiKey } from "../core/resolve-api-key.js";
import type { SearchResult } from "../core/interfaces.js";
import { execSync } from "node:child_process";

const WORKTREE = process.cwd();
const STORE_PATH = path.join(WORKTREE, ".opencode", "rag_db");

const QUERIES: string[] = [
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
  "How does L2 normalization affect vector search scores?",
  "What is the MetadataFilter interface used for?",
  "How does the background indexer handle file changes?",
  "Where is the config validation logic?",
  "How are PDF documents chunked and indexed?",
  "What embedding providers are supported?",
  "How does the CLI parse and dispatch commands?",
  "How does the session logger persist events?",
  "What is the manifest schema version used for?",
  "How does the OpenCode plugin register tools?",
  "Where is the globMatch function defined?",
  "How does the proxy-aware HTTP client work?",
  "What is the FETCH_OVERFETCH_FACTOR constant?",
  "How does the TUI settings menu work?",
  "How are image descriptions generated?",
  // Set B — Code-identifier queries (test hybrid search with keyword contributions)
  "retrieve function",
  "KeywordIndex class",
  "embedder factory",
  "vector store LanceDB",
  "find usages SearchResult",
  "chunkFile method",
  "embedBatch function",
  "retriever retrieve vector search",
  "session logger token",
  "config validation",
];

const THRESHOLDS = [0.85, 0.75, 0.65, 0.50, 0.35];

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

function getGitInfo(): { branch: string; commit: string } {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf-8",
    }).trim();
    const commit = execSync("git rev-parse --short HEAD", {
      encoding: "utf-8",
    }).trim();
    return { branch, commit };
  } catch {
    return { branch: "unknown", commit: "unknown" };
  }
}

function getConfig() {
  const configPath = path.join(WORKTREE, "opencode-rag.json");
  let cfg;
  try {
    cfg = loadConfig(configPath);
  } catch {
    cfg = DEFAULT_CONFIG;
  }
  const overrides = loadRuntimeOverrides(STORE_PATH);
  cfg = applyRuntimeOverrides(cfg, overrides);
  resolveApiKey(cfg, WORKTREE);
  return cfg;
}

async function probeDimension(
  embedder: import("../core/interfaces.js").EmbeddingProvider,
): Promise<number> {
  try {
    const probe = await embedder.embed(["dimension-probe"], "query");
    if (probe.length > 0 && probe[0]!.length > 0) {
      return probe[0]!.length;
    }
  } catch {
    // fall through to default
  }
  return 384;
}

function topResults(
  results: SearchResult[],
  worktree: string,
  max = 5,
): TopResultEntry[] {
  return results.slice(0, max).map((r, i) => {
    const exp = r.explanation;
    return {
      rank: i,
      score: r.score,
      filePath: path.relative(worktree, r.chunk.metadata.filePath).replace(/\\/g, "/"),
      startLine: r.chunk.metadata.startLine,
      endLine: r.chunk.metadata.endLine,
      language: r.chunk.metadata.language,
      explanation: exp
        ? {
            vectorScore: exp.scoreBreakdown.vectorScore,
            keywordScore: exp.scoreBreakdown.keywordScore,
            rawVectorScore: exp.scoreBreakdown.rawVectorScore,
            rawKeywordScore: exp.scoreBreakdown.rawKeywordScore,
            keywordWeight: exp.scoreBreakdown.keywordWeight,
            vectorRank: (exp.scoreBreakdown as Record<string, unknown>).vectorRank as number | undefined,
            keywordRank: (exp.scoreBreakdown as Record<string, unknown>).keywordRank as number | undefined,
            matchedTerms: exp.matchedTerms,
          }
        : undefined,
    };
  });
}

function thresholdAnalysis(
  results: SearchResult[],
): ThresholdResult[] {
  return THRESHOLDS.map((t) => ({
    threshold: t,
    passedCount: results.filter((r) => r.score >= t).length,
    wouldInject: results.some((r) => r.score >= t),
  }));
}

function parseArgs(): { output: string } {
  const args = process.argv.slice(2);
  let output = path.join(WORKTREE, ".opencode", "rag_db", "eval-results", "branch.json");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && args[i + 1]) {
      output = path.resolve(WORKTREE, args[i + 1]!);
      break;
    }
  }
  return { output };
}

async function main() {
  const { output } = parseArgs();
  const { branch, commit } = getGitInfo();

  console.log(`\n  OpenCodeRAG Branch Benchmark`);
  console.log(`  Branch: ${branch} @ ${commit}`);
  console.log(`  Output: ${output}\n`);

  const cfg = getConfig();
  const embedder = createEmbedder(cfg);
  const dimension = await probeDimension(embedder);
  const store = createVectorStore(cfg, STORE_PATH, dimension);

  let keywordIndex: KeywordIndex | undefined;
  try {
    keywordIndex = await KeywordIndex.load(STORE_PATH);
  } catch {
    // optional
  }

  const indexedCount = await store.count();
  console.log(`  Indexed chunks: ${indexedCount}`);
  console.log(`  Embedding: ${cfg.embedding.provider}/${cfg.embedding.model} (${dimension}d)`);
  console.log(`  Retrieval: topK=${cfg.retrieval.topK}, minScore=${cfg.retrieval.minScore}, hybrid=${cfg.retrieval.hybridSearch?.enabled}\n`);

  const queryResults: QueryResult[] = [];

  for (let i = 0; i < QUERIES.length; i++) {
    const query = QUERIES[i]!;
    process.stdout.write(`  [${i + 1}/${QUERIES.length}] ${query.substring(0, 55)}...`);

    const start = performance.now();
    const searchResults = await retrieve(query, embedder, store, {
      topK: cfg.retrieval.topK,
      minScore: 0, // no filter — we want all scores for threshold analysis
      keywordIndex,
      keywordWeight: cfg.retrieval.hybridSearch?.keywordWeight,
      hybridEnabled: cfg.retrieval.hybridSearch?.enabled,
      queryPrefix: cfg.embedding.queryPrefix,
      explain: true,
    });
    const elapsed = performance.now() - start;

    queryResults.push({
      query,
      queryIndex: i,
      resultCount: searchResults.length,
      latencyMs: Math.round(elapsed * 10) / 10,
      topResults: topResults(searchResults, WORKTREE, 5),
      thresholdAnalysis: thresholdAnalysis(searchResults),
    });

    const topScore =
      searchResults.length > 0
        ? searchResults[0]!.score.toFixed(3)
        : "N/A";
    console.log(
      ` ${searchResults.length} results, top=${topScore}, ${Math.round(elapsed)}ms`,
    );
  }

  const outputPayload: BenchmarkOutput = {
    branch,
    commit,
    timestamp: new Date().toISOString(),
    config: {
      embeddingProvider: cfg.embedding.provider,
      embeddingModel: cfg.embedding.model,
      topK: cfg.retrieval.topK,
      minScore: cfg.retrieval.minScore,
      hybridEnabled: cfg.retrieval.hybridSearch?.enabled ?? false,
      keywordWeight: cfg.retrieval.hybridSearch?.keywordWeight ?? 0.4,
    },
    indexChunkCount: indexedCount,
    queries: queryResults,
  };

  const dir = path.dirname(output);
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
  } catch {
    // dir already exists
  }

  writeFileSync(output, JSON.stringify(outputPayload, null, 2), "utf-8");
  console.log(`\n  Results written to: ${output}\n`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
