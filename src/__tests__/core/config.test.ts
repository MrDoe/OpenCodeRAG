import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadConfigLayers, loadWorkspaceConfig, loadWorkspaceRawConfig, resolveConfigPaths, configuredSections, globalConfigPath, findGlobalConfigFile, findConfigFile, projectConfigPath, migrateLegacyProjectConfig, ensureConfigFile, updateGlobalConfigValue, isProviderScopedPath, DEFAULT_CONFIG, resolveLogConfig, validateConfig, updateConfigValue } from "../../core/config.js";
import { getRegisteredExtensions } from "../../chunker/factory.js";

describe("loadConfig", () => {
  let tmpFile: string;

  before(() => {
    tmpFile = join(tmpdir(), `opencode-rag-test-${Date.now()}.json`);
  });

  after(() => {
    try {
      unlinkSync(tmpFile);
    } catch {
      // ignore
    }
  });

  it("returns default config for empty file", () => {
    writeFileSync(tmpFile, "{}", "utf-8");
    const config = loadConfig(tmpFile);
    assert.deepStrictEqual(config, { ...DEFAULT_CONFIG, chunkers: undefined, chunking: { nodeTypes: {}, parsers: {} } });
  });

  const partialOverrideCases: {
    name: string;
    json: Record<string, unknown>;
    assert: (config: ReturnType<typeof loadConfig>) => void;
  }[] = [
    {
      name: "embedding proxy",
      json: { embedding: { proxy: { url: "http://proxy:8080" } } },
      assert: (c) => assert.equal(c.embedding.proxy?.url, "http://proxy:8080"),
    },
    {
      name: "embedding provider and model",
      json: { embedding: { provider: "openai", model: "custom-model" } },
      assert: (c) => {
        assert.equal(c.embedding.provider, "openai");
        assert.equal(c.embedding.model, "custom-model");
        assert.equal(c.embedding.baseUrl, DEFAULT_CONFIG.embedding.baseUrl);
      },
    },
    {
      name: "indexing chunkOverlap",
      json: { indexing: { chunkOverlap: 5 } },
      assert: (c) => {
        assert.equal(c.indexing.chunkOverlap, 5);
        assert.deepStrictEqual(c.indexing.includeExtensions, DEFAULT_CONFIG.indexing.includeExtensions);
      },
    },
    {
      name: "retrieval topK",
      json: { retrieval: { topK: 20 } },
      assert: (c) => assert.equal(c.retrieval.topK, 20),
    },
    {
      name: "openCode maxContextChunks",
      json: { openCode: { maxContextChunks: 10 } },
      assert: (c) => {
        assert.equal(c.openCode.maxContextChunks, 10);
        assert.equal(c.openCode.enabled, DEFAULT_CONFIG.openCode.enabled);
      },
    },
    {
      name: "vectorStore path",
      json: { vectorStore: { path: "/custom/path" } },
      assert: (c) => assert.equal(c.vectorStore.path, "/custom/path"),
    },
    {
      name: "decision model",
      json: { decision: { model: "tev1:0.8b" } },
      assert: (c) => {
        assert.equal(c.decision?.model, "tev1:0.8b");
        assert.equal(c.decision?.enabled, DEFAULT_CONFIG.decision?.enabled);
        assert.equal(c.decision?.timeoutMs, DEFAULT_CONFIG.decision?.timeoutMs);
      },
    },
    {
      name: "imageDescription onDemand",
      json: { imageDescription: { onDemand: { provider: "openai", model: "gpt-4o-mini" } } },
      assert: (c) => {
        assert.equal(c.imageDescription?.onDemand?.provider, "openai");
        assert.equal(c.imageDescription?.onDemand?.model, "gpt-4o-mini");
        assert.equal(c.imageDescription?.model, DEFAULT_CONFIG.imageDescription?.model);
      },
    },
    {
      name: "logging level",
      json: { logging: { level: "debug" } },
      assert: (c) => {
        assert.equal(c.logging.level, "debug");
        assert.equal(c.logging.logFilePath, DEFAULT_CONFIG.logging.logFilePath);
      },
    },
    {
      name: "chunking parsers",
      json: { chunking: { parsers: { CXX: "CPP", ".cu": "cpp" } } },
      assert: (c) => {
        assert.deepStrictEqual(c.chunking?.parsers, { ".cxx": "cpp", ".cu": "cpp" });
        assert.deepStrictEqual(c.chunking?.nodeTypes, {});
      },
    },
    {
      name: "chunking nodeTypes alongside parsers",
      json: { chunking: { nodeTypes: { cpp: ["function_definition"] } } },
      assert: (c) => {
        assert.deepStrictEqual(c.chunking?.nodeTypes, { cpp: ["function_definition"] });
        assert.deepStrictEqual(c.chunking?.parsers, {});
      },
    },
    {
      name: "chunking parsers drops invalid entries",
      json: { chunking: { parsers: { "src/invalid": "cpp", ".ok": "", ".fine": "cpp" } } },
      assert: (c) => {
        assert.deepStrictEqual(c.chunking?.parsers, { ".fine": "cpp" });
      },
    },
  ];

  for (const { name, json, assert: assertion } of partialOverrideCases) {
    it(`allows partial override of ${name}`, () => {
      writeFileSync(tmpFile, JSON.stringify(json), "utf-8");
      const config = loadConfig(tmpFile);
      assertion(config);
    });
  }
});

