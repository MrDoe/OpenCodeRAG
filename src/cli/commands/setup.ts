import type { Command } from "commander";
import path from "node:path";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { c } from "../format.js";
import { getPackageMetadata } from "../helpers.js";
import {
  getRuntimeDir,
  getVersionFile,
  readVersionFile,
  setupRuntime,
} from "../../core/setup-runtime.js";
import { compareVersions, getCurrentVersion, installLatestUpdate } from "../../core/version-check.js";
import { bestAvailablePackageManager, globalUninstallCommand } from "../../core/package-manager.js";
import {
  globalConfigPath,
  loadWorkspaceRawConfig,
  migrateLegacyProjectConfig,
  findConfigFile,
  projectConfigPath,
  type ProxyConfig,
} from "../../core/config.js";
import { createPrompter } from "../prompt.js";
import {
  hasExplicitSetupFlags,
  answersFromFlags,
  runSetupWizard,
} from "../wizard/flow.js";
import {
  buildConfigPatch,
  findShadowingProviderKeys,
  readJsonObjectSafe,
  removeConfigPaths,
  writeConfigPatch,
} from "../wizard/apply.js";
import { offerHealthRepairs } from "../wizard/repair.js";
import { generateDefaultConfigJson } from "./workspace-helpers.js";
import { detectOllamaBackend } from "./backend-detect.js";
import {
  isLikelyProjectRoot,
  runWorkspaceHealthCheck,
  scaffoldWorkspace,
} from "../workspace.js";
import { destroyAllPooledConnections } from "../../embedder/http.js";
import {
  getGlobalPluginDir,
  installGlobalPlugin,
  isGlobalPluginInstalled,
  isWorkspacePluginInstalled,
  removeGlobalPlugin,
} from "../../core/global-plugin.js";
import type { SetupOptions } from "../types.js";

const PLUGIN_NAME = "opencode-rag-plugin";

function removeIfExists(targetPath: string): void {
  if (existsSync(targetPath)) {
    rmSync(targetPath, { recursive: true, force: true });
  }
}

function checkOpenCodeRunning(): void {
  try {
    if (process.platform === "win32") {
      execSync('tasklist /FI "IMAGENAME eq opencode.exe" 2>nul | find /I "opencode.exe" >nul', {
        timeout: 3_000,
        stdio: "ignore",
        windowsHide: true,
      });
      console.log(`\n  ${c.warn("OpenCode is currently running.")} Restart it to load the updated plugin.`);
    } else {
      const pids = execSync("pgrep -x opencode 2>/dev/null", {
        encoding: "utf-8",
        timeout: 3_000,
        windowsHide: true,
      }).trim();
      if (pids) {
        console.log(`\n  ${c.warn("OpenCode is currently running.")} Restart it to load the updated plugin.`);
      }
    }
  } catch {
    // OpenCode not found or tools unavailable.
  }
}

/**
 * Whether the effective raw config already selects an embedding model.
 *
 * The wizard only runs when this is false (or `--reconfigure` is passed), so
 * re-running `setup` after an update never re-asks the same questions.
 */
