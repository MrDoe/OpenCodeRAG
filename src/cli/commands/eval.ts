/**
 * @fileoverview Eval commands for listing, analyzing, and comparing evaluation sessions with token usage breakdowns.
 */
/**
 * `eval:sessions`, `eval:analyze`, `eval:compare` commands —
 * evaluation session listing, per-session token analysis, and cross-session comparison.
 */

import type { Command } from "commander";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { c, resolveCliContext, cleanupContext } from "../format.js";
import type { CliOptions } from "../types.js";
import type { DecisionConfig } from "../../core/config.js";

/**
 * Register the `eval:sessions` command on the given Commander program.
 *
 * Lists all logged evaluation sessions with their query counts,
 * token usage, RAG context tokens, and estimated cost.
 *
 * @param program - The Commander `Command` instance to register on.
 */
export function registerEvalSessionsCommand(program: Command): void {
  program
    .command("eval:sessions")
    .description("List all logged evaluation sessions")
    .option("-c, --config <path>", "path to config file")
    .action(async (options: CliOptions) => {
      try {
        const cwd = process.cwd();
        const logFilePath = path.resolve(cwd, ".opencode", "opencode-rag.log");
        const ctx = await resolveCliContext(options, logFilePath);
        const { storePath } = ctx;

        const { listSessions } = await import("../../eval/storage.js");
        const sessions = listSessions(storePath);

        if (sessions.length === 0) {
          console.log(c.warn("\nNo evaluation sessions found. Sessions are logged automatically during OpenCode usage.\n"));
          return;
        }

        console.log(`\n${c.heading("Evaluation Sessions")} (${sessions.length})\n`);
        console.log("  ID                          Queries  Input Tok  RAG Ctx   Cost");
        console.log("  " + "─".repeat(64));

        for (const s of sessions) {
          const id = (s.sessionID ?? "").padEnd(28);
          const queries = String(s.messageCount).padStart(6);
          const input = String(s.totalTokens.input).padStart(9);
          const ragCtx = String(s.ragContextTokens).padStart(8);
          const cost = `$${s.totalCost.toFixed(4)}`.padStart(7);
          console.log(`  ${id}  ${queries}  ${input}  ${ragCtx}  ${cost}`);
        }
        console.log();
      } catch (err) {
        const message = (err as Error).message || String(err);
        console.error(c.error(`\nFailed: ${message}\n`));
        process.exit(1);
      }
    });
}

/**
 * Register the `eval:analyze <sessionID>` command on the given Commander program.
 *
 * Analyzes token usage for a specific evaluation session, including input/output
 * tokens, reasoning tokens, cache reads, cost, and RAG impact projections.
 *
 * @param program - The Commander `Command` instance to register on.
 */
