/**
 * @fileoverview Single source of truth for the mandatory OpenCodeRAG tool-usage guidance
 * that is injected into both the runtime system prompt (via plugin.ts) and the AGENTS.md
 * directive (via workspace-helpers.ts).
 */

import type { OpenCodeShellConfig } from "../core/config.js";

/** Sentinel marker that opens the managed section. */
export const BEGIN_MARKER = "<!-- BEGIN opencode-rag -->";

/** Sentinel marker that closes the managed section. */
export const END_MARKER = "<!-- END opencode-rag -->";

/**
 * The positional rules that actually move behaviour. Measured on a live
 * workspace (2026-11-11): a flat wall of ~40 MUST/NEVER lines produced exactly
 * one mandated search in the first turn and abandonment afterwards (47 of 130
 * searching sessions called it once; 43 % of editing sessions never called it),
 * while a single ordering rule - the search goes IN the first tool batch - put
 * 78 % of first searches into user turn 1. Order is therefore stated before the
 * tool list, and this block is the only guidance text the compact AGENTS.md
 * directive carries. Shared verbatim by both carriers, so neither can drift.
 */
export const FIRST_MOVE_LINES: readonly string[] = [
  "First move, every task: `search_semantic` goes IN the first tool batch - an orientation call may share that batch, it never precedes it.",
  "Re-search when the working area changes: one search per area, not one per task.",
  "Authoritative elsewhere? When another system owns the current copy (source control, an MCP server, a database, an API), fetch it there first - `search_semantic` covers the local mirror and cross-cutting questions.",
  "A weak result is a lead, not an answer: read the printed relevance, then verify with `read` before concluding.",
];

/** One-line pointer used by the compact AGENTS.md directive. */
export const FULL_PROTOCOL_POINTER =
  "The full protocol (decision tree, proactive triggers, anti-patterns) is injected into the system prompt by the plugin - `openCode.injectSystemPrompt`. Do not restate it here.";

/**
 * How much guidance a generated `AGENTS.md` block carries.
 *
 * - `auto`: compact when the runtime injector will deliver the full protocol
 *   anyway, full when it will not. One carrier, one copy.
 * - `full`: the complete protocol in `AGENTS.md` (the pre-2.14 behaviour, and the
 *   result when the option is unset) - use it when `injectSystemPrompt` is off or
 *   when the file must stand alone (agents without the plugin, CI, humans).
 * - `compact`: always the short form, regardless of the injector.
 */
export type AgentGuidanceDetail = "auto" | "full" | "compact";

/**
 * Resolve a configured detail level into a concrete one.
 *
 * An unset level stays `"full"` so callers that know nothing about the injector
 * keep the standalone file they always produced.
 *
 * @param detail - The configured level.
 * @param injectedAtRuntime - Whether `openCode.injectSystemPrompt` will put the
 *   full protocol into the system prompt of sessions that have the tools.
 * @returns `"full"` or `"compact"`.
 */
export function resolveAgentsMdDetail(
  detail: AgentGuidanceDetail | undefined,
  injectedAtRuntime: boolean,
): "full" | "compact" {
  if (detail === "full" || detail === "compact") return detail;
  if (detail === "auto") return injectedAtRuntime ? "compact" : "full";
  return "full";
}

/**
 * The always-on mandatory guidance lines - tool list, decision tree,
 * proactive triggers, and anti-patterns. The runtime system prompt injector
 * uses these verbatim and additionally puts {@link FIRST_MOVE_LINES} first, so
 * the ordering rule is never buried under the list it governs.
 */
