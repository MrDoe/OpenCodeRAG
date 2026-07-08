/**
 * @fileoverview Show command displaying all chunks for a specific indexed file with line ranges and content.
 */
/**
 * `show` command — displays chunks for a specific indexed file.
 */

import type { Command } from "commander";
import path from "node:path";
import pc from "picocolors";
import { c, resolveCliContext, cleanupContext, logCliError, logCliInfo } from "../format.js";
import type { CliOptions } from "../types.js";

/**
 * Register the `show <file>` command on the given Commander program.
 *
 * Looks up all chunks matching the given file path and prints their line ranges,
 * language, description, and content.
 *
 * @param program - The Commander `Command` instance to register on.
 */
export function registerShowCommand(program: Command): void {
  program
    .command("show <file>")
    .description("Show chunks for a specific file")
    .option("-c, --config <path>", "path to config file")
    .action(async (file: string, options: CliOptions) => {
      try {
        const cwd = process.cwd();
        let logFilePath = path.resolve(cwd, ".opencode", "opencode-rag.log");
        const ctx = await resolveCliContext(options, logFilePath);
        const { store } = ctx;
        logFilePath = ctx.logFilePath;

        const chunks = await store.getChunksByFilePath(file);

        if (chunks.length === 0) {
          logCliInfo(logFilePath, "show", `${c.warn(`No chunks found for '${file}'.`)}`);
          await cleanupContext(ctx);
          return;
        }

        logCliInfo(logFilePath, "show", `\n${c.num(chunks.length)} chunk(s) for ${c.file(file)}:\n`);
        for (const chunk of chunks) {
          logCliInfo(logFilePath, "show", `  ${c.label("[")}${c.value(String(chunk.metadata.startLine))}${c.label("-")}${c.value(String(chunk.metadata.endLine))}${c.label("]")} ${c.label("(")}${c.lang(chunk.metadata.language)}${c.label(")")} ${pc.dim(chunk.id)}`);
          if (chunk.description) {
            logCliInfo(logFilePath, "show", `  ${c.desc(">")} ${c.desc(chunk.description)}`);
          }
          logCliInfo(logFilePath, "show", `  ${chunk.content}\n`);
        }
        await cleanupContext(ctx);
      } catch (err) {
        const message = (err as Error).message || String(err);
        const logFilePath = path.resolve(process.cwd(), ".opencode", "opencode-rag.log");
        logCliError(logFilePath, "show", `\nShow failed: ${message}`, err);
        process.exit(1);
      }
    });
}
