import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRuntimeOverrides,
  saveRuntimeOverride,
  applyRuntimeOverrides,
  type RuntimeOverrides,
} from "../../core/runtime-overrides.js";
import { DEFAULT_CONFIG, type RagConfig } from "../../core/config.js";

describe("loadRuntimeOverrides", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = join(tmpdir(), `rag-override-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    try { unlinkSync(join(tmpDir, "runtime-overrides.json")); } catch { /* ignore */ }
    try { unlinkSync(join(tmpDir, "watcher-status.json")); } catch { /* ignore */ }
  });

  it("returns empty object when no override file exists", () => {
    const result = loadRuntimeOverrides(tmpDir);
    assert.deepStrictEqual(result, {});
  });

  it("returns parsed overrides from file", () => {
    writeFileSync(
      join(tmpDir, "runtime-overrides.json"),
      JSON.stringify({ retrieval: { topK: 25 } }),
      "utf-8"
    );
    const result = loadRuntimeOverrides(tmpDir);
    assert.deepStrictEqual(result, { retrieval: { topK: 25 } });
  });

  it("returns empty object for corrupt file", () => {
    writeFileSync(join(tmpDir, "runtime-overrides.json"), "not-json", "utf-8");
    const result = loadRuntimeOverrides(tmpDir);
    assert.deepStrictEqual(result, {});
  });
});

describe("saveRuntimeOverride", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = join(tmpdir(), `rag-save-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    try { unlinkSync(join(tmpDir, "runtime-overrides.json")); } catch { /* ignore */ }
  });

  it("writes a new runtime override file", () => {
    saveRuntimeOverride(tmpDir, ["retrieval", "topK"], 15);
    const content = readFileSync(join(tmpDir, "runtime-overrides.json"), "utf-8");
    assert.ok(content.includes('"topK"'));
    assert.ok(content.includes("15"));
  });

  it("merges with existing overrides", () => {
    writeFileSync(
      join(tmpDir, "runtime-overrides.json"),
      JSON.stringify({ retrieval: { topK: 10 } }),
      "utf-8"
    );
    saveRuntimeOverride(tmpDir, ["retrieval", "minScore"], 0.7);
    const result = loadRuntimeOverrides(tmpDir);
    assert.equal(result.retrieval?.topK, 10);
    assert.equal(result.retrieval?.minScore, 0.7);
  });

  it("overwrites existing key with new value", () => {
    writeFileSync(
      join(tmpDir, "runtime-overrides.json"),
      JSON.stringify({ retrieval: { topK: 10 } }),
      "utf-8"
    );
    saveRuntimeOverride(tmpDir, ["retrieval", "topK"], 20);
    const result = loadRuntimeOverrides(tmpDir);
    assert.equal(result.retrieval?.topK, 20);
  });

  const valueTypeCases: {
    name: string;
    path: string[];
    value: boolean | number | string;
    assert: (result: RuntimeOverrides) => void;
  }[] = [
    {
      name: "boolean values",
      path: ["description", "enabled"],
      value: false as boolean,
      assert: (r) => assert.equal(r.description?.enabled, false),
    },
    {
      name: "string values",
      path: ["embedding", "model"],
      value: "nomic-embed-text",
      assert: (r) => assert.equal(r.embedding?.model, "nomic-embed-text"),
    },
    {
      name: "string enum values",
      path: ["embedding", "provider"],
      value: "openai",
      assert: (r) => assert.equal(r.embedding?.provider, "openai"),
    },
  ];

  for (const { name, path, value, assert: assertion } of valueTypeCases) {
    it(`handles ${name}`, () => {
      saveRuntimeOverride(tmpDir, path, value);
      const result = loadRuntimeOverrides(tmpDir);
      assertion(result);
    });
  }

  it("overwrites string value with another string", () => {
    saveRuntimeOverride(tmpDir, ["embedding", "baseUrl"], "http://localhost:11434/api");
    saveRuntimeOverride(tmpDir, ["embedding", "baseUrl"], "http://custom:8080/api");
    const result = loadRuntimeOverrides(tmpDir);
    assert.equal(result.embedding?.baseUrl, "http://custom:8080/api");
  });

  it("mixes string and boolean overrides", () => {
    saveRuntimeOverride(tmpDir, ["embedding", "provider"], "openai");
    saveRuntimeOverride(tmpDir, ["embedding", "model"], "text-embedding-3-small");
    saveRuntimeOverride(tmpDir, ["description", "enabled"], false);
    const result = loadRuntimeOverrides(tmpDir);
    assert.equal(result.embedding?.provider, "openai");
    assert.equal(result.embedding?.model, "text-embedding-3-small");
    assert.equal(result.description?.enabled, false);
  });

  it("handles deep nested paths", () => {
    saveRuntimeOverride(tmpDir, ["openCode", "autoIndex", "enabled"], false);
    saveRuntimeOverride(tmpDir, ["openCode", "autoIndex", "debounceMs"], 5000);
    const result = loadRuntimeOverrides(tmpDir);
    assert.equal(result.openCode?.autoIndex?.enabled, false);
    assert.equal(result.openCode?.autoIndex?.debounceMs, 5000);
  });
});

