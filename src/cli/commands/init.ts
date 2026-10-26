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
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, copyFileSync } from "node:fs";
import { loadConfig, findConfigFile, loadWorkspaceConfig, configuredSections } from "../../core/config.js";
import { checkProviderHealth, pullOllamaModels } from "../../embedder/health.js";
import { destroyAllPooledConnections } from "../../embedder/http.js";
import { c } from "../format.js";
import { getPackageMetadata, readJsonObject, writeJsonFile } from "../helpers.js";
import type { InitOptions } from "../types.js";
import {
  buildLegacyTuiConfig,
  buildOpencodeConfig,
  buildWorkspacePackageJson,
  generateDefaultConfigJson,
  generateSkillFile,
  generateDecisionSkillFile,
  generateLegacyWorkspacePluginFile,
  generateLegacyWorkspaceTuiPluginFile,
  generateWorkspacePluginFile,
  generateWorkspaceTuiPluginFile,
  installPluginFromGlobal,
  mergeAgentsMdContent,
  mergeGitignoreContent,
  LEGACY_PLUGIN_ENTRY,
  LEGACY_TUI_CONFIG,
  LEGACY_TUI_ENTRY,
  WORKSPACE_PLUGIN_DIR,
  WORKSPACE_PLUGIN_ENTRY,
  WORKSPACE_TUI_ENTRY,
} from "./init-helpers.js";
import { detectOllamaBackend } from "./backend-detect.js";

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
    .description("Configure this workspace (files + auto-tuned opencode-rag.json)")
    .addHelpText(
      "after",
      "\nUse cases:\n" +
      "  - First-time workspace setup: creates .opencode/, the RAG skill file, AGENTS.md\n" +
      "    guidance, and opencode-rag.json with embedding batches auto-detected for the\n" +
      "    Ollama backend (GPU vs CPU).\n" +
      "  - Re-running in an existing workspace: re-syncs plugin/skill files and keeps the\n" +
      "    existing opencode-rag.json (overwriting requires interactive confirmation).\n" +
      "\nUsually run automatically by 'opencode-rag setup'; run manually to re-sync an existing workspace.\n",
    )
    .option("-f, --force", "overwrite existing files")
    .option("--skip-install", "skip installing workspace-local plugin dependencies")
    .option("--skip-health-check", "skip provider connectivity and model availability check")
    .action((options: InitOptions) => runWorkspaceInit(options));
}

/**
 * Run the full workspace initialization: `.opencode/` directory structure,
 * plugin entry files, `opencode-rag.json`, skill file, AGENTS.md guidance,
 * provider health checks, and plugin linking from the global runtime cache.
 *
 * Shared between the `init` command and the automatic workspace step of
 * `opencode-rag setup`.
 *
 * @param options - init options (force, skipInstall, skipHealthCheck).
 */
