/**
 * @fileoverview Builds the wiki link graph: pages, resolved links, backlinks,
 * orphans, dangling targets, and index coverage.
 *
 * The graph is computed ON DEMAND from the `.md` files — the files are the
 * single source of truth and a wiki is small (protocol: focused pages), so a
 * full scan costs milliseconds and the graph can never be stale. A
 * process-local cache keyed by an (path, mtime, size) fingerprint skips the
 * re-read until something actually changed.
 *
 * Orphan semantics follow the wiki protocol: `index.md` and `log.md` are
 * bookkeeping, not cross-references — links FROM them do not count as inbound
 * evidence, and they are never reported as orphans themselves. Index coverage
 * is reported separately (`uncataloged`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { normalizePageId, pageBasename, parseWikiPage, type ParsedWikiPage, type WikiLink } from "./page-parse.js";

/** Bookkeeping pages: excluded from orphan analysis and inbound counting. */
export const NON_CONTENT_PAGE_IDS: ReadonlySet<string> = new Set(["index", "log"]);

/** A resolved wiki page with its graph edges. */
export interface WikiPageNode {
  /** Normalized id (posix, lowercase, no `.md`), e.g. `entities/plugin`. */
  id: string;
  /** Path relative to the wiki root, posix, with suffix (display). */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
  /** Best display title. */
  title: string;
  parsed: ParsedWikiPage;
  /** Page-level is a content page (not index/log). */
  isContent: boolean;
  /** Resolved outbound links (page ids), document order, no self-links. */
  outbound: string[];
  /** Links that resolved to no page. */
  unresolved: WikiLink[];
  /** Page ids linking TO this page (content pages only), sorted. */
  inbound: string[];
  /** Whether index.md links to this page. */
  cataloged: boolean;
}

/** A `[[link]]` written on a page that resolves to no existing page. */
export interface DanglingLink {
  /** Page id the link was written on. */
  fromId: string;
  /** Link target as written. */
  raw: string;
  /** Normalized target id (what the resolver looked for). */
  target: string;
}

/** A complete snapshot of the wiki graph. */
export interface WikiGraph {
  /** Absolute wiki directory. */
  wikiDir: string;
  /** True when the wiki directory exists at all. */
  exists: boolean;
  /** Pages by normalized id. */
  pages: Map<string, WikiPageNode>;
  /** Content pages with zero inbound links from other content pages. */
  orphans: string[];
  /** Links that resolve to nothing. */
  dangling: DanglingLink[];
  /** Content pages NOT linked from index.md. */
  uncataloged: string[];
  /** Links written in index.md that resolve to nothing. */
  indexEntriesMissingFile: DanglingLink[];
  /** Content pages with no frontmatter block at all. */
  pagesMissingFrontmatter: string[];
  /** Content pages whose frontmatter carries parse issues. */
  frontmatterIssues: { id: string; message: string }[];
  /** True when the scan stopped at the page limit. */
  truncated: boolean;
  /** Pages scanned (== pages.size). */
  pageCount: number;
}

/** Options for a graph build. */
export interface WikiGraphOptions {
  /** Safety cap on pages scanned (config `wikiMode.maxPages`). Default 500. */
  maxPages?: number;
}

/** Recursively collect `.md` files under `dir`, sorted for stable output. */
function collectMarkdownFiles(dir: string, limit: number): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const walk = (current: string) => {
    if (truncated) return;
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        if (truncated) return;
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        files.push(full);
        if (files.length >= limit) { truncated = true; return; }
      }
    }
  };
  walk(dir);
  return { files, truncated };
}

/**
 * Resolve a raw link target against the page set.
 * Order: exact id → unique basename. Case-insensitive on both.
 *
 * @param raw - The link target as written.
 * @param idIndex - Map of normalized id → id.
 * @param basenameIndex - Map of lowercased basename → ids with that basename.
 * @returns The resolved page id, or undefined when dangling.
 */
export function resolveLinkTarget(
  raw: string,
  idIndex: Map<string, string>,
  basenameIndex: Map<string, string[]>,
): string | undefined {
  const id = normalizePageId(raw);
  if (id.length === 0) return undefined;
  const exact = idIndex.get(id);
  if (exact) return exact;
  const byBase = basenameIndex.get(pageBasename(id));
  if (byBase && byBase.length === 1) return byBase[0];
  return undefined;
}

