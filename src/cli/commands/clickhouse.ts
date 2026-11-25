/**
 * @fileoverview `clickhouse setup` — interactively configure and initialize the
 * ClickHouse vector store.
 *
 * Prompts for the endpoint, port, database, credentials, namespace, embedding
 * dimension and ANN mode; probes the server (version/auth), creates the
 * database and the project tables, then writes the `vectorStore` block into the
 * workspace or global config file. Existing config keys are preserved.
 */
import type { Command } from "commander";
import path from "node:path";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { loadWorkspaceConfig, globalConfigPath, findConfigFile, projectConfigPath, type RagConfig } from "../../core/config.js";
import {
  ClickHouseStore,
  deriveNamespace,
  legacyNamespaceVariants,
  resolveClickHouseOptions,
  sanitizeNamespace,
} from "../../vectorstore/clickhouse.js";
import { readJsonObject, writeJsonFile } from "../helpers.js";
import { c } from "../format.js";

/** Options for `opencode-rag clickhouse setup`. */
export interface ClickHouseSetupOptions {
  url?: string;
  port?: string;
  database?: string;
  username?: string;
  password?: string;
  passwordEnv?: string;
  namespace?: string;
  ann?: string;
  dimension?: string;
  scope?: string;
  storePassword?: boolean;
  skipInit?: boolean;
  yes?: boolean;
  /** Working directory override (tests); defaults to `process.cwd()`. */
  cwd?: string;
}

interface SetupInput {
  url: string;
  database: string;
  username: string;
  password: string;
  passwordEnv: string;
  namespace: string;
  ann: "off" | "hnsw";
  dimension: number;
  storeInlinePassword: boolean;
}

/**
 * Merge a ClickHouse `vectorStore` block into an existing config object.
 * Exported for tests; preserves every unrelated top-level key and the old
 * cache path when ClickHouse was already active.
 */
export function mergeClickHouseConfig(
  existing: Record<string, unknown> | undefined,
  input: Pick<SetupInput, "url" | "database" | "username" | "password" | "passwordEnv" | "namespace" | "ann" | "storeInlinePassword">,
): Record<string, unknown> {
  const base = existing ?? {};
  const current = (base.vectorStore ?? {}) as Record<string, unknown>;
  const currentClickhouse = (current.clickhouse ?? {}) as Record<string, unknown>;
  const cachePath =
    current.provider === "clickhouse" && typeof current.path === "string"
      ? current.path
      : "./.opencode/rag_ch";
  const clickhouse: Record<string, unknown> = {
    ...currentClickhouse,
    url: input.url,
    database: input.database,
    username: input.username,
  };
  delete clickhouse.password;
  if (input.storeInlinePassword && input.password) clickhouse.password = input.password;
  if (input.passwordEnv) clickhouse.passwordEnv = input.passwordEnv;
  else delete clickhouse.passwordEnv;
  if (input.namespace) clickhouse.namespace = sanitizeNamespace(input.namespace);
  else delete clickhouse.namespace;
  clickhouse.ann = input.ann;
  if (input.ann === "hnsw") {
    clickhouse.annFetchMultiplier = 4;
    clickhouse.annWithRescoring = true;
  }
  return {
    ...base,
    vectorStore: {
      ...current,
      path: cachePath,
      provider: "clickhouse",
      clickhouse,
    },
  };
}

/** Parse "major.minor.patch.build" into a comparable pair. */
function parseVersion(version: string): { major: number; minor: number } {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  const major = parts[0];
  const minor = parts[1];
  return {
    major: major !== undefined && Number.isFinite(major) ? major : 0,
    minor: minor !== undefined && Number.isFinite(minor) ? minor : 0,
  };
}

/** ClickHouse >= 25.8 has the `vector_similarity` HNSW index. */
function supportsAnn(version: string): boolean {
  const { major, minor } = parseVersion(version);
  return major > 25 || (major === 25 && minor >= 8);
}

