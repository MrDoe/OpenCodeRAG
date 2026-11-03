/**
 * @fileoverview Signal store for the Configuration page: snapshot, per-layer
 * drafts, validation errors, and the save lifecycle.
 */

import { signal } from "@preact/signals";
import { API, ConfigApiError } from "../lib/api";
import { addToast } from "./store";
import { theme, type ThemeName } from "./store";
import {
  deepEqual,
  getAtPath,
  hasAtPath,
  pathKey,
  type ConfigLayerName,
  type ConfigPatchOperation,
  type ConfigSnapshot,
  type ConfigViewName,
  type SettingField,
  type SettingImpact,
} from "../lib/config-types";

/** Pending edits for one layer. */
export interface ConfigDraft {
  set: Record<string, unknown>;
  unset: Record<string, true>;
}

const EMPTY_DRAFT: ConfigDraft = { set: {}, unset: {} };

function readStoredAdvanced(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem("rag-config-advanced") === "1";
}

export const configSnapshot = signal<ConfigSnapshot | null>(null);
export const configLoading = signal<boolean>(true);
export const configError = signal<string | null>(null);
export const configView = signal<ConfigViewName>("project");
export const configAdvanced = signal<boolean>(readStoredAdvanced());
export const configSearch = signal<string>("");
export const configDrafts = signal<Record<ConfigLayerName, ConfigDraft>>({
  project: EMPTY_DRAFT,
  global: EMPTY_DRAFT,
});
export const configFieldErrors = signal<Record<string, string>>({});
export const configSaving = signal<boolean>(false);
export const configSaveState = signal<"idle" | "saving" | "saved" | "error">("idle");
export const configSaveMessage = signal<string | null>(null);
export const configLastImpact = signal<SettingImpact | null>(null);

/** Toggle the advanced-settings visibility and persist the choice. */
export function setConfigAdvanced(value: boolean): void {
  configAdvanced.value = value;
  try {
    localStorage.setItem("rag-config-advanced", value ? "1" : "0");
  } catch {
    // Storage unavailable — the toggle still applies for this session.
  }
}

/** Empty both drafts (after a successful save or a reload). */
export function resetDrafts(layer?: ConfigLayerName): void {
  if (!layer) {
    configDrafts.value = { project: EMPTY_DRAFT, global: EMPTY_DRAFT };
    return;
  }
  configDrafts.value = { ...configDrafts.value, [layer]: EMPTY_DRAFT };
}

/** Fetch the full snapshot (schema + layers + effective config). */
export async function loadConfigSnapshot(showLoading = true): Promise<void> {
  if (showLoading) configLoading.value = true;
  configError.value = null;
  try {
    const snapshot = (await API.configLayers()) as ConfigSnapshot;
    configSnapshot.value = snapshot;
    adoptSnapshotTheme(snapshot);
    resetDrafts();
    configFieldErrors.value = {};
    configSaveState.value = "idle";
  } catch (err) {
    configError.value = (err as Error).message;
  } finally {
    configLoading.value = false;
  }
}

/** Theme names the dashboard supports. */
const KNOWN_THEMES: ThemeName[] = ["dark", "light", "plasma", "drama"];

/**
 * Adopt the persisted `ui.theme` from a fresh snapshot.
 *
 * The global config is the source of truth; localStorage is only the
 * first-paint cache. Runs on snapshot load and Reload, never on save (a save
 * already reflects the current choice).
 */
export function adoptSnapshotTheme(snapshot: ConfigSnapshot): void {
  const ui = (snapshot.config as Record<string, unknown>).ui;
  const name =
    typeof ui === "object" && ui !== null ? (ui as Record<string, unknown>).theme : undefined;
  if (typeof name === "string" && (KNOWN_THEMES as string[]).includes(name) && name !== theme.value) {
    theme.value = name as ThemeName;
  }
}

/**
 * Persist a theme choice to the global config (fire-and-forget).
 *
 * The signal + localStorage apply instantly (see `useTheme`); this only syncs
 * the persisted copy. The snapshot is refreshed so later saves use a fresh
 * mtime, but pending drafts are kept — a theme click must never discard
 * unsaved edits.
 */
export async function persistThemeChoice(name: ThemeName): Promise<void> {
  try {
    const result = (await API.patchConfig({
      layer: "global",
      operations: [{ op: "set", path: ["ui", "theme"], value: name }],
    })) as ConfigSnapshot;
    configSnapshot.value = result;
  } catch (err) {
    addToast(
      "error",
      `Theme applied locally — could not save to global config: ${(err as Error).message}`,
      6000,
    );
  }
}

