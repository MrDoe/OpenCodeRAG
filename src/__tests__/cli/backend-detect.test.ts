import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyOllamaModels } from "../../cli/commands/backend-detect.js";
import { generateDefaultConfigJson } from "../../cli/commands/workspace-helpers.js";

describe("classifyOllamaModels", () => {
  it("classifies GPU when a model has size_vram > 0", () => {
    const info = classifyOllamaModels([{ name: "qwen3-embedding:0.6b", size_vram: 2_370_652_077 }]);
    assert.equal(info.backend, "gpu");
    assert.deepEqual(info.tuning, { embedBatchSize: 40, embedConcurrency: 4, ollamaMaxBatchSize: 40 });
  });

  it("classifies CPU when all models have size_vram === 0", () => {
    const info = classifyOllamaModels([{ name: "qwen3-embedding:0.6b", size_vram: 0 }]);
    assert.equal(info.backend, "cpu");
    assert.deepEqual(info.tuning, { embedBatchSize: 20, embedConcurrency: 1, ollamaMaxBatchSize: 20 });
  });

  it("prefers the default embedding model's own backend over other loaded models", () => {
    const info = classifyOllamaModels([
      { name: "some-other-model", size_vram: 123_456 },
      { name: "qwen3-embedding:0.6b", size_vram: 0 },
    ]);
    assert.equal(info.backend, "cpu");
  });

  it("falls back to any loaded model when the embedding model is not loaded", () => {
    const info = classifyOllamaModels([{ name: "qwen2.5:3b", size_vram: 987_654 }]);
    assert.equal(info.backend, "gpu");
  });

  it("treats a missing size_vram as CPU", () => {
    const info = classifyOllamaModels([{ name: "qwen3-embedding:0.6b" }]);
    assert.equal(info.backend, "cpu");
  });

  it("returns default tuning for an empty model list", () => {
    const info = classifyOllamaModels([]);
    assert.equal(info.backend, "unknown");
    assert.deepEqual(info.tuning, { embedBatchSize: 100, embedConcurrency: 3, ollamaMaxBatchSize: 100 });
  });
});

describe("generateDefaultConfigJson", () => {
  it("writes tuned embedding settings when provided", () => {
    const cfg = JSON.parse(
      generateDefaultConfigJson({ embedBatchSize: 40, embedConcurrency: 4, ollamaMaxBatchSize: 40 }),
    ) as { indexing: Record<string, unknown> };
    assert.equal(cfg.indexing.embedBatchSize, 40);
    assert.equal(cfg.indexing.embedConcurrency, 4);
    assert.equal(cfg.indexing.ollamaMaxBatchSize, 40);
  });

  it("uses config defaults when no tuning is provided", () => {
    const cfg = JSON.parse(generateDefaultConfigJson()) as { indexing: Record<string, unknown> };
    assert.equal(cfg.indexing.embedBatchSize, 100);
    assert.equal(cfg.indexing.embedConcurrency, 3);
    assert.equal(cfg.indexing.ollamaMaxBatchSize, 100);
  });

  it("does not emit provider-scoped keys (they belong to the global config)", () => {
    const cfg = JSON.parse(generateDefaultConfigJson()) as Record<string, unknown>;
    assert.equal("embedding" in cfg, false, "embedding provider/model/baseUrl are machine-global");
    for (const section of ["description", "imageDescription", "decision"]) {
      const value = cfg[section] as Record<string, unknown>;
      assert.equal("provider" in value, false, `${section}.provider must not be project-scoped`);
      assert.equal("model" in value, false, `${section}.model must not be project-scoped`);
      assert.equal("baseUrl" in value, false, `${section}.baseUrl must not be project-scoped`);
      assert.equal("apiKey" in value, false, `${section}.apiKey must not be project-scoped`);
    }
    assert.equal("provider" in (cfg.reranking as Record<string, unknown> | undefined ?? {}), false);
  });

  it("emits an empty chunking section so parser overrides are discoverable", () => {
    const cfg = JSON.parse(generateDefaultConfigJson()) as {
      chunking: { nodeTypes: Record<string, unknown>; parsers: Record<string, unknown> };
    };
    assert.ok(cfg.chunking, "generated config must contain a chunking section");
    assert.deepStrictEqual(cfg.chunking.parsers, {});
    assert.deepStrictEqual(cfg.chunking.nodeTypes, {});
  });
});