/** Prompt for a line with a default value. */
async function promptLine(rl: ReturnType<typeof createInterface>, question: string, fallback: string): Promise<string> {
  const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim();
  return answer.length > 0 ? answer : fallback;
}

/**
 * Prompt for a password without echoing it.
 *
 * Readline's internal `_writeToOutput` hook is muted while the answer is read —
 * an active readline interface otherwise echoes every keystroke, even when the
 * caller switches the stream to raw mode.
 */
export async function promptHidden(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  const mutable = rl as unknown as { _writeToOutput?: (text: string) => void };
  const original = mutable._writeToOutput;
  process.stdout.write(question);
  if (typeof mutable._writeToOutput === "function") {
    mutable._writeToOutput = () => {};
  }
  try {
    return (await rl.question("")).trim();
  } finally {
    mutable._writeToOutput = original;
    process.stdout.write("\n");
  }
}

/** Compose `scheme://host:port` from a user-supplied URL and port. */
export function composeClickHouseUrl(rawUrl: string, port: string): string {
  const parsed = new URL(rawUrl);
  if (port.trim()) parsed.port = port.trim();
  return parsed.toString().replace(/\/+$/, "");
}

/** Probe the server and return its version, or throw a readable error. */
async function probeServer(url: string, username: string, password: string): Promise<string> {
  const { createClient } = await import("@clickhouse/client");
  const client = createClient({
    url,
    username,
    password,
    database: "default",
    request_timeout: 10_000,
  });
  try {
    const result = await client.query({ query: "SELECT version() AS v", format: "JSONEachRow" });
    const rows = await result.json<{ v: string }>();
    return rows[0]?.v ?? "unknown";
  } finally {
    await client.close().catch(() => {});
  }
}

/** Create the database and project tables (and the ANN index when requested). */
async function initializeStore(input: SetupInput, cwd: string): Promise<void> {
  const cfg = loadWorkspaceConfig(cwd);
  cfg.vectorStore.provider = "clickhouse";
  cfg.vectorStore.clickhouse = {
    ...(cfg.vectorStore.clickhouse ?? {}),
    url: input.url,
    database: input.database,
    username: input.username,
    password: input.password,
    passwordEnv: "",
    namespace: input.namespace,
    ann: input.ann,
    annFetchMultiplier: 4,
    annWithRescoring: true,
  };
  const options = resolveClickHouseOptions(cfg, cwd);
  const store = new ClickHouseStore(options, input.dimension);
  try {
    const dimension = await store.getVectorDimension();
    const ann = await store.hasVectorIndex();
    const count = await store.count();
    console.log(`\n  ${c.success("Initialized:")} ${input.database}.${options.chunksTable}`);
    console.log(`  ${c.label("State table:")} ${input.database}.${options.stateTable}`);
    console.log(`  ${c.label("Dimension:")}   ${dimension ?? input.dimension}`);
    console.log(`  ${c.label("ANN:")}         ${ann ? "hnsw (vector_similarity)" : input.ann === "hnsw" ? "missing" : "off (exact scans)"}`);
    console.log(`  ${c.label("Chunks:")}      ${count}`);
  } finally {
    await store.close().catch(() => {});
  }
}

