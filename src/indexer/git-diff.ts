/**
 * @fileoverview Uses git to detect changed, deleted, and untracked files for incremental indexing.
 */
import { execFileSync } from "node:child_process";

/** Result of comparing the working tree against a prior commit. */
export interface GitDiffResult {
  changedFiles: string[];
  deletedFiles: string[];
  currentCommit: string;
}

/**
 * Resolve the root directory of the git repository containing `cwd`.
 *
 * @param cwd - A path inside the repository.
 * @returns The absolute repository root path, or `null` if not a git repo.
 */
export function getRepoRoot(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Get the full SHA of the current HEAD commit.
 *
 * @param cwd - A path inside the repository.
 * @returns The commit SHA, or `null` on failure.
 */
export function getCurrentCommit(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * List changed, added, and deleted files between `fromCommit` and HEAD.
 *
 * @param cwd - A path inside the repository.
 * @param fromCommit - The commit SHA to diff against.
 * @returns A diff result, or `null` if the git command fails or the commit is invalid.
 */
export function getChangedFilesSince(
  cwd: string,
  fromCommit: string,
): GitDiffResult | null {
  // The commit value originates from a manifest file — validate it strictly
  // so a crafted manifest can never inject git options via argv.
  if (!/^[0-9a-f]{7,40}$/i.test(fromCommit)) return null;
  try {
    const changedRaw = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMRT", fromCommit, "HEAD"], {
      cwd, encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    const deletedRaw = execFileSync("git", ["diff", "--name-only", "--diff-filter=D", fromCommit, "HEAD"], {
      cwd, encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    const changedFiles = changedRaw.length > 0 ? changedRaw.split("\n") : [];
    const deletedFiles = deletedRaw.length > 0 ? deletedRaw.split("\n") : [];

    const currentCommit = getCurrentCommit(cwd);
    if (!currentCommit) return null;

    return { changedFiles, deletedFiles, currentCommit };
  } catch {
    return null;
  }
}

/**
 * List untracked files in the repository, respecting .gitignore rules.
 *
 * @param cwd - A path inside the repository.
 * @returns An array of untracked file paths (relative to repo root).
 */
export function getUntrackedFiles(cwd: string): string[] {
  try {
    const raw = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd, encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return raw.length > 0 ? raw.split("\n") : [];
  } catch {
    return [];
  }
}

/** Result of comparing the working tree against HEAD. */
export interface WorkingTreeChanges {
  /** Modified/renamed tracked files (unstaged + staged but not committed). */
  changedFiles: string[];
  /** Deleted tracked files (relative to repo root). */
  deletedFiles: string[];
  /** Untracked files respecting .gitignore (relative to repo root). */
  untrackedFiles: string[];
}

/**
 * Detect uncommitted working-tree changes by comparing against HEAD.
 * Uses `git diff-index` for tracked file modifications, `git diff --diff-filter=D`
 * for deleted files, and `git ls-files --others` for untracked files.
 *
 * @param cwd - A path inside the repository.
 * @returns Working-tree changes, or `null` if not a git repo.
 */
export function getWorkingTreeChanges(cwd: string): WorkingTreeChanges | null {
  try {
    const modifiedRaw = execFileSync("git", ["diff-index", "--name-only", "-M", "HEAD"], {
      cwd, encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    const deletedRaw = execFileSync("git", ["diff", "--name-only", "--diff-filter=D", "HEAD"], {
      cwd, encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    const untrackedRaw = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd, encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    const changedFiles = modifiedRaw.length > 0 ? modifiedRaw.split("\n") : [];
    const deletedFiles = deletedRaw.length > 0 ? deletedRaw.split("\n") : [];
    const untrackedFiles = untrackedRaw.length > 0 ? untrackedRaw.split("\n") : [];

    return { changedFiles, deletedFiles, untrackedFiles };
  } catch {
    return null;
  }
}
