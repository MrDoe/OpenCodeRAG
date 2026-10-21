/**
 * @fileoverview Detection of failures on the surfaces OpenCode does NOT
 * report as tool errors.
 *
 * The host only flags a tool call as an error when it rejects the call itself
 * (schema/argument validation). Everything else arrives as a COMPLETED tool
 * call whose output merely mentions the failure: a command that exits
 * non-zero, a script that raises, a file that cannot be read. The quirk path
 * was blind to all of them, so the most common real failure in an agent
 * session was never learned from and never answered from memory.
 *
 * This module turns such an output into a `DetectedError`. It is deliberately
 * conservative: every rule matches a marker that a real failure produces.
 * A false positive is not free — it costs a recall, a possible quirk write,
 * and an injected block in the next model request — so the generic
 * `Error:`-anywhere and localized "not found" heuristics are deliberately
 * NOT here.
 *
 * Pure and dependency-free, so it is cheap to unit-test.
 */

/** Which surface an error was detected on. */
export type ErrorSource = "host" | "output" | "session";

/** A failure detected on a surface the host does not report as an error. */
export interface DetectedError {
  /**
   * Normalized text used for the recall query and for the quirk content.
   * Deliberately short: it is the failure's own message plus the marker that
   * identified it, never the whole (possibly huge) tool output.
   */
  text: string;
  /** The tool the failure came from; absent for session-level errors. */
  tool?: string;
  /** The surface that produced the signal. */
  source: ErrorSource;
  /**
   * A stable cause class, used as the `cause:<class>` tag when the generic
   * classifier cannot derive one. Stable per failure KIND, which is what
   * keeps the exact duplicate check working across sessions.
   */
  causeClass?: string;
}

/** Tunables for the output scanner. */
export interface OutputErrorOptions {
  /** Only the tail of the output is scanned (default 20000 chars). */
  maxScanChars?: number;
  /** Max characters of the failure message kept in the error text (default 200). */
  maxMessageChars?: number;
  /**
   * The tool's structured exit code, when it reports one. A non-zero code is
   * DEFINITIVE — no text marker is needed, and none is looked for. Measured
   * live 2026-10-21: OpenCode's shell tool reports `{ status, truncated, exit }`
   * in the result metadata.
   */
  exitCode?: number;
}

/** ANSI escape sequences — stripped before matching. */
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

/**
 * OpenCode's shell tool appends `Exited with code N` to the output when the
 * command exits non-zero. Measured live 2026-10-21: this marker is the ONLY
 * machine-readable failure signal in a command's output — the exit code is
 * not reported anywhere else, and the host still reports the call as
 * `status=completed`. The marker is emitted in red, hence the ANSI strip.
 */
const EXIT_CODE_PATTERN = /(?:^|\n)\s*(?:Error:\s*)?Exited with code\s+(\d+)/i;

/** Node errno codes — a precise "this operation failed" signal. */
const ERRNO_PATTERN = /\b(ENOENT|ENOTFOUND|EISDIR|ENOTDIR|EEXIST|ELOOP|ENOTEMPTY|ENAMETOOLONG)\b/;

/** Python's uncaught-exception marker. */
const TRACEBACK_PATTERN = /Traceback \(most recent call last\)/;

/** Node/JS uncaught exception types, anchored to the start of a line. */
const JS_EXCEPTION_PATTERN = /^(?:Type|Reference|Syntax|Range|URI)Error:/m;

/** npm's own failure marker. */
const NPM_ERROR_PATTERN = /^npm ERR!/m;

/** Process-level crashes. */
const CRASH_PATTERN = /Segmentation fault|core dumped|panic:|Killed$/m;

/** OpenCode's shell tool reports some failures as "Command failed". */
const COMMAND_FAILED_PATTERN = /Command failed/i;

/** The RAG read override's own failure message. */
const READ_FALLBACK_PATTERN = /^Could not read file:/i;

/**
 * Tools whose output is a COMMAND's stdout/stderr.
 *
 * The text rules describe a failed command. Applying them to a tool that
 * returns FILE CONTENT produces false positives: measured live 2026-10-21, a
 * `grep` whose match mentioned "EACCES" and a `read` of a file documenting
 * "EACCES / EPERM" were both reported as failures — and each wrote a quirk.
 * The structured exit code (below) is the reliable signal; the text rules are
 * the fallback for tools that report no exit code.
 */
const COMMAND_TOOLS: ReadonlySet<string> = new Set([
  "shell",
  "bash",
  "sh",
  "run",
  "exec",
  "command",
]);

/** Rules that apply to tools which are NOT command runners. */
const NON_COMMAND_RULES: readonly OutputRule[] = [
  { cause: "path", pattern: READ_FALLBACK_PATTERN },
];

/** One failure marker. */
interface OutputRule {
  /** Stable cause class recorded as the `cause:<class>` tag. */
  cause: string;
  /** Matches the failure marker. */
  pattern: RegExp;
  /**
   * Optional filter on the match — used by the exit-code rule to reject
   * `Exited with code 0`.
   */
  accept?: (match: RegExpMatchArray) => boolean;
  /**
   * When true the marker line itself is NOT the message — the interesting
   * text is the line before it (the command's own error output).
   */
  markerIsNotMessage?: boolean;
}

/**
 * Rules in priority order: the first match wins. Order matters — a
 * `ENOENT` in a command's output is a more actionable cause than "the
 * command exited non-zero", so it is checked first.
 */
