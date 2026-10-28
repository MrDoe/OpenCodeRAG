/**
 * @fileoverview Workspace scaffolding shared by `opencode-rag setup`.
 *
 * Creates/updates the `.opencode/` tree, plugin entrypoints, skills,
 * `AGENTS.md` guidance and the workspace `package.json`. Configuration is
 * written separately (see `src/cli/wizard/apply.ts`) so the wizard can decide
 * what goes into the workspace file before `AGENTS.md` is rendered from the
 * effective `decision`/`memory` flags.
 */

import path from "node:path";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { loadConfig, loadWorkspaceConfig, configuredSections, findConfigFile, projectConfigPath } from "../core/config.js";
import { checkProviderHealth, pullOllamaModels } from "../embedder/health.js";
import { c } from "./format.js";
import { getPackageMetadata, readJsonObject, writeJsonFile } from "./helpers.js";
import type { Prompter } from "./prompt.js";
import {
  buildLegacyTuiConfig,
  buildOpencodeConfig,
  buildWorkspacePackageJson,
  generateDecisionSkillFile,
  generateLegacyWorkspacePluginFile,
  generateLegacyWorkspaceTuiPluginFile,
  generateSkillFile,
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
} from "./commands/workspace-helpers.js";

/** Options for {@link scaffoldWorkspace}. */
export interface WorkspaceScaffoldOptions {
  /** Rewrite generated files even when their content already matches. */
  force?: boolean;
  /** Skip linking the plugin from the global runtime cache. */
  skipInstall?: boolean;
  /** Config path used to render the AGENTS.md guidance. */
  configPath?: string;
}

/**
 * Best-effort check whether `cwd` looks like a project root (git repo or
 * common project manifest files). `setup` uses this to warn before creating
 * `.opencode/` in an unrelated directory.
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
    ".opencode/opencode-rag.json",
  ];
  return markers.some((marker) => existsSync(path.join(cwd, marker)));
}

/**
 * Create or refresh the workspace files.
 *
 * Idempotent: unchanged generated files are reported as existing and not
 * rewritten. The workspace config is never modified here.
 */
export async function scaffoldWorkspace(options: WorkspaceScaffoldOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const packageMetadata = getPackageMetadata();
  const configPath = options.configPath ?? findConfigFile(cwd) ?? projectConfigPath(cwd);
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

  console.log(`\n${c.heading("Workspace files")}\n`);

  if (!existsSync(opencodeDir)) {
    mkdirSync(opencodeDir, { recursive: true });
    console.log(`  ${c.created("Created:")}  .opencode/`);
  } else {
    console.log(`  ${c.exists("Exists:")}   .opencode/`);
  }

  // The wiki is user-authored; setup never touches it.
  const wikiDir = path.join(opencodeDir, "wiki");
  if (existsSync(wikiDir)) {
    console.log(`  ${c.exists("Preserved:")} .opencode/wiki/ (never modified by setup)`);
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
  // `index.js` is the server entrypoint and `tui.js` beside it is the CLI
  // entrypoint. Flat `.js` files only reach the server role.
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

  // Remove only the V1-era flat entries that an older `init` wrote verbatim;
  // modified files are kept (they are no longer loaded by OpenCode 2).
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
    // Malformed or missing config — use defaults.
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

  if (options.skipInstall) {
    console.log(`\n  ${c.exists("Skipped:")}   plugin installation (--skip-install)`);
    return;
  }
  console.log(`\n${c.heading("Installing workspace-local plugin...")}\n`);
  await installPluginFromGlobal(opencodeDir, packageMetadata.name, false);
  console.log(`\n  ${c.success("Installed:")} .opencode/node_modules/`);
  console.log(`  ${c.dim("Plugin is linked to the global runtime cache; no npm install was required.")}`);
}

/**
 * Check provider connectivity and offer to pull missing Ollama models.
 *
 * Uses the effective config (global < workspace) so models chosen in the
 * wizard are probed even though most provider settings live in the global
 * file.
 */
export async function runWorkspaceHealthCheck(
  cwd: string,
  prompter: Prompter,
): Promise<void> {
  console.log(`\n${c.heading("Checking provider connectivity...")}\n`);
  const ragConfig = loadWorkspaceConfig(cwd);
  const results = await checkProviderHealth(ragConfig, configuredSections(cwd));

  for (const result of results) {
    const icon =
      result.status === "ok" ? c.success("✓") : result.status === "missing" ? c.warn("○") : c.error("✗");
    const typeLabel =
      result.type === "image_description"
        ? "image description"
        : result.type === "image_description_on_demand"
          ? "image description (on-demand)"
          : result.type;
    console.log(`  ${icon} ${c.value(result.model)} (${result.provider}) — ${typeLabel} model: ${result.status}`);
    if (result.error) console.log(`    ${c.dim(result.error)}`);
  }

  const missingOllama = results.filter(
    (result) => result.status === "missing" && result.provider === "ollama",
  );
  if (missingOllama.length > 0) {
    const pullEntries = missingOllama.map((result) => {
      if (result.type === "embedding") {
        return { model: result.model, baseUrl: ragConfig.embedding.baseUrl, proxy: ragConfig.embedding.proxy };
      }
      if (result.type === "description" && ragConfig.description) {
        return { model: result.model, baseUrl: ragConfig.description.baseUrl, proxy: ragConfig.description.proxy };
      }
      if (result.type === "image_description" && ragConfig.imageDescription) {
        return { model: result.model, baseUrl: ragConfig.imageDescription.baseUrl, proxy: ragConfig.imageDescription.proxy };
      }
      if (result.type === "image_description_on_demand" && ragConfig.imageDescription) {
        const onDemand = ragConfig.imageDescription.onDemand;
        return {
          model: result.model,
          baseUrl: onDemand?.baseUrl ?? ragConfig.imageDescription.baseUrl,
          proxy: onDemand?.proxy ?? ragConfig.imageDescription.proxy,
        };
      }
      return { model: result.model, baseUrl: ragConfig.embedding.baseUrl, proxy: ragConfig.embedding.proxy };
    });
    console.log(`\n  ${c.warn("Models not found:")} ${pullEntries.map((entry) => entry.model).join(", ")}`);

    const pull = prompter.interactive
      ? await prompter.confirm({
          message: `Pull ${pullEntries.length === 1 ? "this model" : "these models"} now?`,
          defaultValue: false,
        })
      : false;
    if (pull) {
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

  if (results.some((result) => result.status === "error")) {
    console.log(
      `\n  ${c.warn("Some providers are not reachable.")} Check configuration and network, then run ${c.file("'opencode-rag index'")}.`,
    );
  }
}