/** Raw value written in a layer (undefined when inherited). */
export function rawLayerValue(
  snapshot: ConfigSnapshot | null,
  layer: ConfigLayerName,
  path: string[],
): unknown {
  if (!snapshot) return undefined;
  return getAtPath(snapshot.layers[layer].values, path);
}

/** Value shown in a control: draft > layer value > effective value. */
export function displayValue(
  snapshot: ConfigSnapshot | null,
  layer: ConfigLayerName,
  field: SettingField,
): unknown {
  if (!snapshot) return undefined;
  const key = pathKey(field.path);
  const draft = configDrafts.value[layer];
  if (Object.hasOwn(draft.set, key)) return draft.set[key];
  if (field.secret) {
    // The effective config only carries the `***` sentinel — never render it
    // into an input where a save could write it back.
    return undefined;
  }
  const raw = getAtPath(snapshot.layers[layer].values, field.path);
  if (raw !== undefined) return raw;
  return getAtPath(snapshot.config, field.path);
}

/** True when the layer explicitly sets the field (secrets included). */
export function layerHasValue(
  snapshot: ConfigSnapshot | null,
  layer: ConfigLayerName,
  field: SettingField,
): boolean {
  if (!snapshot) return false;
  if (hasAtPath(snapshot.layers[layer].values, field.path)) return true;
  // Secret values are stripped from the payload; `secretSet` is the only
  // signal that the layer actually holds one.
  return field.secret === true && snapshot.layers[layer].secretSet[pathKey(field.path)] === true;
}

/** True when a secret has a value in the layer, ignoring a pending clear. */
export function secretIsSet(
  snapshot: ConfigSnapshot | null,
  layer: ConfigLayerName,
  field: SettingField,
): boolean {
  if (!snapshot || field.secret !== true) return false;
  const key = pathKey(field.path);
  const draft = configDrafts.value[layer];
  if (draft.unset[key]) return false;
  const staged = draft.set[key];
  if (typeof staged === "string" && staged !== "***") return true;
  return snapshot.layers[layer].secretSet[key] === true;
}

/** Edit one field in the active layer draft. */
export function setDraftValue(
  layer: ConfigLayerName,
  field: SettingField,
  value: unknown,
): void {
  const key = pathKey(field.path);
  const draft = configDrafts.value[layer];
  const set = { ...draft.set };
  const unset = { ...draft.unset };
  const raw = configSnapshot.value ? rawLayerValue(configSnapshot.value, layer, field.path) : undefined;

  if (value === undefined) {
    delete set[key];
    if (layerHasValue(configSnapshot.value, layer, field)) {
      unset[key] = true;
    } else {
      delete unset[key];
    }
  } else if (deepEqual(value, raw)) {
    delete set[key];
    delete unset[key];
  } else {
    set[key] = value;
    delete unset[key];
  }

  configDrafts.value = { ...configDrafts.value, [layer]: { set, unset } };
  if (configFieldErrors.value[key]) {
    const next = { ...configFieldErrors.value };
    delete next[key];
    configFieldErrors.value = next;
  }
}

/**
 * Drop any pending edit for a field without staging a removal.
 *
 * Needed for secrets: clearing a replacement input must not delete the stored
 * secret — only the explicit Clear button does that.
 */
export function revertDraftValue(layer: ConfigLayerName, field: SettingField): void {
  const key = pathKey(field.path);
  const draft = configDrafts.value[layer];
  const set = { ...draft.set };
  const unset = { ...draft.unset };
  delete set[key];
  delete unset[key];
  configDrafts.value = { ...configDrafts.value, [layer]: { set, unset } };
}

/** Remove the layer's override so the value is inherited again. */
export function clearDraftOverride(layer: ConfigLayerName, field: SettingField): void {
  const key = pathKey(field.path);
  const draft = configDrafts.value[layer];
  const set = { ...draft.set };
  const unset = { ...draft.unset };
  delete set[key];
  if (layerHasValue(configSnapshot.value, layer, field)) {
    unset[key] = true;
  } else {
    delete unset[key];
  }
  configDrafts.value = { ...configDrafts.value, [layer]: { set, unset } };
  if (configFieldErrors.value[key]) {
    const next = { ...configFieldErrors.value };
    delete next[key];
    configFieldErrors.value = next;
  }
}

