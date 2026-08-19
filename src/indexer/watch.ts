/**
 * @fileoverview Debounced file-watching scheduler and path-ignore predicate for incremental re-indexing.
 */
import path from "node:path";
import { manifestPathFor } from "../core/manifest.js";
import type { RagConfig } from "../core/config.js";
import { createExcludeMatcher, createIncludeMatcher } from "../core/exclude.js";

/** Scheduler that coordinates debounced re-index passes triggered by file-system changes. */
export interface WatchPassScheduler {
  /** Notify the scheduler that a change occurred; triggers a debounced re-index.
   *  If `changedPaths` are provided, they are accumulated and passed to runPass.
   *  If omitted, a full scan is requested (no filter paths). */
  notifyChange(changedPaths?: string[]): void;
  /** Resolves once the current pass (if any) finishes and no further passes are pending. */
  waitForIdle(): Promise<void>;
  /** Shut down the scheduler, cancelling any pending pass. */
  close(): void;
}

/**
 * Create a scheduler that debounces calls to a re-index pass. While a pass is
 * running, subsequent notifications queue a single rerun. Useful for watching
 * file changes without overloading the system.
 *
 * Paths passed via `notifyChange` are accumulated during the debounce window
 * and forwarded to `runPass` as a deduplicated array. Calling `notifyChange()`
 * without paths triggers a full scan (filterPaths = undefined).
 *
 * @param runPass   - Async function that performs a single index pass.
 * @param onError   - Callback invoked when `runPass` throws.
 * @param debounceMs- Debounce interval in milliseconds (default 300).
 * @returns A {@link WatchPassScheduler} instance.
 */
export function createWatchPassScheduler(
  runPass: (filterPaths?: string[]) => Promise<void>,
  onError: (error: unknown) => void,
  debounceMs: number = 300,
): WatchPassScheduler {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let rerunRequested = false;
  let closed = false;
  let fullPassRequested = false;
  const pendingPaths = new Set<string>();
  const waiters: Array<() => void> = [];

  function resolveWaiters(): void {
    if (running || timer || rerunRequested) return;
    while (waiters.length > 0) {
      waiters.shift()?.();
    }
  }

  function schedule(): void {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void execute();
    }, debounceMs);
  }

  async function execute(): Promise<void> {
    if (closed) return;
    if (running) {
      rerunRequested = true;
      return;
    }

    // Drain accumulated paths before running
    const paths = fullPassRequested ? undefined : (pendingPaths.size > 0 ? [...pendingPaths] : undefined);
    pendingPaths.clear();
    fullPassRequested = false;

    running = true;
    try {
      await runPass(paths);
    } catch (error) {
      onError(error);
    } finally {
      running = false;
      if (rerunRequested) {
        rerunRequested = false;
        schedule();
      }
      resolveWaiters();
    }
  }

  return {
    notifyChange(changedPaths?: string[]) {
      if (closed) return;
      if (changedPaths && changedPaths.length > 0) {
        for (const p of changedPaths) pendingPaths.add(p);
      } else {
        fullPassRequested = true;
      }
      if (running) {
        rerunRequested = true;
        return;
      }
      schedule();
    },
    waitForIdle() {
      if (!running && !timer && !rerunRequested) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    close() {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolveWaiters();
    },
  };
}

/**
 * Build a predicate that returns `true` for paths that should be ignored by
 * a file watcher (store directory, manifest file, and configured exclude
 * directories). When `indexing.includeDirs` is non-empty, any path outside
 * the included folders is ignored as well, so out-of-scope changes never
 * trigger re-index passes.
 *
 * @param cwd       - Workspace root directory.
 * @param config    - RAG configuration containing `indexing.excludeDirs`.
 * @param storePath - Path to the vector store data directory.
 * @returns A function that accepts a watched path and returns `true` if it
 *          should be ignored.
 */
export function createWatchIgnore(
  cwd: string,
  config: RagConfig,
  storePath: string,
): (watchedPath: string) => boolean {
  const manifestPath = manifestPathFor(storePath);
  const dirMatcher = createExcludeMatcher(config.indexing.excludeDirs);
  const fileMatcher = createExcludeMatcher(config.indexing.excludeFiles ?? []);
  const includeMatcher = createIncludeMatcher(config.indexing.includeDirs ?? []);

  // Prefix check with a trailing separator so sibling dirs like
  // `<storePath>2` are NOT ignored; case-insensitive on win32 so a
  // differently-cased store path cannot cause self-triggering watch loops.
  const storePrefix = storePath.endsWith(path.sep) ? storePath : storePath + path.sep;
  const win32 = process.platform === "win32";

  return (watchedPath: string): boolean => {
    const resolved = path.resolve(watchedPath);
    const compareResolved = win32 ? resolved.toLowerCase() : resolved;
    const compareStorePrefix = win32 ? storePrefix.toLowerCase() : storePrefix;
    if (resolved === storePath || compareResolved.startsWith(compareStorePrefix)) return true;
    if (resolved === manifestPath) return true;

    const relative = path.relative(cwd, resolved);
    if (!relative || relative.startsWith("..")) return false;
    return !includeMatcher.included(relative) || dirMatcher.excluded(relative) || fileMatcher.excluded(relative);
  };
}
