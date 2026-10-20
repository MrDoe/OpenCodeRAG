/**
 * @fileoverview Tool-error → quirk creation: when a tool call fails and NO
 * existing quirk covers the failure, record a new one so future sessions can
 * recall it.
 *
 * Design notes:
 * - Pure and dependency-injected: the caller passes an `add` function (the plugin
 *   binds `addQuirk`), so this module has no store/embedder dependencies and is
 *   cheap to unit-test.
 * - Deterministic content: no LLM is involved. The quirk is a template built
 *   from the tool name and the error text, plus an optional deterministic cause
 *   for a handful of well-known error classes. This keeps the path available
 *   even when `description.enabled` is false (the LLM-based auto-capture
 *   pipeline is inert then) and keeps it off the critical latency path.
 * - Bounded: a per-session budget and a per-error-signature cooldown cap how
 *   many quirks a failing session can write. Cross-session duplication is
 *   prevented by the semantic recall that runs BEFORE creation — the quirk
 *   written for a failure is recalled on the next occurrence of that failure.
 * - The trust monitor is NOT bypassed. A rejected quirk (e.g. an error text
 *   that contains `rm -rf`) is reported as "not created" with a reason; the
 *   caller logs it.
 */

import type { Quirk, QuirkInput } from "./types.js";
import {
  TOOL_ERROR_AUTO_TAG,
  TOOL_ERROR_CAUSE_TAG_PREFIX,
  TOOL_ERROR_QUIRK_TAG,
  TOOL_ERROR_TOOL_TAG_PREFIX,
} from "./types.js";
import { normalizeToolErrorSignature, type ToolErrorInfo } from "./tool-error-recall.js";

export {
  TOOL_ERROR_AUTO_TAG,
  TOOL_ERROR_CAUSE_TAG_PREFIX,
  TOOL_ERROR_QUIRK_TAG,
  TOOL_ERROR_TOOL_TAG_PREFIX,
};

/** Defaults for the tool-error creation path. */
export const TOOL_ERROR_CREATE_DEFAULTS = {
  /**
   * Minimum raw similarity for a candidate to count as "an equivalent quirk
   * already exists" (and therefore suppress creation). Default 0.7 — the
   * injection bar. Measured: an error query scores 0.55-0.63 against
   * ARBITRARY stored quirks, so a lower floor sits inside the noise band and
   * matches unrelated quirks, which suppresses creation on every real failure.
   * The exact duplicate check is done by metadata instead — see
   * `hasEquivalentToolGotcha`.
   */
  minScore: 0.7,
  /** Maximum quirks created per session. Default 2. */
  maxPerSession: 2,
  /** Cooldown per normalized error signature in ms. Default 10 minutes. */
  cooldownMs: 600_000,
  /** Error text is truncated to this length before it becomes quirk content. */
  maxErrorChars: 400,
  /** Hard cap on the generated quirk content. */
  maxContentChars: 300,
  /** Confidence assigned to an auto-created quirk. */
  confidence: 0.6,
  /** Errors shorter than this carry no information — nothing is recorded. */
  minErrorChars: 15,
  /** Max tool gotchas injected proactively into the system prompt. Default 5. */
  maxProactiveItems: 5,
} as const;

/** Known error classes with a deterministic, actionable cause. */
const ERROR_CAUSES: { cls: string; pattern: RegExp; cause: string }[] = [
  {
    cls: "unknown-tool",
    pattern: /unknown tool|no such tool|tool .*not found|not a registered tool/i,
    cause: "the tool name may be wrong, or the tool is not available in this session",
  },
  {
    cls: "schema",
    pattern: /expected .*(received|but got)|invalid argument|invalid type|schema|must be (a|an|string|number|boolean|object|array)/i,
    cause: "the arguments do not match the tool's schema",
  },
  {
    cls: "permissions",
    pattern: /eacces|permission denied/i,
    cause: "the path may need different permissions",
  },
  {
    cls: "path",
    pattern: /enoent|no such file or directory|cannot find module/i,
    cause: "the path or module name may be wrong",
  },
  {
    cls: "rate-limit",
    pattern: /\b429\b|rate limit|too many requests/i,
    cause: "the request was rate limited — retry later",
  },
  {
    cls: "timeout",
    pattern: /timed? ?out|timeout|etimedout/i,
    cause: "the operation timed out",
  },
];

/**
 * Cause classes that are worth surfacing BEFORE the tool is called.
 *
 * A transient failure (rate limit, timeout) must NOT be warned about in
 * advance — the next call will not fail the same way, and the warning would
 * be misleading. An unclassified error is excluded for the same reason: we do
 * not know whether it is durable, and a raw error dump says what happened,
 * not what to do.
 */
export const PROACTIVE_CAUSE_CLASSES: ReadonlySet<string> = new Set([
  "unknown-tool",
  "schema",
  "permissions",
  "path",
]);

/** A classified tool-error cause. */
export interface ToolErrorCause {
  /** Stable class name — also used as the `cause:<class>` tag. */
  cls: string;
  /** Human-readable guidance appended to the quirk content. */
  cause: string;
}

