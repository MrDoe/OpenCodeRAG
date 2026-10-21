/**
 * @fileoverview Selective auto-injection of quirks.
 *
 * Both injection surfaces (`experimental.chat.system.transform` and
 * `chat.message`) used to carry a copy of the same gates. They drifted, and
 * neither logged what it decided, so a "quirk did not show up" report could
 * not be answered without reading the plugin source. This module is the one
 * implementation both call:
 *
 * 1. recall at the auto-inject semantic bar (raw vector similarity),
 * 2. drop quirks already injected in this session,
 * 3. apply the lexical gate against the user's CURRENT message,
 * 4. rank the survivors by *content-word* overlap, then similarity,
 * 5. cut to `topK`.
 *
 * Two deliberate differences from the previous inline copies:
 *
 * - **Over-fetch before gating.** Recall asks for several candidates, not
 *   `topK` of one. Before, a blocked top-1 produced an empty turn *and* stayed
 *   eligible for the next turn (it was never added to the injected set), so the
 *   same ineligible quirk was re-considered every turn while nothing was shown.
 * - **The gate needs one content word.** `sharedWords` counts tokens >= 3
 *   chars including filler ("the", "and", "does", "work"), so four shared
 *   tokens can be four stopwords. The gate now also requires at least one
 *   non-stopword token, and ranking prefers content-word overlap.
 *
 * No user text means no injection: a quirk must earn its place against what the
 * user actually asked, never against the assistant's previous message.
 */

import type { SearchResult } from "../core/interfaces.js";

/**
 * Filler tokens that must not satisfy the lexical gate on their own.
 *
 * Deliberately small and English-only: this is not a linguistics project, just
 * a guard against "the/and/does/this" style overlaps. Technical vocabulary is
 * never listed here — dropping a real identifier would weaken genuine matches.
 */
export const AUTO_INJECT_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "but", "for", "nor", "not", "yet", "you", "your", "yours",
  "with", "without", "from", "into", "onto", "over", "under", "about",
  "this", "that", "these", "those", "there", "their", "them", "they", "its",
  "are", "was", "were", "been", "being", "has", "have", "had", "does", "did",
  "doing", "done", "can", "could", "will", "would", "shall", "should", "may",
  "might", "must", "what", "when", "where", "which", "who", "whom", "whose",
  "why", "how", "all", "any", "some", "more", "most", "such", "only", "also",
  "just", "than", "then", "too", "very", "each", "every", "both", "few",
  "other", "same", "own", "out", "off", "again", "once", "here", "now",
  "after", "before", "during", "while", "because", "since", "until", "per",
  "via", "use", "uses", "used", "using", "get", "gets", "got", "make", "made",
  "does", "doing", "one", "two", "way", "want", "wants", "wanted", "need",
  "needs", "needed", "like", "works", "working",
]);

/** Split a text into lowercased word tokens of at least `minTokenLen` chars. */
export function tokenize(text: string, minTokenLen = 3): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= minTokenLen);
}

/** Distinct tokens shared by both texts (filler included). */
export function sharedTokenCount(a: string, b: string, minTokenLen = 3): number {
  const wordsA = new Set(tokenize(a, minTokenLen));
  const wordsB = new Set(tokenize(b, minTokenLen));
  let count = 0;
  for (const tok of wordsA) {
    if (wordsB.has(tok)) count++;
  }
  return count;
}

/**
 * Distinct *content* tokens shared by both texts — the same overlap with
 * `AUTO_INJECT_STOPWORDS` removed. This is the signal that decides whether a
 * quirk is actually about the user's request rather than about the word "work".
 */
export function contentOverlap(a: string, b: string, minTokenLen = 3): number {
  const wordsA = new Set(tokenize(a, minTokenLen));
  const wordsB = new Set(tokenize(b, minTokenLen));
  let count = 0;
  for (const tok of wordsA) {
    if (wordsB.has(tok) && !AUTO_INJECT_STOPWORDS.has(tok)) count++;
  }
  return count;
}

