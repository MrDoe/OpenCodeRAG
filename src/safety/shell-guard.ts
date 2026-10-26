/**
 * @fileoverview Optional shell-command safety guard.
 *
 * Every `shell`/`bash` command is classified by a local decision model
 * (tev1 via Ollama, or Clef/Jev via llama-swap — all speak the same
 * `/v1/systemone` protocol) before it runs. A command whose `destructive` or
 * `malicious` probability reaches the configured threshold is escalated to
 * OpenCode's permission prompt (V2 `permission.hook("evaluate")` sets
 * `effect = "ask"`); a clean command executes unchanged.
 *
 * Design constraints learned from the OpenCode V2 plugin API:
 * - The V1 `tool.execute.before` hook cannot block a call (throwing is
 *   swallowed by the adapter), so the guard uses the permission `evaluate`
 *   hook, which runs AFTER rules are evaluated and BEFORE the action runs.
 * - That hook runs for `allow` and `ask` decisions but not for `deny`.
 * - The check sits on the critical path of every shell command: the timeout
 *   is short (default 10 s), verdicts are cached, and failures default to
 *   fail-open (`onError: "allow"`).
 *
 * @see https://opencode.ai/v2/docs/build/plugins (Permissions)
 */

import { statSync } from "node:fs";
import path from "node:path";
import type { DecisionConfig, LoggingConfig, RagConfig, ShellGuardConfig } from "../core/config.js";
import { DEFAULT_CONFIG, loadWorkspaceConfig, resolveConfigPaths, resolveLogConfig } from "../core/config.js";
import type { DecisionProvider, DecisionQuestion, DecisionResult } from "../core/interfaces.js";
import { appendDebugLog } from "../core/fileLogger.js";
import { createDecisionProvider } from "../decision/factory.js";

/** Tool names whose command text is vetted (V2 `shell`, V1-style `bash`). */
export const SHELL_GUARD_TOOL_NAMES: readonly string[] = ["shell", "bash"];

/** Fallback decision config when neither shellGuard nor decision provide one. */
const FALLBACK_DECISION: DecisionConfig = {
  enabled: false,
  provider: "ollama",
  baseUrl: "http://127.0.0.1:11434/api",
  model: "tev1:4b",
  timeoutMs: 120000,
};

/**
 * Questions asked of the decision model for every command.
 *
 * Two `noul` questions drive the pass/fail decision (either one reaching the
 * threshold flags the command); the `choice` question only labels the risk so
 * the confirmation prompt explains *why* it was flagged.
 */
export const SHELL_GUARD_QUESTIONS: readonly DecisionQuestion[] = [
  {
    id: "destructive",
    type: "noul",
    instructions:
      "Could this shell command delete, overwrite, move, or irreversibly modify files, databases, or system state beyond a normal edit, build, or test operation?",
    criteria: {
      true: "Deletes/overwrites data or irreversibly changes files or system state",
      false: "Normal, reversible, or read-only operation",
    },
  },
  {
    id: "malicious",
    type: "noul",
    instructions:
      "Does this shell command show malicious intent — exfiltrating data, disabling security controls, privilege escalation, obfuscated payloads, or unexpected remote writes?",
    criteria: {
      true: "Exfiltration, security tampering, privilege escalation, or hidden payloads",
      false: "Ordinary development or administration command",
    },
  },
  {
    id: "category",
    type: "choice",
    instructions: "Which category best describes the risk of this command?",
    criteria: {
      none: "No destructive or malicious behavior",
      delete_files: "Deletes or overwrites files or directories",
      format_disk: "Formats a disk, partition, or block device",
      process_kill: "Kills processes or restarts services",
      network: "Sends data to or pulls code from a remote host",
      config_tamper: "Changes system or security configuration",
      privilege: "Elevates privileges",
    },
  },
];

/** Live configuration resolved for one guard evaluation. */
export interface ShellGuardRuntimeConfig {
  guard: ShellGuardConfig;
  decision: DecisionConfig;
  logging: LoggingConfig;
}

/** Outcome of classifying a single shell command. */
export interface ShellGuardVerdict {
  /** True when the command must be confirmed before it runs. */
  flagged: boolean;
  /** Probability that the command is destructive (0-1). */
  destructive: number;
  /** Probability that the command is malicious (0-1). */
  malicious: number;
  /** Risk label chosen by the model (`none` when clean). */
  category: string;
  /** Human-readable explanation for the permission prompt. */
  reason: string;
  /** Decision provider name (e.g. "ollama"). */
  provider: string;
  /** Decision model name (e.g. "tev1:0.8b" / "Clef-Flash"). */
  model: string;
  /** Classification duration in ms. */
  latencyMs: number;
  /** True when the verdict was served from the cache. */
  cached: boolean;
  /** True when no config was available (guard disabled). */
  skipped?: boolean;
  /** Classifier failure (timeout / endpoint error); `flagged` follows `onError`. */
  error?: string;
}

