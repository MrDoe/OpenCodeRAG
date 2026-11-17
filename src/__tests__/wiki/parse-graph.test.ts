/**
 * @fileoverview Tests for wiki page parsing and the link graph.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  normalizePageId,
  pageBasename,
  parseFrontmatter,
  parseWikiLinks,
  parseWikiPage,
} from "../../wiki/page-parse.js";
import { buildWikiGraph, findPage, graphNeighbors } from "../../wiki/graph.js";

describe("page-parse: normalizePageId", () => {
  it("collapses the accepted spellings to one id", () => {
    for (const raw of [
      "entities/config-system",
      "entities/config-system.md",
      "wiki/entities/config-system",
      ".opencode/wiki/entities/config-system.md",
      ".\\wiki\\entities\\config-system.md",
    ]) {
      assert.equal(normalizePageId(raw), "entities/config-system", raw);
    }
  });

  it("handles bare ids, root pages, and empty input", () => {
    assert.equal(normalizePageId("overview"), "overview");
    assert.equal(normalizePageId("./index"), "index");
    assert.equal(normalizePageId("   "), "");
    assert.equal(pageBasename("entities/config-system"), "config-system");
    assert.equal(pageBasename("index"), "index");
  });
});

describe("page-parse: frontmatter", () => {
  it("parses the protocol keys with inline arrays", () => {
    const fm = parseFrontmatter([
      "---",
      "title: My Page",
      "tags: [alpha, beta]",
      "sourceRefs: [src/a.ts, src/b.ts]",
      "lastReviewed: 2026-11-01",
      "---",
      "# Body",
    ].join("\n"));
    assert.equal(fm.present, true);
    assert.equal(fm.title, "My Page");
    assert.deepEqual(fm.tags, ["alpha", "beta"]);
    assert.deepEqual(fm.sourceRefs, ["src/a.ts", "src/b.ts"]);
    assert.equal(fm.lastReviewedRaw, "2026-11-01");
    assert.ok(fm.lastReviewedMs);
    assert.deepEqual(fm.issues, []);
  });

  it("parses block lists, quoted titles and CRLF", () => {
    const fm = parseFrontmatter(
      [
        "---",
        'title: "Quoted, title"',
        "tags:",
        "  - one",
        "  - two",
        "sourceRefs:",
        "  - src/a.ts",
        "lastReviewed: 2026-11-01",
        "---",
        "",
      ].join("\r\n"),
    );
    assert.equal(fm.title, "Quoted, title");
    assert.deepEqual(fm.tags, ["one", "two"]);
    assert.deepEqual(fm.sourceRefs, ["src/a.ts"]);
  });

  it("reports placeholder and unparseable dates without inventing them", () => {
    const placeholder = parseFrontmatter(["---", "lastReviewed: <date>", "---"].join("\n"));
    assert.equal(placeholder.lastReviewedMs, undefined);
    assert.match(placeholder.issues[0]!.message, /placeholder/);

    const bogus = parseFrontmatter(["---", "lastReviewed: yesterday", "---"].join("\n"));
    assert.equal(bogus.lastReviewedMs, undefined);
    assert.match(bogus.issues[0]!.message, /not a date/);
  });

  it("flags an unclosed block and tolerates unknown keys", () => {
    const unclosed = parseFrontmatter(["---", "title: x"].join("\n"));
    assert.equal(unclosed.present, true);
    assert.match(unclosed.issues.map((i) => i.message).join(" "), /never closed/);
    const unknown = parseFrontmatter(["---", "mystery: [1]", "tags: [ok]", "---"].join("\n"));
    assert.deepEqual(unknown.tags, ["ok"]);
    assert.equal(unknown.issues.length, 0);
  });

  it("returns present:false with no block", () => {
    const fm = parseFrontmatter("# Just a page\n");
    assert.equal(fm.present, false);
  });
});

describe("page-parse: links", () => {
  it("resolves targets, aliases and anchors", () => {
    const links = parseWikiLinks("see [[wiki/plugin#usage|the plugin]] and [[a]]");
    assert.equal(links.length, 2);
    assert.equal(links[0]!.target, "wiki/plugin");
    assert.equal(links[0]!.anchor, "usage");
    assert.equal(links[0]!.alias, "the plugin");
    assert.equal(links[1]!.target, "a");
  });

  it("ignores fenced code blocks and inline code", () => {
    const content = [
      "Before [[real]].",
      "```",
      "Example in a fence: [[wiki/page-name]]",
      "```",
      "The protocol spells it `[[wiki/page-name]]` inline.",
      "~~~",
      "fence two [[fake2]]",
      "~~~",
      "After [[real2]].",
    ].join("\n");
    const targets = parseWikiLinks(content).map((l) => l.target);
    assert.deepEqual(targets, ["real", "real2"]);
  });

  it("parseWikiPage falls back to the H1 title", () => {
    const page = parseWikiPage("# Heading Title\n\nbody [[a]]");
    assert.equal(page.frontmatter.present, false);
    assert.equal(page.headingTitle, "Heading Title");
    assert.equal(page.links.length, 1);
  });
});

/** Write files into a fresh temp dir; returns the root. */
function fixtureDir(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-graph-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");
  }
  return root;
}

