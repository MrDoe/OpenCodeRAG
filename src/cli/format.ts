/**
 * @fileoverview CLI formatting helpers, color palette, logging utilities, context resolution, and result formatting.
 */
/**
 * CLI formatting helpers — color palette, logging utilities, context resolution,
 * and result formatting functions shared across all CLI command modules.
 */

import pc from "picocolors";
import { resolveRagContext, type BootstrapOptions, type RagContext } from "../core/bootstrap.js";
import { destroyAllPooledConnections } from "../embedder/http.js";
import { appendDebugLog } from "../core/fileLogger.js";
import type { RagConfig } from "../core/config.js";
import type { SearchResult } from "../core/interfaces.js";
import type { IndexRunStats } from "../indexer.js";
import type { CliOptions } from "./types.js";

// ── Color palette ───────────────────────────────────────────────

/**
 * Semantic color helpers for consistent CLI output styling.
 *
 * Each property wraps a {@link picocolors} function to provide semantic naming
 * (e.g. `c.file` for file paths, `c.error` for errors) so that color choices
 * can be changed in one place without updating every call site.
 */
export const c = {
  /** Bold cyan — used for section headings. */
  heading: (s: string) => pc.bold(pc.cyan(s)),
  /** Dim text — used for labels and secondary information. */
  label: (s: string) => pc.dim(s),
  /** Dim text — alias for `label`, used for inline dimming. */
  dim: (s: string) => pc.dim(s),
  /** Green text — used for positive values and success states. */
  value: (s: string) => pc.green(s),
  /** Green text — formats numbers as strings for inline display. */
  num: (s: string | number) => pc.green(String(s)),
  /** Yellow text — used for file paths. */
  file: (s: string) => pc.yellow(s),
  /** Cyan text — used for language names and matched terms. */
  lang: (s: string) => pc.cyan(s),
  /** Magenta text — used for relevance scores. */
  score: (s: string) => pc.magenta(s),
  /** Dim text — used for chunk descriptions. */
  desc: (s: string) => pc.dim(s),
  /** Green text — used for success messages. */
  success: (s: string) => pc.green(s),
  /** Yellow text — used for warnings. */
  warn: (s: string) => pc.yellow(s),
  /** Red text — used for error messages. */
  error: (s: string) => pc.red(s),
  /** Green text — used for "enabled" status indicators. */
  enabled: (s: string) => pc.green(s),
  /** Yellow text — used for "disabled" status indicators. */
  disabled: (s: string) => pc.yellow(s),
  /** Green text — used for "created" file status. */
  created: (s: string) => pc.green(s),
  /** Yellow text — used for "updated" file status. */
  updated: (s: string) => pc.yellow(s),
  /** Dim text — used for "already exists" file status. */
  exists: (s: string) => pc.dim(s),
};

// ── Logging helpers ─────────────────────────────────────────────

/**
 * Log an error message to stderr and optionally append to the debug log.
 *
 * @param logFilePath - Absolute path to the debug log file.
 * @param scope - Logical scope (e.g. "index", "query") for log filtering.
 * @param message - Human-readable error message.
 * @param error - Optional error object for structured logging.
 */
export function logCliError(
  logFilePath: string,
  scope: string,
  message: string,
  error?: unknown,
): void {
  console.error(c.error(message));
  appendDebugLog(logFilePath, { scope, message, error });
}

/**
 * Log an informational message to stdout and optionally append to the debug log.
 *
 * @param logFilePath - Absolute path to the debug log file.
 * @param scope - Logical scope (e.g. "index", "query") for log filtering.
 * @param message - Human-readable info message.
 */
export function logCliInfo(
  logFilePath: string,
  scope: string,
  message: string,
): void {
  console.log(message);
  appendDebugLog(logFilePath, { scope, message });
}

// ── Context resolution ──────────────────────────────────────────

/**
 * Resolve a full `RagContext` from CLI options and log the config details.
 *
 * Wraps `resolveRagContext` from the bootstrap module with CLI-specific logging.
 *
 * @param opt - Parsed CLI options (may include a `--config` path).
 * @param logFilePath - Path to the debug log file for config logging.
 * @returns A fully initialized `RagContext` with store, embedder, and keyword index.
 */
