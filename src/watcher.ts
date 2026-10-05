/**
 * @fileoverview Background file watcher (chokidar-based) that auto-re-indexes
 * the workspace when files change. Detects vector store corruption and performs
 * automatic rebuild.
 */

import chokidar from "chokidar";
import path from "node:path";
import { writeFileSync, unlinkSync, existsSync, readFileSync, openSync, closeSync } from "node:fs";
import { appendDebugLog } from "./core/fileLogger.js";
import type { RagConfig } from "./core/config.js";
import type { DescriptionProvider, EmbeddingProvider, KeywordIndex, VectorStore } from "./core/interfaces.js";
import { isCorruptionError } from "./vectorstore/lancedb.js";
import {
  createWatchPassScheduler,
  createWatchIgnore,
  runIndexPass,
} from "./indexer.js";

/** A background indexer that can be shut down gracefully. */
export interface BackgroundIndexer {
  /** Stop the watcher, cancel pending index passes, and clean up status files. */
  close(): Promise<void>;
}

/** Options for creating a background indexer instance. */
export interface CreateBackgroundIndexerOptions {
  /** The workspace root directory to watch for changes. */
  cwd: string;
  /** Absolute path to the vector store directory. */
  storePath: string;
  /** Loaded RAG configuration. */
  config: RagConfig;
  /** Vector store instance for writing indexed chunks. */
  store: VectorStore;
  /** Embedding provider for converting chunks to vectors. */
  embedder: EmbeddingProvider;
  /** Path to the debug log file. */
  logFilePath: string;
  /** Log level controlling verbosity. */
  logLevel?: string;
  /** Optional keyword index for hybrid search support. */
  keywordIndex?: KeywordIndex;
  /** Optional provider for generating LLM-based chunk descriptions. */
  descriptionProvider?: DescriptionProvider;
  /** Embedding vector dimension — enables atomic rebuilds instead of destructive clear. */
  dimension?: number;
}

/** The current operational status of the background indexer watcher. */
export type WatcherStatus = {
  /** Whether an index pass is currently running. */
  running: boolean;
  /** Timestamp (ms since epoch) of the last finished pass (success or failure), or undefined. */
  lastRunAt: number | undefined;
  /** Timestamp (ms since epoch) of the last pass that finished without an error. */
  lastSuccessAt?: number;
  /** Timestamp (ms since epoch) of the last failed pass. */
  lastErrorAt?: number;
  /** Truncated error message from the last failed pass. */
  lastError?: string;
  /** Consecutive failed passes since the last success (0 after a clean pass). */
  consecutiveFailures?: number;
  /** Timestamp (ms since epoch) of the last filesystem change that triggered a pass. */
  lastChangeAt?: number;
  /** Files/chunks that failed inside the last pass without failing the pass itself. */
  lastPassProblems?: number;
};

/** Persist the current watcher status to disk as JSON. */
function writeWatcherStatus(storePath: string, status: WatcherStatus): void {
  try {
    writeFileSync(
      path.join(storePath, "watcher-status.json"),
      JSON.stringify(status, null, 2),
      "utf-8"
    );
  } catch {
    // silently ignore write errors
  }
}

/**
 * Derive whether the watched index may be stale from the persisted status.
 * Stale when a reindex pass failed (or the embedding provider was unavailable and
 * stored nothing), or when filesystem changes arrived after the last successful pass.
 * Pure function — used by `status` and the TUI so both tell the same story.
 *
 * @param status - The persisted watcher status.
 * @returns `stale` plus a human-readable reason when stale.
 */
export function deriveWatcherHealth(status: WatcherStatus): { stale: boolean; reason?: string } {
  const failures = status.consecutiveFailures ?? 0;
  if (failures > 0) {
    const lastError = status.lastError ? `: ${status.lastError}` : "";
    return { stale: true, reason: `${failures} consecutive reindex failure(s)${lastError}` };
  }
  if (status.lastChangeAt && (!status.lastSuccessAt || status.lastChangeAt > status.lastSuccessAt)) {
    return { stale: true, reason: "changes detected after the last successful reindex" };
  }
  return { stale: false };
}

// ── Cross-process watcher claim lock ────────────────────────────────────────
// `index.lock` only serializes individual index passes — it does NOT stop N
// processes (N OpenCode sessions, or a session + `opencode-rag index --watch`)
// from each spawning their own chokidar watcher for the same workspace. Every
// extra watcher fires its own fire-and-forget initial pass (all but one skip
// the pass lock and then retry every 30s) and burns file-watcher resources.
// The claim lock below guarantees at most ONE active watcher per workspace:
// the first process to claim it runs the watcher; the others stay dormant and
// periodically re-check so they take over if the owning process exits.

const WATCHER_LOCK_FILE = "watcher.lock";
/** How often a dormant indexer re-checks whether the watcher lock is free. */
const WATCHER_RECHECK_MS = 60_000;

