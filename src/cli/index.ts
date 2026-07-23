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

import { Command } from "commander";
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
  registerDescribeImageCommand,
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

registerIndexCommand(program);
registerQueryCommand(program);
registerClearCommand(program);
registerStatusCommand(program);
registerListCommand(program);
registerShowCommand(program);
registerDumpCommand(program);
registerDescribeImageCommand(program);
registerUiCommand(program);
registerMcpCommand(program);
registerSetupCommand(program);
registerUpdateCommand(program);
registerEvalSessionsCommand(program);
registerEvalAnalyzeCommand(program);
registerEvalCompareCommand(program);
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

if (shouldAutoRunCli(import.meta.url, process.argv[1])) {
  void program.parseAsync(process.argv);
} else {
  // Fallback: auto-run only when the script being executed IS the CLI entry
  // (detected by basename match). Avoids triggering on test runner imports
  // or other modules that import the CLI programmatically.
  const modulePath = fileURLToPath(import.meta.url);
  const argvRaw = process.argv[1] ?? "";
  const cliScript = basename(modulePath);
  const runningScript = basename(argvRaw);
  if (cliScript === runningScript) {
    void program.parseAsync(process.argv);
  } else {
    // Backwards-compatibility: when a shim points to the sibling cli.js
    // (e.g. node dist/cli.js) but the real entry is dist/cli/index.js,
    // check whether the running script lives in the same parent directory.
    try {
      const resolvedArgv = realpathSync(argvRaw);
      if (dirname(resolvedArgv) === dirname(dirname(modulePath))) {
        void program.parseAsync(process.argv);
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
 * @param argv - The argument vector to parse (defaults to `process.argv`).
 */
export async function runCli(argv: string[] = process.argv): Promise<void> {
  await program.parseAsync(argv);
}
