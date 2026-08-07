/**
 * @fileoverview Helper functions for the init command — file generation, config building, dependency linking, and gitignore merging.
 */
/**
 * Helper functions for the `init` command — file generation, config building,
 * dependency installation, and gitignore merging.
 */

import path from "node:path";
import os from "node:os";
import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { DEFAULT_CONFIG } from "../../core/config.js";
import { c } from "../format.js";
import { BEGIN_MARKER, END_MARKER, buildAgentsMdDirective } from "../../opencode/system-guidance.js";
import {
  getStringRecord,
  readJsonObject,
  writeJsonFile,
} from "../helpers.js";
import type { PackageMetadata } from "../types.js";
import type { IndexingTuning } from "./backend-detect.js";

/**
 * Build the workspace-local `.opencode/package.json` content.
 *
 * Only declares `@opencode-ai/plugin` as a dependency — the RAG plugin
 * itself is extracted directly into `node_modules/` by `installPluginFromGlobal`.
 *
 * @param existing - The existing package.json content (if any).
 * @param packageMetadata - The CLI package's metadata for version resolution.
 * @returns The merged package.json object.
 */
export function buildWorkspacePackageJson(
  existing: Record<string, unknown> | undefined,
  packageMetadata: PackageMetadata,
): Record<string, unknown> {
  const existingDependencies = getStringRecord(existing?.dependencies);
  const pluginVersion =
    existingDependencies["@opencode-ai/plugin"] ??
    packageMetadata.devDependencies?.["@opencode-ai/plugin"] ??
    packageMetadata.peerDependencies?.["@opencode-ai/plugin"] ??
    ">=1.0.0";

  const deps: Record<string, string> = {};
  // Preserve any existing deps that are NOT the RAG plugin (it's extracted directly)
  for (const [name, version] of Object.entries(existingDependencies)) {
    if (name !== packageMetadata.name) {
      deps[name] = version;
    }
  }
  // Ensure @opencode-ai/plugin is always present
  deps["@opencode-ai/plugin"] = pluginVersion;

  return {
    ...existing,
    name: typeof existing?.name === "string" ? existing.name : ".opencode",
    private: true,
    type: "module",
    dependencies: deps,
  };
}

/**
 * Build the `.opencode/opencode.json` config object.
 *
 * Ensures the `$schema` key is present and removes any stale `plugin`
 * entries that would trigger erroneous npm installs.
 *
 * @param existing - The existing opencode.json content (if any).
 * @returns The normalized config object.
 */
export function buildOpencodeConfig(existing: Record<string, unknown> | undefined): Record<string, unknown> {
  const next = { ...(existing ?? {}) };
  if (typeof next.$schema !== "string") {
    next.$schema = "https://opencode.ai/config.json";
  }
  // Plugin is loaded via .opencode/plugins/rag-plugin.js auto-discovery,
  // not via npm package resolution. Stale "plugin" entries from older
  // init versions would trigger npm install (which fails due to native
  // dependencies like sharp) and produce "Plugin export is not a function".
  delete next.plugin;

  return next;
}

/**
 * Remove stale global OpenCode plugin registrations from config files.
 *
 * Scans `~/.config/opencode/opencode.jsonc` and `opencode.json` for
 * plugin entries matching `pluginName` and removes them.
 *
 * @param homeDir - The user's home directory (typically `os.homedir()`).
 * @param pluginName - The plugin package name to remove.
 * @returns Array of config file paths that were modified.
 */
export function removeStaleGlobalPluginRegistrations(homeDir: string, pluginName: string): string[] {
  const globalConfigDir = path.join(homeDir, ".config", "opencode");
  const updatedPaths: string[] = [];

  for (const cfgFile of ["opencode.jsonc", "opencode.json"]) {
    const configPath = path.join(globalConfigDir, cfgFile);
    if (!existsSync(configPath)) {
      continue;
    }

    try {
      const cfg = readJsonObject(configPath);
      if (!cfg || !Array.isArray(cfg.plugin)) {
        continue;
      }

      const nextPlugins = cfg.plugin.filter((entry): entry is string => typeof entry === "string" && entry !== pluginName);
      if (nextPlugins.length === cfg.plugin.length) {
        continue;
      }

      if (nextPlugins.length > 0) {
        cfg.plugin = nextPlugins;
      } else {
        delete cfg.plugin;
      }

      writeJsonFile(configPath, cfg);
      updatedPaths.push(configPath);
    } catch {
      // Ignore malformed OpenCode config files and leave them unchanged.
    }
  }

  return updatedPaths;
}

