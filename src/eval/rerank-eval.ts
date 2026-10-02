/**
 * @fileoverview Rerank A/B evaluation harness: runs labeled ground-truth queries through
 * the real retrieval pipeline (baseline vs. opt-in rerank stage) and reports
 * Hit@k, Precision@5, Recall@k, MRR, nDCG@10, and warm latency (p50/p95).
 *
 * Usage: node --import tsx src/eval/rerank-eval.ts [options]
 *
 * Options:
 *   --arms=baseline,rerank20,rerank30,rerank-desc  Arms to run (default: baseline,rerank20,rerank30)
 *   --topk=20              Override retrieval topK (default: config)
 *   --minScore=0.35        Override retrieval minScore (default: config)
 *   --category=nl          Only run labels of one category (nl|gotcha|symbol|de)
 *   --limit=10             Only run the first N labels (after filtering)
 *   --warmup=2             Discarded warmup queries per arm before measuring (default 2;
 *                          llama-swap cold starts measure 15-25s and would pollute p50/p95)
 *   --labels=path          Label file (default: src/eval/rerank-labels.json)
 *   --report=path          Report file (default: doc/rerank-eval-report.md)
 *   --rerank-base-url=URL  Rerank endpoint (e.g. http://127.0.0.1:11437/v1). Passing any
 *                          --rerank-* flag enables the rerank arms without touching the
 *                          user's opencode-rag.json (synthesized enabled section).
 *   --rerank-model=NAME    Reranker model name (e.g. Qwen3-Reranker-0.6B)
 *   --rerank-api-key=KEY   Optional bearer token for the rerank endpoint
 *   --rerank-provider=ID   Provider id (default: llama-server)
 *   --rerank-timeout=MS    Override the rerank stage timeout for this run (default: provider
 *                          config, 1500). Raise it when the server needs >1.5 s for large
 *                          candidate pools — otherwise most queries degrade to fusion order.
 *   --embedding-model=ID   Override embedding.model for this run (e.g. Qwen3-Embedding:8B).
 *                          Useful when the shared config is broken or leased by another session.
 *   --embedding-base-url=… Override embedding.baseUrl for this run.
 *
 * Design notes:
 * - Ground truth lives in `rerank-labels.json` as query -> file paths (+ optional
 *   symbol). Chunk IDs are deliberately NOT used: they do not survive re-indexing.
 * - The reranker module is imported dynamically so this harness type-checks and runs
 *   while `src/reranker/**` is still under construction. Rerank arms are skipped with
 *   a diagnostic when the config has no enabled `reranking.*` section, the module is
 *   missing, or the provider cannot be created (e.g. llama-server without --reranking).
 * - Latency is measured warm: each arm issues one discarded warmup query first, so
 *   embedding/rerank connection setup does not pollute p50/p95. Cold start is a
 *   separate, documented number — not part of this measurement.
 * - `retrieve()` is called through a loose local signature on purpose: the rerank
 *   stage is being developed in parallel, and this harness must not depend on its
 *   exact RetrieveOptions type.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "../core/config.js";
import type { RagConfig } from "../core/config.js";
import { createEmbedder } from "../embedder/factory.js";
import { createVectorStore } from "../vectorstore/factory.js";
import { readStoreDimension } from "../vectorstore/lancedb.js";
import { retrieve } from "../retriever/retriever.js";
import { KeywordIndex } from "../retriever/keyword-index.js";
import { applyRuntimeOverrides, loadRuntimeOverrides } from "../core/runtime-overrides.js";
import { resolveApiKey } from "../core/resolve-api-key.js";
import type { EmbeddingProvider, SearchResult, VectorStore } from "../core/interfaces.js";

const WORKTREE = process.cwd();
const CONFIG_PATH = path.join(WORKTREE, "opencode-rag.json");
const STORE_PATH = path.join(WORKTREE, ".opencode", "rag_db");
const DEFAULT_LABELS_PATH = path.join(WORKTREE, "src", "eval", "rerank-labels.json");
const DEFAULT_REPORT_PATH = path.join(WORKTREE, "doc", "rerank-eval-report.md");
const RERANK_FACTORY_SPECIFIER = "../reranker/factory.js";

/** Loose local type: shields this harness from in-flight changes to RetrieveOptions. */
type RetrieveFn = (
  query: string,
  embedder: EmbeddingProvider,
  store: VectorStore,
  options: Record<string, unknown>,
) => Promise<SearchResult[]>;
const retrieveFn = retrieve as unknown as RetrieveFn;

