/**
 * @fileoverview Repair flow for models that fail the post-setup health check.
 *
 * `setup` probes the configured providers after applying the configuration.
 * When a model answers with an error (expired key, wrong URL, unreachable
 * server) the run must not stop at "Some providers are not reachable": this
 * module asks whether to fix the section, then collects provider, base URL,
 * API key and model (the same questions as the wizard) and writes the result
 * into the config layer that already owns the section.
 *
 * The health check resolves API keys the same way the runtime does
 * (`resolveApiKey`), so a key stored in OpenCode's auth store is used instead
 * of the indexing section's key — an expired Zen key then reports itself as
 * expired rather than as a generic 401.
 */

import { loadWorkspaceConfig, configuredSections, type ProxyConfig } from "../../core/config.js";
import { resolveApiKey } from "../../core/resolve-api-key.js";
import { resolveZenBaseUrl, isZenProvider } from "../../core/zen.js";
import { resolveOnDemandImageConfig } from "../../chunker/image.js";
import { checkProviderHealth, type HealthCheckResult } from "../../embedder/health.js";
import { c } from "../format.js";
import type { Prompter } from "../prompt.js";
import { readJsonObjectSafe, writeConfigPatch } from "./apply.js";
import { askHost, pickModel, type ProviderEntry } from "./flow.js";
import type { ModelCapability } from "./model-catalog.js";

/** Options for {@link offerHealthRepairs}. */
export interface HealthRepairOptions {
  /** Workspace root (used to reload the effective config and detect sections). */
  cwd: string;
  /** Existing workspace config path (`setup` already resolved it). */
  workspaceConfigPath: string;
  /** Machine-global config path. */
  globalConfigPath: string;
  prompter: Prompter;
  /** Results of the health check that just printed its report. */
  results: readonly HealthCheckResult[];
  proxy?: ProxyConfig;
}

/** Where one failed model lives in the config. */
interface FailureTarget {
  section: "embedding" | "description" | "imageDescription" | "reranking";
  /** Nested override (`imageDescription.onDemand`). */
  sub?: "onDemand";
  label: string;
  capability: ModelCapability;
  requireEmbedding?: boolean;
  requireChat?: boolean;
}

const TARGETS: Record<HealthCheckResult["type"], FailureTarget> = {
  embedding: {
    section: "embedding",
    label: "Embedding",
    capability: "embedding",
    requireEmbedding: true,
  },
  description: {
    section: "description",
    label: "Description",
    capability: "chat",
    requireChat: true,
  },
  image_description: {
    section: "imageDescription",
    label: "Image description",
    capability: "vision",
    requireChat: true,
  },
  image_description_on_demand: {
    section: "imageDescription",
    sub: "onDemand",
    label: "Image description (on-demand)",
    capability: "vision",
    requireChat: true,
  },
  rerank: {
    section: "reranking",
    label: "Reranking",
    capability: "chat",
  },
};

/** Whether a config object has the given section (or nested override). */
function hasSection(raw: Record<string, unknown>, section: string, sub?: string): boolean {
  const value = raw[section];
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!sub) return true;
  const nested = (value as Record<string, unknown>)[sub];
  return Boolean(nested) && typeof nested === "object";
}

/**
 * Pick the config file that owns a section.
 *
 * The section is repaired where the user already put it, so the write is
 * visible immediately instead of being shadowed by another layer.
 */
export function resolveRepairLayer(
  workspaceConfigPath: string,
  globalConfigPath: string,
  section: string,
  sub?: string,
): string {
  if (hasSection(readJsonObjectSafe(workspaceConfigPath), section, sub)) return workspaceConfigPath;
  if (hasSection(readJsonObjectSafe(globalConfigPath), section, sub)) return globalConfigPath;
  return sub ? globalConfigPath : workspaceConfigPath;
}

