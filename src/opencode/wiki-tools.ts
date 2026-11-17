/**
 * @fileoverview Agent tools for wiki structure and health: `wiki_graph` and
 * `wiki_lint`.
 *
 * These move the deterministic half of wiki maintenance out of the LLM:
 * backlink/orphan/dangling questions become one call instead of a grep sweep,
 * and staleness (git vs. lastReviewed) becomes one call instead of manual git
 * archaeology. The report is only as good as the files — there is no
 * persisted graph to go stale.
 */
import { tool } from "@opencode-ai/plugin/tool";
import type { ToolDefinition } from "@opencode-ai/plugin";
import * as path from "node:path";
import { getWikiGraph, findPage, graphNeighbors, type WikiGraph } from "../wiki/graph.js";
import { lintWiki, formatLintReport } from "../wiki/lint.js";

/** Shared construction options for the wiki tools. */
export interface WikiToolOptions {
  /** Workspace root — the wiki lives at `<worktree>/.opencode/wiki`. */
  worktree: string;
  /** Live accessor for `wikiMode.maxPages` (config hot-reload aware). */
  getMaxPages?: () => number | undefined;
}

/** Modes of `wiki_graph`. */
const GRAPH_MODES = ["overview", "backlinks", "outlinks", "neighbors", "orphans", "dangling"] as const;
type GraphMode = (typeof GRAPH_MODES)[number];

function noWikiOutput(wikiDir: string) {
  return {
    title: "Wiki graph",
    output: `No wiki yet at \`${path.relative(process.cwd(), wikiDir).replace(/\\/g, "/") || ".opencode/wiki"}\`. Run \`/wiki seed\` to generate the initial pages.`,
    metadata: { tool: "wiki_graph", wikiFound: false },
  };
}

function pageLine(graph: WikiGraph, id: string): string {
  const node = graph.pages.get(id);
  if (!node) return `- \`${id}\``;
  const inb = node.inbound.length;
  const outb = node.outbound.length;
  return `- \`${node.id}\` — ${node.title} _(in ${inb}, out ${outb})_`;
}

/**
 * Create the `wiki_graph` tool.
 *
 * Purpose: answer every link-structure question in one call — backlinks of a
 * page, its neighborhood, the orphan list, dangling targets, or a whole-wiki
 * overview. Use instead of grepping the wiki for `[[...]]`.
 */