/** Run the interactive (or flag-driven) ClickHouse setup. */
export async function runClickHouseSetup(options: ClickHouseSetupOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const interactive = Boolean(process.stdin.isTTY) && !options.yes;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;

  try {
    const cfg: RagConfig = loadWorkspaceConfig(cwd);
    const defaultDimension =
      cfg.embedding.vectorDimension && cfg.embedding.vectorDimension > 0
        ? String(cfg.embedding.vectorDimension)
        : "384";
    const scopeDefault = options.scope === "global" || options.scope === "workspace" ? options.scope : "workspace";

    const rawUrl = interactive
      ? await promptLine(rl!, "ClickHouse URL", options.url ?? "http://localhost:8123")
      : options.url ?? "http://localhost:8123";
    const defaultPort = (() => {
      try {
        return new URL(rawUrl).port || "8123";
      } catch {
        return "8123";
      }
    })();
    const port = interactive ? await promptLine(rl!, "Port", options.port ?? defaultPort) : options.port ?? defaultPort;
    let url: string;
    try {
      url = composeClickHouseUrl(rawUrl, port);
    } catch {
      throw new Error(`Invalid ClickHouse URL: "${rawUrl}"`);
    }

    const database = interactive
      ? await promptLine(rl!, "Database", options.database ?? cfg.vectorStore.clickhouse?.database ?? "OpenCodeRAG")
      : options.database ?? cfg.vectorStore.clickhouse?.database ?? "OpenCodeRAG";
    const username = interactive
      ? await promptLine(rl!, "Username", options.username ?? cfg.vectorStore.clickhouse?.username ?? "default")
      : options.username ?? cfg.vectorStore.clickhouse?.username ?? "default";

    let password = options.password ?? "";
    if (!password && interactive) password = await promptHidden(rl!, "Password: ");
    if (!password) {
      const envName = options.passwordEnv ?? cfg.vectorStore.clickhouse?.passwordEnv ?? "OPENCODERAG_CLICKHOUSE_PASSWORD";
      password = process.env[envName] ?? "";
      if (!password) {
        throw new Error(
          "A ClickHouse password is required — pass --password, set the password env var, or run the command interactively.",
        );
      }
    }

    // 1. Probe the server before writing anything.
    let version: string;
    try {
      version = await probeServer(url, username, password);
    } catch (err) {
      throw new Error(
        `Could not connect/authenticate to ${url}: ${(err as Error).message}` +
        (process.env.HTTP_PROXY || process.env.HTTPS_PROXY
          ? "\nIf an internal hostname is involved, make sure NO_PROXY includes it."
          : ""),
      );
    }
    const annSupported = supportsAnn(version);
    console.log(`\n  ${c.success("Connected:")} ClickHouse ${version}${annSupported ? " (ANN available)" : " (no ANN, needs 25.8+)"}\n`);

    const scope = interactive
      ? (await promptLine(rl!, "Write the config to workspace or global", scopeDefault)).toLowerCase() === "global"
        ? "global"
        : "workspace"
      : scopeDefault;

    const derived = deriveNamespace(cwd);
    const namespaceDefault =
      options.namespace ?? (scope === "global" ? "" : cfg.vectorStore.clickhouse?.namespace ?? derived);
    const namespace = interactive
      ? await promptLine(
          rl!,
          scope === "global" ? "Namespace (blank = per-workspace tables)" : "Namespace",
          namespaceDefault,
        )
      : namespaceDefault;

    const dimension = interactive
      ? Number.parseInt(await promptLine(rl!, "Embedding dimension (ANN index is bound to it)", options.dimension ?? defaultDimension), 10)
      : Number.parseInt(options.dimension ?? defaultDimension, 10);
    if (!Number.isFinite(dimension) || dimension < 2 || dimension > 16000) {
      throw new Error(`Invalid embedding dimension: ${options.dimension ?? defaultDimension}`);
    }

    const annDefault = options.ann ?? (annSupported ? "hnsw" : "off");
    let ann: "off" | "hnsw";
    if (interactive) {
      const answer = await promptLine(rl!, "Enable the HNSW ANN index (hnsw/off)", annDefault);
      ann = answer.toLowerCase() === "off" ? "off" : "hnsw";
    } else {
      ann = annDefault === "hnsw" ? "hnsw" : "off";
    }
    if (ann === "hnsw" && !annSupported) {
      throw new Error(`ANN requires ClickHouse >= 25.8 — ${url} runs ${version}. Use --ann off.`);
    }

    const storeEnvDefault = options.passwordEnv ?? cfg.vectorStore.clickhouse?.passwordEnv ?? "OPENCODERAG_CLICKHOUSE_PASSWORD";
    let storeInlinePassword = options.storePassword ?? false;
    let passwordEnv = storeEnvDefault;
    if (interactive) {
      storeInlinePassword = /^y/i.test(await promptLine(rl!, "Store the password in the config file (plaintext)", "n"));
      if (!storeInlinePassword) {
        passwordEnv = await promptLine(rl!, "Password env var name", storeEnvDefault);
      }
    }
    if (!storeInlinePassword && !passwordEnv) {
      throw new Error("Set a password env var name or use --store-password.");
    }

    // 2. Initialize the database/tables before writing the config.
    const setupInput: SetupInput = {
      url,
      database,
      username,
      password,
      passwordEnv,
      namespace: namespace ? sanitizeNamespace(namespace) : "",
      ann,
      dimension,
      storeInlinePassword,
    };
    if (!options.skipInit) {
      await initializeStore(setupInput, cwd);
    }

    // 3. Write the config (workspace or the machine-global user config).
    const targetPath = scope === "global"
      ? globalConfigPath()
      : findOrCreateWorkspaceConfig(cwd);
    const existing = readJsonObject(targetPath);
    const next = mergeClickHouseConfig(existing, setupInput);

    if (interactive) {
      const write = await promptLine(rl!, `Write this vectorStore block to ${targetPath}`, "y");
      if (!/^y/i.test(write)) {
        console.log("  (config not written)");
        return;
      }
    }
    if (existsSync(targetPath)) {
      copyFileSync(targetPath, `${targetPath}.bak`);
    }
    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeJsonFile(targetPath, next);

    console.log(`\n  ${c.success("Config written:")} ${targetPath}`);
    console.log(`  ${c.label("Backend:")}  clickhouse ${url}/${database}`);
    console.log(`  ${c.label("Namespace:")} ${setupInput.namespace || "(derived per workspace)"}`);
    console.log(`  ${c.label("ANN:")}        ${ann}`);
    if (!storeInlinePassword) {
      const setCommand = process.platform === "win32"
        ? `[Environment]::SetEnvironmentVariable("${passwordEnv}", "<password>", "User")`
        : `export ${passwordEnv}="<password>"   # add to ~/.bashrc or ~/.zshrc`;
      console.log(
        `\n  ${c.warn("Set the password before using it:")}\n  ${setCommand}`,
      );
    }
    console.log(`\n  Next: ${c.value("opencode-rag index")} (then ${c.value("opencode-rag status")})\n`);
  } finally {
    rl?.close();
  }
}

