/**
 * @fileoverview Status command showing index statistics, store health, manifest status, and configuration summary.
 */
/**
 * `status` command — shows index statistics, store health, and configuration summary.
 */

import type { Command } from "commander";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { c, resolveCliContext, cleanupContext, logCliError, logCliInfo, formatTimestamp } from "../format.js";
import { getIndexStatusSummary } from "../../indexer.js";
import { getPackageMetadata } from "../helpers.js";
import { checkForUpdate } from "../../core/version-check.js";
import type { CliOptions } from "../types.js";

/**
 * Check for a stale index.lock file and clean it up if the owning process is dead.
 *
 * An `index.lock` file is created by `runIndexPass` to prevent concurrent index
 * operations. If the process that created it has terminated (e.g. crash, Ctrl+C),
 * the lock becomes stale and must be removed before any new index pass can start.
 * This function also warns the user when a live index pass is detected.
 *
 * @param storePath - Path to the vector store directory.
 * @param logFilePath - Path to the debug log file for status output.
 */
function checkStaleLock(storePath: string, logFilePath: string): void {
  const lockPath = path.join(storePath, "index.lock");
  if (!fs.existsSync(lockPath)) return;

  try {
    const raw = fs.readFileSync(lockPath, "utf-8");
    const lock = JSON.parse(raw) as { pid?: number; startedAt?: number };

    if (lock.pid) {
      try {
        // Signal 0 tests whether the process exists without actually sending a signal.
        process.kill(lock.pid, 0);
        logCliInfo(logFilePath, "status", `\n${c.warn("⚠")} Index lock is held by running process ${c.num(lock.pid)} — status may be stale until it completes.`);
        return;
      } catch {
        // Process is dead — lock is stale
      }
    }

    logCliInfo(logFilePath, "status", `\n${c.warn("⚠")} Stale index.lock found (PID ${lock.pid ?? "unknown"} is no longer running) — removing it.`);
    fs.unlinkSync(lockPath);
  } catch {
    // Can't read or parse the lock file — not our concern, ignore silently
  }
}

/**
 * Register the `status` command on the given Commander program.
 *
 * Displays a comprehensive overview of the current index: chunk counts,
 * store path, embedding provider/model, file extensions, manifest status,
 * keyword index state, and whether a rebuild is required.
 *
 * @param program - The Commander `Command` instance to register on.
 */
