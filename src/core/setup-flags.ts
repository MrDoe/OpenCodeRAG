/**
 * @fileoverview Setup-phase gating for the plugin's startup sequence.
 *
 * The plugin does substantial work at setup time (dimension probe, store
 * open, keyword-index parse, quirk reconcile, watcher, update check). When a
 * host dies during that sequence there is often no JS error to read — the
 * process just goes away (a native crash or an OOM). These flags let a user
 * bisect the phases from the environment, without rebuilding:
 *
 * - `OPENCODE_RAG_SAFE_MODE=1` — skip every skippable phase (dimension probe,
 *   keyword index, quirk reconcile, watcher, update check). Tools stay
 *   registered and the store opens lazily on first use; keyword search
 *   degrades to vector-only for that session.
 * - `OPENCODE_RAG_SETUP_SKIP=probe,keyword,quirks,watcher,update` — skip a
 *   named subset.
 */

/** Phases that can be skipped at plugin setup. */
export const SKIPPABLE_SETUP_PHASES = ["probe", "keyword", "quirks", "watcher", "update"] as const;

/** A skippable setup phase name. */
export type SkippableSetupPhase = (typeof SKIPPABLE_SETUP_PHASES)[number];

/** Parsed setup gating flags. */
export interface SetupFlags {
  /** `OPENCODE_RAG_SAFE_MODE` was set to a truthy value. */
  safeMode: boolean;
  /** Explicitly skipped phases (`OPENCODE_RAG_SETUP_SKIP`). */
  skip: ReadonlySet<string>;
}

/** Truthy spellings accepted for `OPENCODE_RAG_SAFE_MODE`. */
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * Parse the setup gating flags from an environment.
 *
 * @param env - Environment to read (defaults to `process.env`).
 * @returns The parsed flags; unknown skip entries are kept but never match.
 */
export function parseSetupFlags(env: NodeJS.ProcessEnv = process.env): SetupFlags {
  const safeMode = TRUTHY.has((env.OPENCODE_RAG_SAFE_MODE ?? "").trim().toLowerCase());
  const skip = new Set(
    (env.OPENCODE_RAG_SETUP_SKIP ?? "")
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length > 0),
  );
  return { safeMode, skip };
}

/**
 * Whether a setup phase should be skipped.
 *
 * @param flags - Parsed flags from {@link parseSetupFlags}.
 * @param phase - The phase to test.
 * @returns True when safe mode is active or the phase is in the skip list.
 */
export function setupPhaseSkipped(flags: SetupFlags, phase: SkippableSetupPhase): boolean {
  return flags.safeMode || flags.skip.has(phase);
}