/** Use an existing workspace config file, or the canonical `.opencode/opencode-rag.json` for a new one. */
function findOrCreateWorkspaceConfig(cwd: string): string {
  return findConfigFile(cwd) ?? projectConfigPath(cwd);
}

/** Options shared by `clickhouse adopt` and `clickhouse compact`. */
export interface ClickHouseMaintenanceOptions {
  /** Namespace to adopt from; defaults to every legacy spelling of this workspace. */
  from?: string;
  /** Target namespace; defaults to the configured/derived one. */
  to?: string;
  /** Execute the statements. Without it the command only prints what it would do. */
  apply?: boolean;
  /** Working directory override (tests); defaults to `process.cwd()`. */
  cwd?: string;
}

/** Run one parameterless query per call and return its rows as objects. */
async function withAdmin<T>(
  url: string,
  database: string,
  username: string,
  password: string,
  fn: (run: <R extends Record<string, string>>(sql: string) => Promise<R[]>) => Promise<T>,
): Promise<T> {
  const { createClient } = await import("@clickhouse/client");
  const client = createClient({ url, username, password, database, request_timeout: 60_000 });
  try {
    const run = async <R extends Record<string, string>>(sql: string): Promise<R[]> =>
      await (await client.query({ query: sql, format: "JSONEachRow" })).json<R>();
    return await fn(run);
  } finally {
    await client.close().catch(() => {});
  }
}

/** A namespace is interpolated into DDL, so it must look like one of ours. */
function assertSafeNamespace(ns: string): string {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(ns)) throw new Error(`Refusing to touch unsafe namespace name: ${JSON.stringify(ns)}`);
  return ns;
}

