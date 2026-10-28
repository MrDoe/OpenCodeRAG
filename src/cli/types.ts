/**
 * @fileoverview Shared CLI option interfaces used by all command modules.
 */
/** Shared CLI option interfaces used by all command modules. */

import type { WizardFlags } from "./wizard/flow.js";

/** Standard CLI options shared by most commands (index, query, clear, etc.). */
export interface CliOptions {
  /** Optional path to an `opencode-rag.json` config file. */
  config?: string;
  /** Force a full re-index when set. */
  force?: boolean;
  /** Watch workspace for changes and re-index automatically. */
  watch?: boolean;
  /** Maximum number of results to return (query command). */
  topK?: string;
  /** Chunk offset for paginated dump output. */
  offset?: string;
  /** Maximum number of chunks to dump. */
  limit?: string;
  /** Show hybrid score breakdown in query results. */
  explain?: boolean;
  /** Skip confirmation prompts for destructive operations. */
  yes?: boolean;
  /** Print a machine-readable JSON summary as the last line of the `index` command. */
  json?: boolean;
  /** Skip the workspace scan in `status` (Up-to-date/Pending files then report unknown, not zero). */
  quick?: boolean;
  /** Optional system prompt to steer an image description toward specific features. */
  systemPrompt?: string;
}

/** Options for the `setup` command. */
export interface SetupOptions extends WizardFlags {
  /** Remove the runtime and clean up. */
  uninstall?: boolean;
  /** Force re-setup even if up-to-date. */
  force?: boolean;
  /** Only inspect the runtime. */
  check?: boolean;
  /** Re-open the configuration wizard even when a config already exists. */
  reconfigure?: boolean;
  /** Non-interactive: never prompt and keep the existing configuration. */
  yes?: boolean;
  /** Skip linking workspace-local plugin dependencies. */
  skipInstall?: boolean;
  /** Skip provider connectivity and model availability checks. */
  skipHealthCheck?: boolean;
  /** Skip the machine-level runtime install (workspace setup only). */
  skipRuntime?: boolean;
}

/** Shape of the `package.json` metadata required by CLI helpers. */
export interface PackageMetadata {
  /** The npm package name. */
  name: string;
  /** The semver version string. */
  version: string;
  /** Dev dependencies map, used to resolve plugin versions. */
  devDependencies?: Record<string, string>;
  /** Peer dependencies map, used to resolve plugin versions. */
  peerDependencies?: Record<string, string>;
}