export function createWikiGraphTool(options: WikiToolOptions): ToolDefinition {
  const wikiDir = path.join(options.worktree, ".opencode", "wiki");

  return tool({
    description:
      "Wiki link-graph queries over `.opencode/wiki/` — the tool version of `/wiki` structure questions. " +
      "Modes: `overview` (counts: pages, orphans, dangling, index coverage), " +
      "`backlinks` / `outlinks` / `neighbors` (needs `page`; find WHERE a page is referenced instead of grepping), " +
      "`orphans` (content pages with no inbound content link), `dangling` (links that resolve to no page). " +
      "Computed from the files on every call — never stale. Pair with `wiki_lint` for health (staleness vs git).",

    args: {
      mode: tool.schema.string().optional().describe(
        "One of: overview | backlinks | outlinks | neighbors | orphans | dangling. Default: overview.",
      ),
      page: tool.schema.string().optional().describe(
        "Page id or unique basename (e.g. `entities/config-system` or `clickhouse-store`) — required for backlinks/outlinks/neighbors.",
      ),
      depth: tool.schema.number().int().min(1).max(3).optional().describe(
        "neighbor mode: hops to expand (1–3, default 1).",
      ),
    },

    async execute(args) {
      const mode = ((args.mode as string | undefined) ?? "overview").toLowerCase() as GraphMode;
      if (!GRAPH_MODES.includes(mode)) {
        return {
          title: "Wiki graph",
          output: `Unknown mode "${args.mode}". Use one of: ${GRAPH_MODES.join(", ")}.`,
          metadata: { tool: "wiki_graph", error: "bad-mode" },
        };
      }
      const graph = getWikiGraph(wikiDir, { maxPages: options.getMaxPages?.() });
      if (!graph.exists) return noWikiOutput(wikiDir);

      if (mode === "backlinks" || mode === "outlinks" || mode === "neighbors") {
        if (!args.page) {
          return {
            title: "Wiki graph",
            output: `Mode "${mode}" needs a \`page\` argument (e.g. "entities/config-system" or a unique basename).`,
            metadata: { tool: "wiki_graph", mode, error: "page-required" },
          };
        }
        const node = findPage(graph, args.page);
        if (!node) {
          const hint = graph.pageCount > 0 ? `Run mode "overview" to list pages.` : "";
          return {
            title: "Wiki graph",
            output: `No wiki page matches "${args.page}" (ambiguous or unknown). ${hint}`,
            metadata: { tool: "wiki_graph", mode, page: args.page, error: "page-not-found" },
          };
        }
        const lines: string[] = [`## ${node.title}`, `\`${node.id}\` (${node.relPath})`, ""];
        if (mode === "backlinks" || mode === "neighbors") {
          lines.push(`**Backlinks (${node.inbound.length}):**`);
          lines.push(node.inbound.length === 0 ? "_none — this page is an orphan_" : node.inbound.map((i) => pageLine(graph, i)).join("\n"));
          lines.push("");
        }
        if (mode === "outlinks" || mode === "neighbors") {
          lines.push(`**Outbound links (${node.outbound.length}):**`);
          lines.push(node.outbound.length === 0 ? "_none_" : node.outbound.map((i) => pageLine(graph, i)).join("\n"));
          if (node.unresolved.length > 0) {
            lines.push("");
            lines.push(`**Dangling (${node.unresolved.length}):** ` + node.unresolved.map((l) => `[[${l.target}]]`).join(", "));
          }
          lines.push("");
        }
        if (mode === "neighbors") {
          const neigh = graphNeighbors(graph, node.id, args.depth ?? 1);
          lines.push(`**Neighborhood within ${args.depth ?? 1} hop(s) (${neigh.length}):**`);
          lines.push(neigh.length === 0 ? "_nobody_" : neigh.map((i) => pageLine(graph, i)).join("\n"));
        }
        return {
          title: `Wiki graph — ${node.id}`,
          output: lines.join("\n"),
          metadata: { tool: "wiki_graph", mode, page: node.id, in: node.inbound.length, out: node.outbound.length },
        };
      }

      if (mode === "orphans") {
        return {
          title: `Wiki graph — orphans (${graph.orphans.length})`,
          output: graph.orphans.length === 0
            ? "No orphan pages — every content page has at least one inbound content link."
            : `**Orphan pages (${graph.orphans.length})** — no inbound [[link]] from a content page:\n\n` +
              graph.orphans.map((i) => pageLine(graph, i)).join("\n"),
          metadata: { tool: "wiki_graph", mode, count: graph.orphans.length },
        };
      }

      if (mode === "dangling") {
        return {
          title: `Wiki graph — dangling (${graph.dangling.length})`,
          output: graph.dangling.length === 0
            ? "No dangling links — every [[link]] resolves to an existing page."
            : `**Dangling links (${graph.dangling.length})** — written but resolving to no page:\n\n` +
              graph.dangling.map((d) => `- \`${d.fromId}\` → [[${d.raw}]]`).join("\n"),
          metadata: { tool: "wiki_graph", mode, count: graph.dangling.length },
        };
      }

      // overview
      const dirs = new Map<string, number>();
      for (const node of graph.pages.values()) {
        const idx = node.id.lastIndexOf("/");
        const dir = idx >= 0 ? node.id.slice(0, idx) : "(root)";
        dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
      }
      const degree: number[] = [...graph.pages.values()].map((n) => n.inbound.length + n.outbound.length);
      degree.sort((a, b) => a - b);
      const median = degree.length > 0 ? degree[Math.floor(degree.length / 2)] : 0;
      const hub = [...graph.pages.values()].sort((a, b) => b.inbound.length - a.inbound.length)[0];
      const lines = [
        `## Wiki overview`,
        `Pages: ${graph.pageCount} (content: ${[...graph.pages.values()].filter((n) => n.isContent).length})${graph.truncated ? " — **scan hit the page cap; counts are floors**" : ""}`,
        `By directory: ${[...dirs.entries()].sort().map(([d, n]) => `${d}/${n}`).join(", ")}`,
        `Links: outbound ${[...graph.pages.values()].reduce((s, n) => s + n.outbound.length, 0)} | inbound-median degree ${median} | most linked: ${hub ? `\`${hub.id}\` (${hub.inbound.length}×)` : "—"}`,
        `Health: orphans ${graph.orphans.length} | dangling ${graph.dangling.length} | uncataloged ${graph.uncataloged.length} | missing frontmatter ${graph.pagesMissingFrontmatter.length}`,
        graph.orphans.length > 0 ? `Orphans: ${graph.orphans.slice(0, 15).map((i) => `\`${i}\``).join(", ")}${graph.orphans.length > 15 ? ` (+${graph.orphans.length - 15})` : ""}` : "",
        graph.dangling.length > 0 ? `Dangling: ${graph.dangling.slice(0, 15).map((d) => `${d.fromId}→[[${d.raw}]]`).join(", ")}${graph.dangling.length > 15 ? ` (+${graph.dangling.length - 15})` : ""}` : "",
        ``,
        `Per-page detail: \`wiki_graph { page: "<id>", mode: "backlinks" }\`. Health incl. git staleness: \`wiki_lint\`.`,
      ].filter((l) => l.length > 0);
      return {
        title: `Wiki graph — overview (${graph.pageCount} pages)`,
        output: lines.join("\n"),
        metadata: {
          tool: "wiki_graph",
          mode: "overview",
          pages: graph.pageCount,
          orphans: graph.orphans.length,
          dangling: graph.dangling.length,
          uncataloged: graph.uncataloged.length,
        },
      };
    },
  });
}

