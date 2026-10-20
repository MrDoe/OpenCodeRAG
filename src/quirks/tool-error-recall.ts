/**
 * @fileoverview Tool-error → quirk recall: when a tool call fails, find matching quirk
 * memory entries to inject into the next model request, and gate the existing
 * auto-capture pipeline so recurring errors can become quirks.
 *
 * Design notes:
 * - Pure and dependency-injected: the caller passes a `recall` function (the plugin
 *   wraps `recallQuirks`), so this module has no store/embedder dependencies and is
 *   cheap to unit-test.
 * - Conservative by default: min score 0.7, max 2 hits per error, 3 injections per
 *   session, 60s cooldown per normalized error signature, plus a lexical gate so a
 *   semantically close but lexically unrelated quirk never gets injected.
 * - A failed recall still counts as an attempt (cooldown), so a repeatedly failing
 *   tool does not hammer the embedder every call — but it does not consume the
 *   per-session budget; only actual injections do.
 * - Two similarity bars: the recall FLOOR (`minScore`) decides which quirks are
 *   candidates at all, the INJECTION bar (`injectMinScore`) decides which of them
 *   are injected. The gap between them is the "probable match" tier — it suppresses
 *   quirk creation but is only injected when no confident match exists. The bars are
 *   compared against the RAW vector similarity, never against the confidence-
 *   discounted `score` (see `rawSimilarity`).
 */

import { sharedWords } from "./quirk-store.js";

/** A failed tool call as observed by the plugin. */
export interface ToolErrorInfo {
  /** Tool name as reported by OpenCode (e.g. "search_semantic", "write"). */
  tool: string;
  /** Error text (ToolStateError.error or the V2 execute.after error payload). */
  error: string;
  /** Owning session — callers keep one state object per session. */
  sessionID?: string;
}

/** Minimal recall-hit shape; structurally compatible with `SearchResult`. */
export interface ToolErrorRecallHit {
  chunk: { id: string; content: string; metadata?: { quirkType?: string; tags?: string[] } };
  score: number;
  /**
   * Raw vector similarity (0-1) — the cosine-mapped similarity WITHOUT the
   * confidence discount that `recallQuirks` applies to `score`
   * (`score = similarity * confidence`). Thresholds must be compared against
   * this field; `score` is not comparable to a similarity threshold because a
   * high-confidence quirk and a low-confidence one with the same similarity get
   * different scores. Falls back to `score` when the caller cannot provide it.
   */
  rawSimilarity?: number;
}

/** Recall function the caller provides (usually a `recallQuirks` wrapper). */
export type ToolErrorRecallFn = (
  query: string,
  options: { topK: number; minScore: number },
) => Promise<readonly ToolErrorRecallHit[]>;

/** A quirk selected for injection after a tool error. */
export interface ToolErrorQuirkHit {
  id: string;
  content: string;
  quirkType?: string;
  score: number;
  /** Raw vector similarity (0-1) — the value thresholds are compared against. */
  rawSimilarity: number;
}

/** Tunables for the tool-error quirk path. */
export interface ToolErrorRecallOptions {
  /**
   * Recall floor — the minimum raw similarity a candidate must clear to be
   * returned by the recall at all. Default 0.7.
   */
  minScore?: number;
  /**
   * Threshold a candidate must clear to be INJECTED. Defaults to `minScore`.
   * A candidate between the floor and this threshold is a "probable match": it
   * suppresses quirk creation but is only injected when no confident match
   * exists.
   */
  injectMinScore?: number;
  /** Maximum quirks injected per error. Default 2. */
  topK?: number;
  /** Minimum shared meaningful words (>=3 chars) between quirk and error. 0 disables. Default 1. */
  minTokenOverlap?: number;
  /**
   * Whether the per-session injection budget may block the recall outright
   * (default true). Set to `false` when the caller still needs the candidate
   * list even though it may not inject anything — e.g. to decide whether a
   * quirk already exists. The cooldown still applies either way.
   */
  enforceBudget?: boolean;
}

/** Tunables for the per-session injection state. */
export interface ToolErrorInjectionOptions {
  /** Cooldown per normalized error signature in ms. Default 60_000. */
  cooldownMs?: number;
  /** Maximum injections (errors that produced at least one quirk) per session. Default 3. */
  maxPerSession?: number;
}

