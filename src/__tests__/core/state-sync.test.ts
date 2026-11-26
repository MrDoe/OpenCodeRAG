/**
 * StateSync merge/flush regression: a merged quirk log must be uploaded, not
 * recorded as synced before the upload (which left the remote row stale).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { StateSync, mergeQuirkJsonl, mergeManifestJson } from "../../core/state-sync.js";
import { DEFAULT_CONFIG, type RagConfig } from "../../core/config.js";
import type { VectorStore } from "../../core/interfaces.js";

function clickhouseConfig(): RagConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.vectorStore.provider = "clickhouse";
  cfg.vectorStore.clickhouse = {
    ...cfg.vectorStore.clickhouse!,
    url: "http://clickhouse.example:8123",
    database: "OpenCodeRAG",
    username: "default",
  };
  return cfg;
}

describe("StateSync hydrate/flush", () => {
  it("does not hydrate or flush the keyword index when hybrid search is disabled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-rag-state-sync-"));
    const reads: string[] = [];
    const writes: string[] = [];
    const store = {
      readState: async (name: string) => {
        reads.push(name);
        return name === "keyword-index" ? { data: "remote-keywords", ver: "1" } : undefined;
      },
      writeState: async (name: string) => { writes.push(name); },
    } as unknown as VectorStore;

    try {
      const config = clickhouseConfig();
      config.retrieval.hybridSearch!.enabled = false;
      fs.writeFileSync(path.join(dir, "keyword-index.json"), "local-keywords", "utf-8");

      const sync = new StateSync({ store, storePath: dir, config });
      await sync.hydrate();
      await sync.flush(["keyword-index"]);
      await sync.flush();

      assert.ok(!reads.includes("keyword-index"), "keyword index must not be downloaded");
      assert.ok(!writes.includes("keyword-index"), "keyword index must not be uploaded");
      assert.equal(fs.readFileSync(path.join(dir, "keyword-index.json"), "utf-8"), "local-keywords");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uploads a merged quirk log and keeps the merged records on the next hydrate", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-rag-state-sync-"));
    const remote = new Map<string, string>();
    remote.set(
      "quirks",
      `${JSON.stringify({ id: "quirk:a", content: "old", lastObserved: "2026-01-01T00:00:00Z" })}\n`,
    );
    let written: { name: string; data: string } | undefined;
    const store = {
      readState: async (name: string) =>
        remote.has(name) ? { data: remote.get(name)!, ver: "1" } : undefined,
      writeState: async (name: string, data: string) => {
        written = { name, data };
        remote.set(name, data);
      },
    } as unknown as VectorStore;

    try {
      fs.writeFileSync(
        path.join(dir, "quirks.jsonl"),
        [
          JSON.stringify({ id: "quirk:a", content: "new", lastObserved: "2026-02-01T00:00:00Z" }),
          JSON.stringify({ id: "quirk:b", content: "local-only", lastObserved: "2026-02-01T00:00:00Z" }),
        ].join("\n") + "\n",
        "utf-8",
      );

      const sync = new StateSync({ store, storePath: dir, config: clickhouseConfig() });
      await sync.hydrate();
      assert.ok(written, "the merged log must be uploaded during hydrate");
      assert.equal(written!.name, "quirks");
      assert.match(written!.data, /quirk:b/);
      assert.match(written!.data, /"content":"new"/);

      // A second hydrate must see local == remote and not overwrite the local
      // file with a stale remote copy.
      written = undefined;
      await sync.hydrate();
      assert.equal(written, undefined, "no upload is needed once both sides match");
      const local = fs.readFileSync(path.join(dir, "quirks.jsonl"), "utf-8");
      assert.match(local, /quirk:b/);
      assert.match(local, /"content":"new"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks an unmergeable local conflict dirty so the next flush uploads it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-rag-state-sync-"));
    const local = '{"local":true}';
    const remote = '{"remote":true}';
    const writes: string[] = [];
    const store = {
      readState: async () => ({ data: remote, ver: "2" }),
      writeState: async (_name: string, data: string) => { writes.push(data); },
    } as unknown as VectorStore;

    try {
      fs.writeFileSync(path.join(dir, "keyword-index.json"), local, "utf-8");
      fs.writeFileSync(
        path.join(dir, ".state-sync.json"),
        JSON.stringify({ "keyword-index": { sha256: createHash("sha256").update("previous-base").digest("hex") } }),
        "utf-8",
      );

      const sync = new StateSync({ store, storePath: dir, config: clickhouseConfig() });
      await sync.hydrate();
      await sync.flush(["keyword-index"]);

      assert.deepEqual(writes, [local]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges the manifest as JSON instead of wiping it (hydrate dispatches by state name)", async () => {
    // Regression: hydrate() routed every `merge: true` state through
    // mergeQuirkJsonl, which parses JSONL. Applied to the manifest (a JSON
    // object) it returned an empty string and truncated the file to 0 bytes,
    // making the next index pass treat all files as new and re-describe them.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-rag-state-sync-"));
    const remoteManifest = JSON.stringify({
      schemaVersion: 3,
      lastIndexedAt: 1,
      // Absolute path outside the workspace root, so the scope filter keeps it.
      files: { "/other-tree/remote-only.ts": { hash: "r", chunkCount: 1, indexedAt: 1, descHash: "aaa" } },
    });
    const remote = new Map<string, string>([["manifest", remoteManifest]]);
    const store = {
      readState: async (name: string) =>
        remote.has(name) ? { data: remote.get(name)!, ver: "1" } : undefined,
      writeState: async (name: string, data: string) => { remote.set(name, data); },
    } as unknown as VectorStore;

    try {
      // Local manifest differs from the remote, so hydrate takes the merge path.
      fs.writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({
          schemaVersion: 3,
          lastIndexedAt: 2,
          files: { "local.ts": { hash: "l", chunkCount: 2, indexedAt: 2, descHash: "bbb" } },
        }),
        "utf-8",
      );

      const sync = new StateSync({
        store, storePath: dir, config: clickhouseConfig(), cwd: os.tmpdir(),
      });
      await sync.hydrate();

      const merged = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8"));
      assert.ok(merged.files["local.ts"], "local entry survives the merge");
      assert.ok(merged.files["/other-tree/remote-only.ts"], "remote entry outside the scope survives");
      assert.equal(merged.lastIndexedAt, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propagates a local deletion tombstone instead of resurrecting the remote record", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-rag-state-sync-"));
    const remote = new Map<string, string>();
    remote.set(
      "quirks",
      [
        JSON.stringify({ id: "quirk:a", content: "live", lastObserved: "2026-01-01T00:00:00Z" }),
        JSON.stringify({ id: "quirk:b", content: "keep", lastObserved: "2026-01-01T00:00:00Z" }),
      ].join("\n") + "\n",
    );
    let written: string | undefined;
    const store = {
      readState: async (name: string) =>
        remote.has(name) ? { data: remote.get(name)!, ver: "1" } : undefined,
      writeState: async (name: string, data: string) => {
        if (name === "quirks") written = data;
        remote.set(name, data);
      },
    } as unknown as VectorStore;

    try {
      fs.writeFileSync(
        path.join(dir, "quirks.jsonl"),
        [
          // The deletion: same id, newer lastObserved, deletedAt set.
          JSON.stringify({ id: "quirk:a", content: "live", lastObserved: "2026-03-01T00:00:00Z", deletedAt: "2026-03-01T00:00:00Z" }),
          JSON.stringify({ id: "quirk:b", content: "keep", lastObserved: "2026-01-01T00:00:00Z" }),
        ].join("\n") + "\n",
        "utf-8",
      );

      const sync = new StateSync({ store, storePath: dir, config: clickhouseConfig() });
      await sync.hydrate();

      assert.ok(written, "hydrate must upload the merged log");
      assert.match(written!, /"deletedAt"/, "the tombstone must win the union");
      const local = fs.readFileSync(path.join(dir, "quirks.jsonl"), "utf-8");
      assert.match(local, /"deletedAt"/, "the local file keeps the tombstone");
      assert.doesNotMatch(
        local,
        /"content":"live","lastObserved":"2026-01-01/,
        "the older remote copy must not replace the tombstone",
      );
      assert.match(local, /quirk:b/, "unrelated records survive the merge");

      // Deleting twice must stay deleted: a second hydrate finds both sides equal.
      written = undefined;
      await sync.hydrate();
      assert.equal(written, undefined, "no upload once both sides agree");
      assert.match(fs.readFileSync(path.join(dir, "quirks.jsonl"), "utf-8"), /"deletedAt"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies a remote tombstone to a local live record", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-rag-state-sync-"));
    const remote = new Map<string, string>();
    remote.set(
      "quirks",
      `${JSON.stringify({ id: "quirk:a", content: "live", lastObserved: "2026-03-01T00:00:00Z", deletedAt: "2026-03-01T00:00:00Z" })}\n`,
    );
    const store = {
      readState: async (name: string) =>
        remote.has(name) ? { data: remote.get(name)!, ver: "1" } : undefined,
      writeState: async (name: string, data: string) => {
        remote.set(name, data);
      },
    } as unknown as VectorStore;

    try {
      // A stale machine still holds the live record and has never synced.
      fs.writeFileSync(
        path.join(dir, "quirks.jsonl"),
        `${JSON.stringify({ id: "quirk:a", content: "live", lastObserved: "2026-01-01T00:00:00Z" })}\n`,
        "utf-8",
      );

      const sync = new StateSync({ store, storePath: dir, config: clickhouseConfig() });
      await sync.hydrate();

      assert.match(
        fs.readFileSync(path.join(dir, "quirks.jsonl"), "utf-8"),
        /"deletedAt"/,
        "the remote deletion must win over the stale local record",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps mergeQuirkJsonl a fixpoint, tombstones final, and the local copy winning live ties", () => {
    const tombstone = JSON.stringify({ id: "quirk:a", content: "x", lastObserved: "2026-03-01T00:00:00Z", deletedAt: "2026-03-01T00:00:00Z" });
    const live = JSON.stringify({ id: "quirk:a", content: "x", lastObserved: "2026-03-01T00:00:00Z" });
    const other = JSON.stringify({ id: "quirk:b", content: "y", lastObserved: "2026-01-01T00:00:00Z" });
    const merged = mergeQuirkJsonl(`${tombstone}\n${other}\n`, `${live}\n`);

    assert.equal(mergeQuirkJsonl(merged, merged), merged, "merge must be a fixpoint");
    assert.match(merged, /"deletedAt"/, "a tombstone wins a timestamp tie against a live record");
    assert.match(merged, /quirk:b/);

    // A tombstone is final even against a *newer* live copy (ids are never reused).
    const newerLive = JSON.stringify({ id: "quirk:a", content: "x", lastObserved: "2026-09-01T00:00:00Z" });
    assert.match(
      mergeQuirkJsonl(`${newerLive}\n`, `${tombstone}\n`),
      /"deletedAt"/,
      "a live record must never resurrect a tombstoned id",
    );

    // Two live records with equal timestamps: local (ingested second) wins.
    const localLive = JSON.stringify({ id: "quirk:c", content: "local", lastObserved: "2026-03-01T00:00:00Z" });
    const remoteLive = JSON.stringify({ id: "quirk:c", content: "remote", lastObserved: "2026-03-01T00:00:00Z" });
    assert.match(mergeQuirkJsonl(`${localLive}\n`, `${remoteLive}\n`), /"content":"local"/, "local wins a live tie");
  });

  it("isolates entries when two workspaces share a pinned ClickHouse namespace", () => {
    const cwdA = "/Users/test/repo-a";
    const cwdB = "/Users/test/repo-b";
    const pinnedNamespace = "shared_team_ns";

    // Repo A indexes its files into the shared manifest
    const manifestA = mergeManifestJson(
      JSON.stringify({ schemaVersion: 3, lastIndexedAt: 100, files: { "src/index.ts": { hash: "a", chunkCount: 1 } } }),
      JSON.stringify({ schemaVersion: 3, lastIndexedAt: 0, files: {} }),
      cwdA,
      undefined,
      pinnedNamespace,
    );

    const parsedA = JSON.parse(manifestA);
    const keyA = Object.keys(parsedA.files)[0]!;
    assert.match(keyA, /^ws:[0-9a-f]{12}:src\/index\.ts$/);

    // Repo B indexes its own src/index.ts into the remote manifest containing Repo A's entries
    const manifestB = mergeManifestJson(
      JSON.stringify({ schemaVersion: 3, lastIndexedAt: 200, files: { "src/index.ts": { hash: "b", chunkCount: 2 } } }),
      manifestA,
      cwdB,
      undefined,
      pinnedNamespace,
    );

    const parsedB = JSON.parse(manifestB);
    const keysB = Object.keys(parsedB.files);
    assert.equal(keysB.length, 2, "both repos must preserve their src/index.ts without collision");
    assert.ok(keysB.includes(keyA), "repo A's entry must survive repo B's merge");
    const keyB = keysB.find((k) => k !== keyA)!;
    assert.match(keyB, /^ws:[0-9a-f]{12}:src\/index\.ts$/);
    assert.notEqual(keyA, keyB, "keys must be distinct per workspace root");
  });
});