export const MANDATORY_GUIDANCE_LINES: readonly string[] = [
  "MANDATORY: OpenCodeRAG tools MUST be used before any code task:",
  "- `search_semantic(query)`: retrieve relevant code chunks. Call BEFORE planning, editing, or answering. Accepts `pathHints`, `languageHints`, and `fileExtensions`.",
  "- `get_file_skeleton(filePath)`: structural overview of a file. Call BEFORE reading any file.",
  "- `find_usages(symbolName)`: find all references. Call BEFORE editing any function, class, or variable.",
  "- `describe_image(filePath, systemPrompt?)`: describe an image file using a vision model. Call when user refers to a screenshot, diagram, or image. Optional `systemPrompt` steers the description toward specific features.",
  "- `recall_quirks(query)`: query experiential quirk memory (gotchas, preferences, decisions). Call when you hit an error or need to recall known pitfalls.",
  "- `add_quirk(content)`: store a new experiential memory. Call when you discover a non-obvious fact, gotcha, or coding convention.",
  "- `update_quirk(id, ...)`: fix an outdated or wrong quirk (content, type, tags, confidence, source ref). The ID is shown in `recall_quirks` output.",
  "- `delete_quirk(id)`: delete a quirk that is fixed, obsolete, or no longer applies. The ID is shown in `recall_quirks` output.",
  "",
  "Decision tree — ALWAYS follow this order:",
  "1. User mentions code behavior/architecture → `search_semantic(query)`",
  "2. User mentions a file path → `get_file_skeleton(filePath)` THEN `read` on specific lines",
  "3. User mentions a function/class/variable to edit → `find_usages(symbolName)` THEN `search_semantic` THEN `edit`",
  "4. User asks a code question → `search_semantic` to gather context before answering",
  "5. User asks about an image or visual asset → `describe_image(filePath)` (optionally pass `systemPrompt` to focus on specific features) to retrieve its generated description, then optionally `search_semantic` for related code",
  "6. You encounter an error or need to recall a known pitfall → `recall_quirks(query)`",
  "7. You discover a non-obvious fact or workaround → `add_quirk(content)` to persist it for future sessions",
  "8. A recalled quirk is outdated or wrong → `update_quirk(id, ...)` to fix it, or `delete_quirk(id)` if it no longer applies",
  "",
  "Proactive triggers — you MUST call these tools when:",
  "- User asks about code behavior, architecture, or implementation details",
  "- User asks to edit, refactor, or fix code — call `find_usages` first",
  "- User references files or functions you haven't read yet",
  "- User says \"find\", \"search\", \"look up\", \"where is\", \"how does\"",
  "- User refers to an image, screenshot, diagram, or visual asset",
  "- Before answering ANY code-related question, retrieve context first",
  "- Before reading ANY file, call `get_file_skeleton` to orient first",
  "",
  "Anti-patterns — NEVER do these:",
  "- Reading full files without calling `get_file_skeleton` first (wastes tokens)",
  "- Editing a function without calling `find_usages` first (breaks call sites)",
  "- Answering code questions without calling `search_semantic` first (you guess at behavior)",
  "- Using `grep`/`glob` when `search_semantic` would find the answer faster",
  "- Treating image files as text — use `describe_image` instead of reading raw bytes",
    "- Using `npx opencode-rag quirk` shell commands instead of the built-in quirk tools (`add_quirk` / `recall_quirks` / `update_quirk` / `delete_quirk`) (the tools are faster, already loaded in-process, and go through the trust monitor)",
];

/**
 * The conditional quirk-capture enforcement lines. Only included when
 * `memory.promptEnforcement` is true.
 */
export const QUIRK_ENFORCEMENT_LINES: readonly string[] = [
  "",
  "MANDATORY quirk capture rules — you MUST call `add_quirk` when:",
  "- A build, test, or type-check command fails and you resolve it",
  "- You discover an undocumented library constraint, peer dep, or workaround",
  "- You learn an environment-specific requirement (OS, tool version, etc.)",
  "- You make a design decision that future sessions should remember",
  "- You resolve a gotcha that cost more than one attempt",
  "",
  "MANDATORY quirk hygiene — you MUST call `update_quirk` or `delete_quirk` when:",
  "- A stored quirk is outdated, wrong, or has been fixed — update it or delete it instead of adding a contradicting duplicate",
  "",
  "Anti-pattern — NEVER finish a coding session without adding quirks for resolved errors.",
];

/**
 * The conditional decision-model guidance lines. Only included when
 * `decision.enabled` is true (the tool is not registered otherwise).
 */