describe("updateConfigValue", () => {
  let tmpFile: string;

  before(() => {
    tmpFile = join(tmpdir(), `opencode-rag-update-${Date.now()}.json`);
  });

  after(() => {
    try {
      unlinkSync(tmpFile);
    } catch {
      // ignore
    }
  });

  it("writes a nested value and round-trips through loadConfig", () => {
    writeFileSync(tmpFile, JSON.stringify({ indexing: { includeDirs: [] } }), "utf-8");
    const ok = updateConfigValue(tmpFile, ["indexing", "includeDirs"], ["docs", "src"]);
    assert.equal(ok, true);
    const config = loadConfig(tmpFile);
    assert.deepStrictEqual(config.indexing.includeDirs, ["docs", "src"]);
  });

  it("creates the parent object when the key does not exist yet", () => {
    writeFileSync(tmpFile, "{}", "utf-8");
    const ok = updateConfigValue(tmpFile, ["indexing", "includeDirs"], ["docs"]);
    assert.equal(ok, true);
    const config = loadConfig(tmpFile);
    assert.deepStrictEqual(config.indexing.includeDirs, ["docs"]);
  });

  it("returns false for a missing file", () => {
    const missing = join(tmpdir(), `opencode-rag-does-not-exist-${Date.now()}.json`);
    assert.equal(updateConfigValue(missing, ["indexing", "includeDirs"], ["docs"]), false);
  });

  it("preserves other keys and tolerates a BOM", () => {
    writeFileSync(tmpFile, "\uFEFF{\"embedding\": {\"model\": \"keep-me\"}}", "utf-8");
    const ok = updateConfigValue(tmpFile, ["indexing", "includeDirs"], ["docs"]);
    assert.equal(ok, true);
    const config = loadConfig(tmpFile);
    assert.equal(config.embedding.model, "keep-me");
    assert.deepStrictEqual(config.indexing.includeDirs, ["docs"]);
  });
});

