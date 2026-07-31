/**
 * @fileoverview Tracks which files have been documented during a documentation mode session.
 * Persists progress to disk so interrupted sessions can resume.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Tracks which files have been documented during a documentation mode session. */
export interface DocProgress {
  /** List of file paths that have been documented. */
  documented: string[];
  /** Unix timestamp of the last progress update. */
  lastUpdated: number;
}

const PROGRESS_FILE = "doc-mode-progress.json";

function progressPath(storePath: string): string {
  return join(storePath, PROGRESS_FILE);
}

/** Load documentation progress from the store directory. Returns empty progress if none exists. */
export function loadDocProgress(storePath: string): DocProgress {
  const filePath = progressPath(storePath);
  try {
    if (!existsSync(filePath)) return { documented: [], lastUpdated: 0 };
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as DocProgress;
  } catch {
    return { documented: [], lastUpdated: 0 };
  }
}

/** Persist documentation progress to disk. Silently ignores write errors. */
export function saveDocProgress(storePath: string, progress: DocProgress): void {
  const filePath = progressPath(storePath);
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(progress, null, 2), "utf-8");
  } catch {
    // silently ignore write errors
  }
}

/** Record a file as documented in the progress tracker. No-op if already recorded. */
export function markFileDocumented(storePath: string, filePath: string): void {
  const progress = loadDocProgress(storePath);
  if (!progress.documented.includes(filePath)) {
    progress.documented.push(filePath);
    progress.lastUpdated = Date.now();
    saveDocProgress(storePath, progress);
  }
}

/** Record all files under a subdirectory as documented. Matches files whose path starts with subdir. */
export function markSubdirectoryDocumented(storePath: string, subdir: string, allFilePaths: string[]): void {
  const normalized = subdir.replace(/\\/g, "/").replace(/\/$/, "");
  const progress = loadDocProgress(storePath);
  // Set lookups avoid the O(n·m) `includes` scan for large workspaces
  const documentedSet = new Set(progress.documented);
  let changed = false;
  for (const filePath of allFilePaths) {
    const normalizedFile = filePath.replace(/\\/g, "/");
    if (normalizedFile.startsWith(normalized + "/") || normalizedFile === normalized) {
      if (!documentedSet.has(filePath)) {
        documentedSet.add(filePath);
        changed = true;
      }
    }
  }
  if (changed) {
    progress.documented = [...documentedSet];
    progress.lastUpdated = Date.now();
    saveDocProgress(storePath, progress);
  }
}
