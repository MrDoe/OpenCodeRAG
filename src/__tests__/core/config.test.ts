import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, DEFAULT_CONFIG, resolveLogConfig, validateConfig } from "../../core/config.js";
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
    assert.deepStrictEqual(config, { ...DEFAULT_CONFIG, chunkers: undefined, chunking: { nodeTypes: {} } });
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
      name: "logging level",
      json: { logging: { level: "debug" } },
      assert: (c) => {
        assert.equal(c.logging.level, "debug");
        assert.equal(c.logging.logFilePath, DEFAULT_CONFIG.logging.logFilePath);
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
});
