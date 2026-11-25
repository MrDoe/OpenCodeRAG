/**
 * @fileoverview Tests for wiki staleness (git-backed) and the lint report.
 *
 * Uses a REAL temp git repo with fixed committer dates — staleness without
 * git is only disk-existence, and the day-granular cutoff rule (review day
 * counts as reviewed, per the repo's prototype checker) is the subtlety.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { buildWikiGraph } from "../../wiki/graph.js";
import { computeStaleness, stalenessCounts } from "../../wiki/staleness.js";
import { lintWiki, formatLintReport } from "../../wiki/lint.js";

function git(args: string[], cwd: string, date?: string): void {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (date) {
    env.GIT_AUTHOR_DATE = date;
    env.GIT_COMMITTER_DATE = date;
  }
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    env,
    windowsHide: true,
    timeout: 15000,
  });
}

function pageFile(opts: {
  title: string;
  refs: string[];
  reviewed?: string;
  links?: string[];
}): string {
  const lines = ["---", `title: ${opts.title}`, "tags: [t]"];
  if (opts.refs.length > 0) lines.push(`sourceRefs: [${opts.refs.join(", ")}]`);
  if (opts.reviewed) lines.push(`lastReviewed: ${opts.reviewed}`);
  lines.push("---", "", ...(opts.links ?? []).map((l) => `- ${l}`));
  return lines.join("\n");
}

interface Fixture {
  root: string;
  wikiDir: string;
}

function makeRepo(): Fixture | null {
  let root = "";
  try {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-stale-"));
    git(["init"], root);
    git(["config", "user.email", "t@example.invalid"], root);
    git(["config", "user.name", "test"], root);
    git(["config", "commit.gpgsign", "false"], root);
  } catch {
    try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    return null; // git unavailable — caller skips
  }
  const wikiDir = path.join(root, ".opencode", "wiki");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(wikiDir, "entities"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "stale.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, "src", "fresh.ts"), "export const f = 1;\n");
  fs.writeFileSync(path.join(root, "src", "dirty.ts"), "export const d = 1;\n");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# agents\n");

  // Wiki pages.
  fs.writeFileSync(
    path.join(wikiDir, "index.md"),
    pageFile({ title: "Index", refs: [], reviewed: "2026-11-15", links: ["[[entities/stale]]", "[[entities/fresh]]", "[[entities/gone]]", "[[entities/dirty]]", "[[entities/noreview]]"] }),
  );
  fs.writeFileSync(path.join(wikiDir, "log.md"), pageFile({ title: "Log", refs: [], reviewed: "2026-11-15" }));
  fs.writeFileSync(
    path.join(wikiDir, "entities", "stale.md"),
    pageFile({ title: "Stale", refs: ["src/stale.ts"], reviewed: "2025-11-01", links: ["[[entities/fresh]]"] }),
  );
  fs.writeFileSync(
    path.join(wikiDir, "entities", "fresh.md"),
    pageFile({ title: "Fresh", refs: ["src/fresh.ts"], reviewed: "2025-05-05", links: ["[[entities/fresh]]"] }),
  );
  fs.writeFileSync(
    path.join(wikiDir, "entities", "gone.md"),
    pageFile({ title: "Gone", refs: ["src/gone.ts"], reviewed: "2025-05-05", links: ["[[entities/fresh]]"] }),
  );
  fs.writeFileSync(
    path.join(wikiDir, "entities", "dirty.md"),
    pageFile({ title: "Dirty", refs: ["src/dirty.ts"], reviewed: "2025-05-05", links: ["[[entities/fresh]]"] }),
  );
  fs.writeFileSync(
    path.join(wikiDir, "entities", "low.md"),
    pageFile({ title: "Low", refs: ["AGENTS.md"], reviewed: "2020-01-01", links: ["[[entities/fresh]]"] }),
  );
  fs.writeFileSync(
    path.join(wikiDir, "entities", "url.md"),
    pageFile({ title: "Url", refs: ["https://example.com/spec.md"], reviewed: "2020-01-01", links: ["[[entities/fresh]]"] }),
  );
  fs.writeFileSync(
    path.join(wikiDir, "entities", "noreview.md"),
    pageFile({ title: "NoReview", refs: ["src/fresh.ts"], links: ["[[entities/fresh]]"] }),
  );
  // "low" and "url" need to be indexed to avoid confusing other assertions — not required for staleness.

  git(["add", "."], root);
  git(["commit", "-m", "initial"], root, "2025-05-05T10:00:00Z");
  // Second commit (fixed recent date): touches src/stale.ts AND AGENTS.md.
  fs.writeFileSync(path.join(root, "src", "stale.ts"), "export const a = 2;\n");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# agents v2\n");
  git(["add", "src/stale.ts", "AGENTS.md"], root);
  git(["commit", "-m", "touch stale + agents"], root, "2026-11-15T10:00:00Z");
  // Uncommitted change to src/dirty.ts.
  fs.writeFileSync(path.join(root, "src", "dirty.ts"), "export const d = 99;\n");
  // src/gone.ts never exists.
  return { root, wikiDir };
}

describe("staleness (git fixture)", () => {
  const fx = makeRepo();
  if (!fx) {
    // git unavailable in this environment - the suite registers no tests.
    return;
  }

  const graph = buildWikiGraph(fx.wikiDir, { maxPages: 100 });
  const result = computeStaleness(graph, fx.root, { nowMs: Date.parse("2026-11-17T12:00:00Z") });
  const byId = new Map(result.pages.map((p) => [p.id, p]));

  it("flags a page whose ref was committed after lastReviewed", () => {
    assert.equal(byId.get("entities/stale")!.state, "stale");
    const ref = byId.get("entities/stale")!.refs[0]!;
    assert.equal(ref.state, "changed");
    assert.ok(ref.touchedAt && ref.touchedAt >= Date.parse("2026-11-15T00:00:00Z") / 1000);
  });

  it("day-granular: review on the commit day counts as reviewed", () => {
    const fresh = byId.get("entities/fresh")!;
    assert.equal(fresh.state, "fresh");
    assert.equal(fresh.refs[0]!.state, "fresh");
  });

  it("uncommitted changes make a page stale", () => {
    assert.equal(byId.get("entities/dirty")!.state, "stale");
    assert.equal(byId.get("entities/dirty")!.refs[0]!.state, "dirty");
  });

  it("a vanished ref is missing-refs, not stale", () => {
    assert.equal(byId.get("entities/gone")!.state, "missing-refs");
    assert.equal(byId.get("entities/gone")!.refs[0]!.state, "missing");
  });

  it("AGENTS.md-only movement is low-signal, page stays fresh", () => {
    const low = byId.get("entities/low")!;
    assert.equal(low.state, "fresh");
    assert.equal(low.refs[0]!.state, "low-signal");
    assert.ok(result.notes.some((n) => n.includes("low-signal")));
  });

  it("URL refs are unchecked", () => {
    const url = byId.get("entities/url")!;
    assert.equal(url.refs[0]!.state, "unchecked");
    assert.equal(url.state, "fresh");
  });

  it("missing lastReviewed yields unknown", () => {
    assert.equal(byId.get("entities/noreview")!.state, "unknown");
  });

  it("counts reconcile with the fixture", () => {
    const counts = stalenessCounts(result);
    assert.equal(counts.stale, 2); // stale + dirty
    assert.equal(counts["missing-refs"], 1);
    assert.equal(counts.unknown, 1);
  });
});

describe("lint report", () => {
  it("treats line-range suffixes and ~ locators correctly (non-git cwd)", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-refs-"));
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.mkdirSync(path.join(cwd, ".opencode", "wiki"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "exists.ts"), "export const x = 1;\n");
    const pg = (refs: string[]) => ["---", "title: t", "tags: [t]", `sourceRefs: [${refs.join(", ")}]`, "lastReviewed: 2020-01-01", "---", ""].join("\n");
    fs.writeFileSync(path.join(cwd, ".opencode", "wiki", "lined.md"), pg(["src/exists.ts:798-826"]));
    fs.writeFileSync(path.join(cwd, ".opencode", "wiki", "home.md"), pg(["~/.config/opencode/opencode-rag.json"]));
    fs.writeFileSync(path.join(cwd, ".opencode", "wiki", "gone.md"), pg(["src/gone.ts:3"]));
    const graph = buildWikiGraph(path.join(cwd, ".opencode", "wiki"), { maxPages: 50 });
    const res = computeStaleness(graph, cwd);
    const byId = new Map(res.pages.map((p) => [p.id, p]));
    // line-suffixed ref resolves to the existing file -> fresh, not missing
    assert.equal(byId.get("lined")!.refs[0]!.state, "fresh");
    // ~ locator is external -> unchecked regardless of git/disk
    assert.equal(byId.get("home")!.refs[0]!.state, "unchecked");
    assert.equal(byId.get("home")!.state, "fresh");
    // a suffixed ref whose BASE is gone is still a real dead ref
    assert.equal(byId.get("gone")!.refs[0]!.state, "missing");
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("reports no wiki honestly", () => {
    const report = lintWiki(path.join(os.tmpdir(), "wiki-missing-" + Date.now()), process.cwd());
    assert.equal(report.exists, false);
    assert.equal(report.findingCount, 0);
    assert.match(formatLintReport(report), /No wiki/);
  });

  it("assembles structure and staleness with git notes", (t) => {
    const fx = makeRepo();
    if (!fx) {
      t.skip("git unavailable in this environment");
      return;
    }
    const report = lintWiki(fx.wikiDir, fx.root, { maxPages: 100, maxCommits: 500 });
    assert.equal(report.exists, true);
    assert.equal(report.pageCount, 9);
    assert.equal(report.contentPages, 7);
    // dangling: index.md -> missing "gone"? no: gone.md exists. missing-page from
    // graph fixture is not here; instead check the stale count made it into the
    // report and the formatter mentions the section headers.
    const stale = report.staleness.pages.filter((p) => p.state === "stale").map((p) => p.id);
    assert.deepEqual(stale, ["entities/dirty", "entities/stale"]);
    const text = formatLintReport(report);
    assert.match(text, /Stale pages\*\* \(sourceRefs changed/);
    assert.match(text, /Dead sourceRefs/);
    assert.match(text, /Judgment checks/);
    assert.ok(report.findingCount >= 3);
  });
});
