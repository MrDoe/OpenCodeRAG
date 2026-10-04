/**
 * @fileoverview Decide command for classification/decision questions via the
 * configured decision model (tev1 via Ollama's `/v1/systemone`).
 */
/**
 * `decide` command — answer classification/decision questions with a decision
 * model.
 *
 * Single-question mode:
 *   opencode-rag decide "Which intent is this?" --state "..." --options a,b,c
 * Full multi-question passthrough:
 *   opencode-rag decide --state "..." --questions '[{"id":"intent", ...}]'
 */

import type { Command } from "commander";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { c, resolveCliContext, cleanupContext, logCliError, logCliInfo } from "../format.js";
import type { CliOptions } from "../types.js";
import type { DecisionQuestion, DecisionQuestionType } from "../../core/interfaces.js";
import { validateDecisionRequest } from "../../decision/validate.js";
import { formatDecisionAnswers } from "../../decision/format.js";

/** Options accepted by the `decide` command. */
interface DecideOptions extends CliOptions {
  /** Inline state text to judge. */
  state?: string;
  /** File containing the state text ("-" for stdin). */
  stateFile?: string;
  /** Single-question type: choice, noul, or score. */
  type?: string;
  /** Comma-separated options (choice) or level descriptions (score). */
  options?: string;
  /** Full questions array as JSON. */
  questions?: string;
  /** File containing the questions array as JSON. */
  questionsFile?: string;
  /** Print the raw result as JSON. */
  json?: boolean;
}

/** Read all of stdin as UTF-8 text. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer | string));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/** Resolve the state text from --state, --state-file, or piped stdin. */
async function resolveState(options: DecideOptions, cwd: string): Promise<string> {
  if (options.state !== undefined) return options.state;
  if (options.stateFile !== undefined) {
    if (options.stateFile === "-") return readStdin();
    const resolved = path.isAbsolute(options.stateFile) ? options.stateFile : path.resolve(cwd, options.stateFile);
    if (!existsSync(resolved)) {
      throw new Error(`State file not found: ${options.stateFile}`);
    }
    return readFileSync(resolved, "utf-8");
  }
  if (!process.stdin.isTTY) {
    return readStdin();
  }
  throw new Error(
    "No state provided. Use --state <text>, --state-file <path> (or \"-\" for stdin), or pipe text via stdin."
  );
}

/** Build the questions array from --questions/--questions-file or the single-question flags. */
function buildQuestions(options: DecideOptions, questionArg: string | undefined, cwd: string): DecisionQuestion[] {
  if (options.questions !== undefined || options.questionsFile !== undefined) {
    const raw = options.questionsFile !== undefined
      ? readFileSync(
          path.isAbsolute(options.questionsFile) ? options.questionsFile : path.resolve(cwd, options.questionsFile),
          "utf-8"
        )
      : options.questions!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Questions JSON is invalid: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("Questions JSON must be a non-empty array of question objects.");
    }
    return parsed as DecisionQuestion[];
  }

  if (questionArg === undefined || questionArg.trim().length === 0) {
    throw new Error("Provide a question argument (single-question mode) or --questions <json>.");
  }

  const type = (options.type ?? "choice").toLowerCase() as DecisionQuestionType;
  const parts = options.options
    ? options.options.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    : undefined;

  if (type === "choice") {
    if (!parts || parts.length < 2) {
      throw new Error("--options must list 2-24 comma-separated options for a choice question.");
    }
    return [{
      id: "decision",
      type,
      instructions: questionArg,
      criteria: Object.fromEntries(parts.map((option) => [option, option])),
    }];
  }
  if (type === "score") {
    if (!parts || parts.length < 2) {
      throw new Error("--options must list 2-24 comma-separated level descriptions (lowest first) for a score question.");
    }
    return [{ id: "decision", type, instructions: questionArg, criteria: parts }];
  }
  if (type === "noul") {
    return [{ id: "decision", type, instructions: questionArg }];
  }
  throw new Error(`Unknown question type "${options.type}" — expected choice, noul, or score.`);
}

/**
 * Register the `decide` command on the given Commander program.
 *
 * Loads the resolved config, validates that `decision.enabled` is set, and
 * sends the request to the configured decision provider. State can be passed
 * inline, from a file, or via stdin; questions can use the single-question
 * convenience flags or the full JSON passthrough.
 *
 * @param program - The Commander `Command` instance to register on.
 */
export function registerDecideCommand(program: Command): void {
  program
    .command("decide")
    .description("Answer classification/decision questions with the configured decision model (tev1 via Ollama)")
    .argument("[question]", "question/instruction to decide (single-question mode)")
    .option("--state <text>", "text to judge")
    .option("--state-file <path>", "read the text to judge from a file (\"-\" for stdin)")
    .option("-t, --type <type>", "question type: choice, noul, or score", "choice")
    .option("--options <list>", "comma-separated options (choice) or level descriptions (score)")
    .option("--questions <json>", "full questions array as JSON (advanced, multi-question)")
    .option("--questions-file <path>", "read the questions array from a JSON file")
    .option("--json", "print the raw result as JSON")
    .option("-c, --config <path>", "path to config file")
    .action(async (questionArg: string | undefined, options: DecideOptions) => {
      let logFilePath = path.resolve(process.cwd(), ".opencode", "opencode-rag.log");
      let ctx: Awaited<ReturnType<typeof resolveCliContext>> | undefined;
      try {
        const cwd = process.cwd();
        ctx = await resolveCliContext(options, logFilePath);
        logFilePath = ctx.logFilePath;

        const decisionConfig = ctx.config.decision;
        if (!decisionConfig?.enabled) {
          logCliError(logFilePath, "decide", '\nDecision model is not enabled in config. Set `decision.enabled` to true.', undefined);
          process.exit(1);
        }

        const state = await resolveState(options, cwd);
        const questions = buildQuestions(options, questionArg, cwd);

        const validationError = validateDecisionRequest({
          state,
          questions,
          maxStateChars: decisionConfig.maxStateChars,
        });
        if (validationError) {
          logCliError(logFilePath, "decide", `\nInvalid decision request: ${validationError}`, undefined);
          process.exit(1);
        }

        logCliInfo(
          logFilePath,
          "decide",
          `\n${c.heading("Deciding with:")} ${c.value(`${decisionConfig.provider}/${decisionConfig.model}`)} ` +
            `(${questions.length} question${questions.length === 1 ? "" : "s"}, ${state.length} state chars)`
        );

        const { createDecisionProvider } = await import("../../decision/factory.js");
        const provider = createDecisionProvider(decisionConfig);
        const result = await provider.decide({ state, questions });

        if (options.json) {
          logCliInfo(
            logFilePath,
            "decide",
            JSON.stringify({ provider: provider.name, model: decisionConfig.model, answers: result.answers }, null, 2)
          );
        } else {
          logCliInfo(
            logFilePath,
            "decide",
            `\n${formatDecisionAnswers(result.answers, { provider: provider.name, model: decisionConfig.model })}\n`
          );
        }
        await cleanupContext(ctx);
      } catch (err) {
        const message = (err as Error).message || String(err);
        logCliError(logFilePath, "decide", `\nDecision failed: ${message}`, err);
        if (ctx) await cleanupContext(ctx).catch(() => {});
        process.exit(1);
      }
    });
}