export function registerEvalAnalyzeCommand(program: Command): void {
  program
    .command("eval:analyze <sessionID>")
    .description("Analyze token usage for a specific session")
    .option("-c, --config <path>", "path to config file")
    .action(async (sessionID: string, options: CliOptions) => {
      try {
        const cwd = process.cwd();
        const logFilePath = path.resolve(cwd, ".opencode", "opencode-rag.log");
        const ctx = await resolveCliContext(options, logFilePath);
        const { storePath } = ctx;

        const { analyzeTokenUsage } = await import("../../eval/token-analysis.js");
        const analysis = analyzeTokenUsage(storePath, sessionID);

        if (analysis.queryCount === 0) {
          console.log(c.warn(`\nNo messages found for session '${sessionID}'.\n`));
          return;
        }

        console.log(`\n${c.heading("Token Analysis")} — ${c.value(sessionID)}\n`);
        console.log(`  Queries:          ${analysis.queryCount}`);
        console.log(`  Input tokens:     ${c.num(analysis.totals.inputTokens.toLocaleString())}`);
        console.log(`  Output tokens:    ${c.num(analysis.totals.outputTokens.toLocaleString())}`);
        console.log(`  Reasoning tokens: ${c.num(analysis.totals.reasoningTokens.toLocaleString())}`);
        console.log(`  Cache read:       ${c.num(analysis.totals.cacheRead.toLocaleString())}`);
        console.log(`  Cost:             ${c.num(`$${analysis.totals.cost.toFixed(4)}`)}`);
        console.log();
        console.log(`  ${c.heading("RAG Impact")}`);
        console.log(`  Context injected: ${c.num(analysis.totals.ragContextTokens.toLocaleString())} tokens`);
        console.log(`  System guidance:  ${c.num(analysis.totals.systemGuidanceTokens.toLocaleString())} tokens`);
        console.log(`  Read calls:       ${c.num(analysis.totals.readToolCalls)}`);
        console.log(`  RAG tool calls:   ${c.num(analysis.totals.ragToolCalls)}`);
        console.log();
        console.log(`  ${c.heading("Projection")}`);
        console.log(`  Tokens with RAG:    ${c.num(analysis.estimates.tokensWithRAG.toLocaleString())}`);
        console.log(`  Tokens without RAG: ${c.num(analysis.estimates.tokensWithoutRAG.toLocaleString())}`);
        const savingsColor = analysis.estimates.netSavings > 0 ? c.success : c.warn;
        console.log(`  Net savings:        ${savingsColor(`${analysis.estimates.netSavings > 0 ? "+" : ""}${analysis.estimates.netSavings.toLocaleString()} tokens (${analysis.estimates.percentSavings}%)`)}`);
        console.log();

        if (analysis.breakdowns.length > 0) {
          console.log(`  ${c.heading("Per-Query Breakdown")}`);
          console.log("  #    Input   RAG ctx  Reads  RAG tools  Score");
          console.log("  " + "─".repeat(52));
          for (let i = 0; i < analysis.breakdowns.length; i++) {
            const b = analysis.breakdowns[i]!;
            const num = String(i + 1).padStart(3);
            const input = String(b.inputTokens).padStart(7);
            const ctx = String(b.ragContextTokens).padStart(7);
            const reads = String(b.readToolCalls).padStart(5);
            const tools = String(b.ragToolCalls).padStart(9);
            const score = b.ragTopScore.toFixed(2);
            console.log(`  ${num}  ${input}  ${ctx}  ${reads}  ${tools}  ${score}`);
          }
        }
        console.log();
      } catch (err) {
        const message = (err as Error).message || String(err);
        console.error(c.error(`\nFailed: ${message}\n`));
        process.exit(1);
      }
    });
}

/**
 * Register the `eval:compare <sessionA> <sessionB>` command on the given Commander program.
 *
 * Compares token usage between two evaluation sessions (e.g. RAG-on vs RAG-off)
 * and prints a formatted comparison report with deltas and percentage changes.
 *
 * @param program - The Commander `Command` instance to register on.
 */
export function registerEvalCompareCommand(program: Command): void {
  program
    .command("eval:compare <sessionA> <sessionB>")
    .description("Compare token usage between two sessions (e.g. RAG-on vs RAG-off)")
    .option("-c, --config <path>", "path to config file")
    .action(async (sessionA: string, sessionB: string, options: CliOptions) => {
      try {
        const cwd = process.cwd();
        const logFilePath = path.resolve(cwd, ".opencode", "opencode-rag.log");
        const ctx = await resolveCliContext(options, logFilePath);
        const { storePath } = ctx;

        const { analyzeTokenUsage, compareTokenAnalyses, formatTokenReport } = await import("../../eval/token-analysis.js");
        const a = analyzeTokenUsage(storePath, sessionA);
        const b = analyzeTokenUsage(storePath, sessionB);

        if (a.queryCount === 0 && b.queryCount === 0) {
          console.log(c.warn(`\nNo messages found for sessions '${sessionA}' or '${sessionB}'.\n`));
          return;
        }

        const comparison = compareTokenAnalyses(a, b);
        const report = formatTokenReport(a, b, comparison);
        console.log(report);
      } catch (err) {
        const message = (err as Error).message || String(err);
        console.error(c.error(`\nFailed: ${message}\n`));
        process.exit(1);
      }
    });
}

/** Options for the `eval:gate` command. */
interface EvalGateOptions extends CliOptions {
  /** Path to the golden-set label file. */
  labels?: string;
  /** Override retrieval top-K. */
  topk?: string;
  /** Only run labels of one category. */
  category?: string;
  /** Only run the first N labels. */
  limit?: string;
  /** Minimum mean Hit@5. */
  minHit5?: string;
  /** Minimum mean reciprocal rank. */
  minMrr?: string;
  /** Minimum mean nDCG@10. */
  minNdcg10?: string;
  /** Print a machine-readable result as the last stdout line. */
  json?: boolean;
}

