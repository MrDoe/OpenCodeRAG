import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveScopeDirs } from "../../cli/commands/index-command.js";

describe("resolveScopeDirs", () => {
  it("normalizes directories and rejects what is not one inside the workspace", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "index-scope-"));
    try {
      mkdirSync(path.join(cwd, "src", "core"), { recursive: true });
      writeFileSync(path.join(cwd, "file.ts"), "");

      assert.deepEqual(
        await resolveScopeDirs(cwd, ["./src/", path.join(cwd, "src", "core")]),
        ["src", "src/core"],
      );
      assert.equal(await resolveScopeDirs(cwd, undefined), undefined);
      assert.equal(await resolveScopeDirs(cwd, ["src", "."]), undefined);
      await assert.rejects(resolveScopeDirs(cwd, [".."]), /outside the workspace/);
      await assert.rejects(resolveScopeDirs(cwd, ["missing"]), /not a directory/);
      await assert.rejects(resolveScopeDirs(cwd, ["file.ts"]), /not a directory/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
