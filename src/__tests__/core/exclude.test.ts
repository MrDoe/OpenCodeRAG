import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createExcludeMatcher, createIncludeMatcher } from "../../core/exclude.js";

describe("createExcludeMatcher", () => {
  it("plain name matches that basename at any depth", () => {
    const m = createExcludeMatcher(["node_modules"]);
    assert.equal(m.excluded("node_modules"), true);
    assert.equal(m.excluded("src/node_modules"), true);
    assert.equal(m.excluded("src/a/b/c/node_modules"), true);
  });

  it("plain name is case-insensitive", () => {
    const m = createExcludeMatcher(["NODE_MODULES"]);
    assert.equal(m.excluded("node_modules"), true);
    assert.equal(m.excluded("src/NODE_MODULES"), true);
    assert.equal(m.excluded("src/Node_Modules/file.ts"), true);
  });

  it("plain name does not match unrelated", () => {
    const m = createExcludeMatcher(["node_modules"]);
    assert.equal(m.excluded("src"), false);
    assert.equal(m.excluded("src/components"), false);
    assert.equal(m.excluded("node"), false);
  });

  it("basename glob matches that pattern at any depth", () => {
    const m = createExcludeMatcher(["*.generated.ts"]);
    assert.equal(m.excluded("foo.generated.ts"), true);
    assert.equal(m.excluded("src/foo.generated.ts"), true);
    assert.equal(m.excluded("src/a/b/c/foo.generated.ts"), true);
    assert.equal(m.excluded("src/foo.ts"), false);
  });

  it("anchored path matches that directory exactly", () => {
    const m = createExcludeMatcher(["RequestPortal/.config"]);
    assert.equal(m.excluded("RequestPortal/.config"), true);
  });

  it("anchored path matches files under that directory (ancestor prefix)", () => {
    const m = createExcludeMatcher(["RequestPortal/.config"]);
    assert.equal(m.excluded("RequestPortal/.config/settings.json"), true);
    assert.equal(m.excluded("RequestPortal/.config/sub/file.ts"), true);
  });

  it("anchored path does not match sibling directories", () => {
    const m = createExcludeMatcher(["RequestPortal/.config"]);
    assert.equal(m.excluded("RequestPortal/bin"), false);
    assert.equal(m.excluded("RequestPortal/obj"), false);
    assert.equal(m.excluded("Other/.config"), false);
    assert.equal(m.excluded(".config"), false);
  });

  it("multiple anchored paths work independently", () => {
    const m = createExcludeMatcher(["RequestPortal/.config", "RequestPortal/bin"]);
    assert.equal(m.excluded("RequestPortal/.config/file.ts"), true);
    assert.equal(m.excluded("RequestPortal/bin/tool.exe"), true);
    assert.equal(m.excluded("RequestPortal/obj/thing.o"), false);
  });

  it("double-star glob matches at any depth (rooted)", () => {
    const m = createExcludeMatcher(["**/*.test.ts"]);
    assert.equal(m.excluded("foo.test.ts"), true);
    assert.equal(m.excluded("src/foo.test.ts"), true);
    assert.equal(m.excluded("src/a/b/c/foo.test.ts"), true);
    assert.equal(m.excluded("src/foo.ts"), false);
  });

  it("normalizes backslash to forward slash", () => {
    const m = createExcludeMatcher(["RequestPortal/.config"]);
    assert.equal(m.excluded("RequestPortal\\.config"), true);
    assert.equal(m.excluded("RequestPortal\\.config\\sub\\file.ts"), true);
  });

  it("empty patterns never match", () => {
    const m = createExcludeMatcher([]);
    assert.equal(m.excluded("anything"), false);
    assert.equal(m.excluded("node_modules/file.ts"), false);
    assert.equal(m.excluded("src"), false);
  });

  it("dot:true allows matching dotfiles", () => {
    const m = createExcludeMatcher([".vscode"]);
    assert.equal(m.excluded(".vscode"), true);
    assert.equal(m.excluded("src/.vscode"), true);
    assert.equal(m.excluded("src/.vscode/settings.json"), true);
  });

  it("single segment is not anchored - matches any depth", () => {
    const m = createExcludeMatcher(["dist"]);
    assert.equal(m.excluded("dist"), true);
    assert.equal(m.excluded("src/dist"), true);
    assert.equal(m.excluded("pkg/dist/asset.js"), true);
  });

  it("pattern with ** and specific subpath", () => {
    const m = createExcludeMatcher(["**/test/output"]);
    assert.equal(m.excluded("test/output"), true);
    assert.equal(m.excluded("src/test/output"), true);
    assert.equal(m.excluded("src/test/input"), false);
  });

  it("non-matching patterns return false", () => {
    const m = createExcludeMatcher(["RequestPortal/.config"]);
    assert.equal(m.excluded(""), false);
    assert.equal(m.excluded("RequestPortal"), false);
    assert.equal(m.excluded("RequestPortal/Migrations"), false);
  });
});

