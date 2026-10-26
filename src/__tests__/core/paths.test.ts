import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { homedir } from "node:os";
import { expandTilde, resolveUserPath } from "../../core/paths.js";

describe("expandTilde", () => {
  it("expands a bare ~ to the home directory", () => {
    assert.equal(expandTilde("~"), homedir());
  });

  it("expands a ~/ prefix", () => {
    assert.equal(expandTilde("~/Pictures/a.png"), path.join(homedir(), "Pictures", "a.png"));
  });

  it("expands a ~\\ prefix (Windows-style separator)", { skip: process.platform !== "win32" }, () => {
    assert.equal(expandTilde("~\\Pictures\\a.png"), path.join(homedir(), "Pictures", "a.png"));
  });

  it("leaves ~user and ordinary paths unchanged", () => {
    assert.equal(expandTilde("~other/a.png"), "~other/a.png");
    assert.equal(expandTilde("./docs/a.png"), "./docs/a.png");
    assert.equal(expandTilde("C:\\Temp\\a.png"), "C:\\Temp\\a.png");
  });
});

describe("resolveUserPath", () => {
  const base = path.resolve("/project");

  it("resolves relative paths against the base directory", () => {
    assert.equal(resolveUserPath(base, "docs/a.png"), path.join(base, "docs", "a.png"));
  });

  it("returns absolute paths inside the base unchanged", () => {
    const inside = path.join(base, "docs", "a.png");
    assert.equal(resolveUserPath(base, inside), inside);
  });

  it("accepts absolute paths outside the base", () => {
    const outside = path.resolve("/elsewhere/a.png");
    assert.equal(resolveUserPath(base, outside), outside);
  });

  it("does not reject parent traversal outside the base", () => {
    assert.equal(
      resolveUserPath(base, "../other/a.png"),
      path.resolve(base, "..", "other", "a.png")
    );
  });
});