function hasConfiguredEmbedding(config: Record<string, unknown>): boolean {
  const embedding = config.embedding;
  if (!embedding || typeof embedding !== "object" || Array.isArray(embedding)) return false;
  const section = embedding as Record<string, unknown>;
  return typeof section.model === "string" || typeof section.provider === "string";
}

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Set up OpenCodeRAG: runtime, workspace files and the model configuration wizard")
    .addHelpText(
      "after",
      "\nUse cases:\n" +
      "  - First-time install: installs the plugin runtime into ~/.opencode/, scaffolds the\n" +
      "    current workspace (.opencode/, plugin entries, skills, AGENTS.md) and asks for the\n" +
      "    provider, host URL and models (embedding, description, vision, decision).\n" +
      "  - Re-running: syncs the runtime and workspace files without asking questions.\n" +
      "    Use --reconfigure to re-open the wizard, or pass flags for scripted setups.\n" +
      "  - Updating: use 'opencode-rag update' to install a newer release.\n" +
      "  - Troubleshooting: use --check to inspect the runtime, or --force to reinstall.\n" +
      "\nProvider/model settings are written to the global config\n" +
      "(~/.config/opencode/opencode-rag.json); feature toggles to the workspace\n" +
      "config (.opencode/opencode-rag.json).\n",
    )
    .option("--uninstall", "remove the runtime and cleanup")
    .option("-f, --force", "force re-setup even if up-to-date")
    .option("--check", "check whether the runtime is correctly installed")
    .option("--reconfigure", "re-open the model configuration wizard")
    .option("-y, --yes", "non-interactive: never prompt, keep the existing configuration")
    .option("--provider <name>", "provider id: ollama | openai | cohere | anthropic | google")
    .option("--base-url <url>", "provider base URL")
    .option("--api-key <key>", "provider API key (or env:NAME to read an environment variable)")
    .option("--embedding-model <model>", "embedding model id")
    .option("--description-model <model>", "enable chunk descriptions with this model")
    .option("--vision-model <model>", "enable image descriptions with this vision model")
    .option("--decision-model <model>", "enable make_decision with this tev1 model")
    .option("--description [on|off]", "enable or disable chunk descriptions")
    .option("--vision [on|off]", "enable or disable image descriptions")
    .option("--decision [on|off]", "enable or disable the decision model")
    .option("--reranking [on|off]", "enable or disable reranking")
    .option("--shell-guard [on|off]", "enable or disable the shell-command guard")
    .option("--memory-capture [on|off]", "enable or disable automatic quirk capture")
    .option("--vector-store <provider>", "vector store backend: lancedb | clickhouse")
    .option("--clickhouse-url <url>", "ClickHouse endpoint (default http://localhost:8123)")
    .option("--clickhouse-database <name>", "ClickHouse database (default OpenCodeRAG)")
    .option("--clickhouse-user <name>", "ClickHouse user (default default)")
    .option("--clickhouse-password-env <name>", "env var holding the ClickHouse password")
    .option("--clickhouse-namespace <name>", "project namespace / table suffix")
    .option("--skip-install [on|off]", "skip linking workspace-local plugin dependencies")
    .option("--skip-health-check [on|off]", "skip provider connectivity and model availability check")
    .option("--skip-runtime [on|off]", "skip the machine-level runtime install (workspace setup only)")
    .option("--workspace-plugin", "install the plugin into this workspace instead of the global config")
    .option("--no-index", "do not offer to build the search index after setup")
    .action(async (options: SetupOptions) => {
      await runSetup(options);
    });
}

/** Parse a Commander optional boolean (`--x`, `--x on`, `--x off`). */
function parseToggle(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "on" || normalized === "true" || normalized === "yes" || normalized === "1") return true;
  if (normalized === "off" || normalized === "false" || normalized === "no" || normalized === "0") return false;
  return undefined;
}

/** Setup options with the optional-value booleans already parsed. */
type NormalizedSetupOptions = Omit<SetupOptions, "skipInstall" | "skipHealthCheck" | "skipRuntime"> & {
  skipInstall?: boolean;
  skipHealthCheck?: boolean;
  skipRuntime?: boolean;
};

/** Normalize the raw Commander options into the wizard flag shape. */
function normalizeFlags(options: SetupOptions): NormalizedSetupOptions {
  return {
    ...options,
    description: parseToggle(options.description),
    vision: parseToggle(options.vision),
    decision: parseToggle(options.decision),
    reranking: parseToggle(options.reranking),
    shellGuard: parseToggle(options.shellGuard),
    memoryCapture: parseToggle(options.memoryCapture),
    // Optional-value booleans: `--skip-x`, `--skip-x=false`, `--skip-x off`.
    skipInstall: parseToggle(options.skipInstall),
    skipHealthCheck: parseToggle(options.skipHealthCheck),
    skipRuntime: parseToggle(options.skipRuntime),
  };
}

/** Write the baseline workspace config (with Ollama batch tuning when available). */
async function writeDefaultWorkspaceConfig(configPath: string, configLabel: string): Promise<void> {
  let tuning;
  try {
    const info = await detectOllamaBackend();
    tuning = info.tuning;
    const icon =
      info.backend === "gpu" ? c.success("GPU:") : info.backend === "cpu" ? c.warn("CPU:") : c.dim("Backend:");
    console.log(`\n  ${icon} ${info.message}`);
  } catch {
    tuning = undefined;
  }
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, generateDefaultConfigJson(tuning), "utf-8");
  console.log(`\n  ${c.created("Created:")} ${c.file(configLabel)}`);
}

/**
 * Run `opencode-rag index` in a child process so setup can finish with a
 * ready-to-query index instead of requiring a second command.
 */
function buildIndexNow(): void {
  const entry = process.argv[1];
  if (!entry) return;
  try {
    console.log(`\n${c.heading("Building the search index...")}\n`);
    execFileSync(process.execPath, [...process.execArgv, entry, "index"], {
      stdio: "inherit",
      windowsHide: true,
    });
  } catch {
    console.log(`\n  ${c.warn("Indexing did not finish.")} Run \`opencode-rag index\` to retry.`);
  }
}

