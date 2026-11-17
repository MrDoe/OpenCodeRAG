/**
 * @fileoverview Wiki staleness: `sourceRefs` vs git reality.
 *
 * A page is STALE when any file sourceRef was committed after the page's
 * `lastReviewed`, MISSING when the ref no longer exists (a real defect, not
 * staleness), DIRTY when the ref has uncommitted changes, and LOW-SIGNAL when
 * only refs that churn with every release (AGENTS.md, README.md, LICENSE)
 * moved — following the rules the repo's own `wiki-lint.cjs` prototype
 * measured: day-granular review cutoff, low-signal churn reported separately,
 * dead refs kept distinct from drift.
 *
 * Cost model: the git walk is ONE bounded `git log` for the whole wiki (the
 * oldest review date sets the window), plus the standard working-tree diff —
 * not one spawn per sourceRef.
 */
import { existsSync } from "node:fs";
import * as path from "node:path";
import {
  getRepoRoot,
  getWorkingTreeChanges,
  getFileTouchTimestamps,
} from "../indexer/git-diff.js";
import type { WikiGraph } from "./graph.js";

/** Refs that move with every release and carry no page-specific signal. */
export const LOW_SIGNAL_REFS: ReadonlySet<string> = new Set(["agents.md", "readme.md", "license"]);

/** Permitted staleness states of a single sourceRef. */
export type SourceRefState = "fresh" | "changed" | "dirty" | "missing" | "low-signal" | "unchecked";

/** One page's sourceRef evaluated against git + disk. */
export interface SourceRefStatus {
  /** Ref as written in the frontmatter. */
  ref: string;
  state: SourceRefState;
  /** Newest commit touching the ref (unix seconds), when known. */
  touchedAt?: number;
}

/** Staleness verdict for one wiki page. */
export interface PageStaleness {
  /** Normalized page id. */
  id: string;
  /** Raw lastReviewed value as written, if any. */
  lastReviewedRaw?: string;
  /** Parsed review date (epoch ms), if parseable. */
  lastReviewedMs?: number;
  /** Overall state: stale > missing > unchecked-lastReviewed > fresh. */
  state: "fresh" | "stale" | "missing-refs" | "unknown";
  refs: SourceRefStatus[];
}

/** Options for the staleness pass. */
export interface StalenessOptions {
  /** Max commits walked by the single `git log` (default 500, like the prototype). */
  maxCommits?: number;
  /** Page count cap already applied by the graph layer (unused here). */
  nowMs?: number;
}

/** Result of a staleness pass over a wiki graph. */
export interface StalenessResult {
  /** Per-page verdicts (content pages only). */
  pages: PageStaleness[];
  /** Human-readable caveats: not a git repo, history truncated, git failed. */
  notes: string[];
}

/**
 * Classify a sourceRef. URLs and `~`-prefixed paths are EXTERNAL to the repo:
 * git cannot judge them, so they report as `unchecked` (a `~/.config/...`
 * locator is policy-mandated on purpose — flagging it DEAD would punish the
 * no-secrets-in-docs rule). Line-range suffixes (`file.ts:12-40`) are a
 * legitimate convention: strip before existence/git checks, display as-is.
 */
function classifyRef(ref: string): "file" | "external" {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return "external";
  if (ref === "~" || ref.startsWith("~/") || ref.startsWith("~\\")) return "external";
  return "file";
}

/** Strip a trailing `:LINE` / `:FROM-TO` suffix for filesystem/git lookup. */
function stripLineSuffix(ref: string): string {
  return ref.replace(/:\d+(?:-\d+)?$/, "");
}

/** Normalize a repo path (posix, from git) for comparison. */
function norm(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** Convert a repo-root-relative path to workspace-relative posix, or null. */
function repoToWorkspace(repoRoot: string, cwd: string, repoRel: string): string | null {
  const abs = path.resolve(repoRoot, repoRel);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, "/");
}

/**
 * Compute staleness for every content page in the graph.
 *
 * @param graph - Built wiki graph (pages carry their parsed frontmatter).
 * @param cwd - Workspace root — the base sourceRefs resolve against.
 * @param options - Walk limits.
 * @returns Per-page verdicts plus operational notes.
 */