export async function resolveCliContext(
  opt: CliOptions,
  logFilePath: string,
  bootstrapOpts?: Partial<BootstrapOptions>,
): Promise<RagContext> {
  const ctx = await resolveRagContext({
    configPath: opt.config,
    ...bootstrapOpts,
  });
  logCliInfo(logFilePath, "config", `${c.label("Config:")} ${c.file(ctx.logFilePath)}`);
  logConfigDetails(logFilePath, ctx.config);
  return ctx;
}

/**
 * Print embedding and vector store configuration to stdout.
 *
 * @param logFilePath - Path to the debug log file.
 * @param config - The resolved `RagConfig` to display.
 */
function logConfigDetails(logFilePath: string, config: RagConfig): void {
  logCliInfo(logFilePath, "config", `  ${c.label("Embedding provider:")} ${c.value(config.embedding.provider)}`);
  logCliInfo(logFilePath, "config", `  ${c.label("Embedding model:")}    ${c.value(config.embedding.model)}`);
  logCliInfo(logFilePath, "config", `  ${c.label("Vector store:")}       ${c.file(config.vectorStore.path)}`);
}

/**
 * Gracefully close a `RagContext` — closes the vector store and destroys pooled HTTP connections.
 *
 * The store close is raced against a timeout because LanceDB's native `close()`
 * can hang indefinitely on Windows; callers must never be blocked forever.
 *
 * @param ctx - The `RagContext` to clean up.
 */
export async function cleanupContext(ctx: RagContext): Promise<void> {
  await Promise.race([
    ctx.store.close(),
    new Promise<void>((resolve) => {
      setTimeout(resolve, 5000).unref();
    }),
  ]);
  destroyAllPooledConnections();
}

// ── Formatting helpers ──────────────────────────────────────────

/**
 * Format a Unix timestamp (milliseconds) into a human-readable locale string.
 *
 * @param timestamp - Unix timestamp in milliseconds, or `undefined` for "never".
 * @returns A localized date string, or `"never"` if the timestamp is falsy.
 */
export function formatTimestamp(timestamp?: number): string {
  if (!timestamp) return "never";
  return new Date(timestamp).toLocaleString();
}

/**
 * Print an indexing pass summary to stdout.
 *
 * @param logFilePath - Path to the debug log file.
 * @param stats - Statistics from a single indexing pass.
 */
export function logIndexSummary(logFilePath: string, stats: IndexRunStats): void {
  logCliInfo(logFilePath, "index", `  ${c.label("New:")}              ${c.num(stats.newFiles)}`);
  logCliInfo(logFilePath, "index", `  ${c.label("Modified:")}         ${c.num(stats.modifiedFiles)}`);
  logCliInfo(logFilePath, "index", `  ${c.label("Unchanged:")}        ${c.num(stats.unchangedFiles)}`);
  logCliInfo(logFilePath, "index", `  ${c.label("Deleted:")}          ${c.num(stats.deletedFiles)}`);
  logCliInfo(logFilePath, "index", `  ${c.label("Removed:")}          ${c.num(stats.removedFiles)}`);
  logCliInfo(logFilePath, "index", `  ${c.label("Empty skipped:")}    ${c.num(stats.skippedEmptyFiles)}`);
  logCliInfo(logFilePath, "index", `  ${c.label("Small skipped:")}    ${c.num(stats.skippedSmallFiles)}`);
  if (stats.descriptionFailedFiles > 0) {
    logCliInfo(logFilePath, "index", `  ${c.label("Desc failed:")}     ${c.num(stats.descriptionFailedFiles)}`);
  }
  logCliInfo(logFilePath, "index", `  ${c.label("Chunks written:")}   ${c.num(stats.totalChunks)}`);
}

/**
 * Format a millisecond duration into a compact human-readable string.
 *
 * @param ms - Duration in milliseconds.
 * @returns A string like `"3.2s"` or `"2m 15s"`.
 */
export function formatDuration(ms: number): string {
  const seconds = (ms / 1000).toFixed(1);
  if (ms < 60000) return `${seconds}s`;
  const minutes = Math.floor(ms / 60000);
  const secs = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}m ${secs}s`;
}

/**
 * Remove duplicate search results based on file path, line range, and content.
 *
 * @param results - Raw search results that may contain duplicates.
 * @returns Deduplicated search results preserving original order.
 */
export function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const result of results) {
    const chunk = result.chunk;
    const key = [
      chunk.metadata.filePath,
      chunk.metadata.startLine,
      chunk.metadata.endLine,
      chunk.content,
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(result);
  }
  return deduped;
}