export const DECISION_GUIDANCE_LINES: readonly string[] = [
  "- `make_decision(state, questions)`: classify, route, or score short text with the local tev1 decision model. Questions are `choice`, `noul`, or `score`; keep `state` short and don't rely on it alone for high-stakes decisions.",
];

/** Extra guidance line, only when `decision.routeBeforeAsking` is enabled. */
export const DECISION_ROUTING_GUIDANCE_LINE =
  "- Before asking the user to choose between options, route the decision through `make_decision` first — ask the user only when the model is undecided (low confidence) or the choice is a matter of personal preference.";

/**
 * Build the flat guidance lines array for the runtime system-prompt injector.
 * Returns a new array each call.
 */
export function buildShellBackgroundGuidanceLines(shell?: OpenCodeShellConfig): string[] {
  if (shell?.backgroundGuidance === false) return [];
  const thresholdMs = shell?.longRunningThresholdMs ?? 30000;
  const timeoutMs = shell?.foregroundTimeoutMs ?? 120000;
  const thresholdSec = Math.max(1, Math.round(thresholdMs / 1000));
  return [
    "",
    "Long-running commands:",
    `- Any \`shell\` call expected to take more than ${thresholdSec}s MUST set \`background: true\` (returns immediately; the session is notified on completion) or set an explicit \`timeout\` (ms).`,
    `- Default foreground timeout: ${timeoutMs}ms. Never run builds/tests/indexes in the foreground beyond ${thresholdSec}s; if a call is already running, press Ctrl+B to background it (OpenCode: \`session.background\`).`,
    "- OpenCodeRAG measures foreground shell duration and records a quirk when a call exceeds the threshold, so repeated foreground runs become visible.",
  ];
}

export function buildSystemGuidanceLines(opts: { promptEnforcement: boolean; decisionEnabled?: boolean; routeBeforeAsking?: boolean; shell?: OpenCodeShellConfig }): string[] {
  const lines = [...MANDATORY_GUIDANCE_LINES];
  // Positional rules go directly under the headline: the injector used to lead
  // with a 40-line list, and the ordering rule got skimmed (see FIRST_MOVE_LINES).
  lines.splice(1, 0, "", ...FIRST_MOVE_LINES);
  if (opts.decisionEnabled) {
    const decisionLines = [...DECISION_GUIDANCE_LINES];
    if (opts.routeBeforeAsking) {
      decisionLines.push(DECISION_ROUTING_GUIDANCE_LINE);
    }
    // Keep the tool list grouped: insert right after the describe_image line.
    const idx = lines.findIndex((line) => line.startsWith("- `describe_image"));
    if (idx >= 0) {
      lines.splice(idx + 1, 0, ...decisionLines);
    } else {
      lines.push(...decisionLines);
    }
  }
  if (opts.promptEnforcement) {
    lines.push(...QUIRK_ENFORCEMENT_LINES);
  }
  lines.push(...buildShellBackgroundGuidanceLines(opts.shell));
  return lines;
}

/**
 * The conditional decision-model section for the AGENTS.md directive. Only
 * included when `decision.enabled` is true.
 */
const DECISION_AGENTS_SECTION_LINES: readonly string[] = [
  "### Decision model (`make_decision`)",
  "",
  "- Classify, route, or score short text with the local tev1 model (`state` + 1-64 questions).",
  "- Question types: `choice` (options map to descriptions), `noul` (true/false probability), `score` (ordered rubric levels, lowest first).",
  "- Keep `state` short (~2k-token context); add a `none` option when no listed option may fit.",
  "- Never use it as the only check for a high-stakes decision.",
  "",
];

/** Extra directive bullet, only when `decision.routeBeforeAsking` is enabled. */
const DECISION_ROUTING_AGENTS_LINE =
  "- With `decision.routeBeforeAsking` enabled: route option choices through `make_decision` before asking the user; ask the user only when the model is undecided (low confidence) or the choice is preference-based.";

/**
 * The complete `AGENTS.md` directive body, without sentinel markers. This is the
 * standalone form and repeats the runtime protocol on purpose: a file that has to
 * work without the plugin (agents that do not load it, CI, a human reading the
 * repo) must carry the whole thing.
 */