/** Read the ClickHouse connection block this workspace points at. */
function clickHouseTarget(cwd: string): { url: string; database: string; username: string; password: string; namespace: string; pinned: boolean } {
  const cfg = loadWorkspaceConfig(cwd);
  if ((cfg.vectorStore.provider ?? "lancedb") !== "clickhouse") {
    throw new Error('This workspace does not use the ClickHouse backend (vectorStore.provider is not "clickhouse").');
  }
  const options = resolveClickHouseOptions(cfg, cwd);
  return {
    url: options.url,
    database: options.database,
    username: options.username,
    password: options.password,
    namespace: options.namespace,
    pinned: Boolean(cfg.vectorStore.clickhouse?.namespace?.trim()),
  };
}

/**
 * `clickhouse adopt` - move an index that lives under a stale namespace spelling
 * onto the current one, instead of re-embedding it from scratch.
 *
 * Exists because `deriveNamespace()` used to hash the workspace path exactly as
 * spelled: the same repository opened as `C:\repo` and `c:\repo` got two tables,
 * one of them quietly going stale while the agent read it and concluded retrieval
 * was bad. No rows are created here - a `RENAME TABLE` moves them.
 *
 * @param options - Flags from the CLI.
 */
export async function runClickHouseAdopt(options: ClickHouseMaintenanceOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const t = clickHouseTarget(cwd);
  const target = assertSafeNamespace(options.to ?? t.namespace);
  const candidates = [
    ...new Set([
      ...(options.from ? [assertSafeNamespace(options.from)] : []),
      ...(t.pinned ? [] : legacyNamespaceVariants(cwd)),
    ]),
  ];
  if (candidates.length === 0) {
    console.log(`\n  ${c.success("Nothing to adopt:")} namespace "${target}" is pinned in the config, so no alternative spelling is derived.`);
    console.log(`  ${c.label("If your index lives elsewhere:")} pass --from <namespace>\n`);
    return;
  }

  await withAdmin(t.url, t.database, t.username, t.password, async (run) => {
    const existing = (await run<{ name: string }>(`SELECT name FROM system.tables WHERE database = '${t.database}'`))
      .map((r) => r.name)
      .filter((name) => typeof name === "string" && name.length > 0);
    const live = candidates.filter((ns) => existing.includes(`chunks_${ns}`));
    if (live.length === 0) {
      console.log(`\n  ${c.warn("No index to adopt.")} None of ${candidates.join(", ")} exists in ${t.database}.\n`);
      return;
    }

    console.log(`\n  ${c.heading("ClickHouse namespace adoption")} - target "${target}"\n`);
    const stats: { ns: string; rows: number; ver: string }[] = [];
    for (const ns of live) {
      const row = (await run<{ rows: string; ver: string }>(
        `SELECT count() AS rows, toString(max(ver)) AS ver FROM ${t.database}.chunks_${assertSafeNamespace(ns)}`
      ))[0];
      stats.push({ ns, rows: Number(row?.rows ?? 0) || 0, ver: String(row?.ver ?? "").slice(0, 19) });
    }
    for (const s of stats) {
      console.log(`  ${c.file(`chunks_${s.ns}`.padEnd(46))} ${String(s.rows).padStart(8)} rows  newest ${s.ver}`);
    }

    const chosen = options.from ? assertSafeNamespace(options.from) : (stats.length === 1 ? stats[0]!.ns : "");
    if (!chosen) {
      console.log(`\n  ${c.warn("Two or more spellings exist.")} Pass ${c.value("--from <namespace>")} for the one that holds your real index.`);
      console.log(`  Hint: the one with the newest \`ver\` is the one that was still being written to.\n`);
      return;
    }
    if (chosen === target) {
      console.log(`\n  ${c.success("Already adopted:")} the source namespace is the target namespace.\n`);
      return;
    }

    const targetStats = existing.includes(`chunks_${target}`)
      ? (await run<{ n: string; ver: string }>(`SELECT count() AS n, toString(max(ver)) AS ver FROM ${t.database}.chunks_${target}`))[0]
      : undefined;
    const targetRows = Number(targetStats?.n ?? 0);
    if (targetRows > 0) {
      const source = stats.find((s) => s.ns === chosen);
      console.log(`\n  ${c.error("Refusing:")} both indexes are populated, and merging them is not this command's call to guess.`);
      console.log(`    target ${t.database}.chunks_${target}:  ${targetRows} rows, newest ${String(targetStats?.ver ?? "").slice(0, 19)}`);
      console.log(`    source ${t.database}.chunks_${chosen}:  ${source?.rows ?? "?"} rows, newest ${source?.ver ?? "?"}`);
      console.log(`  ${c.label("Pick one:")}`);
      console.log(`    - the source is the fresher one  -> ${c.value(`opencode-rag clickhouse adopt --from ${chosen} --apply`)} (after dropping the target, or pin vectorStore.clickhouse.namespace to "${chosen}")`);
      console.log(`    - the target is the fresher one  -> the source is a stale duplicate; drop it: DROP TABLE ${t.database}.chunks_${chosen}; DROP TABLE ${t.database}.state_${chosen};`);
      console.log(`    - unsure -> trust the newer \`newest\` timestamp; the index that stopped moving is the one no session writes to.\n`);
      return;
    }

    const statements: string[] = [];
    for (const kind of ["chunks", "state"]) {
      const src = `${t.database}.${kind}_${chosen}`;
      const dst = `${t.database}.${kind}_${target}`;
      if (!existing.includes(`${kind}_${chosen}`)) continue;
      if (existing.includes(`${kind}_${target}`)) statements.push(`DROP TABLE ${dst}`);
      statements.push(`RENAME TABLE ${src} TO ${dst}`);
    }

    console.log(`\n  ${c.label("Statements:")}`);
    for (const s of statements) console.log(`    ${s}`);
    if (!options.apply) {
      console.log(`\n  ${c.warn("Dry run.")} Re-run with ${c.value("--apply")} to execute. Restart OpenCode afterwards so the store reconnects.\n`);
      return;
    }
    for (const s of statements) {
      await run(s);
      console.log(`  ${c.success("Applied:")} ${s}`);
    }
    console.log(`\n  ${c.success("Adopted.")} The index "${chosen}" now answers as "${target}". Restart OpenCode to drop the old table handle.\n`);
  });
}

