/**
 * `opencode-rag clickhouse setup` tests.
 *
 * The pure config-merging helpers run everywhere. The end-to-end command test
 * is gated on CLICKHOUSE_TEST_* and uses OS temp dirs, so it works on Windows
 * and Linux alike.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeClickHouseUrl,
  mergeClickHouseConfig,
  promptHidden,
  runClickHouseSetup,
} from "../../cli/commands/clickhouse.js";

describe("mergeClickHouseConfig", () => {
  it("preserves unrelated keys and replaces a LanceDB path with the ClickHouse cache dir", () => {
    const merged = mergeClickHouseConfig(
      { embedding: { provider: "ollama", model: "x" }, vectorStore: { path: "./old_lance" } },
      {
        url: "http://pat06:8123",
        database: "OpenCodeRAG",
        username: "default",
        password: "secret",
        passwordEnv: "CH_PW",
        namespace: "proj",
        ann: "hnsw",
        storeInlinePassword: false,
      },
    );
    assert.deepEqual((merged.embedding as Record<string, unknown>).provider, "ollama");
    const vectorStore = merged.vectorStore as Record<string, unknown>;
    assert.equal(vectorStore.provider, "clickhouse");
    assert.equal(vectorStore.path, "./.opencode/rag_ch", "a LanceDB cache is not adopted");
    const clickhouse = vectorStore.clickhouse as Record<string, unknown>;
    assert.equal(clickhouse.url, "http://pat06:8123");
    assert.equal(clickhouse.namespace, "proj");
    assert.equal(clickhouse.ann, "hnsw");
    assert.equal(clickhouse.annFetchMultiplier, 4);
    assert.equal(clickhouse.annWithRescoring, true);
    assert.equal(clickhouse.passwordEnv, "CH_PW");
    assert.equal(clickhouse.password, undefined, "no plaintext password by default");
  });

  it("keeps an existing ClickHouse cache path and can store the password inline", () => {
    const merged = mergeClickHouseConfig(
      { vectorStore: { provider: "clickhouse", path: "./my_cache" } },
      {
        url: "http://localhost:8123",
        database: "OpenCodeRAG",
        username: "default",
        password: "secret",
        passwordEnv: "",
        namespace: "",
        ann: "off",
        storeInlinePassword: true,
      },
    );
    const vectorStore = merged.vectorStore as Record<string, unknown>;
    assert.equal(vectorStore.path, "./my_cache");
    const clickhouse = vectorStore.clickhouse as Record<string, unknown>;
    assert.equal(clickhouse.password, "secret");
    assert.equal(clickhouse.namespace, undefined, "blank namespace = derived per workspace");
    assert.equal(clickhouse.ann, "off");
  });
});

describe("composeClickHouseUrl", () => {
  it("applies an explicit port and strips the trailing slash", () => {
    assert.equal(composeClickHouseUrl("http://localhost:8123", "9000"), "http://localhost:9000");
    assert.equal(composeClickHouseUrl("https://ch.example.test", "8443"), "https://ch.example.test:8443");
  });

  it("keeps the URL port when the port answer is blank", () => {
    assert.equal(composeClickHouseUrl("http://ch.example.test:8123", ""), "http://ch.example.test:8123");
  });
});

describe("promptHidden", () => {
  it("mutes readline's output while the password is typed and restores it", async () => {
    const original = (): void => {};
    let wasMuted = false;
    const rl = {
      _writeToOutput: original,
      question: async (): Promise<string> => {
        wasMuted = rl._writeToOutput !== original;
        return "secret";
      },
    };
    const value = await promptHidden(rl as unknown as Parameters<typeof promptHidden>[0], "Password: ");
    assert.equal(value, "secret");
    assert.equal(wasMuted, true, "readline output must be muted during the prompt");
    assert.equal(rl._writeToOutput, original, "the original writer is restored");
  });
});

describe("clickhouse setup (live)", () => {
  const dirs: string[] = [];

  after(() => {
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it("writes a workspace config without initializing tables (--skip-init)", async (t) => {
    const url = process.env.CLICKHOUSE_TEST_URL;
    const password = process.env.CLICKHOUSE_TEST_PASSWORD;
    if (!url || !password) {
      return t.skip("CLICKHOUSE_TEST_URL / CLICKHOUSE_TEST_PASSWORD not set");
    }
    const dir = mkdtempSync(join(tmpdir(), "opencode-rag-chsetup-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "opencode-rag.json"),
      JSON.stringify({ embedding: { provider: "ollama", model: "keep-me" } }),
      "utf-8",
    );

    await runClickHouseSetup({
      cwd: dir,
      yes: true,
      skipInit: true,
      url,
      username: process.env.CLICKHOUSE_TEST_USER ?? "default",
      password,
      database: process.env.CLICKHOUSE_TEST_DATABASE ?? "OpenCodeRAG",
      namespace: "setup_test",
      ann: "off",
      dimension: "4",
      scope: "workspace",
      passwordEnv: "OPENCODERAG_CLICKHOUSE_PASSWORD",
      storePassword: false,
    });

    const written = JSON.parse(readFileSync(join(dir, "opencode-rag.json"), "utf-8")) as {
      embedding?: { model?: string };
      vectorStore?: { provider?: string; path?: string; clickhouse?: Record<string, unknown> };
    };
    assert.equal(written.embedding?.model, "keep-me", "unrelated config survives");
    assert.equal(written.vectorStore?.provider, "clickhouse");
    assert.equal(written.vectorStore?.path, "./.opencode/rag_ch");
    assert.equal(written.vectorStore?.clickhouse?.database, process.env.CLICKHOUSE_TEST_DATABASE ?? "OpenCodeRAG");
    assert.equal(written.vectorStore?.clickhouse?.username, process.env.CLICKHOUSE_TEST_USER ?? "default");
    assert.equal(written.vectorStore?.clickhouse?.namespace, "setup_test");
    assert.equal(written.vectorStore?.clickhouse?.ann, "off");
    assert.equal(written.vectorStore?.clickhouse?.password, undefined);
  });
});