function page(title: string, refs: string[], reviewed: string, links: string[]): string {
  return [
    "---",
    `title: ${title}`,
    `tags: [t]`,
    `sourceRefs: [${refs.join(", ")}]`,
    `lastReviewed: ${reviewed}`,
    "---",
    "",
    ...links.map((l) => `- ${l}`),
  ].join("\n");
}

describe("graph", () => {
  const root = fixtureDir({
    "index.md": page("Index", [], "2026-11-01", ["[[entities/a]]", "[[entities/b]]", "[[concepts/c]]", "[[missing-page]]"]),
    "log.md": page("Log", [], "2026-11-01", ["[[concepts/c]]"]),
    "entities/a.md": page("A", ["README.md"], "2026-11-01", ["[[entities/b]]", "[[concepts/c#section|with anchor]]"]),
    "entities/b.md": page("B", [], "2026-11-01", []),
    "concepts/c.md": page("C", [], "2026-11-01", []),
    "concepts/NoFrontmatter.md": "# No Frontmatter\n\nplain page",
  });

  it("resolves links case-insensitively and builds correct edges", () => {
    const graph = buildWikiGraph(root, { maxPages: 100 });
    assert.equal(graph.exists, true);
    assert.equal(graph.pageCount, 6);
    const a = graph.pages.get("entities/a")!;
    assert.deepEqual(a.outbound, ["entities/b", "concepts/c"]);
    const b = graph.pages.get("entities/b")!;
    // index.md + a link to b, but only a counts as inbound evidence.
    assert.deepEqual(b.inbound, ["entities/a"]);
    // the nofrontmatter file resolves by case-insensitive basename.
    assert.ok(graph.pages.get("concepts/nofrontmatter"));
  });

  it("computes orphans, dangling, catalog and index coverage", () => {
    const graph = buildWikiGraph(root, { maxPages: 100 });
    // c is linked only from index/log (a links it too — so c is NOT orphan):
    assert.ok(!graph.orphans.includes("concepts/c"));
    // nofrontmatter has no inbound anywhere:
    assert.ok(graph.orphans.includes("concepts/nofrontmatter"));
    // index/log are never orphans themselves:
    assert.ok(!graph.orphans.includes("index"));
    assert.ok(!graph.orphans.includes("log"));
    // dangling: the index entry + nothing else
    assert.equal(graph.dangling.length, 1);
    assert.equal(graph.dangling[0]!.raw, "missing-page");
    assert.equal(graph.indexEntriesMissingFile.length, 1);
    // uncataloged: nofrontmatter (a/b/c are in index)
    assert.deepEqual(graph.uncataloged, ["concepts/nofrontmatter"]);
    assert.deepEqual(graph.pagesMissingFrontmatter, ["concepts/nofrontmatter"]);
  });

  it("neighbors expands both directions to the requested depth", () => {
    const graph = buildWikiGraph(root, { maxPages: 100 });
    const n1 = graphNeighbors(graph, "entities/b", 1);
    // Index/log are bookkeeping hubs, not neighbors: b's only neighbor is the
    // content page that links it. (Otherwise index would be everyone's hub.)
    assert.ok(n1.includes("entities/a"));
    assert.ok(!n1.includes("index"));
    const n2 = graphNeighbors(graph, "entities/b", 2);
    assert.ok(n2.includes("concepts/c")); // through a
  });

  it("findPage accepts id, basename and is None on ambiguity", () => {
    const graph = buildWikiGraph(root, { maxPages: 100 });
    assert.ok(findPage(graph, "entities/a"));
    assert.ok(findPage(graph, "a"));
    assert.equal(findPage(graph, "zzz"), undefined);
  });

  it("truncates at maxPages with an honest flag", () => {
    const graph = buildWikiGraph(root, { maxPages: 2 });
    assert.equal(graph.truncated, true);
    assert.equal(graph.pageCount, 2);
  });

  it("catalogs pages linked with standard markdown links, too", () => {
    const dir = fixtureDir({
      "index.md": "# Index\n\n- [A](entities/a.md)\n- [gone](entities/gone.md)\n",
      "entities/a.md": "# A\n\nplain",
    });
    const graph = buildWikiGraph(dir, { maxPages: 50 });
    assert.ok(graph.pages.get("entities/a")!.cataloged);
    assert.equal(graph.uncataloged.length, 0);
    assert.equal(graph.indexEntriesMissingFile.length, 1);
    assert.equal(graph.indexEntriesMissingFile[0]!.raw, "entities/gone.md");
  });
});