const OUTPUT_RULES: readonly OutputRule[] = [
  { cause: "permissions", pattern: /\b(EACCES|EPERM)\b/ },
  { cause: "path", pattern: ERRNO_PATTERN },
  { cause: "runtime", pattern: TRACEBACK_PATTERN },
  { cause: "runtime", pattern: JS_EXCEPTION_PATTERN },
  { cause: "tooling", pattern: NPM_ERROR_PATTERN },
  { cause: "crash", pattern: CRASH_PATTERN },
  { cause: "exit-code", pattern: COMMAND_FAILED_PATTERN },
  { cause: "path", pattern: READ_FALLBACK_PATTERN },
  {
    cause: "exit-code",
    pattern: EXIT_CODE_PATTERN,
    accept: (match) => Number(match[1]) !== 0,
    markerIsNotMessage: true,
  },
];

/** Strip ANSI colour codes. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** Split into trimmed, non-empty lines. */
function toLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The line that carries the most information about the failure: the first
 * line matching the rule. Falls back to the first non-empty line.
 */
function pickMessageLine(lines: readonly string[], pattern: RegExp, maxChars: number): string {
  for (const line of lines) {
    if (pattern.test(line)) return line.slice(0, maxChars);
  }
  return lines[0]?.slice(0, maxChars) ?? "";
}

/**
 * Detect a failure in a tool's output.
 *
 * Returns `undefined` when the output carries no failure marker. A tool that
 * succeeded produces no match, so the common case costs one regex pass over
 * the (capped) output.
 */
export function detectOutputError(
  tool: string,
  output: string,
  options?: OutputErrorOptions,
): DetectedError | undefined {
  if (!output || output.trim().length === 0) return undefined;

  const maxScanChars = options?.maxScanChars ?? 20_000;
  const maxMessageChars = options?.maxMessageChars ?? 200;
  // Errors are reported at the END of a command's output, so scan the tail.
  const scanned = stripAnsi(output.length > maxScanChars ? output.slice(-maxScanChars) : output);
  const lines = toLines(scanned);

  // A structured exit code is AUTHORITATIVE when the tool reports one: a
  // non-zero code means the command failed (no marker required, and none is
  // looked for), and a zero code means it SUCCEEDED — so a marker-looking
  // string in its output (a doc example mentioning ENOENT, a grep for
  // "Error:") is not a failure. This is the strongest signal available and
  // it beats the text rules below, which can misread a localized message.
  const exitCode = options?.exitCode;
  if (typeof exitCode === "number") {
    if (exitCode === 0) return undefined;
    const own = lines.filter((line) => !/^Exited with code/i.test(line));
    const message = (own[own.length - 1] ?? "").slice(0, maxMessageChars);
    const marker = `Exited with code ${exitCode}`;
    const text = [message, marker].filter((part) => part.length > 0).join("\n").slice(0, 400);
    return { text, tool, source: "output", causeClass: "exit-code" };
  }

  if (lines.length === 0) return undefined;

  // Only a command's output can carry a command-failure marker. A tool that
  // returns file content is exempt — except for the plugin's own read
  // failure message, which is the whole output when it happens.
  const rules = COMMAND_TOOLS.has(tool.toLowerCase()) ? OUTPUT_RULES : NON_COMMAND_RULES;

  for (const rule of rules) {
    const match = scanned.match(rule.pattern);
    if (!match) continue;
    if (rule.accept && !rule.accept(match)) continue;

    let message: string;
    if (rule.markerIsNotMessage) {
      // The marker is OpenCode's own annotation — the useful text is the
      // command's own error output, which sits just above it.
      const markerIndex = lines.findIndex((line) => rule.pattern.test(line));
      const before = markerIndex > 0 ? lines.slice(0, markerIndex) : lines;
      const own = before.filter((line) => !/^Exited with code/i.test(line));
      message = own[own.length - 1]?.slice(0, maxMessageChars) ?? "";
    } else {
      message = pickMessageLine(lines, rule.pattern, maxMessageChars);
    }

    // The marker is always part of the text: it is the stable part of the
    // failure and it is what makes the cause class (and therefore the
    // duplicate check) stable across occurrences. It is omitted when the
    // message already carries it.
    const marker = match[0].trim().replace(/^(?:Error:\s*)?/i, "").slice(0, 80);
    const parts = message.includes(marker) ? [message] : [message, marker];
    const text = parts.filter((part) => part.length > 0).join("\n").slice(0, 400);

    return { text, tool, source: "output", causeClass: rule.cause };
  }

  return undefined;
}

/**
 * Read a tool result's structured exit code.
 *
 * The shell tool reports `{ status, truncated, exit }` in its result metadata
 * (measured live 2026-10-21). A non-zero code means the command failed.
 */
export function extractExitCode(metadata: unknown): number | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const record = metadata as Record<string, unknown>;
  for (const key of ["exit", "exitCode"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Detect a session-level error (a failed model call, a provider error).
 *
 * The `session.error` event carries an `error` object whose shape differs
 * between OpenCode versions, so the message is dug out defensively.
 */
export function detectSessionError(error: unknown): DetectedError | undefined {
  const message = extractErrorMessage(error);
  if (!message || message.length < 10) return undefined;
  return { text: message.slice(0, 400), source: "session" };
}

/** Dig a human-readable message out of an error payload of unknown shape. */
export function extractErrorMessage(error: unknown): string | undefined {
  if (typeof error === "string") return error.trim() || undefined;
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  for (const key of ["message", "error", "reason", "detail", "stack"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (value && typeof value === "object") {
      const nested = extractErrorMessage(value);
      if (nested) return nested;
    }
  }
  const name = typeof record["name"] === "string" ? record["name"] : undefined;
  return name;
}