/**
 * Build the sparse patch for a repaired section.
 *
 * `apiKey: null` deletes a stale key (so an environment variable or the
 * OpenCode auth store can take over); `vectorDimension: null` does the same
 * for an embedding model that may have a different dimension.
 */
export function buildRepairPatch(
  section: "embedding" | "description" | "imageDescription" | "reranking",
  sub: "onDemand" | undefined,
  choice: Record<string, unknown>,
): Record<string, unknown> {
  const values = { ...choice };
  if (!values.apiKey) values.apiKey = null;
  if (sub === "onDemand") return { imageDescription: { onDemand: values } };
  if (section === "embedding") return { embedding: { ...values, vectorDimension: null } };
  return { [section]: values };
}

/** A provider entry for an id the wizard does not list (e.g. `opencode-go`). */
function extraProvider(id: string, target: FailureTarget): ProviderEntry[] {
  if (id.length === 0) return [];
  return [
    {
      id,
      label: `${id} (current)`,
      description: "Provider already configured for this model",
      embedding: target.capability === "embedding",
      chat: target.capability !== "embedding",
    },
  ];
}

/** Prompt for a reranker endpoint (no model catalog — llama-server style). */
async function repairReranker(
  prompter: Prompter,
  current: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const baseUrl = await prompter.text({
    message: "Rerank endpoint base URL",
    defaultValue: typeof current.baseUrl === "string" ? current.baseUrl : "http://127.0.0.1:8080/v1",
    hint: "llama-server with --reranking serves /v1/rerank",
  });
  if (baseUrl === undefined) return undefined;
  const model = await prompter.text({
    message: "Rerank model",
    defaultValue: typeof current.model === "string" ? current.model : "qwen3-reranker-0.6b",
  });
  if (model === undefined) return undefined;
  const key = await prompter.password("API key (Enter keeps the current one)");
  if (key === undefined) return undefined;
  const apiKey = key.trim().length > 0 ? key.trim() : undefined;
  return { baseUrl, model, ...(apiKey ? { apiKey } : { apiKey: null }) };
}