export function buildFullAgentsMdLines(opts: { promptEnforcement: boolean; decisionEnabled?: boolean; routeBeforeAsking?: boolean; shell?: OpenCodeShellConfig }): string[] {
  const lines: string[] = [
    "## Code Navigation",
    "",
    "ALWAYS use OpenCodeRAG tools before reading or editing:",
    "- **Search first** — `search_semantic(query)` instead of grep/glob",
    "- **Skeleton before read** — `get_file_skeleton(filePath)` then read specific lines",
    "- **Usages before edit** — `find_usages(symbolName)` before modifying any symbol",
    "- **Images via describe** — `describe_image(filePath, systemPrompt?)` — never read raw bytes",
    "- **Recall quirks** — `recall_quirks(query)` when you hit a known pitfall",
    "- **Add quirks** — `add_quirk(content)` when you discover a non-obvious fact",
    "- **Fix quirks** — `update_quirk(id, ...)` / `delete_quirk(id)` when a stored quirk is outdated or wrong",
    "",
    "If no results, run `opencode-rag index`.",
    "",
    "### Decision tree — ALWAYS follow this order",
    "1. User mentions code behavior/architecture → `search_semantic(query)`",
    "2. User mentions a file path → `get_file_skeleton(filePath)` THEN `read` on specific lines",
    "3. User mentions a function/class/variable to edit → `find_usages(symbolName)` THEN `search_semantic` THEN `edit`",
    "4. User asks a code question → `search_semantic` to gather context before answering",
"5. User asks about an image or visual asset → `describe_image(filePath)` (optionally pass `systemPrompt` to focus on specific features) to retrieve its generated description, then optionally `search_semantic` for related code",
    "6. You encounter an error or need to recall a known pitfall → `recall_quirks(query)`",
    "7. You discover a non-obvious fact or workaround → `add_quirk(content)` to persist it for future sessions",
    "8. A recalled quirk is outdated or wrong → `update_quirk(id, ...)` to fix it, or `delete_quirk(id)` if it no longer applies",
    "",
    "### Proactive triggers — you MUST call these tools when",
    "- User asks about code behavior, architecture, or implementation details",
    "- User asks to edit, refactor, or fix code — call `find_usages` first",
    "- User references files or functions you haven't read yet",
    "- User says \"find\", \"search\", \"look up\", \"where is\", \"how does\"",
    "- User refers to an image, screenshot, diagram, or visual asset",
    "- Before answering ANY code-related question, retrieve context first",
    "- Before reading ANY file, call `get_file_skeleton` to orient first",
    "",
    "### Anti-patterns — NEVER do these",
    "- Reading full files without calling `get_file_skeleton` first (wastes tokens)",
    "- Editing a function without calling `find_usages` first (breaks call sites)",
    "- Answering code questions without calling `search_semantic` first (you guess at behavior)",
    "- Using `grep`/`glob` when `search_semantic` would find the answer faster",
    "- Treating image files as text — use `describe_image` instead of reading raw bytes",
  "- Using `npx opencode-rag quirk` shell commands instead of the built-in quirk tools (`add_quirk` / `recall_quirks` / `update_quirk` / `delete_quirk`) (the tools are faster, already loaded in-process, and go through the trust monitor)",
  ];

  if (opts.decisionEnabled) {
    const decisionSection = [...DECISION_AGENTS_SECTION_LINES];
    if (opts.routeBeforeAsking) {
      // Insert before the trailing blank line of the section.
      decisionSection.splice(decisionSection.length - 1, 0, DECISION_ROUTING_AGENTS_LINE);
    }
    // Place the decision section before the code-navigation decision tree.
    const idx = lines.indexOf("### Decision tree — ALWAYS follow this order");
    if (idx >= 0) {
      lines.splice(idx, 0, ...decisionSection);
    } else {
      lines.push(...decisionSection);
    }
  }

  if (opts.promptEnforcement) {
    lines.push(
      "",
      "### MANDATORY quirk capture rules — you MUST call `add_quirk` when",
      "- A build, test, or type-check command fails and you resolve it",
      "- You discover an undocumented library constraint, peer dep, or workaround",
      "- You learn an environment-specific requirement (OS, tool version, etc.)",
      "- You make a design decision that future sessions should remember",
      "- You resolve a gotcha that cost more than one attempt",
      "",
      "### MANDATORY quirk hygiene — you MUST call `update_quirk` or `delete_quirk` when",
      "- A stored quirk is outdated, wrong, or has been fixed — update it or delete it instead of adding a contradicting duplicate",
      "- NEVER finish a coding session without adding quirks for resolved errors.",
    );
  }

  const shellLines = buildShellBackgroundGuidanceLines(opts.shell);
  if (shellLines.length > 0) {
    lines.push("", "### Long-running commands", ...shellLines.filter((l) => l.trim().length > 0));
  }
  return lines;
}