export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show indexing status")
    .option("-c, --config <path>", "path to config file")
    .action(async (options: CliOptions) => {
      try {
        const cwd = process.cwd();
        let logFilePath = path.resolve(cwd, ".opencode", "opencode-rag.log");
        const ctx = await resolveCliContext(options, logFilePath, { skipProbe: true });
        const { config, store, storePath, keywordIndex } = ctx;
        logFilePath = ctx.logFilePath;

        checkStaleLock(storePath, logFilePath);

        const count = await store.count();
        const summary = await getIndexStatusSummary(
          cwd,
          storePath,
          config,
          store,
          true, // skipScan — don't walk the workspace tree, just use manifest stats
        );

        logCliInfo(logFilePath, "status", `\n${c.heading("Indexed chunks:")}    ${c.num(count)}`);
        logCliInfo(logFilePath, "status", `${c.label("Store path:")}        ${c.file(storePath)}`);
        logCliInfo(logFilePath, "status", `${c.label("Embedding provider:")} ${c.value(config.embedding.provider)}`);
        logCliInfo(logFilePath, "status", `${c.label("Embedding model:")}   ${c.value(config.embedding.model)}`);
        logCliInfo(logFilePath, "status", `${c.label("File extensions:")}   ${config.indexing.includeExtensions.join(", ")}`);
        logCliInfo(logFilePath, "status", `${c.label("Excluded dirs:")}     ${config.indexing.excludeDirs.join(", ")}`);
        logCliInfo(logFilePath, "status", `${c.label("Default top-K:")}     ${c.num(config.retrieval.topK)}`);
        logCliInfo(logFilePath, "status", `${c.label("Plugin enabled:")}    ${config.openCode.enabled ? c.enabled("yes") : c.disabled("no")}`);
        logCliInfo(logFilePath, "status", `${c.label("Manifest status:")}   ${summary.manifestStatus}`);
        logCliInfo(logFilePath, "status", `${c.label("Manifest entries:")}  ${c.num(summary.manifestEntries)}`);
        logCliInfo(logFilePath, "status", `${c.label("Last indexed:")}      ${c.value(formatTimestamp(summary.lastIndexedAt))}`);
        logCliInfo(logFilePath, "status", `${c.label("Up-to-date files:")}  ${c.num(summary.upToDateFiles)}`);
        logCliInfo(logFilePath, "status", `${c.label("Pending files:")}     ${c.num(summary.pendingFiles)}`);
        logCliInfo(logFilePath, "status", `${c.label("Indexed chunks:")}    ${c.num(summary.storeChunkCount)}`);
        logCliInfo(logFilePath, "status", `${c.label("Expected chunks:")}   ${c.num(summary.manifestExpectedChunks)}`);
        // Read watcher status from the background auto-indexer
        const watcherStatusPath = path.join(storePath, "watcher-status.json");
        let watchModeDisplay: string;
        if (fs.existsSync(watcherStatusPath)) {
          try {
            const raw = fs.readFileSync(watcherStatusPath, "utf-8");
            const ws = JSON.parse(raw) as { running?: boolean; lastRunAt?: number };
            if (ws.lastRunAt) {
              const lastRun = formatTimestamp(ws.lastRunAt);
              watchModeDisplay = ws.running
                ? c.enabled("active") + c.dim(" (last run: " + lastRun + ")")
                : c.enabled("on") + c.dim(" (last run: " + lastRun + ")");
            } else {
              watchModeDisplay = c.enabled("on");
            }
          } catch {
            watchModeDisplay = c.enabled("on") + c.dim(" (status unknown)");
          }
        } else if (config.openCode.autoIndex?.enabled) {
          watchModeDisplay = c.enabled("enabled (config)");
        } else {
          watchModeDisplay = c.dim("off");
        }
        logCliInfo(logFilePath, "status", `${c.label("Watch mode:")}        ${watchModeDisplay}`);
        const kiCount = config.retrieval.hybridSearch?.enabled
          ? keywordIndex?.count() ?? 0
          : 0;
        logCliInfo(logFilePath, "status", `${c.label("Keyword index:")}     ${config.retrieval.hybridSearch?.enabled ? c.enabled("enabled") : c.disabled("disabled")} (${c.num(kiCount)} chunks)`);
        if (summary.rebuildRequired) {
          logCliInfo(logFilePath, "status", `${c.label("Rebuild required:")}  ${c.warn("yes")} (manifest missing/corrupt)`);
        }
        if (summary.storeChunkCount > 0 && summary.manifestExpectedChunks > 0 && summary.storeChunkCount < summary.manifestExpectedChunks * 0.5) {
          logCliInfo(logFilePath, "status", `${c.label("Data loss detected:")} ${c.warn("yes")} — store has fewer chunks than expected. Run 'opencode-rag index' to rebuild.`);
        }

        // Version & runtime status
        const pkg = getPackageMetadata();
        logCliInfo(logFilePath, "status", `${c.label("Plugin version:")}    ${c.value(pkg.version)}`);

        const versionFilePath = path.join(os.homedir(), ".opencode", ".bundle-version");
        const runtimeDir = path.join(os.homedir(), ".opencode", "node_modules", "opencode-rag-plugin", "dist");
        const runtimeOk = fs.existsSync(runtimeDir);
        if (!runtimeOk) {
          logCliInfo(logFilePath, "status", `${c.label("Runtime:")}           ${c.warn("not set up — run `opencode-rag setup`")}`);
        } else {
          try {
            const installedVersion = fs.readFileSync(versionFilePath, "utf-8").trim();
            if (installedVersion !== pkg.version) {
              logCliInfo(logFilePath, "status", `${c.label("Runtime version:")}   ${c.warn(installedVersion)} ${c.dim("(sync with `opencode-rag setup`)")}`);
            } else {
              logCliInfo(logFilePath, "status", `${c.label("Runtime:")}           ${c.success("up-to-date")}`);
            }
          } catch {
            logCliInfo(logFilePath, "status", `${c.label("Runtime:")}           ${c.warn("version unknown — run `opencode-rag setup`")}`);
          }
        }

        // Async GitHub update check (fire-and-forget, 5s timeout)
        // Only phone home if autoUpdate is explicitly enabled (opt-in).
        if (config.autoUpdate?.enabled) {
          checkForUpdate(pkg.version).then((info) => {
            if (info.updateAvailable) {
              process.stdout.write(`  ${c.label("Update:")}            ${c.warn(`v${info.latestVersion} available — npm update -g opencode-rag-plugin`)}\n`);
            }
          }).catch(() => { /* ignore network errors */ });
        }

        await cleanupContext(ctx);
      } catch (err) {
        const message = (err as Error).message || String(err);
        const logFilePath = path.resolve(process.cwd(), ".opencode", "opencode-rag.log");
        logCliError(logFilePath, "status", `\nStatus check failed: ${message}`, err);
        process.exit(1);
      }
    });
}
