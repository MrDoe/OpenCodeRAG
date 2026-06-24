import type { Command } from "commander";
import path from "node:path";
import { c, resolveCliContext, cleanupContext, logCliError, logCliInfo, formatDuration } from "../format.js";
import type { CliOptions } from "../types.js";
import { runDocMode, runDocModeForFiles } from "../../doc-generator/batch.js";
import type { DocOptions } from "../../doc-generator/types.js";

interface DocCommandOptions extends CliOptions {
  dryRun?: boolean;
  reset?: boolean;
  file?: string[];
  concurrency?: string;
  style?: string;
}

function createDocOptions(args: {
  worktree: string;
  storePath: string;
  dryRun: boolean;
  style: string;
  concurrency: number;
  descriptionProvider: { provider: string; model: string; baseUrl: string; apiKey?: string };
  docMode: {
    batchSize: number;
    skipExisting: boolean;
    includeExtensions: string[];
    excludeDirs: string[];
    systemPrompt: string;
  };
}): DocOptions {
  return {
    style: args.style === "jsdoc" ? "jsdoc" : "google",
    batchSize: args.docMode.batchSize,
    concurrency: args.concurrency,
    skipExisting: args.docMode.skipExisting,
    includeExtensions: args.docMode.includeExtensions,
    excludeDirs: args.docMode.excludeDirs,
    provider: args.descriptionProvider.provider,
    model: args.descriptionProvider.model,
    baseUrl: args.descriptionProvider.baseUrl,
    apiKey: args.descriptionProvider.apiKey,
    systemPrompt: args.docMode.systemPrompt,
    dryRun: args.dryRun,
    storePath: args.storePath,
    worktree: args.worktree,
  };
}

export function registerDocCommand(program: Command): void {
  program
    .command("doc")
    .description("Document code files using LLM-powered Google JSDoc generation")
    .option("-c, --config <path>", "path to config file")
    .option("--dry-run", "show what would be documented without making changes")
    .option("--reset", "reset documentation progress and start fresh")
    .option("--file <path...>", "specific files to document (can be repeated)")
    .option("--concurrency <n>", "number of files to process in parallel", "4")
    .option("--style <style>", "documentation style: google or jsdoc", "google")
    .action(async (options: DocCommandOptions) => {
      const started = Date.now();

      try {
        const cwd = process.cwd();
        let logFilePath = path.resolve(cwd, ".opencode", "opencode-rag.log");
        const ctx = await resolveCliContext(options, logFilePath);
        const { config } = ctx;
        logFilePath = ctx.logFilePath;

        const storePath = path.resolve(cwd, config.vectorStore.path);

        if (options.reset) {
          const { saveDocProgress } = await import("../../core/doc-progress.js");
          saveDocProgress(storePath, { documented: [], fileDetails: {}, lastUpdated: 0 });
          logCliInfo(logFilePath, "doc", `${c.warn("Documentation progress reset.")}`);
        }

        const docCfg = config.documentationMode;
        if (!docCfg?.enabled) {
          logCliError(logFilePath, "doc", `${c.error("Documentation mode is not enabled in config. Set documentationMode.enabled to true.")}`, undefined);
          process.exit(1);
        }

        const descCfg = config.description;
        if (!descCfg?.enabled) {
          logCliError(logFilePath, "doc", `${c.error("No description provider configured. Set description.enabled to true.")}`, undefined);
          process.exit(1);
        }

        const style = options.style === "jsdoc" ? "jsdoc" : "google";
        const concurrency = Math.max(1, parseInt(options.concurrency ?? "4", 10) || 4);

        const docOptions = createDocOptions({
          worktree: cwd,
          storePath,
          dryRun: options.dryRun ?? false,
          style,
          concurrency,
          descriptionProvider: {
            provider: descCfg.provider,
            model: descCfg.model,
            baseUrl: descCfg.baseUrl,
            apiKey: descCfg.apiKey,
          },
          docMode: {
            batchSize: docCfg.batchSize,
            skipExisting: docCfg.skipExisting,
            includeExtensions: docCfg.includeExtensions,
            excludeDirs: docCfg.excludeDirs,
            systemPrompt: docCfg.systemPrompt,
          },
        });

        logCliInfo(logFilePath, "doc", `\n${c.heading("Documentation mode")}`);
        logCliInfo(logFilePath, "doc", `  ${c.label("Style:")}       ${c.value(style)}`);
        logCliInfo(logFilePath, "doc", `  ${c.label("Concurrency:")} ${c.num(concurrency)}`);
        logCliInfo(logFilePath, "doc", `  ${c.label("Dry run:")}     ${options.dryRun ? c.warn("yes") : c.value("no")}`);
        logCliInfo(logFilePath, "doc", `  ${c.label("Provider:")}    ${c.value(docOptions.provider)}`);
        logCliInfo(logFilePath, "doc", `  ${c.label("Model:")}       ${c.value(docOptions.model)}`);

        let progress;
        if (options.file && options.file.length > 0) {
          const filePaths = options.file.map((f: string) => path.resolve(cwd, f));
          logCliInfo(logFilePath, "doc", `  ${c.label("Files:")}       ${filePaths.length} specified`);
          progress = await runDocModeForFiles(filePaths, { options: docOptions });
        } else {
          logCliInfo(logFilePath, "doc", `  ${c.label("Workspace:")}   ${c.file(cwd)}`);
          progress = await runDocMode({
            options: docOptions,
            onProgress: (p) => {
              process.stdout.write(`\r${c.label("Progress:")} ${p.completed}/${p.total} files (${p.documented} documented, ${p.skipped} skipped, ${p.failed} failed)`);
            },
          });
        }

        process.stdout.write("\n");
        logCliInfo(logFilePath, "doc", `\n${c.heading("Documentation complete")}`);
        logCliInfo(logFilePath, "doc", `  ${c.label("Total:")}       ${c.num(progress.total)}`);
        logCliInfo(logFilePath, "doc", `  ${c.label("Documented:")}  ${c.value(String(progress.documented))}`);
        logCliInfo(logFilePath, "doc", `  ${c.label("Skipped:")}     ${c.dim(String(progress.skipped))}`);
        logCliInfo(logFilePath, "doc", `  ${c.label("Failed:")}      ${progress.failed > 0 ? c.error(String(progress.failed)) : c.num("0")}`);
        logCliInfo(logFilePath, "doc", `  ${c.label("Duration:")}    ${c.dim(formatDuration(Date.now() - started))}`);

        if (progress.errors.length > 0) {
          logCliInfo(logFilePath, "doc", `\n${c.warn("Errors:")}`);
          for (const err of progress.errors.slice(0, 10)) {
            logCliInfo(logFilePath, "doc", `  ${c.error("✗")} ${err}`);
          }
          if (progress.errors.length > 10) {
            logCliInfo(logFilePath, "doc", `  ... and ${progress.errors.length - 10} more`);
          }
        }

        await cleanupContext(ctx);
        process.exit(0);
      } catch (err) {
        const message = (err as Error).message || String(err);
        const logFilePath = path.resolve(process.cwd(), ".opencode", "opencode-rag.log");
        logCliError(logFilePath, "doc", `\nDocumentation failed: ${message}`, err);
        process.exit(1);
      }
    });
}
