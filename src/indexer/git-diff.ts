/**
 * @fileoverview Uses git to detect changed, deleted, and untracked files for incremental indexing.
 *
 * Every git invocation sets `windowsHide: true`. The plugin runs inside
 * OpenCode's console-less service process (`opencode serve --service`); without
 * this option Windows allocates a new visible console (a Windows Terminal
 * window/tab on systems where WT is the default terminal) for each spawn,
 * which shows up as a flickering terminal window per index pass.
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
      windowsHide: true,
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
      windowsHide: true,
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
      cwd, encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    }).trim();

    const deletedRaw = execFileSync("git", ["diff", "--name-only", "--diff-filter=D", fromCommit, "HEAD"], {
      cwd, encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
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
      cwd, encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    }).trim();
    return raw.length > 0 ? raw.split("\n") : [];
  } catch {
    return [];
  }
}

/**
 * Commit-touch timestamps derived from ONE bounded `git log` walk.
 * Used by wiki staleness: instead of one `git log -1` per sourceRef (N
 * spawns), a single history walk since the oldest review date answers
 * "which files changed, and when" for every page at once.
 */
export interface FileTouchTimestamps {
  /** File path (posix, relative to the repo root) → newest commit unix seconds. */
  timestamps: Map<string, number>;
  /** Commits actually walked (for truncation reporting). */
  commitCount: number;
  /** True when `maxCommits` was hit — the map may miss older touches. */
  truncated: boolean;
}

/**
 * Map each file touched since `sinceIso` to the timestamp of its newest
 * commit, in a single `git log --name-only` walk.
 *
 * @param cwd - A path inside the repository.
 * @param sinceIso - ISO date lower bound (validated `YYYY-MM-DD…` only, so a
 *   crafted value can never inject git options via argv).
 * @param maxCommits - Upper bound on walked commits.
 * @returns The touch map, or `null` when git fails or the input is invalid.
 */
export function getFileTouchTimestamps(
  cwd: string,
  sinceIso: string,
  maxCommits: number,
): FileTouchTimestamps | null {
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(sinceIso)) return null;
  if (!Number.isInteger(maxCommits) || maxCommits < 1 || maxCommits > 20000) return null;
  try {
    const raw = execFileSync(
      "git",
      [
        "-c", "core.quotePath=false",
        "log",
        `--since=${sinceIso}`,
        `--max-count=${maxCommits}`,
        "--name-only",
        "--pretty=format:%x1f%ct",
      ],
      { cwd, encoding: "utf-8", timeout: 15000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );

    const timestamps = new Map<string, number>();
    let commitCount = 0;
    let currentTs = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith("\x1f")) {
        currentTs = Number(line.slice(1).trim());
        commitCount++;
        continue;
      }
      const file = line.trim();
      if (file.length === 0 || currentTs === 0) continue;
      const existing = timestamps.get(file);
      // --since walks newest-first: first touch wins; max() is belt-and-braces.
      if (existing === undefined || currentTs > existing) timestamps.set(file, currentTs);
    }
    return { timestamps, commitCount, truncated: commitCount >= maxCommits };
  } catch {
    return null;
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
      cwd, encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    }).trim();

    const deletedRaw = execFileSync("git", ["diff", "--name-only", "--diff-filter=D", "HEAD"], {
      cwd, encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    }).trim();

    const untrackedRaw = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd, encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    }).trim();

    const changedFiles = modifiedRaw.length > 0 ? modifiedRaw.split("\n") : [];
    const deletedFiles = deletedRaw.length > 0 ? deletedRaw.split("\n") : [];
    const untrackedFiles = untrackedRaw.length > 0 ? untrackedRaw.split("\n") : [];

    return { changedFiles, deletedFiles, untrackedFiles };
  } catch {
    return null;
  }
}
