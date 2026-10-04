/**
 * @fileoverview Input validation for decision requests, shared by the
 * OpenCode plugin tool, the MCP handler, and the CLI command.
 *
 * The tev1 API is permissive about malformed questions (it answers with
 * garbage rather than erroring), so validating up front keeps agent calls
 * debuggable — especially option counts, where tev1 was trained on 2-24
 * options.
 */
import type { DecisionQuestion } from "../core/interfaces.js";
import { SYSTEMONE_MAX_OPTIONS, SYSTEMONE_MAX_QUESTIONS, SYSTEMONE_MIN_OPTIONS } from "./systemone.js";

/** Default `state` character limit (~2k-token decision context). */
export const DEFAULT_MAX_STATE_CHARS = 8000;

/** A decision request as received from a tool/MCP/CLI caller. */
export interface DecisionValidationInput {
  state: string;
  questions: DecisionQuestion[];
  /** Maximum characters accepted for `state`. */
  maxStateChars?: number;
}

/** Count the options of a `choice` question (object criteria or array fallback). */
function countChoiceOptions(question: DecisionQuestion): number {
  if (Array.isArray(question.criteria)) return question.criteria.length;
  if (question.criteria !== null && typeof question.criteria === "object") {
    return Object.keys(question.criteria).length;
  }
  return 0;
}

/**
 * Validate a decision request before it is sent to the model.
 *
 * @param input - State text, questions, and the configured state limit.
 * @returns An actionable error message, or `undefined` when the request is valid.
 */
export function validateDecisionRequest(input: DecisionValidationInput): string | undefined {
  const state = typeof input.state === "string" ? input.state : "";
  if (state.trim().length === 0) {
    return "`state` must not be empty.";
  }
  const maxStateChars = input.maxStateChars && input.maxStateChars > 0 ? input.maxStateChars : DEFAULT_MAX_STATE_CHARS;
  if (state.length > maxStateChars) {
    return (
      `\`state\` is ${state.length} characters; the configured limit is ${maxStateChars} ` +
      "(decision models have a ~2k-token context). Shorten `state` to the relevant excerpt."
    );
  }

  const questions = Array.isArray(input.questions) ? input.questions : [];
  if (questions.length < 1) {
    return "At least one question is required.";
  }
  if (questions.length > SYSTEMONE_MAX_QUESTIONS) {
    return `At most ${SYSTEMONE_MAX_QUESTIONS} questions per call (got ${questions.length}).`;
  }

  const seen = new Set<string>();
  for (const question of questions) {
    if (typeof question.id !== "string" || question.id.trim().length === 0) {
      return "Every question needs a non-empty `id`.";
    }
    if (seen.has(question.id)) {
      return `Duplicate question id "${question.id}" — ids must be unique.`;
    }
    seen.add(question.id);
    if (typeof question.instructions !== "string" || question.instructions.trim().length === 0) {
      return `Question "${question.id}" needs non-empty \`instructions\`.`;
    }

    if (question.type === "choice") {
      const optionCount = countChoiceOptions(question);
      if (optionCount < SYSTEMONE_MIN_OPTIONS || optionCount > SYSTEMONE_MAX_OPTIONS) {
        return (
          `Question "${question.id}": \`choice\` requires 2-24 options via \`criteria\` ` +
          `(an object mapping option → description); got ${optionCount}. ` +
          `Add a "none" option when no listed option may fit.`
        );
      }
    } else if (question.type === "score") {
      const levels = Array.isArray(question.criteria) ? question.criteria : [];
      if (levels.length < SYSTEMONE_MIN_OPTIONS || levels.length > SYSTEMONE_MAX_OPTIONS) {
        return (
          `Question "${question.id}": \`score\` requires \`criteria\` as an array of ` +
          `2-24 level descriptions, lowest first (got ${levels.length}).`
        );
      }
    } else if (question.type === "noul") {
      if (Array.isArray(question.criteria)) {
        return `Question "${question.id}": \`noul\` criteria must be an object like { "true": "...", "false": "..." }, not an array.`;
      }
    } else {
      return `Question "${question.id}": unknown type "${String(question.type)}" — expected "choice", "noul", or "score".`;
    }
  }

  return undefined;
}