type WatcherLock = { pid: number; startedAt: number };

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readWatcherLock(storePath: string): WatcherLock | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(storePath, WATCHER_LOCK_FILE), "utf-8")) as WatcherLock;
    return typeof parsed.pid === "number" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Atomically claim the watcher lock for a workspace. Returns true only if
 * this process is now the active watcher. A stale lock (dead PID) or an
 * unreadable/corrupt lock file is cleared and re-claimed.
 */
export function tryAcquireWatcherLock(storePath: string): boolean {
  const lockPath = path.join(storePath, WATCHER_LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = readWatcherLock(storePath);
    if (!existing || !isPidAlive(existing.pid)) {
      // Stale, corrupt, or missing lock — clear it and claim atomically
      // (O_EXCL create so two racing processes cannot both win).
      try { unlinkSync(lockPath); } catch { /* may not exist */ }
      try {
        const fd = openSync(lockPath, "wx");
        try {
          writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() } satisfies WatcherLock), "utf-8");
        } finally {
          closeSync(fd);
        }
        return true;
      } catch {
        // Someone else claimed it between our unlink and create — retry once.
        continue;
      }
    }
    return false;
  }
  return false;
}

/** Release the watcher lock — only if this process owns it. */
export function releaseWatcherLock(storePath: string): void {
  const lock = readWatcherLock(storePath);
  if (lock?.pid === process.pid) {
    try { unlinkSync(path.join(storePath, WATCHER_LOCK_FILE)); } catch { /* ignore */ }
  }
}

/**
 * Create a background file watcher that automatically re-indexes the
 * workspace when files change. Uses chokidar for file system events and
 * debounces rapid changes. Detects vector store corruption and performs
 * an automatic rebuild.
 *
 * @param options - Configuration for the background indexer.
 * @returns A BackgroundIndexer handle with a close() method for shutdown.
 */
