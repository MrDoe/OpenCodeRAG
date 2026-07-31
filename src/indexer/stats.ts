/**
 * @fileoverview Tracks and summarizes index run statistics and health status.
 */
/** Aggregate statistics collected during a single index pass. */
export interface IndexRunStats {
  /** Total number of files discovered in the workspace. */
  totalFiles: number;
  /** Files that are new (no prior manifest entry). */
  newFiles: number;
  /** Files whose content hash differs from the manifest. */
  modifiedFiles: number;
  /** Files whose hash matches the manifest. */
  unchangedFiles: number;
  /** Files that were deleted from the store during this pass. */
  deletedFiles: number;
  /** Files whose manifest entry was removed. */
  removedFiles: number;
  /** Files skipped because they are empty. */
  skippedEmptyFiles: number;
  /** Files skipped because they are too small to chunk. */
  skippedSmallFiles: number;
  /** Total number of chunks produced across all processed files. */
  totalChunks: number;
  /** Final chunk count in the store after the pass completes. */
  finalCount: number;
  /** Status of the manifest file when loaded. */
  manifestStatus: "ok" | "missing" | "corrupt";
  /** Whether a full index rebuild was performed. */
  rebuildPerformed: boolean;
  /** Number of batches flushed (one per file with chunks). */
  batchesFlushed: number;
  /** Number of files that failed content extraction. */
  extractionFailures: number;
  /** Detailed extraction error information. */
  extractionErrors: Array<{ filePath: string; error: string }>;
  /** Number of files where description generation failed. */
  descriptionFailedFiles: number;
  /** True when the pass was skipped because another pass holds the lock. */
  skipped: boolean;
}

/** Summary of the current index health without running a full pass. */
export interface IndexStatusSummary {
  /** Status of the manifest file. */
  manifestStatus: "ok" | "missing" | "corrupt";
  /** Number of file entries in the manifest. */
  manifestEntries: number;
  /** Files whose hash matches the manifest (up-to-date). */
  upToDateFiles: number;
  /** Files that need indexing (new, modified, or stale). */
  pendingFiles: number;
  /** Timestamp of the last successful index pass, if any. */
  lastIndexedAt?: number;
  /** Whether a full rebuild is required (e.g. store exists but manifest does not). */
  rebuildRequired: boolean;
  /** Number of chunks currently stored. */
  storeChunkCount: number;
  /** Number of chunks the manifest expects. */
  manifestExpectedChunks: number;
}

/**
 * Create a zeroed-out {@link IndexRunStats} instance initialised with the
 * given total file count and manifest status.
 *
 * @param totalFiles     - Total number of workspace files discovered.
 * @param manifestStatus - Initial manifest status.
 * @returns A fresh stats object with all counters set to zero.
 */
export function createIndexStats(
  totalFiles: number,
  manifestStatus: IndexRunStats["manifestStatus"],
): IndexRunStats {
  return {
    totalFiles,
    newFiles: 0,
    modifiedFiles: 0,
    unchangedFiles: 0,
    deletedFiles: 0,
    removedFiles: 0,
    skippedEmptyFiles: 0,
    skippedSmallFiles: 0,
    totalChunks: 0,
    finalCount: 0,
    manifestStatus,
    rebuildPerformed: false,
    batchesFlushed: 0,
    extractionFailures: 0,
    extractionErrors: [],
    descriptionFailedFiles: 0,
    skipped: false,
  };
}
