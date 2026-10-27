/**
 * @fileoverview Shared CLI option interfaces used by all command modules.
 */
/** Shared CLI option interfaces used by all command modules. */

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

/** Options for the `init` command. */
export interface InitOptions {
  /** Overwrite existing files during initialization. */
  force?: boolean;
  /** Skip installing workspace-local plugin dependencies. */
  skipInstall?: boolean;
  /** Skip provider connectivity and model availability check. */
  skipHealthCheck?: boolean;
  /** Vector-store backend to write into the config (`lancedb` or `clickhouse`). */
  vectorStore?: string;
  /** ClickHouse endpoint for `--vector-store clickhouse`. */
  clickhouseUrl?: string;
  /** ClickHouse database for `--vector-store clickhouse`. */
  clickhouseDatabase?: string;
  /** ClickHouse user for `--vector-store clickhouse`. */
  clickhouseUser?: string;
  /** ClickHouse password env var name for `--vector-store clickhouse`. */
  clickhousePasswordEnv?: string;
  /** ClickHouse project namespace (table suffix) for `--vector-store clickhouse`. */
  clickhouseNamespace?: string;
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