describe("createIncludeMatcher", () => {
  it("empty patterns include everything (whole workspace)", () => {
    const m = createIncludeMatcher([]);
    assert.equal(m.included(""), true);
    assert.equal(m.included("src"), true);
    assert.equal(m.included("src/index.ts"), true);
    assert.equal(m.included("docs/readme.md"), true);
  });

  it("root is always included so the walk can descend", () => {
    const m = createIncludeMatcher(["docs"]);
    assert.equal(m.included(""), true);
  });

  it("plain folder matches that folder and everything under it", () => {
    const m = createIncludeMatcher(["docs"]);
    assert.equal(m.included("docs"), true);
    assert.equal(m.included("docs/sub"), true);
    assert.equal(m.included("docs/sub/file.md"), true);
  });

  it("plain folder is anchored to the root (no any-depth matching)", () => {
    const m = createIncludeMatcher(["docs"]);
    assert.equal(m.included("src"), false);
    assert.equal(m.included("src/docs"), false);
    assert.equal(m.included("src/docs/file.md"), false);
    assert.equal(m.included("other-docs"), false);
  });

  it("multi-segment folder matches only that root-anchored subtree", () => {
    const m = createIncludeMatcher(["a/b"]);
    assert.equal(m.included("a"), false);
    assert.equal(m.included("a/b"), true);
    assert.equal(m.included("a/b/c/file.ts"), true);
    assert.equal(m.included("a/x"), false);
    assert.equal(m.included("x/a/b"), false);
  });

  it("glob patterns are root-anchored", () => {
    const m = createIncludeMatcher(["docs/**"]);
    assert.equal(m.included("docs"), true);
    assert.equal(m.included("docs/sub/file.md"), true);
    assert.equal(m.included("other/docs/sub/file.md"), false);
  });

  it("brace expansion matches multiple folders", () => {
    const m = createIncludeMatcher(["src/{a,b}"]);
    assert.equal(m.included("src/a"), true);
    assert.equal(m.included("src/b/file.ts"), true);
    assert.equal(m.included("src/c"), false);
  });

  it("multiple patterns are OR-ed", () => {
    const m = createIncludeMatcher(["docs", "src"]);
    assert.equal(m.included("docs/readme.md"), true);
    assert.equal(m.included("src/index.ts"), true);
    assert.equal(m.included("tests"), false);
  });

  it("normalizes backslashes and dot-slash prefixes", () => {
    const m = createIncludeMatcher(["./docs/", "src\\nested"]);
    assert.equal(m.included("docs"), true);
    assert.equal(m.included("src/nested"), true);
    assert.equal(m.included("src/nested/x.ts"), true);
    assert.equal(m.included("src/other"), false);
  });

  it("is case-insensitive", () => {
    const m = createIncludeMatcher(["Docs"]);
    assert.equal(m.included("docs/sub/file.md"), true);
  });
});