describe("DEFAULT_CONFIG", () => {
  it("has ollama as default embedding provider", () => {
    assert.equal(DEFAULT_CONFIG.embedding.provider, "ollama");
  });

  it("includes TypeScript extensions", () => {
    assert.ok(DEFAULT_CONFIG.indexing.includeExtensions.includes(".ts"));
    assert.ok(DEFAULT_CONFIG.indexing.includeExtensions.includes(".tsx"));
  });

  it("includes every registered chunker extension", () => {
    const configured = new Set(DEFAULT_CONFIG.indexing.includeExtensions);
    for (const extension of getRegisteredExtensions()) {
      assert.ok(
        configured.has(extension),
        `expected default config to include ${extension}`
      );
    }
  });

  it("excludes node_modules, .git, and .opencode", () => {
    assert.ok(DEFAULT_CONFIG.indexing.excludeDirs.includes("node_modules"));
    assert.ok(DEFAULT_CONFIG.indexing.excludeDirs.includes(".git"));
    assert.ok(DEFAULT_CONFIG.indexing.excludeDirs.includes(".opencode"));
  });

  it("has openCode enabled by default", () => {
    assert.equal(DEFAULT_CONFIG.openCode.enabled, true);
  });

  it("has topK of 20", () => {
    assert.equal(DEFAULT_CONFIG.retrieval.topK, 20);
  });

  it("has minScore of 0.35 (calibrated for RRF scoring)", () => {
    assert.equal(DEFAULT_CONFIG.retrieval.minScore, 0.35);
  });

  it("has info as default logging level", () => {
    assert.equal(DEFAULT_CONFIG.logging.level, "info");
  });

  it("has default logFilePath", () => {
    assert.equal(DEFAULT_CONFIG.logging.logFilePath, "./.opencode/opencode-rag.log");
  });

  it("opens the TUI settings dialog with a single legacy-safe chord", () => {
    // alt+<letter> is the only modifier shape every terminal encodes (ESC + key);
    // ctrl+shift+<letter> needs the Kitty keyboard protocol, so it is never a
    // default and there is exactly one settings binding.
    assert.equal(DEFAULT_CONFIG.tui.settingsKeybinding, "alt+s");
  });

  it("defaults the decision model to disabled with tev1:4b", () => {
    const decision = DEFAULT_CONFIG.decision;
    assert.ok(decision, "decision config must exist");
    assert.equal(decision.enabled, false, "tev1 needs Ollama >= 0.35 and a pulled model");
    assert.equal(decision.provider, "ollama");
    assert.equal(decision.model, "tev1:4b");
    assert.equal(decision.timeoutMs, 120000);
    assert.equal(decision.maxStateChars, 8000);
    assert.equal(decision.routeBeforeAsking, false);
  });

  it("defaults quirk auto-injection to a high relevance bar", () => {
    // Injected quirks occupy context on every turn, so the default bar must
    // be strict: only strongly relevant quirks qualify, at most one per turn,
    // and only when they lexically overlap the user's current message. Manual
    // recall_quirks uses the lower recallMinScore.
    const mem = DEFAULT_CONFIG.memory;
    assert.ok(mem, "memory config must exist");
    assert.equal(mem.autoInjectMinScore, 0.75, "auto-injection must require a high relevance score");
    assert.ok(mem.autoInjectMinScore >= mem.recallMinScore, "auto-inject bar must not be lower than manual recall");
    assert.equal(mem.autoInjectTopK, 1, "at most one quirk per turn by default");
    assert.equal(mem.autoInjectMinTokenOverlap, 2, "lexical gate must require >=2 shared tokens");
  });
});

describe("resolveLogConfig", () => {
  it("returns default values when config has no logging", () => {
    const { level, logFilePath } = resolveLogConfig({ ...DEFAULT_CONFIG, logging: DEFAULT_CONFIG.logging });
    assert.equal(level, "info");
    assert.equal(logFilePath, "./.opencode/opencode-rag.log");
  });

  it("uses config values when provided", () => {
    const config = { ...DEFAULT_CONFIG, logging: { level: "error" as const, logFilePath: "/custom/path.log" } };
    const { level, logFilePath } = resolveLogConfig(config);
    assert.equal(level, "error");
    assert.equal(logFilePath, "/custom/path.log");
  });

  it("config level overrides default", () => {
    const config = { ...DEFAULT_CONFIG, logging: { level: "debug" as const, logFilePath: DEFAULT_CONFIG.logging.logFilePath } };
    const result = resolveLogConfig(config);
    assert.equal(result.level, "debug");
  });

  it("config logFilePath overrides env var", () => {
    const config = { ...DEFAULT_CONFIG, logging: { level: "info" as const, logFilePath: "/config/path.log" } };
    const { logFilePath } = resolveLogConfig(config);
    assert.equal(logFilePath, "/config/path.log");
  });
});