/**
 * Classify an error message into a cause class plus its guidance.
 *
 * Returns `undefined` for unknown errors — the raw text is then the whole
 * story.
 */
export function classifyToolErrorCause(error: string): ToolErrorCause | undefined {
  for (const { cls, pattern, cause } of ERROR_CAUSES) {
    if (pattern.test(error)) return { cls, cause };
  }
  return undefined;
}

/**
 * Classify an error message into a short, deterministic cause.
 *
 * Returns `undefined` for unknown errors — the raw text is then the whole
 * story.
 */
export function classifyToolError(error: string): string | undefined {
  return classifyToolErrorCause(error)?.cause;
}

/**
 * Build the quirk content for a failed tool call.
 *
 * The tool name and the error text are embedded verbatim (whitespace
 * collapsed, truncated) on purpose: a later occurrence of the same failure
 * must share tokens with this content (the lexical recall gate) and embed
 * close to it (the semantic gate), otherwise the creation path would fire
 * again and again for the same error.
 */
export function buildToolErrorQuirkContent(info: ToolErrorInfo): string {
  const error = info.error
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TOOL_ERROR_CREATE_DEFAULTS.maxErrorChars);
  const cause = classifyToolError(info.error);
  const base = `Tool \`${info.tool}\` failed: ${error}`;
  const content = cause ? `${base} — ${cause}` : base;
  return content.slice(0, TOOL_ERROR_CREATE_DEFAULTS.maxContentChars);
}

/** True when the error carries enough information to be worth recording. */
export function isWorthRecordingToolError(info: ToolErrorInfo): boolean {
  return info.error.replace(/\s+/g, " ").trim().length >= TOOL_ERROR_CREATE_DEFAULTS.minErrorChars;
}

/** Tunables for the per-session creation state. */
export interface ToolErrorCreateOptions {
  /** Maximum quirks created per session. Default 2. */
  maxPerSession?: number;
  /** Cooldown per normalized error signature in ms. Default 600000 (10 min). */
  cooldownMs?: number;
}

/** Per-session creation bookkeeping (budget, cooldown, created signatures). */
export interface ToolErrorCreateState {
  /** True when a new quirk may be created (budget left, signature not cooling down). */
  shouldCreate(info: ToolErrorInfo, now?: number): boolean;
  /** Record the attempt. Always refreshes the cooldown; consumes budget only when `created` is true. */
  record(info: ToolErrorInfo, created: boolean, now?: number): void;
  /** Normalized error signatures that already produced a quirk in this session. */
  readonly createdSignatures: ReadonlySet<string>;
  /** Number of quirks actually created in this session. */
  creationCount(): number;
}

/** Create the per-session creation state. */
export function createToolErrorCreateState(
  options?: ToolErrorCreateOptions,
): ToolErrorCreateState {
  const cooldownMs = options?.cooldownMs ?? TOOL_ERROR_CREATE_DEFAULTS.cooldownMs;
  const maxPerSession = options?.maxPerSession ?? TOOL_ERROR_CREATE_DEFAULTS.maxPerSession;

  const lastAttemptAt = new Map<string, number>();
  const createdSignatures = new Set<string>();
  let creations = 0;

  return {
    shouldCreate(info: ToolErrorInfo, now: number = Date.now()): boolean {
      if (creations >= maxPerSession) return false;
      const signature = normalizeToolErrorSignature(info);
      const last = lastAttemptAt.get(signature);
      if (last !== undefined && now - last < cooldownMs) return false;
      return true;
    },

    record(info: ToolErrorInfo, created: boolean, now: number = Date.now()): void {
      const signature = normalizeToolErrorSignature(info);
      lastAttemptAt.set(signature, now);
      if (!created) return;
      creations += 1;
      createdSignatures.add(signature);
    },

    get createdSignatures(): ReadonlySet<string> {
      return createdSignatures;
    },

    creationCount(): number {
      return creations;
    },
  };
}

/** The function that persists a quirk; injected so the module stays testable. */
export type ToolErrorQuirkAddFn = (input: QuirkInput) => Promise<Quirk>;

/** Dependencies for the creation path. */
export interface ToolErrorQuirkDeps {
  /** Persists the quirk. The plugin binds `addQuirk` to the quirk store deps. */
  add: ToolErrorQuirkAddFn;
}

/** The outcome of a creation attempt. */
export interface ToolErrorQuirkCreateResult {
  /** True when a quirk was written. */
  created: boolean;
  /** The new quirk's id (only when `created`). */
  id?: string;
  /** Why nothing was created (e.g. trust-monitor rejection, error too short). */
  reason?: string;
}

/**
 * Create and persist a quirk for a failed tool call.
 *
 * Never throws: a trust-monitor rejection or a store failure is reported as
 * `created: false` with a reason so the caller can log it and carry on.
 */
