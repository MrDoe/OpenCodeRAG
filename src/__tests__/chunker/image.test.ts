import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

describe("ImageChunker", () => {
  let chunker: any;

  before(async () => {
    const mod = await import("../../chunker/image.js");
    chunker = new mod.ImageChunker([".png", ".jpg", ".jpeg"]);
  });

  it("has correct language and extensions", () => {
    assert.equal(chunker.language, "image");
    assert.deepEqual(chunker.fileExtensions, [".png", ".jpg", ".jpeg"]);
  });

  it("returns empty array for empty content", async () => {
    const chunks = await chunker.chunk("/test/file.png", "");
    assert.equal(chunks.length, 0);
  });

  it("creates one chunk for a short description", async () => {
    const description = "A blue logo with white text reading 'Hello World' on a gradient background.";
    const chunks = await chunker.chunk("/test/logo.png", description);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.content, description);
    assert.equal(chunks[0]!.metadata.filePath, "/test/logo.png");
    assert.equal(chunks[0]!.metadata.language, "image");
    assert.equal(chunks[0]!.metadata.startLine, 1);
    assert.equal(chunks[0]!.metadata.endLine, 1);
  });

  it("splits long descriptions into multiple chunks", async () => {
    const paras: string[] = [];
    for (let i = 0; i < 20; i++) {
      paras.push("Paragraph " + i + ". " + "word ".repeat(200));
    }
    const description = paras.join("\n\n");
    const chunks = await chunker.chunk("/test/image.png", description);
    assert.ok(chunks.length > 1, "should produce multiple chunks for long text");
    for (const chunk of chunks) {
      assert.ok(chunk.content.length > 0);
      assert.ok(chunk.content.length <= 4100, "chunk should not exceed max chars");
    }
  });

  it("preserves all content across chunks", async () => {
    const paras: string[] = [];
    for (let i = 0; i < 10; i++) {
      paras.push("Sentence " + i + " with some words to fill up the paragraph content.");
    }
    const description = paras.join("\n\n");
    const chunks = await chunker.chunk("/test/img.png", description);
    const recombined = chunks.map((c: any) => c.content).join("\n\n");
    assert.equal(recombined, description);
  });

  it("handles single very long paragraph as single chunk", async () => {
    const longPara = "word ".repeat(2000);
    const chunks = await chunker.chunk("/test/large.png", longPara);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.content, longPara);
  });
});

describe("getMimeType", () => {
  let mimeFn: (ext: string) => string;

  before(async () => {
    const mod = await import("../../chunker/image.js");
    mimeFn = mod.getMimeType;
  });

  it("returns correct mime types", () => {
    assert.equal(mimeFn(".png"), "image/png");
    assert.equal(mimeFn(".jpg"), "image/jpeg");
    assert.equal(mimeFn(".jpeg"), "image/jpeg");
    assert.equal(mimeFn(".gif"), "image/gif");
    assert.equal(mimeFn(".webp"), "image/webp");
    assert.equal(mimeFn("png"), "image/png");
    assert.equal(mimeFn(".svg"), "image/svg+xml");
  });

  it("returns png as default for unknown extensions", () => {
    assert.equal(mimeFn(".tiff"), "image/png");
  });
});

describe("createImageVisionProvider", () => {
  let createFn: any;

  before(async () => {
    const mod = await import("../../chunker/image.js");
    createFn = mod.createImageVisionProvider;
  });

  it("creates Ollama provider by default", () => {
    const provider = createFn({
      enabled: true,
      provider: "ollama",
      model: "llama3.2-vision",
      baseUrl: "http://localhost:11434/api",
      timeoutMs: 30000,
      prompt: "Describe this image",
    });
    assert.ok(provider);
    assert.equal(typeof provider.describeImage, "function");
  });

  it("creates OpenAI provider", () => {
    const provider = createFn({
      enabled: true,
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      timeoutMs: 30000,
      prompt: "Describe this image",
    });
    assert.ok(provider);
    assert.equal(typeof provider.describeImage, "function");
  });

  it("creates an OpenCode Zen provider for opencode-go", () => {
    const provider = createFn({
      enabled: true,
      provider: "opencode-go",
      model: "mimo-v2.5",
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "go-key",
      timeoutMs: 30000,
      prompt: "Describe this image",
    });
    assert.ok(provider);
    assert.equal(typeof provider.describeImage, "function");
  });

  it("creates an OpenCode Zen provider for opencode", () => {
    const provider = createFn({
      enabled: true,
      provider: "opencode",
      model: "mimo-v2.5-free",
      baseUrl: "https://opencode.ai/zen/v1",
      apiKey: "zen-key",
      timeoutMs: 30000,
      prompt: "Describe this image",
    });
    assert.ok(provider);
    assert.equal(typeof provider.describeImage, "function");
  });

  it("throws for opencode-go without apiKey", () => {
    assert.throws(() => {
      createFn({
        enabled: true,
        provider: "opencode-go",
        model: "mimo-v2.5",
        baseUrl: "",
        timeoutMs: 30000,
        prompt: "Describe this image",
      });
    }, /apiKey/);
  });

  it("creates Anthropic provider", () => {
    const provider = createFn({
      enabled: true,
      provider: "anthropic",
      model: "claude-3-haiku-20240307",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-test",
      timeoutMs: 30000,
      prompt: "Describe this image",
    });
    assert.ok(provider);
    assert.equal(typeof provider.describeImage, "function");
  });

  it("creates Google Gemini provider", () => {
    const provider = createFn({
      enabled: true,
      provider: "google",
      model: "gemini-2.0-flash",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "test-key",
      timeoutMs: 30000,
      prompt: "Describe this image",
    });
    assert.ok(provider);
    assert.equal(typeof provider.describeImage, "function");
  });

  it("throws for Anthropic without apiKey", () => {
    assert.throws(() => {
      createFn({
        enabled: true,
        provider: "anthropic",
        model: "claude-3-haiku-20240307",
        baseUrl: "https://api.anthropic.com",
        timeoutMs: 30000,
        prompt: "Describe this image",
      });
    }, /apiKey/);
  });

  it("throws for OpenAI without apiKey", () => {
    assert.throws(() => {
      createFn({
        enabled: true,
        provider: "openai",
        model: "gpt-4o-mini",
        baseUrl: "https://api.openai.com/v1",
        timeoutMs: 30000,
        prompt: "Describe this image",
      });
    }, /apiKey/);
  });
});

