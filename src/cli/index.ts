#!/usr/bin/env node
/**
 * @fileoverview CLI entry point creating the Commander program, wiring all command modules, and handling auto-run detection.
 */
/**
 * CLI entry point — creates the Commander program, wires all command modules,
 * and handles auto-run detection for symlinked binaries.
 *
 * This file is compiled to `dist/cli/index.js`, the actual entry point
 * referenced by the `bin` entry in `package.json`. The sibling file
 * `dist/cli.js` is a backwards-compatibility re-export shim.
 */

import { Command, CommanderError } from "commander";
import { realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageMetadata } from "./helpers.js";
import {
  registerIndexCommand,
  registerQueryCommand,
  registerClearCommand,
  registerStatusCommand,
  registerListCommand,
  registerShowCommand,
  registerDumpCommand,
  registerInitCommand,
  registerUiCommand,
  registerMcpCommand,
  registerSetupCommand,
  registerUpdateCommand,
  registerEvalSessionsCommand,
  registerEvalAnalyzeCommand,
  registerEvalCompareCommand,
  registerEvalGateCommand,
  registerEvalDecideCommand,
  registerEvalTuneCommand,
  registerDescribeImageCommand,
  registerDecideCommand,
  registerQuirkCommand,
} from "./commands/index.js";

/**
 * The top-level Commander program instance that defines the `opencode-rag` CLI.
 *
 * All command modules register their sub-commands against this instance during
 * module initialization. The program is parsed either on auto-run detection or
 * when {@link runCli} is called programmatically.
 */
const pkg = getPackageMetadata();
const program = new Command();

program
  .name("opencode-rag")
  .description(`Local-first RAG semantic code search v${pkg.version}`)
  .version(pkg.version);

// Commander's default is to call `process.exit()` for `--help`, `--version`
// and argument-validation errors. That is fatal for `runCli()` — the
// programmatic API used by tests and library consumers: a `--help` would
// terminate the *host* process instead of returning. Override the exit so
// Commander throws a `CommanderError` that the caller can handle.
//
// This MUST be set before the sub-commands are registered: they inherit
// `_exitCallback` from the parent through `copyInheritedSettings()`.
program.exitOverride();

registerIndexCommand(program);
registerQueryCommand(program);
registerClearCommand(program);
registerStatusCommand(program);
registerListCommand(program);
registerShowCommand(program);
registerDumpCommand(program);
registerDescribeImageCommand(program);
registerDecideCommand(program);
registerUiCommand(program);
registerMcpCommand(program);
registerSetupCommand(program);
registerUpdateCommand(program);
registerEvalSessionsCommand(program);
registerEvalAnalyzeCommand(program);
registerEvalCompareCommand(program);
registerEvalGateCommand(program);
registerEvalDecideCommand(program);
registerEvalTuneCommand(program);
registerInitCommand(program);
registerQuirkCommand(program);

// ── Auto-run detection ──────────────────────────────────────────

/**
 * Determine whether the CLI should auto-run for the current module.
 *
 * Resolves the first argv entry so symlinked binaries compare against the
 * real file path, and returns `false` if the path cannot be resolved.
 *
 * @param moduleUrl - The `import.meta.url` of the CLI entry module.
 * @param argv1 - The first CLI argument (`process.argv[1]`), typically the script path.
 * @returns `true` if the resolved argv path matches the module URL.
 */
export function shouldAutoRunCli(moduleUrl: string, argv1?: string): boolean {
  if (!argv1) {
    return false;
  }

  try {
    const resolvedPath = realpathSync(argv1).replace(/\\/g, "/");
    const normalizedUrl = moduleUrl.replace(/\\/g, "/");
    return normalizedUrl === `file://${resolvedPath}` || normalizedUrl.endsWith(`/${resolvedPath}`) || normalizedUrl.includes(resolvedPath);
  } catch {
    return false;
  }
}

/**
 * Commander error codes that mean "the requested output was printed, exit
 * successfully". `--help` and `--version` are successful outcomes, not
 * failures — they just ask Commander to exit with code 0.
 */
const DISPLAY_EXIT_CODES = new Set([
  "commander.helpDisplayed",
  "commander.help",
  "commander.version",
]);

/**
 * Check whether a thrown value is Commander's "output was displayed" exit.
 *
 * @param err - The value thrown by `program.parseAsync()`.
 * @returns `true` for `--help` / `--version` style exits.
 */
function isDisplayExit(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && DISPLAY_EXIT_CODES.has(code);
}

/**
 * Run the CLI as a real command-line process.
 *
 * Commander already wrote the error message to stderr before throwing, so
 * the only thing left to do is map the error to an exit code. Setting
 * `process.exitCode` (instead of calling `process.exit()`) lets pending
 * async work drain first and avoids tearing down live handles mid-flight.
 *
 * @param err - The value thrown by `program.parseAsync()`.
 */
function handleCliExit(err: unknown): void {
  if (isDisplayExit(err)) {
    // Commander's own `help()` exits with `process.exitCode || 0` — respect
    // an exit code a command may already have set.
    process.exitCode = process.exitCode || 0;
    return;
  }
  if (err instanceof CommanderError) {
    process.exitCode = err.exitCode;
    return;
  }
  // Not a Commander control-flow error — rethrow so Node reports it as an
  // unhandled rejection with a visible stack trace, exactly as before.
  throw err;
}

/** Parse `process.argv` as a real CLI invocation. */
function runAsCli(): void {
  void program.parseAsync(process.argv).catch(handleCliExit);
}

if (shouldAutoRunCli(import.meta.url, process.argv[1])) {
  runAsCli();
} else {
  // Fallback: auto-run only when the script being executed IS the CLI entry
  // (detected by basename match). Avoids triggering on test runner imports
  // or other modules that import the CLI programmatically.
  const modulePath = fileURLToPath(import.meta.url);
  const argvRaw = process.argv[1] ?? "";
  const cliScript = basename(modulePath);
  const runningScript = basename(argvRaw);
  if (cliScript === runningScript) {
    runAsCli();
  } else {
    // Backwards-compatibility: when a shim points to the sibling cli.js
    // (e.g. node dist/cli.js) but the real entry is dist/cli/index.js,
    // check whether the running script lives in the same parent directory.
    try {
      const resolvedArgv = realpathSync(argvRaw);
      if (dirname(resolvedArgv) === dirname(dirname(modulePath))) {
        runAsCli();
      }
    } catch {
      // If the path cannot be resolved, skip auto-run.
    }
  }
}

/**
 * Programmatically invoke the CLI with custom arguments.
 *
 * This is the public API entry point for running the CLI from code
 * (e.g. from tests or the library export).
 *
 * Never terminates the host process: Commander's exits are converted into
 * errors. `--help` and `--version` resolve normally (their output was
 * already printed); every other Commander error — a missing required
 * argument, an unknown option — is rethrown so the caller can react.
 *
 * @param argv - The argument vector to parse (defaults to `process.argv`).
 */
export async function runCli(argv: string[] = process.argv): Promise<void> {
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (isDisplayExit(err)) return;
    throw err;
  }
}
