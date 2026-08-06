/**
 * @fileoverview Orchestrates the full indexing pipeline: scan, chunk, embed, and store.
 */
import fs from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import { scanWorkspaceFiles } from "../content/reader.js";
import type { RagConfig } from "../core/config.js";
import { loadManifest, saveManifest, normalizeFilePath, computeDescriptionConfigHash } from "../core/manifest.js";
import { DescriptionCache } from "../core/desc-cache.js";
import type {
  Chunk,
  DescriptionProvider,
  EmbeddingProvider,
  IndexProgress,
  KeywordIndex,
  VectorStore,
} from "../core/interfaces.js";
import type { ImageVisionProvider } from "../chunker/image.js";
import { embedBatch } from "../embedder/factory.js";
import { createVectorStore } from "../vectorstore/factory.js";
import { swapStoreDirectories } from "../vectorstore/lancedb.js";
import { createIndexStats, type IndexRunStats, type IndexStatusSummary } from "./stats.js";
import { prepareFile, buildTextsToEmbed, type WorkerResult, type PreparedFile } from "./worker.js";
import { buildFallbackDescription } from "./description-stage.js";
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
  /** Optional abort signal – when fired, the pass finishes the current file then stops. */
  abortSignal?: AbortSignal;
  /** Embedding vector dimension — needed when creating a temporary store for atomic rebuilds. */
  dimension?: number;
  /**
   * Caller-provided list of changed file paths (absolute). When set, only these
   * files are scanned — full directory walk is skipped.
   */
  filterPaths?: string[];
  /**
   * Caller-provided list of deleted file paths (absolute). When set, these
   * entries are removed from the index without comparing against the scanned set.
   */
  deletedPaths?: string[];
  /**
   * Optional injected image vision provider for testing. When omitted, the
   * provider is created from the imageDescription config as usual.
   */
  imageVisionProvider?: ImageVisionProvider;
}

