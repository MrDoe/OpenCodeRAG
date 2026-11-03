import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleConfigLayers,
  handleConfigPatch,
  readConfigSnapshot,
  type ConfigApiContext,
} from "../../web/config-api.js";
import {
  SETTINGS_SECTIONS,
  collectConfigLeafPaths,
  findSettingField,
  IGNORED_CONFIG_PATHS,
} from "../../web/config-schema.js";
import { DEFAULT_CONFIG } from "../../core/config.js";
import { loadRuntimeOverrides, saveRuntimeOverride } from "../../core/runtime-overrides.js";

describe("config schema", () => {
  it("covers every leaf of DEFAULT_CONFIG", () => {
    const missing: string[] = [];
    for (const leaf of collectConfigLeafPaths(DEFAULT_CONFIG)) {
      if (IGNORED_CONFIG_PATHS.has(leaf)) continue;
      const path = leaf.split(".");
      if (!findSettingField(path)) missing.push(leaf);
    }
    assert.deepEqual(missing, [], `settings missing from the schema: ${missing.join(", ")}`);
  });

  it("has unique paths", () => {
    const seen = new Set<string>();
    for (const section of SETTINGS_SECTIONS) {
      for (const entry of section.fields) {
        const key = entry.path.join(".");
        assert.equal(seen.has(key), false, `duplicate schema path: ${key}`);
        seen.add(key);
      }
    }
  });

  it("marks provider leaves as global and never as project", () => {
    const embeddingModel = findSettingField(["embedding", "model"]);
    assert.equal(embeddingModel?.scope, "global");
    assert.equal(findSettingField(["retrieval", "topK"])?.scope, "project");
  });
});

