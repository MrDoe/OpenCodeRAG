/**
 * @fileoverview Layered configuration API for the Web UI.
 *
 * Exposes the project layer (`.opencode/opencode-rag.json`), the machine-global
 * layer (`~/.config/opencode/opencode-rag.json`), the runtime overrides file,
 * and the effective merged config — plus a validated, atomic write path.
 *
 * Design rules:
 * - Reads always come from disk; the cached in-memory config is only a mirror.
 * - Secrets never leave the server: layer payloads omit them and report
 *   `secretSet` booleans instead.
 * - A patch is validated in full before the first byte is written and is
 *   applied as one atomic file replacement.
 * - Writing a path clears the matching runtime override, which would otherwise
 *   silently shadow the new value.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_CONFIG,
  findConfigFile,
  globalConfigPath as defaultGlobalConfigPath,
  loadConfigLayers,
  projectConfigPath as defaultProjectConfigPath,
  type RagConfig,
} from "../core/config.js";
import {
  applyRuntimeOverrides,
  deleteRuntimeOverride,
  loadRuntimeOverrides,
} from "../core/runtime-overrides.js";
import {
  SETTINGS_SECTIONS,
  cloneConfigValue,
  collectConfigLeafPaths,
  dottedPath,
  findSettingField,
  isPlainConfigObject,
  isSafeConfigPath,
  isSecretConfigPath,
  redactConfigSecrets,
  type SettingField,
} from "./config-schema.js";

/** HTTP-shape response used by the API router. */
export interface ConfigApiResponse {
  status: number;
  body: unknown;
}

/** Dependencies for the layered config handlers. */
export interface ConfigApiContext {
  /** Workspace directory whose effective config is served. */
  workspaceDir: string;
  /** Canonical project config path (write target). */
  projectConfigPath: string;
  /** Machine-global config path. */
  globalConfigPath: string;
  /** Store directory that holds `runtime-overrides.json`. */
  storePath: string;
  /** Mutable in-memory config used by other API routes. */
  configRef: { current?: RagConfig };
  /** Called after a successful write so the server can reset caches. */
  onConfigChanged?: (cfg: RagConfig, changedPaths: string[][]) => void;
}

/** One raw config layer as read from disk. */
interface RawLayer {
  path: string;
  exists: boolean;
  mtimeMs: number;
  values: Record<string, unknown>;
  secretSet: Record<string, boolean>;
  error?: string;
}

/** A single validated patch operation. */
interface ConfigOperation {
  op: "set" | "unset";
  path: string[];
  value?: unknown;
}

/** Provenance of a setting's effective value. */
type Provenance = "runtime" | "project" | "global" | "default";

/**
 * Resolve the workspace config file to read and write.
 *
 * An explicit `--config` path (anything that is not the default canonical
 * location) stays authoritative. Otherwise prefer the canonical
 * `.opencode/opencode-rag.json`, then fall back to a legacy root file so an
 * edit keeps that file authoritative instead of creating a second config.
 */
export function resolveProjectReadPath(workspaceDir: string, canonical: string): string {
  if (canonical !== defaultProjectConfigPath(workspaceDir)) return canonical;
  if (existsSync(canonical)) return canonical;
  return findConfigFile(workspaceDir) ?? canonical;
}

