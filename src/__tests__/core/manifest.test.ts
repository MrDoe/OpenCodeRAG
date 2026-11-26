import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  computeFileHash,
  computeDescriptionConfigHash,
  createEmptyManifest,
  legacyAbsoluteKey,
  legacyAbsoluteKeyVariants,
  loadManifest,
  manifestPathFor,
  normalizeFilePath,
  saveManifest,
} from "../../core/manifest.js";
import { type RagConfig } from "../../core/config.js";

async function makeTempDir(name: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

describe("manifest", () => {
  it("rebuilds the legacy absolute key with forward slashes on Windows", () => {
    // Pre-upgrade rows hold `C:/...`; win32 resolve() alone yields backslashes.
    assert.equal(legacyAbsoluteKey("src/a.ts", "C:\\work\\repo", path.win32), "C:/work/repo/src/a.ts");
    assert.deepEqual(
      legacyAbsoluteKeyVariants("src/a.ts", "c:\\work\\repo", path.win32),
      ["c:/work/repo/src/a.ts", "C:/work/repo/src/a.ts"],
    );
    assert.deepEqual(
      legacyAbsoluteKeyVariants("src/a.ts", "/work/repo", path.posix),
      ["/work/repo/src/a.ts"],
    );
  });

  it("creates an empty manifest", () => {
    assert.deepStrictEqual(createEmptyManifest(), { files: {}, schemaVersion: 3 });
  });

  it("normalizes file paths to workspace-relative forward-slash paths", () => {
    const normalized = normalizeFilePath("src\\test.ts");
    // Relative to the workspace root, never an absolute machine-specific path.
    assert.ok(!normalized.startsWith("/"), `expected relative, got ${normalized}`);
    assert.ok(!normalized.includes("\\"));
  });

  it("relativises absolute paths against an explicit workspace root", () => {
    const cwd = path.resolve("/workspace/root");
    assert.equal(normalizeFilePath(path.join(cwd, "src", "a.ts"), cwd), "src/a.ts");
  });

  it("computes stable hashes", () => {
    assert.equal(computeFileHash("abc"), computeFileHash("abc"));
    assert.notEqual(computeFileHash("abc"), computeFileHash("abcd"));
  });

  it("returns missing status when manifest file does not exist", async () => {
    const dir = await makeTempDir("manifest-missing");
    const result = await loadManifest(dir);
    assert.equal(result.status, "missing");
    assert.deepStrictEqual(result.manifest, { files: {}, schemaVersion: 3 });
    assert.equal(result.path, manifestPathFor(dir));
  });

  it("saves and loads manifest data", async () => {
    const dir = await makeTempDir("manifest-save");
    const manifest = {
      lastIndexedAt: 123,
      files: {
        "src/example.ts": {
          hash: "hash-1",
          chunkCount: 2,
          indexedAt: 123,
        },
      },
    };

    await saveManifest(dir, manifest);
    const result = await loadManifest(dir);

    assert.equal(result.status, "ok");
    assert.deepStrictEqual(result.manifest, manifest);
  });

  it("normalizes legacy absolute file paths to workspace-relative on load", async () => {
    const dir = await makeTempDir("manifest-legacy");
    const cwd = path.resolve("/workspace/root");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      manifestPathFor(dir),
      JSON.stringify({
        schemaVersion: 3,
        files: {
          [path.join(cwd, "src", "legacy.ts")]: { hash: "h1", chunkCount: 1 },
        },
      }),
      "utf-8",
    );
    const result = await loadManifest(dir, cwd);
    assert.equal(result.status, "ok");
    assert.deepStrictEqual(result.manifest.files, {
      "src/legacy.ts": { hash: "h1", chunkCount: 1 },
    });
  });

  it("returns corrupt status for invalid JSON", async () => {
    const dir = await makeTempDir("manifest-corrupt");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(manifestPathFor(dir), "{not-json", "utf-8");

    const result = await loadManifest(dir);
    assert.equal(result.status, "corrupt");
    assert.deepStrictEqual(result.manifest, { files: {}, schemaVersion: 3 });
  });

  it("rejects schema version 1 as corrupt (below MIN_SUPPORTED_SCHEMA_VERSION)", async () => {
    const dir = await makeTempDir("manifest-v1-corrupt");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      manifestPathFor(dir),
      JSON.stringify({ schemaVersion: 1, files: {} }),
      "utf-8",
    );
    const result = await loadManifest(dir);
    assert.equal(result.status, "corrupt");
  });

  it("computeDescriptionConfigHash returns undefined when no description or imageConfig sections exist", () => {
    const config = {} as unknown as RagConfig;
    const hash = computeDescriptionConfigHash(config);
    assert.equal(hash, undefined);
  });

  it("computeDescriptionConfigHash returns consistent values for same config", () => {
    const config = {
      description: {
        provider: "ollama",
        model: "qwen2.5:3b",
        baseUrl: "http://127.0.0.1:11434",
        systemPrompt: "Describe this code",
      },
      imageDescription: {
        provider: "ollama",
        model: "minicpm-v4.6",
        baseUrl: "http://127.0.0.1:11434",
        prompt: "Describe this image",
      },
    } as unknown as RagConfig;

    const hash1 = computeDescriptionConfigHash(config);
    const hash2 = computeDescriptionConfigHash(config);
    assert.ok(typeof hash1 === "string");
    assert.equal(hash1, hash2);
  });

  it("computeDescriptionConfigHash changes when description model changes", () => {
    const config1 = {
      description: { provider: "ollama", model: "qwen2.5:3b", baseUrl: "http://localhost:11434", systemPrompt: "test" },
    } as unknown as RagConfig;
    const config2 = {
      description: { provider: "ollama", model: "qwen2.5:7b", baseUrl: "http://localhost:11434", systemPrompt: "test" },
    } as unknown as RagConfig;

    assert.notEqual(computeDescriptionConfigHash(config1), computeDescriptionConfigHash(config2));
  });

  it("computeDescriptionConfigHash changes when experimental batching is toggled", () => {
    const config1 = {
      description: { provider: "ollama", model: "qwen2.5:3b", baseUrl: "http://localhost:11434", systemPrompt: "test", batchEnabled: false },
    } as unknown as RagConfig;
    const config2 = {
      description: { provider: "ollama", model: "qwen2.5:3b", baseUrl: "http://localhost:11434", systemPrompt: "test", batchEnabled: true },
    } as unknown as RagConfig;

    assert.notEqual(computeDescriptionConfigHash(config1), computeDescriptionConfigHash(config2));
  });
});