/** Fingerprint of the current file set: relPath|mtimeMs|size, sorted. */
function fingerprint(files: string[], wikiDir: string): string {
  return files
    .map((f) => `${path.relative(wikiDir, f).replace(/\\/g, "/")}|${statSync(f).mtimeMs}|${statSync(f).size}`)
    .sort()
    .join(";");
}

interface CacheEntry {
  fp: string;
  maxPages: number;
  graph: WikiGraph;
}
const graphCache = new Map<string, CacheEntry>();

const EMPTY_GRAPH: WikiGraph = {
  wikiDir: "",
  exists: false,
  pages: new Map(),
  orphans: [],
  dangling: [],
  uncataloged: [],
  indexEntriesMissingFile: [],
  pagesMissingFrontmatter: [],
  frontmatterIssues: [],
  truncated: false,
  pageCount: 0,
};

/**
 * Build the wiki graph, reading every page.
 *
 * @param wikiDir - Absolute path of the wiki root (`.opencode/wiki`).
 * @param options - Scan limits.
 * @returns The graph snapshot; `exists: false` when the directory is absent.
 */
export function buildWikiGraph(wikiDir: string, options: WikiGraphOptions = {}): WikiGraph {
  const maxPages = Math.max(1, options.maxPages ?? 500);
  if (!existsSync(wikiDir)) {
    return { ...EMPTY_GRAPH, wikiDir };
  }

  const { files, truncated } = collectMarkdownFiles(wikiDir, maxPages);
  if (files.length === 0) {
    return { ...EMPTY_GRAPH, wikiDir, exists: true, truncated };
  }

  const parsedPages: { absPath: string; parsed: ParsedWikiPage }[] = [];
  for (const absPath of files) {
    let content: string;
    try {
      content = readFileSync(absPath, "utf-8");
    } catch {
      continue; // unreadable file: skip; the lint layer cannot invent content
    }
    parsedPages.push({ absPath, parsed: parseWikiPage(content) });
  }

  const relOf = (abs: string) => path.relative(wikiDir, abs).replace(/\\/g, "/");
  const idOf = (abs: string) => normalizePageId(relOf(abs));

  // Two ids can only collide via case (filesystems aside): first wins.
  const idIndex = new Map<string, string>();
  const basenameIndex = new Map<string, string[]>();
  const nodes = new Map<string, WikiPageNode>();
  for (const { absPath, parsed } of parsedPages) {
    const id = idOf(absPath);
    if (id.length === 0 || nodes.has(id)) continue;
    idIndex.set(id, id);
    const base = pageBasename(id);
    const list = basenameIndex.get(base) ?? [];
    list.push(id);
    basenameIndex.set(base, list);
    const rel = relOf(absPath);
    nodes.set(id, {
      id,
      relPath: rel,
      absPath,
      title: parsed.frontmatter.title ?? parsed.headingTitle ?? base,
      parsed,
      isContent: !NON_CONTENT_PAGE_IDS.has(id) && !id.startsWith("templates/"),
      outbound: [],
      unresolved: [],
      inbound: [],
      cataloged: false,
    });
  }

  // Pass 1: resolve links.
  const edges: { from: string; to: string }[] = [];
  const dangling: DanglingLink[] = [];
  const indexEntriesMissingFile: DanglingLink[] = [];
  for (const node of nodes.values()) {
    for (const link of node.parsed.links) {
      const target = resolveLinkTarget(link.target, idIndex, basenameIndex);
      if (!target || target === node.id) {
        const entry = { fromId: node.id, raw: link.target, target: normalizePageId(link.target) };
        if (target === node.id) continue; // self-link: not dangling, just noise we ignore
        dangling.push(entry);
        if (node.id === "index") indexEntriesMissingFile.push(entry);
        continue;
      }
      node.outbound.push(target);
      edges.push({ from: node.id, to: target });
    }
  }

  // Pass 2: backlinks (content pages only contribute inbound evidence),
  // index cataloging (index.md's OUTBOUND marks pages cataloged). Catalog
  // evidence accepts BOTH wikilinks and standard [text](page.md) links —
  // the protocol only mandates "a link and one-line summary" per entry.
  for (const { from, to } of edges) {
    const toNode = nodes.get(to);
    if (!toNode) continue;
    if (from === "index") toNode.cataloged = true;
    if (from === "index" || from === "log") continue;
    if (!toNode.inbound.includes(from)) toNode.inbound.push(from);
  }
  const indexNode = nodes.get("index");
  if (indexNode) {
    for (const raw of indexNode.parsed.mdPageLinks) {
      const target = resolveLinkTarget(raw, idIndex, basenameIndex);
      if (target) {
        const toNode = nodes.get(target);
        if (toNode) toNode.cataloged = true;
      } else {
        const entry = { fromId: "index", raw, target: normalizePageId(raw) };
        indexEntriesMissingFile.push(entry);
        if (!dangling.some((d) => d.fromId === "index" && d.raw === raw)) dangling.push(entry);
      }
    }
  }

  const orphans: string[] = [];
  const uncataloged: string[] = [];
  const pagesMissingFrontmatter: string[] = [];
  const frontmatterIssues: { id: string; message: string }[] = [];
  for (const node of nodes.values()) {
    if (!node.isContent) continue;
    if (node.inbound.length === 0) orphans.push(node.id);
    if (!node.cataloged) uncataloged.push(node.id);
    if (!node.parsed.frontmatter.present) pagesMissingFrontmatter.push(node.id);
    for (const issue of node.parsed.frontmatter.issues) {
      frontmatterIssues.push({ id: node.id, message: issue.message });
    }
  }
  for (const node of nodes.values()) node.inbound.sort();
  orphans.sort();
  uncataloged.sort();

  return {
    wikiDir,
    exists: true,
    pages: nodes,
    orphans,
    dangling,
    uncataloged,
    indexEntriesMissingFile,
    pagesMissingFrontmatter,
    frontmatterIssues,
    truncated,
    pageCount: nodes.size,
  };
}

