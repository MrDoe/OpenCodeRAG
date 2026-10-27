/**
 * @fileoverview Whole-pass progress accounting for a single index run.
 *
 * Every progress line the `index` command prints reports ONE percentage:
 * the fraction of the WHOLE pass completed — never a per-chunk or
 * per-stage fraction. This module owns that accounting; the pipeline
 * threads a `WindowProgress` handle through the chunk/describe/embed/store
 * stages of each window and emits lines via the shared `logProgress`
 * helper in pipeline.ts.
 */

/** One of the four equal stages every active file passes through. */
const QUARTER = 0.25;

/** Stage names that report a done/total fraction (chunking counts files directly). */
export type ProgressStage = "describe" | "embed" | "store";

/**
 * Tracks the progress of one full index pass in file units.
 *
 * Every active (new or modified, non-empty, large-enough) file contributes
 * one unit, split into four equal credits: chunked, described, embedded,
 * stored. Credits are pushed by `WindowProgress` handles as their window
 * advances, so `percent` rises monotonically from 0 toward 100 across ALL
 * windows and stages — unlike the old per-stage "remaining" percentage
 * that counted down and restarted inside every window.
 *
 * Files are weighted equally regardless of chunk count: the percentage is
 * an honest estimate of "how far through the run are we", not a precise
 * work-meter.
 */
export class PassProgress {
  private credited = 0;

  /** @param totalFiles - Total number of active files the pass will process. */
  constructor(readonly totalFiles: number) {}

  /**
   * Start accounting for one processing window.
   * @param activeFiles - How many of the window's files are active (the same
   *   predicate that produced `totalFiles`). Windows with 0 active files
   *   contribute nothing to the percentage.
   */
  beginWindow(activeFiles: number): WindowProgress {
    return new WindowProgress(this, activeFiles);
  }

  /** @internal Called by {@link WindowProgress} to push credit into the pass total. */
  push(credit: number): void {
    this.credited += credit;
  }

  /** Whole-pass percentage, 0–100, clamped. */
  get percent(): number {
    if (this.totalFiles <= 0) return 100;
    return Math.min(100, (this.credited / this.totalFiles) * 100);
  }

  /** Formatted percentage ("42.3%") for progress lines. */
  get label(): string {
    return `${this.percent.toFixed(1)}%`;
  }
}

/**
 * Credit handle for one window of the windowed pipeline. The pipeline
 * reports each stage's done/total fraction here; the handle converts it to
 * whole-pass credit by scaling with the window's active-file count.
 *
 * All updates are clamped to move FORWARD only, so repeated, out-of-order,
 * or overlapping callbacks (concurrent embed sub-batches, the store phase
 * still running while the next window prepares) can never make the overall
 * percentage go backwards.
 */
export class WindowProgress {
  private done: Record<"chunk" | ProgressStage, number> = {
    chunk: 0,
    describe: 0,
    embed: 0,
    store: 0,
  };
  private chunkedFiles = 0;

  constructor(
    private readonly owner: PassProgress,
    readonly files: number,
  ) {}

  /** Fold the stage-fraction delta into the pass total (forward-only). */
  private advance(stage: "chunk" | ProgressStage, fraction: number): void {
    if (this.files <= 0) return;
    let target = fraction;
    if (!Number.isFinite(target)) target = 1;
    target = Math.min(1, Math.max(0, target));
    if (target <= this.done[stage]) return;
    this.owner.push((target - this.done[stage]) * QUARTER * this.files);
    this.done[stage] = target;
  }

  /** One of this window's active files finished chunking. */
  chunkFile(): void {
    this.chunkedFiles = Math.min(this.files, this.chunkedFiles + 1);
    this.advance("chunk", this.chunkedFiles / this.files);
  }

  /**
   * Report live progress of a per-stage work queue (described texts,
   * embedded texts, stored files). `total` 0 means the stage had no work for
   * this window (early-result files, full description-cache hits, a skipped
   * stage) and fills the stage's credit immediately.
   */
  stage(stage: ProgressStage, done: number, total: number): void {
    this.advance(stage, total > 0 ? done / total : 1);
  }

  /** Mark a stage complete regardless of its counters (stage done, skipped, or failed). */
  fill(stage: ProgressStage): void {
    this.advance(stage, 1);
  }
}
