/**
 * @fileoverview Pure mapping from wizard answers to config patches.
 *
 * Split from the interactive flow so the mapping can be unit-tested without a
 * TTY and reused by the flag-driven (`--yes`) path.
 *
 * Layering: provider/model/baseUrl/apiKey/vectorDimension describe the
 * *machine* and go to the global config file; feature toggles and repo
 * concerns go to the workspace config. This mirrors
 * `isProviderScopedPath()` in `src/core/config.ts` (the TUI's rule).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import type { WizardAnswers } from "./types.js";

/** A two-layer config patch produced from {@link WizardAnswers}. */
export interface ConfigPatch {
  /** Machine-level keys written to `~/.config/opencode/opencode-rag.json`. */
  global: Record<string, unknown>;
  /** Repository-level keys written to `.opencode/opencode-rag.json`. */
  workspace: Record<string, unknown>;
}

/** Whether a value is a plain object (not `null`, not an array). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Deep-merge `patch` into `base`, returning a new object.
 *
 * Arrays and scalars replace the base value; plain objects merge recursively.
 * `undefined` values are ignored so callers can omit optional keys.
 */
export function mergeConfigObjects(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = next[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      next[key] = mergeConfigObjects(existing, value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

/** Drop `undefined` entries from a record (one level deep). */
function defined<T extends Record<string, unknown>>(value: T): T {
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) next[key] = entry;
  }
  return next as T;
}

/**
 * Build the global and workspace patches for a set of answers.
 *
 * The returned objects are sparse: a section that the user did not touch is
 * absent, so merging them never overwrites unrelated settings.
 */
export function buildConfigPatch(answers: WizardAnswers): ConfigPatch {
  const global: Record<string, unknown> = {
    embedding: defined({
      provider: answers.embedding.provider,
      baseUrl: answers.embedding.baseUrl,
      model: answers.embedding.model,
      apiKey: answers.embedding.apiKey,
      vectorDimension: answers.embedding.vectorDimension,
    }),
  };

  if (answers.description) {
    global.description = defined({
      provider: answers.description.provider,
      baseUrl: answers.description.baseUrl,
      model: answers.description.model,
      apiKey: answers.description.apiKey,
    });
  }

  if (answers.imageDescription) {
    global.imageDescription = defined({
      provider: answers.imageDescription.provider,
      baseUrl: answers.imageDescription.baseUrl,
      model: answers.imageDescription.model,
      apiKey: answers.imageDescription.apiKey,
    });
  }

  if (answers.decision?.enabled) {
    global.decision = defined({
      provider: "ollama",
      baseUrl: answers.decision.baseUrl,
      model: answers.decision.model,
    });
  }

  if (answers.reranking?.enabled) {
    global.reranking = defined({
      provider: "llama-server",
      baseUrl: answers.reranking.baseUrl,
      model: answers.reranking.model,
    });
  }

  const workspace: Record<string, unknown> = {};
  if (answers.description !== undefined || answers.descriptionEnabled !== undefined) {
    workspace.description = { enabled: answers.descriptionEnabled ?? Boolean(answers.description) };
  }
  if (answers.imageDescription !== undefined || answers.imageDescriptionEnabled !== undefined) {
    workspace.imageDescription = { enabled: answers.imageDescriptionEnabled ?? Boolean(answers.imageDescription) };
  }
  if (answers.decision !== undefined) {
    workspace.decision = defined({
      enabled: answers.decision.enabled,
      routeBeforeAsking: answers.decision.routeBeforeAsking,
    });
  }
  if (answers.reranking !== undefined) {
    workspace.reranking = { enabled: answers.reranking.enabled };
  }

  if (answers.shellGuard) {
    workspace.shellGuard = { enabled: answers.shellGuard.enabled };
  }
  if (answers.memory) {
    workspace.memory = defined({
      passiveCapture: answers.memory.passiveCapture,
      promptEnforcement: answers.memory.promptEnforcement,
      sessionEndExtraction: answers.memory.sessionEndExtraction,
    });
  }
  if (answers.vectorStore) {
    workspace.vectorStore = defined({
      provider: answers.vectorStore.provider,
      clickhouse: answers.vectorStore.clickhouse
        ? defined({
            url: answers.vectorStore.clickhouse.url,
            database: answers.vectorStore.clickhouse.database,
            username: answers.vectorStore.clickhouse.username,
            passwordEnv: answers.vectorStore.clickhouse.passwordEnv,
            namespace: answers.vectorStore.clickhouse.namespace,
          })
        : undefined,
    });
  }
  if (answers.indexing) {
    workspace.indexing = defined({ embedDescriptions: answers.indexing.embedDescriptions });
  }
  if (answers.openCode) {
    workspace.openCode = defined({
      autoIndex: answers.openCode.autoIndex === undefined ? undefined : { enabled: answers.openCode.autoIndex },
    });
  }

  return { global, workspace };
}

/** Read a JSON object from disk, returning `{}` when the file is absent or invalid. */
export function readJsonObjectSafe(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const value = JSON.parse(parsed) as unknown;
    return isPlainObject(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * Merge a patch into a config file, creating the file when needed.
 *
 * A `.bak` copy is written when the file already exists, so a failed setup
 * cannot leave the user without their previous configuration.
 *
 * @returns `true` when the file was written, `false` when the write failed.
 */
export function writeConfigPatch(filePath: string, patch: Record<string, unknown>): boolean {
  if (Object.keys(patch).length === 0) return false;
  const existed = existsSync(filePath);
  const base = readJsonObjectSafe(filePath);
  const merged = mergeConfigObjects(base, patch);
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const changed = JSON.stringify(merged) !== JSON.stringify(base);
    if (changed) {
      if (existed) {
        try {
          copyFileSync(filePath, `${filePath}.bak`);
        } catch {
          // A missing backup must not block the write.
        }
      }
      writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect provider keys that a workspace config inherited from the old
 * `init` template and that now shadow the machine-global layer.
 *
 * The global file is a base layer, so a stale `embedding.provider`/`baseUrl`/
 * `model` in `.opencode/opencode-rag.json` silently overrides the model the
 * wizard wrote to the global file. Returns the dotted paths that should be
 * removed.
 */
export function findShadowingProviderKeys(workspaceConfig: Record<string, unknown>): string[][] {
  const sections = ["embedding", "description", "imageDescription", "decision", "reranking"];
  const leaves = ["provider", "model", "baseUrl", "apiKey", "vectorDimension"];
  const found: string[][] = [];
  for (const section of sections) {
    const value = workspaceConfig[section];
    if (!isPlainObject(value)) continue;
    for (const leaf of leaves) {
      if (value[leaf] !== undefined) found.push([section, leaf]);
    }
  }
  return found;
}

/** Remove the given dotted paths from a config object, in place. */
export function removeConfigPaths(config: Record<string, unknown>, paths: readonly string[][]): void {
  for (const dotted of paths) {
    let cursor: Record<string, unknown> | undefined = config;
    for (let i = 0; i < dotted.length - 1; i += 1) {
      const segment = dotted[i];
      if (!segment) break;
      const next: unknown = cursor[segment];
      cursor = isPlainObject(next) ? next : undefined;
      if (!cursor) break;
    }
    const leaf = dotted[dotted.length - 1];
    if (cursor && leaf) delete cursor[leaf];
  }
}