export async function createToolErrorQuirk(
  deps: ToolErrorQuirkDeps,
  info: ToolErrorInfo,
  content?: string,
): Promise<ToolErrorQuirkCreateResult> {
  if (!isWorthRecordingToolError(info)) {
    return { created: false, reason: "error text too short to record" };
  }

  const text = (content ?? buildToolErrorQuirkContent(info)).trim();
  if (!text) {
    return { created: false, reason: "empty quirk content" };
  }

  // The cause class is what makes a gotcha usable PROACTIVELY: a transient
  // failure must not be warned about before the next call.
  const cause = classifyToolErrorCause(info.error);
  const tags = [TOOL_ERROR_QUIRK_TAG, TOOL_ERROR_AUTO_TAG, `tool:${info.tool}`];
  if (cause) tags.push(`${TOOL_ERROR_CAUSE_TAG_PREFIX}${cause.cls}`);

  try {
    const quirk = await deps.add({
      content: text,
      quirkType: "gotcha",
      tags,
      confidence: TOOL_ERROR_CREATE_DEFAULTS.confidence,
      sourceRef: `tool-error:${info.tool}`,
    });
    return { created: true, id: quirk.id };
  } catch (err) {
    return { created: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** A stored tool gotcha, ready to be surfaced proactively. */
export interface ToolGotcha {
  /** The tool the gotcha is about (lowercase). */
  tool: string;
  /** The quirk content — the lesson learned from the failure. */
  content: string;
  /** The quirk id, for `update_quirk` / `delete_quirk`. */
  quirkId: string;
}

/**
 * Pick the tool gotchas that are actionable for the tools a session can call.
 *
 * A gotcha about a tool the model cannot invoke is noise, so the tool name
 * is matched against the session's tool catalog. This is a metadata scan, not
 * a semantic recall: the question is "does a quirk exist for THIS tool", not
 * "which quirk is most similar to the current request".
 *
 * @param quirks - Tool-error quirks, newest first.
 * @param toolNames - The tool names the session may call.
 * @param maxItems - Maximum number of gotchas to return.
 */
export function selectToolGotchas(
  quirks: readonly Pick<Quirk, "id" | "content" | "tags">[],
  toolNames: readonly string[],
  maxItems: number = TOOL_ERROR_CREATE_DEFAULTS.maxProactiveItems,
): ToolGotcha[] {
  if (toolNames.length === 0 || maxItems <= 0) return [];
  const callable = new Set(toolNames.map((t) => t.toLowerCase()));
  const gotchas: ToolGotcha[] = [];
  for (const q of quirks) {
    const tags = q.tags ?? [];
    if (!tags.includes(TOOL_ERROR_QUIRK_TAG)) continue;
    const toolTag = tags.find((t) => t.startsWith(TOOL_ERROR_TOOL_TAG_PREFIX));
    if (!toolTag) continue;
    const tool = toolTag.slice(TOOL_ERROR_TOOL_TAG_PREFIX.length).toLowerCase();
    if (!callable.has(tool)) continue;
    // Only durable, actionable causes are worth warning about in advance.
    const causeTag = tags.find((t) => t.startsWith(TOOL_ERROR_CAUSE_TAG_PREFIX));
    if (!causeTag) continue;
    const cls = causeTag.slice(TOOL_ERROR_CAUSE_TAG_PREFIX.length);
    if (!PROACTIVE_CAUSE_CLASSES.has(cls)) continue;
    gotchas.push({ tool, content: q.content, quirkId: q.id });
    if (gotchas.length >= maxItems) break;
  }
  return gotchas;
}

/**
 * Is there already a tool-error quirk for this tool AND cause class?
 *
 * The exact duplicate check. A semantic similarity floor cannot do this job:
 * an error query scores 0.55-0.63 against arbitrary stored quirks, so any
 * floor low enough to catch a genuine duplicate also catches noise — which
 * silently suppressed creation on every real failure. The tags make the
 * check exact: a quirk created for `write` + `schema` is the same lesson as
 * the next `write` + `schema` failure, whatever the error text says.
 *
 * @param quirks - The stored tool-error quirks.
 * @param tool - The failing tool name.
 * @param causeClass - The classified cause class (e.g. "schema").
 */
export function hasEquivalentToolGotcha(
  quirks: readonly Pick<Quirk, "tags">[],
  tool: string,
  causeClass: string,
): boolean {
  const toolTag = `${TOOL_ERROR_TOOL_TAG_PREFIX}${tool.toLowerCase()}`;
  const causeTag = `${TOOL_ERROR_CAUSE_TAG_PREFIX}${causeClass}`;
  return quirks.some(
    (q) => (q.tags ?? []).includes(toolTag) && (q.tags ?? []).includes(causeTag),
  );
}

/**
 * Format the proactive tool-gotcha block for the system prompt.
 *
 * Injected BEFORE the model chooses a tool, so a known failure is not
 * repeated in a later session. Empty when there are no gotchas.
 */
export function formatToolGotchaBlock(gotchas: readonly ToolGotcha[]): string {
  if (gotchas.length === 0) return "";
  const lines = [
    "",
    "---",
    "⚠ **Known tool gotchas** — these tools failed before. Check before calling them:",
    "",
  ];
  for (const g of gotchas) {
    lines.push(`- ${g.content}`);
  }
  return lines.join("\n");
}
