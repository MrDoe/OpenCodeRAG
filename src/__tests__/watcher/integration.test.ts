import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_CONFIG, type RagConfig } from "../../core/config.js";
import { LanceDbStore } from "../../vectorstore/lancedb.js";
import type { EmbeddingProvider } from "../../core/interfaces.js";
import { createBackgroundIndexer } from "../../watcher.js";

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
      excludeDirs: ["node_modules", ".git", ".opencode", "ignored-dir"],
      minFileSizeBytes: 0,
    },
    openCode: {
      ...DEFAULT_CONFIG.openCode,
      autoIndex: {
        enabled: true,
        debounceMs: 50,
        intervalMs: 100,
      },
    },
  };
}

describe("background indexer integration", () => {
  let workspaceDir: string;
  let storeDir: string;
  let logFilePath: string;
  let store: LanceDbStore;
  const embedder = new TestEmbedder();

  before(async () => {
    workspaceDir = await makeTempDir("watcher-workspace");
    storeDir = await makeTempDir("watcher-store");
    logFilePath = path.join(workspaceDir, "test.log");
    store = new LanceDbStore(storeDir, 4);
  });

  after(async () => {
    await store.close();
    // Clean up temp dirs
    try { await fs.rm(storeDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { await fs.rm(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("can start and gracefully close background indexer", { timeout: 120000 }, async () => {
    await writeFile(path.join(workspaceDir, "src", "a.ts"), "function alpha() { return 1; }\n");

    const indexer = createBackgroundIndexer({
      cwd: workspaceDir,
      storePath: storeDir,
      config: testConfig(),
      store,
      embedder,
      logFilePath,
    });

    // Let the initial pass start (generous delay under test load)
    await delay(500);

    // Verify the file was indexed before closing (assertion passes even
    // if close() is slow on Windows due to chokidar cleanup)
    assert.equal(await store.count(), 1);

    // Graceful shutdown — may be slow on Windows
    await indexer.close();
  });

  it("does not start a second watcher for the same workspace", { timeout: 120000 }, async () => {
    await writeFile(path.join(workspaceDir, "src", "a.ts"), "function alpha() { return 1; }\n");

    const indexerA = createBackgroundIndexer({
      cwd: workspaceDir,
      storePath: storeDir,
      config: testConfig(),
      store,
      embedder,
      logFilePath,
    });

    // A claims the watcher lock and becomes the active watcher.
    await delay(300);
    assert.equal(existsSync(path.join(storeDir, "watcher.lock")), true, "owner holds the watcher lock");

    const indexerB = createBackgroundIndexer({
      cwd: workspaceDir,
      storePath: storeDir,
      config: testConfig(),
      store,
      embedder,
      logFilePath,
    });
    await delay(300);

    // B is dormant — closing it must not disturb A's lock.
    await indexerB.close();
    assert.equal(existsSync(path.join(storeDir, "watcher.lock")), true, "dormant indexer must not release the owner's lock");

    // Only the owner releases the lock on close.
    await indexerA.close();
    assert.equal(existsSync(path.join(storeDir, "watcher.lock")), false, "owner releases the lock on close");
  });
});
