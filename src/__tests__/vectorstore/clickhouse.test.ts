/**
 * ClickHouse store tests.
 *
 * The part that needs a server is gated on `CLICKHOUSE_TEST_URL` /
 * `CLICKHOUSE_TEST_PASSWORD` and probes the real endpoint (the repo rule for
 * live-provider tests: probe capability, not liveness, and report a skip).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ClickHouseStore,
  deriveNamespace,
  resolveClickHouseOptions,
  sanitizeNamespace,
} from "../../vectorstore/clickhouse.js";
import { createVectorStore } from "../../vectorstore/factory.js";
import { LanceDbStore } from "../../vectorstore/lancedb.js";
import { DEFAULT_CONFIG, validateConfig, type RagConfig } from "../../core/config.js";
import { mergeQuirkJsonl } from "../../core/state-sync.js";

function makeConfig(mutate: (cfg: RagConfig) => void): RagConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  mutate(cfg);
  return cfg;
}

function clickhouseConfig(overrides: Partial<NonNullable<RagConfig["vectorStore"]["clickhouse"]>> = {}): RagConfig {
  return makeConfig((cfg) => {
    cfg.vectorStore.provider = "clickhouse";
    cfg.vectorStore.clickhouse = {
      ...cfg.vectorStore.clickhouse!,
      url: "http://example.test:8123",
      database: "OpenCodeRAG",
      username: "default",
      ...overrides,
    };
  });
}

describe("ClickHouse namespace helpers", () => {
  it("sanitizes namespaces to safe table suffixes", () => {
    assert.equal(sanitizeNamespace("my repo!"), "my_repo");
    assert.equal(sanitizeNamespace("  "), "default");
    assert.equal(sanitizeNamespace("a".repeat(60)).length, 40);
    assert.equal(sanitizeNamespace("OpenCodeRAG"), "OpenCodeRAG");
  });

  it("derives a stable namespace from the workspace path", () => {
    const a = deriveNamespace("C:/work/My Project");
    const b = deriveNamespace("C:/work/My Project");
    assert.equal(a, b);
    assert.match(a, /^My_Project_[0-9a-f]{8}$/);
    assert.notEqual(a, deriveNamespace("C:/work/Other"));
  });

  it("resolves table names, password env precedence and lease defaults", () => {
    const previous = process.env.OPENCODERAG_TEST_CH_PASSWORD;
    process.env.OPENCODERAG_TEST_CH_PASSWORD = "from-env";
    try {
      const cfg = clickhouseConfig({
        namespace: "proj",
        password: "inline",
        passwordEnv: "OPENCODERAG_TEST_CH_PASSWORD",
      });
      const options = resolveClickHouseOptions(cfg, "C:/work/ignored");
      assert.equal(options.namespace, "proj");
      assert.equal(options.chunksTable, "chunks_proj");
      assert.equal(options.stateTable, "state_proj");
      assert.equal(options.password, "from-env");
      assert.equal(options.ann, "off");
      assert.equal(options.leaseTtlMs, 90_000);
      assert.equal(options.database, "OpenCodeRAG");
    } finally {
      if (previous === undefined) delete process.env.OPENCODERAG_TEST_CH_PASSWORD;
      else process.env.OPENCODERAG_TEST_CH_PASSWORD = previous;
    }
  });

  it("falls back to a derived namespace when none is configured", () => {
    const cfg = clickhouseConfig({ namespace: "" });
    const options = resolveClickHouseOptions(cfg, "C:/work/Demo Repo");
    assert.match(options.namespace, /^Demo_Repo_[0-9a-f]{8}$/);
    assert.equal(options.chunksTable, `chunks_${options.namespace}`);
  });
});

describe("ClickHouse config validation", () => {
  it("accepts a valid block", () => {
    const warnings = validateConfig(clickhouseConfig({ namespace: "proj" })).warnings
      .filter((w) => w.includes("clickhouse"));
    assert.deepEqual(warnings, []);
  });

  it("accepts hnsw on modern servers and warns about plaintext passwords", () => {
    const cfg = clickhouseConfig({ ann: "hnsw", password: "secret", passwordEnv: "" });
    const warnings = validateConfig(cfg).warnings.join("\n");
    assert.doesNotMatch(warnings, /ann = "hnsw"/);
    assert.match(warnings, /password is stored in plaintext/);
  });

  it("rejects an out-of-range ANN fetch multiplier", () => {
    const cfg = clickhouseConfig({ ann: "hnsw", annFetchMultiplier: 0 });
    assert.match(
      validateConfig(cfg).warnings.join("\n"),
      /annFetchMultiplier must be between 1 and 1000/,
    );
  });

  it("rejects invalid namespaces and URLs", () => {
    const cfg = clickhouseConfig({ namespace: "bad name!", url: "not a url" });
    const warnings = validateConfig(cfg).warnings.join("\n");
    assert.match(warnings, /namespace may only contain/);
    assert.match(warnings, /url "not a url" is not a valid URL/);
  });
});

describe("createVectorStore with clickhouse", () => {
  it("returns a ClickHouseStore and keeps LanceDB as the default", () => {
    const cfg = clickhouseConfig({ namespace: "proj" });
    const store = createVectorStore(cfg, "C:/tmp/cache", 8, "C:/work");
    assert.ok(store instanceof ClickHouseStore);
    assert.equal((store as ClickHouseStore).constructor.name, "ClickHouseStore");

    const defaultStore = createVectorStore(makeConfig(() => {}), "memory://", 8);
    assert.ok(defaultStore instanceof LanceDbStore);
  });
});

describe("StateSync quirk merge", () => {
  it("keeps the later record per id and sorts by id", () => {
    const remote = [
      JSON.stringify({ id: "quirk:a", content: "old", lastObserved: "2026-01-01T00:00:00Z" }),
      JSON.stringify({ id: "quirk:b", content: "remote-only", lastObserved: "2026-01-01T00:00:00Z" }),
    ].join("\n");
    const local = [
      JSON.stringify({ id: "quirk:a", content: "new", lastObserved: "2026-02-01T00:00:00Z" }),
      "not json",
    ].join("\n");

    const merged = mergeQuirkJsonl(local, remote);
    const records = merged.trim().split("\n").map((line) => JSON.parse(line) as { id: string; content: string });
    assert.deepEqual(records.map((r) => r.id), ["quirk:a", "quirk:b"]);
    assert.equal(records[0]!.content, "new");
    assert.equal(records[1]!.content, "remote-only");
  });

  it("returns an empty string for two empty logs", () => {
    assert.equal(mergeQuirkJsonl("", ""), "");
  });
});

describe("ClickHouse integration", () => {  it("stores, searches, rebuilds and deletes against a real server", async (t) => {
    const url = process.env.CLICKHOUSE_TEST_URL;
    const password = process.env.CLICKHOUSE_TEST_PASSWORD;
    if (!url || !password) {
      return t.skip("CLICKHOUSE_TEST_URL / CLICKHOUSE_TEST_PASSWORD not set");
    }
    const namespace = `test_${Date.now().toString(36)}`;
    const cfg = clickhouseConfig({
      url,
      username: process.env.CLICKHOUSE_TEST_USER ?? "default",
      password,
      passwordEnv: "",
      namespace,
      database: process.env.CLICKHOUSE_TEST_DATABASE ?? "OpenCodeRAG",
    });
    const options = resolveClickHouseOptions(cfg, "C:/work/test");
    const store = new ClickHouseStore(options, 3);

    const makeChunk = (path: string, embedding: number[], content: string) => ({
      id: `c${Math.random().toString(36).slice(2)}`,
      content,
      description: "",
      embedding,
      metadata: { filePath: path, startLine: 1, endLine: 2, language: "ts", kind: "", role: "source" as const },
    });

    try {
      // Capability probe: a real write+read through the store itself.
      await store.addChunks([
        makeChunk("C:/work/test/a.ts", [1, 0, 0], "alpha"),
        makeChunk("C:/work/test/a.ts", [0.9, 0.1, 0], "alpha-two"),
        makeChunk("C:/work/test/b.ts", [0, 1, 0], "beta"),
      ]);
      assert.equal(await store.count(), 3);
      assert.equal(await store.getVectorDimension(), 3);

      const results = await store.search([1, 0, 0], 2);
      assert.equal(results.length, 2);
      assert.ok(results[0]!.score >= results[1]!.score);
      assert.ok(results[0]!.score > 0.99);

      // Filter parity: a language that does not exist returns nothing.
      assert.equal((await store.searchWithFilter([1, 0, 0], 2, { languages: ["python"] })).length, 0);

      // Dedup: replacing one chunk removes the other revision.
      await store.addChunks([makeChunk("C:/work/test/a.ts", [1, 0, 0], "replacement")]);
      assert.equal(await store.count(), 2);

      // Epoch rebuild: write to a private epoch, nothing visible until promotion.
      const target = await store.beginRebuild();
      await target.addChunks([makeChunk("C:/work/test/c.ts", [0, 0, 1], "epoch-two")], { dedup: false });
      assert.equal(await store.count(), 2);
      await store.promoteRebuild();
      assert.equal(await store.count(), 1);
      assert.deepEqual((await store.search([0, 0, 1], 1)).map((r) => r.chunk.content), ["epoch-two"]);

      // Lease: the second owner is refused while the first holds it.
      assert.equal(await store.acquireLease("owner-a", "index", 30_000), true);
      assert.equal(await store.acquireLease("owner-b", "index", 30_000), false);
      await store.releaseLease("owner-a", "index");

      // Delete + clear.
      await store.deleteByFilePath("C:/work/test/c.ts");
      assert.equal(await store.count(), 0);

      // Dimension change: a handle with a different dimension must refuse
      // normal writes, but a rebuild target may build the new epoch and
      // promote the new dimension into `_meta`.
      const upgraded = new ClickHouseStore(options, 4);
      await assert.rejects(
        () => upgraded.addChunks([{
          id: "dim4-direct",
          content: "nope",
          description: "",
          embedding: [1, 0, 0, 0],
          metadata: { filePath: "C:/work/test/d.ts", startLine: 1, endLine: 1, language: "ts" },
        }]),
        /vector dimension/i,
      );
      const upgradedTarget = await upgraded.beginRebuild();
      await upgradedTarget.addChunks([{
        id: "dim4",
        content: "four",
        description: "",
        embedding: [1, 0, 0, 0],
        metadata: { filePath: "C:/work/test/d.ts", startLine: 1, endLine: 1, language: "ts" },
      }], { dedup: false });
      await upgraded.promoteRebuild();
      assert.equal(await upgraded.getVectorDimension(), 4);
      assert.equal(await upgraded.count(), 1);
      assert.equal((await upgraded.search([1, 0, 0, 0], 1))[0]!.chunk.content, "four");
      await upgraded.close();
    } finally {
      try {
        await store.dropProjectTables();
      } catch {
        // cleanup is best effort
      }
      await store.close();
    }
  });

  it("builds and uses the HNSW index when ann is 'hnsw'", async (t) => {
    const url = process.env.CLICKHOUSE_TEST_URL;
    const password = process.env.CLICKHOUSE_TEST_PASSWORD;
    if (!url || !password) {
      return t.skip("CLICKHOUSE_TEST_URL / CLICKHOUSE_TEST_PASSWORD not set");
    }
    const namespace = `anntest_${Date.now().toString(36)}`;
    const cfg = clickhouseConfig({
      url,
      username: process.env.CLICKHOUSE_TEST_USER ?? "default",
      password,
      passwordEnv: "",
      namespace,
      database: process.env.CLICKHOUSE_TEST_DATABASE ?? "OpenCodeRAG",
      ann: "hnsw",
    });
    const options = resolveClickHouseOptions(cfg, "C:/work/ann");
    const store = new ClickHouseStore(options, 4);

    const makeChunk = (path: string, id: string, embedding: number[], content: string) => ({
      id,
      content,
      description: "",
      embedding,
      metadata: { filePath: path, startLine: 1, endLine: 1, language: "ts" },
    });

    try {
      const rows = [];
      for (let i = 0; i < 8; i++) {
        rows.push(makeChunk("C:/work/ann/a.ts", `a${i}`, [1, i / 100, 0, 0], `alpha ${i}`));
      }
      rows.push(makeChunk("C:/work/ann/b.ts", "b0", [0, 1, 0, 0], "beta 0"));
      rows.push(makeChunk("C:/work/ann/b.ts", "b1", [0, 0.9, 0.1, 0], "beta 1"));
      await store.addChunks(rows);
      assert.equal(await store.count(), 10);
      assert.equal(await store.hasVectorIndex(), true, "the HNSW index must exist");

      const top = await store.search([1, 0, 0, 0], 3);
      assert.equal(top.length, 3);
      assert.ok(top.every((r) => r.chunk.metadata.filePath.endsWith("a.ts")));

      // Replacing a file writes tombstones. They must carry the superseded
      // row's vector: ClickHouse rejects empty arrays in an indexed column.
      await store.addChunks([makeChunk("C:/work/ann/a.ts", "a-new", [1, 0, 0, 0], "alpha new")]);
      assert.equal(await store.count(), 3);

      const filtered = await store.searchWithFilter([1, 0, 0, 0], 2, { languages: ["ts"], kinds: [""] });
      assert.equal(filtered.length, 2);

      await store.deleteByFilePath("C:/work/ann/b.ts");
      assert.equal(await store.count(), 1);
    } finally {
      try {
        await store.dropProjectTables();
      } catch {
        // cleanup is best effort
      }
      await store.close();
    }
  });
});