describe("applyRuntimeOverrides", () => {
  it("returns cfg unchanged when overrides is empty", () => {
    const result = applyRuntimeOverrides(DEFAULT_CONFIG, {});
    assert.deepStrictEqual(result, DEFAULT_CONFIG);
  });

  it("returns cfg unchanged when overrides has no matching keys", () => {
    const result = applyRuntimeOverrides(DEFAULT_CONFIG, { retrieval: {} });
    assert.equal(result.retrieval.topK, DEFAULT_CONFIG.retrieval.topK);
    assert.equal(result.retrieval.minScore, DEFAULT_CONFIG.retrieval.minScore);
  });

  const singleOverrideCases: {
    label: string;
    overrides: RuntimeOverrides;
    assert: (result: RagConfig) => void;
  }[] = [
    {
      label: "retrieval topK",
      overrides: { retrieval: { topK: 25 } },
      assert: (r) => {
        assert.equal(r.retrieval.topK, 25);
        assert.equal(r.retrieval.minScore, DEFAULT_CONFIG.retrieval.minScore);
      },
    },
    {
      label: "retrieval minScore",
      overrides: { retrieval: { minScore: 0.8 } },
      assert: (r) => assert.equal(r.retrieval.minScore, 0.8),
    },
    {
      label: "hybridSearch.enabled",
      overrides: { retrieval: { hybridSearch: { enabled: false } } },
      assert: (r) => assert.equal(r.retrieval.hybridSearch?.enabled, false),
    },
    {
      label: "hybridSearch.keywordWeight",
      overrides: { retrieval: { hybridSearch: { keywordWeight: 0.6 } } },
      assert: (r) => assert.equal(r.retrieval.hybridSearch?.keywordWeight, 0.6),
    },
    {
      label: "autoIndex.enabled",
      overrides: { openCode: { autoIndex: { enabled: false } } },
      assert: (r) => assert.equal(r.openCode.autoIndex?.enabled, false),
    },
    {
      label: "autoIndex.debounceMs",
      overrides: { openCode: { autoIndex: { debounceMs: 5000 } } },
      assert: (r) => assert.equal(r.openCode.autoIndex?.debounceMs, 5000),
    },
    {
      label: "autoIndex.watcher",
      overrides: { openCode: { autoIndex: { watcher: "git" } } },
      assert: (r) => assert.equal(r.openCode.autoIndex?.watcher, "git"),
    },
    {
      label: "description.enabled",
      overrides: { description: { enabled: false } },
      assert: (r) => assert.equal(r.description?.enabled, false),
    },
    {
      label: "embedding.provider",
      overrides: { embedding: { provider: "openai" } },
      assert: (r) => assert.equal(r.embedding.provider, "openai"),
    },
    {
      label: "embedding.model",
      overrides: { embedding: { model: "text-embedding-3-small" } },
      assert: (r) => assert.equal(r.embedding.model, "text-embedding-3-small"),
    },
    {
      label: "embedding.baseUrl",
      overrides: { embedding: { baseUrl: "https://custom.api.com/v1" } },
      assert: (r) => assert.equal(r.embedding.baseUrl, "https://custom.api.com/v1"),
    },
    {
      label: "description.provider",
      overrides: { description: { provider: "openai" } },
      assert: (r) => assert.equal(r.description?.provider, "openai"),
    },
    {
      label: "description.model",
      overrides: { description: { model: "gpt-4o-mini" } },
      assert: (r) => assert.equal(r.description?.model, "gpt-4o-mini"),
    },
    {
      label: "description.baseUrl",
      overrides: { description: { baseUrl: "https://custom.api.com/v1" } },
      assert: (r) => assert.equal(r.description?.baseUrl, "https://custom.api.com/v1"),
    },
    {
      label: "all embedding fields simultaneously",
      overrides: {
        embedding: { provider: "openai", model: "text-embedding-3-small", baseUrl: "https://api.openai.com/v1" },
      },
      assert: (r) => {
        assert.equal(r.embedding.provider, "openai");
        assert.equal(r.embedding.model, "text-embedding-3-small");
        assert.equal(r.embedding.baseUrl, "https://api.openai.com/v1");
      },
    },
    {
      label: "description provider, model, enabled together",
      overrides: { description: { provider: "openai", model: "gpt-4o-mini", enabled: true } },
      assert: (r) => {
        assert.equal(r.description?.provider, "openai");
        assert.equal(r.description?.model, "gpt-4o-mini");
        assert.equal(r.description?.enabled, true);
      },
    },
  ];

  for (const { label, overrides, assert: assertion } of singleOverrideCases) {
    it(`applies ${label} override`, () => {
      const result = applyRuntimeOverrides(DEFAULT_CONFIG, overrides);
      assertion(result);
    });
  }

  it("applies multiple overrides simultaneously", () => {
    const result = applyRuntimeOverrides(DEFAULT_CONFIG, {
      retrieval: { topK: 15, minScore: 0.6 },
      openCode: { autoIndex: { enabled: false } },
    });
    assert.equal(result.retrieval.topK, 15);
    assert.equal(result.retrieval.minScore, 0.6);
    assert.equal(result.openCode.autoIndex?.enabled, false);
    assert.equal(result.openCode.autoIndex?.debounceMs, 2000);
  });

  it("does not mutate the original config", () => {
    const original = { ...DEFAULT_CONFIG, retrieval: { ...DEFAULT_CONFIG.retrieval } };
    const result = applyRuntimeOverrides(original, { retrieval: { topK: 99 } });
    assert.equal(result.retrieval.topK, 99);
    assert.equal(original.retrieval.topK, DEFAULT_CONFIG.retrieval.topK);
  });

  it("handles overrides when openCode.autoIndex is undefined in config", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      openCode: { ...DEFAULT_CONFIG.openCode, autoIndex: undefined },
    };
    const result = applyRuntimeOverrides(cfg, {
      openCode: { autoIndex: { debounceMs: 5000 } },
    });
    assert.equal(result.openCode.autoIndex?.debounceMs, 5000);
  });

  it("handles overrides when description is undefined in config", () => {
    const cfg = { ...DEFAULT_CONFIG, description: undefined as unknown as typeof DEFAULT_CONFIG.description };
    const result = applyRuntimeOverrides(cfg, {
      description: { enabled: false },
    });
    assert.equal(result.description?.enabled, false);
  });

  it("applies chunking.parsers overrides", () => {
    // The TUI writes ["chunking","parsers"] to runtime-overrides.json. Without
    // a matching branch here the write is silently dropped and the edit only
    // takes effect after an OpenCode restart.
    const result = applyRuntimeOverrides(DEFAULT_CONFIG, {
      chunking: { parsers: { ".c": "cpp", ".cu": "cpp" } },
    });
    assert.deepStrictEqual(result.chunking?.parsers, { ".c": "cpp", ".cu": "cpp" });
  });

  it("normalizes chunking.parsers overrides like the config loader", () => {
    const result = applyRuntimeOverrides(DEFAULT_CONFIG, {
      chunking: { parsers: { CXX: "CPP", ".cu": " cpp " } },
    });
    assert.deepStrictEqual(result.chunking?.parsers, { ".cxx": "cpp", ".cu": "cpp" });
  });

  it("applies chunking.nodeTypes overrides", () => {
    const result = applyRuntimeOverrides(DEFAULT_CONFIG, {
      chunking: { nodeTypes: { cpp: ["function_definition"] } },
    });
    assert.deepStrictEqual(result.chunking?.nodeTypes, { cpp: ["function_definition"] });
  });

  it("keeps the on-disk chunking config when no chunking override is set", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      chunking: { nodeTypes: { ts: ["function_declaration"] }, parsers: { ".c": "cpp" } },
    };
    const result = applyRuntimeOverrides(cfg, { retrieval: { topK: 7 } });
    assert.deepStrictEqual(result.chunking?.parsers, { ".c": "cpp" });
    assert.deepStrictEqual(result.chunking?.nodeTypes, { ts: ["function_declaration"] });
  });

});
