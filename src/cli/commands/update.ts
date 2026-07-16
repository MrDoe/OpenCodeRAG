/**
 * @fileoverview `update` command — checks GitHub for a newer OpenCodeRAG release and installs it.
 */
/**
 * `update` command — checks for a newer published version of OpenCodeRAG and,
 * by default, installs it (via `npm install -g ...@latest`) then re-syncs the
 * OpenCode runtime junctions so the new build is picked up on next restart.
 */

import type { Command } from "commander";
import { c } from "../format.js";
import { checkForUpdate, getCurrentVersion, installLatestUpdate } from "../../core/version-check.js";

interface UpdateOptions {
  /** Only report whether an update is available; do not install. */
  check?: boolean;
  /** Stream npm/setup output to the console instead of capturing it. */
  verbose?: boolean;
}

/**
 * Register the `update` command on the given Commander program.
 *
 * @param program - The Commander `Command` instance to register on.
 */
export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description("Check for and install the newest published version of OpenCodeRAG")
    .option("--check", "only check whether an update is available; do not install")
    .option("-v, --verbose", "stream npm/setup output to the console")
    .action(async (options: UpdateOptions) => {
      const currentVersion = getCurrentVersion();

      console.log(`\n${c.heading("OpenCodeRAG Update")}\n`);
      console.log(`  ${c.label("Current version:")} ${c.value(currentVersion)}`);
      console.log(`  ${c.label("Checking...")}     `);

      let info;
      try {
        info = await checkForUpdate(currentVersion);
      } catch {
        console.log(`\n  ${c.warn("Could not reach the update server. Check your network and try again.")}\n`);
        process.exit(1);
        return;
      }

      if (!info.updateAvailable) {
        console.log(`\n  ${c.success("Already up-to-date.")} (${c.value(info.latestVersion || currentVersion)})\n`);
        return;
      }

      console.log(`  ${c.label("Latest version:")}  ${c.value(info.latestVersion)}`);
      if (info.publishedAt) {
        console.log(`  ${c.label("Published:")}      ${c.dim(info.publishedAt)}`);
      }
      if (info.releaseUrl) {
        console.log(`  ${c.label("Release notes:")}  ${c.file(info.releaseUrl)}`);
      }

      if (options.check) {
        console.log(`\n  ${c.warn("Update available.")} Run ${c.file("opencode-rag update")} to install.\n`);
        return;
      }

      console.log(`\n  ${c.dim("Installing newest version...")}\n`);
      const result = await installLatestUpdate({ verbose: options.verbose });

      if (result.success) {
        console.log(`  ${c.success("✓")} ${result.message}`);
        console.log(`\n  ${c.dim("Restart OpenCode if it is running to load the new version.")}\n`);
      } else {
        console.error(`  ${c.error("✗")} ${result.message}`);
        console.error(`\n  ${c.error("Update failed. You can retry with `opencode-rag update` or install manually:")}\n`);
        console.error(`  ${c.dim("  npm install -g opencode-rag-plugin@latest && opencode-rag setup")}\n`);
        process.exit(1);
      }
    });
}