/** Minimal logger interface for indexing pipeline diagnostics. */
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
    } else if (lock.pid) {
      // A LIVE process owns the lock — always skip, regardless of age.
      // (Long re-indexes routinely exceed LOCK_MAX_AGE_MS; allowing a second
      // process through the age check defeats the lock entirely and causes
      // concurrent LanceDB writes.)
      logger.warn(`Another index pass is running (PID ${lock.pid}). Skipping.`);
      return { ...createIndexStats(0, "missing"), skipped: true };
    } else if (lock.startedAt && age < LOCK_MAX_AGE_MS) {
      // No readable PID but a fresh lock — treat as active.
      logger.warn(`Another index pass is running (no PID). Skipping.`);
      return { ...createIndexStats(0, "missing"), skipped: true };
    }
  } catch {
    // No lock file — proceed
  }

  try {
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf-8");
  } catch (err) {
    // Best-effort lock — but surface it: without the lock file, the
    // concurrent-pass protection above silently stops working.
    logger.debug(`Could not write index lock file: ${(err as Error).message} — concurrent-pass protection disabled`);
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

  // Compute a hash of the current description config — used to skip re-description
  // when neither the file content nor the description config has changed.
  const descHash = options.descriptionProvider
    ? computeDescriptionConfigHash(options.config)
    : undefined;

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

  // Persistent description cache — survives aborted runs so that descriptions
  // generated before an abort are reused on the next run.
  const descCachePath = options.storePath;
  const descCache = new DescriptionCache(descCachePath);
  await descCache.load();

  // Resume-on-interrupt: detect manifest entries that are inconsistent with
  // the vector store (e.g. indexing was aborted before all chunks were stored,
  // or a full rebuild was aborted leaving a stale manifest pointing to old data).
  // These entries are removed so they will be re-processed in this pass.
  if (!options.force && manifestStatus === "ok" && Object.keys(manifest.files).length > 0) {
    try {
      const storedPaths = await options.store.getFilePaths();
      const storedSet = new Set(storedPaths);
      let removedCount = 0;
      for (const [p, entry] of Object.entries(manifest.files)) {
        // Path missing from store entirely (aborted before store finished)
        if (entry.chunkCount > 0 && !storedSet.has(p)) {
          delete manifest.files[p];
          removedCount++;
        }
      }
      if (removedCount > 0) {
        logger.info(`  ${removedCount} file(s) in manifest but missing from store — re-indexing (resume after interruption)`);
      }
    } catch {
      logger.debug("  Could not check store paths for resume — proceeding without");
    }
  }

  // Clear files where the stored descHash doesn't match current descHash and the
  // file content IS different — these would be caught by hash comparison below but
  // this pre-clear ensures the description cache is consulted during re-description.
  // (Files with same hash but different descHash already fall through in prepareFile.)

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
        // Git paths are relative to the REPO ROOT. When the workspace is a
        // subdirectory of the repo (monorepos), convert them to workspace-
        // relative paths before passing them to the scan — resolving repo-root
        // paths against `cwd` would silently miss every change.
        const toCwdRelative = (p: string): string | null => {
          const abs = path.resolve(repoRoot, p);
          const rel = path.relative(options.cwd, abs);
          if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
          return rel;
        };
        const cwdRelative: string[] = [];
        for (const p of changedSet) {
          const rel = toCwdRelative(p);
          if (rel !== null) cwdRelative.push(rel);
        }
        filterPaths = cwdRelative;
        gitDeletedPaths = diffResult.deletedFiles;
        logger.debug(`Git incremental: ${filterPaths.length} changed/untracked, ${gitDeletedPaths.length} deleted since ${manifest.lastGitCommit.slice(0, 8)}`);
      }
    }
  }

  const scanStart = Date.now();
  const workspaceFiles = await scanWorkspaceFiles(
    options.cwd,
    options.config,
    logger,
    options.force ? undefined : manifest,
    filterPaths,
    options.imageVisionProvider,
    descCache,
  );

  const scanSec = ((Date.now() - scanStart) / 1000).toFixed(1);
  logger.info(`Workspace scan complete: ${workspaceFiles.length} files in ${scanSec}s`);

  logger.info(`Querying vector store for existing chunk count...`);
  const storeCountStart = Date.now();
  const existingCount = await options.store.count();
  logger.info(`Store has ${existingCount} existing chunks (${((Date.now() - storeCountStart) / 1000).toFixed(1)}s)`);

  // Direct data-integrity check: try to actually read a row from the store.
  // LanceDB's countRows() may return a value from the version manifest
  // even when the underlying data files are missing from disk, so we need
  // an explicit probe.  If this fails, treat the store as corrupt.
  if (!options.force && manifestStatus === "ok" && Object.keys(manifest.files).length > 0) {
    try {
      const isIntact: boolean | undefined = await (options.store as any).checkIntegrity?.();
      if (isIntact === false) {
        logger.warn(
          "Vector store data integrity check failed — data files are missing " +
          `(${existingCount} chunks in manifest but store can't be read). Re-indexing all files.`
        );
        for (const key of Object.keys(manifest.files)) {
          delete manifest.files[key];
        }
        manifest.lastIndexedAt = undefined;
        manifestStatus = "missing";
      }
    } catch {
      // checkIntegrity not available (older VectorStore impl) — skip
    }
  }

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

  // Effective store used throughout the pass — may be a temp store for atomic rebuild.
  let effectiveStore: VectorStore = options.store;
  let tempStorePath: string | undefined;

  if (options.force || (manifestStatus !== "ok" && existingCount > 0)) {
    for (const key of Object.keys(manifest.files)) {
      delete manifest.files[key];
    }
    manifest.lastIndexedAt = undefined;
    rebuildPerformed = existingCount > 0 || !!options.force;
    if (manifestStatus !== "ok" && existingCount > 0) {
      logger.warn("Manifest missing or corrupt; rebuilding full index.");
    }
    manifestStatus = options.force ? "missing" : manifestStatus;

    // Build the new index into a temporary store first, then atomically
    // swap on completion.  Original data stays untouched if the process
    // is aborted (Ctrl+C, crash) before the swap completes.
    if (options.dimension) {
      tempStorePath = options.storePath + "_tmp";
      try { await fs.rm(tempStorePath, { recursive: true, force: true }); } catch { /* may not exist */ }
      effectiveStore = createVectorStore(options.config, tempStorePath, options.dimension);
      logger.debug(`Rebuilding index in temporary store at ${tempStorePath}`);
      // Only clear the shared in-memory keyword index once the rebuild is
      // guaranteed to proceed — the guard below may still bail out, and
      // clearing it there would degrade live hybrid search for nothing.
      options.keywordIndex?.clear();
    } else if (existingCount > 0) {
      // NEVER destroy existing data when we can't do an atomic rebuild.
      // Abort and ask the user to run 'opencode-rag index --force' manually.
      logger.warn(
        "Cannot rebuild safely without embedding dimension — aborting to protect existing data. " +
        "Run 'opencode-rag index --force' manually to rebuild."
      );
      // Restore manifest entries we just deleted so the next pass can retry incrementally
      return createIndexStats(workspaceFiles.length, manifestStatus);
    } else {
      // No existing data — safe to proceed with in-place indexing (no clear needed)
      options.keywordIndex?.clear();
      logger.debug("No existing data; indexing from scratch.");
    }
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
          await effectiveStore.deleteByFilePath(p);
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

  const limit = pLimit(options.config.indexing.concurrency);
  const deferDescriptions = !!options.descriptionProvider;

  const activeCount = workspaceFiles.filter(
    (f) => !f.isEmpty && !f.isTooSmall && (!manifest.files[f.normalizedPath] || manifest.files[f.normalizedPath]!.hash !== f.hash),
  ).length;
  logger.info(`Chunking ${activeCount} file(s)...`);

  let chunkedDone = 0;
  const chunkProgressInterval = Math.max(1, Math.floor(activeCount / 20));
  const chunkPhaseStart = Date.now();

  /** Chunk one window of files (used by the windowed pipeline loop below). */
  async function prepareWindow(windowFiles: import("../content/reader.js").WorkspaceFile[]): Promise<PreparedFile[]> {
    const prepared = await Promise.all(
      windowFiles.map((file) =>
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
            descHash,
          );

          if (isActive) {
            chunkedDone++;
            if (chunkedDone % chunkProgressInterval === 0 || chunkedDone === activeCount) {
              const pct = ((chunkedDone / activeCount) * 100).toFixed(1);
              logger.info(`  Chunking: ${chunkedDone}/${activeCount} files (${pct}%)`);
            }
          }

          if (prep.earlyResult && isActive) {
            options.progress?.finishFile(fileLabel);
          }

          return prep;
        }),
      ),
    );
    return prepared;
  }

  const aborted = (): boolean => options.abortSignal?.aborted ?? false;

  // Shared progress logger: "stage <file> (chunk i/n) — X/total remaining (P%)".
  const logChunkProgress = (
    stage: string,
    fileLabel: string,
    index: number,
    count: number,
    completed: number,
    total: number,
  ): void => {
    const remaining = total - completed;
    const pct = total > 0 ? ((remaining / total) * 100).toFixed(1) : "0.0";
    logger.info(`${stage} ${fileLabel} (chunk ${index}/${count}) — ${remaining}/${total} remaining (${pct}%)`);
  };

  // File metadata look-up for manifest entries
  const fileMeta = new Map(workspaceFiles.map((f) => [f.normalizedPath, { mtime: f.mtime, size: f.size }]));

  // Serialised manifest-save queue — prevents concurrent write races and acts
  // as a checkpoint for Ctrl+C resilience.  Each worker appends to this chain
  // after a successful store, so previously completed files are never lost.
  // During a temp-store rebuild, saves go to the temp path so the real
  // manifest stays consistent with the real store if the process is aborted.
  const manifestTargetPath = (): string => tempStorePath ?? options.storePath;
  let manifestSaveChain = Promise.resolve<void>(undefined);
  function enqueueManifestSave(): void {
    manifestSaveChain = manifestSaveChain.then(() =>
      saveManifest(manifestTargetPath(), manifest).catch((err) => {
        options.logger?.warn?.(`Failed to save manifest: ${(err as Error).message}`);
      }),
    );
  }

  /**
   * Store one window's prepared files into the vector store and update the
   * manifest. Runs as a standalone async step so the caller can overlap it
   * with the next window's prepare/describe/embed phases (the store phase is
   * I/O-bound; the embed phase is GPU/API-bound).
   *
   * All chunks in the window are written in ONE bulk transaction (a single
   * table.add plus one delete per modified file) instead of per-file adds
   * plus per-startLine deletes.  Per-file transactions caused LanceDB
   * version-manifest accumulation (K+2 versions per file) that made the
   * store phase degrade quadratically as the index grew.
   */
  async function storeWindow(prepared: PreparedFile[]): Promise<void> {
    const filesToStore = prepared.filter((p) => !earlyWorkerResults.has(prepared.indexOf(p)) && p.chunks && (p.textToEmbed?.length ?? 0) > 0).length;
    const storePhaseStart = Date.now();
    logger.info(`Store phase: storing ${filesToStore} file(s) into vector database...`);
    let storedFiles = 0;

    // Compute per-file store payloads first (pure computation, no I/O).
    const storePayloads: Array<{ prep: PreparedFile; validChunks: Chunk[]; allEmbedded: boolean }> = [];
    for (const prep of prepared) {
      if (aborted()) break;
      if (earlyWorkerResults.has(prepared.indexOf(prep))) continue;
      if (!prep.chunks || prep.textToEmbed?.length === 0) continue;
      const validChunks = (prep.chunks ?? []).filter(
        (c) => c.embedding && c.embedding.length > 0,
      );
      // Partial embed failure: some chunks have no vector. Do NOT record the
      // file as complete — keep the previous manifest entry (or none, for
      // new files) so the next pass retries the missing chunks.
      const allEmbedded = validChunks.length === (prep.chunks?.length ?? 0);
      if (!allEmbedded && (prep.chunks?.length ?? 0) > 0) {
        options.logger?.warn?.(
          `  ${prep.fileLabel}: ${validChunks.length}/${prep.chunks?.length} chunks embedded — marking for retry on next pass`,
        );
      }
      storePayloads.push({ prep, validChunks, allEmbedded });
    }

    // One bulk write per window. Dedup (per-modified-file deletes) is skipped
    // when the store provably has no prior rows: during a full rebuild the
    // temp store starts empty, and on a first-time index the store counted 0
    // chunks at the start of the pass. Nothing can collide there, so the
    // delete transactions (which would each scan the table) are pure waste.
    const skipDedup = tempStorePath !== undefined || existingCount === 0;
    if (storePayloads.length > 0) {
      const bulkItems = storePayloads.map(({ validChunks }) => ({
        chunks: validChunks,
        dedup: !skipDedup,
      }));
      if (effectiveStore.addChunksBulk) {
        await effectiveStore.addChunksBulk(bulkItems);
      } else {
        // Fallback for stores without bulk-write support
        for (const item of bulkItems) {
          await effectiveStore.addChunks(item.chunks, { dedup: item.dedup });
        }
      }
    }

    // Manifest updates + progress reporting (per file, in-memory only).
    const storeResults: Array<WorkerResult | { skipped: boolean; normalizedPath: string }> = [];
    for (let fi = 0; fi < prepared.length; fi++) {
      if (aborted()) {
        storeResults.push({ normalizedPath: prepared[fi]!.normalizedPath, skipped: true } as const);
        break;
      }

      // Return early results from phase 1
      const earlyResult = earlyWorkerResults.get(fi);
      if (earlyResult) {
        storeResults.push(earlyResult);
        continue;
      }

      const prep = prepared[fi]!;
      // No-embed path (shouldn't reach here but guard anyway)
      if (!prep.chunks || prep.textToEmbed?.length === 0) {
        options.progress?.finishFile(prep.fileLabel);
        storeResults.push({
          normalizedPath: prep.normalizedPath, hash: prep.hash, chunkCount: 0,
          fileLabel: prep.fileLabel,
          isNew: false, isModified: false, isUnchanged: false, isEmpty: false,
          isTooSmall: false, isRemoved: true, hadChunks: false,
          descriptionFailed: prep.descriptionFailed,
        });
        continue;
      }

      const payload = storePayloads.find((p) => p.prep === prep);
      const validChunks = payload?.validChunks ?? [];
      const allEmbedded = payload?.allEmbedded ?? false;

      const result: WorkerResult = {
        normalizedPath: prep.normalizedPath,
        hash: prep.hash,
        chunkCount: validChunks.length,
        fileLabel: prep.fileLabel,
        isNew: !prep.isModified,
        isModified: prep.isModified,
        isUnchanged: false,
        isEmpty: false,
        isTooSmall: false,
        isRemoved: (prep.chunks?.length ?? 0) > 0 && validChunks.length === 0 ? false : validChunks.length === 0,
        hadChunks: (prep.chunks?.length ?? 0) > 0,
        descriptionFailed: prep.descriptionFailed,
        descHash: prep.descHash,
      };

      // Update manifest — only when ALL chunks were embedded. A partial
      // write must not bump the hash/chunkCount, otherwise the missing
      // chunks would never be retried (hash match on the next pass).
      if (result.chunkCount > 0 && !result.isRemoved && allEmbedded) {
        const meta = fileMeta.get(result.normalizedPath);
        const entry: {
          hash: string;
          chunkCount: number;
          indexedAt: number;
          mtime?: number;
          size?: number;
          descriptionFailed?: boolean;
          descHash?: string;
        } = {
          hash: result.hash,
          chunkCount: result.chunkCount,
          indexedAt: Date.now(),
          mtime: meta?.mtime,
          size: meta?.size,
          descriptionFailed: result.descriptionFailed,
        };
        if (result.descHash) {
          entry.descHash = result.descHash;
        }
        manifest.files[result.normalizedPath] = entry as import("../core/manifest.js").ManifestEntry;
        enqueueManifestSave();
      } else if (result.isRemoved) {
        delete manifest.files[result.normalizedPath];
        enqueueManifestSave();
      }

      options.progress?.finishFile(prep.fileLabel);
      storedFiles++;
      logChunkProgress("Storing", prep.fileLabel, storedFiles, filesToStore, storedFiles, filesToStore);
      storeResults.push(result);
    }

    const workerResults = storeResults;
    for (const r of workerResults) {
      if ((r as { skipped?: boolean }).skipped) {
        abortedInWindow = true;
        break;
      }
      allFinalResults.push(r as WorkerResult);
    }
    aggregateStats(stats, allFinalResults.slice(-workerResults.length));

    const storePhaseSec = ((Date.now() - storePhaseStart) / 1000).toFixed(1);
    logger.info(`Store phase: ${storedFiles} files stored in ${storePhaseSec}s (running total ${stats.totalChunks} chunks)`);

    // Free this window's chunk payloads so GC can reclaim them before the
    // next window is prepared.
    for (const prep of prepared) {
      prep.chunks = undefined;
      prep.textToEmbed = undefined;
    }
  }

  // ── Windowed pipeline ────────────────────────────────────────────────────
  // The prepare→describe→embed→store chain used to materialize ALL chunks,
  // embed texts, and vectors of the whole workspace simultaneously (hundreds
  // of MB on large repos). Processing bounded windows of files keeps peak
  // memory proportional to the window size instead of the workspace size.
  //
  // The store phase is launched as a non-awaited promise per window so it
  // overlaps the next window's prepare/describe/embed (the store is I/O-bound,
  // the embed is GPU/API-bound). Stores themselves stay serialized: the next
  // window's store only starts after the previous one resolves.
  const WINDOW_SIZE = Math.max(50, (options.config.indexing.concurrency ?? 4) * 10);
  const allFinalResults: WorkerResult[] = [];
  let abortedInWindow = false;
  const earlyWorkerResults = new Map<number, WorkerResult>();
  let prevStore: Promise<void> | null = null;
  let windowCount = 0;
  const optimizeInterval = options.config.indexing.optimizeIntervalWindows ?? 8;

  for (let windowStart = 0; windowStart < workspaceFiles.length; windowStart += WINDOW_SIZE) {
    if (aborted()) {
      abortedInWindow = true;
      break;
    }
    windowCount++;
    const windowFiles = workspaceFiles.slice(windowStart, windowStart + WINDOW_SIZE);
    const prepared = await prepareWindow(windowFiles);
    if (windowStart === 0) {
      const chunkPhaseSec = ((Date.now() - chunkPhaseStart) / 1000).toFixed(1);
      logger.info(`Chunking complete: ${activeCount} files in ${chunkPhaseSec}s`);
    }

  if (deferDescriptions) {
    const deferredPreps = prepared.filter((p) => p.chunks && p.chunks.length > 0 && p.relPath !== undefined);
    if (deferredPreps.length > 0) {
      const allChunks: Chunk[] = [];
      const oversizedChunks: Chunk[] = [];
      const maxContentChars = options.config.description?.maxContentChars;
      logger.info(`Description phase: ${deferredPreps.length} files with chunks to describe`);
      for (const prep of deferredPreps) {
        for (const chunk of prep.chunks!) {
          if (chunk.metadata.contentType !== "image") {
            if (maxContentChars && chunk.content.length > maxContentChars) {
              oversizedChunks.push(chunk);
            } else {
              allChunks.push(chunk);
            }
          }
        }
      }

      for (const chunk of oversizedChunks) {
        chunk.description = buildFallbackDescription(chunk);
      }

      // Per-file chunk index + label for clear progress reporting, plus a shared
      // progress logger emitting "stage <file> (chunk i/n) — X/total remaining (P%)".
      const chunkToFileLabel = new Map<string, string>();
      for (const prep of deferredPreps) {
        for (const chunk of prep.chunks ?? []) {
          chunkToFileLabel.set(chunk.id, prep.fileLabel);
        }
      }
      const chunkMeta = new Map<string, { fileLabel: string; index: number; count: number }>();
      {
        const perFileCount = new Map<string, number>();
        for (const chunk of allChunks) {
          perFileCount.set(chunk.metadata.filePath, (perFileCount.get(chunk.metadata.filePath) ?? 0) + 1);
        }
        const perFileSeen = new Map<string, number>();
        for (const chunk of allChunks) {
          const seen = perFileSeen.get(chunk.metadata.filePath) ?? 0;
          perFileSeen.set(chunk.metadata.filePath, seen + 1);
          chunkMeta.set(chunk.id, {
            fileLabel: chunkToFileLabel.get(chunk.id) ?? chunk.metadata.filePath,
            index: seen + 1,
            count: perFileCount.get(chunk.metadata.filePath) ?? 1,
          });
        }
      }

      // Advance progress to Description stage before descriptions start
      for (const prep of deferredPreps) {
        options.progress?.finishStage(prep.fileLabel);
      }

      if (allChunks.length > 0 && descHash) {
        // Check description cache first — reuse cached descriptions for unchanged chunks.
        // The key includes the chunk's file context: identical content in two
        // files must not reuse a contextually wrong description.
        const chunkContext = (c: Chunk): string => `${c.metadata.filePath}:${c.metadata.startLine}-${c.metadata.endLine}`;
        const cacheHits: Array<{ chunk: Chunk; desc: string }> = [];
        const cacheMisses: Chunk[] = [];
        for (const chunk of allChunks) {
          const cacheKey = DescriptionCache.codeKey(chunk.content, descHash, chunkContext(chunk));
          const cached = descCache.get(cacheKey);
          if (cached) {
            cacheHits.push({ chunk, desc: cached });
          } else {
            cacheMisses.push(chunk);
          }
        }

        if (cacheHits.length > 0) {
          logger.debug(`  Using ${cacheHits.length} cached descriptions`);
          for (const { chunk, desc } of cacheHits) {
            chunk.description = desc;
          }
        }

        // Build chunkId → prep map for tracking description failures per-file
        const chunkToPrep = new Map<string, (typeof deferredPreps)[number]>();
        for (const prep of deferredPreps) {
          for (const chunk of prep.chunks ?? []) {
            chunkToPrep.set(chunk.id, prep);
          }
        }

        // Process cache misses in parallel waves with throttled cache saves.
        // Parallel sub-batches reduce serial LLM turnaround time.
        // Cache saves are throttled to avoid O(n^2) full-JSON serialization I/O.
        if (cacheMisses.length > 0) {
          const totalMisses = cacheMisses.length;
          const descConcurrency = options.config.indexing.descriptionConcurrency ?? 4;
          const SUB_BATCH = 10;
          let describedDone = 0;
          let describedSinceLastSave = 0;
          const SAVE_INTERVAL = 200;

          const descLimit = pLimit(descConcurrency);
          const subBatchTasks: Array<{ i: number; chunks: Chunk[] }> = [];
          for (let i = 0; i < totalMisses; i += SUB_BATCH) {
            subBatchTasks.push({ i, chunks: cacheMisses.slice(i, i + SUB_BATCH) });
          }

          await Promise.all(
            subBatchTasks.map(({ i, chunks: subBatch }) =>
              descLimit(async () => {
                if (aborted()) return;

                try {
                  const batchResult = await options.descriptionProvider!.generateBatchDescriptions(subBatch, logger, {
                    total: totalMisses,
                    onProgress: (chunk) => {
                      describedDone++;
                      const meta = chunkMeta.get(chunk.id);
                      if (meta) logChunkProgress("Describing", meta.fileLabel, meta.index, meta.count, describedDone, totalMisses);
                    },
                  });
                  const newCacheEntries: Array<[string, string]> = [];
                  for (const chunk of subBatch) {
                    const desc = batchResult.get(chunk.id);
                    if (desc && desc.trim().length > 0) {
                      chunk.description = desc;
                      newCacheEntries.push([DescriptionCache.codeKey(chunk.content, descHash, chunkContext(chunk)), desc]);
                    }
                  }
                  if (newCacheEntries.length > 0) {
                    descCache.setMany(newCacheEntries);
                    describedSinceLastSave += newCacheEntries.length;
                    if (describedSinceLastSave >= SAVE_INTERVAL) {
                      await descCache.save();
                      describedSinceLastSave = 0;
                    }
                  }
                } catch (err) {
                  logger.warn(`  Description sub-batch failed (${i}-${i + subBatch.length}): ${(err as Error).message}`);
                  const failedPreps = new Set<(typeof deferredPreps)[number]>();
                  for (const chunk of subBatch) {
                    const prep = chunkToPrep.get(chunk.id);
                    if (prep) failedPreps.add(prep);
                  }
                  for (const prep of failedPreps) {
                    prep.descriptionFailed = true;
                  }
                }
              }),
            ),
          );

          if (describedSinceLastSave > 0) {
            await descCache.save();
          }
          logger.debug(`Descriptions generated for ${totalMisses} chunks (concurrency: ${descConcurrency})`);
        }
      } else if (allChunks.length > 0) {
        // No descHash available (no description provider) — still generate descriptions
        let describedDone = 0;
        try {
          const batchResult = await options.descriptionProvider!.generateBatchDescriptions(allChunks, logger, {
            total: allChunks.length,
            onProgress: (chunk) => {
              describedDone++;
              const meta = chunkMeta.get(chunk.id);
              if (meta) logChunkProgress("Describing", meta.fileLabel, meta.index, meta.count, describedDone, allChunks.length);
            },
          });
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

      for (const prep of deferredPreps) {
        prep.textToEmbed = buildTextsToEmbed(
          prep.chunks!,
          prep.relPath!,
          prep.metaHeader ?? "",
          prep.docPrefix ?? "",
          prep.isImageFile ?? false,
        );
      }
      const totalDescribedChunks = deferredPreps.reduce((s, p) => s + (p.chunks?.length ?? 0), 0);
      logger.info(`Description phase complete: ${totalDescribedChunks} chunks across ${deferredPreps.length} files`);
    }
  }

  // Cross-file embedding batch: collect this window's texts into a single queue,
  // embed in one batched call (with concurrency), then distribute back.
  const isOllama = options.embedder.name === "ollama";
  const defaultBatchSize = options.config.indexing.embedBatchSize;
  const defaultConcurrency = options.config.indexing.embedConcurrency ?? 1;

  // ── Phase 1: Collect embed queue + handle early results ────────────────
  const embedQueue: Array<{ fileIdx: number; chunkIdx: number; text: string }> = [];
  let totalEmbedChunks = 0;
  earlyWorkerResults.clear();

  for (let fi = 0; fi < prepared.length; fi++) {
    const prep = prepared[fi]!;

    if (prep.earlyResult) {
      if (prep.earlyResult.isRemoved) {
        await effectiveStore.deleteByFilePath(prep.normalizedPath);
        options.keywordIndex?.removeByFilePath(prep.normalizedPath);
        delete manifest.files[prep.normalizedPath];
        enqueueManifestSave();
      }
      earlyWorkerResults.set(fi, prep.earlyResult);
      continue;
    }

    if (!prep.chunks || !prep.textToEmbed || prep.textToEmbed.length === 0) {
      options.progress?.finishFile(prep.fileLabel);
      earlyWorkerResults.set(fi, {
        normalizedPath: prep.normalizedPath, hash: prep.hash, chunkCount: 0,
        fileLabel: prep.fileLabel,
        isNew: false, isModified: false, isUnchanged: false, isEmpty: false,
        isTooSmall: false, isRemoved: true, hadChunks: false,
        descriptionFailed: prep.descriptionFailed,
      });
      continue;
    }

    options.progress?.finishStage(prep.fileLabel);
    for (let ci = 0; ci < prep.textToEmbed.length; ci++) {
      embedQueue.push({ fileIdx: fi, chunkIdx: ci, text: prep.textToEmbed[ci]! });
    }
    totalEmbedChunks += prep.textToEmbed.length;
  }

  // ── Phase 2: Embed all texts in a single batched call ──────────────────
  const batchSize = isOllama
    ? Math.min(options.config.indexing.ollamaMaxBatchSize ?? 500, defaultBatchSize)
    : defaultBatchSize;

  let embeddedDone = 0;
  const allTexts = embedQueue.map(item => item.text);
  let allEmbeddings: number[][] = [];
  const embedPhaseStart = Date.now();

  if (allTexts.length > 0) {
    logger.info(`Embedding phase: ${allTexts.length} texts in batches of ${batchSize}...`);
    try {
      allEmbeddings = await embedBatch(
        options.embedder,
        allTexts,
        batchSize,
        "document",
        defaultConcurrency,
        (completed, total) => {
          embeddedDone = completed;
          logChunkProgress("Embedding", "", completed, total, embeddedDone, totalEmbedChunks);
        },
      );
      logger.info(`Embedding complete: ${allTexts.length} texts in ${((Date.now() - embedPhaseStart) / 1000).toFixed(1)}s`);
    } catch (err) {
      logger.warn(`  Global embedding failed: ${(err as Error).message}`);
      for (const { fileIdx } of embedQueue) {
        options.progress?.failFile(prepared[fileIdx]!.fileLabel);
        earlyWorkerResults.set(fileIdx, {
          normalizedPath: prepared[fileIdx]!.normalizedPath,
          hash: prepared[fileIdx]!.hash,
          chunkCount: 0, fileLabel: prepared[fileIdx]!.fileLabel,
          isNew: false, isModified: false, isUnchanged: false, isEmpty: false,
          isTooSmall: false, isRemoved: false, hadChunks: false,
          descriptionFailed: prepared[fileIdx]!.descriptionFailed,
        });
      }
      embedQueue.length = 0; // prevent double-processing in store phase
    }
  }

  // ── Distribute embeddings back to per-file chunks ─────────────────────
  for (let i = 0; i < embedQueue.length; i++) {
    const { fileIdx, chunkIdx } = embedQueue[i]!;
    const emb = allEmbeddings[i];
    const prep = prepared[fileIdx]!;
    if (prep.chunks && prep.chunks[chunkIdx] && Array.isArray(emb) && emb.length > 0 && typeof emb[0] === "number") {
      prep.chunks[chunkIdx]!.embedding = emb as number[];
    }
  }

  // ── Phase 3: Store + manifest update per file ─────────────────────────
  // The store phase is I/O-bound, so it is launched without awaiting and
  // overlaps the next window's prepare/describe/embed (GPU/API-bound)
  // phases. Stores stay serialized: the previous window's store is drained
  // before the next one starts.
  if (prevStore) await prevStore;
  prevStore = storeWindow(prepared);

  // Periodically compact fragments and prune old versions so the store
  // phase doesn't slow down as the index grows during long runs.
  if (optimizeInterval > 0 && windowCount % optimizeInterval === 0) {
    await prevStore;
    prevStore = null;
    logger.info("Optimizing vector store (mid-run compaction, pruning old versions)...");
    await effectiveStore.optimize?.(tempStorePath ? { aggressive: true } : undefined);
  }

  if (abortedInWindow) break;
  } // end windowed pipeline loop

  // Drain the final window's store before finishing.
  if (prevStore) await prevStore;

  const finalResults = allFinalResults;

  // Drain any in-flight manifest saves so all file entries are durable
  await manifestSaveChain;

  // Update mtime/size for unchanged files (speeds up the next scan)
  for (const { normalizedPath, mtime, size } of workspaceFiles) {
    const entry = manifest.files[normalizedPath];
    if (entry && (mtime !== undefined || size !== undefined)) {
      entry.mtime = mtime;
      entry.size = size;
    }
  }

  logger.info(`Index pass complete: ${stats.totalChunks} total chunks (${finalResults.length} files processed)`);

  // Update timestamps; advance lastGitCommit ONLY on a complete pass
  manifest.lastIndexedAt = Date.now();
  if (!aborted()) {
    tryUpdateLastGitCommit(options.cwd, manifest);
  }

  // ── Atomically promote temp store if a full rebuild was performed ──
  if (tempStorePath) {
    if (!aborted()) {
      try {
        await effectiveStore.close();
        await options.store.close();
        // Swap the newly-built temp directory into the real path
        await swapStoreDirectories(tempStorePath, options.storePath);
        // Re-open the original store handle so callers can search the new data
        await options.store.reopen?.(options.storePath);
        logger.debug(`Promoted temporary store ${tempStorePath} → ${options.storePath}`);
      } catch (err) {
        logger.warn(
          `Could not promote temporary store: ${(err as Error).message}. ` +
          `Original data preserved at ${options.storePath}`,
        );
        try { await fs.rm(tempStorePath, { recursive: true, force: true }); } catch {}
      }
    } else {
      // Aborted — discard temp, keep original data intact.
      // Do NOT save the manifest to the real path — the in-memory manifest
      // was cleared at rebuild start and only partially rebuilt.  The old
      // manifest on disk (at the real path) is still consistent with the
      // old store data.
      effectiveStore.close().catch(() => {});
      try { await fs.rm(tempStorePath, { recursive: true, force: true }); } catch {}
      logger.debug("Index pass cancelled; discarded temporary store.");
      // Skip final manifest/keyword save since we want the old state preserved
      await descCache.save();
      return stats;
    }
  }

  // Save manifest and keyword index (always to the real store path — after
  // a successful swap this points to the new data; after an abort it's the old).
  await saveManifest(options.storePath, manifest);
  await options.keywordIndex?.save(options.storePath);

  // Compact fragments and prune old version manifests so countRows() can't
  // hang on accumulated versions from many add/delete cycles. After a temp
  // store rebuild, optimize the reopened real store handle (the temp handle
  // was closed and its directory moved); use aggressive pruning since the
  // swapped-in store is private to this process.
  if (!aborted()) {
    logger.info("Optimizing vector store (compacting fragments, pruning old versions)...");
    const optimizeStart = Date.now();
    try {
      const optimizeTarget = tempStorePath ? options.store : effectiveStore;
      await optimizeTarget.optimize?.(tempStorePath ? { aggressive: true } : undefined);
      logger.info(`Vector store optimized in ${((Date.now() - optimizeStart) / 1000).toFixed(1)}s`);
    } catch (err) {
      logger.warn(`Vector store optimization failed: ${(err as Error).message}`);
    }
  }

  // Persist description cache
  await descCache.save();

  // Count from the store — after a successful swap, the original handle has
  // been reopened pointing to the new directory.
  try {
    stats.finalCount = await options.store.count();
  } catch {
    stats.finalCount = (tempStorePath ? 0 : stats.totalChunks);
  }
  return stats;
}

function aggregateStats(
  stats: IndexRunStats,
  results: WorkerResult[],
): void {
  for (const result of results) {
    if (result.isEmpty) {
      stats.skippedEmptyFiles++;
      if (result.isRemoved) stats.removedFiles++;
      continue;
    }
    if (result.isTooSmall) {
      stats.skippedSmallFiles++;
      if (result.isRemoved) stats.removedFiles++;
      continue;
    }
    if (result.isUnchanged) {
      stats.unchangedFiles++;
      continue;
    }
    if (result.isRemoved) {
      stats.removedFiles++;
      continue;
    }
    if (result.isModified) {
      stats.modifiedFiles++;
    } else if (result.isNew) {
      stats.newFiles++;
    }
    if (result.chunkCount > 0) {
      if (result.descriptionFailed) {
        stats.descriptionFailedFiles++;
      }
      stats.totalChunks += result.chunkCount;
      stats.batchesFlushed++;
    }
  }
}

/**
 * Build an overview of the current index health without running a full pass.
 * Scans workspace files and compares their hashes against the manifest to
 * determine how many are up-to-date vs pending re-indexing.
 *
 * @param cwd - Workspace root directory.
 * @param storePath - Path to the vector store data directory.
 * @param config - Full RAG configuration.
 * @param store - Vector store instance for chunk count.
 * @param skipScan - When true, skip the workspace file scan and only report
 *   manifest / store metadata.
 * @returns A summary of the current index status.
 */
export async function getIndexStatusSummary(
  cwd: string,
  storePath: string,
  config: RagConfig,
  store: VectorStore,
  skipScan?: boolean,
): Promise<IndexStatusSummary> {
  const loadResult = await loadManifest(storePath);
  const manifest = loadResult.manifest;
  const storeCount = await store.count();

  if (loadResult.status !== "ok") {
    return {
      manifestStatus: loadResult.status,
      manifestEntries: 0,
      upToDateFiles: 0,
      pendingFiles: 0,
      rebuildRequired: storeCount > 0,
      storeChunkCount: storeCount,
      manifestExpectedChunks: 0,
    };
  }

  let upToDateFiles = 0;
  let pendingFiles = 0;
  let manifestExpectedChunks = 0;

  if (!skipScan) {
    const workspaceFiles = await scanWorkspaceFiles(cwd, config, undefined, manifest);
    const currentPaths = new Set(workspaceFiles.map((file) => file.normalizedPath));

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

    manifestExpectedChunks = Object.values(manifest.files).reduce(
      (sum, entry) => sum + entry.chunkCount, 0
    );
  } else {
    manifestExpectedChunks = Object.values(manifest.files).reduce(
      (sum, entry) => sum + entry.chunkCount, 0
    );
  }

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
