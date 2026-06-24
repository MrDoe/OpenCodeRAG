/** 
 * Shared CLI option interfaces used by all command modules. 
 */
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
}

/**
 * Standard CLI options shared by most commands (index, query, clear, etc.).
 */
export interface InitOptions {
  /** Overwrite existing files during initialization. */
  force?: boolean;
  /** Skip installing workspace-local plugin dependencies. */
  skipInstall?: boolean;
  /** Skip provider connectivity and model availability check. */
  skipHealthCheck?: boolean;
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
