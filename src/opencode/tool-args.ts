/**
 * @fileoverview Normalizes and validates read tool arguments, and resolves file paths relative to the workspace root.
 */

import path from "node:path";
import { realpathSync } from "node:fs";

/**
 * Raw argument variants accepted by the read tool.
 */
export interface RawReadArgs {
  filePath?: string;
  path?: string;
  absolutePath?: string;

  offset?: number;
  limit?: number;

  startLine?: number;
  endLine?: number;

  query?: string;
  reason?: string;
}

/**
 * Normalized internal shape for read request handling.
 */
export interface NormalizedReadArgs {
  filePath: string;
  startLine?: number;
  endLine?: number;
  query?: string;
}

/**
 * Normalize raw read tool arguments into a consistent internal shape.
 *
 * Accepts:
 *   - filePath / path / absolutePath
 *   - offset + limit (converted to startLine + endLine)
 *   - startLine / endLine (passthrough)
 *   - query / reason (passthrough)
 *
 * Validates:
 *   - A file path is required.
 *   - startLine/offset must be >= 1 when provided.
 *   - endLine must be >= 1 when provided.
 *   - endLine must be >= startLine when both are provided.
 */
export function normalizeReadArgs(args: RawReadArgs): NormalizedReadArgs {
  const filePath = args.filePath ?? args.path ?? args.absolutePath;

  const startLine =
    args.startLine ?? (args.offset !== undefined ? args.offset : undefined);

  const endLine =
    args.endLine ??
    (args.offset !== undefined && args.limit !== undefined
      ? args.offset + args.limit - 1
      : undefined);

  const query = args.query ?? args.reason;

  if (!filePath) {
    throw new Error("read requires filePath, path, or absolutePath");
  }

  if (startLine !== undefined && startLine < 1) {
    throw new Error("startLine/offset must be >= 1");
  }

  if (endLine !== undefined && endLine < 1) {
    throw new Error("endLine must be >= 1");
  }

  if (
    startLine !== undefined &&
    endLine !== undefined &&
    endLine < startLine
  ) {
    throw new Error("endLine must be greater than or equal to startLine");
  }

  return { filePath, startLine, endLine, query };
}

/**
 * Resolve a file path relative to the workspace root.
 *
 * Rules:
 *   - Absolute paths are normalized.
 *   - Relative paths are resolved relative to worktree.
 *   - The resolved path must be inside the workspace.
 *   - Returns absolute path with forward slashes.
 *
 * Throws if the path resolves outside the workspace.
 */
export function resolveWorkspacePath(
  worktree: string,
  inputPath: string
): string {
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(worktree, inputPath);

  const normalizedWorktree = path.resolve(worktree);
  const normalizedResolved = path.resolve(resolved);

  // Case-insensitive on win32: an absolute path with different casing must
  // not be falsely rejected as "outside the workspace".
  const cmp = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);

  if (
    !cmp(normalizedResolved).startsWith(cmp(normalizedWorktree) + path.sep) &&
    normalizedResolved !== normalizedWorktree
  ) {
    throw new Error(
      `read path "${inputPath}" resolves outside the workspace "${normalizedWorktree}"`
    );
  }

  // Resolve symlinks/junctions: a link INSIDE the workspace pointing outside
  // must not let the agent read arbitrary files (node_modules junctions are
  // common on Windows). realpath failure (e.g. missing file) falls back to
  // the lexical check above — the read itself will fail with ENOENT.
  try {
    const realResolved = realpathSync(normalizedResolved);
    const realWorktree = realpathSync(normalizedWorktree);
    if (
      !cmp(realResolved).startsWith(cmp(realWorktree) + path.sep) &&
      realResolved !== realWorktree
    ) {
      throw new Error(
        `read path "${inputPath}" resolves outside the workspace "${normalizedWorktree}" (via symlink "${realResolved}")`
      );
    }
  } catch (err) {
    if (err instanceof Error && /outside the workspace/.test(err.message)) {
      throw err;
    }
    // otherwise: realpath unavailable — keep the lexical result
  }

  return toForwardSlash(normalizedResolved);
}

/**
 * Convert a path to use forward slashes.
 */
function toForwardSlash(p: string): string {
  return p.replace(/\\/g, "/");
}