/** Repair one failed model. Returns `true` when a patch was written. */
async function repairOne(
  options: HealthRepairOptions,
  failure: HealthCheckResult,
): Promise<boolean> {
  const target = TARGETS[failure.type];
  if (!target) return false;

  const config = loadWorkspaceConfig(options.cwd);
  const sectionValue =
    target.section === "reranking"
      ? (config.reranking as unknown as Record<string, unknown> | undefined)
      : (config[target.section] as unknown as Record<string, unknown> | undefined);
  const override =
    target.sub && sectionValue
      ? (sectionValue[target.sub] as Record<string, unknown> | undefined)
      : undefined;
  const effective =
    target.sub && config.imageDescription
      ? (resolveOnDemandImageConfig(config.imageDescription) as unknown as Record<string, unknown>)
      : (sectionValue ?? {});

  if (target.sub === "onDemand") {
    const disable = await options.prompter.confirm({
      message: "Remove the on-demand override and use the indexing vision model instead?",
      defaultValue: false,
    });
    if (disable === undefined) return false;
    if (disable) {
      const layer = resolveRepairLayer(options.workspaceConfigPath, options.globalConfigPath, "imageDescription", "onDemand");
      writeConfigPatch(layer, { imageDescription: { onDemand: null } });
      console.log(`  ${c.updated("Removed:")} imageDescription.onDemand`);
      return true;
    }
  }

  if (target.section === "reranking") {
    const patch = await repairReranker(options.prompter, effective);
    if (!patch) return false;
    const layer = resolveRepairLayer(options.workspaceConfigPath, options.globalConfigPath, "reranking");
    writeConfigPatch(layer, { reranking: patch });
    return true;
  }

  // Defaults: the section's own values first, the effective (inherited) values
  // second. For `onDemand` the inherited indexing base URL/key are deliberately
  // not offered as the stored key — they are what just failed.
  const provider = String(override?.provider ?? effective.provider ?? "ollama");
  const defaultBaseUrl =
    typeof override?.baseUrl === "string"
      ? override.baseUrl
      : isZenProvider(provider)
        ? resolveZenBaseUrl(typeof effective.baseUrl === "string" ? effective.baseUrl : undefined, provider)
        : String(effective.baseUrl ?? "");
  const defaultModel = String(override?.model ?? effective.model ?? "");
  const defaults = {
    provider,
    baseUrl: defaultBaseUrl,
    ...(defaultModel ? { model: defaultModel } : {}),
    ...(typeof override?.apiKey === "string" ? { apiKey: override.apiKey } : {}),
  };

  console.log();
  const host = await askHost(options.prompter, {
    message: `${target.label} provider`,
    existing: { embedding: defaults },
    flags: {},
    proxy: options.proxy,
    ...(target.requireEmbedding ? { requireEmbedding: true } : {}),
    ...(target.requireChat ? { requireChat: true } : {}),
    extraProviders: extraProvider(provider, target),
    forceKeyPrompt: true,
  });
  if (!host) return false;

  const model = await pickModel(options.prompter, {
    message: `${target.label} model`,
    catalog: host.catalog,
    capability: target.capability,
    defaultValue: defaultModel || undefined,
  });
  if (model === undefined) return false;

  const choice: Record<string, unknown> = {
    provider: host.host.provider,
    baseUrl: host.host.baseUrl,
    model,
    ...(host.host.apiKey ? { apiKey: host.host.apiKey } : {}),
  };

  const patch = buildRepairPatch(target.section, target.sub, choice);
  const layer = resolveRepairLayer(options.workspaceConfigPath, options.globalConfigPath, target.section, target.sub);
  if (!writeConfigPatch(layer, patch)) {
    console.log(`  ${c.warn("Could not write the configuration.")} Check permissions for ${c.file(layer)}.`);
    return false;
  }
  console.log(`  ${c.updated("Updated:")} ${c.file(layer)} ${c.dim(`(${target.label.toLowerCase()})`)}`);
  return true;
}

/**
 * Offer to repair every model that failed the connectivity check.
 *
 * Only runs for an interactive prompter: `--yes` / non-TTY runs keep the
 * current report-and-continue behaviour. Returns the number of sections that
 * were written.
 */
export async function offerHealthRepairs(options: HealthRepairOptions): Promise<number> {
  const failures = options.results.filter((result) => result.status === "error");
  if (failures.length === 0 || !options.prompter.interactive) return 0;

  console.log(`\n${c.heading("Fixing provider configuration")}`);
  let repaired = 0;
  for (const failure of failures) {
    const target = TARGETS[failure.type];
    if (!target) continue;
    const detail = failure.error ? ` (${failure.error})` : "";
    const answer = await options.prompter.confirm({
      message: `${target.label} model ${c.value(failure.model)} failed${detail}. Reconfigure it now?`,
      defaultValue: true,
    });
    if (answer === undefined) return repaired;
    if (!answer) continue;

    if (await repairOne(options, failure)) {
      repaired += 1;
      // Verify against the runtime-resolved config, not the raw file.
      const updated = loadWorkspaceConfig(options.cwd);
      resolveApiKey(updated, options.cwd);
      const after = (await checkProviderHealth(updated, configuredSections(options.cwd))).find(
        (result) => result.type === failure.type,
      );
      if (!after) {
        console.log(`  ${c.success("✓")} ${c.value(failure.model)} is no longer checked.`);
      } else if (after.status === "ok") {
        console.log(`  ${c.success("✓")} ${c.value(after.model)} is reachable now.`);
      } else {
        console.log(
          `  ${c.error("✗")} ${c.value(after.model)} still fails: ${after.error ?? "unknown error"}`,
        );
        console.log(`  ${c.dim("Run `opencode-rag setup --reconfigure` to change more settings.")}`);
      }
    }
  }
  return repaired;
}