/**
 * Generate the content for `.opencode/plugins/rag-plugin.js`.
 *
 * This file re-exports the plugin from the workspace-local node_modules.
 *
 * @param packageName - The npm package name of the RAG plugin.
 * @returns The JavaScript source code for the plugin entry file.
 */
export function generateWorkspacePluginFile(packageName: string): string {
  return [
    `import plugin from "../node_modules/${packageName}/dist/plugin-entry.js";`,
    `export const id = plugin.id;`,
    `export const server = plugin.server;`,
    `export default plugin;`,
    "",
  ].join("\n");
}

/**
 * Generate the content for `.opencode/plugins/rag-tui.js`.
 *
 * This file re-exports the TUI plugin from the workspace-local node_modules.
 *
 * @param packageName - The npm package name of the RAG plugin.
 * @returns The JavaScript source code for the TUI plugin entry file.
 */
export function generateWorkspaceTuiPluginFile(packageName: string): string {
  return [
    `import plugin from "../node_modules/${packageName}/dist/tui.js";`,
    `export default plugin;`,
    "",
  ].join("\n");
}

/**
 * Generate the content for `.opencode/skills/opencode-rag/SKILL.md`.
 *
 * This file provides tool usage guidance for AI assistants working in the workspace.
 *
 * @returns The full Markdown content of the skill file.
 */
