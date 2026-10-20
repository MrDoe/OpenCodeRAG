/**
 * @fileoverview Repairs a keyword index that drifted behind the vector store.
 *
 * The keyword index (BM25 side of hybrid search) and the vector store are two
 * independent stores of the same corpus. Nothing keeps them in sync by
 * construction: an incremental index pass only calls `addChunks()` for the
 * files it reprocessed, so unchanged files keep whatever the *loaded* index
 * had. Once the persisted index loses entries — a crashed pass that saved a
 * cleared index, a partial indexer, a rebuild that swapped the store without
 * rewriting the sidecar — every later pass re-saves the same partial state
 * and the missing files stay unreachable through keyword search forever.
 *
 * The repair needs no re-embedding: the store already holds the chunk text
 * and descriptions, so the missing keyword entries can be rebuilt from the
 * store's own rows.
 */
import path from "node:path";
import type { KeywordIndex, VectorStore } from "../core/interfaces.js";
import { normalizeFilePath } from "../core/manifest.js";
import { QUIRK_FILE_PREFIX } from "../quirks/quirk-store.js";

/** Options for {@link rehydrateKeywordIndex}. */
export interface KeywordRehydrationOptions {
  /** The vector store holding the authoritative chunk rows. */
  store: VectorStore;
  /** The keyword index to repair. */
  keywordIndex: KeywordIndex;
  /** Optional logger (missing methods default to no-ops). */
  logger?: {
    info?(message: string): void;
    warn?(message: string): void;
    debug?(message: string): void;
  };
  /** Maximum number of files to rehydrate in one call (0/undefined = unlimited). */
  maxFiles?: number;
}

/** Outcome of a rehydration attempt. */
export interface KeywordRehydrationResult {
  /** Files present in the store with no keyword entries. */
  missingFiles: number;
  /** Files whose chunks were added to the keyword index. */
  rehydratedFiles: number;
  /** Chunks added to the keyword index. */
  rehydratedChunks: number;
  /** Chunks skipped because they were already indexed. */
  skippedChunks: number;
  /** Files that could not be rehydrated (one failure never aborts the rest). */
  failedFiles: string[];
}

/**
 * Restore the keyword entries for every file the store holds but the keyword
 * index does not.
 *
 * Quirk rows are skipped: `quirks.jsonl` owns them, and `reconcileQuirks()`
 * adds and removes them under its own rules.
 *
 * @param options - The store, the keyword index, and optional logging.
 * @returns What was missing and what was restored.
 */
export async function rehydrateKeywordIndex(
  options: KeywordRehydrationOptions,
): Promise<KeywordRehydrationResult> {
  const { store, keywordIndex, logger } = options;
  const result: KeywordRehydrationResult = {
    missingFiles: 0,
    rehydratedFiles: 0,
    rehydratedChunks: 0,
    skippedChunks: 0,
    failedFiles: [],
  };

  let storePaths: string[];
  try {
    storePaths = await store.getFilePaths();
  } catch (err) {
    logger?.warn?.(
      `Keyword rehydration skipped — could not list store files: ${(err as Error).message}`,
    );
    return result;
  }
  if (storePaths.length === 0) return result;

  const indexed = new Set(keywordIndex.getIndexedFilePaths());
  const missing = storePaths.filter((p) => {
    // Quirk rows belong to quirks.jsonl — reconcileQuirks() owns them.
    if (path.basename(p).startsWith(QUIRK_FILE_PREFIX)) return false;
    return !indexed.has(normalizeFilePath(p));
  });
  result.missingFiles = missing.length;
  if (missing.length === 0) return result;

  const maxFiles = options.maxFiles && options.maxFiles > 0 ? options.maxFiles : missing.length;
  const targets = missing.slice(0, maxFiles);
  if (targets.length < missing.length) {
    logger?.info?.(
      `Keyword rehydration: ${missing.length} file(s) missing from the keyword index — rehydrating the first ${targets.length}`,
    );
  }

  for (const filePath of targets) {
    try {
      const chunks = await store.getChunksByFilePath(filePath);
      if (chunks.length === 0) continue;
      // Guard against double counting: `addChunks()` is not idempotent for the
      // BM25 length statistics and term frequencies, so a chunk that is
      // already indexed must never be added a second time.
      const fresh = chunks.filter((c) => !keywordIndex.hasChunk(c.id));
      result.skippedChunks += chunks.length - fresh.length;
      if (fresh.length === 0) continue;
      keywordIndex.addChunks(fresh);
      result.rehydratedFiles++;
      result.rehydratedChunks += fresh.length;
    } catch (err) {
      result.failedFiles.push(filePath);
      logger?.warn?.(
        `Keyword rehydration failed for ${filePath}: ${(err as Error).message}`,
      );
    }
  }

  if (result.rehydratedFiles > 0) {
    logger?.info?.(
      `Keyword rehydration: restored ${result.rehydratedChunks} chunk(s) from ` +
      `${result.rehydratedFiles} file(s) (${result.missingFiles} file(s) were missing from the keyword index)`,
    );
  }
  return result;
}

/**
 * Compare the keyword index against the vector store without changing either.
 *
 * @param store - The vector store holding the authoritative chunk rows.
 * @param keywordIndex - The keyword index to compare.
 * @returns The files the store has that the keyword index does not cover.
 */
export async function findKeywordIndexGaps(
  store: VectorStore,
  keywordIndex: KeywordIndex,
): Promise<string[]> {
  let storePaths: string[];
  try {
    storePaths = await store.getFilePaths();
  } catch {
    return [];
  }
  const indexed = new Set(keywordIndex.getIndexedFilePaths());
  return storePaths.filter((p) => {
    if (path.basename(p).startsWith(QUIRK_FILE_PREFIX)) return false;
    return !indexed.has(normalizeFilePath(p));
  });
}
