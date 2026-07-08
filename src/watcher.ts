/**
 * @fileoverview Background file watcher (chokidar-based) that auto-re-indexes
 * the workspace when files change. Detects vector store corruption and performs
 * automatic rebuild.
 */

import chokidar from "chokidar";
import path from "node:path";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
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
}

/** The current operational status of the background indexer watcher. */
export type WatcherStatus = {
  /** Whether an index pass is currently running. */
  running: boolean;
  /** Timestamp (ms since epoch) of the last completed run, or undefined. */
  lastRunAt: number | undefined;
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
 * Create a background file watcher that automatically re-indexes the
 * workspace when files change. Uses chokidar for file system events and
 * debounces rapid changes. Detects vector store corruption and performs
 * an automatic rebuild.
 *
 * @param options - Configuration for the background indexer.
 * @returns A BackgroundIndexer handle with a close() method for shutdown.
 */
export function createBackgroundIndexer(options: CreateBackgroundIndexerOptions): BackgroundIndexer {
  const { cwd, storePath, config, store, embedder, logFilePath, logLevel, keywordIndex, descriptionProvider } = options;

  writeWatcherStatus(storePath, { running: false, lastRunAt: undefined });

  const ac = new AbortController();

  const updateStatus = (partial: Partial<WatcherStatus>) => {
    writeWatcherStatus(storePath, { running: false, lastRunAt: undefined, ...partial });
  };

  const runPass = async (filterPaths?: string[]): Promise<void> => {
    updateStatus({ running: true, lastRunAt: Date.now() });
    try {
      await runIndexPass({
        cwd,
        storePath,
        config,
        store,
        embedder,
        keywordIndex,
        descriptionProvider,
        filterPaths,
        abortSignal: ac.signal,
        logger: {
          info: (message) => appendDebugLog(logFilePath, { scope: "autoIndex", message }, logLevel),
          warn: (message) => appendDebugLog(logFilePath, { scope: "autoIndex", message }, logLevel),
              debug: (message) => appendDebugLog(logFilePath, { scope: "autoIndex", message: `DEBUG: ${message}`, severity: "debug" }, logLevel),
        },
      });
      updateStatus({ running: false, lastRunAt: Date.now() });
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
      updateStatus({ running: false, lastRunAt: Date.now() });
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

  const autoIndexCfg = config.openCode.autoIndex ?? { enabled: false, debounceMs: 5000, intervalMs: 300000 };
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

  const handleChange = (filePath?: string) => scheduler.notifyChange(filePath ? [filePath] : undefined);
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

  // Periodic timer: only needed for git backend (chokidar gets real FS events)
  const watcherBackend = autoIndexCfg.watcher ?? "chokidar";
  const periodicTimer = watcherBackend === "git"
    ? setInterval(() => {
        scheduler.notifyChange();
      }, autoIndexCfg.intervalMs)
    : undefined;

  return {
    async close(): Promise<void> {
      if (periodicTimer) clearInterval(periodicTimer);
      ac.abort();
      scheduler.close();
      await scheduler.waitForIdle();
      await watcher.close();
      const statusPath = path.join(storePath, "watcher-status.json");
      if (existsSync(statusPath)) {
        try { unlinkSync(statusPath); } catch { /* ignore */ }
      }
      appendDebugLog(logFilePath, {
        scope: "autoIndex",
        message: "Background indexer shut down",
      });
    },
  };
}
