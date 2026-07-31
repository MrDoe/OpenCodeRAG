/**
 * @fileoverview Query command for hybrid vector and keyword search against the indexed codebase.
 */
/**
 * `query` command — searches the indexed codebase with semantic and keyword retrieval.
 */

import type { Command } from "commander";
import path from "node:path";
import pc from "picocolors";
import { CODE_SEARCH_FILTER } from "../../core/interfaces.js";
import { retrieve } from "../../retriever/retriever.js";
import { c, resolveCliContext, cleanupContext, logCliError, logCliInfo, formatDuration } from "../format.js";
import { optimizeContext, DEFAULT_CONTEXT_OPTIMIZATION } from "../../retriever/context-optimizer.js";
import type { CliOptions } from "../types.js";

/**
 * Register the `query` command on the given Commander program.
 *
 * Embeds the user's natural-language query, performs hybrid vector + keyword
 * search against the LanceDB store, and prints ranked results with scores,
 * line ranges, and content previews.
 *
 * @param program - The Commander `Command` instance to register on.
 */
export function registerQueryCommand(program: Command): void {
  program
    .command("query")
    .description("Search the indexed codebase")
    .argument("<query>", "natural language query")
    .option("-c, --config <path>", "path to config file")
    .option("-n, --top-k <number>", "number of results", "10")
    .option("--explain", "show hybrid score breakdown")
    .action(async (query: string, options: CliOptions) => {
      const started = Date.now();

      try {
        const cwd = process.cwd();
        let logFilePath = path.resolve(cwd, ".opencode", "opencode-rag.log");
        const ctx = await resolveCliContext(options, logFilePath);
        const { config, embedder, store, keywordIndex } = ctx;
        logFilePath = ctx.logFilePath;

        logCliInfo(logFilePath, "query", `\n${c.heading("Querying:")} "${query}"`);
        logCliInfo(logFilePath, "query", `${c.label("Top-K:")} ${c.num(parseInt(options.topK ?? "10", 10))}`);

        const indexedCount = await store.count();
        if (indexedCount === 0) {
          logCliInfo(logFilePath, "query", `${c.warn("No indexed chunks found.")} Run 'opencode-rag index' first.`);
          await cleanupContext(ctx);
          return;
        }
        logCliInfo(logFilePath, "query", `${c.label("Searching")} ${c.num(indexedCount)} indexed chunks...`);

        const topK = parseInt(options.topK ?? "10", 10);
        const minScore = config.retrieval.minScore;
        const hybridCfg = config.retrieval.hybridSearch;
        const rawResults = await retrieve(query, embedder, store, {
          topK,
          minScore,
          keywordIndex,
          keywordWeight: hybridCfg?.keywordWeight,
          hybridEnabled: hybridCfg?.enabled,
          queryPrefix: config.embedding.queryPrefix,
          explain: options.explain ?? false,
          filter: CODE_SEARCH_FILTER,
        });
        const optCfg = config.retrieval.contextOptimization ?? DEFAULT_CONTEXT_OPTIMIZATION;
        const results = optimizeContext(rawResults, { topK, config: optCfg });

        if (results.length === 0) {
          logCliInfo(logFilePath, "query", c.warn("No results found."));
          await cleanupContext(ctx);
          return;
        }

        const duration = formatDuration(Date.now() - started);
        logCliInfo(logFilePath, "query", `\n${c.num(results.length)} result(s) in ${duration}:\n`);

        for (const r of results) {
          logCliInfo(logFilePath, "query", `  ${c.file(r.chunk.metadata.filePath)}:${c.value(String(r.chunk.metadata.startLine))}-${c.value(String(r.chunk.metadata.endLine))}`);
          logCliInfo(logFilePath, "query", `  ${c.label("Score:")} ${c.score(r.score.toFixed(4))}`);
          if (r.explanation) {
            const sb = r.explanation.scoreBreakdown;
            logCliInfo(logFilePath, "query", `  ${c.label("  Vector:")} ${c.score(sb.rawVectorScore.toFixed(4))}  ${c.label("Keyword:")} ${c.score(sb.rawKeywordScore.toFixed(4))}  ${c.label("KW weight:")} ${sb.keywordWeight.toFixed(2)}`);
            if (r.explanation.matchedTerms && r.explanation.matchedTerms.length > 0) {
              logCliInfo(logFilePath, "query", `  ${c.label("  Matched:")} ${c.lang(r.explanation.matchedTerms.join(", "))}`);
            }
          }
          logCliInfo(logFilePath, "query", `  ${pc.dim(r.chunk.content.replace(/\n/g, "\n  "))}`);
        }
        await cleanupContext(ctx);
      } catch (err) {
        const message = (err as Error).message || String(err);
        const logFilePath = path.resolve(process.cwd(), ".opencode", "opencode-rag.log");
        logCliError(logFilePath, "query", `\nQuery failed: ${message}`, err);
        if (message.toLowerCase().includes("fetch") || message.toLowerCase().includes("econnrefused")) {
          console.error(c.warn("Hint: Is your embedding provider running?"));
        }
        process.exit(1);
      }
    });
}
