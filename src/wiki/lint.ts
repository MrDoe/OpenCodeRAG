/**
 * @fileoverview Deterministic wiki health report — the computed half of
 * `/wiki lint`. Everything here is machine-decidable (graph structure,
 * frontmatter, git-vs-lastReviewed); the judgment checks (contradictions,
 * "important concepts lacking a page") stay the agent's job and are listed
 * as such in the report footer.
 */
import * as path from "node:path";
import { getWikiGraph, type WikiGraph, type WikiGraphOptions } from "./graph.js";
import {
  computeStaleness,
  formatPageStaleness,
  stalenessCounts,
  type StalenessResult,
} from "./staleness.js";

/** Options for a lint pass. */
export interface WikiLintOptions extends WikiGraphOptions {
  /** Max commits in the single git-log walk (staleness). Default 500. */
  maxCommits?: number;
  /** Injected clock (tests). */
  nowMs?: number;
}

/** The full deterministic health report for one wiki. */
export interface WikiLintReport {
  wikiDir: string;
  exists: boolean;
  pageCount: number;
  contentPages: number;
  truncated: boolean;
  orphans: string[];
  dangling: WikiGraph["dangling"];
  uncataloged: string[];
  indexEntriesMissingFile: WikiGraph["indexEntriesMissingFile"];
  pagesMissingFrontmatter: string[];
  frontmatterIssues: { id: string; message: string }[];
  staleness: StalenessResult;
  /** Total deterministic findings (a page can carry several). */
  findingCount: number;
}

/**
 * Run the deterministic lint pass.
 *
 * @param wikiDir - Absolute path to `.opencode/wiki`.
 * @param cwd - Workspace root (sourceRefs resolve against it).
 * @param options - Limits.
 * @returns The report; `exists: false` when there is no wiki yet.
 */
export function lintWiki(wikiDir: string, cwd: string, options: WikiLintOptions = {}): WikiLintReport {
  const graph = getWikiGraph(wikiDir, { maxPages: options.maxPages });
  if (!graph.exists) {
    const staleness = { pages: [], notes: [] };
    return {
      wikiDir,
      exists: false,
      pageCount: 0,
      contentPages: 0,
      truncated: false,
      orphans: [],
      dangling: [],
      uncataloged: [],
      indexEntriesMissingFile: [],
      pagesMissingFrontmatter: [],
      frontmatterIssues: [],
      staleness,
      findingCount: 0,
    };
  }

  const staleness = computeStaleness(graph, cwd, { maxCommits: options.maxCommits, nowMs: options.nowMs });
  const counts = stalenessCounts(staleness);
  const contentPages = [...graph.pages.values()].filter((p) => p.isContent).length;
  const findingCount =
    graph.orphans.length +
    graph.dangling.length +
    graph.uncataloged.length +
    graph.pagesMissingFrontmatter.length +
    graph.frontmatterIssues.length +
    counts.stale +
    counts["missing-refs"];

  return {
    wikiDir,
    exists: true,
    pageCount: graph.pageCount,
    contentPages,
    truncated: graph.truncated,
    orphans: graph.orphans,
    dangling: graph.dangling,
    uncataloged: graph.uncataloged,
    indexEntriesMissingFile: graph.indexEntriesMissingFile,
    pagesMissingFrontmatter: graph.pagesMissingFrontmatter,
    frontmatterIssues: graph.frontmatterIssues,
    staleness,
    findingCount,
  };
}

/** Cap list rendering so the report stays token-lean. */
function cappedList(items: string[], cap: number): string {
  const shown = items.slice(0, cap).map((i) => `\`${i}\``).join(", ");
  return items.length > cap ? `${shown} (+${items.length - cap} more)` : shown;
}

/**
 * Render a lint report as compact markdown (agent/tool output).
 *
 * @param report - The computed report.
 * @param cap - Max items per section (default 25).
 * @returns Markdown report; a short "no wiki" text when the wiki is absent.
 */
export function formatLintReport(report: WikiLintReport, cap = 25): string {
  if (!report.exists) {
    return `No wiki at \`${report.wikiDir}\`. Run \`/wiki seed\` to generate the initial pages.`;
  }
  const lines: string[] = [];
  lines.push(
    `**Wiki lint** — ${report.pageCount} pages (${report.contentPages} content)` +
    (report.truncated ? " _(scan hit the page cap)_" : ""),
  );
  lines.push(`Deterministic findings: **${report.findingCount}**`);
  lines.push("");

  const stalePages = report.staleness.pages.filter((p) => p.state === "stale");
  const missingPages = report.staleness.pages.filter((p) => p.state === "missing-refs");
  const unknownPages = report.staleness.pages.filter((p) => p.state === "unknown");

  lines.push(`- **Stale pages** (sourceRefs changed after lastReviewed): ${stalePages.length}`);
  for (const p of stalePages.slice(0, cap)) lines.push(...formatPageStaleness(p));
  if (stalePages.length > cap) lines.push(`    _(… +${stalePages.length - cap} more pages)_`);

  lines.push(`- **Dead sourceRefs** (file no longer exists): ${missingPages.length}`);
  for (const p of missingPages.slice(0, cap)) lines.push(...formatPageStaleness(p));

  lines.push(`- **Pages missing lastReviewed** (cannot judge staleness): ${unknownPages.length}`);
  if (unknownPages.length > 0) lines.push(`    ${cappedList(unknownPages.map((p) => p.id), cap)}`);

  lines.push(`- **Orphans** (no inbound link from a content page): ${report.orphans.length}`);
  if (report.orphans.length > 0) lines.push(`    ${cappedList(report.orphans, cap)}`);

  lines.push(`- **Dangling links** (resolve to no page): ${report.dangling.length}`);
  for (const d of report.dangling.slice(0, cap)) lines.push(`    \`${d.fromId}\` → [[${d.raw}]]`);
  if (report.dangling.length > cap) lines.push(`    _(… +${report.dangling.length - cap} more)_`);

  lines.push(`- **Uncataloged** (content page not linked from index.md): ${report.uncataloged.length}`);
  if (report.uncataloged.length > 0) lines.push(`    ${cappedList(report.uncataloged, cap)}`);

  if (report.indexEntriesMissingFile.length > 0) {
    lines.push(`- **index.md entries with no file**: ${report.indexEntriesMissingFile.length}`);
    for (const d of report.indexEntriesMissingFile.slice(0, cap)) lines.push(`    index.md → [[${d.raw}]]`);
  }

  lines.push(`- **Pages without frontmatter**: ${report.pagesMissingFrontmatter.length}`);
  if (report.pagesMissingFrontmatter.length > 0) lines.push(`    ${cappedList(report.pagesMissingFrontmatter, cap)}`);

  if (report.frontmatterIssues.length > 0) {
    lines.push(`- **Frontmatter issues**: ${report.frontmatterIssues.length}`);
    for (const i of report.frontmatterIssues.slice(0, cap)) lines.push(`    \`${i.id}\`: ${i.message}`);
  }

  for (const note of report.staleness.notes) lines.push(`_Note:_ ${note}`);

  lines.push("");
  lines.push("_Judgment checks the tool cannot compute — do these as the agent:_ contradictions between pages; concepts mentioned in 3+ pages without their own page; pages that lost their reason to exist.");
  return lines.join("\n");
}

/** JSON-safe plain object of a report (CLI `--json`). */
export function lintReportToJson(report: WikiLintReport): Record<string, unknown> {
  return JSON.parse(JSON.stringify({ ...report, wikiDirRel: path.basename(path.dirname(report.wikiDir)) })) as Record<string, unknown>;
}