/**
 * `clickhouse compact` - delete tombstoned chunk rows and collapse the merge tree.
 *
 * A ReplacingMergeTree keeps superseded embeddings until something forces the
 * merge, and every read filters on `is_deleted = 0`. Left alone that inflates the
 * ANN candidate pool - one measured workspace carried 153 424 rows of which 9 167
 * were live - and that costs both recall and latency on every search.
 *
 * @param options - Flags from the CLI.
 */
export async function runClickHouseCompact(options: ClickHouseMaintenanceOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const t = clickHouseTarget(cwd);
  const ns = assertSafeNamespace(options.to ?? t.namespace);
  await withAdmin(t.url, t.database, t.username, t.password, async (run) => {
    const exists = Number((await run<{ n: string }>(
      `SELECT count() AS n FROM system.tables WHERE database = '${t.database}' AND name = 'chunks_${ns}'`
    ))[0]?.n ?? 0) > 0;
    if (!exists) {
      console.log(`\n  ${c.warn("No such table:")} ${t.database}.chunks_${ns}\n`);
      return;
    }
    const row = (await run<{ total: string; live: string }>(
      `SELECT count() AS total, countIf(is_deleted = 0) AS live FROM ${t.database}.chunks_${ns}`
    ))[0];
    const totalN = Number(row?.total ?? 0) || 0;
    const liveN = Number(row?.live ?? 0) || 0;
    const dead = totalN - liveN;
    console.log(`\n  ${c.heading("ClickHouse table")} ${t.database}.chunks_${ns}`);
    console.log(`  ${c.label("Rows:")}  ${totalN}`);
    console.log(`  ${c.label("Live:")}  ${liveN}`);
    console.log(`  ${c.label("Dead:")}  ${dead}${totalN > 0 ? ` (${Math.round((dead / totalN) * 100)}%)` : ""}\n`);
    if (dead === 0) {
      console.log(`  ${c.success("Nothing to sweep.")}\n`);
      return;
    }
    if (!options.apply) {
      console.log(`  ${c.warn("Dry run.")} Re-run with ${c.value("--apply")} to run:`);
      console.log(`    ALTER TABLE ${t.database}.chunks_${ns} DELETE WHERE is_deleted = 1`);
      console.log(`    OPTIMIZE TABLE ${t.database}.chunks_${ns} FINAL\n`);
      return;
    }
    await run(`ALTER TABLE ${t.database}.chunks_${ns} DELETE WHERE is_deleted = 1`);
    console.log(`  ${c.success("Mutation queued:")} is_deleted = 1`);
    await run(`OPTIMIZE TABLE ${t.database}.chunks_${ns} FINAL`);
    const after = Number((await run<{ n: string }>(`SELECT count() AS n FROM ${t.database}.chunks_${ns}`))[0]?.n ?? 0);
    console.log(`  ${c.success("Optimized FINAL:")}, ${after} rows visible (mutations run asynchronously - re-check in a moment)\n`);
  });
}

