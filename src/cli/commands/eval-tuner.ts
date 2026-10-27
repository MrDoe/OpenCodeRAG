/**
 * @fileoverview `eval:tune` command — sweeps the retrieval fusion weights
 * against the labelled golden set and reports the best configuration.
 */
import type { Command } from "commander";
import path from "node:path";
import { c, resolveCliContext, cleanupContext, logCliError } from "../format.js";
import type { CliOptions } from "../types.js";
import type { TuningCandidate, TuningMetric } from "../../eval/tuner.js";

/** Options for the `eval:tune` command. */
interface EvalTuneOptions extends CliOptions {
  /** Path to the golden-set label file. */
  labels?: string;
  /** Only run labels of one category. */
  category?: string;
  /** Only run the first N labels. */
  limit?: string;
  /** Metric the winner is picked by (ndcg10 | hit5 | hit1 | mrr). */
  metric?: string;
  /** Comma-separated keyword weights to try. */
  keywordWeights?: string;
  /** Comma-separated symbol keyword weights to try. */
  symbolWeights?: string;
  /** Comma-separated minScore values to try. */
  minScores?: string;
  /** Comma-separated topK values to try. */
  topks?: string;
  /** Write the winning values into the config file. */
  write?: boolean;
  /** Print a machine-readable result as the last stdout line. */
  json?: boolean;
}

/** Parse a comma-separated list of numbers. */
function parseNumberList(raw: string | undefined, option: string): number[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new Error(`${option} needs at least one number (e.g. "${option} 0,0.2,0.4")`);
  }
  const values = parts.map((p) => Number(p));
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isFinite(value)) {
      throw new Error(`${option} contains a non-numeric value: "${part}"`);
    }
  }
  return values;
}

/**
 * Register the `eval:tune` command on the given Commander program.
 *
 * Measures the current retrieval configuration against the golden set, sweeps a
 * grid of fusion weights, and reports the winner. Exits `0` when the sweep ran
 * (even when the current configuration already wins), `2` when it could not run.
 *
 * @param program - The Commander `Command` instance to register on.
 */
