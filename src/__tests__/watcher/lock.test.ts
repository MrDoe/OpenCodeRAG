import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { tryAcquireWatcherLock, releaseWatcherLock } from "../../watcher.js";

const LOCK_FILE = "watcher.lock";
// Essentially never a live PID on this host — simulates a crashed owner.
const DEAD_PID = 2_147_483_647;

async function makeTempDir(name: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

describe("watcher lock", () => {
  let dir: string;

  before(async () => {
    dir = await makeTempDir("watcher-lock");
  });

  after(async () => {
    try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("only one process may hold the lock at a time", () => {
    assert.equal(tryAcquireWatcherLock(dir), true);
    assert.equal(tryAcquireWatcherLock(dir), false, "second claim must fail while owned");
    releaseWatcherLock(dir);
    assert.equal(existsSync(path.join(dir, LOCK_FILE)), false, "release removes the lock file");
    assert.equal(tryAcquireWatcherLock(dir), true, "claim succeeds after release");
    releaseWatcherLock(dir);
  });

  it("recovers a stale lock left by a dead process", async () => {
    await fs.writeFile(path.join(dir, LOCK_FILE), JSON.stringify({ pid: DEAD_PID, startedAt: Date.now() }), "utf-8");
    assert.equal(tryAcquireWatcherLock(dir), true, "stale lock must be reclaimed");
    releaseWatcherLock(dir);
  });

  it("recovers a corrupt lock file", async () => {
    await fs.writeFile(path.join(dir, LOCK_FILE), "not json {", "utf-8");
    assert.equal(tryAcquireWatcherLock(dir), true, "corrupt lock must be reclaimed");
    releaseWatcherLock(dir);
  });

  it("does not release a lock owned by another process", async () => {
    await fs.writeFile(path.join(dir, LOCK_FILE), JSON.stringify({ pid: DEAD_PID, startedAt: Date.now() }), "utf-8");
    releaseWatcherLock(dir);
    assert.equal(existsSync(path.join(dir, LOCK_FILE)), true, "foreign lock must survive");
    assert.equal(tryAcquireWatcherLock(dir), true, "stale foreign lock can still be claimed");
    releaseWatcherLock(dir);
  });
});
