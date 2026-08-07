import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../../core/config.js";
import { createDescribeImageTool } from "../../opencode/tools.js";
import type { ImageVisionProvider } from "../../chunker/image.js";
import type { RagConfig } from "../../core/config.js";

type ToolResult = string | {
  title?: string;
  output: string;
  metadata?: Record<string, unknown>;
};

const TEST_DESCRIPTION = "A test image with sample content";

function makeFakeVisionProvider(): ImageVisionProvider {
  return {
    describeImage: async () => TEST_DESCRIPTION,
  };
}

function makeSpyVisionProvider(): { provider: ImageVisionProvider; calls: { prompt?: string; systemPrompt?: string }[] } {
  const calls: { prompt?: string; systemPrompt?: string }[] = [];
  const provider: ImageVisionProvider = {
    describeImage: async (_b64, _mime, prompt, systemPrompt) => {
      calls.push({ prompt, systemPrompt });
      return TEST_DESCRIPTION;
    },
  };
  return { provider, calls };
}

function makeConfigWithImageDesc(overrides?: Partial<RagConfig>): RagConfig {
  const cfg = {
    ...DEFAULT_CONFIG,
    ...overrides,
    embedding: { ...DEFAULT_CONFIG.embedding, ...overrides?.embedding },
    retrieval: { ...DEFAULT_CONFIG.retrieval, ...overrides?.retrieval },
    imageDescription: {
      enabled: true,
      provider: "ollama",
      model: "test-model",
      baseUrl: "http://localhost:11434/api",
      timeoutMs: 30000,
      prompt: "Describe this image",
      resizeMaxDimension: 1024,
      ...(overrides?.imageDescription ?? {}),
    },
  } as RagConfig;
  return cfg;
}

function asObject(r: ToolResult): NonNullable<Exclude<ToolResult, string>> {
  assert.notEqual(typeof r, "string");
  return r as NonNullable<Exclude<ToolResult, string>>;
}

// Valid 2x2 red PNG (sharp needs >1px for JPEG conversion)
const MINI_PNG_HEX = "89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a730000000970485973000003e8000003e801b57b526b0000001349444154089963f8cfc0f09f018cff333000001fee03fda92fc0e20000000049454e44ae426082";

describe("createDescribeImageTool", () => {
  let tmpDir: string;
  let pngPath: string;

  before(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "opencode-rag-describe-tool-"));
    pngPath = path.join(tmpDir, "test.png");
    writeFileSync(pngPath, Buffer.from(MINI_PNG_HEX, "hex"));
    writeFileSync(path.join(tmpDir, "readme.txt"), "Hello world", "utf-8");
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns description on success with visionProvider", async () => {
    const cfg = makeConfigWithImageDesc();
    const tool = createDescribeImageTool({
      worktree: tmpDir,
      config: cfg,
      visionProvider: makeFakeVisionProvider(),
    });

    const exec = (tool as { execute: Function }).execute;
    const r = asObject(await exec({ filePath: "test.png" }));

    assert.equal(r.title, `Image description — test.png`);
    assert.match(r.output, /test\.png/);
    assert.match(r.output, /test image with sample content/);
    assert.match(r.output, /test-model/);
    assert.equal(r.metadata?.tool, "describe_image");
    assert.equal(r.metadata?.filePath, "test.png");
    assert.equal(r.metadata?.description, TEST_DESCRIPTION);
    assert.equal(r.metadata?.provider, "ollama");
    assert.equal(r.metadata?.model, "test-model");
  });

  it("returns error metadata for missing file", async () => {
    const cfg = makeConfigWithImageDesc();
    const tool = createDescribeImageTool({
      worktree: tmpDir,
      config: cfg,
      visionProvider: makeFakeVisionProvider(),
    });

    const exec = (tool as { execute: Function }).execute;
    const r = asObject(await exec({ filePath: "nonexistent.png" }));

    assert.equal(r.title, "Describe image");
    assert.match(r.output, /not found/i);
    assert.equal(r.metadata?.error, "not_found");
  });

  it("returns error metadata for unsupported extension", async () => {
    const cfg = makeConfigWithImageDesc();
    const tool = createDescribeImageTool({
      worktree: tmpDir,
      config: cfg,
      visionProvider: makeFakeVisionProvider(),
    });

    const exec = (tool as { execute: Function }).execute;
    const r = asObject(await exec({ filePath: "readme.txt" }));

    assert.equal(r.title, "Describe image");
    assert.match(r.output, /Unsupported file extension/i);
    assert.equal(r.metadata?.error, "unsupported_extension");
  });

  it("returns error metadata when imageDescription is disabled", async () => {
    const cfg = makeConfigWithImageDesc({
      imageDescription: { enabled: false } as any,
    });
    const tool = createDescribeImageTool({
      worktree: tmpDir,
      config: cfg,
      visionProvider: makeFakeVisionProvider(),
    });

    const exec = (tool as { execute: Function }).execute;
    const r = asObject(await exec({ filePath: "test.png" }));

    assert.equal(r.title, "Describe image");
    assert.match(r.output, /not enabled/i);
    assert.equal(r.metadata?.error, "disabled");
  });

  it("handles absolute file path", async () => {
    const cfg = makeConfigWithImageDesc();
    const tool = createDescribeImageTool({
      worktree: tmpDir,
      config: cfg,
      visionProvider: makeFakeVisionProvider(),
    });

    const exec = (tool as { execute: Function }).execute;
    const r = asObject(await exec({ filePath: pngPath }));

    assert.equal(r.title, `Image description — ${pngPath}`);
    assert.ok(r.output.includes("test image with sample content"));
  });

  it("forwards systemPrompt to the vision provider", async () => {
    const cfg = makeConfigWithImageDesc();
    const { provider, calls } = makeSpyVisionProvider();
    const tool = createDescribeImageTool({
      worktree: tmpDir,
      config: cfg,
      visionProvider: provider,
    });

    const exec = (tool as { execute: Function }).execute;
    const r = asObject(await exec({ filePath: "test.png", systemPrompt: "focus on colors and layout" }));

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.prompt, "Describe this image");
    assert.equal(calls[0]?.systemPrompt, "focus on colors and layout");
    assert.equal(r.metadata?.description, TEST_DESCRIPTION);
  });

  it("does not pass systemPrompt when omitted", async () => {
    const cfg = makeConfigWithImageDesc();
    const { provider, calls } = makeSpyVisionProvider();
    const tool = createDescribeImageTool({
      worktree: tmpDir,
      config: cfg,
      visionProvider: provider,
    });

    const exec = (tool as { execute: Function }).execute;
    await exec({ filePath: "test.png" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.systemPrompt, undefined);
  });

  it("creates real vision provider when none injected (config fallback)", () => {
    const cfg = makeConfigWithImageDesc();
    const tool = createDescribeImageTool({
      worktree: tmpDir,
      config: cfg,
    });
    assert.ok(tool);
    assert.equal(typeof tool.execute, "function");
  });
});