/** Register the `clickhouse` command group. */
export function registerClickHouseCommand(program: Command): void {
  const group = program
    .command("clickhouse")
    .description("Manage the ClickHouse vector store");

  group
    .command("setup")
    .description("Interactively configure and initialize a ClickHouse vector store")
    .option("--url <url>", "ClickHouse endpoint (e.g. http://localhost:8123)")
    .option("--port <port>", "ClickHouse HTTP port (default 8123)")
    .option("--database <name>", "database name (default OpenCodeRAG)")
    .option("--username <name>", "ClickHouse user (default default)")
    .option("--password <password>", "password (prefer the prompt or an env var)")
    .option("--password-env <name>", "env var holding the password")
    .option("--namespace <name>", "project namespace / table suffix (blank = per-workspace)")
    .option("--ann <mode>", "ANN mode: hnsw or off")
    .option("--dimension <n>", "embedding dimension the ANN index is bound to")
    .option("--scope <scope>", "write the config to workspace or global")
    .option("--store-password", "write the password into the config file (plaintext)")
    .option("--skip-init", "only write the config; do not create the database/tables")
    .option("--yes", "non-interactive: use the flags/defaults without prompting")
    .action(async (options: ClickHouseSetupOptions) => {
      try {
        await runClickHouseSetup(options);
      } catch (err) {
        console.error(`\n${c.error("ClickHouse setup failed:")} ${(err as Error).message}\n`);
        process.exitCode = 1;
      }
    });

  group
    .command("adopt")
    .description("Move an index from a stale namespace spelling onto this workspace's current one")
    .option("--from <namespace>", "namespace to adopt from (default: the legacy spelling of this path)")
    .option("--to <namespace>", "target namespace (default: configured/derived)")
    .option("--apply", "execute the RENAME statements (default: dry run)")
    .action(async (options: ClickHouseMaintenanceOptions) => {
      try {
        await runClickHouseAdopt(options);
      } catch (err) {
        console.error(`\n${c.error("Adopt failed:")} ${(err as Error).message}\n`);
        process.exitCode = 1;
      }
    });

  group
    .command("compact")
    .description("Delete tombstoned chunk rows and collapse the merge tree")
    .option("--to <namespace>", "namespace to compact (default: configured/derived)")
    .option("--apply", "execute the mutation (default: dry run)")
    .action(async (options: ClickHouseMaintenanceOptions) => {
      try {
        await runClickHouseCompact(options);
      } catch (err) {
        console.error(`\n${c.error("Compact failed:")} ${(err as Error).message}\n`);
        process.exitCode = 1;
      }
    });
}
