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
import { c, resolveCliContext, logCliError, logCliInfo, formatTimestamp, formatRelativeAge } from "../format.js";
import { getIndexStatusSummary } from "../../indexer.js";
import { findKeywordIndexGaps } from "../../indexer/keyword-rehydration.js";
import { deriveWatcherHealth, discoverWatcherStates, type WatcherStatus } from "../../watcher.js";
import { getPackageMetadata } from "../helpers.js";
import { checkForUpdate } from "../../core/version-check.js";
import { deriveNamespace, sanitizeNamespace } from "../../vectorstore/clickhouse.js";
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
    .option("--quick", "skip the workspace scan (Up-to-date/Pending files are then unknown, not zero)")
    .action(async (options: CliOptions) => {
      try {
        const cwd = process.cwd();
        let logFilePath = path.resolve(cwd, ".opencode", "opencode-rag.log");
        const ctx = await resolveCliContext(options, logFilePath, { skipProbe: true });
        const { config, store, storePath, keywordIndex } = ctx;
        logFilePath = ctx.logFilePath;

        checkStaleLock(storePath, logFilePath);

        const count = await store.count();
        // Scan by default: a skipped scan used to print "Up-to-date files: 0 /
        // Pending files: 0" — two numbers that were never computed. With
        // --quick the summary's `scanned` flag makes the display say so.
        const summary = await getIndexStatusSummary(
          cwd,
          storePath,
          config,
          store,
          options.quick === true,
        );

        logCliInfo(logFilePath, "status", `\n${c.heading("Indexed chunks:")}    ${c.num(count)}`);
        const provider = config.vectorStore.provider ?? "lancedb";
        if (provider === "clickhouse") {
          const ch = config.vectorStore.clickhouse;
          const namespace = ch?.namespace?.trim()
            ? sanitizeNamespace(ch.namespace)
            : deriveNamespace(cwd);
          const annMode = ch?.ann === "hnsw" ? "hnsw ANN" : "exact scans";
          logCliInfo(
            logFilePath,
            "status",
            `${c.label("Vector store:")}      ${c.value("clickhouse")} ${c.file(`${ch?.url ?? ""}/${ch?.database ?? ""}`)} ` +
            `(namespace ${c.value(namespace)}, ${annMode})`,
          );
          if (ch?.ann === "hnsw") {
            const hasIndex = (store as unknown as { hasVectorIndex?: () => Promise<boolean> }).hasVectorIndex;
            if (hasIndex) {
              const present = await hasIndex.call(store).catch(() => false);
              logCliInfo(
                logFilePath,
                "status",
                `${c.label("ANN index:")}       ${present ? c.success("present") : c.warn("missing")} (vector_similarity)`,
              );
            }
          }
          logCliInfo(logFilePath, "status", `${c.label("Local cache:")}       ${c.file(storePath)} (disposable)`);
          try {
            const lease = await store.getLease?.("index");
            if (lease) {
              logCliInfo(
                logFilePath,
                "status",
                `${c.label("Index lease:")}       ${c.value(lease.owner)} (expires ${formatTimestamp(lease.expiresAt)})`,
              );
            }
          } catch {
            // lease diagnostics are best effort
          }
        } else {
          logCliInfo(logFilePath, "status", `${c.label("Store path:")}        ${c.file(storePath)}`);
        }
        logCliInfo(logFilePath, "status", `${c.label("Embedding provider:")} ${c.value(config.embedding.provider)}`);
        logCliInfo(logFilePath, "status", `${c.label("Embedding model:")}   ${c.value(config.embedding.model)}`);
        const storeDimension = await store.getVectorDimension?.();
        const embedderDimension = config.embedding.vectorDimension;
        if (embedderDimension && embedderDimension > 0) {
          logCliInfo(logFilePath, "status", `${c.label("Embedder dim:")}      ${c.num(embedderDimension)}`);
        }
        if (storeDimension !== undefined) {
          logCliInfo(logFilePath, "status", `${c.label("Store dimension:")}   ${c.num(storeDimension)}`);
        }
        if (
          storeDimension !== undefined &&
          embedderDimension !== undefined &&
          embedderDimension > 0 &&
          storeDimension !== embedderDimension
        ) {
          logCliInfo(
            logFilePath,
            "status",
            `${c.label("Dimension mismatch:")} ${c.warn("yes")} — the store was built with a different embedding model. Run 'opencode-rag index' to rebuild.`,
          );
        }
        logCliInfo(logFilePath, "status", `${c.label("File extensions:")}   ${config.indexing.includeExtensions.join(", ")}`);
        logCliInfo(logFilePath, "status", `${c.label("Excluded dirs:")}     ${config.indexing.excludeDirs.join(", ")}`);
        logCliInfo(logFilePath, "status", `${c.label("Default top-K:")}     ${c.num(config.retrieval.topK)}`);
        logCliInfo(logFilePath, "status", `${c.label("Plugin enabled:")}    ${config.openCode.enabled ? c.enabled("yes") : c.disabled("no")}`);
        logCliInfo(logFilePath, "status", `${c.label("Manifest status:")}   ${summary.manifestStatus}`);
        logCliInfo(logFilePath, "status", `${c.label("Manifest entries:")}  ${c.num(summary.manifestEntries)}`);
        logCliInfo(logFilePath, "status", `${c.label("Last indexed:")}      ${c.value(formatTimestamp(summary.lastIndexedAt))}`);
        if (summary.scanned) {
          logCliInfo(logFilePath, "status", `${c.label("Up-to-date files:")}  ${c.num(summary.upToDateFiles)}`);
          logCliInfo(logFilePath, "status", `${c.label("Pending files:")}     ${c.num(summary.pendingFiles)}`);
        } else {
          logCliInfo(logFilePath, "status", `${c.label("Up-to-date files:")}  ${c.dim("n/a (not scanned)")}`);
          logCliInfo(logFilePath, "status", `${c.label("Pending files:")}     ${c.dim("n/a (not scanned — rerun without --quick)")}`);
        }
        logCliInfo(logFilePath, "status", `${c.label("Indexed chunks:")}    ${c.num(summary.storeChunkCount)}`);
        logCliInfo(logFilePath, "status", `${c.label("Expected chunks:")}   ${c.num(summary.manifestExpectedChunks)}`);
        logCliInfo(logFilePath, "status", `${c.label("Orphan chunks:")}    ${c.num(summary.orphanChunks)}`);
        if (summary.quirkChunks !== undefined) {
          // Quirk rows are owned by quirks.jsonl — count them so
          // Indexed = Expected + Orphan + Quirk reconciles and the reader can
          // tell a sweepable orphan from a legitimately owned row.
          logCliInfo(logFilePath, "status", `${c.label("Quirk chunks:")}     ${c.num(summary.quirkChunks)} ${c.dim("(owned by quirks.jsonl)")}`);
        }
        if (summary.orphanChunks > 0) {
          logCliInfo(
            logFilePath,
            "status",
            `${c.label("Unaccounted rows:")}  ${c.warn("yes")} — stored chunks no manifest entry owns (files whose embedding never completed). Run 'opencode-rag index' to sweep them.`,
          );
        }
        // Read watcher status from the background auto-indexer. The watcher
        // writes into ITS OWN store dir, so also discover watchers running in
        // other store dirs (a plugin whose store was changed under it after
        // load keeps watching elsewhere — this is where that shows up).
        const watcherStatusPath = path.join(storePath, "watcher-status.json");
        let watchModeDisplay: string;
        let watcherWarning: string | undefined;
        if (fs.existsSync(watcherStatusPath)) {
          try {
            const ws = JSON.parse(fs.readFileSync(watcherStatusPath, "utf-8")) as WatcherStatus;
            const lastRun = ws.lastSuccessAt ?? ws.lastRunAt;
            if (lastRun) {
              const runLabel = ws.lastSuccessAt ? "last successful run" : "last run";
              watchModeDisplay = `${ws.running ? c.enabled("active") : c.enabled("on")} ${c.dim(`(${runLabel}: ${formatTimestamp(lastRun)}, ${formatRelativeAge(lastRun)})`)}`;
            } else {
              watchModeDisplay = c.enabled("on");
            }
            const health = deriveWatcherHealth(ws);
            if (health.stale) watcherWarning = health.reason;
          } catch {
            watchModeDisplay = c.enabled("on") + c.dim(" (status unknown)");
          }
        } else if (config.openCode.autoIndex?.enabled) {
          watchModeDisplay = c.enabled("enabled (config)");
        } else {
          watchModeDisplay = c.dim("off");
        }
        logCliInfo(logFilePath, "status", `${c.label("Watch mode:")}        ${watchModeDisplay}`);
        if (watcherWarning) {
          logCliInfo(
            logFilePath,
            "status",
            `${c.label("Watcher health:")}   ${c.warn(`stale — ${watcherWarning}`)} ${c.dim("(run 'opencode-rag index' or check .opencode/opencode-rag.log)")}`,
          );
        }
        try {
          const others = discoverWatcherStates(storePath, cwd).filter(
            (w) => path.resolve(w.storePath) !== path.resolve(storePath),
          );
          for (const w of others) {
            if (w.alive && w.lock) {
              logCliInfo(
                logFilePath,
                "status",
                `${c.label("Watcher elsewhere:")} ${c.warn("active")} pid ${w.lock.pid} in ${c.file(w.storePath)} ${c.dim("(the running OpenCode plugin indexes THAT store — restart OpenCode after a vectorStore/embedding config change)")}`,
              );
            } else if (w.status?.lastRunAt || w.status?.lastSuccessAt) {
              const last = w.status.lastSuccessAt ?? w.status.lastRunAt!;
              logCliInfo(
                logFilePath,
                "status",
                `${c.label("Watcher (old):")}   ${c.dim(`stopped — last run ${formatRelativeAge(last)} in ${w.storePath}`)}`,
              );
            }
          }
        } catch {
          // watcher discovery is best effort
        }
        const kiCount = config.retrieval.hybridSearch?.enabled
          ? keywordIndex?.count() ?? 0
          : 0;
        logCliInfo(logFilePath, "status", `${c.label("Keyword index:")}     ${config.retrieval.hybridSearch?.enabled ? c.enabled("enabled") : c.disabled("disabled")} (${c.num(kiCount)} chunks)`);
        // The keyword index and the vector store are two independent stores of
        // the same corpus. A file the store holds but the keyword index does
        // not cover is unreachable through keyword search — report the gap
        // instead of printing two unrelated chunk counts.
        if (config.retrieval.hybridSearch?.enabled && keywordIndex) {
          const gaps = await findKeywordIndexGaps(store, keywordIndex);
          if (gaps.length > 0) {
            logCliInfo(
              logFilePath,
              "status",
              `${c.label("Keyword coverage:")} ${c.warn(`${gaps.length} file(s) in the store are missing from the keyword index`)} ${c.dim("(run 'opencode-rag index' to rehydrate — no re-embedding needed)")}`,
            );
            for (const gap of gaps.slice(0, 5)) {
              logCliInfo(logFilePath, "status", `  ${c.file(path.relative(cwd, gap) || gap)}`);
            }
            if (gaps.length > 5) {
              logCliInfo(logFilePath, "status", `  ${c.dim(`… and ${gaps.length - 5} more`)}`);
            }
          } else {
            logCliInfo(logFilePath, "status", `${c.label("Keyword coverage:")} ${c.success("complete")} ${c.dim("(every indexed file is searchable by keyword)")}`);
          }
        }
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

        // GitHub update check. Runs unless autoUpdate is explicitly disabled.
        // Awaited (raced against 3s) so the result can actually print —
        // process.exit(0) below would previously kill the promise before it
        // resolved, making the Update: line dead code.
        if (config.autoUpdate?.enabled) {
          try {
            const info = await Promise.race([
              checkForUpdate(pkg.version),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
            ]);
            if (info && info.updateAvailable) {
              process.stdout.write(`  ${c.label("Update:")}            ${c.warn(`v${info.latestVersion} available — run \`opencode-rag update\` to install`)}\n`);
            }
          } catch {
            /* ignore network errors */
          }
        }

        // Force exit — avoid LanceDB close() hanging on Windows native bindings.
        // Status is read-only so there's no state to lose.
        process.exit(0);
      } catch (err) {
        const message = (err as Error).message || String(err);
        const logFilePath = path.resolve(process.cwd(), ".opencode", "opencode-rag.log");
        logCliError(logFilePath, "status", `\nStatus check failed: ${message}`, err);
        process.exit(1);
      }
    });
}