describe("layered config API", () => {
  let dir: string;
  let workspace: string;
  let globalPath: string;
  let projectPath: string;
  let storePath: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "rag-web-layers-"));
    workspace = join(dir, "workspace");
    mkdirSync(join(workspace, ".opencode"), { recursive: true });
    globalPath = join(dir, "global", "opencode-rag.json");
    projectPath = join(workspace, ".opencode", "opencode-rag.json");
    storePath = join(dir, "store");
    mkdirSync(storePath, { recursive: true });
  });

  after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function reset(): void {
    mkdirSync(join(dir, "global"), { recursive: true });
    writeFileSync(globalPath, JSON.stringify({ embedding: { apiKey: "sk-global" } }), "utf-8");
    writeFileSync(
      projectPath,
      JSON.stringify({ retrieval: { topK: 12 }, memory: { autoInjectMinTokenOverlap: 3 } }),
      "utf-8",
    );
    try {
      rmSync(join(storePath, "runtime-overrides.json"), { force: true });
    } catch {
      // ignore
    }
  }

  function ctx(): ConfigApiContext {
    return {
      workspaceDir: workspace,
      projectConfigPath: projectPath,
      globalConfigPath: globalPath,
      storePath,
      configRef: {},
    };
  }

  function snapshot(): Record<string, unknown> {
    return readConfigSnapshot(ctx());
  }

  function layerOf(body: Record<string, unknown>, name: "project" | "global"): Record<string, unknown> {
    const layers = body.layers as Record<string, Record<string, unknown>>;
    return layers[name]!;
  }

  it("reads both layers, the effective config, and provenance", () => {
    reset();
    const body = snapshot();
    assert.equal(layerOf(body, "project").exists, true);
    assert.equal(layerOf(body, "global").exists, true);

    const projectValues = layerOf(body, "project").values as Record<string, unknown>;
    assert.deepEqual(projectValues.retrieval, { topK: 12 });

    const config = body.config as Record<string, unknown>;
    assert.equal((config.retrieval as Record<string, unknown>).topK, 12);

    const provenance = body.provenance as Record<string, string>;
    assert.equal(provenance["retrieval.topK"], "project");
    assert.equal(provenance["embedding.provider"], "default");
  });

  it("never returns secret values but reports whether they are set", () => {
    reset();
    const body = snapshot();
    const globalLayer = layerOf(body, "global");
    assert.equal((globalLayer.values as Record<string, unknown>).embedding, undefined);
    assert.deepEqual(globalLayer.secretSet, { "embedding.apiKey": true });

    const config = body.config as Record<string, unknown>;
    assert.equal((config.embedding as Record<string, unknown>).apiKey, "***");
  });

  it("does not redact numeric settings whose names contain 'Token'", () => {
    reset();
    const config = snapshot().config as Record<string, unknown>;
    assert.equal((config.memory as Record<string, unknown>).autoInjectMinTokenOverlap, 3);
  });

  it("writes a project value and clears a matching runtime override", () => {
    reset();
    saveRuntimeOverride(storePath, ["retrieval", "topK"], 99);
    const mtimeMs = statSync(projectPath).mtimeMs;
    const res = handleConfigPatch(ctx(), {
      layer: "project",
      operations: [{ op: "set", path: ["retrieval", "topK"], value: 7 }],
      base: { project: { mtimeMs } },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const onDisk = JSON.parse(readFileSync(projectPath, "utf-8")) as Record<string, unknown>;
    assert.deepEqual(onDisk.retrieval, { topK: 7 });
    assert.deepEqual(loadRuntimeOverrides(storePath), {});
    const body = res.body as Record<string, unknown>;
    assert.equal((body.saved as Record<string, unknown>).impact, "live");
  });

  it("rejects a provider setting written to the project layer", () => {
    reset();
    const res = handleConfigPatch(ctx(), {
      layer: "project",
      operations: [{ op: "set", path: ["embedding", "model"], value: "other" }],
    });
    assert.equal(res.status, 400);
    const body = res.body as Record<string, unknown>;
    assert.equal(body.code, "invalid-fields");
    assert.match(JSON.stringify(body.fieldErrors), /machine-global/);
  });

  it("allows the same provider setting in the global layer", () => {
    reset();
    const res = handleConfigPatch(ctx(), {
      layer: "global",
      operations: [{ op: "set", path: ["embedding", "model"], value: "nomic-embed" }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const onDisk = JSON.parse(readFileSync(globalPath, "utf-8")) as Record<string, unknown>;
    assert.equal((onDisk.embedding as Record<string, unknown>).model, "nomic-embed");
  });

  it("treats the *** sentinel as unchanged", () => {
    reset();
    const res = handleConfigPatch(ctx(), {
      layer: "global",
      operations: [{ op: "set", path: ["embedding", "apiKey"], value: "***" }],
    });
    assert.equal(res.status, 200);
    const onDisk = JSON.parse(readFileSync(globalPath, "utf-8")) as Record<string, unknown>;
    assert.equal((onDisk.embedding as Record<string, unknown>).apiKey, "sk-global");
  });

  it("writes a real secret value and unsets it", () => {
    reset();
    let res = handleConfigPatch(ctx(), {
      layer: "global",
      operations: [{ op: "set", path: ["embedding", "apiKey"], value: "sk-new" }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    let onDisk = JSON.parse(readFileSync(globalPath, "utf-8")) as Record<string, unknown>;
    assert.equal((onDisk.embedding as Record<string, unknown>).apiKey, "sk-new");

    res = handleConfigPatch(ctx(), {
      layer: "global",
      operations: [{ op: "unset", path: ["embedding", "apiKey"] }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    onDisk = JSON.parse(readFileSync(globalPath, "utf-8")) as Record<string, unknown>;
    const embedding = onDisk.embedding as Record<string, unknown> | undefined;
    assert.equal(embedding?.apiKey, undefined);
  });

  it("returns 409 when the layer changed on disk", () => {
    reset();
    const res = handleConfigPatch(ctx(), {
      layer: "project",
      operations: [{ op: "set", path: ["retrieval", "topK"], value: 7 }],
      base: { project: { mtimeMs: 1 } },
    });
    assert.equal(res.status, 409);
    assert.equal((res.body as Record<string, unknown>).code, "stale-layer");
  });

  it("returns 422 for a malformed layer and still serves a snapshot", () => {
    reset();
    writeFileSync(projectPath, "{ not json", "utf-8");
    const res = handleConfigPatch(ctx(), {
      layer: "project",
      operations: [{ op: "set", path: ["retrieval", "topK"], value: 7 }],
    });
    assert.equal(res.status, 422);
    assert.equal((res.body as Record<string, unknown>).code, "invalid-json");

    const body = snapshot();
    assert.match(String(layerOf(body, "project").error), /JSON/);
    const warnings = body.warnings as Array<Record<string, unknown>>;
    assert.equal(warnings.some((warning) => warning.code === "invalid-json"), true);
  });

  it("clears a runtime override without touching either file", () => {
    reset();
    saveRuntimeOverride(storePath, ["retrieval", "topK"], 99);
    const before = readFileSync(projectPath, "utf-8");
    const res = handleConfigPatch(ctx(), {
      layer: "runtime",
      operations: [{ op: "unset", path: ["retrieval", "topK"] }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(readFileSync(projectPath, "utf-8"), before);
    assert.deepEqual(loadRuntimeOverrides(storePath), {});
  });

  it("rejects unsafe or unknown paths", () => {
    reset();
    const unsafe = handleConfigPatch(ctx(), {
      layer: "project",
      operations: [{ op: "set", path: ["__proto__", "polluted"], value: true }],
    });
    assert.equal(unsafe.status, 400);

    const unknown = handleConfigPatch(ctx(), {
      layer: "project",
      operations: [{ op: "set", path: ["retrieval", "nope"], value: true }],
    });
    assert.equal(unknown.status, 400);
    assert.match(JSON.stringify((unknown.body as Record<string, unknown>).fieldErrors), /Unknown setting/);
  });

  it("GET keeps the legacy `config` key alongside the new payload", () => {
    reset();
    const res = handleConfigLayers(ctx());
    assert.equal(res.status, 200);
    const body = res.body as Record<string, unknown>;
    assert.equal(typeof body.config, "object");
    assert.ok(Array.isArray((body.schema as Record<string, unknown>).sections));
  });

  it("edits a legacy root config in place instead of creating a canonical file", () => {
    const root = mkdtempSync(join(tmpdir(), "rag-web-legacy-"));
    try {
      const ws = join(root, "ws");
      mkdirSync(ws, { recursive: true });
      const legacy = join(ws, "opencode-rag.json");
      writeFileSync(legacy, JSON.stringify({ retrieval: { topK: 5 } }), "utf-8");
      const store = join(root, "store");
      mkdirSync(store, { recursive: true });

      const local: ConfigApiContext = {
        workspaceDir: ws,
        projectConfigPath: join(ws, ".opencode", "opencode-rag.json"),
        globalConfigPath: join(root, "global.json"),
        storePath: store,
        configRef: {},
      };
      const res = handleConfigPatch(local, {
        layer: "project",
        operations: [{ op: "set", path: ["retrieval", "topK"], value: 9 }],
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const onDisk = JSON.parse(readFileSync(legacy, "utf-8")) as Record<string, unknown>;
      assert.equal((onDisk.retrieval as Record<string, unknown>).topK, 9);
      assert.equal(existsSync(join(ws, ".opencode", "opencode-rag.json")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps an explicit --config file authoritative", () => {
    const root = mkdtempSync(join(tmpdir(), "rag-web-explicit-"));
    try {
      const ws = join(root, "ws");
      mkdirSync(join(ws, ".opencode"), { recursive: true });
      const canonical = join(ws, ".opencode", "opencode-rag.json");
      const explicit = join(ws, "custom.json");
      writeFileSync(canonical, JSON.stringify({ retrieval: { topK: 7 } }), "utf-8");
      writeFileSync(explicit, JSON.stringify({ retrieval: { topK: 3 } }), "utf-8");
      const store = join(root, "store");
      mkdirSync(store, { recursive: true });

      const local: ConfigApiContext = {
        workspaceDir: ws,
        projectConfigPath: explicit,
        globalConfigPath: join(root, "global.json"),
        storePath: store,
        configRef: {},
      };
      const res = handleConfigPatch(local, {
        layer: "project",
        operations: [{ op: "set", path: ["retrieval", "topK"], value: 4 }],
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(
        ((JSON.parse(readFileSync(explicit, "utf-8")) as Record<string, unknown>).retrieval as Record<string, unknown>).topK,
        4,
      );
      assert.equal(
        ((JSON.parse(readFileSync(canonical, "utf-8")) as Record<string, unknown>).retrieval as Record<string, unknown>).topK,
        7,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the healthy layer when the other layer is malformed", () => {
    reset();
    writeFileSync(globalPath, "{ not json", "utf-8");
    const config = snapshot().config as Record<string, unknown>;
    assert.equal((config.retrieval as Record<string, unknown>).topK, 12);
  });

  it("reports a provider secret duplicated in the project file", () => {
    reset();
    writeFileSync(projectPath, JSON.stringify({ embedding: { apiKey: "sk-project" } }), "utf-8");
    const warnings = snapshot().warnings as Array<Record<string, unknown>>;
    const shadowed = warnings.find((warning) => warning.code === "provider-shadowed");
    assert.ok(shadowed, "expected a provider-shadowed warning");
    assert.match(JSON.stringify(shadowed.paths), /embedding\.apiKey/);
  });
});