/** A quirk selected for injection, with the evidence that selected it. */
export interface AutoInjectHit {
  id: string;
  content: string;
  quirkType?: string;
  /** Confidence-weighted similarity as reported by `recallQuirks`. */
  score: number;
  /** Raw vector similarity (`(cosine + 1) / 2`), the auto-inject bar's domain. */
  rawSimilarity: number;
  /** Shared tokens including filler — the number the config threshold counts. */
  overlap: number;
  /** Shared non-filler tokens — the number ranking uses first. */
  contentOverlap: number;
}

/** Why a selection produced the hits it did (logged, never shown to the model). */
export type AutoInjectReason =
  | "ok"
  | "no-user-text"
  | "no-candidates"
  | "gate"
  | "already-injected"
  | "budget"
  | "recall-error";

/** The full outcome of one auto-inject attempt. */
export interface AutoInjectSelection {
  hits: AutoInjectHit[];
  /** Recall results before any gate (0..n). */
  considered: number;
  droppedByGate: number;
  droppedAlreadyInjected: number;
  reason: AutoInjectReason;
}

/** Recall function shape — `recallQuirks` bound to its deps and tag filter. */
export type AutoInjectRecall = (
  query: string,
  options: { topK: number; minScore: number; explain: true },
) => Promise<SearchResult[]>;

export interface AutoInjectOptions {
  topK: number;
  /** Minimum shared tokens (filler included) — `memory.autoInjectMinTokenOverlap`. */
  minTokenOverlap: number;
  /** Semantic bar — `memory.autoInjectMinScore`. */
  minScore: number;
  /** Quirks already injected in this session. */
  injectedIds?: ReadonlySet<string>;
  /** Extra recall candidates per injected slot (default 4, floor 8). */
  candidateMultiplier?: number;
}

/** Raw similarity of a recall result (falls back to the reported score). */
function rawSimilarityOf(r: SearchResult): number {
  return r.explanation?.scoreBreakdown?.rawVectorScore ?? r.score;
}

/**
 * Select the quirks to auto-inject for one turn.
 *
 * @param recall - Bound recall (`recallQuirks` with `excludeTags` applied).
 * @param args.query - Combined assistant + user text used for retrieval.
 * @param args.userText - The user's CURRENT message; the lexical gate runs on it.
 * @param args.options - Bars, topK, and the session's injected set.
 */
export async function selectAutoInjectQuirks(
  recall: AutoInjectRecall,
  args: { query: string; userText: string; options: AutoInjectOptions },
): Promise<AutoInjectSelection> {
  const { query, userText, options } = args;
  const empty = (
    reason: AutoInjectReason,
    extra: Partial<AutoInjectSelection> = {},
  ): AutoInjectSelection => ({
    hits: [],
    considered: 0,
    droppedByGate: 0,
    droppedAlreadyInjected: 0,
    reason,
    ...extra,
  });

  if (userText.trim().length === 0) return empty("no-user-text");
  if (query.trim().length === 0) return empty("no-candidates");

  const topK = Math.max(1, Math.floor(options.topK));
  const candidateK = Math.max(topK * (options.candidateMultiplier ?? 4), 8);

  let raw: SearchResult[];
  try {
    raw = await recall(query, { topK: candidateK, minScore: options.minScore, explain: true });
  } catch {
    return empty("recall-error");
  }
  if (raw.length === 0) return empty("no-candidates");

  const injected = options.injectedIds;
  let droppedAlreadyInjected = 0;
  let droppedByGate = 0;
  const eligible: AutoInjectHit[] = [];

  for (const r of raw) {
    const id = r.chunk.id;
    if (injected?.has(id)) {
      droppedAlreadyInjected++;
      continue;
    }
    const content = r.chunk.content;
    const overlap = sharedTokenCount(content, userText);
    const contentWords = contentOverlap(content, userText);
    // The threshold is the calibrated one; the content-word requirement is the
    // fix for filler-only matches ("the ... and ... does ... work").
    if (options.minTokenOverlap > 0 && (overlap < options.minTokenOverlap || contentWords < 1)) {
      droppedByGate++;
      continue;
    }
    eligible.push({
      id,
      content,
      quirkType: r.chunk.metadata?.quirkType,
      score: r.score,
      rawSimilarity: rawSimilarityOf(r),
      overlap,
      contentOverlap: contentWords,
    });
  }

  if (eligible.length === 0) {
    if (droppedAlreadyInjected > 0 && droppedByGate === 0) return empty("already-injected", { considered: raw.length, droppedAlreadyInjected });
    if (droppedByGate > 0) return empty("gate", { considered: raw.length, droppedByGate, droppedAlreadyInjected });
    return empty("no-candidates");
  }

  // Rank by what actually makes a quirk relevant to this turn: the number of
  // meaningful tokens it shares with the user's message, then the (also
  // overlap-based) total, then semantic similarity as the tie-breaker.
  eligible.sort(
    (a, b) =>
      b.contentOverlap - a.contentOverlap ||
      b.overlap - a.overlap ||
      b.rawSimilarity - a.rawSimilarity ||
      b.score - a.score,
  );

  return {
    hits: eligible.slice(0, topK),
    considered: raw.length,
    droppedByGate,
    droppedAlreadyInjected,
    reason: "ok",
  };
}

