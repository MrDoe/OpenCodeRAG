import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveRagContext } from "../../core/bootstrap.js";
import { DEFAULT_CONFIG } from "../../core/config.js";
import { LanceDbStore } from "../../vectorstore/lancedb.js";

describe("resolveRagContext", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `opencode-rag-bootstrap-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("uses default config when no config file exists", async () => {
    const ctx = await resolveRagContext({ cwd: tmpDir });
    assert.equal(ctx.config.embedding.provider, DEFAULT_CONFIG.embedding.provider);
    assert.equal(ctx.config.embedding.model, DEFAULT_CONFIG.embedding.model);
    assert.ok(ctx.embedder);
    assert.ok(ctx.store);
    assert.ok(ctx.keywordIndex);
    assert.ok(typeof ctx.dimension === "number");
    assert.ok(typeof ctx.logFilePath === "string");
  });

  it("loads config from explicit configPath", async () => {
    const configPath = join(tmpDir, "my-config.json");
    writeFileSync(configPath, JSON.stringify({
      embedding: { provider: "ollama", model: "test-model" },
    }), "utf-8");

    const ctx = await resolveRagContext({ cwd: tmpDir, configPath: "my-config.json" });
    assert.equal(ctx.config.embedding.provider, "ollama");
    assert.equal(ctx.config.embedding.model, "test-model");
  });

  it("auto-discovers opencode-rag.json in cwd", async () => {
    writeFileSync(join(tmpDir, "opencode-rag.json"), JSON.stringify({
      embedding: { provider: "ollama", model: "discovered-model" },
    }), "utf-8");

    const ctx = await resolveRagContext({ cwd: tmpDir });
    assert.equal(ctx.config.embedding.provider, "ollama");
    assert.equal(ctx.config.embedding.model, "discovered-model");
  });

  it("auto-discovers .opencode/opencode-rag.json", async () => {
    const opencodeDir = join(tmpDir, ".opencode");
    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(join(opencodeDir, "opencode-rag.json"), JSON.stringify({
      embedding: { model: "nested-model" },
    }), "utf-8");

    const ctx = await resolveRagContext({ cwd: tmpDir });
    assert.equal(ctx.config.embedding.model, "nested-model");
  });

  it("auto-discovers .opencode/rag.json", async () => {
    const opencodeDir = join(tmpDir, ".opencode");
    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(join(opencodeDir, "rag.json"), JSON.stringify({
      embedding: { model: "rag-json-model" },
    }), "utf-8");

    const ctx = await resolveRagContext({ cwd: tmpDir });
    assert.equal(ctx.config.embedding.model, "rag-json-model");
  });

  it("throws when configPath points to missing file", async () => {
    let threw = false;
    try {
      await resolveRagContext({ cwd: tmpDir, configPath: "nonexistent.json" });
    } catch (err) {
      threw = true;
      assert.ok((err as Error).message.includes("Config file not found"));
    }
    assert.ok(threw, "Expected resolveRagContext to throw");
  });

  it("probes dimension from embedder", async () => {
    const ctx = await resolveRagContext({ cwd: tmpDir });
    assert.ok(ctx.dimension > 0, `Expected positive dimension, got ${ctx.dimension}`);
  });

  it("creates store with correct storePath", async () => {
    const ctx = await resolveRagContext({ cwd: tmpDir });
    assert.ok(ctx.storePath.includes(tmpDir));
    const expectedStorePath = resolve(tmpDir, ctx.config.vectorStore.path);
    assert.equal(ctx.storePath, expectedStorePath);
  });

  it("creates keyword index", async () => {
    const ctx = await resolveRagContext({ cwd: tmpDir });
    assert.ok(ctx.keywordIndex);
    assert.equal(typeof ctx.keywordIndex.count, "function");
    assert.equal(ctx.keywordIndex.count(), 0);
  });

  it("creates descriptionProvider when description is enabled", async () => {
    const configPath = join(tmpDir, "opencode-rag.json");
    writeFileSync(configPath, JSON.stringify({
      description: { enabled: true, provider: "ollama", baseUrl: "http://127.0.0.1:11434/api", model: "test", systemPrompt: "" },
    }), "utf-8");

    const ctx = await resolveRagContext({ cwd: tmpDir });
    assert.ok(ctx.descriptionProvider);
  });

  it("does not create descriptionProvider when description is disabled", async () => {
    const configPath = join(tmpDir, "opencode-rag.json");
    writeFileSync(configPath, JSON.stringify({
      description: { enabled: false },
    }), "utf-8");

    const ctx = await resolveRagContext({ cwd: tmpDir });
    assert.equal(ctx.descriptionProvider, undefined);
  });

  it("uses the configured vectorDimension without probing", async () => {
    writeFileSync(join(tmpDir, "opencode-rag.json"), JSON.stringify({
      embedding: { provider: "ollama", model: "test-model", vectorDimension: 1234 },
    }), "utf-8");

    const ctx = await resolveRagContext({ cwd: tmpDir });
    assert.equal(ctx.dimension, 1234);
  });

  it("falls back to the existing store's schema dimension when the probe fails", async () => {
    // Deterministic provider outage: port 9 (discard) is never listening.
    writeFileSync(join(tmpDir, "opencode-rag.json"), JSON.stringify({
      embedding: {
        provider: "openai",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "unreachable",
        apiKey: "test-key",
      },
    }), "utf-8");

    const storePath = resolve(tmpDir, DEFAULT_CONFIG.vectorStore.path);
    const store = new LanceDbStore(storePath, 7);
    await store.addChunks([{
      id: "seed",
      content: "seed",
      embedding: new Array(7).fill(0.1),
      metadata: { filePath: "src/seed.ts", startLine: 1, endLine: 1, language: "typescript" },
    }]);
    await store.close();

    const ctx = await resolveRagContext({ cwd: tmpDir });
    assert.equal(ctx.dimension, 7);
  });

  it("exposes the resolved config path", async () => {
    const ctxDefault = await resolveRagContext({ cwd: tmpDir });
    assert.equal(ctxDefault.configPath, undefined);

    writeFileSync(join(tmpDir, "opencode-rag.json"), JSON.stringify({
      embedding: { provider: "ollama", model: "path-test" },
    }), "utf-8");
    const ctx = await resolveRagContext({ cwd: tmpDir });
    assert.equal(ctx.configPath, join(tmpDir, "opencode-rag.json"));
  });
});