describe("resolveZenBaseUrl", () => {
  let resolveFn: any;

  before(async () => {
    const mod = await import("../../core/zen.js");
    resolveFn = mod.resolveZenBaseUrl;
  });

  it("uses the Go endpoint by default", () => {
    assert.equal(resolveFn("", "opencode-go"), "https://opencode.ai/zen/go/v1");
  });

  it("replaces a non-Zen base URL inherited from indexing", () => {
    assert.equal(resolveFn("http://127.0.0.1:8080/v1", "opencode-go"), "https://opencode.ai/zen/go/v1");
  });

  it("keeps explicit opencode.ai base URLs", () => {
    assert.equal(resolveFn("https://opencode.ai/zen/go/v1", "opencode-go"), "https://opencode.ai/zen/go/v1");
  });

  it("uses the standard Zen endpoint for provider opencode", () => {
    assert.equal(resolveFn("", "opencode"), "https://opencode.ai/zen/v1");
  });
});

describe("resolveOnDemandImageConfig", () => {
  let resolveFn: any;

  before(async () => {
    const mod = await import("../../chunker/image.js");
    resolveFn = mod.resolveOnDemandImageConfig;
  });

  const makeBase = (onDemand?: Record<string, unknown>) => ({
    enabled: true,
    provider: "ollama",
    model: "index-model",
    baseUrl: "http://localhost:11434/api",
    timeoutMs: 30000,
    prompt: "index prompt",
    resizeMaxDimension: 1024,
    ...(onDemand ? { onDemand } : {}),
  });

  it("returns the base config unchanged when onDemand is absent", () => {
    const base = makeBase();
    const resolved = resolveFn(base);
    assert.deepEqual(resolved, base);
  });

  it("applies provider, model, and prompt overrides", () => {
    const resolved = resolveFn(makeBase({
      provider: "openai",
      model: "gpt-4o-mini",
      prompt: "on-demand prompt",
      resizeMaxDimension: 512,
    }));
    assert.equal(resolved.provider, "openai");
    assert.equal(resolved.model, "gpt-4o-mini");
    assert.equal(resolved.prompt, "on-demand prompt");
    assert.equal(resolved.resizeMaxDimension, 512);
  });

  it("falls back to base values for omitted override fields", () => {
    const resolved = resolveFn(makeBase({ model: "other-model" }));
    assert.equal(resolved.provider, "ollama");
    assert.equal(resolved.baseUrl, "http://localhost:11434/api");
    assert.equal(resolved.timeoutMs, 30000);
    assert.equal(resolved.prompt, "index prompt");
  });

  it("strips the onDemand key from the result", () => {
    const resolved = resolveFn(makeBase({ model: "other-model" }));
    assert.equal("onDemand" in resolved, false);
  });

  it("ignores null and undefined override values", () => {
    const resolved = resolveFn(makeBase({ model: null, prompt: undefined, provider: "openai" }));
    assert.equal(resolved.model, "index-model");
    assert.equal(resolved.prompt, "index prompt");
    assert.equal(resolved.provider, "openai");
  });

  it("does not mutate the input config", () => {
    const base = makeBase({ model: "other-model" });
    resolveFn(base);
    assert.equal(base.model, "index-model");
    assert.deepEqual(base.onDemand, { model: "other-model" });
  });
});