export async function runWorkspaceInit(options: InitOptions = {}): Promise<void> {
  try {
      const cwd = process.cwd();
      const packageMetadata = getPackageMetadata();
      // Use findConfigFile so an existing config in .opencode/rag.json (or
      // .opencode/opencode-rag.json) is respected instead of being shadowed
      // by a new root-level opencode-rag.json.
      const configPath = findConfigFile(cwd) ?? path.join(cwd, "opencode-rag.json");
      const opencodeDir = path.join(cwd, ".opencode");
      const gitignorePath = path.join(opencodeDir, ".gitignore");
      const opencodeConfigPath = path.join(opencodeDir, "opencode.json");
      const pluginsDir = path.join(opencodeDir, "plugins");
      const workspacePluginDir = path.join(pluginsDir, WORKSPACE_PLUGIN_DIR);
      const pluginEntryPath = path.join(workspacePluginDir, "index.js");
      const tuiPluginEntryPath = path.join(workspacePluginDir, "tui.js");
      const legacyPluginEntryPath = path.join(pluginsDir, "rag-plugin.js");
      const legacyTuiPluginEntryPath = path.join(pluginsDir, "rag-tui.js");
      const legacyTuiConfigPath = path.join(opencodeDir, "tui.json");
      const opencodePackagePath = path.join(opencodeDir, "package.json");

      console.log(`\n${c.heading("Initializing OpenCodeRAG in workspace...")}\n`);

      if (!existsSync(opencodeDir)) {
        mkdirSync(opencodeDir, { recursive: true });
        console.log(`  ${c.created("Created:")}  .opencode/`);
      } else {
        console.log(`  ${c.exists("Exists:")}   .opencode/`);
      }

      // Wiki safety: warn if wiki exists but would be affected (currently init never touches it)
      const wikiDir = path.join(opencodeDir, "wiki");
      if (existsSync(wikiDir)) {
        console.log(`  ${c.exists("Preserved:")} .opencode/wiki/ (never modified by init)`);
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

      // OpenCode 2 discovers plugin *directories* under `.opencode/plugins/`:
      // `index.js` is the server (business) entrypoint and `tui.js` beside it
      // is the CLI entrypoint. Flat `.js` files only reach the server role, so
      // the terminal UI never saw the TUI plugin before this layout.
      if (!existsSync(workspacePluginDir)) {
        mkdirSync(workspacePluginDir, { recursive: true });
        console.log(`  ${c.created("Created:")}  .opencode/plugins/${WORKSPACE_PLUGIN_DIR}/`);
      }

      const pluginEntryExists = existsSync(pluginEntryPath);
      const pluginEntryContent = generateWorkspacePluginFile(packageMetadata.name);
      if (!pluginEntryExists || options.force) {
        writeFileSync(pluginEntryPath, pluginEntryContent, "utf-8");
        console.log(`  ${pluginEntryExists ? c.updated("Updated:") : c.created("Created:")} ${WORKSPACE_PLUGIN_ENTRY}`);
      } else if (readFileSync(pluginEntryPath, "utf-8") !== pluginEntryContent) {
        writeFileSync(pluginEntryPath, pluginEntryContent, "utf-8");
        console.log(`  ${c.updated("Updated:")}  ${WORKSPACE_PLUGIN_ENTRY}`);
      } else {
        console.log(`  ${c.exists("Exists:")}   ${WORKSPACE_PLUGIN_ENTRY}`);
      }

      const tuiPluginEntryExists = existsSync(tuiPluginEntryPath);
      const tuiPluginEntryContent = generateWorkspaceTuiPluginFile(packageMetadata.name);
      if (!tuiPluginEntryExists || options.force) {
        writeFileSync(tuiPluginEntryPath, tuiPluginEntryContent, "utf-8");
        console.log(`  ${tuiPluginEntryExists ? c.updated("Updated:") : c.created("Created:")} ${WORKSPACE_TUI_ENTRY}`);
      } else if (readFileSync(tuiPluginEntryPath, "utf-8") !== tuiPluginEntryContent) {
        writeFileSync(tuiPluginEntryPath, tuiPluginEntryContent, "utf-8");
        console.log(`  ${c.updated("Updated:")}  ${WORKSPACE_TUI_ENTRY}`);
      } else {
        console.log(`  ${c.exists("Exists:")}   ${WORKSPACE_TUI_ENTRY}`);
      }

      // Migrate away from the V1-era flat entries: a leftover `rag-plugin.js`
      // registers the server plugin a second time, and `rag-tui.js` is dead
      // weight (the TUI never loads flat files). Only files whose content is
      // exactly what an earlier `init` wrote are removed — hand-written files
      // and custom `.opencode/tui.json` configs are left untouched.
      const legacyEntries: readonly [string, string, string][] = [
        [legacyPluginEntryPath, generateLegacyWorkspacePluginFile(packageMetadata.name), LEGACY_PLUGIN_ENTRY],
        [legacyTuiPluginEntryPath, generateLegacyWorkspaceTuiPluginFile(packageMetadata.name), LEGACY_TUI_ENTRY],
      ];
      for (const [legacyPath, legacyContent, legacyRel] of legacyEntries) {
        if (!existsSync(legacyPath)) continue;
        if (readFileSync(legacyPath, "utf-8") === legacyContent) {
          unlinkSync(legacyPath);
          console.log(`  ${c.updated("Removed:")}  ${legacyRel} (superseded by ${WORKSPACE_PLUGIN_DIR}/)`);
        } else {
          console.log(`  ${c.warn("Kept:")}     ${legacyRel} (modified locally — no longer loaded by OpenCode 2)`);
        }
      }

      if (existsSync(legacyTuiConfigPath)) {
        const sameLegacyConfig =
          JSON.stringify(readJsonObject(legacyTuiConfigPath)) === JSON.stringify(buildLegacyTuiConfig());
        if (sameLegacyConfig) {
          unlinkSync(legacyTuiConfigPath);
          console.log(`  ${c.updated("Removed:")}  ${LEGACY_TUI_CONFIG} (V1 config — OpenCode 2 discovers CLI plugins)`);
        } else {
          console.log(`  ${c.warn("Kept:")}     ${LEGACY_TUI_CONFIG} (V1 config — ignored by OpenCode 2)`);
        }
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

      // Separate decision-model skill — loaded on demand when a task needs
      // classification/routing/scoring via `make_decision`.
      const decisionSkillDir = path.join(skillsDir, "make-decision");
      const decisionSkillPath = path.join(decisionSkillDir, "SKILL.md");
      if (!existsSync(decisionSkillDir)) {
        mkdirSync(decisionSkillDir, { recursive: true });
        console.log(`  ${c.created("Created:")}  .opencode/skills/make-decision/`);
      }
      const decisionSkillContent = generateDecisionSkillFile();
      const decisionSkillExists = existsSync(decisionSkillPath);
      if (!decisionSkillExists || options.force) {
        writeFileSync(decisionSkillPath, decisionSkillContent, "utf-8");
        console.log(`  ${decisionSkillExists ? c.updated("Updated:") : c.created("Created:")} .opencode/skills/make-decision/SKILL.md`);
      } else if (readFileSync(decisionSkillPath, "utf-8") !== decisionSkillContent) {
        writeFileSync(decisionSkillPath, decisionSkillContent, "utf-8");
        console.log(`  ${c.updated("Updated:")}  .opencode/skills/make-decision/SKILL.md`);
      } else {
        console.log(`  ${c.exists("Exists:")}   .opencode/skills/make-decision/SKILL.md`);
      }

      const agentsMdPath = path.join(cwd, "AGENTS.md");
      const agentsMdExists = existsSync(agentsMdPath);
      // Read effective memory/decision flags from existing config (if present)
      let promptEnforcement = true;
      let decisionEnabled = false;
      let routeBeforeAsking = false;
      try {
        if (existsSync(configPath)) {
          const existingCfg = loadConfig(configPath, false);
          promptEnforcement = existingCfg.memory?.promptEnforcement ?? true;
          decisionEnabled = existingCfg.decision?.enabled ?? false;
          routeBeforeAsking = existingCfg.decision?.routeBeforeAsking ?? false;
        }
      } catch {
        // Malformed or missing config — use defaults
      }
      const nextAgentsMd = mergeAgentsMdContent(
        agentsMdExists ? readFileSync(agentsMdPath, "utf-8") : undefined,
        { promptEnforcement, decisionEnabled, routeBeforeAsking },
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

      // Detect the Ollama backend (CPU vs GPU) lazily — only when we are
      // actually about to write a config — and tune embedding batches for it.
      let detectedTuning: { embedBatchSize: number; embedConcurrency: number; ollamaMaxBatchSize: number } | undefined;
      const configContent = async (): Promise<string> => {
        if (!detectedTuning) {
          try {
            const info = await detectOllamaBackend();
            detectedTuning = info.tuning;
            const icon =
              info.backend === "gpu" ? c.success("GPU:") :
              info.backend === "cpu" ? c.warn("CPU:") :
              c.dim("Backend:");
            console.log(`  ${icon} ${info.message}`);
          } catch {
            detectedTuning = undefined;
          }
        }
        // Carry the identity-critical embedding keys (apiKey, vectorDimension)
        // over from the file being replaced: a reset must never downgrade the
        // store schema to the 384 default or drop provider auth.
        let existingRaw: string | undefined;
        if (configExists) {
          try {
            existingRaw = readFileSync(configPath, "utf-8");
          } catch {
            existingRaw = undefined;
          }
        }
        return generateDefaultConfigJson(detectedTuning, existingRaw);
      };

      if (!configExists) {
        writeFileSync(configPath, await configContent(), "utf-8");
        console.log(`  ${c.created("Created:")} opencode-rag.json`);
      } else {
        // NEVER overwrite existing config without interactive confirmation
        let overwrite = false;
        if (process.stdin.isTTY) {
          const readline = await import("node:readline");
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise<string>((resolve) => {
            rl.question(
              `  ${c.warn("opencode-rag.json already exists.")} Overwrite with default config? A backup will be saved. (y/N) `,
              resolve,
            );
          });
          rl.close();
          overwrite = /^y(?:es)?$/i.test(answer.trim());
        }
        if (overwrite) {
          copyFileSync(configPath, `${configPath}.bak`);
          console.log(`  ${c.dim("Backup:")}        opencode-rag.json.bak`);
          writeFileSync(configPath, await configContent(), "utf-8");
          console.log(`  ${c.updated("Updated:")}  opencode-rag.json`);
        } else {
          console.log(`  ${c.exists("Exists:")}   opencode-rag.json (preserved)`);
          if (!process.stdin.isTTY && options.force) {
            console.log(`  ${c.warn("Skipped overwrite:")} non-interactive shell. Edit opencode-rag.json manually or re-run in a TTY.`);
          }
        }
      }

      // ── Provider health check + dependency install (parallel) ──
      const healthPromise = options.skipHealthCheck
        ? null
        : (async () => {
            console.log(`\n${c.heading("Checking provider connectivity...")}\n`);
            // Effective config (global < workspace) and the sections the user
            // actually configured: models that are merely on by default are
            // never probed or offered for `ollama pull`.
            const ragConfig = loadWorkspaceConfig(cwd);
            return checkProviderHealth(ragConfig, configuredSections(cwd));
          })();

      const installPromise = options.skipInstall
        ? null
        : installPluginFromGlobal(opencodeDir, packageMetadata.name, false);

      // Wait for health check results first
      if (healthPromise) {
        const results = await healthPromise;

        for (const r of results) {
          const icon = r.status === "ok" ? c.success("✓") : r.status === "missing" ? c.warn("○") : c.error("✗");
          const typeLabel = r.type === "image_description" ? "image description" : r.type === "image_description_on_demand" ? "image description (on-demand)" : r.type;
          const label = `${typeLabel} model`;
          console.log(`  ${icon} ${c.value(r.model)} (${r.provider}) — ${label}: ${r.status}`);
          if (r.error) console.log(`    ${c.dim(r.error)}`);
        }

        const missingOllama = results.filter((r) => r.status === "missing" && r.provider === "ollama");
        if (missingOllama.length > 0) {
          const ragConfig = loadWorkspaceConfig(cwd);
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
            if (r.type === "image_description_on_demand" && ragConfig.imageDescription) {
              const onDemand = ragConfig.imageDescription.onDemand;
              return {
                model: r.model,
                baseUrl: onDemand?.baseUrl ?? ragConfig.imageDescription.baseUrl,
                proxy: onDemand?.proxy ?? ragConfig.imageDescription.proxy,
              };
            }
            return { model: r.model, baseUrl: ragConfig.embedding.baseUrl, proxy: ragConfig.embedding.proxy };
          });
          console.log(`\n  ${c.warn("Models not found:")} ${pullEntries.map((e) => e.model).join(", ")}`);

          // Non-TTY guard: rl.question would block forever with a still-open
          // stdin pipe (e.g. `echo y | opencode-rag init`, CI runners).
          if (!process.stdin.isTTY) {
            console.log(`  ${c.dim("Non-interactive shell — skipping. Pull manually with: ollama pull <model>")}`);
          } else {
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
}

/**
 * Best-effort check whether `cwd` looks like a project root (git repo or
 * common project manifest files). `opencode-rag setup` uses this to decide
 * whether to automatically initialize the current workspace.
 *
 * @param cwd - Directory to inspect.
 * @returns Whether the directory looks like a project root.
 */
export function isLikelyProjectRoot(cwd: string): boolean {
  if (existsSync(path.join(cwd, ".git"))) {
    return true;
  }
  const markers = [
    "package.json",
    "AGENTS.md",
    "README.md",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "opencode-rag.json",
  ];
  return markers.some((marker) => existsSync(path.join(cwd, marker)));
}

/**
 * Check whether the workspace at `cwd` has already been initialized with
 * OpenCodeRAG (plugin entry files and the TUI plugin config are present).
 *
 * @param cwd - Directory to inspect.
 * @returns Whether the workspace looks initialized.
 */
export function isWorkspaceInitialized(cwd: string): boolean {
  // V2 layout: plugin directory with server + TUI entrypoints beside each other.
  if (
    existsSync(path.join(cwd, ".opencode", "plugins", WORKSPACE_PLUGIN_DIR, "index.js")) &&
    existsSync(path.join(cwd, ".opencode", "plugins", WORKSPACE_PLUGIN_DIR, "tui.js"))
  ) {
    return true;
  }
  // V1 layout (flat entries + .opencode/tui.json): treated as *not* initialized
  // so `setup` re-runs `init` once and migrates the workspace.
  return false;
}
