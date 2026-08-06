/**
 * @fileoverview Index command for incremental or full workspace file indexing into the vector database with watch mode support.
 */
/**
 * `index` command — indexes workspace files into the vector database.
 *
 * Supports incremental indexing (only changed files), full rebuilds (`--force`),
 * and watch mode (`--watch`) with chokidar-based file monitoring.
 * Watch mode suppresses all CLI output — logs to opencode-rag.log only.
 */

import type { Command } from "commander";
import path from "node:path";
import readline from "node:readline";
import chokidar from "chokidar";
import { appendDebugLog } from "../../core/fileLogger.js";
import {
  createWatchPassScheduler,
  createWatchIgnore,
  type IndexRunStats,
  runIndexPass,
} from "../../indexer.js";
import { tryAcquireWatcherLock, releaseWatcherLock } from "../../watcher.js";
import {
  c,
  resolveCliContext,
  cleanupContext,
  logCliError,
  logCliInfo,
  logIndexSummary,
  formatDuration,
} from "../format.js";
import type { CliOptions } from "../types.js";

/**
 * Build a logger that suppresses console output when watchTriggered is true.
 */
function watchAwareLogger(logFilePath: string, scope: string, watchTriggered: boolean) {
  return {
    info: (message: string) => {
      if (!watchTriggered) console.log(message);
      appendDebugLog(logFilePath, { scope, message });
    },
    warn: (message: string) => {
      if (!watchTriggered) console.warn(message);
      appendDebugLog(logFilePath, { scope, message: `WARN: ${message}` });
    },
    debug: (message: string) => {
      appendDebugLog(logFilePath, { scope, message: `DEBUG: ${message}`, severity: "debug" });
    },
  };
}

/**
 * Register the `index` command on the given Commander program.
 *
 * Scans the workspace, chunks changed/new files, generates embeddings,
 * and stores vectors in LanceDB. In watch mode, monitors file changes
 * via chokidar and triggers debounced re-indexing.
 *
 * @param program - The Commander `Command` instance to register on.
 */
