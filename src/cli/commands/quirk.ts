/**
 * @fileoverview Quirk command — manage experiential agent memory (add, list, rm, lint).
 */
import type { Command } from "commander";
import { resolveCliContext, cleanupContext, logCliInfo, logCliError, c } from "../format.js";
import { addQuirk, listQuirks, lintQuirks, recallQuirks, removeQuirk } from "../../quirks/quirk-store.js";

/**
 * Register the `quirk` command on the given Commander program.
 *
 * @param program - The Commander `Command` instance to register on.
 */
export function registerQuirkCommand(program: Command): void {
  const quirkCmd = program
    .command("quirk")
    .description("Manage experiential quirk memory (gotchas, preferences, decisions, constraints)");

  quirkCmd
    .command("add")
    .description("Add a new quirk")
    .argument("<content>", "quirk text")
    .option("-t, --type <type>", "quirk type: gotcha, preference, decision, environment-constraint")
    .option("--tag <tags...>", "tags for filtering")
    .option("--source-ref <path>", "source file path reference")
    .action(async (content: string, options: Record<string, string | string[] | undefined>) => {
      try {
        const ctx = await resolveCliContext(options, resolveLogPath());
        const { config, embedder, store, keywordIndex } = ctx;

        const quirk = await addQuirk(
          { embedder, store, keywordIndex: keywordIndex!, cfg: config, storePath: ctx.storePath },
          {
            content,
            quirkType: options.type as string | undefined,
            tags: options.tag ? (Array.isArray(options.tag) ? options.tag : [options.tag as string]) : undefined,
            sourceRef: options.sourceRef as string | undefined,
          },
        );

        logCliInfo(ctx.logFilePath, "quirk add", `\n${c.success("Quirk added:")}`);
        logCliInfo(ctx.logFilePath, "quirk add", `  ${c.label("ID:")} ${quirk.id}`);
        logCliInfo(ctx.logFilePath, "quirk add", `  ${c.label("Type:")} ${quirk.quirkType ?? "general"}`);
        logCliInfo(ctx.logFilePath, "quirk add", `  ${c.label("Confidence:")} ${(quirk.confidence * 100).toFixed(0)}%`);
        await cleanupContext(ctx);
      } catch (err) {
        logCliError(resolveLogPath(), "quirk add", `Failed to add quirk: ${(err as Error).message}`, err);
        process.exit(1);
      }
    });

  quirkCmd
    .command("list")
    .description("List all quirks")
    .option("-c, --config <path>", "path to config file")
    .action(async (options: Record<string, string | undefined>) => {
      try {
        const ctx = await resolveCliContext(options, resolveLogPath());
        const { config, embedder, store, keywordIndex } = ctx;
        const quirks = await listQuirks({ embedder, store, keywordIndex: keywordIndex!, cfg: config, storePath: ctx.storePath });

        logCliInfo(ctx.logFilePath, "quirk list", `\n${c.num(quirks.length)} quirk(s):\n`);
        for (const q of quirks) {
          const badge = q.quirkType ? `[${q.quirkType}] ` : "";
          const tags = q.tags.length > 0 ? ` (${q.tags.join(", ")})` : "";
          const date = q.lastObserved ? new Date(q.lastObserved).toLocaleDateString() : "";
          logCliInfo(ctx.logFilePath, "quirk list", `  ${c.value(badge)}${c.file(q.content.slice(0, 120))}${c.dim(tags)} ${c.dim(date)}`);
        }
        await cleanupContext(ctx);
      } catch (err) {
        logCliError(resolveLogPath(), "quirk list", `Failed to list quirks: ${(err as Error).message}`, err);
        process.exit(1);
      }
    });

  quirkCmd
    .command("rm")
    .description("Remove a quirk by ID")
    .argument("<id>", "quirk ID")
    .option("-c, --config <path>", "path to config file")
    .action(async (id: string, options: Record<string, string | undefined>) => {
      try {
        const ctx = await resolveCliContext(options, resolveLogPath());
        const { config, embedder, store, keywordIndex } = ctx;
        await removeQuirk({ embedder, store, keywordIndex: keywordIndex!, cfg: config, storePath: ctx.storePath }, id);
        logCliInfo(ctx.logFilePath, "quirk rm", `\n${c.success("Quirk removed:")} ${id}`);
        await cleanupContext(ctx);
      } catch (err) {
        logCliError(resolveLogPath(), "quirk rm", `Failed to remove quirk: ${(err as Error).message}`, err);
        process.exit(1);
      }
    });

  quirkCmd
    .command("lint")
    .description("Health-check quirks (low confidence, stale, duplicates)")
    .option("-c, --config <path>", "path to config file")
    .action(async (options: Record<string, string | undefined>) => {
      try {
        const ctx = await resolveCliContext(options, resolveLogPath());
        const { config, embedder, store, keywordIndex } = ctx;
        const issues = await lintQuirks({ embedder, store, keywordIndex: keywordIndex!, cfg: config, storePath: ctx.storePath });

        if (issues.length === 0) {
          logCliInfo(ctx.logFilePath, "quirk lint", c.success("\nNo issues found. All quirks look healthy."));
        } else {
          logCliInfo(ctx.logFilePath, "quirk lint", `\n${c.warn(`${issues.length} issue(s) found:`)}\n`);
          for (const issue of issues) {
            logCliInfo(ctx.logFilePath, "quirk lint", `  • ${issue}`);
          }
        }
        await cleanupContext(ctx);
      } catch (err) {
        logCliError(resolveLogPath(), "quirk lint", `Failed to lint quirks: ${(err as Error).message}`, err);
        process.exit(1);
      }
    });

  quirkCmd
    .command("test")
    .description("Test whether a quirk with similar content already exists")
    .argument("<content>", "quirk text to test")
    .option("-c, --config <path>", "path to config file")
    .action(async (content: string, options: Record<string, string | undefined>) => {
      try {
        const ctx = await resolveCliContext(options, resolveLogPath());
        const { config, embedder, store, keywordIndex } = ctx;

        const results = await recallQuirks(
          { embedder, store, keywordIndex: keywordIndex!, cfg: config, storePath: ctx.storePath },
          content,
          { topK: 5 },
        );

        if (results.length > 0) {
          logCliInfo(ctx.logFilePath, "quirk test", c.success("\n✓ Quirk has been appended:\n"));
          for (const r of results) {
            const badge = r.chunk.metadata.quirkType ? `[${r.chunk.metadata.quirkType}] ` : "";
            const tags = r.chunk.metadata.tags?.length ? ` (${r.chunk.metadata.tags.join(", ")})` : "";
            const confidence = r.chunk.metadata.confidence ? `${(r.chunk.metadata.confidence * 100).toFixed(0)}% confidence` : "";
            logCliInfo(ctx.logFilePath, "quirk test", `  ${c.value(badge)}${c.file(r.chunk.content.slice(0, 120))}${c.dim(tags)}`);
            logCliInfo(ctx.logFilePath, "quirk test", `  ${c.dim(confidence)}`);
            logCliInfo(ctx.logFilePath, "quirk test", "");
          }
        } else {
          logCliInfo(ctx.logFilePath, "quirk test", c.warn("\n✗ No matching quirk found — quirk has not been appended\n"));
        }

        await cleanupContext(ctx);
      } catch (err) {
        logCliError(resolveLogPath(), "quirk test", `Failed to test quirk: ${(err as Error).message}`, err);
        process.exit(1);
      }
    });
}

function resolveLogPath(): string {
  return "./.opencode/opencode-rag.log";
}