/**
 * The short `AGENTS.md` directive body: the positional rules plus a tool index
 * and a pointer. Used when the runtime injector already ships the full protocol,
 * so the same ~40 lines do not arrive twice in one request.
 */
export function buildCompactAgentsMdLines(opts: { promptEnforcement: boolean; decisionEnabled?: boolean; routeBeforeAsking?: boolean; shell?: OpenCodeShellConfig }): string[] {
  const lines: string[] = [
    "## Code Navigation",
    "",
    "OpenCodeRAG indexes this workspace.",
    "",
    ...FIRST_MOVE_LINES.map((line) => `- ${line}`),
    "",
    "Tools: `search_semantic` finds code by meaning - use it before grep; `get_file_skeleton` before reading a file; `find_usages` before editing a symbol; `describe_image` for images, never raw bytes; `recall_quirks` / `add_quirk` / `update_quirk` / `delete_quirk` for experiential memory. Signatures live in the tool schema, not here.",
    "",
    "A search that returns nothing useful usually means the workspace is not indexed: run `opencode-rag index` (or `opencode-rag status` to check).",
  ];

  if (opts.decisionEnabled) {
    lines.push(
      "",
      opts.routeBeforeAsking
        ? "`make_decision(state, questions)` classifies/routes/scores short text with the local decision model; with `decision.routeBeforeAsking` set, route option choices through it before asking the user."
        : "`make_decision(state, questions)` classifies/routes/scores short text with the local decision model; never as the only check for a high-stakes decision.",
    );
  }
  if (opts.promptEnforcement) {
    lines.push(
      "",
      "Quirks: call `add_quirk` after resolving a failed build/test/type-check, an undocumented constraint, or a gotcha that cost more than one attempt; `update_quirk`/`delete_quirk` instead of storing a contradicting duplicate.",
    );
  }
  const shellLines = buildShellBackgroundGuidanceLines(opts.shell);
  if (shellLines.length > 0) {
    // Same heading as the full form; the plain in-list title is dropped.
    lines.push("", "### Long-running commands", ...shellLines.filter((l) => l.trim().length > 0).slice(1));
  }
  lines.push("", FULL_PROTOCOL_POINTER);
  return lines;
}

/**
 * Build the markdown-formatted `AGENTS.md` directive section, wrapped in sentinel
 * markers so `mergeAgentsMdContent` can replace it in place on re-runs.
 *
 * @param opts - Section switches plus `agentsMdDetail` (default `"auto"`: compact
 *   when the runtime injector is on, full when it is off).
 * @returns The marker-delimited section, without a trailing newline.
 */
export function buildAgentsMdDirective(opts: {
  promptEnforcement: boolean;
  decisionEnabled?: boolean;
  routeBeforeAsking?: boolean;
  shell?: OpenCodeShellConfig;
  agentsMdDetail?: AgentGuidanceDetail;
  injectedAtRuntime?: boolean;
}): string {
  const detail = resolveAgentsMdDetail(opts.agentsMdDetail, opts.injectedAtRuntime !== false);
  const body = detail === "compact" ? buildCompactAgentsMdLines(opts) : buildFullAgentsMdLines(opts);
  return [BEGIN_MARKER, ...body, END_MARKER].join("\n");
}
