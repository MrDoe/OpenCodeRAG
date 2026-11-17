import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseGitignoreExclusions,
  mergeExclusionLists,
} from "../../core/gitignore-exclusions.js";

describe("parseGitignoreExclusions", () => {
  it("maps any-depth directory patterns to plain basenames", () => {
    const { dirs, files } = parseGitignoreExclusions(
      ["**/bin/", "**/obj/", "node_modules/", ""].join("\n"),
    );
    assert.deepEqual(dirs, ["bin", "node_modules", "obj"]);
    assert.deepEqual(files, []);
  });

  it("maps directory-with-contents patterns (`**/dir/*`) to the directory", () => {
    const { dirs } = parseGitignoreExclusions("**/Migrations/*");
    assert.deepEqual(dirs, ["Migrations"]);
  });

  it("keeps multi-segment directory patterns as rooted paths", () => {
    const { dirs } = parseGitignoreExclusions("/playwright/.cache/");
    assert.deepEqual(dirs, ["playwright/.cache"]);
  });

  it("routes file globs to the files bucket", () => {
    const { dirs, files } = parseGitignoreExclusions(["*.bin", "package-lock.json"].join("\n"));
    assert.deepEqual(dirs, []);
    assert.deepEqual(files, ["*.bin", "package-lock.json"]);
  });

  it("routes ambiguous single-segment names to BOTH buckets", () => {
    const { dirs, files } = parseGitignoreExclusions("target");
    assert.deepEqual(dirs, ["target"]);
    assert.deepEqual(files, ["target"]);
  });

  it("skips comments, blank lines and negations", () => {
    const { dirs, files } = parseGitignoreExclusions(
      ["# a comment", "", "  ", "!keep/", "dist/"].join("\n"),
    );
    assert.deepEqual(dirs, ["dist"]);
    assert.deepEqual(files, []);
  });

  it("parses the bmbh-requestportal style gitignore end to end", () => {
    const { dirs, files } = parseGitignoreExclusions(
      [
        "*.bin",
        ".vs/*",
        "**/bin/",
        "**/obj/",
        "**/Migrations/*",
        "# Playwright",
        "node_modules/",
        "/test-results/",
        "/playwright-report/",
        "/blob-report/",
        "/playwright/.cache/",
        "/playwright/.auth/",
        "/BMBHRequestPortal/.vs/BMBHRequestPortal",
      ].join("\n"),
    );
    assert.equal(files.includes("*.bin"), true);
    for (const dir of ["bin", "obj", "Migrations", "test-results", "playwright-report", "blob-report"]) {
      assert.equal(dirs.includes(dir), true, `missing dir: ${dir}`);
    }
    // `.vs/*` describes the contents of any .vs dir -> plain `.vs`
    assert.equal(dirs.includes(".vs"), true);
  });

  it("deduplicates case-insensitively", () => {
    const { dirs } = parseGitignoreExclusions(["bin/", "BIN/", "**/Bin"].join("\n"));
    assert.equal(dirs.length, 1);
  });
});

describe("mergeExclusionLists", () => {
  it("preserves existing entries and order, appends only the missing ones", () => {
    const merged = mergeExclusionLists(["node_modules", ".git"], ["node_modules", "obj", "bin"]);
    assert.deepEqual(merged, ["node_modules", ".git", "obj", "bin"]);
  });

  it("is idempotent - re-merging adds nothing", () => {
    const first = mergeExclusionLists(["a"], ["b"]);
    assert.deepEqual(mergeExclusionLists(first, ["b", "a"]), first);
  });

  it("drops non-string and blank existing entries", () => {
    const merged = mergeExclusionLists(["ok", "", 42, null], []);
    assert.deepEqual(merged, ["ok"]);
  });
});