/** Injectable dependencies (tests provide a fake provider and clock). */
export interface ShellGuardDeps {
  /** Resolve the live runtime config; `undefined` disables the guard. */
  getConfig?: () => ShellGuardRuntimeConfig | undefined;
  /** Provider factory override (defaults to the decision-model factory). */
  createProvider?: (config: DecisionConfig) => DecisionProvider;
  /** Clock override for cache tests. */
  now?: () => number;
}

interface CacheEntry {
  /** Raw classifier outcome; `flagged`/`reason` are re-derived per call so a threshold or onError edit applies immediately. */
  outcome: CachedOutcome;
  ts: number;
  ttlMs: number;
}

/** Model output retained in the cache, before the current threshold is applied. */
interface CachedOutcome {
  destructive: number;
  malicious: number;
  category: string;
  latencyMs: number;
  /** Set when the classifier failed; `flagged` then follows the current `onError`. */
  error?: string;
}

/** Case-insensitive test for a shell-execution tool name. */
export function isShellToolName(name: string | undefined): boolean {
  if (!name) return false;
  return SHELL_GUARD_TOOL_NAMES.includes(name.toLowerCase());
}

/**
 * Truncate an oversized command for the decision model.
 *
 * The model's effective context is small (~2k tokens), so keep the head and
 * the tail — destructive payloads usually appear at one end — and mark the
 * omission explicitly.
 */
export function buildShellGuardState(command: string, maxChars = 8000): string {
  const trimmed = command.trim();
  if (maxChars <= 0 || trimmed.length <= maxChars) return trimmed;
  const marker = "\n…[truncated by shell guard]…\n";
  const headLen = Math.floor(maxChars * 0.6);
  const tailLen = Math.max(0, maxChars - headLen - marker.length);
  return `${trimmed.slice(0, headLen)}${marker}${tailLen > 0 ? trimmed.slice(-tailLen) : ""}`;
}

/** Clamp a probability into [0, 1]; non-numeric answers degrade to 0. */
function clampProbability(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Convert raw decision answers into a guard verdict.
 *
 * Exported for tests; production callers use {@link ShellGuard.evaluate}.
 */
export function verdictFromDecisionResult(
  result: DecisionResult,
  opts: {
    threshold: number;
    provider: string;
    model: string;
    latencyMs: number;
    cached?: boolean;
  },
): ShellGuardVerdict {
  let destructive = 0;
  let malicious = 0;
  let category = "none";
  for (const answer of result.answers) {
    if (answer.id === "destructive") destructive = clampProbability(answer.noul);
    else if (answer.id === "malicious") malicious = clampProbability(answer.noul);
    else if (answer.id === "category" && typeof answer.choice === "string" && answer.choice.length > 0) {
      category = answer.choice;
    }
  }
  const flagged = destructive >= opts.threshold || malicious >= opts.threshold;
  const verdict: ShellGuardVerdict = {
    flagged,
    destructive,
    malicious,
    category,
    reason: "",
    provider: opts.provider,
    model: opts.model,
    latencyMs: opts.latencyMs,
    cached: opts.cached ?? false,
  };
  // The reason is only consumed when a command is escalated; clean verdicts
  // stay message-free so a caller cannot accidentally prompt for them.
  if (flagged) verdict.reason = formatShellGuardReason(verdict);
  return verdict;
}

/** Build the message shown in the permission prompt. */
export function formatShellGuardReason(verdict: ShellGuardVerdict): string {
  if (verdict.error) {
    return (
      `ShellGuard could not classify this command (${verdict.error}) — ` +
      `confirmation required by shellGuard.onError = "ask".`
    );
  }
  const category = verdict.category && verdict.category !== "none" ? ` (category: ${verdict.category})` : "";
  return (
    `ShellGuard flagged this command with ${verdict.provider}/${verdict.model}: ` +
    `destructive p=${verdict.destructive.toFixed(2)}, malicious p=${verdict.malicious.toFixed(2)}${category}. ` +
    `Confirm before running.`
  );
}

/** Short, log-safe error description. */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 160 ? `${message.slice(0, 157)}…` : message;
}

/**
 * Classify shell commands and cache verdicts.
 *
 * One instance lives for the lifetime of the plugin registration. Provider
 * instances are re-created only when the endpoint/model signature changes, so
 * a config edit (e.g. switching tev1 → Clef-Flash) takes effect without a
 * restart.
 */