export function generateSkillFile(): string {
  return [
    "---",
    "name: opencode-rag",
    "description: Semantic code & image retrieval via OpenCodeRAG — vector search, file skeletons, symbol usage lookup, and image description lookup for this workspace",
    "---",
    "",
    "## OpenCodeRAG Tools",
    "",
    "This workspace has OpenCodeRAG indexed for semantic code and image search. Use these tools BEFORE planning, editing, or answering code questions.",
    "",
    "### Decision tree — ALWAYS follow this order",
    "",
    "1. User mentions code behavior/architecture → `search_semantic(query)`",
    "2. User mentions a file path → `get_file_skeleton(filePath)` THEN `read` on specific lines",
    "3. User mentions a function/class/variable to edit → `find_usages(symbolName)` THEN `search_semantic` THEN `edit`",
    "4. User asks a code question → `search_semantic` to gather context before answering",
    "5. User asks about an image or visual asset → `describe_image(filePath)` to retrieve its generated description, then optionally `search_semantic` for related code",
    "6. You encounter an error or need a known pitfall → `recall_quirks(query)`",
    "7. You discover a non-obvious fact or workaround → `add_quirk(content)` to persist it",
    "8. A recalled quirk is outdated or wrong → `update_quirk(id, ...)` to fix it, or `delete_quirk(id)` if it no longer applies",
    "",
    "### When to use each tool",
    "",
    "| Tool | Use when | Example |",
    "|------|----------|---------|",
    "| `search_semantic` | Any code search — find relevant code by meaning or keyword | `\"authentication middleware\"` |",
    "| `get_file_skeleton` | You have a file path but need to orient before reading | `\"src/plugin.ts\"` |",
    "| `find_usages` | Before editing any function, class, or variable — check all call sites | `\"createRagHooks\"` |",
    "| `describe_image` | When the user refers to an image or asks \"what's in this screenshot/diagram?\" | `\"assets/login-screen.png\"` |",
    "| `recall_quirks` | You hit an error or need to remember a gotcha, preference, or decision from past sessions | `\"lancedb type casting\"` |",
    "| `add_quirk` | You just discovered a non-obvious fact, workaround, or convention worth remembering | `'\"npm needs --legacy-peer-deps\" --type gotcha --tag installation'` |",
    "| `update_quirk` | A recalled quirk is outdated or wrong — fix its content, type, or tags | `id` from `recall_quirks` output + `content: \"...\"` |",
    "| `delete_quirk` | A quirk is fixed, obsolete, or no longer applies | `id` from `recall_quirks` output |",
    "",
    "### Workflow",
    "",
    "1. **Skeleton first** — call `get_file_skeleton(filePath)` to see structure",
    "2. **Find usages** — call `find_usages(symbolName)` before modifying any symbol",
    "3. **Search** — call `search_semantic(query)` to find relevant code",
    "4. **Describe images** — call `describe_image(filePath)` when context involves an image file",
    "5. **Read** — use the `read` tool on specific line ranges identified above",
    "6. **Edit** — now you have full context to make safe changes",
    "",
    "### Anti-patterns — NEVER do these",
    "",
    "- Reading full files without calling `get_file_skeleton` first (wastes tokens)",
    "- Editing a function without calling `find_usages` first (breaks call sites)",
    "- Answering code questions without calling `search_semantic` first (you guess at behavior)",
    "- Using `grep`/`glob` when `search_semantic` would find the answer faster",
    "- Treating image files as text — use `describe_image` instead of reading raw bytes",
    "",
    "### Parameters",
    "",
    "- `search_semantic`: `query` (req), `pathHints?`, `languageHints?`, `topK?`",
    "- `get_file_skeleton`: `filePath` (req)",
    "- `find_usages`: `symbolName` (req), `pathHint?`, `topK?`",
    "- `describe_image`: `filePath` (req)",
    "- `recall_quirks`: `query` (req), `topK?`, `quirkType?`, `tags?`",
    "- `add_quirk`: `content` (req), `quirkType?`, `tags?`, `sourceRef?`",
    "- `update_quirk`: `id` (req) + at least one of `content?`, `quirkType?`, `tags?`, `confidence?`, `sourceRef?`",
    "- `delete_quirk`: `id` (req)",
    "",
    "### Tips",
    "",
    "- Use `pathHints` to narrow searches to specific directories",
    "- Use `languageHints` to filter by file type",
    "- `find_usages` is essential before refactoring — it shows every reference",
    "- If no results appear, the workspace may not be indexed yet — run `opencode-rag index`",
    "- Image descriptions are generated at index time using the configured vision provider; ensure `imageDescription` is configured in `opencode-rag.json` if your project includes images",
    "",
  ].join("\n");
}

/**
 * Merge required entries into an existing `.gitignore` content string.
 *
 * Ensures `node_modules/`, `package-lock.json`, `rag_db/`, and `opencode-rag.log`
 * are present. If no existing content is provided, generates a complete file.
 *
 * @param existingContent - The current `.gitignore` content, or `undefined` if absent.
 * @returns The merged `.gitignore` content with a trailing newline.
 */
export function mergeGitignoreContent(existingContent?: string): string {
  const lines = existingContent ? existingContent.split(/\r?\n/) : [];
  const trimmed = new Set(lines.map((line) => line.trim()));
  const requiredEntries = ["node_modules/", "package-lock.json", "rag_db/", "opencode-rag.log"];
  const missing = requiredEntries.filter((entry) => !trimmed.has(entry));

  if (!existingContent) {
    return [
      "# Ignore workspace-local plugin dependencies",
      "node_modules/",
      "package-lock.json",
      "",
      "# Ignore the LanceDB vector store (binary data)",
      "rag_db/",
      "",
      "# Ignore logs",
      "opencode-rag.log",
      "",
    ].join("\n");
  }

  if (missing.length === 0) {
    return existingContent.endsWith("\n") ? existingContent : `${existingContent}\n`;
  }

  const merged = [...lines];
  const lastLine = merged.length > 0 ? (merged[merged.length - 1] ?? "") : "";
  if (lastLine.trim().length > 0) {
    merged.push("");
  }
  merged.push("# OpenCodeRAG workspace state", ...missing, "");
  return merged.join("\n");
}