export function registerIndexCommand(program: Command): void {
  program
    .command("index")
    .description("Index workspace files")
    .option("-c, --config <path>", "path to config file")
    .option("-f, --force", "force full re-index")
    .option("-y, --yes", "skip confirmation prompt for full rebuild")
    .option("-w, --watch", "watch workspace and incrementally re-index on changes")
    .action(async (options: CliOptions) => {
      const started = Date.now();

      try {
        const cwd = process.cwd();
        let logFilePath = path.resolve(cwd, ".opencode", "opencode-rag.log");
        const ctx = await resolveCliContext(options, logFilePath);
        const { config, embedder, store, storePath, keywordIndex, descriptionProvider, dimension } = ctx;
        logFilePath = ctx.logFilePath;

        // ── Abort controller for graceful Ctrl+C during the initial pass ──
        const abortController = new AbortController();
        let sigReceived = false;

        const handleSigint = () => {
          if (sigReceived) {
            console.error("\nForce exiting...");
            cleanupContext(ctx).finally(() => process.exit(130));
            return;
          }
          sigReceived = true;
          abortController.abort();
        };
        process.on("SIGINT", handleSigint);
        process.on("SIGTERM", handleSigint);

        logCliInfo(logFilePath, "index", `\n${c.heading("Indexing workspace...")}`);
        logCliInfo(logFilePath, "index", `  ${c.label("Vector dimension:")}   ${c.num(dimension)}`);
        if (descriptionProvider) {
          const descriptionConfig = config.description ?? { provider: "ollama" as const, model: "qwen2.5:3b" };
          logCliInfo(logFilePath, "index", `  ${c.label("Description LLM:")}  ${c.value(descriptionConfig.model)} (${descriptionConfig.provider})`);
        }

        // ── Prompt for confirmation when --force would destroy existing data ──
        if (options.force && !options.yes) {
          const prevCount = await store.count();
          if (prevCount > 0) {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const answer = await new Promise<string>((resolve) => {
              rl.question(`Delete ${c.num(prevCount)} existing chunks and re-index everything? [y/N] `, resolve);
            });
            rl.close();
            const trimmed = answer.trim().toLowerCase();
            if (trimmed !== "y" && trimmed !== "yes") {
              logCliInfo(logFilePath, "index", c.warn("Force rebuild cancelled."));
              await cleanupContext(ctx);
              process.exit(0);
            }
          }
        }

        logCliInfo(logFilePath, "index", `${c.label("Scanning:")} ${c.file(cwd)}`);
        const runPass = async (
          watchTriggered: boolean = false,
          abortSignal?: AbortSignal,
          filterPaths?: string[],
        ): Promise<IndexRunStats> => {
          const passStarted = Date.now();
          const stats = await runIndexPass({
            cwd,
            storePath,
            config,
            store,
            embedder,
            keywordIndex,
            descriptionProvider,
            force: !!(options.force && !watchTriggered),
            abortSignal,
            dimension,
            filterPaths,
            logger: watchAwareLogger(logFilePath, watchTriggered ? "watch" : "index", watchTriggered),
          });

          if (!watchTriggered) {
            logIndexSummary(logFilePath, stats);
            logCliInfo(
              logFilePath,
              "index",
              `\n${c.success("Indexing complete.")} ${c.num(stats.finalCount)} chunks stored (${formatDuration(Date.now() - passStarted)}).`
            );
          }

          if (sigReceived && !watchTriggered) {
            logCliInfo(logFilePath, "index", `\n${c.warn("Indexing was interrupted.")} ${c.num(stats.finalCount)} chunks saved. Run again to index remaining files.`);
          }

          return stats;
        };

        await runPass(false, abortController.signal);

        process.removeListener("SIGINT", handleSigint);
        process.removeListener("SIGTERM", handleSigint);

        if (!options.watch) {
          await cleanupContext(ctx);
          process.exit(sigReceived ? 130 : 0);
        }

        // Only one watcher may run per workspace — a background auto-indexer
        // in an OpenCode session (or another `index --watch`) may already own
        // this store. The initial pass above still ran; just don't start a
        // duplicate watcher.
        if (!tryAcquireWatcherLock(storePath)) {
          logCliInfo(
            logFilePath,
            "index",
            c.warn("Another watcher is already running for this workspace (e.g. an OpenCode session with auto-index enabled) — not starting a second one. The index is up to date.")
          );
          await cleanupContext(ctx);
          process.exit(0);
        }

        logCliInfo(logFilePath, "index", `\n${c.heading("Watching for changes...")}`);
        const scheduler = createWatchPassScheduler(
          async (changedPaths?: string[]): Promise<void> => { await runPass(true, undefined, changedPaths); },
          (error) => {
            const message = (error as Error).message || String(error);
            logCliError(logFilePath, "watch", `\nWatch reindex failed: ${message}`, error);
          },
          300,
        );

        const watcher = chokidar.watch(cwd, {
          ignored: createWatchIgnore(cwd, config, storePath),
          ignoreInitial: true,
          persistent: true,
        });

        watcher.on("add", (filePath: string) => scheduler.notifyChange([filePath]));
        watcher.on("change", (filePath: string) => scheduler.notifyChange([filePath]));
        watcher.on("unlink", (filePath: string) => scheduler.notifyChange([filePath]));
        watcher.on("unlinkDir", (filePath: string) => scheduler.notifyChange([filePath]));
        watcher.on("addDir", (filePath: string) => scheduler.notifyChange([filePath]));
        watcher.on("error", (error) => {
          logCliError(logFilePath, "watch", `Watcher error: ${(error as Error).message}`, error);
        });

        const shutdown = async () => {
          scheduler.close();
          await scheduler.waitForIdle();
          await Promise.race([
            watcher.close(),
            new Promise((r) => setTimeout(r, 5000)),
          ]);
          releaseWatcherLock(storePath);
          await cleanupContext(ctx);
          process.exit(0);
        };

        process.once("SIGINT", () => void shutdown());
        process.once("SIGTERM", () => void shutdown());

        const duration = formatDuration(Date.now() - started);
        logCliInfo(logFilePath, "index", `${c.success("Watcher ready")} (${duration} startup). Press Ctrl+C to stop.`);
      } catch (err) {
        const message = (err as Error).message || String(err);
        const logFilePath = path.resolve(process.cwd(), ".opencode", "opencode-rag.log");
        logCliError(logFilePath, "index", `\nIndexing failed: ${message}`, err);
        if (message.toLowerCase().includes("fetch") || message.toLowerCase().includes("econnrefused")) {
          console.error(c.warn("Hint: Is your embedding provider running?"));
        }
        process.exit(1);
      }
    });
}
