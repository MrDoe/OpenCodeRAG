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
    .description("Set up the OpenCodeRAG runtime (~/.opencode/) for OpenCode plugin discovery")
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
        removeIfExists(runtimeSdkDir);
        removeIfExists(versionFile);
        console.log(`  ${c.updated("Removed:")} ${c.file(runtimeDir)}`);
        console.log(`\n  ${c.success("Done.")} Run ${c.file("npm uninstall -g opencode-rag-plugin")} to remove the global package.\n`);
        return;
      }

      // --- install ---
      console.log(`\n${c.heading("Setting up OpenCodeRAG runtime...")}\n`);

      // Check if already installed and up-to-date
      const installedVersion = readVersionFile(versionFile);
      const runtimeDist = path.join(runtimePluginDir, "dist");
      const alreadyInstalled = existsSync(runtimeDist);

      if (alreadyInstalled && installedVersion === pluginVersion && !options.force) {
        console.log(`  ${c.success("Already up-to-date.")} (${c.value(pluginVersion)}) at ${c.file(runtimeDir)}\n`);
        console.log(`  ${c.dim("Run `opencode-rag setup --force` to re-install.")}\n`);
        return;
      }

      const result = await setupRuntime({ force: options.force, version: pluginVersion });

      if (result.success) {
        console.log(`  ${c.created("Updated:")} runtime at ${c.file(runtimeDir)}`);
        console.log(`  ${c.created("Version:")} ${c.value(pluginVersion)}`);
        console.log(`\n${c.success("Setup complete.")}`);
        console.log(`\n  ${c.dim("Next steps:")}`);
        console.log(`  ${c.dim("  1. Restart OpenCode if it is running")}`);
        console.log(`  ${c.dim("  2. Run `opencode-rag init` in each workspace")}`);
        console.log(`  ${c.dim("  3. Run `opencode-rag index` to build the search index")}`);
      } else {
        for (const err of result.errors) {
          console.error(`  ${c.error("✗")} ${err}`);
        }
        console.error(`\n  ${c.error("Setup failed. Please check the errors above or run with --force.\n")}`);
        process.exit(1);
      }

      checkOpenCodeRunning();

      console.log();
    });
}