export function computeStaleness(
  graph: WikiGraph,
  cwd: string,
  options: StalenessOptions = {},
): StalenessResult {
  const notes: string[] = [];
  const nowMs = options.nowMs ?? Date.now();
  const maxCommits = options.maxCommits ?? 500;
  const contentPages = [...graph.pages.values()].filter((p) => p.isContent);

  // Window: one day before the oldest review date (all we need to compare).
  const reviewDates = contentPages
    .map((p) => p.parsed.frontmatter.lastReviewedMs)
    .filter((d): d is number => typeof d === "number");
  const windowStartMs = reviewDates.length > 0
    ? Math.min(...reviewDates) - 24 * 3600_000
    : nowMs - 90 * 24 * 3600_000; // no dates at all: last quarter
  const sinceIso = new Date(windowStartMs).toISOString().slice(0, 10);

  const repoRoot = getRepoRoot(cwd);
  let touchByWorkspacePath: Map<string, number> | null = null;
  if (repoRoot) {
    const logResult = getFileTouchTimestamps(cwd, sinceIso, maxCommits);
    if (logResult) {
      touchByWorkspacePath = new Map();
      for (const [repoRel, ts] of logResult.timestamps) {
        const wsRel = repoToWorkspace(repoRoot, cwd, repoRel);
        if (wsRel === null) continue;
        const existing = touchByWorkspacePath.get(wsRel.toLowerCase());
        if (existing === undefined || ts > existing) touchByWorkspacePath.set(wsRel.toLowerCase(), ts);
      }
      if (logResult.truncated) {
        notes.push(`git history walk hit the ${maxCommits}-commit cap — older changes may be unreported`);
      }
    } else {
      notes.push("git log walk failed — staleness falls back to disk-existence checks only");
    }
  } else {
    notes.push("workspace is not a git repository — staleness falls back to disk-existence checks only");
  }

  // Uncommitted drift counts too: a modified/untracked source is unreviewed.
  const dirtySet = new Set<string>();
  if (repoRoot) {
    const wt = getWorkingTreeChanges(cwd);
    if (wt) {
      for (const list of [wt.changedFiles, wt.untrackedFiles]) {
        for (const repoRel of list) {
          const wsRel = repoToWorkspace(repoRoot, cwd, repoRel);
          if (wsRel) dirtySet.add(wsRel.toLowerCase());
        }
      }
    }
  }

  const pages: PageStaleness[] = [];
  for (const page of contentPages) {
    const fm = page.parsed.frontmatter;
    const cutoff = fm.lastReviewedMs !== undefined
      ? Math.floor((fm.lastReviewedMs + 24 * 3600_000 - 1) / 1000) // day-granular: review day counts as reviewed
      : undefined;

    const refs: SourceRefStatus[] = [];
    let staleCount = 0;
    let missingCount = 0;
    let lowSignalHits = 0;

    for (const raw of fm.sourceRefs) {
      if (classifyRef(raw) === "external") {
        refs.push({ ref: raw, state: "unchecked" });
        continue;
      }
      const refPath = stripLineSuffix(raw).replace(/\\/g, "/").replace(/^\.\//, "");
      const key = norm(refPath);
      const absRef = path.isAbsolute(refPath) ? refPath : path.resolve(cwd, refPath);
      if (!existsSync(absRef)) {
        refs.push({ ref: raw, state: "missing" });
        missingCount++;
        continue;
      }
      const isLowSignal = LOW_SIGNAL_REFS.has(key);
      const dirty = dirtySet.has(key);
      const touched = touchByWorkspacePath?.get(key);
      const moved = (touched !== undefined && cutoff !== undefined && touched > cutoff) || dirty;
      if (moved && isLowSignal) {
        refs.push({ ref: raw, state: "low-signal", touchedAt: touched });
        lowSignalHits++;
      } else if (moved) {
        refs.push({ ref: raw, state: dirty && !(touched !== undefined && cutoff !== undefined && touched > cutoff) ? "dirty" : "changed", touchedAt: touched });
        staleCount++;
      } else {
        refs.push({ ref: raw, state: "fresh", touchedAt: touched });
      }
    }

    const state: PageStaleness["state"] =
      staleCount > 0 ? "stale"
        : missingCount > 0 ? "missing-refs"
          : fm.lastReviewedMs === undefined ? "unknown"
            : "fresh";
    pages.push({
      id: page.id,
      lastReviewedRaw: fm.lastReviewedRaw,
      lastReviewedMs: fm.lastReviewedMs,
      state,
      refs,
    });
  }

  const flagged = pages.filter((p) => p.state === "stale" || p.state === "missing-refs").length;
  const lowSignalOnly = pages.filter((p) => p.state === "fresh" && p.refs.some((r) => r.state === "low-signal")).length;
  if (lowSignalOnly > 0) {
    notes.push(`${lowSignalOnly} page(s) moved only through low-signal refs (AGENTS.md/README.md/LICENSE) — intentionally not flagged`);
  }
  notes.unshift(`${flagged} of ${pages.length} content page(s) flagged`);
  if (!touchByWorkspacePath) {
    // existence-only mode already announced via the notes above
  }

  pages.sort((a, b) => a.id.localeCompare(b.id));
  return { pages, notes };
}

/** Count helper for summary lines. */
export function stalenessCounts(result: StalenessResult): Record<PageStaleness["state"], number> {
  const counts: Record<PageStaleness["state"], number> = { fresh: 0, stale: 0, "missing-refs": 0, unknown: 0 };
  for (const p of result.pages) counts[p.state]++;
  return counts;
}

/** Format one page's staleness for markdown output. */
export function formatPageStaleness(page: PageStaleness): string[] {
  const lines: string[] = [];
  const date = page.lastReviewedRaw ?? "(none)";
  lines.push(`- \`${page.id}\` — ${page.state.toUpperCase()} (lastReviewed ${date})`);
  for (const r of page.refs) {
    if (r.state === "fresh" || r.state === "low-signal" || r.state === "unchecked") continue;
    const when = r.touchedAt ? new Date(r.touchedAt * 1000).toISOString().slice(0, 10) : undefined;
    lines.push(`    ${r.state}: ${r.ref}${when ? ` (commit ${when})` : ""}`);
  }
  const low = page.refs.filter((r) => r.state === "low-signal");
  if (low.length > 0) {
    lines.push(`    (low-signal churn: ${low.map((r) => r.ref).join(", ")})`);
  }
  return lines;
}
