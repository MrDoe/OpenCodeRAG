import fs from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import { scanWorkspaceFiles } from "../content/reader.js";
import type { RagConfig } from "../core/config.js";
import { loadManifest, saveManifest, normalizeFilePath } from "../core/manifest.js";
import type {
  Chunk,
  DescriptionProvider,
  EmbeddingProvider,
  IndexProgress,
  KeywordIndex,
  VectorStore,
} from "../core/interfaces.js";
import { embedBatch } from "../embedder/factory.js";
import { createIndexStats, type IndexRunStats, type IndexStatusSummary } from "./stats.js";
import { prepareFile, buildTextsToEmbed, storeFileChunks, type WorkerResult, type PreparedFile } from "./worker.js";
import { getCurrentCommit, getChangedFilesSince, getUntrackedFiles, getRepoRoot } from "./git-diff.js";

export type { WatchPassScheduler } from "./watch.js";
export { createWatchPassScheduler, createWatchIgnore } from "./watch.js";

/** Options for configuring a single index pass. */
export interface RunIndexPassOptions {
  /** Workspace root directory. */
  cwd: string;
  /** Path to the vector store data directory. */
  storePath: string;
  /** Full RAG configuration for the workspace. */
  config: RagConfig;
  /** Vector store instance for persisting chunks. */
  store: VectorStore;
  /** Embedding provider for generating vector representations. */
  embedder: EmbeddingProvider;
  /** When true, ignore the existing manifest and re-index everything. */
  force?: boolean;
  /** Optional partial logger (missing methods default to no-ops). */
  logger?: Partial<Logger>;
  /** Optional keyword index to populate during the pass. */
  keywordIndex?: KeywordIndex;
  /** Optional provider for AI-generated chunk descriptions. */
  descriptionProvider?: DescriptionProvider;
  /** Optional progress tracker for reporting file-level progress. */
  progress?: IndexProgress;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

function createLogger(logger?: Partial<Logger>): Logger {
  return {
    info: logger?.info ?? (() => {}),
    warn: logger?.warn ?? (() => {}),
    debug: logger?.debug ?? (() => {}),
  };
}

function tryUpdateLastGitCommit(cwd: string, manifest: { lastGitCommit?: string }): boolean {
  try {
    const repoRoot = getRepoRoot(cwd);
    if (!repoRoot) return false;
    const commit = getCurrentCommit(repoRoot);
    if (!commit) return false;
    manifest.lastGitCommit = commit;
    return true;
  } catch {
    return false;
  }
}

const LOCK_FILE = "index.lock";
const LOCK_MAX_AGE_MS = 5 * 60 * 1000;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute a full index pass: scan workspace, prepare files, generate embeddings
 * (and optionally AI descriptions), and store results into the vector store.
 * Uses a lock file to prevent concurrent passes.
 *
 * @param options - Configuration for the index pass.
 * @returns Aggregate statistics for the pass.
 */
export async function runIndexPass(options: RunIndexPassOptions): Promise<IndexRunStats> {
  const logger = createLogger(options.logger);
  const lockPath = path.join(options.storePath, LOCK_FILE);

  try {
    const raw = await fs.readFile(lockPath, "utf-8");
    const lock = JSON.parse(raw) as { pid?: number; startedAt?: number };
    const age = lock.startedAt ? Date.now() - lock.startedAt : Infinity;
    if (lock.pid && !isPidAlive(lock.pid)) {
      logger.debug(`Stale lock from dead process ${lock.pid} — continuing`);
    } else if (lock.startedAt && age < LOCK_MAX_AGE_MS) {
      logger.warn(`Another index pass is running (PID ${lock.pid ?? "unknown"}). Skipping.`);
      return createIndexStats(0, "missing");
    }
  } catch {
    // No lock file — proceed
  }

  try {
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf-8");
  } catch {
    // Best-effort lock
  }

  try {
    return await runIndexPassInner(options, logger);
  } finally {
    try { await fs.unlink(lockPath); } catch {}
  }
}

async function runIndexPassInner(options: RunIndexPassOptions, logger: Logger): Promise<IndexRunStats> {
  const loadResult = await loadManifest(options.storePath);
  const manifest = loadResult.manifest;
  let manifestStatus = loadResult.status;
  let rebuildPerformed = false;

  logger.info(`Manifest loaded: ${manifestStatus}, ${Object.keys(manifest.files).length} entries`);

  if (options.force) {
    manifestStatus = "missing";
    logger.debug("Force mode: ignoring manifest");
  }

  // Clear files that had description failures so they are fully re-indexed
  const descFailedPaths = Object.keys(manifest.files).filter(
    (p) => manifest.files[p]?.descriptionFailed,
  );
  if (descFailedPaths.length > 0) {
    logger.info(`  ${descFailedPaths.length} file(s) marked as description-failed — re-indexing`);
    for (const p of descFailedPaths) {
      delete manifest.files[p];
    }
  }

  let filterPaths: string[] | undefined;
  let gitDeletedPaths: string[] = [];

  if (!options.force && manifestStatus === "ok" && manifest.lastGitCommit) {
    const repoRoot = getRepoRoot(options.cwd);
    if (repoRoot) {
      const diffResult = getChangedFilesSince(options.cwd, manifest.lastGitCommit);
      if (diffResult) {
        const untracked = getUntrackedFiles(options.cwd);
        const changedSet = new Set<string>();
        for (const f of diffResult.changedFiles) changedSet.add(f);
        for (const f of untracked) changedSet.add(f);
        filterPaths = Array.from(changedSet);
        gitDeletedPaths = diffResult.deletedFiles;
        logger.debug(`Git incremental: ${filterPaths.length} changed/untracked, ${gitDeletedPaths.length} deleted since ${manifest.lastGitCommit.slice(0, 8)}`);
      }
    }
  }

  logger.info("Scanning workspace for files...");
  const scanStarted = Date.now();
  const workspaceFiles = await scanWorkspaceFiles(
    options.cwd,
    options.config,
    logger,
    options.force ? undefined : manifest,
    filterPaths,
  );
  logger.info(`Scan complete: ${workspaceFiles.length} files in ${((Date.now() - scanStarted) / 1000).toFixed(1)}s`);

  logger.debug(`Workspace scan complete: ${workspaceFiles.length} files`);

  const existingCount = await options.store.count();

  // Detect data loss: if the store has far fewer chunks than the manifest expects,
  // treat it as a corrupt store (e.g. schema migration dropped the old table).
  if (!options.force && manifestStatus === "ok" && existingCount > 0) {
    const manifestTotalChunks = Object.values(manifest.files).reduce(
      (sum, entry) => sum + entry.chunkCount, 0
    );
    if (manifestTotalChunks > 0 && existingCount < manifestTotalChunks * 0.5) {
      logger.warn(
        `Store has ${existingCount} chunks but manifest expects ~${manifestTotalChunks}. ` +
        `Data appears to have been lost — re-indexing all files.`
      );
      for (const key of Object.keys(manifest.files)) {
        delete manifest.files[key];
      }
      manifest.lastIndexedAt = undefined;
      manifestStatus = "missing";
    }
  }

  if (options.force || (manifestStatus !== "ok" && existingCount > 0)) {
    await options.store.clear();
    options.keywordIndex?.clear();
    for (const key of Object.keys(manifest.files)) {
      delete manifest.files[key];
    }
    manifest.lastIndexedAt = undefined;
    rebuildPerformed = existingCount > 0 || Boolean(options.force);
    if (manifestStatus !== "ok" && existingCount > 0) {
      logger.warn("Manifest missing or corrupt; rebuilding full index.");
    }
    manifestStatus = options.force ? "missing" : manifestStatus;
  }

  const stats = createIndexStats(workspaceFiles.length, manifestStatus);
  stats.rebuildPerformed = rebuildPerformed;

  for (const file of workspaceFiles) {
    if (file.extractionStatus === "failed" && file.extractionError) {
      stats.extractionFailures++;
      stats.extractionErrors.push({
        filePath: file.filePath,
        error: file.extractionError,
      });
    }
  }

  const currentPaths = new Set(workspaceFiles.map((file) => file.normalizedPath));
  let stalePaths: string[];
  if (filterPaths) {
    const repoRoot = getRepoRoot(options.cwd) ?? options.cwd;
    stalePaths = gitDeletedPaths.map((p) => normalizeFilePath(path.resolve(repoRoot, p)));
  } else {
    stalePaths = Object.keys(manifest.files).filter((p) => !currentPaths.has(p));
  }
  if (stalePaths.length > 0) {
    logger.debug(`Removing ${stalePaths.length} stale files from index...`);
    const deleteLimit = pLimit(options.config.indexing.concurrency);
    await Promise.all(
      stalePaths.map((p) =>
        deleteLimit(async () => {
          await options.store.deleteByFilePath(p);
          options.keywordIndex?.removeByFilePath(p);
          delete manifest.files[p];
          stats.deletedFiles++;
        }),
      ),
    );
  }

  let newCount = 0;
  let modifiedCount = 0;
  let unchangedCount = 0;
  for (const file of workspaceFiles) {
    const previous = manifest.files[file.normalizedPath];
    if (file.isEmpty || file.isTooSmall) continue;
    if (previous && previous.hash === file.hash) {
      unchangedCount++;
    } else if (previous) {
      modifiedCount++;
    } else {
      newCount++;
    }
  }
  if (stats.deletedFiles > 0) {
    logger.debug(`Removed ${stats.deletedFiles} deleted files from index.`);
  }
  logger.debug(`Processing ${workspaceFiles.length} files (${newCount} new, ${modifiedCount} modified, ${unchangedCount} unchanged)...`);

  // ── Phase 1: prepare all files (chunk + keyword, defer descriptions if provider present) ──
  const limit = pLimit(options.config.indexing.concurrency);
  const deferDescriptions = !!options.descriptionProvider;

  const prepared = await Promise.all(
    workspaceFiles.map((file) =>
      limit(async () => {
        const fileLabel = path.relative(options.cwd, file.normalizedPath).replace(/\\/g, "/");

        const isActive = !file.isEmpty && !file.isTooSmall &&
          (!manifest.files[file.normalizedPath] || manifest.files[file.normalizedPath]!.hash !== file.hash);
        if (isActive) {
          options.progress?.startFile(fileLabel);
        }

        const prep = await prepareFile(
          file,
          options.cwd,
          manifest.files[file.normalizedPath],
          options.config,
          options.keywordIndex,
          options.descriptionProvider,
          logger,
          deferDescriptions,
        );

        if (prep.earlyResult && isActive) {
          options.progress?.finishFile(fileLabel);
        }

        return prep;
      }),
    ),
  );

  // ── Phase 1.5: global description generation (single pool, no nested concurrency) ──
  if (deferDescriptions) {
    const deferredPreps = prepared.filter((p) => p.chunks && p.chunks.length > 0 && p.relPath !== undefined);
    if (deferredPreps.length > 0) {
      const allChunks: Chunk[] = [];
      for (const prep of deferredPreps) {
        for (const chunk of prep.chunks!) {
          if (chunk.metadata.contentType !== "image") {
            allChunks.push(chunk);
          }
        }
      }

      // Advance progress to Description stage before descriptions start
      for (const prep of deferredPreps) {
        options.progress?.finishStage(prep.fileLabel);
      }

      if (allChunks.length > 0) {
        try {
          const batchResult = await options.descriptionProvider!.generateBatchDescriptions(allChunks, (msg: string) => logger.debug(msg));
          for (const chunk of allChunks) {
            const desc = batchResult.get(chunk.id);
            if (desc && desc.trim().length > 0) {
              chunk.description = desc;
            }
          }
        } catch (err) {
          logger.warn(`  Global description generation failed: ${(err as Error).message}`);
          for (const prep of deferredPreps) {
            if (prep.chunks!.some((c) => c.metadata.contentType !== "image")) {
              prep.descriptionFailed = true;
            }
          }
        }
      }

      // Phase 1.6: build textToEmbed with descriptions injected
      for (const prep of deferredPreps) {
        prep.textToEmbed = buildTextsToEmbed(
          prep.chunks!,
          prep.relPath!,
          prep.metaHeader ?? "",
          prep.docPrefix ?? "",
          prep.isImageFile ?? false,
        );
      }
    }
  }

  // ── Handle deletions from store for files being re-processed ──
  const deletionLimit = pLimit(options.config.indexing.concurrency);
  await Promise.all(
    prepared.map((prep) =>
      deletionLimit(async () => {
        if (prep.earlyResult?.isRemoved) {
          await options.store.deleteByFilePath(prep.normalizedPath);
          options.keywordIndex?.removeByFilePath(prep.normalizedPath);
          return;
        }
        if (prep.isModified && prep.chunks && prep.chunks.length > 0) {
          await options.store.deleteByFilePath(prep.normalizedPath);
          options.keywordIndex?.removeByFilePath(prep.normalizedPath);
        }
      }),
    ),
  );

  // ── Phase 2+3: per-file embed + store (in parallel) ──
  const isOllama = options.embedder.name === "ollama";
  const ollamaMaxBatch = options.config.indexing.ollamaMaxBatchSize ?? 4000;
  const defaultBatchSize = options.config.indexing.embedBatchSize;
  const defaultConcurrency = options.config.indexing.embedConcurrency ?? 1;

  const embedStoreLimit = pLimit(options.config.indexing.concurrency);
  const workerResults = await Promise.all(
    prepared.map((prep) =>
      embedStoreLimit(async () => {
        if (prep.earlyResult) return prep.earlyResult;
        if (!prep.chunks || !prep.textToEmbed || prep.textToEmbed.length === 0) {
          options.progress?.finishFile(prep.fileLabel);
          return {
            normalizedPath: prep.normalizedPath, hash: prep.hash, chunkCount: 0,
            fileLabel: prep.fileLabel,
            isNew: false, isModified: false, isUnchanged: false, isEmpty: false,
            isTooSmall: false, isRemoved: true, hadChunks: false,
            descriptionFailed: prep.descriptionFailed,
          };
        }

        // Plan A: single batch for Ollama
        const batchSize = isOllama
          ? Math.min(prep.textToEmbed.length, ollamaMaxBatch)
          : defaultBatchSize;
        const concurrency = isOllama ? 1 : defaultConcurrency;

        options.progress?.finishStage(prep.fileLabel);

        let embeddings: number[][];
        try {
          embeddings = await embedBatch(
            options.embedder,
            prep.textToEmbed,
            batchSize,
            "document",
            concurrency,
          );
        } catch (err) {
          logger.warn(`  ${prep.fileLabel} (embedding failed: ${(err as Error).message})`);
          options.progress?.failFile(prep.fileLabel);
          return {
            normalizedPath: prep.normalizedPath, hash: prep.hash, chunkCount: 0,
            fileLabel: prep.fileLabel,
            isNew: false, isModified: false, isUnchanged: false, isEmpty: false,
            isTooSmall: false, isRemoved: true, hadChunks: false,
            descriptionFailed: prep.descriptionFailed,
          };
        }

        const result = await storeFileChunks(prep, embeddings, options.store, logger);
        options.progress?.finishFile(prep.fileLabel);
        return result;
      }),
    ),
  );

  // ── Aggregate stats and update manifest ──
  aggregateStats(stats, workerResults, manifest, workspaceFiles);

  manifest.lastIndexedAt = Date.now();
  tryUpdateLastGitCommit(options.cwd, manifest);

  await saveManifest(options.storePath, manifest);
  await options.keywordIndex?.save(options.storePath);
  stats.finalCount = await options.store.count();
  return stats;
}

function aggregateStats(
  stats: IndexRunStats,
  results: WorkerResult[],
  manifest: { files: Record<string, { hash: string; chunkCount: number; indexedAt?: number; mtime?: number; size?: number; descriptionFailed?: boolean }> },
  workspaceFiles: { normalizedPath: string; mtime?: number; size?: number }[],
): void {
  const fileMeta = new Map(workspaceFiles.map((f) => [f.normalizedPath, { mtime: f.mtime, size: f.size }]));

  for (const result of results) {
    if (result.isEmpty) {
      stats.skippedEmptyFiles++;
      if (result.isRemoved) {
        delete manifest.files[result.normalizedPath];
        stats.removedFiles++;
      }
      continue;
    }
    if (result.isTooSmall) {
      stats.skippedSmallFiles++;
      if (result.isRemoved) {
        delete manifest.files[result.normalizedPath];
        stats.removedFiles++;
      }
      continue;
    }
    if (result.isUnchanged) {
      stats.unchangedFiles++;
      continue;
    }
    if (result.isRemoved) {
      delete manifest.files[result.normalizedPath];
      stats.removedFiles++;
      continue;
    }
    if (result.isModified) {
      stats.modifiedFiles++;
    } else if (result.isNew) {
      stats.newFiles++;
    }
    if (result.chunkCount > 0) {
      const meta = fileMeta.get(result.normalizedPath);
      manifest.files[result.normalizedPath] = {
        hash: result.hash,
        chunkCount: result.chunkCount,
        indexedAt: Date.now(),
        mtime: meta?.mtime,
        size: meta?.size,
        descriptionFailed: result.descriptionFailed,
      };
      if (result.descriptionFailed) {
        stats.descriptionFailedFiles++;
      }
      stats.totalChunks += result.chunkCount;
      stats.batchesFlushed++;
    }
  }

  for (const { normalizedPath, mtime, size } of workspaceFiles) {
    const entry = manifest.files[normalizedPath];
    if (entry && (mtime !== undefined || size !== undefined)) {
      entry.mtime = mtime;
      entry.size = size;
    }
  }
}

export async function getIndexStatusSummary(
  cwd: string,
  storePath: string,
  config: RagConfig,
  store: VectorStore,
): Promise<IndexStatusSummary> {
  const loadResult = await loadManifest(storePath);
  const manifest = loadResult.manifest;
  const workspaceFiles = await scanWorkspaceFiles(cwd, config, undefined, manifest);
  const storeCount = await store.count();

  if (loadResult.status !== "ok") {
    return {
      manifestStatus: loadResult.status,
      manifestEntries: 0,
      upToDateFiles: 0,
      pendingFiles: workspaceFiles.length,
      rebuildRequired: storeCount > 0,
      storeChunkCount: storeCount,
      manifestExpectedChunks: 0,
    };
  }

  const currentPaths = new Set(workspaceFiles.map((file) => file.normalizedPath));
  let upToDateFiles = 0;
  let pendingFiles = 0;

  for (const file of workspaceFiles) {
    const previous = manifest.files[file.normalizedPath];
    if (file.isEmpty || file.isTooSmall) {
      if (previous) pendingFiles++;
      continue;
    }

    if (previous && previous.hash === file.hash) {
      upToDateFiles++;
    } else {
      pendingFiles++;
    }
  }

  for (const indexedPath of Object.keys(manifest.files)) {
    if (!currentPaths.has(indexedPath)) {
      pendingFiles++;
    }
  }

  const manifestExpectedChunks = Object.values(manifest.files).reduce(
    (sum, entry) => sum + entry.chunkCount, 0
  );

  return {
    manifestStatus: loadResult.status,
    manifestEntries: Object.keys(manifest.files).length,
    upToDateFiles,
    pendingFiles,
    lastIndexedAt: manifest.lastIndexedAt,
    rebuildRequired: false,
    storeChunkCount: storeCount,
    manifestExpectedChunks,
  };
}
