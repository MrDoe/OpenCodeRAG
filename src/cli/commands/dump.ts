/**
 * @fileoverview Dump command for paginated output of all indexed chunks from the vector store.
 */
/**
 * `dump` command — dumps all indexed chunks with pagination support.
 */

import type { Command } from "commander";
import path from "node:path";
import { c, resolveCliContext, cleanupContext, logCliError, logCliInfo } from "../format.js";
import type { CliOptions } from "../types.js";

/**
 * Register the `dump` command on the given Commander program.
 *
 * Retrieves chunks from the vector store with optional offset/limit pagination
 * and prints each chunk's file path, line range, language, and content.
 *
 * @param program - The Commander `Command` instance to register on.
 */
export function registerDumpCommand(program: Command): void {
  program
    .command("dump")
    .description("Dump all indexed chunks")
    .option("-c, --config <path>", "path to config file")
    .option("--offset <number>", "start at chunk offset", "0")
    .option("--limit <number>", "max number of chunks to dump", "25")
    .action(async (options: CliOptions) => {
      try {
        const cwd = process.cwd();
        let logFilePath = path.resolve(cwd, ".opencode", "opencode-rag.log");
        const ctx = await resolveCliContext(options, logFilePath);
        const { store } = ctx;
        logFilePath = ctx.logFilePath;

        const total = await store.count();

        if (total === 0) {
          logCliInfo(logFilePath, "dump", `${c.warn("No indexed chunks found.")} Run 'opencode-rag index' first.`);
          await cleanupContext(ctx);
          return;
        }

        const offset = parseInt(options.offset ?? "0", 10);
        const limit = parseInt(options.limit ?? "25", 10);
        const chunks = await store.getChunks(offset, limit);

        logCliInfo(logFilePath, "dump", `\n${c.heading("Chunks")} ${c.value(String(offset + 1))}${c.label("-")}${c.value(String(offset + chunks.length))} of ${c.num(total)}:\n`);
        for (const chunk of chunks) {
          logCliInfo(logFilePath, "dump", `  ${c.file(chunk.filePath)}:${c.value(String(chunk.startLine))}${c.label("-")}${c.value(String(chunk.endLine))} ${c.label("(")}${c.lang(chunk.language)}${c.label(")")}`);
          logCliInfo(logFilePath, "dump", `  ${chunk.content}\n`);
        }

        if (offset + limit < total) {
          logCliInfo(logFilePath, "dump", `  ${c.dim(`... ${total - offset - limit} more (use --offset ${offset + limit} to continue)`)}`);
        }
        await cleanupContext(ctx);
      } catch (err) {
        const message = (err as Error).message || String(err);
        const logFilePath = path.resolve(process.cwd(), ".opencode", "opencode-rag.log");
        logCliError(logFilePath, "dump", `\nDump failed: ${message}`, err);
        process.exit(1);
      }
    });
}
