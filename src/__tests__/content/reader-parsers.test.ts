import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanWorkspaceFiles } from "../../content/reader.js";
import { DEFAULT_CONFIG, type RagConfig } from "../../core/config.js";

describe("scanWorkspaceFiles with chunking.parsers", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rag-parser-ext-"));
    await fs.writeFile(path.join(tmpDir, "app.ts"), "export const x = 1;\n", "utf-8");
    await fs.writeFile(path.join(tmpDir, "kernel.cu"), "int add(int a, int b) { return a + b; }\n", "utf-8");
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function config(parsers?: Record<string, string>): RagConfig {
    return {
      ...DEFAULT_CONFIG,
      indexing: {
        ...DEFAULT_CONFIG.indexing,
        includeExtensions: [".ts"],
        minFileSizeBytes: 0,
      },
      chunking: { nodeTypes: {}, parsers },
      imageDescription: { ...DEFAULT_CONFIG.imageDescription!, enabled: false },
    };
  }

  it("scans only configured extensions when no parser override is set", async () => {
    const files = await scanWorkspaceFiles(tmpDir, config());
    const names = files.map((f) => path.basename(f.filePath)).sort();
    assert.deepEqual(names, ["app.ts"]);
  });

  it("implicitly includes extensions named in chunking.parsers", async () => {
    const files = await scanWorkspaceFiles(tmpDir, config({ ".cu": "cpp" }));
    const names = files.map((f) => path.basename(f.filePath)).sort();
    assert.deepEqual(names, ["app.ts", "kernel.cu"]);
  });
});
