import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  loadAutoUpdateState,
  saveAutoUpdateState,
  shouldAttemptInstall,
  statePath,
  type AutoUpdateState,
} from "../core/auto-update-state.js";

describe("auto-update-state", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "auto-update-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("statePath", () => {
    it("returns path under store", () => {
      assert.match(statePath(tmpDir), /\.auto-update-state\.json$/);
    });
  });

  describe("save and load", () => {
    it("writes and reads back the state", () => {
      const state: AutoUpdateState = {
        lastAttemptAt: 1_700_000_000_000,
        lastAttemptedVersion: "1.5.0",
        lastResult: "success",
        consecutiveFailures: 0,
      };
      saveAutoUpdateState(tmpDir, state);
      const loaded = loadAutoUpdateState(tmpDir);
      assert.deepEqual(loaded, state);
    });

    it("returns null when no file exists", () => {
      assert.equal(loadAutoUpdateState(tmpDir), null);
    });

    it("returns null for corrupt JSON", () => {
      writeFileSync(statePath(tmpDir), "not json", "utf-8");
      assert.equal(loadAutoUpdateState(tmpDir), null);
    });

    it("returns null for incomplete data", () => {
      writeFileSync(statePath(tmpDir), JSON.stringify({ lastAttemptAt: 1 }), "utf-8");
      assert.equal(loadAutoUpdateState(tmpDir), null);
    });

    it("never throws on corrupt data", () => {
      writeFileSync(statePath(tmpDir), "{}", "utf-8");
      assert.equal(loadAutoUpdateState(tmpDir), null);
    });

    it("never throws on malformed path", () => {
      loadAutoUpdateState(path.join(tmpDir, "nonexistent"));
      // no throw
    });
  });

  describe("shouldAttemptInstall", () => {
    const now = Date.now();
    const cooldownMs = 3_600_000;  // 1h
    const maxFailures = 3;

    it("attempts when no prior state", () => {
      const r = shouldAttemptInstall(null, "2.0.0", cooldownMs, maxFailures);
      assert.equal(r.attempt, true);
      assert.match(r.reason, /first run/);
    });

    it("skips when same version within cooldown", () => {
      const state: AutoUpdateState = {
        lastAttemptAt: now - 60_000,  // 1 minute ago
        lastAttemptedVersion: "2.0.0",
        lastResult: "success",
        consecutiveFailures: 0,
      };
      const r = shouldAttemptInstall(state, "2.0.0", cooldownMs, maxFailures);
      assert.equal(r.attempt, false);
      assert.match(r.reason, /already attempted/);
    });

    it("attempts when same version outside cooldown", () => {
      const state: AutoUpdateState = {
        lastAttemptAt: now - 7_200_000,  // 2h ago
        lastAttemptedVersion: "2.0.0",
        lastResult: "success",
        consecutiveFailures: 0,
      };
      const r = shouldAttemptInstall(state, "2.0.0", cooldownMs, maxFailures);
      assert.equal(r.attempt, true);
    });

    it("attempts when different version regardless of cooldown", () => {
      const state: AutoUpdateState = {
        lastAttemptAt: now - 10_000,  // 10 seconds ago
        lastAttemptedVersion: "2.0.0",
        lastResult: "success",
        consecutiveFailures: 0,
      };
      const r = shouldAttemptInstall(state, "2.1.0", cooldownMs, maxFailures);
      assert.equal(r.attempt, true);
    });

    it("skips when consecutive failures exceed max within cooldown", () => {
      const state: AutoUpdateState = {
        lastAttemptAt: now - 60_000,
        lastAttemptedVersion: "2.0.0",
        lastResult: "failure",
        consecutiveFailures: 3,
      };
      const r = shouldAttemptInstall(state, "2.1.0", cooldownMs, maxFailures);
      assert.equal(r.attempt, false);
      assert.match(r.reason, /consecutive failures/);
    });

    it("attempts when consecutive failures below threshold", () => {
      const state: AutoUpdateState = {
        lastAttemptAt: now - 60_000,
        lastAttemptedVersion: "2.0.0",
        lastResult: "failure",
        consecutiveFailures: 2,
      };
      const r = shouldAttemptInstall(state, "2.1.0", cooldownMs, maxFailures);
      assert.equal(r.attempt, true);
    });

    it("attempts when max failures met but cooldown expired", () => {
      const state: AutoUpdateState = {
        lastAttemptAt: now - 7_200_000,  // 2h ago
        lastAttemptedVersion: "2.0.0",
        lastResult: "failure",
        consecutiveFailures: 5,
      };
      const r = shouldAttemptInstall(state, "2.0.0", cooldownMs, maxFailures);
      assert.equal(r.attempt, true);
    });

    it("attempts after successful upgrade to a newer version", () => {
      const state: AutoUpdateState = {
        lastAttemptAt: now - 30_000,
        lastAttemptedVersion: "2.0.0",
        lastResult: "success",
        consecutiveFailures: 0,
      };
      const r = shouldAttemptInstall(state, "3.0.0", cooldownMs, maxFailures);
      assert.equal(r.attempt, true);
    });
  });
});