describe("validateConfig", () => {
  it("returns valid for default config", () => {
    const result = validateConfig(DEFAULT_CONFIG);
    assert.equal(result.valid, true);
    assert.deepEqual(result.warnings, []);
  });

  it("warns about unknown top-level keys", () => {
    const cfg = { ...DEFAULT_CONFIG, unknownKey: "test" } as typeof DEFAULT_CONFIG;
    const result = validateConfig(cfg);
    assert.equal(result.valid, false);
    assert.ok(result.warnings.some(w => w.includes("unknownKey")));
  });

  it("warns about invalid embedding provider", () => {
    const cfg = { ...DEFAULT_CONFIG, embedding: { ...DEFAULT_CONFIG.embedding, provider: "invalid" } };
    const result = validateConfig(cfg);
    assert.equal(result.valid, false);
    assert.ok(result.warnings.some(w => w.includes("embedding.provider")));
  });

  it("warns about invalid embedding.baseUrl", () => {
    const cfg = { ...DEFAULT_CONFIG, embedding: { ...DEFAULT_CONFIG.embedding, baseUrl: "not-a-url" } };
    const result = validateConfig(cfg);
    assert.equal(result.valid, false);
    assert.ok(result.warnings.some(w => w.includes("embedding.baseUrl")));
  });

  it("warns about negative chunkOverlap", () => {
    const cfg = { ...DEFAULT_CONFIG, indexing: { ...DEFAULT_CONFIG.indexing, chunkOverlap: -1 } };
    const result = validateConfig(cfg);
    assert.equal(result.valid, false);
    assert.ok(result.warnings.some(w => w.includes("chunkOverlap")));
  });

  it("warns about topK <= 0", () => {
    const cfg = { ...DEFAULT_CONFIG, retrieval: { ...DEFAULT_CONFIG.retrieval, topK: 0 } };
    const result = validateConfig(cfg);
    assert.equal(result.valid, false);
    assert.ok(result.warnings.some(w => w.includes("topK")));
  });

  it("warns about minScore out of range", () => {
    const cfg = { ...DEFAULT_CONFIG, retrieval: { ...DEFAULT_CONFIG.retrieval, minScore: 1.5 } };
    const result = validateConfig(cfg);
    assert.equal(result.valid, false);
    assert.ok(result.warnings.some(w => w.includes("minScore")));
  });

  it("warns about invalid logging level", () => {
    const cfg = { ...DEFAULT_CONFIG, logging: { level: "trace" as "debug", logFilePath: "./log" } };
    const result = validateConfig(cfg);
    assert.equal(result.valid, false);
    assert.ok(result.warnings.some(w => w.includes("logging.level")));
  });

  it("accepts 'none' as valid logging level", () => {
    const cfg = { ...DEFAULT_CONFIG, logging: { level: "none" as const, logFilePath: "./log" } };
    const result = validateConfig(cfg);
    assert.ok(!result.warnings.some(w => w.includes("logging.level")));
  });

  it("warns about invalid ui.port", () => {
    const cfg = { ...DEFAULT_CONFIG, ui: { port: 99999, openBrowser: false } };
    const result = validateConfig(cfg);
    assert.equal(result.valid, false);
    assert.ok(result.warnings.some(w => w.includes("ui.port")));
  });

  it("warns about invalid description provider", () => {
    const cfg = { ...DEFAULT_CONFIG, description: { ...DEFAULT_CONFIG.description!, provider: "invalid" } };
    const result = validateConfig(cfg);
    assert.equal(result.valid, false);
    assert.ok(result.warnings.some(w => w.includes("description.provider")));
  });

  it("warns about unsupported decision providers", () => {
    const cfg = { ...DEFAULT_CONFIG, decision: { ...DEFAULT_CONFIG.decision!, provider: "openai" } };
    const result = validateConfig(cfg);
    assert.equal(result.valid, false);
    assert.ok(result.warnings.some(w => w.includes("decision.provider")));
  });
});

