/**
 * @fileoverview Clear command to remove all indexed chunk data from the vector store with confirmation prompt.
 */
/**
 * `clear` command — removes all indexed vector data from the workspace.
 */

import type { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { c, resolveCliContext, cleanupContext, logCliError, logCliInfo } from "../format.js";
import { manifestPathFor } from "../../core/manifest.js";
import { indexPathFor } from "../../retriever/keyword-index.js";
import type { CliOptions } from "../types.js";

/**
 * Prompt the user for a yes/no answer via the terminal.
 * Returns `true` for "y", `false` for "n", and `undefined` on EOF.
 */
async function confirmPrompt(question: string): Promise<boolean | undefined> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${question} [y/N] `, resolve);
    });
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === "y" || trimmed === "yes") return true;
    if (trimmed === "n" || trimmed === "no") return false;
    return trimmed === "" ? false : undefined;
  } finally {
    rl.close();
  }
}

/**
 * Register the `clear` command on the given Commander program.
 *
 * Clears all indexed chunks from the vector store with a confirmation prompt.
 *
 * @param program - The Commander `Command` instance to register on.
 */
export function registerClearCommand(program: Command): void {
  program
    .command("clear")
    .description("Clear all indexed data")
    .option("-c, --config <path>", "path to config file")
    .option("-y, --yes", "skip confirmation prompt")
    .action(async (options: CliOptions) => {
      try {
        const cwd = process.cwd();
        let logFilePath = path.resolve(cwd, ".opencode", "opencode-rag.log");
        const ctx = await resolveCliContext(options, logFilePath);
        const { store } = ctx;
        logFilePath = ctx.logFilePath;

        const prevCount = await store.count();

        if (prevCount === 0) {
          logCliInfo(logFilePath, "clear", c.warn("No indexed data to clear."));
          await cleanupContext(ctx);
          return;
        }

        if (!options.yes) {
          const ok = await confirmPrompt(
            `Clear all ${c.num(prevCount)} indexed chunks? This cannot be undone.`,
          );
          if (!ok) {
            logCliInfo(logFilePath, "clear", c.warn("Clear cancelled."));
            await cleanupContext(ctx);
            return;
          }
        }

        logCliInfo(logFilePath, "clear", `${c.label("Clearing")} ${c.num(prevCount)} indexed chunks...`);
        await store.clear();

        // Trust, but verify: an interrupted clear used to leave the store AND
        // the manifest completely untouched while printing nothing after the
        // "Clearing…" line. Only drop the manifest/keyword index once the
        // table is provably empty, so a failed clear cannot desynchronise them.
        let remaining: number;
        try {
          remaining = await store.count();
        } catch (err) {
          logCliError(
            logFilePath,
            "clear",
            `\nClear could not be verified: ${(err as Error).message}. Manifest and keyword index were left in place.`,
            err,
          );
          await cleanupContext(ctx);
          process.exit(1);
        }
        if (remaining > 0) {
          logCliError(
            logFilePath,
            "clear",
            `\nClear incomplete: ${remaining} of ${prevCount} chunks are still stored (interrupted, or the store is held open by another process). Manifest and keyword index were left in place.`,
          );
          await cleanupContext(ctx);
          process.exit(1);
        }

        await fs.unlink(manifestPathFor(ctx.storePath)).catch(() => {});
        await fs.unlink(indexPathFor(ctx.storePath)).catch(() => {});
        logCliInfo(
          logFilePath,
          "clear",
          `${c.success("Done.")} vector database cleared (was ${c.num(prevCount)} chunks); manifest and keyword index removed.`,
        );
        await cleanupContext(ctx);
      } catch (err) {
        const message = (err as Error).message || String(err);
        const logFilePath = path.resolve(process.cwd(), ".opencode", "opencode-rag.log");
        logCliError(logFilePath, "clear", `\nClear failed: ${message}`, err);
        process.exit(1);
      }
    });
}
