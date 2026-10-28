import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoScaffoldWorkspace } from "../../core/auto-scaffold.js";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-rag-autoscaffold-"));
  writeFileSync(join(dir, "package.json"), "{}", "utf-8");
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("autoScaffoldWorkspace", () => {
  it("creates the missing workspace files once", () => {
    const first = autoScaffoldWorkspace(dir);
    assert.ok(first.created.includes(".opencode/opencode-rag.json"));
    assert.ok(first.created.includes(".opencode/.gitignore"));
    assert.ok(first.created.includes(".opencode/skills/opencode-rag/SKILL.md"));
    assert.ok(first.created.includes(".opencode/skills/make-decision/SKILL.md"));
    assert.ok(first.created.includes("AGENTS.md"));

    const config = JSON.parse(readFileSync(join(dir, ".opencode", "opencode-rag.json"), "utf-8")) as Record<string, unknown>;
    assert.equal(config.embedding, undefined, "provider settings stay global");
    assert.equal(config.setup !== undefined && (config.setup as { autoScaffold: boolean }).autoScaffold, true);
    assert.ok(readFileSync(join(dir, "AGENTS.md"), "utf-8").includes("<!-- BEGIN opencode-rag -->"));

    const second = autoScaffoldWorkspace(dir);
    assert.deepEqual(second.created, [], "second run is a no-op");
  });

  it("respects setup.autoScaffold: false", () => {
    autoScaffoldWorkspace(dir);
    const configPath = join(dir, ".opencode", "opencode-rag.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    config.setup = { autoScaffold: false };
    writeFileSync(configPath, JSON.stringify(config), "utf-8");
    rmSync(join(dir, ".opencode", "skills", "make-decision"), { recursive: true, force: true });

    const result = autoScaffoldWorkspace(dir);
    assert.deepEqual(result.created, []);
    assert.equal(existsSync(join(dir, ".opencode", "skills", "make-decision")), false);
  });

  it("never overwrites an existing AGENTS.md or config", () => {
    writeFileSync(join(dir, "AGENTS.md"), "# Custom\n", "utf-8");
    autoScaffoldWorkspace(dir);
    assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf-8"), "# Custom\n");
    const config = JSON.parse(readFileSync(join(dir, ".opencode", "opencode-rag.json"), "utf-8")) as Record<string, unknown>;
    assert.equal(config.embedding, undefined);
  });
});