/** Parse a `0..1` ratio CLI option, or undefined when absent. */
function parseRatioOption(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number between 0 and 1 (got "${raw}")`);
  }
  return value;
}

/**
 * Register the `eval:gate` command on the given Commander program.
 *
 * Runs the labelled golden set through the real retrieval pipeline (fusion only —
 * the rerank stage is intentionally not active) and exits non-zero when Hit@5,
 * MRR, or nDCG@10 drop below the documented floors. Exit contract:
 * `0` = passed, `1` = gate failed (quality regression), `2` = could not run
 * (missing labels/index, provider down, invalid options).
 *
 * @param program - The Commander `Command` instance to register on.
 */
export function registerEvalGateCommand(program: Command): void {
  program
    .command("eval:gate")
    .description("Run the retrieval golden set and fail when Hit@5 / MRR / nDCG@10 drop below the thresholds")
    .option("-c, --config <path>", "path to config file")
    .option("--labels <path>", "golden-set label file (default: src/eval/rerank-labels.json)")
    .option("--topk <n>", "top-K retrieved per query (default: retrieval.topK)")
    .option("--category <name>", "only run labels of this category")
    .option("--limit <n>", "only run the first N labels")
    .option("--min-hit5 <ratio>", "minimum Hit@5, 0-1 (default 0.35)")
    .option("--min-mrr <ratio>", "minimum MRR, 0-1 (default 0.25)")
    .option("--min-ndcg10 <ratio>", "minimum nDCG@10, 0-1 (default 0.32)")
    .option("--json", "print a machine-readable result as the last stdout line")
    .action(async (options: EvalGateOptions) => {
      const cwd = process.cwd();
      const logFilePath = path.resolve(cwd, ".opencode", "opencode-rag.log");
      const started = Date.now();
      let ctx: Awaited<ReturnType<typeof resolveCliContext>> | undefined;
      let exitCode = 0;
      try {
        const { loadGoldenLabels } = await import("../../eval/golden-set.js");
        const { DEFAULT_GATE_THRESHOLDS, evaluateGate, runGoldenGate } = await import("../../eval/golden-gate.js");

        const labelsPath = options.labels
          ? path.resolve(cwd, options.labels)
          : path.join(cwd, "src", "eval", "rerank-labels.json");
        let labels = loadGoldenLabels(labelsPath);
        if (options.category) labels = labels.filter((label) => label.category === options.category);
        if (options.limit !== undefined) {
          const limit = Number(options.limit);
          if (!Number.isInteger(limit) || limit <= 0) {
            throw new Error(`--limit must be a positive integer (got "${options.limit}")`);
          }
          labels = labels.slice(0, limit);
        }
        if (labels.length === 0) {
          throw new Error("No labels selected (check --category/--limit).");
        }

        const thresholds = {
          hit5: parseRatioOption(options.minHit5, "--min-hit5") ?? DEFAULT_GATE_THRESHOLDS.hit5,
          mrr: parseRatioOption(options.minMrr, "--min-mrr") ?? DEFAULT_GATE_THRESHOLDS.mrr,
          ndcg10: parseRatioOption(options.minNdcg10, "--min-ndcg10") ?? DEFAULT_GATE_THRESHOLDS.ndcg10,
        };

        ctx = await resolveCliContext(options, logFilePath);
        const indexedCount = await ctx.store.count();
        if (indexedCount === 0) {
          console.error(c.error(`\nGate cannot run: the index is empty. Run 'opencode-rag index' first.\n`));
          await cleanupContext(ctx);
          process.exit(2);
        }

        const topK = options.topk !== undefined ? Number(options.topk) : ctx.config.retrieval.topK;
        if (!Number.isInteger(topK) || topK <= 0) {
          throw new Error(`--topk must be a positive integer (got "${options.topk}")`);
        }

        // Mirror the production retrieval options from the resolved config — the
        // gate must measure the shipped pipeline, not a bespoke one.
        const hybrid = (ctx.config.retrieval as unknown as {
          hybridSearch?: {
            enabled?: boolean;
            keywordWeight?: number;
            symbolKeywordWeight?: number;
            docKeywordDemotion?: number;
            testKeywordDemotion?: number;
          };
        }).hybridSearch;
        const retrieveOptions = {
          topK,
          minScore: ctx.config.retrieval.minScore,
          keywordIndex: ctx.keywordIndex,
          keywordWeight: hybrid?.keywordWeight,
          symbolKeywordWeight: hybrid?.symbolKeywordWeight,
          docKeywordDemotion: hybrid?.docKeywordDemotion,
          testKeywordDemotion: hybrid?.testKeywordDemotion,
          hybridEnabled: hybrid?.enabled,
          queryPrefix: ctx.config.embedding.queryPrefix,
        };
        const { retrieve } = await import("../../retriever/retriever.js");

        console.log(`\n${c.heading("Retrieval Golden-Set Gate")}\n`);
        console.log(`  Indexed chunks:  ${c.num(indexedCount)}`);
        console.log(`  Embedder:        ${c.value(`${ctx.config.embedding.provider}/${ctx.config.embedding.model}`)} (dim ${c.num(ctx.dimension)})`);
        console.log(`  Retrieval:       topK=${c.num(topK)}, minScore=${c.num(ctx.config.retrieval.minScore)}, hybrid=${c.value(String(hybrid?.enabled ?? false))}`);
        console.log(`  Labels:          ${c.num(labels.length)} from ${c.file(path.relative(cwd, labelsPath).replace(/\\/g, "/"))}`);
        console.log(`  Note:            fusion-only measurement — the rerank stage is intentionally not active.\n`);

        const { summary } = await runGoldenGate({
          labels,
          root: cwd,
          retrieve: (label) => retrieve(label.query, ctx!.embedder, ctx!.store, retrieveOptions),
        });

        const { pass, rows } = evaluateGate(summary, thresholds);
        console.log(`\n  ${c.heading("Gate")}`);
        for (const row of rows) {
          const mark = row.pass ? c.success("PASS") : c.error("FAIL");
          console.log(
            `  ${mark}  ${row.metric.padEnd(8)} ${(row.actual * 100).toFixed(1).padStart(6)}%  (required ≥ ${(row.required * 100).toFixed(1)}%)`,
          );
        }
        console.log(
          `\n  All metrics: Hit@1 ${(summary.hit1 * 100).toFixed(1)}% · Hit@3 ${(summary.hit3 * 100).toFixed(1)}% · ` +
          `Hit@5 ${(summary.hit5 * 100).toFixed(1)}% · Hit@10 ${(summary.hit10 * 100).toFixed(1)}% · ` +
          `MRR ${summary.mrr.toFixed(3)} · nDCG@10 ${summary.ndcg10.toFixed(3)}\n`,
        );

        if (options.json) {
          console.log(JSON.stringify({
            schema: 1,
            status: pass ? "pass" : "fail",
            durationMs: Date.now() - started,
            labels: labels.length,
            labelsPath: path.relative(cwd, labelsPath).replace(/\\/g, "/"),
            topK,
            indexedChunks: indexedCount,
            metrics: {
              hit1: summary.hit1,
              hit3: summary.hit3,
              hit5: summary.hit5,
              hit10: summary.hit10,
              mrr: summary.mrr,
              ndcg10: summary.ndcg10,
              symbolRate: summary.symbolRate,
            },
            thresholds,
            rows,
          }));
        }

        if (!pass) {
          console.error(c.error("\nGate FAILED — ranking regressed below the documented floors.\n"));
          exitCode = 1;
        } else {
          console.log(c.success("Gate passed."));
        }
      } catch (err) {
        const message = (err as Error).message || String(err);
        console.error(c.error(`\nGate could not run: ${message}\n`));
        if (message.toLowerCase().includes("fetch") || message.toLowerCase().includes("econnrefused")) {
          console.error(c.warn("Hint: Is your embedding provider running?\n"));
        }
        exitCode = 2;
      } finally {
        if (ctx) await cleanupContext(ctx);
      }
      process.exit(exitCode);
    });
}

/** Options for the `eval:decide` command. */
interface EvalDecideOptions extends CliOptions {
  /** Path to the calibration label file. */
  labels?: string;
  /** Decision model override. */
  model?: string;
  /** Ollama base URL override. */
  baseUrl?: string;
  /** Only run items of one category. */
  category?: string;
  /** Only run the first N items. */
  limit?: string;
  /** Write a markdown calibration report to this path. */
  report?: string;
  /** Print a machine-readable result as the last stdout line. */
  json?: boolean;
}

/**
 * Register the `eval:decide` command on the given Commander program.
 *
 * Measures accuracy, ECE (10 bins) and Brier score of the tev1 decision model against
 * the labelled calibration set. Unlike `eval:gate` this is a measurement, not a threshold
 * check — it exits `0` when the run completed, `2` when it could not run (no decision
 * config, Ollama unreachable, model missing).
 *
 * @param program - The Commander `Command` instance to register on.
 */
export function registerEvalDecideCommand(program: Command): void {
  program
    .command("eval:decide")
    .description("Measure accuracy, ECE, and Brier score of the tev1 decision model on the labelled calibration set")
    .option("-c, --config <path>", "path to config file")
    .option("--labels <path>", "calibration label file (default: src/eval/decide-labels.json)")
    .option("--model <name>", "decision model override (synthesizes an enabled decision config)")
    .option("--base-url <url>", "Ollama base URL override (e.g. http://127.0.0.1:11434)")
    .option("--category <name>", "only run items of this category")
    .option("--limit <n>", "only run the first N items")
    .option("--report <path>", "write a markdown calibration report to this path")
    .option("--json", "print a machine-readable result as the last stdout line")
    .action(async (options: EvalDecideOptions) => {
      const cwd = process.cwd();
      const logFilePath = path.resolve(cwd, ".opencode", "opencode-rag.log");
      let ctx: Awaited<ReturnType<typeof resolveCliContext>> | undefined;
      let exitCode = 0;
      try {
        const { loadDecideCalibration, runDecideCalibration } = await import("../../eval/decide-calibration.js");
        const labelsPath = options.labels
          ? path.resolve(cwd, options.labels)
          : path.join(cwd, "src", "eval", "decide-labels.json");
        let items = loadDecideCalibration(labelsPath);
        if (options.category) items = items.filter((item) => item.category === options.category);
        if (options.limit !== undefined) {
          const limit = Number(options.limit);
          if (!Number.isInteger(limit) || limit <= 0) {
            throw new Error(`--limit must be a positive integer (got "${options.limit}")`);
          }
          items = items.slice(0, limit);
        }
        if (items.length === 0) {
          throw new Error("No calibration items selected (check --category/--limit).");
        }

        ctx = await resolveCliContext(options, logFilePath);
        const configured = ctx.config.decision;
        let decisionCfg: DecisionConfig | undefined;
        if (configured?.enabled) {
          decisionCfg = { ...configured };
        } else if (options.baseUrl || options.model) {
          // CLI-only override, like the rerank harness — never touches the config file.
          decisionCfg = {
            enabled: true,
            provider: "ollama",
            baseUrl: options.baseUrl ?? "http://127.0.0.1:11434",
            model: options.model ?? "tev1:0.8b",
            timeoutMs: 30000,
          };
        }
        if (!decisionCfg) {
          console.error(
            c.error("\nNo enabled decision config. Set `decision.enabled` in opencode-rag.json or pass --base-url/--model.\n"),
          );
          await cleanupContext(ctx);
          process.exit(2);
        }
        if (options.model) decisionCfg.model = options.model;
        if (options.baseUrl) decisionCfg.baseUrl = options.baseUrl;

        const { createDecisionProvider } = await import("../../decision/factory.js");
        const provider = createDecisionProvider(decisionCfg);

        console.log(`\n${c.heading("Decision-Model Calibration")}\n`);
        console.log(`  Model:     ${c.value(decisionCfg.model)} (${c.value(decisionCfg.baseUrl)})`);
        console.log(`  Items:     ${c.num(items.length)} from ${c.file(path.relative(cwd, labelsPath).replace(/\\/g, "/"))}`);
        console.log(`  Note:      'confidence' is probability concentration — this run measures how close it is to correctness.\n`);

        const { scored, summary } = await runDecideCalibration({ items, provider });

        console.log(`\n  ${c.heading("Calibration")}`);
        console.log(`  Accuracy:          ${c.num(`${(summary.accuracy * 100).toFixed(1)}%`)} (${summary.n} items, ${summary.answered} answered)`);
        console.log(`  ECE (10 bins):     ${c.num(summary.ece.toFixed(3))}`);
        console.log(`  Brier score:       ${c.num(summary.brier.toFixed(3))}`);
        console.log(`  Mean confidence:   ${c.num(summary.meanConfidence.toFixed(3))}`);
        if (summary.meanPExpected !== null) {
          console.log(`  Mean p(expected):  ${c.num(summary.meanPExpected.toFixed(3))}`);
        }
        console.log();
        console.log(`  ${c.heading("Reliability")}  (bin, n, mean confidence, accuracy, gap)`);
        for (const bin of summary.bins) {
          if (bin.count === 0) continue;
          const gap = (bin.accuracy - bin.confidence) * 100;
          console.log(
            `  ${(bin.lo).toFixed(1)}–${(bin.hi).toFixed(1)}  n=${String(bin.count).padStart(2)}  ` +
            `conf=${bin.confidence.toFixed(2)}  acc=${bin.accuracy.toFixed(2)}  gap=${gap >= 0 ? "+" : ""}${gap.toFixed(0)}%`,
          );
        }
        console.log();

        if (options.report) {
          const reportPath = path.resolve(cwd, options.report);
          const lines: string[] = [
            "# Decision-Model Calibration",
            "",
            `**Date:** ${new Date().toISOString()}`,
            `**Model:** ${decisionCfg.model} (${decisionCfg.baseUrl})`,
            `**Labels:** ${items.length} from \`${path.relative(cwd, labelsPath).replace(/\\/g, "/")}\``,
            "",
            "## Metrics",
            "",
            "| Metric | Value |",
            "|--------|-------|",
            `| Accuracy | ${(summary.accuracy * 100).toFixed(1)}% (${summary.n} items, ${summary.answered} answered) |`,
            `| ECE (10 bins) | ${summary.ece.toFixed(3)} |`,
            `| Brier score | ${summary.brier.toFixed(3)} |`,
            `| Mean confidence | ${summary.meanConfidence.toFixed(3)} |`,
            `| Mean p(expected) | ${summary.meanPExpected !== null ? summary.meanPExpected.toFixed(3) : "-"} |`,
            "",
            "## Reliability (10 bins)",
            "",
            "| Bin | n | Mean confidence | Accuracy | Gap |",
            "|-----|---|-----------------|----------|-----|",
          ];
          for (const bin of summary.bins) {
            if (bin.count === 0) continue;
            const gap = (bin.accuracy - bin.confidence) * 100;
            lines.push(
              `| ${bin.lo.toFixed(1)}–${bin.hi.toFixed(1)} | ${bin.count} | ${bin.confidence.toFixed(2)} | ${bin.accuracy.toFixed(2)} | ${gap >= 0 ? "+" : ""}${gap.toFixed(0)}% |`,
            );
          }
          lines.push("", "## Per-item", "", "| ID | Category | Expected | Predicted | Correct | Confidence |", "|----|----------|----------|-----------|---------|------------|");
          for (const entry of scored) {
            lines.push(
              `| ${entry.item.id} | ${entry.item.category} | ${entry.item.expected} | ${entry.predicted ?? "-"} | ${entry.correct ? "yes" : "no"} | ${entry.confidence.toFixed(2)} |`,
            );
          }
          lines.push("");
          writeFileSync(reportPath, lines.join("\n"), "utf-8");
          console.log(`  Report written: ${c.file(reportPath)}\n`);
        }

        if (options.json) {
          console.log(JSON.stringify({
            schema: 1,
            status: "ok",
            model: decisionCfg.model,
            labels: items.length,
            labelsPath: path.relative(cwd, labelsPath).replace(/\\/g, "/"),
            metrics: {
              accuracy: summary.accuracy,
              answered: summary.answered,
              ece: summary.ece,
              brier: summary.brier,
              meanConfidence: summary.meanConfidence,
              meanPExpected: summary.meanPExpected,
            },
            bins: summary.bins,
            items: scored.map((entry) => ({
              id: entry.item.id,
              expected: entry.item.expected,
              predicted: entry.predicted ?? null,
              correct: entry.correct,
              confidence: entry.confidence,
            })),
          }));
        }
      } catch (err) {
        const message = (err as Error).message || String(err);
        console.error(c.error(`\nCalibration could not run: ${message}\n`));
        if (message.toLowerCase().includes("econnrefused") || message.toLowerCase().includes("fetch")) {
          console.error(c.warn("Hint: decision calibration requires Ollama >= 0.35 with a pulled tev1 model (`ollama pull tev1:0.8b`).\n"));
        }
        exitCode = 2;
      } finally {
        if (ctx) await cleanupContext(ctx);
      }
      process.exit(exitCode);
    });
}
