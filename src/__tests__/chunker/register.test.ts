import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerChunker, getChunker } from "../../chunker/factory.js";
import { loadChunkersFromConfig } from "../../chunker/loader.js";
import type { Chunker, Chunk } from "../../core/interfaces.js";

describe("registerChunker", () => {
  const testChunker: Chunker = {
    language: "test",
    fileExtensions: [".xyz"],
    chunk: async (_path: string, content: string): Promise<Chunk[]> => {
      return [{ id: "1", content, metadata: { filePath: _path, startLine: 1, endLine: 1, language: "test" } }];
    },
  };

  it("registers a chunker for new extensions", () => {
    registerChunker(testChunker, [".xyz"]);
    const chunker = getChunker("file.xyz");
    assert.equal(chunker.language, "test");
  });

  it("uses fileExtensions from chunker when no extensions arg given", () => {
    const autoChunker: Chunker = {
      language: "auto",
      fileExtensions: [".abc"],
      chunk: async (_path: string, content: string): Promise<Chunk[]> => {
        return [{ id: "1", content, metadata: { filePath: _path, startLine: 1, endLine: 1, language: "auto" } }];
      },
    };
    registerChunker(autoChunker);
    const chunker = getChunker("file.abc");
    assert.equal(chunker.language, "auto");
  });

  it("warns and skips when extension already registered", () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => { warnings.push(msg); };

    try {
      const existing = getChunker("file.ts");
      assert.ok(existing, "TypeScript chunker should exist");

      const overrideChunker: Chunker = {
        language: "override",
        fileExtensions: [".ts"],
        chunk: async (): Promise<Chunk[]> => [],
      };
      registerChunker(overrideChunker, [".ts"]);

      assert.ok(warnings.some((w) => w.includes("already registered")), "expected warning");
      const stillExisting = getChunker("file.ts");
      assert.equal(stillExisting.language, "typescript", "existing chunker should be preserved");
    } finally {
      console.warn = origWarn;
    }
  });
});

describe("loadChunkersFromConfig", () => {
  it("does nothing when chunkers array is empty", async () => {
    await loadChunkersFromConfig({ chunkers: [] } as unknown as import("../../core/config.js").RagConfig, "/tmp");
    // no crash = pass
  });

  it("does nothing when chunkers is undefined", async () => {
    await loadChunkersFromConfig({} as unknown as import("../../core/config.js").RagConfig, "/tmp");
    // no crash = pass
  });

  it("warns when a chunking.parsers target is not a registered parser", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => { warnings.push(msg); };

    try {
      await loadChunkersFromConfig(
        { chunking: { parsers: { ".cu": "cuda-not-real", ".c": "cpp" } } } as unknown as import("../../core/config.js").RagConfig,
        "/tmp"
      );
      assert.ok(
        warnings.some((w) => w.includes('".cu"') && w.includes("cuda-not-real")),
        `expected unknown-parser warning, got: ${JSON.stringify(warnings)}`
      );
      assert.ok(
        !warnings.some((w) => w.includes('".c"')),
        "a valid override must not warn"
      );
    } finally {
      console.warn = origWarn;
    }
  });

  it("warns when a chunking.parsers key is not a usable extension", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => { warnings.push(msg); };

    try {
      await loadChunkersFromConfig(
        { chunking: { parsers: { "src/nested": "cpp" } } } as unknown as import("../../core/config.js").RagConfig,
        "/tmp"
      );
      assert.ok(warnings.some((w) => w.includes("not a valid file extension")));
    } finally {
      console.warn = origWarn;
    }
  });

  it("warns when module path does not exist", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => { warnings.push(msg); };

    try {
      await loadChunkersFromConfig(
        { chunkers: [{ module: "./nonexistent.js", extensions: [".zzz"] }] } as unknown as import("../../core/config.js").RagConfig,
        "/tmp"
      );
      assert.ok(warnings.length > 0, "expected warning about failed load");
    } finally {
      console.warn = origWarn;
    }
  });

  it("warns when module does not export a valid Chunker", async () => {
    const fs = await import("node:fs/promises");
    const pathMod = await import("node:path");
    const os = await import("node:os");
    const tmpDir = await fs.mkdtemp(pathMod.join(os.tmpdir(), "chunker-test-"));
    const moduleName = "invalid.mjs";
    await fs.writeFile(pathMod.join(tmpDir, moduleName), "export const foo = 42;\n");

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => { warnings.push(msg); };

    try {
      await loadChunkersFromConfig(
        { chunkers: [{ module: moduleName, extensions: [".inv"] }] } as unknown as import("../../core/config.js").RagConfig,
        tmpDir
      );
      assert.ok(warnings.some((w) => w.includes("no .chunk()")), "expected warning about missing chunk method");
    } finally {
      console.warn = origWarn;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
