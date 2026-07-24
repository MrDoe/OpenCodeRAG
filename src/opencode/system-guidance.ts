/**
 * @fileoverview Single source of truth for the mandatory OpenCodeRAG tool-usage guidance
 * that is injected into both the runtime system prompt (via plugin.ts) and the AGENTS.md
 * directive (via init-helpers.ts).
 */

/** Sentinel marker that opens the managed section. */
export const BEGIN_MARKER = "<!-- BEGIN opencode-rag -->";

/** Sentinel marker that closes the managed section. */
export const END_MARKER = "<!-- END opencode-rag -->";

/**
 * The always-on mandatory guidance lines — tool list, decision tree,
 * proactive triggers, and anti-patterns. Used verbatim by the runtime
 * system prompt injector.
 */
export const MANDATORY_GUIDANCE_LINES: readonly string[] = [
  "MANDATORY: OpenCodeRAG tools MUST be used before any code task:",
  "- `search_semantic(query)`: retrieve relevant code chunks. Call BEFORE planning, editing, or answering. Accepts `pathHints` and `languageHints`.",
  "- `get_file_skeleton(filePath)`: structural overview of a file. Call BEFORE reading any file.",
  "- `find_usages(symbolName)`: find all references. Call BEFORE editing any function, class, or variable.",
  "- `describe_image(filePath)`: describe an image file using a vision model. Call when user refers to a screenshot, diagram, or image.",
  "- `recall_quirks(query)`: query experiential quirk memory (gotchas, preferences, decisions). Call when you hit an error or need to recall known pitfalls.",
  "- `add_quirk(content)`: store a new experiential memory. Call when you discover a non-obvious fact, gotcha, or coding convention.",
  "",
  "Decision tree — ALWAYS follow this order:",
  "1. User mentions code behavior/architecture → `search_semantic(query)`",
  "2. User mentions a file path → `get_file_skeleton(filePath)` THEN `read` on specific lines",
  "3. User mentions a function/class/variable to edit → `find_usages(symbolName)` THEN `search_semantic` THEN `edit`",
  "4. User asks a code question → `search_semantic` to gather context before answering",
  "5. User asks about an image or visual asset → `describe_image(filePath)` to retrieve its generated description, then optionally `search_semantic` for related code",
  "6. You encounter an error or need to recall a known pitfall → `recall_quirks(query)`",
  "7. You discover a non-obvious fact or workaround → `add_quirk(content)` to persist it for future sessions",
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
  "- Using `npx opencode-rag quirk` shell commands instead of the built-in `add_quirk` / `recall_quirks` tools (the tools are faster, already loaded in-process, and go through the trust monitor)",
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
  "Anti-pattern — NEVER finish a coding session without adding quirks for resolved errors.",
];

/**
 * Build the flat guidance lines array for the runtime system-prompt injector.
 * Returns a new array each call.
 */
export function buildSystemGuidanceLines(opts: { promptEnforcement: boolean }): string[] {
  const lines = [...MANDATORY_GUIDANCE_LINES];
  if (opts.promptEnforcement) {
    lines.push(...QUIRK_ENFORCEMENT_LINES);
  }
  return lines;
}

/**
 * Build the markdown-formatted AGENTS.md directive section, wrapped in sentinel
 * markers so `mergeAgentsMdContent` can replace it in place on re-runs.
 */
export function buildAgentsMdDirective(opts: { promptEnforcement: boolean }): string {
  const lines: string[] = [
    BEGIN_MARKER,
    "## Code Navigation",
    "",
    "ALWAYS use OpenCodeRAG tools before reading or editing:",
    "- **Search first** — `search_semantic(query)` instead of grep/glob",
    "- **Skeleton before read** — `get_file_skeleton(filePath)` then read specific lines",
    "- **Usages before edit** — `find_usages(symbolName)` before modifying any symbol",
    "- **Images via describe** — `describe_image(filePath)` — never read raw bytes",
    "- **Recall quirks** — `recall_quirks(query)` when you hit a known pitfall",
    "- **Add quirks** — `add_quirk(content)` when you discover a non-obvious fact",
    "",
    "If no results, run `opencode-rag index`.",
    "",
    "### Decision tree — ALWAYS follow this order",
    "1. User mentions code behavior/architecture → `search_semantic(query)`",
    "2. User mentions a file path → `get_file_skeleton(filePath)` THEN `read` on specific lines",
    "3. User mentions a function/class/variable to edit → `find_usages(symbolName)` THEN `search_semantic` THEN `edit`",
    "4. User asks a code question → `search_semantic` to gather context before answering",
    "5. User asks about an image or visual asset → `describe_image(filePath)` to retrieve its generated description, then optionally `search_semantic` for related code",
    "6. You encounter an error or need to recall a known pitfall → `recall_quirks(query)`",
    "7. You discover a non-obvious fact or workaround → `add_quirk(content)` to persist it for future sessions",
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
    "- Using `npx opencode-rag quirk` shell commands instead of the built-in `add_quirk` / `recall_quirks` tools (the tools are faster, already loaded in-process, and go through the trust monitor)",
  ];

  if (opts.promptEnforcement) {
    lines.push(
      "",
      "### MANDATORY quirk capture rules — you MUST call `add_quirk` when",
      "- A build, test, or type-check command fails and you resolve it",
      "- You discover an undocumented library constraint, peer dep, or workaround",
      "- You learn an environment-specific requirement (OS, tool version, etc.)",
      "- You make a design decision that future sessions should remember",
      "- You resolve a gotcha that cost more than one attempt",
      "- NEVER finish a coding session without adding quirks for resolved errors.",
    );
  }

  lines.push(END_MARKER);
  return lines.join("\n");
}
