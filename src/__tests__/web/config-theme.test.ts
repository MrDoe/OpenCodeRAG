import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleConfigPatch,
  readConfigSnapshot,
  type ConfigApiContext,
} from "../../web/config-api.js";

describe("ui.theme persistence", () => {
  let dir: string;
  let workspace: string;
  let globalPath: string;
  let projectPath: string;
  let storePath: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "rag-web-theme-"));
    workspace = join(dir, "workspace");
    mkdirSync(join(workspace, ".opencode"), { recursive: true });
    mkdirSync(join(dir, "global"), { recursive: true });
    globalPath = join(dir, "global", "opencode-rag.json");
    projectPath = join(workspace, ".opencode", "opencode-rag.json");
    storePath = join(dir, "store");
    mkdirSync(storePath, { recursive: true });
    writeFileSync(globalPath, JSON.stringify({}), "utf-8");
    writeFileSync(projectPath, JSON.stringify({}), "utf-8");
  });

  after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function ctx(): ConfigApiContext {
    return {
      workspaceDir: workspace,
      projectConfigPath: projectPath,
      globalConfigPath: globalPath,
      storePath,
      configRef: {},
    };
  }

  it("writes ui.theme to the global layer and reflects it in the snapshot", () => {
    const patch = handleConfigPatch(ctx(), {
      layer: "global",
      operations: [{ op: "set", path: ["ui", "theme"], value: "drama" }],
    });
    assert.equal(patch.status, 200);
    const body = patch.body as Record<string, unknown>;
    const config = body.config as Record<string, unknown>;
    assert.equal((config.ui as Record<string, unknown>).theme, "drama");
    const fresh = readConfigSnapshot(ctx()) as Record<string, unknown>;
    assert.equal(((fresh.config as Record<string, unknown>).ui as Record<string, unknown>).theme, "drama");
  });

  it("rejects an unknown ui.theme with fieldErrors", () => {
    const patch = handleConfigPatch(ctx(), {
      layer: "global",
      operations: [{ op: "set", path: ["ui", "theme"], value: "neon" }],
    });
    assert.equal(patch.status, 400);
    const body = patch.body as Record<string, unknown>;
    assert.ok((body.fieldErrors as Record<string, string>)["ui.theme"]);
  });

  it("rejects ui.theme on the project layer (global-only setting)", () => {
    const patch = handleConfigPatch(ctx(), {
      layer: "project",
      operations: [{ op: "set", path: ["ui", "theme"], value: "drama" }],
    });
    assert.equal(patch.status, 400);
  });
});
