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
}