/** Per-session injection bookkeeping (cooldown, budget, already-injected quirk ids). */
export interface ToolErrorInjectionState {
  /** True when this error may trigger a recall (budget left, signature not cooling down). */
  shouldInject(info: ToolErrorInfo, now?: number): boolean;
  /**
   * True when the per-signature cooldown blocks this error. Independent of the
   * per-session budget — a cooled-down error must not trigger another recall
   * (that is what stops a repeatedly failing tool from hammering the
   * embedder), while an exhausted budget is a *context* limit that must not
   * also block quirk creation.
   */
  isCoolingDown(info: ToolErrorInfo, now?: number): boolean;
  /** True when the per-session injection budget still has room. */
  hasBudget(): boolean;
  /** Record an attempt. Always refreshes the cooldown; counts toward the budget only when quirkIds is non-empty. */
  record(info: ToolErrorInfo, quirkIds: readonly string[], now?: number): void;
  /** Quirk ids already injected in this session. */
  readonly injectedQuirkIds: ReadonlySet<string>;
  /** Number of injections that actually delivered at least one quirk. */
  injectionCount(): number;
}

/** Defaults shared by the state factory and the selector. */
export const TOOL_ERROR_DEFAULTS = {
  minScore: 0.7,
  topK: 2,
  minTokenOverlap: 1,
  cooldownMs: 60_000,
  maxPerSession: 3,
  /** Error text is truncated before it becomes a recall query / capture payload. */
  maxErrorChars: 400,
  /** Capture payloads are sliced to match the existing auto-capture tool-result cap. */
  maxCaptureChars: 500,
} as const;

/** Collapse an error into a stable signature for cooldown/dedup purposes. */
export function normalizeToolErrorSignature(info: ToolErrorInfo): string {
  const normalized = info.error
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\d+/g, "#")
    .trim()
    .slice(0, 160);
  return `${info.tool.toLowerCase()}|${normalized}`;
}

/** Build the recall query for a failed tool call. */
export function buildToolErrorQuery(info: ToolErrorInfo): string {
  const error = info.error.replace(/\s+/g, " ").trim().slice(0, TOOL_ERROR_DEFAULTS.maxErrorChars);
  return `Tool "${info.tool}" failed: ${error}`;
}

/** Create the per-session injection state. */
export function createToolErrorInjectionState(
  options?: ToolErrorInjectionOptions,
): ToolErrorInjectionState {
  const cooldownMs = options?.cooldownMs ?? TOOL_ERROR_DEFAULTS.cooldownMs;
  const maxPerSession = options?.maxPerSession ?? TOOL_ERROR_DEFAULTS.maxPerSession;

  const lastAttemptAt = new Map<string, number>();
  const injectedIds = new Set<string>();
  let injections = 0;

  return {
    shouldInject(info: ToolErrorInfo, now: number = Date.now()): boolean {
      if (!this.hasBudget()) return false;
      return !this.isCoolingDown(info, now);
    },

    isCoolingDown(info: ToolErrorInfo, now: number = Date.now()): boolean {
      const signature = normalizeToolErrorSignature(info);
      const last = lastAttemptAt.get(signature);
      return last !== undefined && now - last < cooldownMs;
    },

    hasBudget(): boolean {
      return injections < maxPerSession;
    },

    record(info: ToolErrorInfo, quirkIds: readonly string[], now: number = Date.now()): void {
      lastAttemptAt.set(normalizeToolErrorSignature(info), now);
      if (quirkIds.length === 0) return;
      injections += 1;
      for (const id of quirkIds) injectedIds.add(id);
    },

    get injectedQuirkIds(): ReadonlySet<string> {
      return injectedIds;
    },

    injectionCount(): number {
      return injections;
    },
  };
}

/** The outcome of a single tool-error recall. */
export interface ToolErrorRecallResult {
  /**
   * Hits that may be injected right now: they cleared the injection bar and
   * were not already injected in this session.
   */
  inject: ToolErrorQuirkHit[];
  /**
   * Every hit that cleared the recall floor, sorted by raw similarity
   * descending. Includes already-injected quirks — the caller uses this to
   * decide whether a quirk ALREADY EXISTS (which suppresses creation) even
   * when it must not be injected again.
   */
  candidates: ToolErrorQuirkHit[];
  /** True when the attempt was blocked by the cooldown or the per-session budget. */
  blocked: boolean;
}