/**
 * Merge the OpenCodeRAG directive section into an existing `AGENTS.md`.
 *
 * The directive is wrapped in sentinel markers so re-runs replace the
 * section in place rather than appending duplicates. Existing content
 * outside the markers is always preserved. If no existing content is
 * provided, the section alone is returned as a new file.
 *
 * @param existingContent - The current `AGENTS.md` content, or `undefined` if absent.
 * @param opts - Optional settings. `promptEnforcement` controls whether the
 *   quirk-capture enforcement rules are included (default `true`).
 * @returns The merged `AGENTS.md` content with a trailing newline.
 */
export function mergeAgentsMdContent(
  existingContent?: string,
  opts?: { promptEnforcement?: boolean },
): string {
  const section = buildAgentsMdDirective({ promptEnforcement: opts?.promptEnforcement ?? true });

  if (!existingContent) {
    return `${section}\n`;
  }

  const beginIdx = existingContent.indexOf(BEGIN_MARKER);
  const endIdx = existingContent.indexOf(END_MARKER);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existingContent.slice(0, beginIdx);
    const after = existingContent.slice(endIdx + END_MARKER.length);
    const merged = `${before}${section}${after}`;
    return merged.endsWith("\n") ? merged : `${merged}\n`;
  }

  const trimmed = existingContent.trimEnd();
  const separator = trimmed.endsWith(BEGIN_MARKER) ? "" : "\n\n";
  return `${trimmed}${separator}${section}\n`;
}

/**
 * Get the runtime directory path (`~/.opencode`).
 *
 * @returns The absolute path to the user's OpenCode runtime directory.
 */
export function getRuntimeDir(): string {
  return path.join(os.homedir(), ".opencode");
}

/**
 * Create a directory junction (Windows) or symlink (Linux/macOS) from
 * `linkPath` pointing to `targetPath`.
 *
 * @param targetPath - The existing directory to link to.
 * @param linkPath - The junction/symlink to create (must not exist).
 */
function createJunction(targetPath: string, linkPath: string): void {
  const type = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(targetPath, linkPath, type);
}

/**
 * Link the precompiled plugin from the global runtime directory
 * (`~/.opencode/node_modules/...`) into the workspace via a junction/symlink,
 * then verify that both the plugin entry and `@opencode-ai/plugin` are
 * resolvable through the junction.
 *
 * No npm install is required — the global runtime (created by the `compile`
 * step) has all dependencies pre-installed, and Node.js resolves module
 * imports through the junction's real path.
 *
 * @param opencodeDir - Absolute path to the workspace `.opencode/` directory.
 * @param packageName - The npm package name of the RAG plugin.
 * @param skipInstall - If true, skip the junction creation.
 * @throws If the global runtime is missing or the junction cannot be created.
 */
