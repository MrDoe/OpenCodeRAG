/**
 * @fileoverview List command displaying all indexed files with their chunk counts and languages.
 */
/**
 * `list` command — displays all indexed files with their chunk counts.
 */

import type { Command } from "commander";
import path from "node:path";
import { c, resolveCliContext, cleanupContext, logCliError, logCliInfo } from "../format.js";
import type { CliOptions } from "../types.js";

/**
 * Register the `list` command on the given Commander program.
 *
 * Queries the vector store for all indexed files and prints a formatted table
 * showing each file path, language, and chunk count.
 *
 * @param program - The Commander `Command` instance to register on.
 */
export function registerListCommand(program: Command): void {
  program
    .command("list")
    .description("List all indexed files with chunk counts")
    .option("-c, --config <path>", "path to config file")
    .action(async (options: CliOptions) => {
      try {
        const cwd = process.cwd();
        let logFilePath = path.resolve(cwd, ".opencode", "opencode-rag.log");
        const ctx = await resolveCliContext(options, logFilePath);
        const { store } = ctx;
        logFilePath = ctx.logFilePath;

        const files = await store.listFiles();

        if (files.length === 0) {
          logCliInfo(logFilePath, "list", `${c.warn("No indexed files found.")} Run 'opencode-rag index' first.`);
          await cleanupContext(ctx);
          return;
        }

        logCliInfo(logFilePath, "list", `\n${c.num(files.length)} file(s) indexed:\n`);
        for (const f of files) {
          logCliInfo(logFilePath, "list", `  ${c.file(f.filePath)}  ${c.label("(")}${c.lang(f.language)}${c.label(", ")}${c.num(f.chunkCount)} chunk${f.chunkCount === 1 ? "" : "s"}${c.label(")")}`);
        }
        await cleanupContext(ctx);
      } catch (err) {
        const message = (err as Error).message || String(err);
        const logFilePath = path.resolve(process.cwd(), ".opencode", "opencode-rag.log");
        logCliError(logFilePath, "list", `\nList failed: ${message}`, err);
        process.exit(1);
      }
    });
}
