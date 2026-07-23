/**
 * @fileoverview Persisted state for the background auto-update mechanism.
 * Tracks when an install was last attempted, for which version,
 * and consecutive failure counts to implement cooldown and backoff.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Name of the state file written to the store path. */
const STATE_FILE_NAME = ".auto-update-state.json";

/** Persisted state of a background auto-update attempt. */
export interface AutoUpdateState {
  /** Epoch ms of the most recent attempt. */
  lastAttemptAt: number;
  /** The latestVersion we tried to install (or checked). */
  lastAttemptedVersion: string;
  /** Outcome of the last attempt. */
  lastResult: "success" | "failure";
  /** Consecutive failures so far (reset on success). */
  consecutiveFailures: number;
}

/** Full path to the state file for a given store path. */
export function statePath(storePath: string): string {
  return path.join(storePath, STATE_FILE_NAME);
}

/** Load persisted auto-update state, or return null if missing / corrupt. */
export function loadAutoUpdateState(storePath: string): AutoUpdateState | null {
  try {
    const p = statePath(storePath);
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as AutoUpdateState;
    if (
      typeof parsed.lastAttemptAt !== "number" ||
      typeof parsed.lastAttemptedVersion !== "string" ||
      (parsed.lastResult !== "success" && parsed.lastResult !== "failure") ||
      typeof parsed.consecutiveFailures !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Persist auto-update state to disk (best-effort, never throws). */
export function saveAutoUpdateState(storePath: string, state: AutoUpdateState): void {
  try {
    writeFileSync(statePath(storePath), JSON.stringify(state, null, 2), "utf-8");
  } catch {
    /* best-effort */
  }
}

/**
 * Determine whether an auto-install attempt should proceed, based on
 * the persisted state, the version we just discovered, and configured
 * limits.
 *
 * @returns An object with `attempt: boolean` and `reason: string`.
 */
export function shouldAttemptInstall(
  state: AutoUpdateState | null,
  latestVersion: string,
  cooldownMs: number,
  maxConsecutiveFailures: number,
): { attempt: boolean; reason: string } {
  if (!state) {
    return { attempt: true, reason: "first run" };
  }

  const elapsed = Date.now() - state.lastAttemptAt;

  if (state.lastAttemptedVersion === latestVersion && elapsed < cooldownMs) {
    return {
      attempt: false,
      reason: `version ${latestVersion} already attempted ${Math.round(elapsed / 1000)}s ago (cooldown ${Math.round(cooldownMs / 1000)}s)`,
    };
  }

  if (state.lastResult === "failure" && state.consecutiveFailures >= maxConsecutiveFailures && elapsed < cooldownMs) {
    return {
      attempt: false,
      reason: `${state.consecutiveFailures} consecutive failures within cooldown window`,
    };
  }

  return { attempt: true, reason: "proceeding" };
}
