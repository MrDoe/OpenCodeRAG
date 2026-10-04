/**
 * @fileoverview Markdown formatting for decision answers, shared by the
 * OpenCode plugin tool, the MCP handler, and the CLI command.
 */
import type { DecisionAnswer } from "../core/interfaces.js";

/** Optional provenance header fields. */
export interface DecisionFormatOptions {
  /** Provider name (e.g. "ollama"). */
  provider?: string;
  /** Model name (e.g. "tev1:0.8b"). */
  model?: string;
}

/** Render an ordered list of decision answers as compact markdown. */
export function formatDecisionAnswers(
  answers: DecisionAnswer[],
  opts: DecisionFormatOptions = {}
): string {
  const header =
    opts.provider && opts.model
      ? `**Decision** — ${opts.provider}/${opts.model}`
      : "**Decision**";
  const lines: string[] = [header, ""];
  for (const answer of answers) {
    lines.push(formatAnswer(answer));
  }
  return lines.join("\n");
}

function formatAnswer(answer: DecisionAnswer): string {
  if (answer.type === "choice") {
    const confidence =
      answer.confidence !== undefined ? ` (confidence ${answer.confidence.toFixed(2)})` : "";
    const lines = [
      `- **${answer.id}** = \`${answer.choice ?? "(no choice returned)"}\`${confidence}`,
    ];
    const probabilities = formatProbabilities(answer.probabilities);
    if (probabilities) lines.push(`  - probabilities: ${probabilities}`);
    return lines.join("\n");
  }

  if (answer.type === "noul") {
    if (answer.noul === undefined) {
      return `- **${answer.id}** = (no probability returned)`;
    }
    const verdict = answer.noul >= 0.5 ? "true" : "false";
    return `- **${answer.id}** = ${verdict} (p=${answer.noul.toFixed(2)})`;
  }

  const score = answer.score !== undefined ? answer.score.toFixed(2) : "(no score returned)";
  const scale = answer.legend && answer.legend.length > 1 ? ` / ${answer.legend.length - 1}` : "";
  const confidence =
    answer.confidence !== undefined ? ` (confidence ${answer.confidence.toFixed(2)})` : "";
  const lines = [`- **${answer.id}** = ${score}${scale}${confidence}`];
  if (answer.legend && answer.legend.length > 0) {
    lines.push(`  - legend: ${answer.legend.map((label, i) => `${i}=${label}`).join(", ")}`);
  }
  const probabilities = formatProbabilities(answer.probabilities);
  if (probabilities) lines.push(`  - probabilities: ${probabilities}`);
  return lines.join("\n");
}

function formatProbabilities(probabilities: DecisionAnswer["probabilities"]): string | undefined {
  if (!probabilities) return undefined;
  if (Array.isArray(probabilities)) {
    return probabilities.map((p, i) => `${i}=${p.toFixed(2)}`).join(", ");
  }
  return Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .map(([label, p]) => `${label}=${p.toFixed(2)}`)
    .join(", ");
}