/** The `setup` action body. */
async function runSetup(rawOptions: SetupOptions): Promise<void> {
  const options = normalizeFlags(rawOptions);
  const pkg = getPackageMetadata();
  const pluginVersion = pkg.version;
  const runtimeDir = getRuntimeDir();
  const versionFile = getVersionFile(runtimeDir);
  const runtimePluginDir = path.join(runtimeDir, "node_modules", PLUGIN_NAME);
  const runtimeSdkDir = path.join(runtimeDir, "node_modules", "@opencode-ai");
  const runtimeSdkPluginDir = path.join(runtimeSdkDir, "plugin");

  // --- check status ---
  if (options.check) {
    console.log(`\n${c.heading("OpenCodeRAG Runtime Status")}\n`);
    const runtimeDist = path.join(runtimePluginDir, "dist");
    if (existsSync(runtimeDist)) {
      console.log(`  ${c.label("Runtime:")}    ${c.success("installed")} at ${c.file(runtimeDir)}`);
      const installedVersion = readVersionFile(versionFile);
      console.log(`  ${c.label("Installed:")}  ${c.value(installedVersion ?? "?")}`);
      if (installedVersion !== pluginVersion) {
        console.log(`  ${c.label("Published:")}  ${c.value(pluginVersion)} ${c.warn("(update available — run `opencode-rag setup` to sync)")}`);
      }
      console.log(`  ${c.label("Plugin:")}    ${existsSync(runtimePluginDir) ? (() => {
        try {
          const stat = lstatSync(runtimePluginDir);
          return stat.isSymbolicLink() ? "junction" : "directory";
        } catch {
          return "?";
        }
      })() : "missing"}`);
      console.log(`  ${c.label("SDK:")}       ${existsSync(runtimeSdkPluginDir) ? "present" : "missing"}`);
      {
        const globalDir = getGlobalPluginDir();
        if (isGlobalPluginInstalled()) {
          console.log(`  ${c.label("Plugin mode:")} ${c.success("global")} at ${c.file(globalDir)}`);
        } else if (isWorkspacePluginInstalled(process.cwd())) {
          console.log(`  ${c.label("Plugin mode:")} ${c.value("workspace")} (legacy layout in this project)`);
        } else {
          console.log(`  ${c.label("Plugin mode:")} ${c.warn("not installed")} — run \`opencode-rag setup\``);
        }
      }
    } else {
      console.log(`  ${c.label("Runtime:")}    ${c.warn("not installed")}`);
      console.log(`  ${c.label("Run:")}       ${c.file("opencode-rag setup")} to install`);
    }
    console.log();
    return;
  }

  // --- uninstall ---
  if (options.uninstall) {
    console.log(`\n${c.heading("Removing OpenCodeRAG runtime...")}\n`);
    removeIfExists(runtimePluginDir);
    // Only remove the @opencode-ai/plugin SDK package — the scope dir may be
    // shared with other OpenCode plugins/tools.
    removeIfExists(runtimeSdkPluginDir);
    removeIfExists(versionFile);
    if (removeGlobalPlugin()) {
      console.log(`  ${c.updated("Removed:")} ${c.file(getGlobalPluginDir())}`);
    }
    console.log(`  ${c.updated("Removed:")} ${c.file(runtimePluginDir)}`);
    console.log(`  ${c.updated("Removed:")} ${c.file(runtimeSdkPluginDir)}`);
    const uninstallPm = bestAvailablePackageManager() ?? "npm";
    console.log(`\n  ${c.success("Done.")} Run ${c.file(globalUninstallCommand(uninstallPm, PLUGIN_NAME))} to remove the global package.\n`);
    return;
  }

  // --- install runtime ---
  if (options.skipRuntime) {
    console.log(`\n  ${c.exists("Skipped:")}   runtime install (--skip-runtime)`);
  } else {
    console.log(`\n${c.heading("Setting up OpenCodeRAG runtime...")}\n`);
    const installedVersion = readVersionFile(versionFile);
    const runtimeDist = path.join(runtimePluginDir, "dist");
    const alreadyInstalled = existsSync(runtimeDist);

    if (alreadyInstalled && installedVersion === pluginVersion && !options.force) {
      console.log(`  ${c.success("Already up-to-date.")} (${c.value(pluginVersion)}) at ${c.file(runtimeDir)}`);
      console.log(`  ${c.dim("Run `opencode-rag setup --force` to re-install the runtime.\n")}`);
    } else {
      await ensureUpToDate();
    }

    const result = await setupRuntime({ force: options.force, version: pluginVersion });
    if (result.success) {
      console.log(`  ${c.created("Updated:")} runtime at ${c.file(runtimeDir)}`);
      console.log(`  ${c.created("Version:")} ${c.value(pluginVersion)}`);
    } else {
      for (const err of result.errors) {
        console.error(`  ${c.error("✗")} ${err}`);
      }
      console.error(`\n  ${c.error("Setup failed. Please check the errors above or run with --force.\n")}`);
      process.exitCode = 1;
      return;
    }
  }

  // --- global plugin (default) ---
  let pluginMode: "global" | "workspace" = options.workspacePlugin ? "workspace" : "global";
  if (pluginMode === "global") {
    try {
      const installed = installGlobalPlugin({ force: options.force });
      const label = installed.written.length > 0 ? c.created("Installed:") : c.exists("Exists:");
      console.log(`\n  ${label}   global plugin at ${c.file(installed.dir)}`);
    } catch (err) {
      console.log(`\n  ${c.warn("Global plugin install skipped:")} ${(err as Error).message}`);
      console.log(`  ${c.dim("Falling back to the workspace-local plugin layout.")}`);
      pluginMode = "workspace";
    }
  }

  // --- workspace ---
  const cwd = process.cwd();
  const prompter = createPrompter(!options.yes);
  try {
    if (!isLikelyProjectRoot(cwd)) {
      console.log(`\n${c.heading("Workspace")}`);
      console.log(`  ${c.dim("This directory does not look like a project root.")}`);
      const proceed = prompter.interactive
        ? await prompter.confirm({ message: "Initialize it as an OpenCodeRAG workspace anyway?", defaultValue: false })
        : false;
      if (!proceed) {
        console.log(`  ${c.warn("Skipped workspace setup.")} Run setup inside a project directory.\n`);
        return;
      }
    }

    migrateLegacyProjectConfig(cwd);
    const configPath = findConfigFile(cwd) ?? projectConfigPath(cwd);
    const configLabel = path.relative(cwd, configPath).replace(/\\/g, "/");
    const existing = loadWorkspaceRawConfig(cwd);
    const configured = hasConfiguredEmbedding(existing);
    const explicitFlags = hasExplicitSetupFlags(options);
    const existingEmbedding = existing.embedding;
    const configProxy =
      existingEmbedding && typeof existingEmbedding === "object" && !Array.isArray(existingEmbedding)
        ? ((existingEmbedding as Record<string, unknown>).proxy as ProxyConfig | undefined)
        : undefined;

    let answers;
    if (prompter.interactive && (options.reconfigure || !configured)) {
      answers = await runSetupWizard({
        ...options,
        prompter,
        existing,
        proxy: configProxy,
      });
      if (answers === undefined) {
        console.log(`\n  ${c.warn("Setup cancelled.")} No configuration was changed.\n`);
        return;
      }
    } else if (explicitFlags) {
      answers = answersFromFlags(options, existing);
    }

    if (answers) {
      // A wizard/flag run still needs the baseline template (indexing tuning,
      // chunking, retrieval defaults) before the sparse patch is merged in.
      if (!existsSync(configPath)) {
        await writeDefaultWorkspaceConfig(configPath, configLabel);
      }
      const patch = buildConfigPatch(answers);
      const globalPath = globalConfigPath();
      if (!writeConfigPatch(globalPath, patch.global)) {
        console.log(`  ${c.warn("Could not write the global config.")} Check permissions for ${c.file(globalPath)}.`);
      } else {
        console.log(`\n  ${c.updated("Updated:")} ${c.file(globalPath)} ${c.dim("(provider/model settings)")}`);
      }

      // Strip stale provider keys that the old `init` template wrote into the
      // workspace file: the global layer is a base layer, so those copies
      // would shadow the models just chosen.
      const workspaceRaw = readJsonObjectSafe(configPath);
      const shadowing = findShadowingProviderKeys(workspaceRaw);
      if (shadowing.length > 0) {
        const remove = prompter.interactive
          ? await prompter.confirm({
              message: `Remove ${shadowing.length} stale provider setting(s) from ${configLabel}? They would override the global config.`,
              defaultValue: true,
            })
          : true;
        if (remove) {
          removeConfigPaths(workspaceRaw, shadowing);
          writeFileSync(`${configPath}.bak`, readFileSync(configPath, "utf-8"), "utf-8");
          writeFileSync(configPath, `${JSON.stringify(workspaceRaw, null, 2)}\n`, "utf-8");
          console.log(`  ${c.updated("Cleaned:")} ${c.file(configLabel)} ${c.dim("(provider keys moved to the global config)")}`);
        }
      }

      if (!writeConfigPatch(configPath, patch.workspace)) {
        console.log(`  ${c.warn("Could not write the workspace config.")} Check permissions for ${c.file(configPath)}.`);
      } else {
        console.log(`  ${c.updated("Updated:")} ${c.file(configLabel)} ${c.dim("(feature toggles)")}`);
      }
    } else if (!existsSync(configPath)) {
      // Non-interactive first run without flags: write the default template.
      await writeDefaultWorkspaceConfig(configPath, configLabel);
    } else {
      console.log(`\n  ${c.exists("Using:")}   ${c.file(configLabel)} ${c.dim("(run setup --reconfigure to change providers)")}`);
    }

    await scaffoldWorkspace({
      force: options.force,
      skipInstall: options.skipInstall,
      configPath,
      workspacePlugin: pluginMode === "workspace",
    });

    if (!options.skipHealthCheck) {
      const health = await runWorkspaceHealthCheck(cwd, prompter, { autoPull: answers?.recommended === true });
      await offerHealthRepairs({
        cwd,
        workspaceConfigPath: configPath,
        globalConfigPath: globalConfigPath(),
        prompter,
        results: health,
        ...(configProxy ? { proxy: configProxy } : {}),
      });
    }

    if (options.index !== false && prompter.interactive) {
      const buildIndex = await prompter.confirm({
        message: "Build the search index now? (can take a few minutes)",
        defaultValue: true,
      });
      if (buildIndex) buildIndexNow();
    }
  } catch (err) {
    console.error(`\n  ${c.error("Setup failed:")} ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    prompter.close();
    destroyAllPooledConnections();
  }

  console.log(`\n${c.success("Setup complete.")}`);
  console.log(`\n  ${c.dim("Next steps:")}`);
  console.log(`  ${c.dim("  1. Restart OpenCode if it is running")}`);
  console.log(`  ${c.dim("  2. Run `opencode-rag index` to build the search index")}`);
  checkOpenCodeRunning();
  console.log();
}

/**
 * Self-update: when this OpenCodeRAG build is outdated compared to the latest
 * version published on npm, fetch and install the new version of itself.
 *
 * This is independent of how/where the package was installed (global npm
 * prefix, runtime cache junction, or local development link) - the comparison
 * is purely between the running version and the published version. A
 * development build that is newer than the published release is left alone.
 */
async function ensureUpToDate(): Promise<void> {
  const current = getCurrentVersion();
  const latest = await getLatestNpmVersion();
  if (!latest) {
    console.log(`  ${c.dim("Could not check the npm registry for the latest version (offline?).")}`);
    console.log(`  ${c.dim("Run `opencode-rag update` later to upgrade.\n")}`);
    return;
  }
  if (compareVersions(latest, current) <= 0) {
    console.log(`  ${c.dim(`No update needed (local v${current}, npm v${latest}).`)}\n`);
    return;
  }

  console.log(`  ${c.warn("New version available:")} ${c.value(`v${current}`)} ${c.dim("->")} ${c.value(`v${latest}`)}`);
  console.log(`  ${c.dim("Fetching and installing it...\n")}`);
  const updated = await installLatestUpdate({ verbose: false });
  if (!updated.success) {
    console.error(`  ${c.error("✗-")} ${updated.message}`);
    console.error(`  ${c.dim("You can retry later with `opencode-rag update`.\n")}`);
    process.exitCode = 1;
  } else {
    console.log(`  ${c.success("✓")} ${updated.message}`);
  }
}

/**
 * Query the npm registry for the latest published version of the plugin.
 *
 * Fetches the registry over HTTPS directly so the check works no matter which
 * package manager installed this CLI — the npm binary may not even exist on
 * machines set up via pnpm/yarn/bun (GitHub issue #34). Honors
 * `npm_config_registry` (set by all four managers) for private mirrors.
 *
 * Best-effort: returns `null` when every endpoint lookup fails (offline,
 * mirror without the endpoint, malformed response).
 */
async function getLatestNpmVersion(): Promise<string | null> {
  const registry = (process.env.npm_config_registry || "https://registry.npmjs.org").replace(/\/+$/, "");
  const pkgPath = PLUGIN_NAME.includes("/") ? PLUGIN_NAME.replace("/", "%2F") : PLUGIN_NAME;
  const urls = [
    `${registry}/-/package/${pkgPath}/dist-tags`,
    `${registry}/${pkgPath}/latest`,
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    for (const url of urls) {
      try {
        const response = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) continue;
        const data = (await response.json()) as { latest?: unknown; version?: unknown };
        const version = data.latest ?? data.version;
        if (typeof version === "string" && version) return version;
      } catch {
        // Try the next endpoint.
      }
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