describe("global config layer", () => {
  it("merges the global file under the workspace file, section by section", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-rag-layers-"));
    try {
      const globalFile = join(dir, "global.json");
      const workspaceFile = join(dir, "opencode-rag.json");
      writeFileSync(globalFile, JSON.stringify({
        shellGuard: { enabled: true, threshold: 0.9 },
        decision: { model: "tev1:0.8b" },
        openCode: { autoIndex: { debounceMs: 1234 } },
      }));
      writeFileSync(workspaceFile, JSON.stringify({
        shellGuard: { threshold: 0.3 },
        openCode: { shell: { backgroundGuidance: false } },
      }));

      const cfg = loadConfigLayers([globalFile, workspaceFile]);
      assert.equal(cfg.shellGuard?.enabled, true, "global enabled flag is inherited");
      assert.equal(cfg.shellGuard?.threshold, 0.3, "workspace value wins");
      assert.equal(cfg.decision?.model, "tev1:0.8b", "global decision model is inherited");
      assert.equal(cfg.openCode.autoIndex?.debounceMs, 1234, "nested global value survives a workspace layer");
      assert.equal(cfg.openCode.shell?.backgroundGuidance, false, "nested workspace value wins");
      assert.equal(
        cfg.openCode.autoIndex?.intervalMs,
        DEFAULT_CONFIG.openCode.autoIndex?.intervalMs,
        "untouched nested defaults are preserved",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies the global file when the workspace has no config", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-rag-globalonly-"));
    const xdg = mkdtempSync(join(tmpdir(), "opencode-rag-xdg-"));
    const previous = process.env.XDG_CONFIG_HOME;
    try {
      mkdirSync(join(xdg, "opencode"), { recursive: true });
      writeFileSync(
        join(xdg, "opencode", "opencode-rag.json"),
        JSON.stringify({ shellGuard: { enabled: true } }),
      );
      process.env.XDG_CONFIG_HOME = xdg;

      assert.equal(resolveConfigPaths(dir).global, join(xdg, "opencode", "opencode-rag.json"));
      assert.equal(resolveConfigPaths(dir).workspace, undefined);
      const cfg = loadWorkspaceConfig(dir, false);
      assert.equal(cfg.shellGuard?.enabled, true);
      assert.equal(cfg.shellGuard?.threshold, DEFAULT_CONFIG.shellGuard?.threshold);
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
      rmSync(dir, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  it("prefers the workspace file over the global file for the same setting", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-rag-wswins-"));
    try {
      const globalFile = join(dir, "global.json");
      const workspaceFile = join(dir, "opencode-rag.json");
      writeFileSync(globalFile, JSON.stringify({ shellGuard: { enabled: true, threshold: 0.9 } }));
      writeFileSync(workspaceFile, JSON.stringify({ shellGuard: { enabled: false } }));
      const cfg = loadConfigLayers([globalFile, workspaceFile]);
      assert.equal(cfg.shellGuard?.enabled, false);
      assert.equal(cfg.shellGuard?.threshold, 0.9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves XDG_CONFIG_HOME and falls back to ~/.config", () => {
    assert.equal(
      globalConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/user"),
      join("/xdg", "opencode", "opencode-rag.json"),
    );
    assert.equal(
      globalConfigPath({}, "/home/user"),
      join("/home/user", ".config", "opencode", "opencode-rag.json"),
    );
    assert.equal(findGlobalConfigFile({}, "/definitely/not/a/home"), undefined);
  });
});

describe("configuredSections", () => {
  it("reports only sections present in a raw config layer", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-rag-sections-"));
    const previous = process.env.XDG_CONFIG_HOME;
    const xdg = mkdtempSync(join(tmpdir(), "opencode-rag-sections-xdg-"));
    try {
      mkdirSync(join(xdg, "opencode"), { recursive: true });
      writeFileSync(
        join(xdg, "opencode", "opencode-rag.json"),
        JSON.stringify({ shellGuard: { enabled: true }, decision: { model: "tev1:0.8b" } }),
      );
      writeFileSync(join(dir, "opencode-rag.json"), JSON.stringify({ embedding: { model: "test-model" } }));
      process.env.XDG_CONFIG_HOME = xdg;

      const sections = configuredSections(dir);
      assert.deepEqual([...sections].sort(), ["decision", "embedding", "shellGuard"]);
      assert.equal(sections.has("description"), false, "default-enabled sections are not configured");
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
      rmSync(dir, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  it("is empty when no config file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-rag-sections-none-"));
    const previous = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = join(dir, "missing-xdg");
      assert.equal(configuredSections(dir).size, 0);
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("project config location (.opencode/)", () => {
  /** Isolate every case from the real user-global config. */
  function isolateGlobal(body: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "opencode-rag-loc-"));
    const previous = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = join(dir, "no-global");
      body(dir);
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("prefers .opencode/opencode-rag.json over the legacy root file", () => {
    isolateGlobal((dir) => {
      mkdirSync(join(dir, ".opencode"), { recursive: true });
      writeFileSync(join(dir, "opencode-rag.json"), JSON.stringify({ retrieval: { topK: 1 } }), "utf-8");
      writeFileSync(join(dir, ".opencode", "opencode-rag.json"), JSON.stringify({ retrieval: { topK: 2 } }), "utf-8");
      assert.equal(findConfigFile(dir), join(dir, ".opencode", "opencode-rag.json"));
      const cfg = loadWorkspaceConfig(dir, false);
      assert.equal(cfg.retrieval.topK, 2, "canonical file is the workspace layer");
    });
  });

  it("still reads the legacy root file when no canonical file exists", () => {
    isolateGlobal((dir) => {
      writeFileSync(join(dir, "opencode-rag.json"), JSON.stringify({ retrieval: { topK: 3 } }), "utf-8");
      assert.equal(findConfigFile(dir), join(dir, "opencode-rag.json"));
      assert.equal(loadWorkspaceConfig(dir, false).retrieval.topK, 3);
    });
  });

  it("migrateLegacyProjectConfig moves the root file but never merges over an existing one", () => {
    isolateGlobal((dir) => {
      // move case
      writeFileSync(join(dir, "opencode-rag.json"), JSON.stringify({ retrieval: { topK: 4 } }), "utf-8");
      assert.equal(migrateLegacyProjectConfig(dir), join(dir, ".opencode", "opencode-rag.json"));
      assert.ok(!existsSync(join(dir, "opencode-rag.json")), "root file is gone");
      assert.equal(findConfigFile(dir), join(dir, ".opencode", "opencode-rag.json"));
      assert.equal(loadWorkspaceConfig(dir, false).retrieval.topK, 4, "content survives the move");

      // no-merge case: root stays untouched when the canonical file exists
      writeFileSync(join(dir, "opencode-rag.json"), JSON.stringify({ retrieval: { topK: 5 } }), "utf-8");
      assert.equal(migrateLegacyProjectConfig(dir), undefined);
      assert.ok(existsSync(join(dir, "opencode-rag.json")), "legacy file kept");
      assert.equal(loadWorkspaceConfig(dir, false).retrieval.topK, 4, "canonical file still wins");

      // no-op case: nothing to move
      unlinkSync(join(dir, "opencode-rag.json"));
      assert.equal(migrateLegacyProjectConfig(dir), undefined);
    });
  });

  it("projectConfigPath points into .opencode/ regardless of existence", () => {
    assert.equal(projectConfigPath("/ws"), join("/ws", ".opencode", "opencode-rag.json"));
  });

  it("loadWorkspaceRawConfig deep-merges global under workspace without defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-rag-raw-"));
    const xdg = mkdtempSync(join(tmpdir(), "opencode-rag-raw-xdg-"));
    const previous = process.env.XDG_CONFIG_HOME;
    try {
      mkdirSync(join(xdg, "opencode"), { recursive: true });
      writeFileSync(
        join(xdg, "opencode", "opencode-rag.json"),
        JSON.stringify({ embedding: { provider: "openai", model: "global-model" }, tui: { settingsKeybinding: "alt+k" } }),
      );
      mkdirSync(join(dir, ".opencode"), { recursive: true });
      writeFileSync(
        join(dir, ".opencode", "opencode-rag.json"),
        JSON.stringify({ embedding: { model: "ws-model" } }),
      );
      process.env.XDG_CONFIG_HOME = xdg;

      const raw = loadWorkspaceRawConfig(dir);
      const embedding = raw.embedding as Record<string, unknown>;
      assert.equal(embedding.provider, "openai", "global leaf survives");
      assert.equal(embedding.model, "ws-model", "workspace leaf wins");
      assert.equal((raw.tui as Record<string, unknown>).settingsKeybinding, "alt+k");
      assert.equal(raw.retrieval, undefined, "defaults are NOT materialized");
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
      rmSync(dir, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
    }
  });
});

describe("updateGlobalConfigValue", () => {
  it("creates the global file on demand and merges subsequent writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-rag-gwrite-"));
    const previous = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = join(dir, "xdg");
      assert.ok(updateGlobalConfigValue(["embedding", "model"], "m-prod"));
      const file = globalConfigPath();
      assert.ok(existsSync(file), "global file created with parents");
      assert.deepEqual(JSON.parse(readFileSync(file, "utf-8")), { embedding: { model: "m-prod" } });

      assert.ok(updateGlobalConfigValue(["embedding", "apiKey"], "sk-1"));
      assert.ok(updateGlobalConfigValue(["description", "model"], "m-desc"));
      assert.deepEqual(
        JSON.parse(readFileSync(file, "utf-8")),
        { embedding: { model: "m-prod", apiKey: "sk-1" }, description: { model: "m-desc" } },
      );
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ensureConfigFile is a no-op for an existing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-rag-ensure-"));
    try {
      const file = join(dir, "sub", "cfg.json");
      ensureConfigFile(file);
      assert.equal(readFileSync(file, "utf-8"), "{}");
      writeFileSync(file, JSON.stringify({ retrieval: { topK: 9 } }), "utf-8");
      ensureConfigFile(file);
      assert.equal(JSON.parse(readFileSync(file, "utf-8")).retrieval.topK, 9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isProviderScopedPath", () => {
  it("classifies provider/model options as global", () => {
    for (const p of [
      ["embedding", "provider"],
      ["embedding", "model"],
      ["embedding", "baseUrl"],
      ["embedding", "apiKey"],
      ["embedding", "vectorDimension"],
      ["description", "model"],
      ["imageDescription", "provider"],
      ["imageDescription", "onDemand", "model"],
      ["decision", "baseUrl"],
      ["reranking", "apiKey"],
    ]) {
      assert.ok(isProviderScopedPath(p), `${p.join(".")} is a provider option`);
    }
  });

  it("keeps everything else project-scoped", () => {
    for (const p of [
      ["retrieval", "topK"],
      ["description", "enabled"],
      ["imageDescription", "enabled"],
      ["embedding", "timeoutMs"],
      ["embedding", "proxy", "url"],
      ["embedding", "documentPrefix"],
      ["memory", "model"],
      ["openCode", "autoIndex", "enabled"],
      ["tui", "settingsKeybinding"],
      ["embedding"],
    ]) {
      assert.ok(!isProviderScopedPath(p), `${p.join(".")} is NOT a provider option`);
    }
  });
});
