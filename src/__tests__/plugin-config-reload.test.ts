import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLiveEmbedder, getConfig, refreshConfig } from "../plugin.js";
import { DEFAULT_CONFIG, type RagConfig } from "../core/config.js";
import type { EmbeddingProvider } from "../core/interfaces.js";

/**
 * Isolate from the machine's global config
 * (`$XDG_CONFIG_HOME/opencode/opencode-rag.json`).
 *
 * These tests assert workspace-layer behaviour: a real global file would be
 * merged under every temp workspace and make the results machine-dependent.
 */
let isolatedXdg: string | undefined;
let previousXdg: string | undefined;
before(() => {
  previousXdg = process.env.XDG_CONFIG_HOME;
  isolatedXdg = mkdtempSync(path.join(tmpdir(), "opencode-rag-no-global-"));
  process.env.XDG_CONFIG_HOME = isolatedXdg;
});
after(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  if (isolatedXdg) rmSync(isolatedXdg, { recursive: true, force: true });
});

/**
 * Write a config file and force a distinct mtime.
 *
 * Two writes in the same millisecond can share an mtime, which would make the
 * "file changed" check miss the edit — the mtime is pushed forward explicitly
 * so the test is deterministic.
 */
function writeConfig(dir: string, apiKey: string, bumpSeconds: number): void {
  const file = path.join(dir, "opencode-rag.json");
  writeFileSync(
    file,
    JSON.stringify({
      embedding: {
        provider: "openai",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "jina-code-embeddings-0.5b",
        apiKey,
        vectorDimension: 896,
      },
    }),
  );
  const future = new Date(Date.now() + bumpSeconds * 1000);
  utimesSync(file, future, future);
}

/** Config with a distinctive embedding key, used as the no-file fallback. */
function makeConfig(apiKey: string): RagConfig {
  return {
    ...DEFAULT_CONFIG,
    embedding: { ...DEFAULT_CONFIG.embedding, provider: "openai", apiKey },
  };
}

/** Minimal embedding provider that records the key it was built with. */
function makeProvider(apiKey: string): EmbeddingProvider {
  return {
    name: `provider:${apiKey}`,
    async embed(): Promise<number[][]> {
      return [[0.1, 0.2, 0.3]];
    },
  };
}

describe("refreshConfig", () => {
  it("re-reads the config file when it changed on disk", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-rag-refresh-"));
    try {
      writeConfig(dir, "key-1", 0);
      const fallback = makeConfig("fallback");

      // Loading the workspace config is what makes the file the source of
      // truth for it — only then is it refreshed.
      await getConfig(dir);
      const first = refreshConfig(dir, fallback);
      assert.equal(first.embedding.apiKey, "key-1");

      // The file is unchanged — the cached config is served.
      assert.equal(refreshConfig(dir, fallback), first);

      // Edit the file (mtime pushed forward) — the new value must be picked up.
      writeConfig(dir, "key-2", 10);
      const second = refreshConfig(dir, fallback);
      assert.equal(second.embedding.apiKey, "key-2");
      assert.notEqual(second, first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the caller's config when the workspace was never loaded from a file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-rag-nofile-"));
    try {
      // A config file exists, but this module never loaded it for that
      // workspace — the caller's own config stays authoritative.
      writeConfig(dir, "key-1", 0);
      const fallback = makeConfig("fallback");
      assert.equal(refreshConfig(dir, fallback), fallback);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the previous config when the file becomes invalid", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-rag-broken-"));
    try {
      writeConfig(dir, "key-1", 0);
      await getConfig(dir);
      const first = refreshConfig(dir, makeConfig("fallback"));
      assert.equal(first.embedding.apiKey, "key-1");

      const file = path.join(dir, "opencode-rag.json");
      writeFileSync(file, "{ not json");
      const future = new Date(Date.now() + 10_000);
      utimesSync(file, future, future);

      // A broken file must not wipe the working config.
      assert.equal(refreshConfig(dir, makeConfig("fallback")).embedding.apiKey, "key-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the last known config when the file is removed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-rag-removed-"));
    try {
      writeConfig(dir, "key-1", 0);
      await getConfig(dir);
      assert.equal(refreshConfig(dir, makeConfig("fallback")).embedding.apiKey, "key-1");

      rmSync(path.join(dir, "opencode-rag.json"));
      assert.equal(refreshConfig(dir, makeConfig("fallback")).embedding.apiKey, "key-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createLiveEmbedder", () => {
  it("rebuilds the provider when the embedding config changes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-rag-live-"));
    try {
      writeConfig(dir, "key-1", 0);
      await getConfig(dir);

      const built: string[] = [];
      const embedder = createLiveEmbedder(
        () => refreshConfig(dir, makeConfig("fallback")),
        (cfg) => {
          built.push(cfg.embedding.apiKey ?? "");
          return makeProvider(cfg.embedding.apiKey ?? "");
        },
      );

      // The provider is created eagerly and used until the config changes.
      assert.deepStrictEqual(built, ["key-1"]);
      assert.equal(embedder.name, "provider:key-1");
      await embedder.embed(["probe"]);
      assert.deepStrictEqual(built, ["key-1"], "no rebuild while the config is unchanged");

      // Edit the config — the next embed must use a provider built from it.
      writeConfig(dir, "key-2", 10);
      await embedder.embed(["probe"]);
      assert.deepStrictEqual(built, ["key-1", "key-2"]);
      assert.equal(embedder.name, "provider:key-2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps using the injected provider until the config changes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-rag-injected-"));
    try {
      writeConfig(dir, "key-1", 0);
      await getConfig(dir);

      const built: string[] = [];
      const embedder = createLiveEmbedder(
        () => refreshConfig(dir, makeConfig("fallback")),
        (cfg) => {
          built.push(cfg.embedding.apiKey ?? "");
          return makeProvider(cfg.embedding.apiKey ?? "");
        },
        makeProvider("injected"),
      );

      // The injected provider wins until the config actually changes.
      assert.deepStrictEqual(built, [], "no provider is built while the injected one is valid");
      assert.equal(embedder.name, "provider:injected");
      await embedder.embed(["probe"]);
      assert.deepStrictEqual(built, []);

      writeConfig(dir, "key-2", 10);
      await embedder.embed(["probe"]);
      assert.deepStrictEqual(built, ["key-2"]);
      assert.equal(embedder.name, "provider:key-2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores config changes that do not affect the embedding provider", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-rag-irrelevant-"));
    try {
      writeConfig(dir, "key-1", 0);
      await getConfig(dir);

      let cfg = refreshConfig(dir, makeConfig("fallback"));
      const built: string[] = [];
      const embedder = createLiveEmbedder(
        () => cfg,
        (c) => {
          built.push(c.embedding.apiKey ?? "");
          return makeProvider(c.embedding.apiKey ?? "");
        },
      );

      await embedder.embed(["probe"]);
      assert.deepStrictEqual(built, ["key-1"]);

      // A retrieval-only change must not rebuild the embedding provider.
      cfg = { ...cfg, retrieval: { ...cfg.retrieval, topK: 42 } };
      await embedder.embed(["probe"]);
      assert.deepStrictEqual(built, ["key-1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