export async function installPluginFromGlobal(
  opencodeDir: string,
  packageName: string,
  skipInstall: boolean,
): Promise<void> {
  if (skipInstall) {
    console.log(`\n  ${c.exists("Skipped:")}   plugin installation (--skip-install)`);
    return;
  }

  const runtimeDir = getRuntimeDir();
  const globalPluginDir = path.join(runtimeDir, "node_modules", packageName);
  const workspaceTarget = path.join(opencodeDir, "node_modules", packageName);

  if (!existsSync(globalPluginDir)) {
    // Fallback: try the global npm prefix
    let globalRoot: string;
    try {
      globalRoot = execSync("npm root -g", { encoding: "utf-8", timeout: 10_000 }).trim();
    } catch {
      throw new Error(
        `Global plugin cache not found at ${globalPluginDir}. ` +
        "Run 'opencode-rag setup' or install globally with 'npm install -g opencode-rag-plugin' first.",
      );
    }
    const globalNpmPluginDir = path.join(globalRoot, packageName);
    if (existsSync(globalNpmPluginDir) && existsSync(path.join(globalNpmPluginDir, "dist", "cli.js"))) {
      console.log(`  ${c.created("Found:")} ${packageName} in global npm prefix, linking...`);
      if (existsSync(workspaceTarget)) {
        rmSync(workspaceTarget, { recursive: true, force: true });
      }
      mkdirSync(path.dirname(workspaceTarget), { recursive: true });
      createJunction(globalNpmPluginDir, workspaceTarget);
      const cliEntry = path.join(workspaceTarget, "dist", "cli.js");
      if (existsSync(cliEntry)) {
        console.log(`  ${c.success("Linked:")} ${packageName} from global npm`);
        // Also link @opencode-ai/plugin from global npm
        const globalSdkDir = path.join(globalRoot, "@opencode-ai", "plugin");
        const workspaceSdkDir = path.join(opencodeDir, "node_modules", "@opencode-ai", "plugin");
        if (existsSync(globalSdkDir) && !existsSync(workspaceSdkDir)) {
          mkdirSync(path.dirname(workspaceSdkDir), { recursive: true });
          try {
            createJunction(globalSdkDir, workspaceSdkDir);
          } catch {
            const { cpSync } = await import("node:fs") as typeof import("node:fs");
            cpSync(globalSdkDir, workspaceSdkDir, { recursive: true });
          }
        }
        console.log(`  ${c.success("Linked:")} @opencode-ai/plugin from global npm`);
        return;
      }
      // Junction failed or incomplete — fall through to error
      rmSync(workspaceTarget, { recursive: true, force: true });
    }
    throw new Error(
      `Global plugin cache not found at ${globalPluginDir}. ` +
      "Run 'opencode-rag setup' or install globally with 'npm install -g opencode-rag-plugin' first.",
    );
  }

  // Remove any stale copy (e.g. from a previous 'npm install' run)
  if (existsSync(workspaceTarget)) {
    rmSync(workspaceTarget, { recursive: true, force: true });
  }

  // Create directory junction from workspace → global runtime.
  // Junction creation can throw (EPERM, cross-drive on Windows) — fall back
  // to a copy instead of aborting `init`.
  console.log(`  ${c.created("Linking:")} ${packageName} from global cache...`);
  mkdirSync(path.dirname(workspaceTarget), { recursive: true });
  try {
    createJunction(globalPluginDir, workspaceTarget);
  } catch (err) {
    console.log(`  ${c.warn("Junction failed, falling back to copy...")}`);
    rmSync(workspaceTarget, { recursive: true, force: true });
    const { cpSync } = await import("node:fs");
    mkdirSync(path.dirname(workspaceTarget), { recursive: true });
    cpSync(globalPluginDir, workspaceTarget, { recursive: true });
    console.log(`  ${c.success("Copied:")} ${packageName} from global cache`);
    return;
  }

  const cliEntry = path.join(workspaceTarget, "dist", "cli.js");
  if (!existsSync(cliEntry)) {
    // Junction may not work (e.g. cross-drive on Windows) — fall back to copy
    console.log(`  ${c.warn("Junction not supported, falling back to copy...")}`);
    rmSync(workspaceTarget, { recursive: true, force: true });
    const { cpSync } = await import("node:fs");
    mkdirSync(path.dirname(workspaceTarget), { recursive: true });
    cpSync(globalPluginDir, workspaceTarget, { recursive: true });
  }

  const pluginSdkPkg = path.join(runtimeDir, "node_modules", "@opencode-ai", "plugin", "package.json");
  if (!existsSync(pluginSdkPkg)) {
    throw new Error(
      "@opencode-ai/plugin not found in global runtime. " +
        "Run 'install.sh compile' / 'install.ps1 compile' to install it.",
    );
  }
}



/**
 * Generate the default `opencode-rag.json` configuration content.
 *
 * @param tuning - Optional embedding batch tuning (auto-detected from the
 *   Ollama backend). Falls back to `DEFAULT_CONFIG` for any omitted field.
 * @returns A pretty-printed JSON string with all default configuration values.
 */
