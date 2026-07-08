/**
 * @fileoverview Init command for configuring a workspace with OpenCodeRAG (directory structure, plugin files, config, health checks).
 */
/**
 * `init` command — configures a workspace for OpenCodeRAG.
 *
 * Creates the `.opencode/` directory structure, plugin entry files,
 * workspace package.json, opencode config, skill file, and runtime
 * configuration. Also handles provider health checks and dependency
 * installation.
 */

import type { Command } from "commander";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { loadConfig } from "../../core/config.js";
import { checkProviderHealth, pullOllamaModels } from "../../embedder/health.js";
import { destroyAllPooledConnections } from "../../embedder/http.js";
import { c } from "../format.js";
import { getPackageMetadata, readJsonObject, writeJsonFile } from "../helpers.js";
import type { InitOptions } from "../types.js";
import {
  buildOpencodeConfig,
  buildWorkspacePackageJson,
  generateDefaultConfigJson,
  generateSkillFile,
  generateWorkspacePluginFile,
  generateWorkspaceTuiPluginFile,
  installPluginFromGlobal,
  mergeAgentsMdContent,
  mergeGitignoreContent,
} from "./init-helpers.js";

/**
 * Register the `init` command on the given Commander program.
 *
 * Creates the full `.opencode/` workspace structure, plugin entries,
 * skill file, and `opencode-rag.json` config. Optionally runs provider
 * health checks and installs workspace-local npm dependencies.
 *
 * @param program - The Commander `Command` instance to register on.
 */