export function createBackgroundIndexer(options: CreateBackgroundIndexerOptions): BackgroundIndexer {
  const { cwd, storePath, config, store, embedder, logFilePath, logLevel, keywordIndex, descriptionProvider, dimension } = options;
  const autoIndexCfg = config.openCode.autoIndex ?? { enabled: false, debounceMs: 5000, intervalMs: 300000 };

  let active = false;
  let recheckTimer: NodeJS.Timeout | undefined;
  let stopActive: (() => Promise<void>) | undefined;

  /** Start the chokidar watcher, debounced scheduler, and initial pass. */
  const startActive = (): void => {
    if (active) return;
    active = true;

    let status: WatcherStatus = { running: false, lastRunAt: undefined };
    writeWatcherStatus(storePath, status);

    const ac = new AbortController();

    // Merge partial updates into the persisted status so fields written by other
    // code paths (lastSuccessAt, error info) survive every write.
    const updateStatus = (patch: Partial<WatcherStatus>) => {
      status = { ...status, ...patch };
      writeWatcherStatus(storePath, status);
    };

    /** Files/chunks that failed inside a pass without failing the pass itself. */
    const passProblems = (stats: {
      extractionFailures: number;
      descriptionFailedFiles: number;
      embeddingFailures: number;
    }): number =>
      stats.extractionFailures + stats.descriptionFailedFiles + stats.embeddingFailures;

    // Watched passes are full scans + manifest diffs by design: the scheduler's
    // coalesced paths are change *hints* only. A filtered scan cannot detect
    // deletions, and missed fs events would silently stale the index — the
    // manifest hash diff is what makes every pass authoritative.
    const runPass = async (): Promise<void> => {
      updateStatus({ running: true, lastRunAt: Date.now() });
      try {
        const stats = await runIndexPass({
          cwd,
          storePath,
          config,
          store,
          embedder,
          keywordIndex,
          descriptionProvider,
          dimension,
          abortSignal: ac.signal,
          logger: {
            info: (message) => appendDebugLog(logFilePath, { scope: "autoIndex", message }, logLevel),
            warn: (message) => appendDebugLog(logFilePath, { scope: "autoIndex", message }, logLevel),
            debug: (message) => appendDebugLog(logFilePath, { scope: "autoIndex", message: `DEBUG: ${message}`, severity: "debug" }, logLevel),
          },
        });
        // A lock-skipped pass did NO work — retry shortly so the workspace
        // does not stay unindexed until the next file event.
        if (stats.skipped) {
          appendDebugLog(logFilePath, {
            scope: "autoIndex",
            message: "Index pass skipped (another pass holds the lock) — retrying in 30s",
          }, logLevel);
          if (!ac.signal.aborted) {
            setTimeout(() => {
              if (!ac.signal.aborted) scheduler.notifyChange();
            }, 30_000).unref();
          }
          updateStatus({ running: false, lastRunAt: Date.now() });
        } else if (stats.embeddingUnavailable) {
          // The pass "completed" but stored nothing — treat it as a failed pass so
          // `status` and the TUI show a stale index instead of silent success.
          const message = "embedding provider unavailable — nothing was stored";
          appendDebugLog(logFilePath, { scope: "autoIndex", message }, logLevel);
          updateStatus({
            running: false,
            lastRunAt: Date.now(),
            lastErrorAt: Date.now(),
            lastError: message,
            consecutiveFailures: (status.consecutiveFailures ?? 0) + 1,
            lastPassProblems: passProblems(stats),
          });
        } else {
          updateStatus({
            running: false,
            lastRunAt: Date.now(),
            lastSuccessAt: Date.now(),
            consecutiveFailures: 0,
            lastPassProblems: passProblems(stats),
          });
        }
      } catch (err) {
        appendDebugLog(logFilePath, {
          scope: "autoIndex",
          message: "Watch reindex pass failed",
          error: err,
        }, logLevel);
        if (isCorruptionError(err)) {
          appendDebugLog(logFilePath, {
            scope: "autoIndex",
            message: "Corruption detected — run 'opencode-rag index --force' to rebuild manually",
          }, logLevel);
        }
        const message = err instanceof Error ? err.message : String(err);
        updateStatus({
          running: false,
          lastRunAt: Date.now(),
          lastErrorAt: Date.now(),
          lastError: message.length > 300 ? `${message.slice(0, 299)}…` : message,
          consecutiveFailures: (status.consecutiveFailures ?? 0) + 1,
        });
      }
    };

    // Fire-and-forget initial index pass
    runPass().catch((err) => {
      appendDebugLog(logFilePath, {
        scope: "autoIndex",
        message: "Initial index pass failed",
        error: err,
      }, logLevel);
    });

    const scheduler = createWatchPassScheduler(
      runPass,
      (error) => {
        const message = (error as Error).message || String(error);
        appendDebugLog(logFilePath, {
          scope: "autoIndex",
          message: `Watch reindex failed: ${message}`,
          error,
        }, logLevel);
      },
      autoIndexCfg.debounceMs
    );

    const watcher = chokidar.watch(cwd, {
      ignored: createWatchIgnore(cwd, config, storePath),
      ignoreInitial: true,
      persistent: true,
    });

    const handleChange = (filePath?: string) => {
      updateStatus({ lastChangeAt: Date.now() });
      scheduler.notifyChange(filePath ? [filePath] : undefined);
    };
    watcher.on("add", handleChange);
    watcher.on("change", handleChange);
    watcher.on("unlink", handleChange);
    watcher.on("unlinkDir", handleChange);
    watcher.on("addDir", handleChange);
    watcher.on("error", (error) => {
      appendDebugLog(logFilePath, {
        scope: "autoIndex",
        message: `Watcher error: ${(error as Error).message}`,
        error,
      }, logLevel);
    });

    // Periodic timer: only needed for git backend (chokidar gets real FS events).
    // Note: with git mode BOTH backends run — the scheduler coalesces redundant
    // passes into one, so this only adds a safety net for missed events.
    const watcherBackend = autoIndexCfg.watcher ?? "chokidar";
    const periodicTimer = watcherBackend === "git"
      ? setInterval(() => {
          scheduler.notifyChange();
        }, autoIndexCfg.intervalMs)
      : undefined;
    // Never keep the process alive just for the periodic scan
    periodicTimer?.unref();

    stopActive = async (): Promise<void> => {
      if (!active) return;
      active = false;
      if (periodicTimer) clearInterval(periodicTimer);
      ac.abort();
      scheduler.close();
      // chokidar close() can hang on some Windows setups — guard it like
      // the CLI does.
      await Promise.race([
        scheduler.waitForIdle(),
        new Promise<void>((resolve) => setTimeout(resolve, 5000).unref()),
      ]);
      await Promise.race([
        watcher.close(),
        new Promise<void>((resolve) => setTimeout(resolve, 5000).unref()),
      ]);
      const statusPath = path.join(storePath, "watcher-status.json");
      if (existsSync(statusPath)) {
        try { unlinkSync(statusPath); } catch { /* ignore */ }
      }
      releaseWatcherLock(storePath);
      appendDebugLog(logFilePath, {
        scope: "autoIndex",
        message: "Background indexer shut down",
      });
    };
  };

  if (tryAcquireWatcherLock(storePath)) {
    startActive();
  } else {
    // Another process already runs the watcher for this workspace (a second
    // OpenCode session, `opencode-rag index --watch`, …). Stay dormant and
    // re-check periodically so this process takes over once the owner exits.
    const owner = readWatcherLock(storePath);
    appendDebugLog(logFilePath, {
      scope: "autoIndex",
      message: owner?.pid
        ? `Watcher already running for this workspace (PID ${owner.pid}) — skipping duplicate watcher`
        : "Watcher already running for this workspace — skipping duplicate watcher",
    }, logLevel);
    recheckTimer = setInterval(() => {
      if (!active && tryAcquireWatcherLock(storePath)) {
        appendDebugLog(logFilePath, {
          scope: "autoIndex",
          message: "Previous watcher released this workspace — taking over",
        }, logLevel);
        if (recheckTimer) {
          clearInterval(recheckTimer);
          recheckTimer = undefined;
        }
        startActive();
      }
    }, WATCHER_RECHECK_MS);
    recheckTimer.unref();
  }

  return {
    async close(): Promise<void> {
      if (recheckTimer) {
        clearInterval(recheckTimer);
        recheckTimer = undefined;
      }
      if (stopActive) {
        await stopActive();
      }
    },
  };
}