export function generateDefaultConfigJson(tuning?: Partial<IndexingTuning>): string {
  return JSON.stringify(
    {
      embedding: {
        provider: DEFAULT_CONFIG.embedding.provider,
        baseUrl: DEFAULT_CONFIG.embedding.baseUrl,
        model: DEFAULT_CONFIG.embedding.model,
        timeoutMs: DEFAULT_CONFIG.embedding.timeoutMs,
      },
      indexing: {
        includeExtensions: DEFAULT_CONFIG.indexing.includeExtensions,
        excludeDirs: DEFAULT_CONFIG.indexing.excludeDirs,
        chunkOverlap: DEFAULT_CONFIG.indexing.chunkOverlap,
        minFileSizeBytes: DEFAULT_CONFIG.indexing.minFileSizeBytes,
        concurrency: DEFAULT_CONFIG.indexing.concurrency,
        embedBatchSize: tuning?.embedBatchSize ?? DEFAULT_CONFIG.indexing.embedBatchSize,
        embedConcurrency: tuning?.embedConcurrency ?? DEFAULT_CONFIG.indexing.embedConcurrency ?? 3,
        ollamaMaxBatchSize: tuning?.ollamaMaxBatchSize ?? DEFAULT_CONFIG.indexing.ollamaMaxBatchSize ?? 100,
      },
      vectorStore: {
        path: DEFAULT_CONFIG.vectorStore.path,
      },
      retrieval: {
        topK: DEFAULT_CONFIG.retrieval.topK,
        minScore: DEFAULT_CONFIG.retrieval.minScore,
        hybridSearch: {
          enabled: DEFAULT_CONFIG.retrieval.hybridSearch!.enabled,
          keywordWeight: DEFAULT_CONFIG.retrieval.hybridSearch!.keywordWeight,
        },
      },
      openCode: {
        enabled: DEFAULT_CONFIG.openCode.enabled,
        maxContextChunks: DEFAULT_CONFIG.openCode.maxContextChunks,
        readOverride: DEFAULT_CONFIG.openCode.readOverride,
        autoIndex: {
          enabled: DEFAULT_CONFIG.openCode.autoIndex!.enabled,
          debounceMs: DEFAULT_CONFIG.openCode.autoIndex!.debounceMs,
          intervalMs: DEFAULT_CONFIG.openCode.autoIndex!.intervalMs,
          watcher: DEFAULT_CONFIG.openCode.autoIndex!.watcher,
        },
      },
      imageDescription: {
        enabled: DEFAULT_CONFIG.imageDescription!.enabled,
        provider: DEFAULT_CONFIG.imageDescription!.provider,
        model: DEFAULT_CONFIG.imageDescription!.model,
        baseUrl: DEFAULT_CONFIG.imageDescription!.baseUrl,
        timeoutMs: DEFAULT_CONFIG.imageDescription!.timeoutMs,
        think: DEFAULT_CONFIG.imageDescription!.think,
        numCtx: DEFAULT_CONFIG.imageDescription!.numCtx,
      },
      description: {
        enabled: DEFAULT_CONFIG.description!.enabled,
        provider: DEFAULT_CONFIG.description!.provider,
        baseUrl: DEFAULT_CONFIG.description!.baseUrl,
        model: DEFAULT_CONFIG.description!.model,
        think: DEFAULT_CONFIG.description!.think,
        numCtx: DEFAULT_CONFIG.description!.numCtx,
        timeoutMs: DEFAULT_CONFIG.description!.timeoutMs,
        maxContentChars: DEFAULT_CONFIG.description!.maxContentChars,
      },
      wikiMode: {
        enabled: DEFAULT_CONFIG.wikiMode!.enabled,
      },
      mcp: {
        enabled: DEFAULT_CONFIG.mcp!.enabled,
      },
      logging: {
        level: DEFAULT_CONFIG.logging.level,
        logFilePath: DEFAULT_CONFIG.logging.logFilePath,
      },
      chunking: {
        nodeTypes: {},
      },
    },
    null,
    2,
  ) + "\n";
}