/**
 * Cached wrapper around {@link buildWikiGraph}: returns the cached graph while
 * the (path, mtime, size) fingerprint of the file set is unchanged, so
 * repeated tool calls in one session cost one disk read.
 *
 * @param wikiDir - Absolute path of the wiki root.
 * @param options - Scan limits (part of the cache key).
 * @returns The graph snapshot.
 */
export function getWikiGraph(wikiDir: string, options: WikiGraphOptions = {}): WikiGraph {
  const maxPages = Math.max(1, options.maxPages ?? 500);
  if (!existsSync(wikiDir)) {
    graphCache.delete(wikiDir);
    return { ...EMPTY_GRAPH, wikiDir };
  }
  const { files } = collectMarkdownFiles(wikiDir, maxPages);
  const fp = fingerprint(files, wikiDir);
  const hit = graphCache.get(wikiDir);
  if (hit && hit.fp === fp && hit.maxPages === maxPages) return hit.graph;
  const graph = buildWikiGraph(wikiDir, { maxPages });
  graphCache.set(wikiDir, { fp, maxPages, graph });
  return graph;
}

/**
 * BFS neighborhood of a page over both edge directions.
 *
 * @param graph - The wiki graph.
 * @param pageId - Normalized id of the center page.
 * @param depth - Hops to expand (1–3).
 * @returns Page ids within `depth` hops, center excluded, sorted.
 */
export function graphNeighbors(graph: WikiGraph, pageId: string, depth: number): string[] {
  const seen = new Set<string>([pageId]);
  let frontier = [pageId];
  const max = Math.min(3, Math.max(1, depth));
  for (let d = 0; d < max; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      const node = graph.pages.get(id);
      if (!node) continue;
      for (const n of [...node.outbound, ...node.inbound]) {
        if (!seen.has(n)) {
          seen.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  seen.delete(pageId);
  return [...seen].sort();
}

/**
 * Find the page a user-facing `page` argument refers to.
 * Accepts an exact id or a unique basename (mirrors link resolution),
 * case-insensitively, with or without the `.opencode/wiki/` prefix.
 *
 * @param graph - The wiki graph.
 * @param page - User-provided page reference.
 * @returns The matching node, or undefined when unknown or ambiguous.
 */
export function findPage(graph: WikiGraph, page: string): WikiPageNode | undefined {
  const id = normalizePageId(page);
  const exact = graph.pages.get(id);
  if (exact) return exact;
  const matches = [...graph.pages.values()].filter((n) => pageBasename(n.id) === pageBasename(id));
  return matches.length === 1 ? matches[0] : undefined;
}
