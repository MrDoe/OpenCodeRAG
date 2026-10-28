/**
 * @fileoverview Create-only workspace scaffolding for the OpenCode plugin.
 *
 * With the plugin installed globally, a repository does not need a CLI run
 * before it works: on first load the plugin creates the missing workspace
 * files itself (config, skills, `AGENTS.md`, `.gitignore`). Existing files are
 * never overwritten, and `setup.autoScaffold: false` disables the behaviour.
 */

import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { findConfigFile, loadWorkspaceConfig, projectConfigPath } from "./config.js";
import { appendDebugLog } from "./fileLogger.js";
import {
  generateDecisionSkillFile,
  generateDefaultConfigJson,
  generateSkillFile,
  mergeAgentsMdContent,
  mergeGitignoreContent,
} from "../cli/commands/workspace-helpers.js";

/** Result of {@link autoScaffoldWorkspace}. */
export interface AutoScaffoldResult {
  /** Workspace-relative paths created during this call. */
  created: string[];
}

/** Write a file when it does not exist yet. */
function createIfMissing(filePath: string, content: string, created: string[], relativeTo: string): void {
  if (existsSync(filePath)) return;
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf-8");
  created.push(path.relative(relativeTo, filePath).replace(/\\/g, "/"));
}

/**
 * Create the missing workspace files for `directory`.
 *
 * Only runs when no workspace config exists yet *or* the effective config
 * still has `setup.autoScaffold` enabled. The function never overwrites an
 * existing file and never throws (plugin load must not break).
 */
export function autoScaffoldWorkspace(directory: string): AutoScaffoldResult {
  const created: string[] = [];
  try {
    const existingConfig = findConfigFile(directory);
    if (existingConfig) {
      try {
        const cfg = loadWorkspaceConfig(directory, false);
        if (cfg.setup?.autoScaffold === false) return { created };
      } catch {
        // Malformed config: still fill in the missing files.
      }
    }

    const opencodeDir = path.join(directory, ".opencode");
    const configPath = projectConfigPath(directory);
    mkdirSync(opencodeDir, { recursive: true });

    if (!existingConfig) {
      createIfMissing(configPath, generateDefaultConfigJson(), created, directory);
    }

    createIfMissing(
      path.join(opencodeDir, ".gitignore"),
      mergeGitignoreContent(undefined),
      created,
      directory,
    );
    createIfMissing(
      path.join(opencodeDir, "skills", "opencode-rag", "SKILL.md"),
      generateSkillFile(),
      created,
      directory,
    );
    createIfMissing(
      path.join(opencodeDir, "skills", "make-decision", "SKILL.md"),
      generateDecisionSkillFile(),
      created,
      directory,
    );

    const agentsPath = path.join(directory, "AGENTS.md");
    if (!existsSync(agentsPath)) {
      let promptEnforcement = true;
      let decisionEnabled = false;
      let routeBeforeAsking = false;
      try {
        const cfg = loadWorkspaceConfig(directory, false);
        promptEnforcement = cfg.memory?.promptEnforcement ?? true;
        decisionEnabled = cfg.decision?.enabled ?? false;
        routeBeforeAsking = cfg.decision?.routeBeforeAsking ?? false;
      } catch {
        // Defaults.
      }
      createIfMissing(
        agentsPath,
        mergeAgentsMdContent(undefined, { promptEnforcement, decisionEnabled, routeBeforeAsking }),
        created,
        directory,
      );
    }

    if (created.length > 0) {
      appendDebugLog(
        path.join(opencodeDir, "opencode-rag.log"),
        {
          scope: "setup",
          message: `auto-scaffolded workspace files: ${created.join(", ")}`,
        },
        "info",
      );
    }
  } catch {
    // Never break plugin load because a workspace could not be scaffolded.
  }
  return { created };
}
