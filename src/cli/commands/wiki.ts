/**
 * @fileoverview Wiki command — structure and health reports over
 * `.opencode/wiki/` (status, graph, lint).
 *
 * Provider-free by design: the wiki tools need no store and no embedder, so
 * these commands resolve config for limits only and never touch the vector
 * store — `wiki lint` works on an un-indexed workspace.
 */
import type { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { c, logCliError, logCliInfo } from "../format.js";
import { loadWorkspaceConfig } from "../../core/config.js";
import { getWikiGraph, findPage, graphNeighbors } from "../../wiki/graph.js";
import { lintWiki, formatLintReport } from "../../wiki/lint.js";

interface WikiCliOptions {
  dir?: string;
  config?: string;
  /** lint */
  json?: boolean;
  staleDays?: string;
  maxCommits?: string;
  /** graph */
  page?: string;
  mode?: string;
  depth?: string;
}

/** Resolve the workspace + wiki dir, honoring --dir. */
function resolveWikiContext(options: WikiCliOptions): { cwd: string; wikiDir: string; maxPages: number } {
  const cwd = path.resolve(options.dir ?? process.cwd());
  let maxPages = 500;
  try {
    const cfg = loadWorkspaceConfig(cwd);
    maxPages = cfg.wikiMode?.maxPages ?? maxPages;
  } catch {
    // unreadable config: defaults; the wiki itself is plain files
  }
  return { cwd, wikiDir: path.join(cwd, ".opencode", "wiki"), maxPages };
}

/** Shared preamble: register the `wiki` command. */
export function registerWikiCommand(program: Command): void {
  const wikiCmd = program
    .command("wiki")
    .description("Wiki structure and health (status, graph, lint) — no store, no embedder required");

  const logFilePath = (options: WikiCliOptions): string =>
    path.join(path.resolve(options.dir ?? process.cwd()), ".opencode", "opencode-rag.log");

  wikiCmd
    .command("status")
    .description("Page count, structure health, latest log entry")
    .option("--dir <path>", "workspace root (default: cwd)")
    .action((options: WikiCliOptions) => {
      try {
        const { wikiDir, maxPages } = resolveWikiContext(options);
        const graph = getWikiGraph(wikiDir, { maxPages });
        if (!graph.exists) {
          logCliInfo(logFilePath(options), "wiki status", `\nNo wiki at .opencode/wiki/ — run \`/wiki seed\` (or seed pages by hand).`);
          return;
        }
        const contentPages = [...graph.pages.values()].filter((n) => n.isContent).length;
        const logPath = path.join(wikiDir, "log.md");
        let lastLog = "";
        if (fs.existsSync(logPath)) {
          const entries = fs.readFileSync(logPath, "utf-8").split("\n").filter((l) => l.startsWith("## ["));
          lastLog = entries[entries.length - 1] ?? "";
        }
        logCliInfo(logFilePath(options), "wiki status", `\n${c.heading("Wiki")} ${c.dim(wikiDir)}`);
        logCliInfo(logFilePath(options), "wiki status", `  ${c.label("Pages:")} ${c.num(graph.pageCount)} (${contentPages} content)${graph.truncated ? ` ${c.warn("(page cap hit — floors only)")}` : ""}`);
        logCliInfo(logFilePath(options), "wiki status", `  ${c.label("Index:")} ${fs.existsSync(path.join(wikiDir, "index.md")) ? "yes" : "no"}`);
        logCliInfo(logFilePath(options), "wiki status", `  ${c.label("Health:")} orphans ${graph.orphans.length}, dangling ${graph.dangling.length}, uncataloged ${graph.uncataloged.length}, missing frontmatter ${graph.pagesMissingFrontmatter.length}`);
        if (lastLog) logCliInfo(logFilePath(options), "wiki status", `  ${c.label("Latest log:")} ${lastLog}`);
      } catch (err) {
        logCliError(logFilePath(options), "wiki status", `wiki status failed: ${(err as Error).message}`, err);
        process.exit(1);
      }
    });

  wikiCmd
    .command("graph")
    .description("Link-graph queries: overview, backlinks, outlinks, neighbors, orphans, dangling")
    .option("--dir <path>", "workspace root (default: cwd)")
    .option("--page <page>", "page id or unique basename (required for backlinks/outlinks/neighbors)")
    .option("--mode <mode>", "overview | backlinks | outlinks | neighbors | orphans | dangling", "overview")
    .option("--depth <n>", "neighbors mode hop count (1-3)", "1")
    .action((options: WikiCliOptions) => {
      try {
        const { wikiDir, maxPages } = resolveWikiContext(options);
        const graph = getWikiGraph(wikiDir, { maxPages });
        if (!graph.exists) {
          logCliInfo(logFilePath(options), "wiki graph", `\nNo wiki at .opencode/wiki/.`);
          return;
        }
        const mode = String(options.mode ?? "overview").toLowerCase();
        const log = (line: string) => logCliInfo(logFilePath(options), "wiki graph", line);
        const lineFor = (id: string): string => {
          const node = graph.pages.get(id);
          return `  - ${id}${node ? `  (in ${node.inbound.length}, out ${node.outbound.length})` : ""}`;
        };

        if (mode === "orphans" || mode === "dangling") {
          const items = mode === "orphans" ? graph.orphans : graph.dangling.map((d) => `${d.fromId} -> [[${d.raw}]]`);
          log(`\n${c.heading(mode)}: ${items.length}`);
          for (const item of items) log(`  - ${item}`);
          return;
        }
        if (mode === "backlinks" || mode === "outlinks" || mode === "neighbors") {
          if (!options.page) {
            logCliError(logFilePath(options), "wiki graph", `--mode ${mode} requires --page <page>`);
            process.exit(1);
          }
          const node = findPage(graph, options.page!);
          if (!node) {
            logCliError(logFilePath(options), "wiki graph", `no wiki page matches "${options.page}"`);
            process.exit(1);
          }
          log(`\n${c.heading(node.title)} ${c.dim(node.id)}`);
          if (mode !== "outlinks") {
            log(`  ${c.label("Backlinks:")}`);
            for (const i of node.inbound) log(lineFor(i));
          }
          if (mode !== "backlinks") {
            log(`  ${c.label("Outlinks:")}`);
            for (const i of node.outbound) log(lineFor(i));
            for (const d of node.unresolved) log(`  ${c.warn(`dangling -> [[${d.target}]]`)}`);
          }
          if (mode === "neighbors") {
            const depth = Math.min(3, Math.max(1, Number(options.depth ?? 1)));
            for (const n of graphNeighbors(graph, node.id, depth)) log(lineFor(n));
          }
          return;
        }
        // overview
        log(`\n${c.heading("Wiki overview")}`);
        log(`  ${c.label("Pages:")} ${c.num(graph.pageCount)}${graph.truncated ? ` ${c.warn("(page cap hit)")}` : ""}`);
        log(`  ${c.label("Orphans:")} ${graph.orphans.length} | ${c.label("Dangling:")} ${graph.dangling.length} | ${c.label("Uncataloged:")} ${graph.uncataloged.length}`);
        for (const [id, node] of [...graph.pages.entries()].sort()) {
          log(`  ${id}  ${c.dim(`(in ${node.inbound.length}, out ${node.outbound.length})`)}`);
        }
      } catch (err) {
        logCliError(logFilePath(options), "wiki graph", `wiki graph failed: ${(err as Error).message}`, err);
        process.exit(1);
      }
    });

  wikiCmd
    .command("lint")
    .description("Deterministic health report: git-verified staleness, structure, frontmatter, index coverage")
    .option("--dir <path>", "workspace root (default: cwd)")
    .option("--json", "machine-readable report on stdout")
    .option("--stale-days <n>", "also list pages unreviewed for more than n days")
    .option("--max-commits <n>", "cap on the git-history walk (default 500)")
    .action((options: WikiCliOptions) => {
      try {
        const { cwd, wikiDir, maxPages } = resolveWikiContext(options);
        const report = lintWiki(wikiDir, cwd, {
          maxPages,
          maxCommits: options.maxCommits ? Number(options.maxCommits) : undefined,
        });
        if (options.json) {
          // JSON goes to stdout raw so it pipes; no color codes.
          const staleDays = options.staleDays ? Number(options.staleDays) : undefined;
          const aging = staleDays
            ? report.staleness.pages.filter((p) =>
                p.state === "fresh" && p.lastReviewedMs !== undefined &&
                p.lastReviewedMs < Date.now() - staleDays * 24 * 3600_000).map((p) => p.id)
            : [];
          process.stdout.write(JSON.stringify({ ...report, aging }, null, 2) + "\n");
          return;
        }
        if (!report.exists) {
          logCliInfo(logFilePath(options), "wiki lint", `\nNo wiki at .opencode/wiki/ — run \`/wiki seed\`.`);
          return;
        }
        for (const line of formatLintReport(report).split("\n")) {
          logCliInfo(logFilePath(options), "wiki lint", line);
        }
      } catch (err) {
        logCliError(logFilePath(options), "wiki lint", `wiki lint failed: ${(err as Error).message}`, err);
        process.exit(1);
      }
    });
}
