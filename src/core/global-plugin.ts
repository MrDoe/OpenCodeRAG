/**
 * @fileoverview Global OpenCode plugin installation.
 *
 * OpenCode 2 loads plugins from `~/.config/opencode/plugins/` as well as from
 * a workspace's `.opencode/plugins/`. Installing the RAG plugin once in the
 * global directory removes the per-repository plugin entries, the
 * `.opencode/node_modules` junction and the workspace `package.json`:
 *
 * ```
 * ~/.config/opencode/plugins/opencode-rag/index.js   (server role)
 * ~/.config/opencode/plugins/opencode-rag/tui.js     (TUI role)
 * ```
 *
 * Both files re-export the plugin from the global runtime
 * (`~/.opencode/node_modules/opencode-rag-plugin/dist/…`) via a relative
 * path, so the install keeps working when the home directory moves. The
 * vector store is NOT affected: `vectorStore.path` is resolved against the
 * workspace, so every repository keeps its own local LanceDB.
 */

import path from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { globalConfigPath } from "./config.js";
import { getRuntimeDir } from "./setup-runtime.js";

/** npm package name of the plugin. */
const PLUGIN_NAME = "opencode-rag-plugin";

/** Directory name used inside OpenCode's plugin directory. */
const GLOBAL_PLUGIN_ID = "opencode-rag";

/** OpenCode's global plugin directory (`<config>/plugins`). */
export function getGlobalPluginsRoot(): string {
  return path.join(path.dirname(globalConfigPath()), "plugins");
}

/** Our directory inside OpenCode's global plugin directory. */
export function getGlobalPluginDir(): string {
  return path.join(getGlobalPluginsRoot(), GLOBAL_PLUGIN_ID);
}

/** Dist directory of the plugin inside the runtime cache. */
export function getRuntimePluginDist(): string {
  return path.join(getRuntimeDir(), "node_modules", PLUGIN_NAME, "dist");
}

/** Result of {@link installGlobalPlugin}. */
export interface GlobalPluginResult {
  /** Directory that holds the entrypoints. */
  dir: string;
  /** Files written during this call (empty when already up to date). */
  written: string[];
}

/** Render an import specifier relative to the global plugin directory. */
function relativeImport(fromDir: string, target: string): string {
  const relative = path.relative(fromDir, target).split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/** Entry file content for one role. */
function entryContent(fromDir: string, distFile: string): string {
  return [
    `import plugin from "${relativeImport(fromDir, path.join(getRuntimePluginDist(), distFile))}";`,
    `export default plugin;`,
    "",
  ].join("\n");
}

/** Write a file only when its content changed (or `force`). */
function writeIfChanged(filePath: string, content: string, force: boolean): boolean {
  if (!force && existsSync(filePath)) {
    try {
      if (readFileSync(filePath, "utf-8") === content) return false;
    } catch {
      // Fall through to the write.
    }
  }
  writeFileSync(filePath, content, "utf-8");
  return true;
}

/**
 * Install (or refresh) the global plugin entrypoints.
 *
 * @throws When the runtime plugin dist is missing (run the runtime step first).
 */
export function installGlobalPlugin(options: { force?: boolean } = {}): GlobalPluginResult {
  const dist = getRuntimePluginDist();
  const serverEntry = path.join(dist, "plugin-entry.js");
  const tuiEntry = path.join(dist, "tui.js");
  if (!existsSync(serverEntry) || !existsSync(tuiEntry)) {
    throw new Error(`Plugin runtime not found at ${dist}. Run 'opencode-rag setup' first.`);
  }

  const dir = getGlobalPluginDir();
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const files: readonly [string, string][] = [
    ["index.js", entryContent(dir, "plugin-entry.js")],
    ["tui.js", entryContent(dir, "tui.js")],
  ];
  for (const [name, content] of files) {
    const target = path.join(dir, name);
    if (writeIfChanged(target, content, options.force ?? false)) written.push(target);
  }
  return { dir, written };
}

/** Whether both global entrypoints exist. */
export function isGlobalPluginInstalled(): boolean {
  const dir = getGlobalPluginDir();
  return existsSync(path.join(dir, "index.js")) && existsSync(path.join(dir, "tui.js"));
}

/** Remove the global plugin entrypoints. Returns `true` when something was removed. */
export function removeGlobalPlugin(): boolean {
  const dir = getGlobalPluginDir();
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Workspace-local plugin directory (legacy/per-repo mode). */
export function getWorkspacePluginDir(workspaceDir: string): string {
  return path.join(workspaceDir, ".opencode", "plugins", GLOBAL_PLUGIN_ID);
}

/** Whether a workspace still uses the per-repository plugin entries. */
export function isWorkspacePluginInstalled(workspaceDir: string): boolean {
  return existsSync(path.join(getWorkspacePluginDir(workspaceDir), "index.js"));
}
