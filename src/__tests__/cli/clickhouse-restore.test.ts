import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeClickHouseRestore } from "../../cli/commands/clickhouse.js";
import { DEFAULT_CONFIG, type RagConfig } from "../../core/config.js";
import { DescriptionCache } from "../../core/desc-cache.js";
import { computeDescriptionConfigHash } from "../../core/manifest.js";

function testConfig(): RagConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.vectorStore.provider = "clickhouse";
  cfg.vectorStore.clickhouse = {
    url: "http://clickhouse.example:8123",
    database: "OpenCodeRAG",
    username: "default",
    namespace: "testproj",
  };
  return cfg;
}

describe("executeClickHouseRestore (isolated)", () => {
  it("restores description cache from chunks table into .desc-cache.json", async () => {
    const testDir = mkdtempSync(path.join(os.tmpdir(), "ch-restore-desc-"));
    const cfg = testConfig();

    const mockRows = [
      {
        file_path: "src/a.ts",
        start_line: 1,
        end_line: 10,
        content: "function hello() { return 'world'; }",
        description: "Returns greeting string.",
      },
      {
        file_path: "src/b.ts",
        start_line: 20,
        end_line: 35,
        content: "function add(x, y) { return x + y; }",
        description: "Adds two numbers together.",
      },
    ];

    const run = async <R>(sql: string): Promise<R[]> => {
      if (sql.includes("name = '_meta'")) {
        return [{ data: JSON.stringify({ activeEpoch: 2 }) }] as R[];
      }
      if (sql.includes("FROM OpenCodeRAG.chunks_testproj FINAL")) {
        return mockRows as unknown as R[];
      }
      return [] as R[];
    };

    try {
      const res = await executeClickHouseRestore(
        run,
        { cache: true },
        cfg,
        testDir,
        "testproj",
        testDir,
      );

      assert.equal(res.cacheEntries, 2);

      const cache = new DescriptionCache(testDir);
      await cache.load();
      const descHash = computeDescriptionConfigHash(cfg) ?? "";

      const keyA = DescriptionCache.codeKey(mockRows[0]!.content, descHash, `${path.join(testDir, "src", "a.ts")}:1-10`);
      const keyB = DescriptionCache.codeKey(mockRows[1]!.content, descHash, `${path.join(testDir, "src", "b.ts")}:20-35`);

      assert.equal(cache.get(keyA), "Returns greeting string.");
      assert.equal(cache.get(keyB), "Adds two numbers together.");
    } finally {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  it("restores manifest from state table", async () => {
    const testDir = mkdtempSync(path.join(os.tmpdir(), "ch-restore-manifest-"));
    const cfg = testConfig();

    const remoteManifest = {
      schemaVersion: 3,
      lastIndexedAt: 1700000000000,
      files: {
        "src/main.ts": { hash: "abc1", chunkCount: 3, indexedAt: 1700000000000 },
        "src/util.ts": { hash: "def2", chunkCount: 1, indexedAt: 1700000000000 },
      },
    };

    const run = async <R>(sql: string): Promise<R[]> => {
      if (sql.includes("name = '_meta'")) {
        return [{ data: JSON.stringify({ activeEpoch: 1 }) }] as R[];
      }
      if (sql.includes("name = 'manifest'")) {
        return [{ data: JSON.stringify(remoteManifest) }] as R[];
      }
      return [] as R[];
    };

    try {
      const res = await executeClickHouseRestore(
        run,
        { manifest: true },
        cfg,
        testDir,
        "testproj",
        testDir,
      );

      assert.equal(res.manifestFiles, 2);
      const saved = JSON.parse(await fs.readFile(path.join(testDir, "manifest.json"), "utf-8"));
      assert.equal(saved.files["src/main.ts"].chunkCount, 3);
      assert.equal(saved.files["src/util.ts"].hash, "def2");
    } finally {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  it("reconstructs manifest from chunks when forced or state row missing", async () => {
    const testDir = mkdtempSync(path.join(os.tmpdir(), "ch-restore-recon-"));
    const cfg = testConfig();

    // Create a dummy local file
    await fs.mkdir(path.join(testDir, "src"), { recursive: true });
    await fs.writeFile(path.join(testDir, "src", "code.ts"), "const x = 42;", "utf-8");

    const chunkSummary = [
      {
        file_path: "src/code.ts",
        chunk_count: 5,
        last_indexed: "2026-11-20 10:00:00",
      },
    ];

    const run = async <R>(sql: string): Promise<R[]> => {
      if (sql.includes("name = '_meta'")) {
        return [{ data: JSON.stringify({ activeEpoch: 1 }) }] as R[];
      }
      if (sql.includes("GROUP BY file_path")) {
        return chunkSummary as unknown as R[];
      }
      return [] as R[];
    };

    try {
      const res = await executeClickHouseRestore(
        run,
        { manifest: true, reconstructManifest: true },
        cfg,
        testDir,
        "testproj",
        testDir,
      );

      assert.equal(res.manifestFiles, 1);
      const saved = JSON.parse(await fs.readFile(path.join(testDir, "manifest.json"), "utf-8"));
      assert.ok(saved.files["src/code.ts"]);
      assert.equal(saved.files["src/code.ts"].chunkCount, 5);
      assert.ok(saved.files["src/code.ts"].hash.length > 0);
    } finally {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  it("restores quirks from state table", async () => {
    const testDir = mkdtempSync(path.join(os.tmpdir(), "ch-restore-quirks-"));
    const cfg = testConfig();

    const quirkLines = [
      JSON.stringify({ id: "quirk:1", content: "quirk one" }),
      JSON.stringify({ id: "quirk:2", content: "quirk two" }),
    ].join("\n") + "\n";

    const run = async <R>(sql: string): Promise<R[]> => {
      if (sql.includes("name = '_meta'")) {
        return [{ data: JSON.stringify({ activeEpoch: 1 }) }] as R[];
      }
      if (sql.includes("name = 'quirks'")) {
        return [{ data: quirkLines }] as R[];
      }
      return [] as R[];
    };

    try {
      const res = await executeClickHouseRestore(
        run,
        { quirks: true },
        cfg,
        testDir,
        "testproj",
        testDir,
      );

      assert.equal(res.quirksCount, 2);
      const content = await fs.readFile(path.join(testDir, "quirks.jsonl"), "utf-8");
      assert.match(content, /quirk:1/);
      assert.match(content, /quirk:2/);
    } finally {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });
});
