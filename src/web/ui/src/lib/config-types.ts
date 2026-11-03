/**
 * @fileoverview Client-side types mirroring the server's configuration schema,
 * plus the small helpers the form needs (path lookup, validation, formatting).
 */

export type SettingType =
  | "boolean"
  | "number"
  | "string"
  | "enum"
  | "string[]"
  | "stringMap"
  | "stringArrayMap"
  | "json";

export type SettingImpact = "live" | "reindex" | "restart";
export type SettingScope = "project" | "global";

export interface SettingField {
  path: string[];
  label: string;
  description?: string;
  type: SettingType;
  enumValues?: string[];
  minimum?: number;
  maximum?: number;
  step?: number;
  placeholder?: string;
  multiline?: boolean;
  secret?: boolean;
  advanced?: boolean;
  scope: SettingScope;
  impact: SettingImpact;
}

export interface SettingSection {
  id: string;
  label: string;
  description?: string;
  fields: SettingField[];
}

export interface ConfigLayer {
  path: string;
  writePath?: string;
  exists: boolean;
  mtimeMs: number;
  values: Record<string, unknown>;
  secretSet: Record<string, boolean>;
  error?: string;
}

export interface ConfigWarning {
  code: string;
  message: string;
  paths?: string[];
}

export interface ConfigSaved {
  layer: "project" | "global" | "runtime";
  applied: number;
  changedPaths: string[];
  impact: SettingImpact;
}

export interface ConfigSnapshot {
  config: Record<string, unknown>;
  schema: { version: number; sections: SettingSection[] };
  layers: { global: ConfigLayer; project: ConfigLayer };
  runtimeOverrides: { path: string; values: Record<string, unknown> };
  provenance: Record<string, string>;
  warnings: ConfigWarning[];
  saved?: ConfigSaved;
}

export type ConfigLayerName = "project" | "global";
export type ConfigViewName = ConfigLayerName | "effective";

export interface ConfigPatchOperation {
  op: "set" | "unset";
  path: string[];
  value?: unknown;
}

/** Dotted key used in drafts and error maps. */
export function pathKey(path: readonly string[]): string {
  return path.join(".");
}

/** Read a nested value; returns undefined when any segment is missing. */
export function getAtPath(root: unknown, path: readonly string[]): unknown {
  let cursor: unknown = root;
  for (const segment of path) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** True when the full path exists as an own property chain. */
export function hasAtPath(root: unknown, path: readonly string[]): boolean {
  let cursor: unknown = root;
  for (const segment of path) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return false;
    if (!Object.hasOwn(cursor as Record<string, unknown>, segment)) return false;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return true;
}

/** Structural equality for JSON-ish values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === "object" && a !== null && b !== null) {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => Object.hasOwn(bObj, key) && deepEqual(aObj[key], bObj[key]));
  }
  return false;
}

/** Human-readable one-line rendering for read-only values. */
export function formatConfigValue(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value.length > 160 ? `${value.slice(0, 157)}…` : value;
  if (Array.isArray(value)) {
    const text = value.map((item) => String(item)).join(", ");
    return text.length > 160 ? `${text.slice(0, 157)}…` : text || "(empty)";
  }
  const json = JSON.stringify(value);
  return json.length > 160 ? `${json.slice(0, 157)}…` : json;
}

/** Validate a typed value against a field; mirrors the server's checks. */
export function validateConfigValue(field: SettingField, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean" ? undefined : "Must be true or false";
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "Must be a number";
      if (field.minimum !== undefined && value < field.minimum) return `Must be at least ${field.minimum}`;
      if (field.maximum !== undefined && value > field.maximum) return `Must be at most ${field.maximum}`;
      return undefined;
    }
    case "string":
      return typeof value === "string" ? undefined : "Must be text";
    case "enum":
      if (typeof value !== "string") return "Must be text";
      if (field.enumValues && !field.enumValues.includes(value)) {
        return `Must be one of: ${field.enumValues.join(", ")}`;
      }
      return undefined;
    case "string[]":
      return Array.isArray(value) && value.every((item) => typeof item === "string")
        ? undefined
        : "Must be a list of strings";
    case "stringMap": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return "Must be an object mapping names to strings";
      }
      return Object.values(value as Record<string, unknown>).every((item) => typeof item === "string")
        ? undefined
        : "Every value must be a string";
    }
    case "stringArrayMap": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return "Must be an object mapping names to lists";
      }
      return Object.values(value as Record<string, unknown>).every(
        (item) => Array.isArray(item) && item.every((entry) => typeof entry === "string"),
      )
        ? undefined
        : "Every value must be a list of strings";
    }
    case "json":
      return undefined;
  }
}

/** Label shown for a provenance value. */
export function provenanceLabel(provenance: string | undefined): string {
  switch (provenance) {
    case "runtime":
      return "Runtime";
    case "project":
      return "Project";
    case "global":
      return "Global";
    case "default":
      return "Default";
    default:
      return "Unknown";
  }
}