export class ShellGuard {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private readonly createProvider: (config: DecisionConfig) => DecisionProvider;
  private providerState: { signature: string; provider: DecisionProvider } | undefined;

  constructor(private readonly deps: ShellGuardDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.createProvider = deps.createProvider ?? createDecisionProvider;
  }

  /**
   * Classify one command.
   *
   * Returns a non-flagged verdict when the guard is disabled or when the
   * classifier fails under `onError: "allow"` (fail-open). Never throws.
   */
  async evaluate(command: string, abort?: AbortSignal): Promise<ShellGuardVerdict> {
    const cfg = this.deps.getConfig?.();
    if (!cfg) {
      return {
        flagged: false,
        destructive: 0,
        malicious: 0,
        category: "none",
        reason: "",
        provider: "",
        model: "",
        latencyMs: 0,
        cached: false,
        skipped: true,
      };
    }

    const { guard, decision, logging } = cfg;
    const signature = `${decision.provider}|${decision.baseUrl}|${decision.model}`;
    const cacheKey = `${signature}\u0000${command}`;
    const cacheTtlMs = guard.cacheTtlMs ?? 0;

    if (cacheTtlMs > 0) {
      const hit = this.cache.get(cacheKey);
      if (hit) {
        if (this.now() - hit.ts < hit.ttlMs) {
          return this.verdictFromOutcome(hit.outcome, guard, decision, true);
        }
        this.cache.delete(cacheKey);
      }
    }

    const provider = this.getProvider(signature, decision);
    const started = this.now();
    const state = buildShellGuardState(command, decision.maxStateChars ?? 8000);

    let timedOut = false;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    abort?.addEventListener("abort", onAbort);
    const timeoutMs = Math.max(50, guard.timeoutMs ?? 10000);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const result = await provider.decide({ state, questions: [...SHELL_GUARD_QUESTIONS] }, controller.signal);
      const latencyMs = this.now() - started;
      const verdict = verdictFromDecisionResult(result, {
        threshold: guard.threshold,
        provider: decision.provider,
        model: decision.model,
        latencyMs,
      });
      this.log(logging, verdict, command, undefined);
      this.store(
        cacheKey,
        {
          destructive: verdict.destructive,
          malicious: verdict.malicious,
          category: verdict.category,
          latencyMs,
        },
        cacheTtlMs,
        guard.maxCacheEntries ?? 256,
      );
      return verdict;
    } catch (error) {
      const failure = timedOut ? `timeout after ${timeoutMs}ms` : describeError(error);
      const latencyMs = this.now() - started;
      const verdict = this.verdictFromOutcome(
        { destructive: 0, malicious: 0, category: "none", latencyMs, error: failure },
        guard,
        decision,
        false,
      );
      this.log(logging, verdict, command, error);
      // Cache failures briefly so a dead endpoint is not re-probed before
      // every command — but never longer than the normal verdict TTL.
      this.store(
        cacheKey,
        { destructive: 0, malicious: 0, category: "none", latencyMs, error: failure },
        Math.min(cacheTtlMs, 30_000),
        guard.maxCacheEntries ?? 256,
      );
      return verdict;
    } finally {
      clearTimeout(timer);
      abort?.removeEventListener("abort", onAbort);
    }
  }

  /** Reset cached verdicts (tests / config reload). */
  clearCache(): void {
    this.cache.clear();
  }

  private getProvider(signature: string, decision: DecisionConfig): DecisionProvider {
    if (this.providerState?.signature === signature) return this.providerState.provider;
    const provider = this.createProvider(decision);
    this.providerState = { signature, provider };
    return provider;
  }

  /**
   * Build a verdict from a (possibly cached) classifier outcome using the
   * CURRENT threshold and `onError` policy — editing either in
   * `opencode-rag.json` takes effect on the next command even while cached
   * probabilities are still valid.
   */
  private verdictFromOutcome(
    outcome: CachedOutcome,
    guard: ShellGuardConfig,
    decision: DecisionConfig,
    cached: boolean,
  ): ShellGuardVerdict {
    const base = {
      destructive: outcome.destructive,
      malicious: outcome.malicious,
      category: outcome.category,
      reason: "",
      provider: decision.provider,
      model: decision.model,
      latencyMs: outcome.latencyMs,
      cached,
    };
    if (outcome.error) {
      const verdict: ShellGuardVerdict = {
        ...base,
        destructive: 0,
        malicious: 0,
        category: "none",
        flagged: (guard.onError ?? "allow") === "ask",
        error: outcome.error,
      };
      // Fail-open verdicts stay message-free — the "confirmation required"
      // text describes the ask policy and would be a lie under allow.
      if (verdict.flagged) verdict.reason = formatShellGuardReason(verdict);
      return verdict;
    }
    const flagged = outcome.destructive >= guard.threshold || outcome.malicious >= guard.threshold;
    const verdict: ShellGuardVerdict = { ...base, flagged };
    // The reason is only consumed when a command is escalated; clean verdicts
    // stay message-free so a caller cannot accidentally prompt for them.
    if (flagged) verdict.reason = formatShellGuardReason(verdict);
    return verdict;
  }

  private store(key: string, outcome: CachedOutcome, ttlMs: number, maxEntries: number): void {
    if (ttlMs <= 0 || maxEntries <= 0) return;
    if (this.cache.size >= maxEntries) {
      // Map preserves insertion order — evict the oldest entry.
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, { outcome, ts: this.now(), ttlMs });
  }

  private log(
    logging: LoggingConfig,
    verdict: ShellGuardVerdict,
    command: string,
    error: unknown,
  ): void {
    const preview = command.length > 160 ? `${command.slice(0, 157)}…` : command;
    if (verdict.error) {
      appendDebugLog(
        logging.logFilePath,
        {
          scope: "shell.guard",
          message: `classifier failed (${verdict.error}) — onError=${verdict.flagged ? "ask" : "allow"} for "${preview}"`,
          error,
          severity: "warn",
        },
        logging.level,
      );
      return;
    }
    appendDebugLog(
      logging.logFilePath,
      {
        scope: "shell.guard",
        message:
          `${verdict.flagged ? "FLAG" : "allow"} destructive=${verdict.destructive.toFixed(2)} ` +
          `malicious=${verdict.malicious.toFixed(2)} category=${verdict.category} ` +
          `model=${verdict.provider}/${verdict.model} latency=${verdict.latencyMs}ms for "${preview}"`,
        severity: verdict.flagged ? "info" : "debug",
      },
      logging.level,
    );
  }
}

