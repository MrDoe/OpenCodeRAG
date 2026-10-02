import type { Command } from "commander";
import path from "node:path";
import { existsSync, lstatSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
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
import { isLikelyProjectRoot, isWorkspaceInitialized, runWorkspaceInit } from "./init.js";

const PLUGIN_NAME = "opencode-rag-plugin";

interface SetupOptions {
  uninstall?: boolean;
  force?: boolean;
  check?: boolean;
}

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
      });
      console.log(`\n  ${c.warn("OpenCode is currently running.")} Restart it to load the updated plugin.`);
    } else {
      const pids = execSync("pgrep -x opencode 2>/dev/null", {
        encoding: "utf-8",
        timeout: 3_000,
      }).trim();
      if (pids) {
        console.log(`\n  ${c.warn("OpenCode is currently running.")} Restart it to load the updated plugin.`);
      }
    }
  } catch {
    // OpenCode not found or tools unavailable
  }
}

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Install/update the OpenCodeRAG runtime and initialize the current workspace")
    .addHelpText(
      "after",
      "\nUse cases:\n" +
      "  - First-time install: run once per machine to install the plugin runtime\n" +
      "    into ~/.opencode/ so OpenCode can discover the RAG plugin. When\n" +
      "    outdated, fetches and installs the latest published version from npm.\n" +
      "  - Workspace setup: run inside a project to also initialize .opencode/,\n" +
      "    the skill file and opencode-rag.json for this workspace.\n" +
      "  - Updating: use 'opencode-rag update' to install a newer release.\n" +
      "  - Troubleshooting: use --check to inspect the runtime, or --force to reinstall.\n" +
      "\nMachine + workspace step: run 'opencode-rag init' only when you need to re-sync\nan already initialized workspace.\n",
    )
    .option("--uninstall", "remove the runtime and cleanup")
    .option("-f, --force", "force re-setup even if up-to-date")
    .option("--check", "check whether the runtime is correctly installed")
    .action(async (options: SetupOptions) => {
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
            } catch { return "?"; }
          })() : "missing"}`);
          console.log(`  ${c.label("SDK:")}       ${existsSync(runtimeSdkPluginDir) ? "present" : "missing"}`);
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
        // Only remove the @opencode-ai/plugin SDK package — the scope dir may
        // be shared with other OpenCode plugins/tools.
        removeIfExists(runtimeSdkPluginDir);
        removeIfExists(versionFile);
        console.log(`  ${c.updated("Removed:")} ${c.file(runtimePluginDir)}`);
        console.log(`  ${c.updated("Removed:")} ${c.file(runtimeSdkPluginDir)}`);
        const uninstallPm = bestAvailablePackageManager() ?? "npm";
        console.log(`\n  ${c.success("Done.")} Run ${c.file(globalUninstallCommand(uninstallPm, PLUGIN_NAME))} to remove the global package.\n`);
        return;
      }

      // --- install ---
      console.log(`\n${c.heading("Setting up OpenCodeRAG runtime...")}\n`);

      // Check if already installed and up-to-date
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
        process.exit(1);
      }

      // --- workspace step: automatically initialize the current workspace ---
      const cwd = process.cwd();
      console.log(`\n${c.heading("Workspace")}`);
      if (isLikelyProjectRoot(cwd)) {
        if (isWorkspaceInitialized(cwd)) {
          console.log(`  ${c.exists("Exists:")}   OpenCodeRAG already initialized in ${c.file(cwd)}`);
          console.log(`  ${c.dim("Run `opencode-rag init` to re-sync workspace files when needed.\n")}`);
        } else {
          await runWorkspaceInit({});
        }
      } else {
        console.log(`  ${c.dim("Current directory is not a project root - skipping workspace initialization.")}`);
        console.log(`  ${c.dim("Run `opencode-rag init` inside the workspace when needed.\n")}`);
      }

      console.log(`\n${c.success("Setup complete.")}`);
      console.log(`\n  ${c.dim("Next steps:")}`);
      console.log(`  ${c.dim("  1. Restart OpenCode if it is running")}`);
      console.log(`  ${c.dim("  2. Run `opencode-rag index` to build the search index")}`);

      checkOpenCodeRunning();

      console.log();
    });
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
    process.exit(1);
  }
  console.log(`  ${c.success("✓")} ${updated.message}`);
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
 *
 * @returns The latest version string, or `null` on failure.
 */
async function getLatestNpmVersion(): Promise<string | null> {
  const registry = (process.env.npm_config_registry || "https://registry.npmjs.org").replace(/\/+$/, "");
  const pkgPath = PLUGIN_NAME.includes("/") ? PLUGIN_NAME.replace("/", "%2F") : PLUGIN_NAME;
  // Prefer the lightweight dist-tags endpoint; fall back to the version
  // document for mirrors that do not implement it.
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