/** Operations that would be sent for a layer. */
export function buildOperations(layer: ConfigLayerName, fields: SettingField[]): ConfigPatchOperation[] {
  const snapshot = configSnapshot.value;
  if (!snapshot) return [];
  const fieldByKey = new Map(fields.map((field) => [pathKey(field.path), field]));
  const draft = configDrafts.value[layer];
  const operations: ConfigPatchOperation[] = [];

  for (const [key, value] of Object.entries(draft.set)) {
    const field = fieldByKey.get(key);
    if (!field) continue;
    const raw = rawLayerValue(snapshot, layer, field.path);
    if (!deepEqual(raw, value)) {
      operations.push({ op: "set", path: field.path, value });
    }
  }
  for (const key of Object.keys(draft.unset)) {
    const field = fieldByKey.get(key);
    if (!field) continue;
    if (layerHasValue(snapshot, layer, field)) {
      operations.push({ op: "unset", path: field.path });
    }
  }
  return operations;
}

/** Number of pending changes in a layer. */
export function dirtyCount(layer: ConfigLayerName, fields: SettingField[]): number {
  return buildOperations(layer, fields).length;
}

/** Set or clear one field error. */
export function setFieldError(key: string, message: string | undefined): void {
  const next = { ...configFieldErrors.value };
  if (message) next[key] = message;
  else delete next[key];
  configFieldErrors.value = next;
}

/** Save a layer. Returns true on success so the caller can move focus. */
export async function saveLayer(layer: ConfigLayerName, fields: SettingField[]): Promise<boolean> {
  const snapshot = configSnapshot.value;
  if (!snapshot) return false;
  const operations = buildOperations(layer, fields);
  if (operations.length === 0) {
    addToast("info", "No changes to save");
    return true;
  }

  configSaving.value = true;
  configSaveState.value = "saving";
  configSaveMessage.value = "Saving…";
  configFieldErrors.value = {};

  try {
    const result = (await API.patchConfig({
      layer,
      operations,
      base: { [layer]: { mtimeMs: snapshot.layers[layer].mtimeMs } },
    })) as ConfigSnapshot;

    configSnapshot.value = result;
    resetDrafts(layer);
    configLastImpact.value = result.saved?.impact ?? "live";
    configSaveState.value = "saved";
    configSaveMessage.value = `${operations.length} change${operations.length === 1 ? "" : "s"} saved`;
    addToast("success", "Configuration saved");
    return true;
  } catch (err) {
    if (err instanceof ConfigApiError && err.fieldErrors) {
      configFieldErrors.value = err.fieldErrors;
    }
    configSaveState.value = "error";
    configSaveMessage.value = (err as Error).message;
    addToast("error", (err as Error).message, 6000);
    return false;
  } finally {
    configSaving.value = false;
  }
}

/** Remove one runtime override so the file value applies again. */
export async function clearRuntimeOverride(path: string[]): Promise<void> {
  try {
    const result = (await API.patchConfig({
      layer: "runtime",
      operations: [{ op: "unset", path }],
    })) as ConfigSnapshot;
    configSnapshot.value = result;
    addToast("success", "Runtime override cleared");
  } catch (err) {
    addToast("error", (err as Error).message, 6000);
  }
}

/** Queue stale provider keys in the project file for removal. */
export function queueProjectRemovals(paths: string[]): void {
  const draft = configDrafts.value.project;
  const unset = { ...draft.unset };
  const set = { ...draft.set };
  for (const dotted of paths) {
    const path = dotted.split(".");
    delete set[dotted];
    const field = findFieldByDotted(path);
    if (field ? layerHasValue(configSnapshot.value, "project", field) : hasAtPath(configSnapshot.value?.layers.project.values ?? {}, path)) {
      unset[dotted] = true;
    }
  }
  configDrafts.value = { ...configDrafts.value, project: { set, unset } };
  addToast("info", `${paths.length} removal${paths.length === 1 ? "" : "s"} queued — review and save the Project layer.`);
}

/** Schema lookup for a path that arrived as a dotted string. */
export function findFieldByDotted(path: string[]): SettingField | undefined {
  const target = pathKey(path);
  for (const section of configSnapshot.value?.schema.sections ?? []) {
    for (const field of section.fields) {
      if (pathKey(field.path) === target) return field;
    }
  }
  return undefined;
}

/** Latest snapshot value for a field. */
export function effectiveValue(snapshot: ConfigSnapshot | null, field: SettingField): unknown {
  if (!snapshot) return undefined;
  return getAtPath(snapshot.config, field.path);
}