export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Configure the current workspace for OpenCodeRAG")
    .option("-f, --force", "overwrite existing files")
    .option("--skip-install", "skip installing workspace-local plugin dependencies")
    .option("--skip-health-check", "skip provider connectivity and model availability check")
    .action(async (options: InitOptions) => {
      try {
        const cwd = process.cwd();
        const packageMetadata = getPackageMetadata();
      const configPath = path.join(cwd, "opencode-rag.json");
      const opencodeDir = path.join(cwd, ".opencode");
      const gitignorePath = path.join(opencodeDir, ".gitignore");
      const opencodeConfigPath = path.join(opencodeDir, "opencode.json");
      const pluginsDir = path.join(opencodeDir, "plugins");
      const pluginEntryPath = path.join(pluginsDir, "rag-plugin.js");
      const tuiPluginEntryPath = path.join(pluginsDir, "rag-tui.js");
      const tuiConfigPath = path.join(opencodeDir, "tui.json");
      const opencodePackagePath = path.join(opencodeDir, "package.json");

      console.log(`\n${c.heading("Initializing OpenCodeRAG in workspace...")}\n`);

      if (!existsSync(opencodeDir)) {
        mkdirSync(opencodeDir, { recursive: true });
        console.log(`  ${c.created("Created:")}  .opencode/`);
      } else {
        console.log(`  ${c.exists("Exists:")}   .opencode/`);
      }

      if (!existsSync(pluginsDir)) {
        mkdirSync(pluginsDir, { recursive: true });
        console.log(`  ${c.created("Created:")}  .opencode/plugins/`);
      } else {
        console.log(`  ${c.exists("Exists:")}   .opencode/plugins/`);
      }

      const gitignoreExists = existsSync(gitignorePath);
      const nextGitignoreContent = mergeGitignoreContent(
        gitignoreExists ? readFileSync(gitignorePath, "utf-8") : undefined,
      );
      if (!gitignoreExists || options.force || readFileSync(gitignorePath, "utf-8") !== nextGitignoreContent) {
        writeFileSync(gitignorePath, nextGitignoreContent, "utf-8");
        console.log(`  ${gitignoreExists ? c.updated("Updated:") : c.created("Created:")} .opencode/.gitignore`);
      } else {
        console.log(`  ${c.exists("Exists:")}   .opencode/.gitignore`);
      }

      const opencodeConfigExists = existsSync(opencodeConfigPath);
      const nextOpencodeConfig = buildOpencodeConfig(readJsonObject(opencodeConfigPath));
      if (!opencodeConfigExists || options.force) {
        writeJsonFile(opencodeConfigPath, nextOpencodeConfig);
        console.log(`  ${opencodeConfigExists ? c.updated("Updated:") : c.created("Created:")} .opencode/opencode.json`);
      } else if (JSON.stringify(readJsonObject(opencodeConfigPath)) !== JSON.stringify(nextOpencodeConfig)) {
        writeJsonFile(opencodeConfigPath, nextOpencodeConfig);
        console.log(`  ${c.updated("Updated:")}  .opencode/opencode.json`);
      } else {
        console.log(`  ${c.exists("Exists:")}   .opencode/opencode.json`);
      }

      const pluginEntryExists = existsSync(pluginEntryPath);
      const pluginEntryContent = generateWorkspacePluginFile(packageMetadata.name);
      if (!pluginEntryExists || options.force) {
        writeFileSync(pluginEntryPath, pluginEntryContent, "utf-8");
        console.log(`  ${pluginEntryExists ? c.updated("Updated:") : c.created("Created:")} .opencode/plugins/rag-plugin.js`);
      } else if (readFileSync(pluginEntryPath, "utf-8") !== pluginEntryContent) {
        writeFileSync(pluginEntryPath, pluginEntryContent, "utf-8");
        console.log(`  ${c.updated("Updated:")}  .opencode/plugins/rag-plugin.js`);
      } else {
        console.log(`  ${c.exists("Exists:")}   .opencode/plugins/rag-plugin.js`);
      }

      const tuiPluginEntryExists = existsSync(tuiPluginEntryPath);
      const tuiPluginEntryContent = generateWorkspaceTuiPluginFile(packageMetadata.name);
      if (!tuiPluginEntryExists || options.force) {
        writeFileSync(tuiPluginEntryPath, tuiPluginEntryContent, "utf-8");
        console.log(`  ${tuiPluginEntryExists ? c.updated("Updated:") : c.created("Created:")} .opencode/plugins/rag-tui.js`);
      } else if (readFileSync(tuiPluginEntryPath, "utf-8") !== tuiPluginEntryContent) {
        writeFileSync(tuiPluginEntryPath, tuiPluginEntryContent, "utf-8");
        console.log(`  ${c.updated("Updated:")}  .opencode/plugins/rag-tui.js`);
      } else {
        console.log(`  ${c.exists("Exists:")}   .opencode/plugins/rag-tui.js`);
      }

      const tuiConfigExists = existsSync(tuiConfigPath);
      const nextTuiConfig = { plugin: ["./plugins/rag-tui.js"] };
      if (!tuiConfigExists || options.force) {
        writeJsonFile(tuiConfigPath, nextTuiConfig);
        console.log(`  ${tuiConfigExists ? c.updated("Updated:") : c.created("Created:")} .opencode/tui.json`);
      } else if (JSON.stringify(readJsonObject(tuiConfigPath)) !== JSON.stringify(nextTuiConfig)) {
        writeJsonFile(tuiConfigPath, nextTuiConfig);
        console.log(`  ${c.updated("Updated:")}  .opencode/tui.json`);
      } else {
        console.log(`  ${c.exists("Exists:")}   .opencode/tui.json`);
      }

      const skillsDir = path.join(opencodeDir, "skills");
      const skillDir = path.join(skillsDir, "opencode-rag");
      const skillPath = path.join(skillDir, "SKILL.md");
      if (!existsSync(skillDir)) {
        mkdirSync(skillDir, { recursive: true });
        console.log(`  ${c.created("Created:")}  .opencode/skills/opencode-rag/`);
      }
      const skillContent = generateSkillFile();
      const skillExists = existsSync(skillPath);
      if (!skillExists || options.force) {
        writeFileSync(skillPath, skillContent, "utf-8");
        console.log(`  ${skillExists ? c.updated("Updated:") : c.created("Created:")} .opencode/skills/opencode-rag/SKILL.md`);
      } else if (readFileSync(skillPath, "utf-8") !== skillContent) {
        writeFileSync(skillPath, skillContent, "utf-8");
        console.log(`  ${c.updated("Updated:")}  .opencode/skills/opencode-rag/SKILL.md`);
      } else {
        console.log(`  ${c.exists("Exists:")}   .opencode/skills/opencode-rag/SKILL.md`);
      }

      const agentsMdPath = path.join(cwd, "AGENTS.md");
      const agentsMdExists = existsSync(agentsMdPath);
      const nextAgentsMd = mergeAgentsMdContent(
        agentsMdExists ? readFileSync(agentsMdPath, "utf-8") : undefined,
      );
      if (!agentsMdExists || options.force) {
        writeFileSync(agentsMdPath, nextAgentsMd, "utf-8");
        console.log(`  ${agentsMdExists ? c.updated("Updated:") : c.created("Created:")} AGENTS.md`);
      } else if (readFileSync(agentsMdPath, "utf-8") !== nextAgentsMd) {
        writeFileSync(agentsMdPath, nextAgentsMd, "utf-8");
        console.log(`  ${c.updated("Updated:")}  AGENTS.md`);
      } else {
        console.log(`  ${c.exists("Exists:")}   AGENTS.md`);
      }

      const workspacePackageExists = existsSync(opencodePackagePath);
      const nextWorkspacePackage = buildWorkspacePackageJson(readJsonObject(opencodePackagePath), packageMetadata);
      if (!workspacePackageExists || options.force) {
        writeJsonFile(opencodePackagePath, nextWorkspacePackage);
        console.log(`  ${workspacePackageExists ? c.updated("Updated:") : c.created("Created:")} .opencode/package.json`);
      } else if (JSON.stringify(readJsonObject(opencodePackagePath)) !== JSON.stringify(nextWorkspacePackage)) {
        writeJsonFile(opencodePackagePath, nextWorkspacePackage);
        console.log(`  ${c.updated("Updated:")}  .opencode/package.json`);
      } else {
        console.log(`  ${c.exists("Exists:")}   .opencode/package.json`);
      }

      const configExists = existsSync(configPath);
      if (!configExists || options.force) {
        if (configExists && options.force) {
          copyFileSync(configPath, configPath + ".bak");
          console.log(`  ${c.dim("Backup:")}        ${configPath}.bak`);
        }
        writeFileSync(configPath, generateDefaultConfigJson(), "utf-8");
        console.log(`  ${configExists ? c.updated("Updated:") : c.created("Created:")} opencode-rag.json`);
      } else {
        console.log(`  ${c.exists("Exists:")}   opencode-rag.json`);
      }

      // ── Provider health check + dependency install (parallel) ──
      const healthPromise = options.skipHealthCheck
        ? null
        : (async () => {
            console.log(`\n${c.heading("Checking provider connectivity...")}\n`);
            const ragConfig = loadConfig(configPath);
            return checkProviderHealth(ragConfig);
          })();

      const installPromise = options.skipInstall
        ? null
        : installPluginFromGlobal(opencodeDir, packageMetadata.name, false);

      // Wait for health check results first
      if (healthPromise) {
        const results = await healthPromise;

        for (const r of results) {
          const icon = r.status === "ok" ? c.success("✓") : r.status === "missing" ? c.warn("○") : c.error("✗");
          const typeLabel = r.type === "image_description" ? "image description" : r.type;
          const label = `${typeLabel} model`;
          console.log(`  ${icon} ${c.value(r.model)} (${r.provider}) — ${label}: ${r.status}`);
          if (r.error) console.log(`    ${c.dim(r.error)}`);
        }

        const missingOllama = results.filter((r) => r.status === "missing" && r.provider === "ollama");
        if (missingOllama.length > 0) {
          const ragConfig = loadConfig(configPath);
          const pullEntries = missingOllama.map((r) => {
            if (r.type === "embedding") {
              return { model: r.model, baseUrl: ragConfig.embedding.baseUrl, proxy: ragConfig.embedding.proxy };
            }
            if (r.type === "description" && ragConfig.description) {
              return { model: r.model, baseUrl: ragConfig.description.baseUrl, proxy: ragConfig.description.proxy };
            }
            if (r.type === "image_description" && ragConfig.imageDescription) {
              return { model: r.model, baseUrl: ragConfig.imageDescription.baseUrl, proxy: ragConfig.imageDescription.proxy };
            }
            return { model: r.model, baseUrl: ragConfig.embedding.baseUrl, proxy: ragConfig.embedding.proxy };
          });
          console.log(`\n  ${c.warn("Models not found:")} ${pullEntries.map((e) => e.model).join(", ")}`);

          const readline = await import("node:readline");
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise<string>((resolve) => {
            rl.question(`  Pull ${pullEntries.length === 1 ? "this model" : "these models"} now? (y/n) `, resolve);
          });
          rl.close();

          if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
            console.log();
            try {
              await pullOllamaModels(pullEntries, (model, line) => {
                console.log(`  ${c.value(model)}: ${line}`);
              });
              console.log(`\n  ${c.success("Models pulled successfully.")}`);
            } catch (err) {
              console.error(`\n  ${c.error("Pull failed:")} ${(err as Error).message}`);
              console.log(`  ${c.dim("Pull manually with: ollama pull <model>")}`);
            }
          } else {
            console.log(`  ${c.dim("Skipped. Pull manually with: ollama pull <model>")}`);
          }
        }

        const hasErrors = results.some((r) => r.status === "error");
        if (hasErrors) {
          console.log(`\n  ${c.warn("Some providers are not reachable.")} Check configuration and network, then run ${c.file("'opencode-rag index'")}.`);
        }
      }

      // Now install the plugin from global cache via junction
      if (installPromise) {
        console.log(`\n${c.heading("Installing workspace-local plugin...")}\n`);
        await installPromise;
        console.log(`\n  ${c.success("Installed:")} .opencode/node_modules/`);
        console.log(`  ${c.dim("Plugin is linked to global runtime cache; no npm install was required.")}`);
      } else {
        console.log(`\n  ${c.exists("Skipped:")}   plugin installation (--skip-install)`);
      }

      console.log(`\n${c.success("Done.")} Restart OpenCode if it is running, then run ${c.file("'opencode-rag index'")} in this workspace.`);
    } catch (err) {
      console.error(`\n  ${c.error("Init failed:")} ${(err as Error).message}`);
      console.error(`  ${c.dim("Fix the issue above, then run 'opencode-rag init' again.")}`);
      process.exitCode = 1;
    } finally {
      destroyAllPooledConnections();
    }
    });
}