export function registerEvalTuneCommand(program: Command): void {
  program
    .command("eval:tune")
    .description(
      "Sweep the retrieval fusion weights against the golden set and report the best configuration",
    )
    .option("-c, --config <path>", "path to config file")
    .option("--labels <path>", "golden-set label file (default: src/eval/rerank-labels.json)")
    .option("--category <name>", "only run labels of this category")
    .option("--limit <n>", "only run the first N labels")
    .option("--metric <name>", "metric the winner is picked by (ndcg10 | hit5 | hit1 | mrr, default ndcg10)")
    .option("--keyword-weights <list>", "comma-separated keyword weights to try (default 0,0.1,...,0.6)")
    .option("--symbol-weights <list>", "comma-separated symbol keyword weights to try (default: same as keyword weights)")
    .option("--min-scores <list>", "comma-separated minScore values to try (default: the configured one)")
    .option("--topks <list>", "comma-separated topK values to try (default: the configured one)")
    .option("--write", "write the winning values into the config file")
    .option("--json", "print a machine-readable result as the last stdout line")
    .action(async (options: EvalTuneOptions) => {
      const cwd = process.cwd();
      const logFilePath = path.resolve(cwd, ".opencode", "opencode-rag.log");
      let ctx: Awaited<ReturnType<typeof resolveCliContext>> | undefined;
      let exitCode = 0;
      try {
        const { loadGoldenLabels } = await import("../../eval/golden-set.js");
        const {
          applyTuningToConfig,
          buildCandidateGrid,
          comparePaired,
          measureSignalQuality,
          runTuner,
          selectBestTuning,
          tuningDelta,
        } = await import("../../eval/tuner.js");
        const { updateConfigValue } = await import("../../core/config.js");
        const { retrieve } = await import("../../retriever/retriever.js");

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

        const metric = (options.metric ?? "ndcg10") as TuningMetric;
        if (!["ndcg10", "hit5", "hit1", "mrr"].includes(metric)) {
          throw new Error(`--metric must be one of ndcg10, hit5, hit1, mrr (got "${options.metric}")`);
        }

        ctx = await resolveCliContext(options, logFilePath);
        const indexedCount = await ctx.store.count();
        if (indexedCount === 0) {
          console.error(c.error(`\nTuning cannot run: the index is empty. Run 'opencode-rag index' first.\n`));
          await cleanupContext(ctx);
          process.exit(2);
        }

        const hybrid = ctx.config.retrieval.hybridSearch;
        const base: TuningCandidate = {
          keywordWeight: hybrid?.keywordWeight ?? 0.4,
          symbolKeywordWeight: hybrid?.symbolKeywordWeight,
          minScore: ctx.config.retrieval.minScore,
          topK: ctx.config.retrieval.topK,
        };

        const candidates = buildCandidateGrid(base, {
          keywordWeights: parseNumberList(options.keywordWeights, "--keyword-weights"),
          symbolKeywordWeights: parseNumberList(options.symbolWeights, "--symbol-weights"),
          minScores: parseNumberList(options.minScores, "--min-scores"),
          topKs: parseNumberList(options.topks, "--topks"),
        });

        console.log(`\n${c.heading("Retrieval Tuning")}\n`);
        console.log(`  Indexed chunks:  ${c.num(indexedCount)}`);
        console.log(`  Embedder:        ${c.value(`${ctx.config.embedding.provider}/${ctx.config.embedding.model}`)} (dim ${c.num(ctx.dimension)})`);
        console.log(`  Labels:          ${c.num(labels.length)} from ${c.file(path.relative(cwd, labelsPath).replace(/\\/g, "/"))}`);
        console.log(`  Current config:  keywordWeight=${c.num(base.keywordWeight)} symbolKeywordWeight=${c.num(base.symbolKeywordWeight ?? "unset")} minScore=${c.num(base.minScore)} topK=${c.num(base.topK)}`);
        console.log(`  Candidates:      ${c.num(candidates.length)} · winner picked by ${c.value(metric)}\n`);

        const results = await runTuner({
          labels,
          root: cwd,
          candidates,
          retrieve: (label, candidate) =>
            retrieve(label.query, ctx!.embedder, ctx!.store, {
              topK: candidate.topK,
              minScore: candidate.minScore,
              keywordIndex: ctx!.keywordIndex,
              keywordWeight: candidate.keywordWeight,
              symbolKeywordWeight: candidate.symbolKeywordWeight,
              docKeywordDemotion: hybrid?.docKeywordDemotion,
              testKeywordDemotion: hybrid?.testKeywordDemotion,
              hybridEnabled: hybrid?.enabled,
              queryPrefix: ctx!.config.embedding.queryPrefix,
            }),
          log: (line) => console.log(line),
        });

        const best = selectBestTuning(results, metric);
        if (!best) {
          throw new Error("The sweep produced no results.");
        }
        const current = results.find(
          (r) =>
            r.keywordWeight === base.keywordWeight &&
            (r.symbolKeywordWeight ?? "unset") === (base.symbolKeywordWeight ?? "unset") &&
            r.minScore === base.minScore &&
            r.topK === base.topK,
        );
        const delta = tuningDelta(best, current);

        console.log(`\n  ${c.heading("Best configuration")}`);
        console.log(`  keywordWeight=${c.num(best.keywordWeight)}  symbolKeywordWeight=${c.num(best.symbolKeywordWeight ?? "unset")}  minScore=${c.num(best.minScore)}  topK=${c.num(best.topK)}`);
        console.log(
          `  Hit@1 ${(best.summary.hit1 * 100).toFixed(1)}% · Hit@3 ${(best.summary.hit3 * 100).toFixed(1)}% · ` +
          `Hit@5 ${(best.summary.hit5 * 100).toFixed(1)}% · Hit@10 ${(best.summary.hit10 * 100).toFixed(1)}% · ` +
          `MRR ${best.summary.mrr.toFixed(3)} · nDCG@10 ${best.summary.ndcg10.toFixed(3)}`,
        );
        if (current) {
          const sign = (v: number): string => (v >= 0 ? "+" : "");
          console.log(
            `  ${c.dim("vs. current config:")} Hit@5 ${sign(delta.hit5!)}${(delta.hit5! * 100).toFixed(1)} pts · ` +
            `MRR ${sign(delta.mrr!)}${delta.mrr!.toFixed(3)} · nDCG@10 ${sign(delta.ndcg10!)}${delta.ndcg10!.toFixed(3)}`,
          );
        }

        // The point estimate alone is not evidence on a small label set — show
        // the confidence interval and refuse to recommend a change the data
        // does not support.
        const paired = comparePaired(best, current, metric);
        if (paired) {
          const sign = (v: number): string => (v >= 0 ? "+" : "");
          console.log(
            `  ${c.dim("paired bootstrap:")} Δ${paired.metric} ${sign(paired.meanDelta)}${paired.meanDelta.toFixed(3)} ` +
            `(95% CI ${paired.ciLow.toFixed(3)} … ${paired.ciHigh.toFixed(3)}) · ` +
            `${paired.improved} better / ${paired.regressed} worse / ${paired.unchanged} equal · ` +
            `sign test p=${paired.signTestP.toFixed(2)}`,
          );
          if (paired.signTestP > 0.05) {
            console.log(
              `  ${c.warn("Weak evidence:")} the sign test over the discordant labels is not significant — ` +
              "more labels are needed before changing the shipped default.",
            );
          }
          if (paired.withinNoise) {
            console.log(
              `  ${c.warn("Within noise:")} the 95% CI includes 0 for ${labels.length} label(s) — ` +
              "treat the winner as a hint, not a measurement. Add labels or check the signal split below.",
            );
          }
        }

        // Per-signal split: a fused number is only interpretable next to the
        // quality of the two halves it mixes.
        const signals = await measureSignalQuality({
          labels,
          root: cwd,
          retrieveKeyword: async (label) =>
            ctx!.keywordIndex.search(label.query, (base.topK ?? 20) * 3),
          retrieveVector: async (label) =>
            retrieve(label.query, ctx!.embedder, ctx!.store, {
              topK: base.topK,
              minScore: 0,
              keywordIndex: undefined,
              keywordWeight: 0,
              queryPrefix: ctx!.config.embedding.queryPrefix,
            }),
          retrieveFused: async (label) =>
            retrieve(label.query, ctx!.embedder, ctx!.store, {
              topK: base.topK,
              minScore: base.minScore,
              keywordIndex: ctx!.keywordIndex,
              keywordWeight: base.keywordWeight,
              symbolKeywordWeight: base.symbolKeywordWeight,
              docKeywordDemotion: hybrid?.docKeywordDemotion,
              testKeywordDemotion: hybrid?.testKeywordDemotion,
              hybridEnabled: hybrid?.enabled,
              queryPrefix: ctx!.config.embedding.queryPrefix,
            }),
        });
        console.log(`\n  ${c.heading("Signal split")} ${c.dim("(file level, current config, minScore=0 for the single signals)")}`);
        const signalRow = (name: string, q: { hit1: number; hit5: number; hit10: number; misses: number }): string =>
          `  ${name.padEnd(14)} Hit@1 ${(q.hit1 * 100).toFixed(1)}% · Hit@5 ${(q.hit5 * 100).toFixed(1)}% · ` +
          `Hit@10 ${(q.hit10 * 100).toFixed(1)}% · ${q.misses} miss`;
        console.log(signalRow("BM25 only", signals.keyword));
        console.log(signalRow("vector only", signals.vector));
        console.log(signalRow(`fused kw=${base.keywordWeight}`, signals.fused));

        let written = false;
        if (options.write) {
          if (!ctx.configPath) {
            throw new Error(
              "No config file to write to — pass --config <path> or run this in a workspace with .opencode/opencode-rag.json.",
            );
          }
          const tuned = applyTuningToConfig(ctx.config, best);
          const hybridWeights = tuned.retrieval.hybridSearch ?? { enabled: true, keywordWeight: best.keywordWeight };
          const updates: Array<[string[], unknown]> = [
            [["retrieval", "hybridSearch", "keywordWeight"], hybridWeights.keywordWeight],
            [["retrieval", "hybridSearch", "symbolKeywordWeight"], hybridWeights.symbolKeywordWeight],
            [["retrieval", "minScore"], tuned.retrieval.minScore],
            [["retrieval", "topK"], tuned.retrieval.topK],
          ];
          for (const [keyPath, value] of updates) {
            if (value === undefined) continue;
            if (!updateConfigValue(ctx.configPath, keyPath, value)) {
              throw new Error(`Could not write ${keyPath.join(".")} to ${ctx.configPath}`);
            }
          }
          written = true;
          console.log(`  ${c.success(`Wrote the winning configuration to ${path.relative(cwd, ctx.configPath)}`)}`);
        } else {
          console.log(`  ${c.dim("Re-run with --write to persist these values.")}`);
        }

        if (options.json) {
          console.log(
            JSON.stringify({
              schema: 1,
              status: "ok",
              labels: labels.length,
              labelsPath: path.relative(cwd, labelsPath).replace(/\\/g, "/"),
              metric,
              candidates: results.map((r) => ({
                keywordWeight: r.keywordWeight,
                symbolKeywordWeight: r.symbolKeywordWeight,
                minScore: r.minScore,
                topK: r.topK,
                hit1: r.summary.hit1,
                hit5: r.summary.hit5,
                mrr: r.summary.mrr,
                ndcg10: r.summary.ndcg10,
                durationMs: r.durationMs,
              })),
              best: {
                keywordWeight: best.keywordWeight,
                symbolKeywordWeight: best.symbolKeywordWeight,
                minScore: best.minScore,
                topK: best.topK,
                metrics: {
                  hit1: best.summary.hit1,
                  hit5: best.summary.hit5,
                  mrr: best.summary.mrr,
                  ndcg10: best.summary.ndcg10,
                },
              },
              delta,
              paired: paired
                ? {
                    metric: paired.metric,
                    meanDelta: paired.meanDelta,
                    ciLow: paired.ciLow,
                    ciHigh: paired.ciHigh,
                    pBetter: paired.pBetter,
                    improved: paired.improved,
                    regressed: paired.regressed,
                    unchanged: paired.unchanged,
                    withinNoise: paired.withinNoise,
                    signTestP: paired.signTestP,
                  }
                : null,
              signals: {
                keyword: signals.keyword,
                vector: signals.vector,
                fused: signals.fused,
              },
              written,
            }),
          );
        }
      } catch (err) {
        const message = (err as Error).message || String(err);
        console.error(c.error(`\nTuning could not run: ${message}\n`));
        if (message.toLowerCase().includes("fetch") || message.toLowerCase().includes("econnrefused")) {
          console.error(c.warn("Hint: Is your embedding provider running?\n"));
        }
        logCliError(logFilePath, "eval:tune", `Tuning failed: ${message}`, err);
        exitCode = 2;
      } finally {
        if (ctx) await cleanupContext(ctx);
      }
      process.exit(exitCode);
    });
}
