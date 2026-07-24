import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_CONFIG, type RagConfig } from "../../core/config.js";
import { loadManifest, normalizeFilePath } from "../../core/manifest.js";
import {
  createWatchPassScheduler,
  getIndexStatusSummary,
  runIndexPass,
} from "../../indexer.js";
import type { Chunk, DescriptionProvider, EmbeddingProvider } from "../../core/interfaces.js";
import type { ImageVisionProvider } from "../../chunker/image.js";
import { LanceDbStore } from "../../vectorstore/lancedb.js";

class TestEmbedder implements EmbeddingProvider {
  readonly name = "test";

  async embed(texts: string[], _purpose?: "query" | "document"): Promise<number[][]> {
    return texts.map((text, index) => [text.length, index + 1, 0.5, -0.5]);
  }
}

async function makeTempDir(name: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

function testConfig(): RagConfig {
  return {
    ...DEFAULT_CONFIG,
    indexing: {
      ...DEFAULT_CONFIG.indexing,
      includeExtensions: [".ts"],
      excludeDirs: ["node_modules", ".git", ".opencode"],
      minFileSizeBytes: 0,
    },
  };
}

describe("indexer", () => {
  let workspaceDir: string;
  let storeDir: string;
  let store: LanceDbStore;
  const embedder = new TestEmbedder();

  beforeEach(async () => {
    workspaceDir = await makeTempDir("indexer-workspace");
    storeDir = await makeTempDir("indexer-store");
    // Use in-memory store for speed; storePath still needs a real dir for manifest
    store = new LanceDbStore("memory://", 4);
  });

  it("indexes new files and records them in the manifest", async () => {
    await writeFile(path.join(workspaceDir, "src", "a.ts"), "function alpha() { return 1; }\n");
    await writeFile(path.join(workspaceDir, "src", "b.ts"), "function beta() { return 2; }\n");

    const stats = await runIndexPass({
      cwd: workspaceDir,
      storePath: storeDir,
      config: testConfig(),
      store,
      embedder,
    });

    assert.equal(stats.newFiles, 2);
    assert.equal(stats.modifiedFiles, 0);
    assert.equal(stats.unchangedFiles, 0);
    assert.equal(stats.deletedFiles, 0);
    assert.equal(stats.finalCount, 2);

    const manifest = await loadManifest(storeDir);
    assert.equal(manifest.status, "ok");
    assert.equal(Object.keys(manifest.manifest.files).length, 2);
  });

  it("skips unchanged files and updates modified or deleted files", async () => {
    const fileA = path.join(workspaceDir, "src", "a.ts");
    const fileB = path.join(workspaceDir, "src", "b.ts");
    const fileC = path.join(workspaceDir, "src", "c.ts");

    await writeFile(fileA, "function alpha() { return 1; }\n");
    await writeFile(fileB, "function beta() { return 2; }\n");
    await runIndexPass({
      cwd: workspaceDir,
      storePath: storeDir,
      config: testConfig(),
      store,
      embedder,
    });

    await writeFile(fileA, "function alpha() { return 10; }\n");
    await fs.unlink(fileB);
    await writeFile(fileC, "function gamma() { return 3; }\n");

    const stats = await runIndexPass({
      cwd: workspaceDir,
      storePath: storeDir,
      config: testConfig(),
      store,
      embedder,
    });

    assert.equal(stats.newFiles, 1);
    assert.equal(stats.modifiedFiles, 1);
    assert.equal(stats.deletedFiles, 1);
    assert.equal(stats.unchangedFiles, 0);
    assert.equal(stats.finalCount, 2);
  });

  it("removes empty files from the index", async () => {
    const filePath = path.join(workspaceDir, "src", "empty.ts");
    await writeFile(filePath, "function keep() { return 1; }\n");

    await runIndexPass({
      cwd: workspaceDir,
      storePath: storeDir,
      config: testConfig(),
      store,
      embedder,
    });

    await writeFile(filePath, "   \n");
    const stats = await runIndexPass({
      cwd: workspaceDir,
      storePath: storeDir,
      config: testConfig(),
      store,
      embedder,
    });

    assert.equal(stats.skippedEmptyFiles, 1);
    assert.equal(stats.removedFiles, 1);
    assert.equal(await store.count(), 0);
  });

  it("skips files smaller than minFileSizeBytes", async () => {
    const smallFilePath = path.join(workspaceDir, "src", "small.ts");
    const largeFilePath = path.join(workspaceDir, "src", "large.ts");

    // Config with a min file size of 50 bytes
    const customConfig: RagConfig = {
      ...testConfig(),
      indexing: { ...testConfig().indexing, minFileSizeBytes: 50 },
    };

    await writeFile(smallFilePath, "// short"); // 9 bytes
    await writeFile(largeFilePath, "// This is a much longer file with more content to exceed the min size threshold."); // > 50 bytes

    const stats = await runIndexPass({
      cwd: workspaceDir,
      storePath: storeDir,
      config: customConfig,
      store,
      embedder,
    });

    assert.equal(stats.skippedSmallFiles, 1);
    assert.equal(stats.newFiles, 1);
    assert.equal(stats.finalCount, 1);
    assert.equal(await store.count(), 1);

    const manifest = await loadManifest(storeDir);
    assert.equal(manifest.status, "ok");
    assert.ok(!manifest.manifest.files[normalizeFilePath(smallFilePath)]);
    assert.ok(manifest.manifest.files[normalizeFilePath(largeFilePath)]);
  });

  it("removes too small files from the index", async () => {
    const filePath = path.join(workspaceDir, "src", "shrinking.ts");
    await writeFile(filePath, "// large enough file content to be indexed initially");

    const initialConfig: RagConfig = {
      ...testConfig(),
      indexing: { ...testConfig().indexing, minFileSizeBytes: 10 },
    };

    await runIndexPass({
      cwd: workspaceDir,
      storePath: storeDir,
      config: initialConfig,
      store,
      embedder,
    });

    assert.equal(await store.count(), 1);

    // Shrink the file below the threshold
    await writeFile(filePath, "//tiny");

    const shrinkConfig: RagConfig = {
      ...testConfig(),
      indexing: { ...testConfig().indexing, minFileSizeBytes: 50 },
    };

    const stats = await runIndexPass({
      cwd: workspaceDir,
      storePath: storeDir,
      config: shrinkConfig,
      store,
      embedder,
    });

    assert.equal(stats.skippedSmallFiles, 1);
    assert.equal(stats.removedFiles, 1);
    assert.equal(await store.count(), 0);
  });

  it("reports pending files in status summary", async () => {
    const filePath = path.join(workspaceDir, "src", "a.ts");
    await writeFile(filePath, "function alpha() { return 1; }\n");

    await runIndexPass({
      cwd: workspaceDir,
      storePath: storeDir,
      config: testConfig(),
      store,
      embedder,
    });

    await writeFile(filePath, "function alpha() { return 2; }\n");

    const summary = await getIndexStatusSummary(
      workspaceDir,
      storeDir,
      testConfig(),
      store
    );

    assert.equal(summary.manifestStatus, "ok");
    assert.equal(summary.upToDateFiles, 0);
    assert.equal(summary.pendingFiles, 1);
    assert.equal(summary.manifestEntries, 1);
  });

  it("rebuilds safely when manifest is missing but store has data", async () => {
    const filePath = path.join(workspaceDir, "src", "a.ts");
    await writeFile(filePath, "function alpha() { return 1; }\n");

    await runIndexPass({
      cwd: workspaceDir,
      storePath: storeDir,
      config: testConfig(),
      store,
      embedder,
      dimension: 4,
    });

    await fs.unlink(path.join(storeDir, "manifest.json"));
    const stats = await runIndexPass({
      cwd: workspaceDir,
      storePath: storeDir,
      config: testConfig(),
      store,
      embedder,
      dimension: 4,
    });

    assert.equal(stats.rebuildPerformed, true);
    assert.equal(stats.newFiles, 1);
    assert.equal(await store.count(), 1);
  });

  it("aborts rebuild without dimension to protect existing data", async () => {
    const filePath = path.join(workspaceDir, "src", "a.ts");
    await writeFile(filePath, "function alpha() { return 1; }\n");

    await runIndexPass({
      cwd: workspaceDir,
      storePath: storeDir,
      config: testConfig(),
      store,
      embedder,
      dimension: 4,
    });

    const countBefore = await store.count();
    assert.equal(countBefore, 1);

    await fs.unlink(path.join(storeDir, "manifest.json"));
    const stats = await runIndexPass({
      cwd: workspaceDir,
      storePath: storeDir,
      config: testConfig(),
      store,
      embedder,
    });

    assert.equal(stats.rebuildPerformed, false);
    assert.equal(await store.count(), 1);
  });

  it("queues one follow-up watch pass while a pass is running", async () => {
    let runs = 0;
    let release = () => {};

    const scheduler = createWatchPassScheduler(
      async () => {
        runs++;
        if (runs === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      },
      () => {
        assert.fail("unexpected watch scheduler error");
      },
      10
    );

    scheduler.notifyChange();
    await delay(25);
    scheduler.notifyChange();
    scheduler.notifyChange();

    release();
    await scheduler.waitForIdle();
    scheduler.close();

    assert.equal(runs, 2);
  });

  it("accumulates paths across multiple notifyChange calls", async () => {
    const receivedPaths: string[][] = [];
    const scheduler = createWatchPassScheduler(
      async (paths?: string[]) => {
        receivedPaths.push(paths ?? []);
      },
      () => { assert.fail("unexpected error"); },
      10,
    );

    scheduler.notifyChange(["a.ts", "b.ts"]);
    scheduler.notifyChange(["b.ts", "c.ts"]); // b.ts is duplicate
    await delay(50);

    assert.equal(receivedPaths.length, 1);
    const paths = receivedPaths[0]!.sort();
    assert.deepStrictEqual(paths, ["a.ts", "b.ts", "c.ts"]);

    scheduler.close();
  });

  it("accumulates paths and passes undefined when no paths given", async () => {
    const receivedPaths: (string[] | undefined)[] = [];
    const scheduler = createWatchPassScheduler(
      async (paths?: string[]) => { receivedPaths.push(paths); },
      () => { assert.fail("unexpected error"); },
      10,
    );

    scheduler.notifyChange(["x.ts"]);
    scheduler.notifyChange(); // full pass request overrides
    await delay(50);

    assert.equal(receivedPaths.length, 1);
    assert.equal(receivedPaths[0], undefined); // full pass = no filter paths

    scheduler.close();
  });

  describe("description provider integration", () => {
    it("generates descriptions and embeds description + content together", async () => {
      await writeFile(path.join(workspaceDir, "src", "a.ts"), "function alpha() { return 1; }\n");

      const descriptions = new Map<string, string>();
      const descProvider: DescriptionProvider = {
        async generateDescription(chunk: Chunk): Promise<string> {
          const desc = `Description for ${chunk.metadata.filePath}`;
          descriptions.set(chunk.id, desc);
          return desc;
        },
        async generateBatchDescriptions(chunks: Chunk[]): Promise<Map<string, string>> {
          const result = new Map<string, string>();
          for (const chunk of chunks) {
            const desc = `Description for ${chunk.metadata.filePath}`;
            result.set(chunk.id, desc);
          }
          return result;
        },
        async generateText(): Promise<string> { return ""; },
      };

      // Track what text is sent to the embedder
      const embeddedTexts: string[] = [];
      const trackingEmbedder: EmbeddingProvider = {
        name: "test",
        async embed(texts: string[], _purpose?: "query" | "document"): Promise<number[][]> {
          embeddedTexts.push(...texts);
          return texts.map((_, index) => [texts.length, index + 1, 0.5, -0.5]);
        },
      };

      const stats = await runIndexPass({
        cwd: workspaceDir,
        storePath: storeDir,
        config: testConfig(),
        store,
        embedder: trackingEmbedder,
        descriptionProvider: descProvider,
      });

      assert.equal(stats.newFiles, 1);
      assert.ok(stats.totalChunks > 0);
      // Verify that the embedded text contains filePath, description, and the code
      assert.ok(embeddedTexts.some((t) => t.includes("src/a.ts")));
      assert.ok(embeddedTexts.some((t) => t.includes("Description for")));
      assert.ok(embeddedTexts.some((t) => t.includes("function alpha")));
    });

    it("falls back to content when description generation fails", async () => {
      await writeFile(path.join(workspaceDir, "src", "b.ts"), "function beta() { return 2; }\n");

      const failingProvider: DescriptionProvider = {
        async generateDescription(): Promise<string> {
          throw new Error("LLM unavailable");
        },
        async generateBatchDescriptions(): Promise<Map<string, string>> {
          throw new Error("LLM unavailable");
        },
        async generateText(): Promise<string> { throw new Error("LLM unavailable"); },
      };

      const embeddedTexts: string[] = [];
      const trackingEmbedder: EmbeddingProvider = {
        name: "test",
        async embed(texts: string[], _purpose?: "query" | "document"): Promise<number[][]> {
          embeddedTexts.push(...texts);
          return texts.map((_, index) => [texts.length, index + 1, 0.5, -0.5]);
        },
      };

      const stats = await runIndexPass({
        cwd: workspaceDir,
        storePath: storeDir,
        config: testConfig(),
        store,
        embedder: trackingEmbedder,
        descriptionProvider: failingProvider,
      });

      assert.equal(stats.newFiles, 1);
      // Should fall back to embedding filePath + content
      assert.ok(embeddedTexts.some((t) => t.includes("src/b.ts")));
      assert.ok(embeddedTexts.some((t) => t.includes("function beta")));
    });

    it("embeds content when no description provider is given", async () => {
      await writeFile(path.join(workspaceDir, "src", "c.ts"), "function gamma() { return 3; }\n");

      const embeddedTexts: string[] = [];
      const trackingEmbedder: EmbeddingProvider = {
        name: "test",
        async embed(texts: string[], _purpose?: "query" | "document"): Promise<number[][]> {
          embeddedTexts.push(...texts);
          return texts.map((_, index) => [texts.length, index + 1, 0.5, -0.5]);
        },
      };

      const stats = await runIndexPass({
        cwd: workspaceDir,
        storePath: storeDir,
        config: testConfig(),
        store,
        embedder: trackingEmbedder,
      });

      assert.equal(stats.newFiles, 1);
      // Verify filePath and new description format (lines + language) are included
      assert.ok(embeddedTexts.some((t) => t.includes("src/c.ts")));
      assert.ok(embeddedTexts.some((t) => t.includes("function gamma")));
    });

    it("uses document prefix with descriptions", async () => {
      await writeFile(path.join(workspaceDir, "src", "d.ts"), "function delta() { return 4; }\n");

      const descProvider: DescriptionProvider = {
        async generateDescription(): Promise<string> {
          return "A delta function.";
        },
        async generateBatchDescriptions(chunks: Chunk[]): Promise<Map<string, string>> {
          const result = new Map<string, string>();
          for (const chunk of chunks) {
            result.set(chunk.id, "A delta function.");
          }
          return result;
        },
        async generateText(): Promise<string> { return ""; },
      };

      const embeddedTexts: string[] = [];
      const trackingEmbedder: EmbeddingProvider = {
        name: "test",
        async embed(texts: string[], _purpose?: "query" | "document"): Promise<number[][]> {
          embeddedTexts.push(...texts);
          return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
        },
      };

      const configWithPrefix: RagConfig = {
        ...testConfig(),
        embedding: {
          ...testConfig().embedding,
          documentPrefix: "search_document: ",
        },
      };

      await runIndexPass({
        cwd: workspaceDir,
        storePath: storeDir,
        config: configWithPrefix,
        store,
        embedder: trackingEmbedder,
        descriptionProvider: descProvider,
      });

      assert.ok(embeddedTexts.every((t) => t.startsWith("search_document: ")));
      // Verify the embedded text contains filePath after the document prefix
      assert.ok(embeddedTexts.every((t) => t.includes("src/d.ts")));
      assert.ok(embeddedTexts.some((t) => t.includes("A delta function.")));
    });

    it("always includes filePath as first component in embedding text", async () => {
      await writeFile(path.join(workspaceDir, "src", "e.ts"), "function epsilon() { return 5; }\n");

      const descProvider: DescriptionProvider = {
        async generateDescription(): Promise<string> {
          return "An epsilon function.";
        },
        async generateBatchDescriptions(chunks: Chunk[]): Promise<Map<string, string>> {
          const result = new Map<string, string>();
          for (const chunk of chunks) {
            result.set(chunk.id, "An epsilon function.");
          }
          return result;
        },
        async generateText(): Promise<string> { return ""; },
      };

      const embeddedTexts: string[] = [];
      const trackingEmbedder: EmbeddingProvider = {
        name: "test",
        async embed(texts: string[]): Promise<number[][]> {
          embeddedTexts.push(...texts);
          return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
        },
      };

      await runIndexPass({
        cwd: workspaceDir,
        storePath: storeDir,
        config: testConfig(),
        store,
        embedder: trackingEmbedder,
        descriptionProvider: descProvider,
      });

      // Format should be: relPath\n\n[metaHeader]\n\ndescription\n\ncontent
      assert.ok(embeddedTexts.some((t) => {
        const idx = t.indexOf("src/e.ts");
        if (idx < 0) return false;
        // filePath should be followed by optional metadata header, then description, then content
        return t.includes("src/e.ts\n\n") && t.includes("An epsilon function.") && t.includes("function epsilon()");
      }));
    });

    it("flags files with description failures in the manifest", async () => {
      await writeFile(path.join(workspaceDir, "src", "fail.ts"), "function fail() { return 1; }\n");

      const failingProvider: DescriptionProvider = {
        async generateDescription(): Promise<string> {
          throw new Error("LLM unavailable");
        },
        async generateBatchDescriptions(): Promise<Map<string, string>> {
          throw new Error("LLM unavailable");
        },
        async generateText(): Promise<string> { throw new Error("LLM unavailable"); },
      };

      const stats = await runIndexPass({
        cwd: workspaceDir,
        storePath: storeDir,
        config: testConfig(),
        store,
        embedder,
        descriptionProvider: failingProvider,
      });

      assert.equal(stats.newFiles, 1);
      assert.equal(stats.descriptionFailedFiles, 1);

      const manifest = await loadManifest(storeDir);
      const entry = manifest.manifest.files[normalizeFilePath(path.join(workspaceDir, "src", "fail.ts"))];
      assert.ok(entry);
      assert.equal(entry.descriptionFailed, true);
    });

    it("skips description generation for unchanged files with matching descHash", async () => {
      await writeFile(path.join(workspaceDir, "src", "skip.ts"), "function skipDesc() { return 1; }\n");

      let descCallCount = 0;
      const descProvider: DescriptionProvider = {
        async generateDescription(): Promise<string> {
          descCallCount++;
          return "A skip function.";
        },
        async generateBatchDescriptions(chunks: Chunk[]): Promise<Map<string, string>> {
          descCallCount += chunks.length;
          const result = new Map<string, string>();
          for (const chunk of chunks) {
            result.set(chunk.id, "A skip function.");
          }
          return result;
        },
        async generateText(): Promise<string> { return ""; },
      };

      // First pass: file is new, descriptions should be generated
      await runIndexPass({
        cwd: workspaceDir,
        storePath: storeDir,
        config: testConfig(),
        store,
        embedder,
        descriptionProvider: descProvider,
      });
      assert.ok(descCallCount > 0, "Descriptions should have been generated on first pass");

      // Check that descHash is stored in the manifest
      const manifestAfterFirst = await loadManifest(storeDir);
      const filePath = normalizeFilePath(path.join(workspaceDir, "src", "skip.ts"));
      const entry = manifestAfterFirst.manifest.files[filePath];
      assert.ok(entry, "File should be in manifest");
      assert.ok(entry.descHash, "descHash should be stored in manifest");

      // Record the call count so far
      const callsBeforeSecondPass = descCallCount;

      // Second pass: file content is unchanged, descriptions should be skipped
      const stats = await runIndexPass({
        cwd: workspaceDir,
        storePath: storeDir,
        config: testConfig(),
        store,
        embedder,
        descriptionProvider: descProvider,
      });

      assert.equal(stats.unchangedFiles, 1);
      // descCallCount should not have increased
      assert.equal(descCallCount, callsBeforeSecondPass, "Descriptions should not be re-generated for unchanged file");
    });

    it("reindexes description-failed files on the next run", async () => {
      const filePath = path.join(workspaceDir, "src", "retry.ts");
      await writeFile(filePath, "function retry() { return 1; }\n");

      // First run: description fails
      const failingProvider: DescriptionProvider = {
        async generateDescription(): Promise<string> {
          throw new Error("LLM unavailable");
        },
        async generateBatchDescriptions(): Promise<Map<string, string>> {
          throw new Error("LLM unavailable");
        },
        async generateText(): Promise<string> { throw new Error("LLM unavailable"); },
      };

      await runIndexPass({
        cwd: workspaceDir,
        storePath: storeDir,
        config: testConfig(),
        store,
        embedder,
        descriptionProvider: failingProvider,
      });

      const manifestAfterFail = await loadManifest(storeDir);
      assert.equal(manifestAfterFail.manifest.files[normalizeFilePath(filePath)]?.descriptionFailed, true);

      // Second run: description succeeds — file should be reindexed
      const successProvider: DescriptionProvider = {
        async generateDescription(): Promise<string> {
          return "A retry function.";
        },
        async generateBatchDescriptions(chunks: Chunk[]): Promise<Map<string, string>> {
          const result = new Map<string, string>();
          for (const chunk of chunks) {
            result.set(chunk.id, "A retry function.");
          }
          return result;
        },
        async generateText(): Promise<string> { return ""; },
      };

      const stats = await runIndexPass({
        cwd: workspaceDir,
        storePath: storeDir,
        config: testConfig(),
        store,
        embedder,
        descriptionProvider: successProvider,
      });

      // The file should have been treated as new (not unchanged) because it was cleared from manifest
      assert.equal(stats.newFiles, 1);
      assert.equal(stats.unchangedFiles, 0);
      assert.equal(stats.descriptionFailedFiles, 0);

      const manifestAfterSuccess = await loadManifest(storeDir);
      const entry = manifestAfterSuccess.manifest.files[normalizeFilePath(filePath)];
      assert.ok(entry);
      assert.notEqual(entry.descriptionFailed, true);
    });
  });

  it("reuses cached image description after Ctrl+C — vision LLM call is not repeated", async () => {
    const imgDir = path.join(workspaceDir, "assets");
    await fs.mkdir(imgDir, { recursive: true });
    const imgPath = path.join(imgDir, "screenshot.png");
    await fs.writeFile(imgPath, "fake-png-content");

    let visionCallCount = 0;
    const mockVisionProvider: ImageVisionProvider = {
      async describeImage(): Promise<string> {
        visionCallCount++;
        return "a blue login screen with email and password fields";
      },
    };

    const imgConfig: RagConfig = {
      ...testConfig(),
      indexing: {
        ...testConfig().indexing,
        includeExtensions: [".png", ".ts"],
      },
      imageDescription: {
        enabled: true,
        provider: "ollama",
        model: "minicpm-v4.6",
        baseUrl: "http://127.0.0.1:11434/api",
        timeoutMs: 60000,
        prompt: "Describe this image 10-20 comma-separated keywords.",
      },
    };

    const abortController = new AbortController();
    abortController.abort();

    await runIndexPass({
      cwd: workspaceDir,
      storePath: storeDir,
      config: imgConfig,
      store,
      embedder,
      abortSignal: abortController.signal,
      imageVisionProvider: mockVisionProvider,
    });

    const manifestAfterAbort = await loadManifest(storeDir);
    assert.equal(Object.keys(manifestAfterAbort.manifest.files).length, 0,
      "No manifest entries after aborted pass — nothing was stored");

    assert.equal(visionCallCount, 1, "Vision LLM should have been called once during scan");

    await runIndexPass({
      cwd: workspaceDir,
      storePath: storeDir,
      config: imgConfig,
      store,
      embedder,
      imageVisionProvider: mockVisionProvider,
    });

    // After the fix: image description is persisted to the description cache,
    // so the second run reuses the cached description without calling vision again.
    assert.equal(visionCallCount, 1,
      "Image description should be reused from cache — vision LLM should " +
      "NOT be called again on the second run after Ctrl+C");
  });

  it("excludes anchored dir paths and wildcard file patterns", async () => {
    // Create a workspace with excluded and non-excluded content
    await writeFile(path.join(workspaceDir, "good.ts"), "export const a = 1;\n");
    await writeFile(path.join(workspaceDir, "RequestPortal", ".config", "settings.ts"), "export const s = 1;\n");
    await writeFile(path.join(workspaceDir, "RequestPortal", "Migrations", "001.ts"), "export const m = 1;\n");
    await writeFile(path.join(workspaceDir, "src", "util.generated.ts"), "export const u = 1;\n");
    await writeFile(path.join(workspaceDir, "src", "util.ts"), "export const v = 1;\n");

    const cfg = testConfig();
    cfg.indexing.excludeDirs.push("RequestPortal/.config");
    cfg.indexing.excludeFiles = ["*.generated.ts"];

    const stats = await runIndexPass({
      cwd: workspaceDir,
      storePath: storeDir,
      config: cfg,
      store,
      embedder,
    });

    // good.ts, Migrations/001.ts, src/util.ts should be indexed (3 files)
    // RequestPortal/.config/settings.ts and src/util.generated.ts should be excluded
    assert.equal(stats.newFiles, 3);
    assert.equal(stats.finalCount, 3);

    const manifest = await loadManifest(storeDir);
    assert.equal(manifest.status, "ok");
    const filePaths = Object.keys(manifest.manifest.files);
    assert.ok(filePaths.some((p) => p.endsWith("good.ts")));
    assert.ok(filePaths.some((p) => p.endsWith("Migrations/001.ts") || p.endsWith("001.ts")));
    assert.ok(filePaths.some((p) => p.endsWith("src/util.ts") || p.endsWith("util.ts")));
    assert.ok(!filePaths.some((p) => p.endsWith("util.generated.ts")));
    assert.ok(!filePaths.some((p) => p.endsWith("settings.ts")));
  });
});