/**
 * Resolve the guard's live config from a loaded `RagConfig`.
 *
 * Returns `undefined` when the guard is disabled — callers use that as the
 * single gate. `decision.enabled` deliberately does NOT gate the guard: the
 * guard has its own switch and may run against a backend the `make_decision`
 * tool does not expose.
 *
 * @param cfg - Fully merged workspace configuration.
 * @param directory - Workspace root; when given, the log file path is
 *   resolved against it (the plugin's process cwd is not necessarily the
 *   workspace).
 */
export function resolveShellGuardRuntimeConfig(
  cfg: RagConfig,
  directory?: string,
): ShellGuardRuntimeConfig | undefined {
  const guard = cfg.shellGuard;
  if (guard?.enabled !== true) return undefined;
  const base = cfg.decision ?? DEFAULT_CONFIG.decision ?? FALLBACK_DECISION;
  const decision: DecisionConfig = {
    ...base,
    enabled: true,
    provider: guard.provider?.trim() || base.provider,
    baseUrl: guard.baseUrl?.trim() || base.baseUrl,
    model: guard.model?.trim() || base.model,
  };
  const log = resolveLogConfig(cfg);
  return {
    guard,
    decision,
    logging: directory
      ? { ...log, logFilePath: path.resolve(directory, log.logFilePath) }
      : log,
  };
}

/**
 * Build a config reader that re-reads the global + workspace config when
 * either changes.
 *
 * A shell command is classified at most a few seconds apart, so the stat
 * check is cheap; re-reading makes an edit (global enabled flag, threshold,
 * model) take effect without restarting OpenCode.
 */
export function createShellGuardConfigReader(
  directory: string,
): () => ShellGuardRuntimeConfig | undefined {
  let cached: { stamp: string; value: ShellGuardRuntimeConfig | undefined } | undefined;
  return () => {
    try {
      const paths = resolveConfigPaths(directory);
      if (!paths.global && !paths.workspace) return undefined;
      const stamp = [paths.global, paths.workspace]
        .filter((p): p is string => p !== undefined)
        .map((p) => {
          const stat = statSync(p);
          return `${p}:${stat.mtimeMs}:${stat.size}`;
        })
        .join("|");
      if (cached && cached.stamp === stamp) return cached.value;
      const value = resolveShellGuardRuntimeConfig(loadWorkspaceConfig(directory, false), directory);
      cached = { stamp, value };
      return value;
    } catch {
      // Malformed config: keep the last good value rather than disabling the
      // guard mid-session.
      return cached?.value;
    }
  };
}

/** Convenience factory used by the V2 adapter. */
export function createShellGuardForDirectory(directory: string): ShellGuard {
  return new ShellGuard({ getConfig: createShellGuardConfigReader(directory) });
}
