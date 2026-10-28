/**
 * @fileoverview Backwards-compatibility shim re-exporting the CLI runner from
 * cli/index.ts so existing imports from ../cli.js continue to work.
 */

/** Main CLI runner and auto-launch detection. */
export { runCli, shouldAutoRunCli } from "./cli/index.js";
/** Cleanup helper that removes stale global plugin registration symlinks. */
export { removeStaleGlobalPluginRegistrations } from "./cli/commands/workspace-helpers.js";
