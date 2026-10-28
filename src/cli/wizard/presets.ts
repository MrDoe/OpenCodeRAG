/**
 * @fileoverview Recommended model presets for one-question `setup`.
 *
 * The presets are the "press Enter" path: they map a detected Ollama backend
 * (CPU vs GPU) to a small, well-tested model set so a first-time user does not
 * have to choose four models. The full wizard remains available as "Custom
 * setup" and via `--reconfigure`.
 */

import type { ModelCatalog } from "./model-catalog.js";

/** Preset identifiers. */
export type PresetId = "ollama-cpu" | "ollama-gpu" | "openai";

/** One recommended model set. */
export interface Preset {
  /** Stable identifier. */
  id: PresetId;
  /** Human-readable label. */
  label: string;
  /** One-line description shown in the prompt. */
  description: string;
  /** Provider that serves the models. */
  provider: "ollama" | "openai";
  /** Embedding model (required). */
  embedding: string;
  /** Description model, when the preset enables descriptions. */
  descriptionModel?: string;
  /** Vision model, when the preset enables image descriptions. */
  visionModel?: string;
}

/** CPU-friendly Ollama preset (small models, fast on consumer hardware). */
export const OLLAMA_CPU_PRESET: Preset = {
  id: "ollama-cpu",
  label: "Ollama · CPU",
  description: "Small models that stay fast without a dedicated GPU",
  provider: "ollama",
  embedding: "qwen3-embedding:0.6b",
  descriptionModel: "qwen2.5:3b",
  visionModel: "minicpm-v4.6",
};

/** GPU Ollama preset (larger embedding model for better recall). */
export const OLLAMA_GPU_PRESET: Preset = {
  id: "ollama-gpu",
  label: "Ollama · GPU",
  description: "Larger embedding model for better recall",
  provider: "ollama",
  embedding: "qwen3-embedding:1.7b",
  descriptionModel: "qwen2.5:3b",
  visionModel: "minicpm-v4.6",
};

/** OpenAI preset (cloud; needs OPENAI_API_KEY). */
export const OPENAI_PRESET: Preset = {
  id: "openai",
  label: "OpenAI",
  description: "Cloud models (requires OPENAI_API_KEY)",
  provider: "openai",
  embedding: "text-embedding-3-small",
  descriptionModel: "gpt-4o-mini",
  visionModel: "gpt-4o-mini",
};

/** All presets, in display order. */
export const PRESETS: readonly Preset[] = [OLLAMA_CPU_PRESET, OLLAMA_GPU_PRESET, OPENAI_PRESET];

/** Pick the Ollama preset matching a detected backend. */
export function presetForBackend(backend: "gpu" | "cpu" | "unreachable" | "unknown"): Preset {
  return backend === "gpu" ? OLLAMA_GPU_PRESET : OLLAMA_CPU_PRESET;
}

/** A model from a preset plus whether the host already has it. */
export interface PresetModelStatus {
  /** Model id. */
  id: string;
  /** Whether the host listed the model. */
  installed: boolean;
}

/**
 * Whether a model id is present in the catalog.
 *
 * Ollama lists the implicit `:latest` tag explicitly, so `minicpm-v4.6` and
 * `minicpm-v4.6:latest` are the same model for the "installed" display.
 */
function isInstalled(installed: ReadonlySet<string>, id: string): boolean {
  return installed.has(id) || installed.has(`${id.replace(/:latest$/i, "")}:latest`);
}

/**
 * List the preset's models with their installation status.
 *
 * An unreachable catalog reports every model as not installed (the caller
 * only uses this for display after a successful probe, but being defensive
 * keeps the helper usable from tests).
 */
export function presetModelStatus(preset: Preset, catalog?: ModelCatalog): PresetModelStatus[] {
  const installed = new Set(catalog?.models.map((model) => model.id) ?? []);
  const ids = [preset.embedding, preset.descriptionModel, preset.visionModel].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  return ids.map((id) => ({ id, installed: isInstalled(installed, id) }));
}

/** Render the preset's model list for the confirmation prompt. */
export function describePreset(preset: Preset, catalog?: ModelCatalog): string[] {
  return presetModelStatus(preset, catalog).map(
    (model) => `${model.id}${model.installed ? " (installed)" : " (will be pulled)"}`,
  );
}
