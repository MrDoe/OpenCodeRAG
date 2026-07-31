import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createEmbedder } from "../../embedder/factory.js";
import type { RagConfig } from "../../core/config.js";
import { DEFAULT_CONFIG } from "../../core/config.js";

function makeConfig(overrides: Partial<RagConfig>): RagConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    embedding: {
      ...DEFAULT_CONFIG.embedding,
      ...overrides.embedding,
    },
  };
}

describe("createEmbedder", () => {
  it("creates Ollama provider with default config", () => {
    const embedder = createEmbedder(DEFAULT_CONFIG);
    assert.equal(embedder.name, "ollama");
  });

  it("creates Ollama provider explicitly", () => {
    const config = makeConfig({
      embedding: {
        provider: "ollama",
        baseUrl: "http://localhost:11434/v1",
        model: "custom-model",
        apiKey: undefined,
      },
    });
    const embedder = createEmbedder(config);
    assert.equal(embedder.name, "ollama");
  });

  it("creates Ollama provider with proxy config", () => {
    const config = makeConfig({
      embedding: {
        provider: "ollama",
        baseUrl: "http://localhost:11434/v1",
        model: "custom-model",
        apiKey: undefined,
        proxy: { url: "http://proxy:8080", username: "user", password: "pass" },
      },
    });
    const embedder = createEmbedder(config);
    assert.equal(embedder.name, "ollama");
  });

  it("creates OpenAI provider with apiKey", () => {
    const config = makeConfig({
      embedding: {
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: "text-embedding-3-small",
        apiKey: "sk-test-key",
      },
    });
    const embedder = createEmbedder(config);
    assert.equal(embedder.name, "openai");
  });

  it("throws for OpenAI provider without apiKey", () => {
    const config = makeConfig({
      embedding: {
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: "text-embedding-3-small",
        apiKey: undefined,
      },
    });
    assert.throws(() => createEmbedder(config), {
      message: /openai provider requires an apiKey/,
    });
  });

  it("throws for unknown provider (no apiKey needed to reject)", () => {
    const config = makeConfig({
      embedding: {
        provider: "unknown" as "ollama",
        baseUrl: "",
        model: "",
        apiKey: undefined,
      },
    });
    assert.throws(() => createEmbedder(config), {
      message: /does not support embeddings/,
    });
  });

  it("throws for unknown provider even with apiKey", () => {
    const config = makeConfig({
      embedding: {
        provider: "custom" as "ollama",
        baseUrl: "https://custom.api/v1",
        model: "custom-model",
        apiKey: "custom-key",
      },
    });
    // Unknown provider names must fail fast instead of silently attempting
    // OpenAI-style calls against a nonsense base URL.
    assert.throws(() => createEmbedder(config), /does not support embeddings/);
  });
});