/**
 * `selectAutoInjectQuirks` under a latency budget.
 *
 * Auto-injection runs inside a model request; an embedding provider that is
 * slow (or down) must cost at most `budgetMs`. On timeout the result is an
 * empty selection with reason `"budget"` — the pending promise is NOT
 * cancelled, but nothing awaits it, so the request proceeds.
 */
export async function selectAutoInjectQuirksWithinBudget(
  recall: AutoInjectRecall,
  args: { query: string; userText: string; options: AutoInjectOptions },
  budgetMs: number,
): Promise<AutoInjectSelection> {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    return selectAutoInjectQuirks(recall, args);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<AutoInjectSelection>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          hits: [],
          considered: 0,
          droppedByGate: 0,
          droppedAlreadyInjected: 0,
          reason: "budget",
        }),
      budgetMs,
    );
  });
  try {
    return await Promise.race([selectAutoInjectQuirks(recall, args), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Render the block appended to the user message / prepended to the system prompt. */
export function formatAutoInjectBlock(
  hits: readonly AutoInjectHit[],
  options: { heading?: string; separator?: boolean } = {},
): string {
  const heading = options.heading ?? "⚠ **Quirk memory**";
  const separator = options.separator ?? true;
  const lines: string[] = [""];
  if (separator) lines.push("---");
  lines.push(heading, "");
  for (const h of hits) {
    const badge = h.quirkType ? `[\`${h.quirkType}\`] ` : "";
    lines.push(`- ${badge}${h.content}`);
  }
  return lines.join("\n");
}

/**
 * One-line, greppable description of a selection for the plugin log.
 *
 * Format: `injected=2 [quirk:a overlap=5 content=3 raw=0.81] found=6 gate=2 dup=1`
 */
export function describeAutoInjectSelection(selection: AutoInjectSelection): string {
  const parts: string[] = [];
  if (selection.hits.length > 0) {
    const hits = selection.hits
      .map((h) => `${h.id} overlap=${h.overlap} content=${h.contentOverlap} raw=${h.rawSimilarity.toFixed(3)}`)
      .join("; ");
    parts.push(`injected=${selection.hits.length} [${hits}]`);
  } else {
    parts.push(`injected=0 reason=${selection.reason}`);
  }
  parts.push(`found=${selection.considered}`);
  if (selection.droppedByGate > 0) parts.push(`gate=${selection.droppedByGate}`);
  if (selection.droppedAlreadyInjected > 0) parts.push(`dup=${selection.droppedAlreadyInjected}`);
  return parts.join(" ");
}
