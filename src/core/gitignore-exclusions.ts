// Translate workspace `.gitignore` exclusion patterns into the
// `indexing.excludeDirs` / `indexing.excludeFiles` vocabulary of
// `createExcludeMatcher` (see `exclude.ts`), so `opencode-rag setup` can keep
// the indexer out of exactly the trees git already ignores.
//
// Mapping rules (documented subset of gitignore - anything else is skipped):
// - Comments, blank lines and `!` negations are skipped (negations cannot be
//   expressed as exclusions).
// - Directory-shaped patterns like `foo/`, `/foo/`, `**/foo/`, `**/foo/**`,
//   `**/foo/*` become the plain basename `foo`, which `createExcludeMatcher`
//   matches at any depth - the gitignore any-depth forms map exactly,
//   root-anchored `/foo/` becomes slightly broader (any depth), which is the
//   safer direction.
// - Multi-segment patterns like `/playwright/.cache/` stay as rooted relative
//   paths (`playwright/.cache`); the matcher anchors them to the workspace
//   root.
// - A pattern ending in `/*` or `/**` describes the CONTENTS of a directory,
//   which pruning the directory achieves identically.
// - Single-segment patterns that look like files (contain a dot) go to the
//   file bucket (`*.bin`, `package-lock.json`); ambiguous ones (no dot, no
//   trailing slash) go to BOTH buckets because git matches them against files
//   and directories alike.
// - Escapes (`\#`, `\!`) are unescaped; other backslash handling is not
//   implemented - unusual gitignore syntax is skipped, not mis-imported.
//
// NOTE: keep this header in line comments - gitignore examples contain the
// `*` + `/` sequence which would close a block comment prematurely.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface GitignoreExclusions {
  /** Patterns for `indexing.excludeDirs`. */
  dirs: string[];
  /** Patterns for `indexing.excludeFiles`. */
  files: string[];
}

const GLOB_MAGIC = /[*?[\]{}]/;

/**
 * Parse `.gitignore` content into matcher-compatible exclusion patterns.
 * Results are de-duplicated (case-insensitively) and sorted for stable output.
 */
export function parseGitignoreExclusions(content: string): GitignoreExclusions {
  const dirs = new Map<string, string>(); // lowercased key -> original
  const files = new Map<string, string>();
  const put = (bucket: Map<string, string>, pattern: string): void => {
    const key = pattern.toLowerCase();
    if (!bucket.has(key)) bucket.set(key, pattern);
  };

  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("!")) continue; // negation: not expressible
    if (line.startsWith("\\#") || line.startsWith("\\!")) {
      line = line.slice(1); // escaped first char is literal
    }

    const dirHint = line.endsWith("/");
    if (dirHint) line = line.slice(0, -1);

    // Strip root anchors and any-depth markers around the core.
    let anyDepth = false;
    if (line.startsWith("**/")) {
      anyDepth = true;
      line = line.slice(3);
    } else if (line.startsWith("/")) {
      // Root-anchored. As a single segment this becomes a plain basename
      // (any depth); multi-segment cores keep their rooted path form.
      line = line.slice(1);
    }
    // Trailing content markers: `name/**` and `name/*` describe the subtree.
    let subtreeOnly = false;
    if (line.endsWith("/**") || line.endsWith("/*")) {
      subtreeOnly = true;
      line = line.replace(/\/\*\*?$/, "");
    }
    if (!line) continue;

    const isDir = dirHint || anyDepth || subtreeOnly || line.endsWith("**");
    const hasSep = line.includes("/");

    if (!hasSep) {
      if (isDir) {
        put(dirs, line);
      } else if (GLOB_MAGIC.test(line) || line.includes(".")) {
        // `*.bin`, `Thumbs.db`, `package-lock.json` -> file bucket
        put(files, line);
      } else {
        // Ambiguous (e.g. `node_modules` without slash): git matches files
        // AND directories - mirror that by adding to both buckets.
        put(dirs, line);
        put(files, line);
      }
    } else {
      const core = line.replace(/\/\*\*$/, "");
      if (isDir) {
        put(dirs, core);
      } else if (GLOB_MAGIC.test(core)) {
        put(files, core);
      } else {
        // Anchored, slash-containing, glob-free path (e.g. `a/b/c`): git
        // matches it against files and directories alike -> both buckets.
        put(dirs, core);
        put(files, core);
      }
    }
  }

  const sorted = (m: Map<string, string>): string[] =>
    [...m.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return { dirs: sorted(dirs), files: sorted(files) };
}

/**
 * Read `<workspaceDir>/.gitignore` and parse it. Returns empty lists when the
 * file does not exist or cannot be read.
 */
export function readGitignoreExclusions(workspaceDir: string): GitignoreExclusions {
  try {
    const gitignorePath = path.join(workspaceDir, ".gitignore");
    if (!existsSync(gitignorePath)) return { dirs: [], files: [] };
    return parseGitignoreExclusions(readFileSync(gitignorePath, "utf-8"));
  } catch {
    return { dirs: [], files: [] };
  }
}

/**
 * Append `derived` patterns to an existing exclusion list, preserving the
 * existing entries and their order. Comparison is case-insensitive, matching
 * the matcher's own nocase behaviour.
 */
export function mergeExclusionLists(existing: unknown[], derived: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: string): void => {
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(value);
  };
  for (const entry of existing) {
    if (typeof entry === "string" && entry.trim()) add(entry.trim());
  }
  for (const entry of derived) add(entry);
  return out;
}
