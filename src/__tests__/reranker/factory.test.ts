import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createReranker, getRerankerFor } from "../../reranker/factory.js";
import { LlamaServerReranker } from "../../reranker/llama-server.js";
import type { RerankingConfig } from "../../core/config.js";

function makeConfig(overrides: Partial<RerankingConfig> = {}): RerankingConfig {
  return {
    enabled: true,
    provider: "llama-server",
    baseUrl: "http://127.0.0.1:9/v1",
    model: "qwen3-reranker-0.6b",
    ...overrides,
  };
}

describe("createReranker", () => {
  it("returns null when config is undefined", () => {
    assert.equal(createReranker(undefined), null);
  });

  it("returns null when disabled", () => {
    assert.equal(createReranker(makeConfig({ enabled: false })), null);
  });

  it("creates a llama-server provider when enabled", () => {
    const provider = createReranker(makeConfig());
    assert.ok(provider instanceof LlamaServerReranker);
    assert.equal(provider.name, "llama-server");
    assert.equal(provider.model, "qwen3-reranker-0.6b");
  });

  it("returns null (and warns) when baseUrl or model are missing", () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(createReranker(makeConfig({ baseUrl: "" })), null);
      assert.equal(createReranker(makeConfig({ model: "" })), null);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("returns null for an unknown provider", () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(createReranker(makeConfig({ provider: "nope" as "llama-server" })), null);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("getRerankerFor", () => {
  it("returns null for disabled/undefined configs without caching", () => {
    assert.equal(getRerankerFor(undefined), null);
    assert.equal(getRerankerFor(makeConfig({ enabled: false })), null);
  });

  it("memoizes one provider per endpoint identity", () => {
    const cfg = makeConfig({ baseUrl: "http://127.0.0.1:40001/v1", model: "memo-model" });
    const first = getRerankerFor(cfg);
    const second = getRerankerFor(cfg);
    assert.ok(first);
    assert.equal(first, second);

    const other = getRerankerFor({ ...cfg, model: "other-model" });
    assert.ok(other);
    assert.notEqual(first, other);
  });
});
