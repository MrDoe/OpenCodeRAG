/**
 * @fileoverview Re-exports indexer pipeline types and functions. Provides
 * runIndexPass, createWatchPassScheduler, createWatchIgnore, and scanWorkspace.
 */

export type { IndexRunStats, IndexStatusSummary } from "./indexer/stats.js";
export { createIndexStats } from "./indexer/stats.js";
export type { WorkspaceFile } from "./content/reader.js";
export { scanWorkspaceFiles, walkFiles } from "./content/reader.js";
export { createExcludeMatcher, type ExcludeMatcher } from "./core/exclude.js";
export type { RunIndexPassOptions, WatchPassScheduler } from "./indexer/pipeline.js";
export {
  runIndexPass,
  getIndexStatusSummary,
  createWatchPassScheduler,
  createWatchIgnore,
  type Logger,
} from "./indexer/pipeline.js";

import { scanWorkspaceFiles } from "./content/reader.js";
import type { RagConfig } from "./core/config.js";
import type { WorkspaceFile } from "./content/reader.js";

/** Minimal logger interface used by index operations. */
interface Logger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

/**
 * Scan the workspace directory for indexable files according to the given
 * configuration, returning their metadata and content.
 *
 * @param cwd   - Root directory to scan.
 * @param config - Workspace RAG configuration controlling which files are included.
 * @param logger - Optional logger for diagnostic output.
 * @returns A list of workspace file descriptors.
 */
export async function scanWorkspace(
  cwd: string,
  config: RagConfig,
  logger?: Logger,
): Promise<WorkspaceFile[]> {
  return scanWorkspaceFiles(cwd, config, logger);
}