/**
 * Recall quirks for a failed tool call and tier them by raw similarity.
 *
 * The recall happens ONCE, at the floor (`minScore`), so the caller can tell
 * "a confident match exists" from "only a probable match exists" from "no
 * match at all" without paying for a second embedding.
 *
 * This function does NOT mutate the injection state — the caller records the
 * attempt (and the injected ids) once it has decided what to inject.
 */
export async function recallToolErrorQuirks(
  recall: ToolErrorRecallFn,
  info: ToolErrorInfo,
  state: ToolErrorInjectionState,
  options?: ToolErrorRecallOptions,
): Promise<ToolErrorRecallResult> {
  const budgetAvailable = state.hasBudget();
  if (state.isCoolingDown(info)) {
    return { inject: [], candidates: [], blocked: true };
  }
  if (!budgetAvailable && options?.enforceBudget !== false) {
    return { inject: [], candidates: [], blocked: true };
  }

  const minScore = options?.minScore ?? TOOL_ERROR_DEFAULTS.minScore;
  const injectMinScore = options?.injectMinScore ?? minScore;
  const topK = options?.topK ?? TOOL_ERROR_DEFAULTS.topK;
  const minTokenOverlap = options?.minTokenOverlap ?? TOOL_ERROR_DEFAULTS.minTokenOverlap;

  let raw: readonly ToolErrorRecallHit[] = [];
  try {
    // Over-fetch so the lexical gate has candidates to choose from.
    raw = await recall(buildToolErrorQuery(info), { topK: Math.max(topK * 3, 6), minScore });
  } catch {
    // Recall failures must never break tool execution; the caller still
    // records the attempt so the cooldown applies.
    return { inject: [], candidates: [], blocked: false };
  }

  // Filter everything first, then sort and slice — otherwise the topK cut
  // would keep the first raw entries instead of the highest-scoring ones.
  const candidates: ToolErrorQuirkHit[] = [];
  for (const hit of raw) {
    const { id, content } = hit.chunk;
    if (minTokenOverlap > 0 && sharedWords(content, info.error) < minTokenOverlap) continue;
    candidates.push({
      id,
      content,
      quirkType: hit.chunk.metadata?.quirkType,
      score: hit.score,
      rawSimilarity: hit.rawSimilarity ?? hit.score,
    });
  }

  candidates.sort((a, b) => b.rawSimilarity - a.rawSimilarity);

  const inject = budgetAvailable
    ? candidates
        .filter((c) => c.rawSimilarity >= injectMinScore && !state.injectedQuirkIds.has(c.id))
        .slice(0, topK)
    : [];

  return { inject, candidates, blocked: false };
}

/**
 * Select quirks for a failed tool call.
 *
 * Returns `[]` when the state blocks the attempt (cooldown/budget) or nothing
 * passes the score, dedup, and lexical gates. Records the attempt in the state —
 * with cooldown always, with budget only when at least one quirk is returned.
 */
export async function selectToolErrorQuirks(
  recall: ToolErrorRecallFn,
  info: ToolErrorInfo,
  state: ToolErrorInjectionState,
  options?: ToolErrorRecallOptions,
): Promise<ToolErrorQuirkHit[]> {
  const result = await recallToolErrorQuirks(recall, info, state, options);
  if (result.blocked) return [];
  state.record(info, result.inject.map((h) => h.id));
  return result.inject;
}

/** Format the injection block appended to the next model request. Empty when there are no hits. */
export function formatToolErrorQuirkBlock(
  info: ToolErrorInfo,
  hits: readonly ToolErrorQuirkHit[],
  options?: { heading?: string },
): string {
  if (hits.length === 0) return "";
  const heading = options?.heading ?? `⚠ **Tool error** \`${info.tool}\` — matching quirk memory:`;
  const lines: string[] = ["", "---", heading, ""];
  for (const hit of hits) {
    const badge = hit.quirkType ? `[\`${hit.quirkType}\`] ` : "";
    lines.push(`- ${badge}${hit.content}`);
  }
  return lines.join("\n");
}

/**
 * Shape a tool error as an entry for the existing auto-capture pipeline
 * (`CaptureExchange.toolResults`). Feed the returned entry into the session's
 * tool-result list so recurring errors can become quirks at session end.
 */
export function toToolErrorCaptureEntry(info: ToolErrorInfo): { tool: string; output: string } {
  return {
    tool: `${info.tool} (error)`,
    output: info.error.slice(0, TOOL_ERROR_DEFAULTS.maxCaptureChars),
  };
}