// ────────────────────────────────────────────────────────────────────────────
// Labels
// ────────────────────────────────────────────────────────────────────────────

interface Label {
  id: string;
  category: string;
  query: string;
  files: string[];
  symbol?: string;
  note?: string;
}

interface LabelFile {
  version: number;
  labels: Label[];
}

// ────────────────────────────────────────────────────────────────────────────
// Arms
// ────────────────────────────────────────────────────────────────────────────

interface ArmSpec {
  name: string;
  description: string;
  reranked: boolean;
  overrides?: Record<string, unknown>;
}

const ARM_SPECS: ArmSpec[] = [
  { name: "baseline", description: "current pipeline (reranking disabled)", reranked: false },
  { name: "rerank20", description: "rerank stage, candidates=20", reranked: true, overrides: { candidates: 20 } },
  { name: "rerank30", description: "rerank stage, candidates=30", reranked: true, overrides: { candidates: 30 } },
  { name: "rerank-desc", description: "rerank stage, docField=content+description", reranked: true, overrides: { candidates: 20, docField: "content+description" } },
];

interface Options {
  arms: string[];
  topK?: number;
  minScore?: number;
  category?: string;
  limit?: number;
  warmup?: number;
  labelsPath: string;
  reportPath: string;
  rerankBaseUrl?: string;
  rerankModel?: string;
  rerankApiKey?: string;
  rerankProvider?: string;
  rerankTimeoutMs?: number;
  embeddingModel?: string;
  embeddingBaseUrl?: string;
}

function parseOptions(argv: string[]): Options {
  const kv = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) kv.set(arg.slice(2), "true");
    else kv.set(arg.slice(2, eq), arg.slice(eq + 1));
  }
  const num = (key: string): number | undefined => {
    const raw = kv.get(key);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const armsRaw = kv.get("arms");
  return {
    arms: armsRaw ? armsRaw.split(",").map((a) => a.trim()).filter(Boolean) : ["baseline", "rerank20", "rerank30"],
    topK: num("topk"),
    minScore: num("minScore"),
    category: kv.get("category"),
    limit: num("limit"),
    warmup: num("warmup"),
    labelsPath: kv.get("labels") ? path.resolve(WORKTREE, kv.get("labels")!) : DEFAULT_LABELS_PATH,
    reportPath: kv.get("report") ? path.resolve(WORKTREE, kv.get("report")!) : DEFAULT_REPORT_PATH,
    rerankBaseUrl: kv.get("rerank-base-url"),
    rerankModel: kv.get("rerank-model"),
    rerankApiKey: kv.get("rerank-api-key"),
    rerankProvider: kv.get("rerank-provider"),
    rerankTimeoutMs: num("rerank-timeout"),
    embeddingModel: kv.get("embedding-model"),
    embeddingBaseUrl: kv.get("embedding-base-url"),
  };
}

