/**
 * @fileoverview Resolution helpers for user-supplied filesystem paths.
 */

import path from "node:path";
import { homedir } from "node:os";

/**
 * Expand a leading `~` to the current user's home directory.
 *
 * Only bare `~` and the `~/` / `~\` prefixes are expanded; `~otheruser` is
 * returned unchanged (it has no portable meaning).
 *
 * @param inputPath - The path supplied by the user.
 * @returns The path with `~` replaced by the home directory.
 */
export function expandTilde(inputPath: string): string {
  if (inputPath === "~") return homedir();
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(homedir(), inputPath.slice(2));
  }
  return inputPath;
}

/**
 * Resolve a user-supplied path against a base directory WITHOUT sandboxing it.
 *
 * Absolute paths (and `~`-prefixed paths) are used as-is; relative paths are
 * resolved against `baseDir`. Use this for read-only tools that legitimately
 * operate on files anywhere on disk (e.g. `describe_image` on a screenshot
 * outside the workspace). Do NOT use it for the workspace-sandboxed `read`
 * tool — that one must keep rejecting paths outside the workspace.
 *
 * @param baseDir - Directory used to resolve relative paths (usually the worktree).
 * @param inputPath - The path supplied by the user.
 * @returns An absolute path; no containment check is performed.
 */
export function resolveUserPath(baseDir: string, inputPath: string): string {
  const expanded = expandTilde(inputPath);
  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(baseDir, expanded);
}