/** Read the mtime of a file, or 0 when it does not exist. */
function fileMtime(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/** Read a JSON object from disk without throwing on a missing file. */
function readJsonObject(filePath: string): Record<string, unknown> {
  const raw = readFileSync(filePath, "utf-8");
  const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const parsed = JSON.parse(stripped) as unknown;
  if (!isPlainConfigObject(parsed)) {
    throw new Error("expected a JSON object at the top level");
  }
  return parsed;
}

/** Read one layer, turning parse errors into an `error` field instead of throwing. */
function readLayer(filePath: string): RawLayer {
  if (!existsSync(filePath)) {
    return {
      path: filePath,
      exists: false,
      mtimeMs: 0,
      values: {},
      secretSet: {},
    };
  }
  try {
    const values = readJsonObject(filePath);
    const sanitized = sanitizeLayer(values);
    return {
      path: filePath,
      exists: true,
      mtimeMs: fileMtime(filePath),
      values: sanitized.values,
      secretSet: sanitized.secretSet,
    };
  } catch (err) {
    return {
      path: filePath,
      exists: true,
      mtimeMs: fileMtime(filePath),
      values: {},
      secretSet: {},
      error: (err as Error).message,
    };
  }
}

/** Remove secret values from a raw layer and record which paths are populated. */
function sanitizeLayer(raw: Record<string, unknown>): {
  values: Record<string, unknown>;
  secretSet: Record<string, boolean>;
} {
  const values = cloneConfigValue(raw);
  const secretSet: Record<string, boolean> = {};
  for (const section of SETTINGS_SECTIONS) {
    for (const entry of section.fields) {
      if (!entry.secret) continue;
      const current = getPath(values, entry.path);
      if (typeof current === "string" && current.trim().length > 0) {
        secretSet[dottedPath(entry.path)] = true;
      }
      if (current !== undefined) deletePath(values, entry.path);
    }
  }
  // Unknown credential-named leaves are removed entirely (no sentinel).
  redactConfigSecrets(values);
  return { values, secretSet };
}

/** Read a nested value by path. */
function getPath(root: Record<string, unknown>, path: readonly string[]): unknown {
  let cursor: unknown = root;
  for (const segment of path) {
    if (!isPlainConfigObject(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/** True when a path exists as an own property chain. */
function hasPath(root: Record<string, unknown>, path: readonly string[]): boolean {
  let cursor: unknown = root;
  for (const segment of path) {
    if (!isPlainConfigObject(cursor) || !Object.hasOwn(cursor, segment)) return false;
    cursor = cursor[segment];
  }
  return true;
}

/** Set a nested value, creating intermediate objects. */
function setPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let cursor = root;
  for (const segment of path.slice(0, -1)) {
    const next = cursor[segment];
    if (!isPlainConfigObject(next)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  const leaf = path[path.length - 1];
  if (leaf !== undefined) cursor[leaf] = value;
}

/** Delete a nested value, pruning containers that become empty. */
function deletePath(root: Record<string, unknown>, path: readonly string[]): void {
  const chain: Record<string, unknown>[] = [];
  let cursor: Record<string, unknown> = root;
  for (const segment of path.slice(0, -1)) {
    const next = cursor[segment];
    if (!isPlainConfigObject(next)) return;
    chain.push(cursor);
    cursor = next;
  }
  const leaf = path[path.length - 1];
  if (leaf === undefined || !Object.hasOwn(cursor, leaf)) return;
  delete cursor[leaf];
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const parent = chain[i];
    const childKey = path[i];
    if (!parent || childKey === undefined) break;
    const child = parent[childKey];
    if (isPlainConfigObject(child) && Object.keys(child).length === 0) {
      delete parent[childKey];
    } else {
      break;
    }
  }
}

/** Write a layer atomically (temp file + rename) with a one-generation backup. */
function writeLayerFile(filePath: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  if (existsSync(filePath)) {
    try {
      writeFileSync(`${filePath}.bak`, readFileSync(filePath));
    } catch {
      // A missing backup must not block the write.
    }
  }
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  renameSync(tmpPath, filePath);
}

/** Build the effective config from the two file layers plus runtime overrides. */
function buildEffective(
  globalPath: string,
  projectPath: string,
  overrides: Record<string, unknown>,
): RagConfig {
  // Skip a malformed layer instead of throwing away the healthy one — the
  // layer is already reported through `warnings`.
  const layers: string[] = [];
  for (const filePath of [globalPath, projectPath]) {
    if (!existsSync(filePath)) continue;
    try {
      readJsonObject(filePath);
      layers.push(filePath);
    } catch {
      // reported as invalid-json in layerWarnings()
    }
  }
  let cfg: RagConfig;
  try {
    cfg = layers.length === 0 ? structuredClone(DEFAULT_CONFIG) : loadConfigLayers(layers);
  } catch {
    cfg = structuredClone(DEFAULT_CONFIG);
  }
  return applyRuntimeOverrides(cfg, overrides as Parameters<typeof applyRuntimeOverrides>[1]);
}

/** Fields whose scope is machine-global, as dotted paths. */
const GLOBAL_SCOPE_PATHS: string[][] = SETTINGS_SECTIONS.flatMap((section) =>
  section.fields.filter((entry) => entry.scope === "global").map((entry) => entry.path),
);

/** Known top-level config sections (from the schema). */
const KNOWN_SECTIONS = new Set(SETTINGS_SECTIONS.map((section) => section.id));

/** Project keys that shadow the machine-global layer (secrets included). */
function findShadowedProviderPaths(project: RawLayer): string[][] {
  return GLOBAL_SCOPE_PATHS.filter(
    (path) => hasPath(project.values, path) || project.secretSet[dottedPath(path)] === true,
  );
}

/** Warnings that both GET and PATCH surface. */
function layerWarnings(
  project: RawLayer,
  global: RawLayer,
): Array<{ code: string; message: string; paths?: string[] }> {
  const warnings: Array<{ code: string; message: string; paths?: string[] }> = [];
  if (global.error) {
    warnings.push({
      code: "invalid-json",
      message: `The global config is not valid JSON: ${global.error}`,
      paths: [global.path],
    });
  }
  if (project.error) {
    warnings.push({
      code: "invalid-json",
      message: `The project config is not valid JSON: ${project.error}`,
      paths: [project.path],
    });
  }
  const shadowed = findShadowedProviderPaths(project);
  if (shadowed.length > 0) {
    warnings.push({
      code: "provider-shadowed",
      message: `${shadowed.length} machine-global provider setting(s) are duplicated in the project file and override the global layer.`,
      paths: shadowed.map(dottedPath),
    });
  }
  for (const [layerName, layer] of [["project", project], ["global", global]] as const) {
    const unknown = Object.keys(layer.values).filter((key) => !KNOWN_SECTIONS.has(key));
    if (unknown.length > 0) {
      warnings.push({
        code: "unknown-sections",
        message: `${layerName} config contains unknown section(s): ${unknown.join(", ")}`,
        paths: unknown,
      });
    }
  }
  return warnings;
}

/** Provenance map for every schema field. */
function buildProvenance(
  project: RawLayer,
  global: RawLayer,
  overrides: Record<string, unknown>,
): Record<string, Provenance> {
  const provenance: Record<string, Provenance> = {};
  for (const section of SETTINGS_SECTIONS) {
    for (const entry of section.fields) {
      const key = dottedPath(entry.path);
      if (hasPath(overrides, entry.path)) provenance[key] = "runtime";
      else if (hasPath(project.values, entry.path)) provenance[key] = "project";
      else if (hasPath(global.values, entry.path)) provenance[key] = "global";
      else provenance[key] = "default";
    }
  }
  return provenance;
}

/** Load a full snapshot of schema, layers, effective config, and metadata. */
export function readConfigSnapshot(ctx: ConfigApiContext): Record<string, unknown> {
  const projectReadPath = resolveProjectReadPath(ctx.workspaceDir, ctx.projectConfigPath);
  const project = readLayer(projectReadPath);
  const global = readLayer(ctx.globalConfigPath);

  const overrides = loadRuntimeOverrides(ctx.storePath) as unknown as Record<string, unknown>;
  const effective = buildEffective(global.path, project.path, overrides);
  const redactedEffective = cloneConfigValue(effective) as unknown as Record<string, unknown>;
  redactConfigSecrets(redactedEffective);

  const warnings = layerWarnings(project, global);

  return {
    config: redactedEffective,
    schema: { version: 1, sections: SETTINGS_SECTIONS },
    layers: {
      global: {
        path: global.path,
        exists: global.exists,
        mtimeMs: global.mtimeMs,
        values: global.values,
        secretSet: global.secretSet,
        ...(global.error ? { error: global.error } : {}),
      },
      project: {
        path: project.path,
        writePath: ctx.projectConfigPath,
        exists: project.exists,
        mtimeMs: project.mtimeMs,
        values: project.values,
        secretSet: project.secretSet,
        ...(project.error ? { error: project.error } : {}),
      },
    },
    runtimeOverrides: {
      path: `${ctx.storePath}/runtime-overrides.json`,
      values: overrides,
    },
    provenance: buildProvenance(project, global, overrides),
    warnings,
  };
}

/** GET /api/config — schema + layers + effective config. */
export function handleConfigLayers(ctx: ConfigApiContext): ConfigApiResponse {
  return { status: 200, body: readConfigSnapshot(ctx) };
}

/** Validate a field value; returns an error message or undefined. */
function validateFieldValue(field: SettingField, value: unknown): string | undefined {
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean" ? undefined : "Must be true or false";
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "Must be a number";
      if (field.minimum !== undefined && value < field.minimum) {
        return `Must be at least ${field.minimum}`;
      }
      if (field.maximum !== undefined && value > field.maximum) {
        return `Must be at most ${field.maximum}`;
      }
      return undefined;
    }
    case "string":
      if (typeof value !== "string") return "Must be text";
      if (value.length > 100_000) return "Text is too long";
      return undefined;
    case "enum":
      if (typeof value !== "string") return "Must be text";
      if (field.enumValues && !field.enumValues.includes(value)) {
        return `Must be one of: ${field.enumValues.join(", ")}`;
      }
      return undefined;
    case "string[]":
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        return "Must be a list of strings";
      }
      return undefined;
    case "stringMap":
      if (!isPlainConfigObject(value)) return "Must be an object mapping names to strings";
      if (Object.values(value).some((entry) => typeof entry !== "string")) {
        return "Every value must be a string";
      }
      return undefined;
    case "stringArrayMap":
      if (!isPlainConfigObject(value)) return "Must be an object mapping names to lists";
      if (
        Object.values(value).some(
          (entry) => !Array.isArray(entry) || entry.some((item) => typeof item !== "string"),
        )
      ) {
        return "Every value must be a list of strings";
      }
      return undefined;
    case "json":
      return undefined;
  }
}

/** Parse and fully validate the PATCH body before any write. */
function parsePatchBody(
  body: unknown,
): { ok: true; layer: "project" | "global" | "runtime"; operations: ConfigOperation[]; baseMtime?: number }
  | { ok: false; response: ConfigApiResponse } {
  if (!isPlainConfigObject(body)) {
    return { ok: false, response: { status: 400, body: { error: "Invalid config patch" } } };
  }
  const layer = body.layer;
  if (layer !== "project" && layer !== "global" && layer !== "runtime") {
    return {
      ok: false,
      response: { status: 400, body: { error: "layer must be 'project', 'global', or 'runtime'" } },
    };
  }
  const rawOperations = body.operations;
  if (!Array.isArray(rawOperations) || rawOperations.length === 0) {
    return {
      ok: false,
      response: { status: 400, body: { error: "operations must be a non-empty array" } },
    };
  }
  if (rawOperations.length > 200) {
    return {
      ok: false,
      response: { status: 400, body: { error: "At most 200 operations per request" } },
    };
  }

  const fieldErrors: Record<string, string> = {};
  const operations: ConfigOperation[] = [];
  for (const raw of rawOperations) {
    if (!isPlainConfigObject(raw)) {
      return { ok: false, response: { status: 400, body: { error: "Invalid operation" } } };
    }
    const op = raw.op;
    const path = raw.path;
    if (op !== "set" && op !== "unset") {
      return { ok: false, response: { status: 400, body: { error: "op must be 'set' or 'unset'" } } };
    }
    if (!Array.isArray(path) || !path.every((segment) => typeof segment === "string") || !isSafeConfigPath(path)) {
      return { ok: false, response: { status: 400, body: { error: "Invalid path" } } };
    }
    const key = dottedPath(path as string[]);
    if (layer === "runtime") {
      if (op !== "unset") {
        return {
          ok: false,
          response: { status: 400, body: { error: "The runtime layer only supports 'unset'" } },
        };
      }
      operations.push({ op, path: path as string[], ...(raw.value !== undefined ? { value: raw.value } : {}) });
      continue;
    }

    const field = findSettingField(path as string[]);
    if (!field) {
      fieldErrors[key] = "Unknown setting";
      continue;
    }
    if (field.scope === "global" && layer === "project") {
      fieldErrors[key] = "This setting can only be written to the machine-global config";
      continue;
    }
    if (op === "unset") {
      operations.push({ op, path: path as string[] });
      continue;
    }
    if (!("value" in raw)) {
      fieldErrors[key] = "Missing value";
      continue;
    }
    if (field.secret && raw.value === "***") {
      // The UI echoes the redaction sentinel when the secret is unchanged.
      continue;
    }
    const error = validateFieldValue(field, raw.value);
    if (error) {
      fieldErrors[key] = error;
      continue;
    }
    operations.push({ op, path: path as string[], value: raw.value });
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      ok: false,
      response: {
        status: 400,
        body: { error: "Some settings are invalid", code: "invalid-fields", fieldErrors },
      },
    };
  }

  const base = body.base;
  let baseMtime: number | undefined;
  if (isPlainConfigObject(base)) {
    const layerBase = base[layer];
    if (isPlainConfigObject(layerBase) && typeof layerBase.mtimeMs === "number") {
      baseMtime = layerBase.mtimeMs;
    }
  }

  return { ok: true, layer, operations, ...(baseMtime !== undefined ? { baseMtime } : {}) };
}

/** Apply validated operations, then return a fresh snapshot. */
function applyPatch(
  ctx: ConfigApiContext,
  layer: "project" | "global",
  operations: ConfigOperation[],
  baseMtime: number | undefined,
): ConfigApiResponse {
  const targetPath = layer === "project" ? ctx.projectConfigPath : ctx.globalConfigPath;
  const readPath = layer === "project" ? resolveProjectReadPath(ctx.workspaceDir, ctx.projectConfigPath) : targetPath;

  if (baseMtime !== undefined) {
    const current = fileMtime(readPath);
    if (current !== baseMtime && !(current === 0 && baseMtime === 0)) {
      return {
        status: 409,
        body: {
          error: "The config file changed on disk since it was loaded. Reload and try again.",
          code: "stale-layer",
          layer,
          currentMtimeMs: current,
        },
      };
    }
  }

  let raw: Record<string, unknown>;
  try {
    raw = existsSync(readPath) ? readJsonObject(readPath) : {};
  } catch (err) {
    return {
      status: 422,
      body: {
        error: `Cannot edit ${readPath}: ${(err as Error).message}`,
        code: "invalid-json",
        layer,
      },
    };
  }

  for (const operation of operations) {
    if (operation.op === "unset") {
      deletePath(raw, operation.path);
    } else {
      setPath(raw, operation.path, operation.value);
    }
  }

  try {
    // Editing a legacy/root file keeps that file authoritative — write it
    // rather than creating a second config in `.opencode/` that would win.
    writeLayerFile(readPath, raw);
  } catch (err) {
    return {
      status: 500,
      body: { error: `Failed to write ${readPath}: ${(err as Error).message}` },
    };
  }

  const changedPaths = operations.map((operation) => operation.path);
  // A fresh file value must not be shadowed by an older runtime toggle.
  for (const path of changedPaths) {
    try {
      deleteRuntimeOverride(ctx.storePath, [...path]);
    } catch {
      // The override file is auxiliary; a failed cleanup must not undo the save.
    }
  }

  let reloaded: RagConfig | undefined;
  try {
    reloaded = buildEffective(
      layer === "global" ? readPath : ctx.globalConfigPath,
      layer === "project" ? readPath : resolveProjectReadPath(ctx.workspaceDir, ctx.projectConfigPath),
      loadRuntimeOverrides(ctx.storePath) as unknown as Record<string, unknown>,
    );
  } catch {
    reloaded = ctx.configRef.current;
  }
  if (reloaded) {
    ctx.configRef.current = reloaded;
    ctx.onConfigChanged?.(reloaded, changedPaths);
  }

  const snapshot = readConfigSnapshot(ctx);
  const impacts = new Set(operations.map((operation) => findSettingField(operation.path)?.impact ?? "live"));
  const impact = impacts.has("restart") ? "restart" : impacts.has("reindex") ? "reindex" : "live";

  return {
    status: 200,
    body: {
      ...snapshot,
      saved: {
        layer,
        applied: operations.length,
        changedPaths: changedPaths.map(dottedPath),
        impact,
      },
    },
  };
}

/** PATCH /api/config — validated, atomic layer write. */
export function handleConfigPatch(ctx: ConfigApiContext, body: unknown): ConfigApiResponse {
  const parsed = parsePatchBody(body);
  if (!parsed.ok) return parsed.response;

  if (parsed.layer === "runtime") {
    for (const operation of parsed.operations) {
      try {
        deleteRuntimeOverride(ctx.storePath, [...operation.path]);
      } catch (err) {
        return {
          status: 500,
          body: { error: `Failed to clear runtime override: ${(err as Error).message}` },
        };
      }
    }
    let reloaded: RagConfig | undefined;
    try {
      reloaded = buildEffective(
        ctx.globalConfigPath,
        resolveProjectReadPath(ctx.workspaceDir, ctx.projectConfigPath),
        loadRuntimeOverrides(ctx.storePath) as unknown as Record<string, unknown>,
      );
    } catch {
      reloaded = ctx.configRef.current;
    }
    if (reloaded) {
      ctx.configRef.current = reloaded;
      ctx.onConfigChanged?.(reloaded, []);
    }
    const snapshot = readConfigSnapshot(ctx);
    return {
      status: 200,
      body: {
        ...snapshot,
        saved: {
          layer: "runtime",
          applied: parsed.operations.length,
          changedPaths: parsed.operations.map((operation) => dottedPath(operation.path)),
          impact: "live",
        },
      },
    };
  }

  return applyPatch(ctx, parsed.layer, parsed.operations, parsed.baseMtime);
}

/** Default context factory used by the server when no overrides are supplied. */
export function defaultConfigApiContext(
  workspaceDir: string,
  storePath: string,
  projectConfigPath?: string,
  globalPath?: string,
): Pick<ConfigApiContext, "workspaceDir" | "projectConfigPath" | "globalConfigPath" | "storePath"> {
  return {
    workspaceDir,
    projectConfigPath: projectConfigPath ?? defaultProjectConfigPath(workspaceDir),
    globalConfigPath: globalPath ?? defaultGlobalConfigPath(),
    storePath,
  };
}

/** All schema leaf paths, for the completeness test. */
export function schemaLeafPaths(): string[] {
  return collectConfigLeafPaths(
    Object.fromEntries(SETTINGS_SECTIONS.map((section) => [section.id, section.fields])),
  );
}

export { isSecretConfigPath };