function loadLabels(labelsPath: string): Label[] {
  if (!existsSync(labelsPath)) {
    throw new Error(`Label file not found: ${labelsPath}`);
  }
  const parsed = JSON.parse(readFileSync(labelsPath, "utf-8")) as LabelFile;
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

// ────────────────────────────────────────────────────────────────────────────
// Bootstrapping
// ────────────────────────────────────────────────────────────────────────────

interface Runtime {
  cfg: RagConfig;
  embedder: EmbeddingProvider;
  store: VectorStore;
  keywordIndex?: KeywordIndex;
  storePath: string;
  dimension: number;
  indexedCount: number;
}

async function bootstrap(opts: Options): Promise<Runtime> {
  let cfg: RagConfig;
  if (existsSync(CONFIG_PATH)) {
    cfg = loadConfig(CONFIG_PATH);
  } else {
    cfg = structuredClone(DEFAULT_CONFIG);
  }
  const overrides = loadRuntimeOverrides(STORE_PATH);
  cfg = applyRuntimeOverrides(cfg, overrides);
  resolveApiKey(cfg, WORKTREE);

  // CLI overrides for the embedding endpoint — never touch the shared config file
  // (it may be leased/broken by another session).
  if (opts.embeddingModel) cfg.embedding.model = opts.embeddingModel;
  if (opts.embeddingBaseUrl) cfg.embedding.baseUrl = opts.embeddingBaseUrl;

  const storePath = path.resolve(WORKTREE, cfg.vectorStore.path);
  const dimension =
    (await readStoreDimension(storePath)) ??
    (cfg.embedding as unknown as { vectorDimension?: number }).vectorDimension ??
    384;

  const embedder = createEmbedder(cfg);
  const store = createVectorStore(cfg, storePath, dimension);

  let keywordIndex: KeywordIndex | undefined;
  try {
    keywordIndex = await KeywordIndex.load(storePath);
  } catch {
    // optional — hybrid search degrades to vector-only, same as the plugin
  }

  const indexedCount = await store.count();
  return { cfg, embedder, store, keywordIndex, storePath, dimension, indexedCount };
}

/**
 * Resolve a rerank provider from the parallel rerank implementation without a static
 * import (the module may not exist yet). Returns a diagnostic instead of throwing.
 */
async function resolveRerankProvider(section?: Record<string, unknown>): Promise<{ provider?: unknown; error?: string }> {
  if (!section || section.enabled !== true) {
    return { error: "no enabled reranking config — pass --rerank-base-url=… --rerank-model=… or set reranking.enabled=true" };
  }
  try {
    const mod = (await import(RERANK_FACTORY_SPECIFIER)) as { getRerankerFor?: (cfg: unknown) => unknown };
    if (typeof mod.getRerankerFor !== "function") {
      return { error: "src/reranker/factory.ts exists but has no getRerankerFor export yet" };
    }
    const provider = await mod.getRerankerFor(section);
    if (!provider) {
      return { error: "getRerankerFor returned undefined (provider disabled/unavailable)" };
    }
    return { provider };
  } catch (err) {
    return { error: `reranker module unavailable: ${(err as Error).message}` };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Metrics
// ────────────────────────────────────────────────────────────────────────────

interface Outcome {
  label: Label;
  latencyMs: number;
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
  /** True when the rerank stage actually reordered (explanation.scoreBreakdown.rerankScore present). */
  rerankRan: boolean;
}

function toRepoRelative(filePath: string): string {
  let p = filePath.replace(/\\/g, "/");
  const root = WORKTREE.replace(/\\/g, "/").toLowerCase();
  const idx = p.toLowerCase().indexOf(root);
  if (idx >= 0) p = p.slice(idx + root.length);
  return p.replace(/^\/+/, "").toLowerCase();
}

function evaluateResults(label: Label, results: SearchResult[]): Omit<Outcome, "label" | "latencyMs"> {
  const expected = new Set(label.files.map((f) => f.toLowerCase()));
  const fileRank = new Map<string, number>();
  for (const [i, r] of results.entries()) {
    const file = toRepoRelative(r.chunk.metadata.filePath);
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
    const file = toRepoRelative(r.chunk.metadata.filePath);
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
      const file = toRepoRelative(r.chunk.metadata.filePath);
      if (expected.has(file) && r.chunk.content.includes(label.symbol)) {
        symbolHitRank = i + 1;
        break;
      }
    }
  }

  // Did the rerank stage actually reorder this query? The stage sets
  // explanation.scoreBreakdown.rerankScore only on a successful rerank; when it
  // degrades (timeout/error/cooldown) the fusion order is kept and the field is absent.
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
    topFiles: results.slice(0, 5).map((r) => toRepoRelative(r.chunk.metadata.filePath)),
    rerankRan,
  };
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[idx] ?? 0;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

interface ArmResult {
  spec: ArmSpec;
  status: "ok" | "skipped";
  skipReason?: string;
  outcomes: Outcome[];
  /** Queries where the rerank stage actually reordered (0 for baseline). */
  rerankRanCount: number;
}

interface ArmSummary {
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

function summarize(outcomes: Outcome[]): ArmSummary {
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

// ────────────────────────────────────────────────────────────────────────────
// Run
// ────────────────────────────────────────────────────────────────────────────

async function runArm(
  spec: ArmSpec,
  labels: Label[],
  runtime: Runtime,
  baseOptions: Record<string, unknown>,
  reranker: unknown | undefined,
  rerankerError: string | undefined,
  warmupCount: number,
  rerankTimeoutMs: number | undefined,
): Promise<ArmResult> {
  if (spec.reranked && reranker === undefined) {
    return { spec, status: "skipped", skipReason: rerankerError ?? "no rerank provider", outcomes: [], rerankRanCount: 0 };
  }

  const options: Record<string, unknown> = { ...baseOptions };
  if (spec.reranked) {
    options.reranker = reranker;
    options.reranking = {
      ...spec.overrides,
      ...(rerankTimeoutMs !== undefined ? { timeoutMs: rerankTimeoutMs } : {}),
    };
  }

  // Discarded warmup queries so model loading/connection setup does not pollute
  // p50/p95 — llama-swap cold starts measure 15-25s per model swap.
  const warmupLabels = labels.slice(0, Math.max(0, Math.min(warmupCount, labels.length)));
  for (const warmup of warmupLabels) {
    await retrieveFn(warmup.query, runtime.embedder, runtime.store, options);
  }

  const outcomes: Outcome[] = [];
  for (const label of labels) {
    const t0 = performance.now();
    let results: SearchResult[] = [];
    let failure: string | undefined;
    try {
      results = await retrieveFn(label.query, runtime.embedder, runtime.store, options);
    } catch (err) {
      failure = (err as Error).message;
    }
    const latencyMs = performance.now() - t0;
    const metrics = evaluateResults(label, results);
    outcomes.push({ label, latencyMs, ...metrics });
    const rankText = metrics.firstHitRank !== null ? `rank ${metrics.firstHitRank}` : "miss";
    console.log(
      `    ${armLabelPad(spec.name)} ${label.id.padEnd(10)} ${rankText.padEnd(8)} ${latencyMs.toFixed(0)}ms` +
        (failure ? `  ERROR: ${failure}` : ""),
    );
  }
  const rerankRanCount = outcomes.filter((o) => o.rerankRan).length;
  return { spec, status: "ok", outcomes, rerankRanCount };
}

function armLabelPad(name: string): string {
  return name.padEnd(12);
}

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Top-5 file overlap between two arms (Jaccard-ish: share of baseline files still present). */
function top5Overlap(baseline: Outcome, other: Outcome): number {
  if (baseline.topFiles.length === 0) return 1;
  const otherSet = new Set(other.topFiles);
  let shared = 0;
  for (const f of baseline.topFiles) if (otherSet.has(f)) shared += 1;
  return shared / baseline.topFiles.length;
}

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));
  const labels = loadLabels(opts.labelsPath)
    .filter((l) => (opts.category ? l.category === opts.category : true))
    .slice(0, opts.limit ?? Number.MAX_SAFE_INTEGER);
  if (labels.length === 0) {
    throw new Error("No labels selected (check --category/--limit).");
  }

  const runtime = await bootstrap(opts);
  const { cfg } = runtime;
  const topK = opts.topK ?? cfg.retrieval.topK ?? 10;
  const minScore = opts.minScore ?? cfg.retrieval.minScore ?? 0;
  const hybrid = (cfg.retrieval as unknown as {
    hybridSearch?: {
      enabled?: boolean;
      keywordWeight?: number;
      symbolKeywordWeight?: number;
      docKeywordDemotion?: number;
      testKeywordDemotion?: number;
    };
  }).hybridSearch;

  const baseOptions: Record<string, unknown> = {
    topK,
    minScore,
    keywordIndex: runtime.keywordIndex,
    keywordWeight: hybrid?.keywordWeight,
    symbolKeywordWeight: hybrid?.symbolKeywordWeight,
    docKeywordDemotion: hybrid?.docKeywordDemotion,
    testKeywordDemotion: hybrid?.testKeywordDemotion,
    hybridEnabled: hybrid?.enabled,
    queryPrefix: cfg.embedding.queryPrefix,
    explain: true,
  };

  const requested = ARM_SPECS.filter((a) => opts.arms.includes(a.name));
  const unknownArms = opts.arms.filter((a) => !ARM_SPECS.some((s) => s.name === a));
  for (const u of unknownArms) console.warn(`  ! Unknown arm ignored: ${u}`);

  const needsReranker = requested.some((a) => a.reranked);
  // CLI --rerank-* flags synthesize an enabled section so the A/B runs without
  // touching the user's opencode-rag.json (which stays reranking.enabled=false).
  const cliRerankOverrides: Record<string, unknown> = {};
  if (opts.rerankBaseUrl) cliRerankOverrides.baseUrl = opts.rerankBaseUrl;
  if (opts.rerankModel) cliRerankOverrides.model = opts.rerankModel;
  if (opts.rerankApiKey) cliRerankOverrides.apiKey = opts.rerankApiKey;
  if (opts.rerankProvider) cliRerankOverrides.provider = opts.rerankProvider;
  const cfgReranking = (cfg as unknown as { reranking?: Record<string, unknown> }).reranking;
  const rerankSection = Object.keys(cliRerankOverrides).length > 0
    ? { ...(cfgReranking ?? {}), ...cliRerankOverrides, enabled: true }
    : cfgReranking;
  const resolved = needsReranker
    ? await resolveRerankProvider(rerankSection)
    : { provider: undefined as unknown, error: undefined as string | undefined };

  console.log(`\n  OpenCodeRAG Rerank Evaluation`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  Indexed chunks:  ${runtime.indexedCount}`);
  console.log(`  Embedder:        ${cfg.embedding.provider}/${cfg.embedding.model} (dim ${runtime.dimension})`);
  console.log(`  Retrieval:       topK=${topK}, minScore=${minScore}, hybrid=${hybrid?.enabled ?? false}`);
  console.log(`  Labels:          ${labels.length} (${opts.labelsPath})`);
  console.log(`  Arms:            ${requested.map((a) => a.name).join(", ")}`);
  if (needsReranker && resolved.error) {
    console.log(`  Reranker:        UNAVAILABLE — ${resolved.error}`);
  }
  console.log();

  const armResults: ArmResult[] = [];
  const warmupCount = opts.warmup ?? 2;
  for (const spec of requested) {
    console.log(`  Arm "${spec.name}" — ${spec.description}`);
    // eslint-disable-next-line no-await-in-loop
    const result = await runArm(spec, labels, runtime, baseOptions, resolved.provider, resolved.error, warmupCount, opts.rerankTimeoutMs);
    if (result.status === "skipped") {
      console.log(`    SKIPPED: ${result.skipReason}\n`);
    } else {
      console.log();
    }
    armResults.push(result);
  }

  const okResults = armResults.filter((r) => r.status === "ok");
  const baselineResult = okResults.find((r) => r.spec.name === "baseline");
  const summaries = new Map<string, ArmSummary>();
  for (const result of okResults) summaries.set(result.spec.name, summarize(result.outcomes));

  // ── Report ──────────────────────────────────────────────────────────────
  const report: string[] = [];
  report.push("# Rerank A/B Evaluation");
  report.push("");
  report.push(`**Date:** ${new Date().toISOString()}`);
  report.push(`**Worktree:** ${WORKTREE}`);
  report.push(`**Indexed chunks:** ${runtime.indexedCount}`);
  report.push(`**Embedder:** ${cfg.embedding.provider}/${cfg.embedding.model} (dimension ${runtime.dimension})`);
  report.push(`**Retrieval:** topK=${topK}, minScore=${minScore}, hybrid=${hybrid?.enabled ?? false}, keywordWeight=${hybrid?.keywordWeight ?? "-"}`);
  report.push(`**Labels:** ${labels.length} from \`${path.relative(WORKTREE, opts.labelsPath).replace(/\\/g, "/")}\``);
  const byCategory = new Map<string, number>();
  for (const l of labels) byCategory.set(l.category, (byCategory.get(l.category) ?? 0) + 1);
  report.push(`**Categories:** ${[...byCategory.entries()].map(([c, n]) => `${c}=${n}`).join(", ")}`);
  report.push(`**Warmup:** ${warmupCount} discarded queries per arm (p50/p95 are warm measurements)`);
  report.push("");

  report.push("## Arm status");
  report.push("");
  report.push("| Arm | Status | Note |");
  report.push("|-----|--------|------|");
  for (const result of armResults) {
    const note = result.status === "ok" ? result.spec.description : (result.skipReason ?? "");
    report.push(`| \`${result.spec.name}\` | ${result.status === "ok" ? "ok" : "SKIPPED"} | ${note} |`);
  }
  if (needsReranker && resolved.error) {
    report.push("");
    report.push(`> Rerank provider unavailable: ${resolved.error}`);
    report.push(">");
    report.push("> To enable the rerank arms: set `reranking.enabled=true` in the config and start a llama-server");
    report.push("> with `--reranking --pooling rank` serving a verified Qwen3-Reranker GGUF (see AGENTS.md quirk notes).");
  }
  report.push("");

  if (okResults.length > 0) {
    report.push("## Aggregate metrics (warm)");
    report.push("");
    report.push("| Metric | " + okResults.map((r) => `\`${r.spec.name}\``).join(" | ") + " |");
    report.push("|--------|" + okResults.map(() => "---").join("|") + "|");
    const metricRows: Array<[string, (s: ArmSummary) => string]> = [
      ["Hit@1", (s) => fmtPct(s.hit1)],
      ["Hit@3", (s) => fmtPct(s.hit3)],
      ["Hit@5", (s) => fmtPct(s.hit5)],
      ["Hit@10", (s) => fmtPct(s.hit10)],
      ["Precision@5", (s) => s.precision5.toFixed(3)],
      ["Recall@10", (s) => fmtPct(s.recall10)],
      ["MRR", (s) => s.mrr.toFixed(3)],
      ["nDCG@10", (s) => s.ndcg10.toFixed(3)],
      ["Symbol hit rate", (s) => (s.symbolRate > 0 ? fmtPct(s.symbolRate) : "-")],
      ["Latency avg", (s) => `${s.latencyAvg.toFixed(0)} ms`],
      ["Latency p50", (s) => `${s.latencyP50.toFixed(0)} ms`],
      ["Latency p95", (s) => `${s.latencyP95.toFixed(0)} ms`],
    ];
    for (const [name, fn] of metricRows) {
      report.push(`| ${name} | ${okResults.map((r) => fn(summaries.get(r.spec.name)!)).join(" | ")} |`);
    }
    report.push(`| Reranked queries | ${okResults.map((r) => `${r.rerankRanCount}/${r.outcomes.length}`).join(" | ")} |`);
    report.push("");

    if (baselineResult) {
      const others = okResults.filter((r) => r !== baselineResult);
      if (others.length > 0) {
        const baselineSummary = summaries.get("baseline")!;
        report.push("## Effect vs. baseline");
        report.push("");
        report.push("| Arm | Δ nDCG@10 | Δ MRR | Δ Hit@5 | Δ p50 latency | Top-5 overlap | Changed top-1 |");
        report.push("|-----|-----------|-------|---------|---------------|---------------|---------------|");
        for (const other of others) {
          const s = summaries.get(other.spec.name)!;
          let changedTop1 = 0;
          let overlapSum = 0;
          const baselineByLabel = new Map(baselineResult.outcomes.map((o) => [o.label.id, o]));
          for (const o of other.outcomes) {
            const b = baselineByLabel.get(o.label.id);
            if (!b) continue;
            if (b.topFiles[0] !== o.topFiles[0]) changedTop1 += 1;
            overlapSum += top5Overlap(b, o);
          }
          const overlap = other.outcomes.length > 0 ? overlapSum / other.outcomes.length : 0;
          report.push(
            `| \`${other.spec.name}\` | ${(s.ndcg10 - baselineSummary.ndcg10 >= 0 ? "+" : "") + (s.ndcg10 - baselineSummary.ndcg10).toFixed(3)} | ` +
              `${(s.mrr - baselineSummary.mrr >= 0 ? "+" : "") + (s.mrr - baselineSummary.mrr).toFixed(3)} | ` +
              `${(s.hit5 - baselineSummary.hit5 >= 0 ? "+" : "") + (s.hit5 - baselineSummary.hit5).toFixed(3)} | ` +
              `${(s.latencyP50 - baselineSummary.latencyP50 >= 0 ? "+" : "") + (s.latencyP50 - baselineSummary.latencyP50).toFixed(0)} ms | ` +
              `${fmtPct(overlap)} | ${changedTop1}/${other.outcomes.length} |`,
          );
        }
        report.push("");
      }
    }

    report.push("## Metrics by category");
    report.push("");
    const categories = [...new Set(labels.map((l) => l.category))];
    report.push("| Arm | Category | Hit@1 | Hit@5 | MRR | nDCG@10 |");
    report.push("|-----|----------|-------|-------|-----|---------|");
    for (const result of okResults) {
      for (const category of categories) {
        const catOutcomes = result.outcomes.filter((o) => o.label.category === category);
        if (catOutcomes.length === 0) continue;
        const s = summarize(catOutcomes);
        report.push(`| \`${result.spec.name}\` | ${category} | ${fmtPct(s.hit1)} | ${fmtPct(s.hit5)} | ${s.mrr.toFixed(3)} | ${s.ndcg10.toFixed(3)} |`);
      }
    }
    report.push("");

    report.push("## Per-query results");
    report.push("");
    const armHeader = okResults.map((r) => `\`${r.spec.name}\``).join(" | ");
    report.push(`| ID | Category | Query | Expected files | ${armHeader} |`);
    report.push("|----|----------|-------|----------------|" + okResults.map(() => "---").join("|") + "|");
    for (const label of labels) {
      const cells = okResults.map((r) => {
        const o = r.outcomes.find((x) => x.label.id === label.id);
        if (!o) return "-";
        const hit = o.firstHitRank !== null ? `#${o.firstHitRank}` : "miss";
        const sym = label.symbol ? (o.symbolHitRank !== null ? ` (sym #${o.symbolHitRank})` : " (sym miss)") : "";
        return hit + sym;
      });
      const q = label.query.length > 52 ? label.query.substring(0, 49) + "..." : label.query;
      report.push(`| ${label.id} | ${label.category} | ${q} | ${label.files.join(", ")} | ${cells.join(" | ")} |`);
    }
    report.push("");

    report.push("## Interpretation notes");
    report.push("");
    report.push("- **Rank shown** is the position of the first expected file (1-based); `sym` marks the rank of a chunk");
    report.push("  that also contains the expected symbol.");
    report.push("- **Reranked queries** counts queries where the rerank stage actually reordered (`rerankScore` present in");
    report.push("  the explanation). Fewer than N means the provider timed out/errored or the cooldown was active; those");
    report.push("  queries measured the fusion order, so rerank deltas are conservative.");
    report.push("- **Misses are not necessarily retrieval failures**: a label may map to multiple files and the metric");
    report.push("  counts every expected file; check the per-query table before drawing conclusions.");
    report.push("- **Rerank arms are reorder-only** (`reranking.minScore=0`): the candidate set is unchanged, only the order");
    report.push("  within the top-K differs. A reranker that only churns ranks without improving nDCG@10/MRR is not worth");
    report.push("  the latency cost — that is the decision this report informs.");
    report.push("- Latency was measured warm on a local llama-swap tunnel; p95 includes network jitter. Cold start is not");
    report.push("  included and must be measured separately before enabling the stage by default.");
    report.push("");
  }

  writeFileSync(opts.reportPath, report.join("\n"), "utf-8");

  // ── Console summary ─────────────────────────────────────────────────────
  const sep = "─".repeat(78);
  console.log(sep);
  console.log("  SUMMARY (warm)");
  console.log(sep);
  console.log("  Arm           Hit@1   Hit@5  Recall@10   MRR   nDCG@10   P@5    p50     p95");
  for (const result of okResults) {
    const s = summaries.get(result.spec.name)!;
    console.log(
      `  ${result.spec.name.padEnd(12)}  ${fmtPct(s.hit1).padStart(5)}  ${fmtPct(s.hit5).padStart(5)}  ` +
        `${fmtPct(s.recall10).padStart(8)}  ${s.mrr.toFixed(3)}  ${s.ndcg10.toFixed(3).padStart(7)}  ` +
        `${s.precision5.toFixed(3)}  ${s.latencyP50.toFixed(0).padStart(4)}ms  ${s.latencyP95.toFixed(0).padStart(4)}ms`,
    );
  }
  for (const result of armResults.filter((r) => r.status === "skipped")) {
    console.log(`  ${result.spec.name.padEnd(12)}  SKIPPED — ${result.skipReason}`);
  }
  console.log(sep);
  console.log(`  Report written to: ${opts.reportPath}`);
  console.log();
}

main().catch((err) => {
  console.error("\n  Rerank evaluation failed:", (err as Error).message);
  process.exitCode = 1;
});
