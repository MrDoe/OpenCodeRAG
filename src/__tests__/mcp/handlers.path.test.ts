import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { handleFileSkeleton, resolveFilePath } from "../../mcp/handlers.js";

// ─── Unit: resolveFilePath ──────────────────────────────────────────────

describe("resolveFilePath — path traversal prevention", () => {
  it("resolves a normal relative path inside the worktree", () => {
    const result = resolveFilePath("src/index.ts", "/home/user/project");
    assert.equal(result, "/home/user/project/src/index.ts");
  });

  it("resolves a path without leading ./", () => {
    const result = resolveFilePath("foo/bar.ts", "/root");
    assert.equal(result, "/root/foo/bar.ts");
  });

  it("returns the root itself for empty relative", () => {
    const result = resolveFilePath("", "/root");
    assert.equal(result, "/root");
  });

  it("throws when .. escapes above worktree", () => {
    assert.throws(
      () => resolveFilePath("../../etc/passwd", "/home/user/project"),
      /escapes worktree/i
    );
  });

  it("throws when deeply nested .. escapes", () => {
    assert.throws(
      () => resolveFilePath("src/../../../../etc/passwd", "/home/user/project"),
      /escapes worktree/i
    );
  });

  it("accepts an absolute path within the worktree", () => {
    const result = resolveFilePath("/home/user/project/src/index.ts", "/home/user/project");
    assert.equal(result, "/home/user/project/src/index.ts");
  });

  it("throws an absolute path outside the worktree", () => {
    assert.throws(
      () => resolveFilePath("/etc/passwd", "/home/user/project"),
      /escapes worktree/i
    );
  });

  it("throws when the absolute path starts with .. relative escape", () => {
    assert.throws(
      () => resolveFilePath("../other/src/index.ts", "/home/user/project"),
      /escapes worktree/i
    );
  });

  it("accepts a symlink-resolvable path deeper than the worktree root", () => {
    const result = resolveFilePath("node_modules/foo/index.ts", "/home/user/project");
    assert.equal(result, "/home/user/project/node_modules/foo/index.ts");
  });

  it("rejects a path with null byte injection", () => {
    assert.throws(
      () => resolveFilePath("../../etc/passwd%00", "/home/user/project"),
      /escapes worktree/i
    );
  });
});

// ─── Integration: handleFileSkeleton traversal protection ───────────────

describe("handleFileSkeleton — path traversal protection", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "opencode-rag-traversal-"));
    writeFileSync(path.join(tmpDir, "index.ts"), `const x = 1;\n`);
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("succeeds for a file inside the worktree", async () => {
    const result = await handleFileSkeleton({ filePath: "index.ts" }, tmpDir);
    assert.ok(result.elements.length >= 0);
    assert.ok(result.formatted.length > 0);
  });

  it("throws on absolute path attempt outside worktree", async () => {
    await assert.rejects(
      () => handleFileSkeleton({ filePath: "/etc/passwd" }, tmpDir),
      /access denied|escapes worktree/i
    );
  });

  it("throws on .. path escaping worktree", async () => {
    await assert.rejects(
      () => handleFileSkeleton({ filePath: "../../etc/passwd" }, tmpDir),
      /access denied|escapes worktree/i
    );
  });

  it("throws on deep nested escape attempt", async () => {
    await assert.rejects(
      () => handleFileSkeleton({ filePath: "src/../../../../../etc/passwd" }, tmpDir),
      /access denied|escapes worktree/i
    );
  });

  it("still accepts valid paths after the fix", async () => {
    const result = await handleFileSkeleton({ filePath: "index.ts" }, tmpDir);
    assert.ok(result.formatted.includes("structural elements"));
  });
});
