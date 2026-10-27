import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readWatcherState, discoverWatcherStates } from "../../watcher.js";

const LOCK_FILE = "watcher.lock";
const STATUS_FILE = "watcher-status.json";
// Essentially never a live PID on this host — simulates a crashed/stale owner.
const DEAD_PID = 2_147_483_647;

async function makeTempDir(name: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

async function writeLock(dir: string, pid: number): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, LOCK_FILE), JSON.stringify({ pid, startedAt: Date.now() }), "utf-8");
}

async function writeStatus(dir: string, status: Record<string, unknown>): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, STATUS_FILE), JSON.stringify(status), "utf-8");
}

describe("watcher observation", () => {
  let root: string;
  let workspace: string;

  before(async () => {
    root = await makeTempDir("watcher-observe");
    workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(workspace, ".opencode"), { recursive: true });
  });

  after(async () => {
    try { await fs.rm(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("reports nothing for a store dir without lock or status", async () => {
    const dir = path.join(root, "empty-store");
    await fs.mkdir(dir, { recursive: true });
    assert.equal(readWatcherState(dir), undefined);
    assert.equal(readWatcherState(path.join(root, "does-not-exist")), undefined);
  });

  it("reads a status file without a lock (stopped watcher)", async () => {
    const dir = path.join(root, "stopped-store");
    await writeStatus(dir, { running: false, lastSuccessAt: 1234 });
    const state = readWatcherState(dir);
    assert.ok(state);
    assert.equal(state.alive, false, "no lock means no live owner");
    assert.equal(state.lock, undefined);
    assert.equal(state.status?.lastSuccessAt, 1234);
  });

  it("marks a lock owned by this process as alive", async () => {
    const dir = path.join(root, "live-store");
    await writeLock(dir, process.pid);
    const state = readWatcherState(dir);
    assert.ok(state);
    assert.equal(state.alive, true);
    assert.equal(state.lock?.pid, process.pid);
  });

  it("marks a lock owned by a dead PID as not alive", async () => {
    const dir = path.join(root, "dead-store");
    await writeLock(dir, DEAD_PID);
    const state = readWatcherState(dir);
    assert.ok(state);
    assert.equal(state.alive, false);
  });

  it("discovers a live watcher running in a DIFFERENT store dir", async () => {
    // Configured store (CLI view): fresh, no watcher of its own.
    const configured = path.join(workspace, ".opencode", "rag_ch");
    await fs.mkdir(configured, { recursive: true });
    // The store the running plugin actually watches (e.g. after a config
    // switch the plugin never picked up): live lock + status.
    const legacy = path.join(workspace, ".opencode", "rag_db");
    await writeLock(legacy, process.pid);
    await writeStatus(legacy, { running: true, lastSuccessAt: Date.now() });

    const found = discoverWatcherStates(configured, workspace);
    const legacyState = found.find((w) => path.resolve(w.storePath) === path.resolve(legacy));
    assert.ok(legacyState, "must find the watcher in the sibling store dir");
    assert.equal(legacyState.alive, true);

    // Unrelated trees stay untouched.
    const elsewhere = await makeTempDir("watcher-unrelated");
    try {
      assert.deepEqual(discoverWatcherStates(path.join(elsewhere, "store"), elsewhere), []);
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("sorts live watchers before stopped ones", async () => {
    const root2 = await makeTempDir("watcher-sort");
    try {
      const ws = path.join(root2, "ws");
      await fs.mkdir(path.join(ws, ".opencode"), { recursive: true });
      const dead = path.join(ws, ".opencode", "rag_old");
      const live = path.join(ws, ".opencode", "rag_new");
      await writeLock(dead, DEAD_PID);
      await writeStatus(dead, { running: false, lastSuccessAt: Date.now() });
      await writeLock(live, process.pid);
      await writeStatus(live, { running: true, lastSuccessAt: 1 });

      const found = discoverWatcherStates(dead, ws);
      assert.equal(found.length, 2);
      assert.equal(found[0]!.alive, true, "live watcher comes first");
      assert.equal(path.resolve(found[0]!.storePath), path.resolve(live));
    } finally {
      await fs.rm(root2, { recursive: true, force: true });
    }
  });
});