/**
 * Create the `wiki_lint` tool.
 *
 * Purpose: the deterministic health report — structure (orphans/dangling/
 * catalog) plus staleness (sourceRefs committed after lastReviewed, dead
 * refs, uncommitted drift) in one call. Run it FIRST for any lint request,
 * then handle the judgment checks it cannot compute.
 */
export function createWikiLintTool(options: WikiToolOptions): ToolDefinition {
  const wikiDir = path.join(options.worktree, ".opencode", "wiki");

  return tool({
    description:
      "Deterministic wiki health report for `.opencode/wiki/`: stale pages (each page's git-verified `sourceRefs` newer than `lastReviewed`), dead sourceRefs, orphan/dangling link structure, frontmatter and index.md coverage. " +
      "One `git log` walk, day-granular review cutoff, AGENTS.md/README churn reported as low-signal. Run this FIRST when asked to lint or review the wiki, then fix the findings and append them to `log.md`; only the judgment checks (contradictions, missing concepts) remain manual. " +
      "Returns `format: \"json\"` data verbatim in metadata when requested.",

    args: {
      staleDays: tool.schema.number().int().min(1).optional().describe(
        "Also flag pages not reviewed for more than this many days (reported separately as aging).",
      ),
      maxCommits: tool.schema.number().int().min(10).max(5000).optional().describe(
        "Cap on commits in the single git-history walk (default 500). Raise for long histories; the report says when it truncated.",
      ),
      format: tool.schema.string().optional().describe('"markdown" (default) or "json" (full report in metadata).'),
    },

    async execute(args) {
      const report = lintWiki(wikiDir, options.worktree, {
        maxPages: options.getMaxPages?.(),
        maxCommits: args.maxCommits,
      });
      if (!report.exists) {
        return {
          title: "Wiki lint",
          output: `No wiki yet at \`.opencode/wiki/\`. Run \`/wiki seed\` to generate the initial pages.`,
          metadata: { tool: "wiki_lint", wikiFound: false },
        };
      }
      const staleDays = args.staleDays;
      const aging = staleDays
        ? report.staleness.pages.filter((p) =>
            p.state === "fresh" && p.lastReviewedMs !== undefined &&
            p.lastReviewedMs < Date.now() - staleDays * 24 * 3600_000)
        : [];
      let output = formatLintReport(report);
      if (aging.length > 0) {
        output += `\n- **Aging** (unreviewed > ${args.staleDays} days, sources unchanged): ${aging.length}\n    ` +
          aging.slice(0, 25).map((p) => `\`${p.id}\` (${p.lastReviewedRaw})`).join(", ");
      }
      const wantJson = String(args.format ?? "").toLowerCase() === "json";
      return {
        title: `Wiki lint — ${report.findingCount} findings (${report.pageCount} pages)`,
        output,
        metadata: {
          tool: "wiki_lint",
          pages: report.pageCount,
          findings: report.findingCount,
          stale: report.staleness.pages.filter((p) => p.state === "stale").length,
          deadRefs: report.staleness.pages.filter((p) => p.state === "missing-refs").length,
          orphans: report.orphans.length,
          dangling: report.dangling.length,
          uncataloged: report.uncataloged.length,
          ...(wantJson ? { report } : {}),
        },
      };
    },
  });
}
