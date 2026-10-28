/**
 * @fileoverview Interactive `setup` wizard.
 *
 * The flow is deliberately linear and every question has a default taken from
 * the effective configuration, so pressing Enter through the wizard keeps an
 * existing setup intact. Any prompt resolving `undefined` (Ctrl+C / Ctrl+D)
 * aborts the whole wizard: no configuration is written.
 */

import { DEFAULT_CONFIG, type ProxyConfig } from "../../core/config.js";
import { getProviderDefault, supportsChat, supportsEmbedding } from "../../core/provider-defaults.js";
import { c } from "../format.js";
import { ollamaInstallHint } from "../ollama.js";
import type { Prompter, SelectOption } from "../prompt.js";
import { detectOllamaBackend } from "../commands/backend-detect.js";
import {
  fetchModelCatalog,
  probeEmbeddingDimension,
  ollamaRoot,
  type ModelCatalog,
  type ModelCapability,
} from "./model-catalog.js";
import { describePreset, presetForBackend } from "./presets.js";
import type {
  ChatChoice,
  DecisionChoice,
  EmbeddingChoice,
  HostChoice,
  RerankChoice,
  VectorStoreChoice,
  WizardAnswers,
} from "./types.js";

/** Provider entries offered by the wizard. */
export interface ProviderEntry {
  id: string;
  label: string;
  description: string;
  embedding: boolean;
  chat: boolean;
}

const PROVIDERS: readonly ProviderEntry[] = [
  {
    id: "ollama",
    label: "Ollama",
    description: "Local or remote — embeddings, chat, vision and the decision model",
    embedding: true,
    chat: true,
  },
  {
    id: "openai",
    label: "OpenAI-compatible API",
    description: "OpenAI, llama.cpp, LM Studio, vLLM, OpenRouter, …",
    embedding: true,
    chat: true,
  },
  {
    id: "cohere",
    label: "Cohere",
    description: "Embeddings only",
    embedding: true,
    chat: false,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    description: "Chat and vision — no embedding API",
    embedding: false,
    chat: true,
  },
  {
    id: "google",
    label: "Google Gemini",
    description: "Chat and vision — no embedding API",
    embedding: false,
    chat: true,
  },
];

/** Flags that pre-fill the wizard and make it scriptable. */
export interface WizardFlags {
  /** Provider id (`ollama`, `openai`, `cohere`, `anthropic`, `google`). */
  provider?: string;
  /** Base URL for the provider. */
  baseUrl?: string;
  /** API key (or `env:NAME` to read an environment variable). */
  apiKey?: string;
  /** Embedding model id. */
  embeddingModel?: string;
  /** Description model id (implies the feature is on). */
  descriptionModel?: string;
  /** Vision model id (implies the feature is on). */
  visionModel?: string;
  /** Decision model id (implies the feature is on). */
  decisionModel?: string;
  /** Explicit on/off for chunk descriptions. */
  description?: boolean;
  /** Explicit on/off for image descriptions. */
  vision?: boolean;
  /** Explicit on/off for the decision model. */
  decision?: boolean;
  /** Explicit on/off for reranking. */
  reranking?: boolean;
  /** Explicit on/off for the shell guard. */
  shellGuard?: boolean;
  /** Explicit on/off for passive quirk capture. */
  memoryCapture?: boolean;
  /** Vector-store backend (`lancedb` or `clickhouse`). */
  vectorStore?: string;
  /** ClickHouse endpoint. */
  clickhouseUrl?: string;
  /** ClickHouse database. */
  clickhouseDatabase?: string;
  /** ClickHouse user. */
  clickhouseUser?: string;
  /** Env var holding the ClickHouse password. */
  clickhousePasswordEnv?: string;
  /** ClickHouse project namespace. */
  clickhouseNamespace?: string;
}

/** Inputs for {@link runSetupWizard}. */
export interface WizardRunOptions extends WizardFlags {
  /** Prompter to use (interactive by construction). */
  prompter: Prompter;
  /** Effective raw config (global < workspace) used to pre-fill defaults. */
  existing: Record<string, unknown>;
  /** Proxy settings inherited from the current embedding config. */
  proxy?: ProxyConfig;
}

/** Read a section of the raw config. */
function section(
  config: Record<string, unknown>,
  name: string,
): Record<string, unknown> | undefined {
  const value = config[name];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Read a string from a raw config section. */
function readString(
  config: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = config?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read a boolean from a raw config section. */
function readBoolean(
  config: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = config?.[key];
  return typeof value === "boolean" ? value : undefined;
}

/** Default base URL for a provider. */
function defaultBaseUrl(provider: string): string {
  const defaults = getProviderDefault(provider);
  if (defaults?.defaultBaseUrl) return defaults.defaultBaseUrl;
  if (provider === "ollama") return "http://127.0.0.1:11434/api";
  return "";
}

/** Render a catalog probe result as a status line. */
function printCatalogStatus(catalog: ModelCatalog): void {
  if (catalog.reachable) {
    const count = catalog.models.length;
    console.log(`  ${c.success("✓")} ${c.value(catalog.baseUrl)} — ${count} model${count === 1 ? "" : "s"} found`);
    return;
  }
  console.log(`  ${c.error("✗")} ${c.value(catalog.baseUrl)} — ${catalog.error ?? "unreachable"}`);
}

/** Ask for a provider + base URL + optional API key, then probe its models. */
export async function askHost(
  prompter: Prompter,
  options: {
    message: string;
    existing: Record<string, unknown>;
    flags: WizardFlags;
    proxy?: ProxyConfig;
    requireEmbedding?: boolean;
    requireChat?: boolean;
    /** Extra entries appended to the built-in list (repair keeps an unlisted provider selectable). */
    extraProviders?: readonly ProviderEntry[];
    /** Ask for a new key even when one is stored (used after an auth failure). */
    forceKeyPrompt?: boolean;
  },
): Promise<{ host: HostChoice; catalog: ModelCatalog } | undefined> {
  const { message, existing, flags } = options;
  const previous = section(existing, "embedding");
  const entries = [...PROVIDERS];
  for (const extra of options.extraProviders ?? []) {
    if (!entries.some((entry) => entry.id === extra.id)) entries.push(extra);
  }
  const candidates = entries.filter((entry) =>
    (options.requireEmbedding ? entry.embedding : true) &&
    (options.requireChat ? entry.chat : true),
  );

  const defaultProvider =
    (flags.provider && candidates.some((entry) => entry.id === flags.provider) ? flags.provider : undefined) ??
    readString(previous, "provider") ??
    DEFAULT_CONFIG.embedding.provider;
  const defaultIndex = Math.max(0, candidates.findIndex((entry) => entry.id === defaultProvider));

  const picked = await prompter.select<string>({
    message,
    options: candidates.map((entry) => ({
      label: entry.label,
      value: entry.id,
      description: entry.description,
    })),
    defaultIndex,
  });
  if (picked === undefined) return undefined;
  const entry = candidates.find((candidate) => candidate.id === picked);
  if (!entry) return undefined;

  const baseUrlDefault =
    flags.baseUrl ??
    readString(previous, "baseUrl") ??
    (entry.id === "ollama" ? "http://127.0.0.1:11434/api" : defaultBaseUrl(entry.id));

  const baseUrl = await prompter.text({
    message: "Base URL",
    defaultValue: baseUrlDefault,
    hint:
      entry.id === "ollama"
        ? "Ollama accepts http://127.0.0.1:11434 or http://127.0.0.1:11434/api"
        : entry.id === "openai"
          ? "OpenAI-compatible servers usually end in /v1 (llama.cpp, LM Studio, vLLM, …)"
          : undefined,
    validate: (value) => {
      if (!value) return "A base URL is required.";
      try {
        new URL(value);
        return undefined;
      } catch {
        return "Enter a valid URL, e.g. http://127.0.0.1:11434/api";
      }
    },
  });
  if (baseUrl === undefined) return undefined;

  let apiKey: string | undefined;
  const envVar = getProviderDefault(entry.id)?.apiKeyEnvVar;
  const envValue = envVar ? process.env[envVar] : undefined;
  const existingKey = readString(previous, "apiKey");
  const flagKey =
    flags.apiKey && flags.apiKey.startsWith("env:")
      ? process.env[flags.apiKey.slice(4)]
      : flags.apiKey;

  if (flagKey) {
    apiKey = flagKey;
  } else if (options.forceKeyPrompt && entry.id !== "ollama") {
    if (existingKey && !existingKey.startsWith("env:")) {
      console.log(`  ${c.dim("The stored key was rejected — paste a new one, or press Enter to keep it.")}`);
    }
    const typed = await prompter.password("API key (Enter keeps the current one)");
    if (typed === undefined) return undefined;
    if (typed.trim().length > 0) apiKey = typed.trim();
    else if (existingKey && !existingKey.startsWith("env:")) apiKey = existingKey;
  } else if (existingKey && !existingKey.startsWith("env:")) {
    apiKey = existingKey;
    console.log(`  ${c.dim("Using the API key already stored in the config.")}`);
  } else if (envValue) {
    console.log(`  ${c.dim(`Using ${envVar} from the environment (not written to the config).`)}`);
  } else if (entry.id !== "ollama") {
    console.log(
      `  ${c.dim(envVar ? `No ${envVar} set. Paste a key or leave empty to add it later.` : "Paste an API key or leave empty to add it later.")}`,
    );
    const typed = await prompter.password("API key (Enter to skip)");
    if (typed === undefined) return undefined;
    if (typed.trim().length > 0) apiKey = typed.trim();
  }

  console.log(`\n  ${c.dim(`Checking ${entry.id} at ${baseUrl}…`)}`);
  const catalog = await fetchModelCatalog({
    provider: entry.id,
    baseUrl,
    apiKey,
    proxy: options.proxy,
  });
  printCatalogStatus(catalog);

  return {
    host: {
      provider: entry.id,
      baseUrl: entry.id === "ollama" ? catalog.baseUrl : baseUrl,
      ...(apiKey ? { apiKey } : {}),
    },
    catalog,
  };
}

/**
 * Pick a model from a probed catalog, falling back to free-text entry.
 *
 * `__custom__` is always offered so a model that the provider does not list
 * (or a freshly pulled one) can still be typed.
 */
export async function pickModel(
  prompter: Prompter,
  options: {
    message: string;
    catalog: ModelCatalog;
    capability: ModelCapability;
    defaultValue?: string;
    allowSkip?: boolean;
  },
): Promise<string | undefined> {
  const { catalog, capability } = options;
  const candidates = catalog.models.filter((model) => model.capabilities.includes(capability));
  // Keep the configured model selectable when the host lists models but did
  // not advertise it. With no candidates at all, fall straight through to
  // manual entry instead of showing a one-item menu.
  if (candidates.length > 0 && options.defaultValue && !candidates.some((model) => model.id === options.defaultValue)) {
    candidates.unshift({ id: options.defaultValue, capabilities: [capability] });
  }

  if (candidates.length === 0) {
    if (catalog.reachable) {
      console.log(`  ${c.warn("No model with the required capability was advertised by the host.")}`);
    }
    return prompter.text({
      message: options.message,
      defaultValue: options.defaultValue ?? "",
      hint: "Type the model name exactly as the provider expects it.",
    });
  }

  const entries: SelectOption<string>[] = candidates.map((model) => ({
    label: model.id,
    value: model.id,
    description: model.detail,
  }));
  entries.push({ label: "Type a model name…", value: "__custom__" });
  if (options.allowSkip) {
    entries.push({ label: "Skip for now", value: "__skip__" });
  }

  const defaultIndex = Math.max(
    0,
    options.defaultValue ? candidates.findIndex((model) => model.id === options.defaultValue) : 0,
  );

  const picked = await prompter.select<string>({
    message: options.message,
    options: entries,
    defaultIndex,
  });
  if (picked === undefined) return undefined;
  if (picked === "__skip__") return undefined;
  if (picked === "__custom__") {
    return prompter.text({
      message: options.message,
      defaultValue: options.defaultValue ?? "",
      hint: "Type the model name exactly as the provider expects it.",
    });
  }
  return picked;
}

/** Print a compact summary of the collected answers. */
function printSummary(answers: WizardAnswers): void {
  console.log(`\n${c.heading("Configuration summary")}\n`);
  const host = (choice: HostChoice): string =>
    `${choice.provider} @ ${choice.baseUrl}${choice.apiKey ? " (API key set)" : ""}`;
  console.log(`  ${c.label("Embedding:")}    ${c.value(answers.embedding.model)} — ${host(answers.embedding)}${answers.embedding.vectorDimension ? ` (${answers.embedding.vectorDimension} dims)` : ""}`);
  console.log(`  ${c.label("Description:")}  ${answers.description ? `${c.value(answers.description.model)} — ${host(answers.description)}` : c.dim("disabled")}`);
  console.log(`  ${c.label("Vision:")}       ${answers.imageDescription ? `${c.value(answers.imageDescription.model)} — ${host(answers.imageDescription)}` : c.dim("disabled")}`);
  console.log(`  ${c.label("Decision:")}     ${answers.decision?.enabled ? `${c.value(answers.decision.model ?? "tev1")} — ${answers.decision.baseUrl ?? "ollama"}` : c.dim("disabled")}`);
  console.log(`  ${c.label("Reranking:")}    ${answers.reranking?.enabled ? `${c.value(answers.reranking.model ?? "reranker")} — ${answers.reranking.baseUrl ?? ""}` : c.dim("disabled")}`);
  console.log(`  ${c.label("Shell guard:")}  ${answers.shellGuard ? (answers.shellGuard.enabled ? c.value("enabled") : c.dim("disabled")) : c.dim("unchanged")}`);
  console.log(`  ${c.label("Memory:")}       ${answers.memory ? (answers.memory.passiveCapture ? c.value("auto-capture on") : c.dim("auto-capture off")) : c.dim("unchanged")}`);
  console.log(`  ${c.label("Vector store:")} ${answers.vectorStore ? c.value(answers.vectorStore.provider) : c.dim("unchanged")}`);
  console.log(`\n  ${c.dim("Provider/model settings are written to the global config; toggles to .opencode/opencode-rag.json.")}`);
}

/** Ask the advanced questions (reranking, shell guard, memory, vector store). */
async function askAdvanced(
  prompter: Prompter,
  existing: Record<string, unknown>,
  flags: WizardFlags,
): Promise<Partial<WizardAnswers> | undefined> {
  const reranking = section(existing, "reranking");
  const shellGuard = section(existing, "shellGuard");
  const memory = section(existing, "memory");
  const vectorStore = section(existing, "vectorStore");
  const indexing = section(existing, "indexing");
  const openCode = section(existing, "openCode");
  const autoIndex = section(openCode ?? {}, "autoIndex");

  const answers: Partial<WizardAnswers> = {};

  const wantRerank =
    flags.reranking ??
    (await prompter.confirm({
      message: "Enable reranking with a llama-server /v1/rerank endpoint?",
      defaultValue: readBoolean(reranking, "enabled") ?? DEFAULT_CONFIG.reranking?.enabled ?? false,
    }));
  if (wantRerank === undefined) return undefined;
  if (wantRerank) {
    const baseUrl = await prompter.text({
      message: "Rerank base URL",
      defaultValue: readString(reranking, "baseUrl") ?? DEFAULT_CONFIG.reranking?.baseUrl ?? "http://127.0.0.1:8080/v1",
    });
    if (baseUrl === undefined) return undefined;
    const model = await prompter.text({
      message: "Rerank model",
      defaultValue: readString(reranking, "model") ?? DEFAULT_CONFIG.reranking?.model ?? "qwen3-reranker-0.6b",
    });
    if (model === undefined) return undefined;
    answers.reranking = { enabled: true, baseUrl, model } satisfies RerankChoice;
  } else {
    answers.reranking = { enabled: false };
  }

  const wantGuard =
    flags.shellGuard ??
    (await prompter.confirm({
      message: "Enable the shell-command guard (needs the decision model)?",
      defaultValue: readBoolean(shellGuard, "enabled") ?? DEFAULT_CONFIG.shellGuard?.enabled ?? false,
    }));
  if (wantGuard === undefined) return undefined;
  answers.shellGuard = { enabled: wantGuard };

  const wantCapture =
    flags.memoryCapture ??
    (await prompter.confirm({
      message: "Enable automatic quirk capture (passive + prompt enforcement + session end)?",
      defaultValue: readBoolean(memory, "passiveCapture") ?? DEFAULT_CONFIG.memory?.passiveCapture ?? true,
    }));
  if (wantCapture === undefined) return undefined;
  answers.memory = {
    passiveCapture: wantCapture,
    promptEnforcement: wantCapture,
    sessionEndExtraction: wantCapture,
  };

  const backendDefault = flags.vectorStore ?? readString(vectorStore, "provider") ?? "lancedb";
  const backend = await prompter.select<"lancedb" | "clickhouse">({
    message: "Vector store backend",
    options: [
      { label: "LanceDB (local, default)", value: "lancedb", description: "One index per workspace" },
      { label: "ClickHouse (central)", value: "clickhouse", description: "One shared index for many machines" },
    ],
    defaultIndex: backendDefault === "clickhouse" ? 1 : 0,
  });
  if (backend === undefined) return undefined;
  if (backend === "clickhouse") {
    const current = section(vectorStore ?? {}, "clickhouse");
    const url = await prompter.text({
      message: "ClickHouse URL",
      defaultValue: flags.clickhouseUrl ?? readString(current, "url") ?? "http://localhost:8123",
    });
    if (url === undefined) return undefined;
    const database = await prompter.text({
      message: "ClickHouse database",
      defaultValue: flags.clickhouseDatabase ?? readString(current, "database") ?? "OpenCodeRAG",
    });
    if (database === undefined) return undefined;
    const username = await prompter.text({
      message: "ClickHouse user",
      defaultValue: flags.clickhouseUser ?? readString(current, "username") ?? "default",
    });
    if (username === undefined) return undefined;
    const passwordEnv = await prompter.text({
      message: "Environment variable holding the ClickHouse password",
      defaultValue: flags.clickhousePasswordEnv ?? readString(current, "passwordEnv") ?? "OPENCODERAG_CLICKHOUSE_PASSWORD",
    });
    if (passwordEnv === undefined) return undefined;
    const namespace = await prompter.text({
      message: "Namespace (table suffix, optional)",
      defaultValue: flags.clickhouseNamespace ?? readString(current, "namespace") ?? "",
    });
    if (namespace === undefined) return undefined;
    answers.vectorStore = {
      provider: "clickhouse",
      clickhouse: {
        url,
        database,
        username,
        passwordEnv,
        ...(namespace ? { namespace } : {}),
      },
    } satisfies VectorStoreChoice;
  } else {
    answers.vectorStore = { provider: "lancedb" };
  }

  const embedDescriptions = await prompter.confirm({
    message: "Embed chunk descriptions as well as code? (turn off for code-specialized embedders)",
    defaultValue: readBoolean(indexing, "embedDescriptions") ?? DEFAULT_CONFIG.indexing.embedDescriptions ?? true,
  });
  if (embedDescriptions === undefined) return undefined;
  answers.indexing = { embedDescriptions };

  const wantWatcher = await prompter.confirm({
    message: "Run the background indexer automatically?",
    defaultValue: readBoolean(autoIndex, "enabled") ?? DEFAULT_CONFIG.openCode.autoIndex?.enabled ?? false,
  });
  if (wantWatcher === undefined) return undefined;
  answers.openCode = { autoIndex: wantWatcher };

  return answers;
}

/**
 * Whether the caller passed any flag that should override the stored config.
 *
 * `setup` only rewrites configuration when the wizard ran, when a flag was
 * supplied, or when no config exists yet.
 */
export function hasExplicitSetupFlags(flags: WizardFlags): boolean {
  const keys: (keyof WizardFlags)[] = [
    "provider",
    "baseUrl",
    "apiKey",
    "embeddingModel",
    "descriptionModel",
    "visionModel",
    "decisionModel",
    "description",
    "vision",
    "decision",
    "reranking",
    "shellGuard",
    "memoryCapture",
    "vectorStore",
  ];
  return keys.some((key) => flags[key] !== undefined);
}

/**
 * Build answers from CLI flags plus the existing config, for non-interactive
 * runs (`--yes`, CI, piped stdin).
 *
 * Only used when at least one explicit flag is present; otherwise `setup`
 * leaves the stored configuration alone.
 */
export function answersFromFlags(
  flags: WizardFlags,
  existing: Record<string, unknown>,
): WizardAnswers {
  const embeddingSection = section(existing, "embedding");
  const provider = flags.provider ?? readString(embeddingSection, "provider") ?? DEFAULT_CONFIG.embedding.provider;
  const baseUrl =
    flags.baseUrl ??
    readString(embeddingSection, "baseUrl") ??
    (provider === "ollama" ? "http://127.0.0.1:11434/api" : defaultBaseUrl(provider));
  const apiKey =
    flags.apiKey?.startsWith("env:")
      ? process.env[flags.apiKey.slice(4)]
      : flags.apiKey ?? readString(embeddingSection, "apiKey");
  const configuredModel = readString(embeddingSection, "model");
  const model = flags.embeddingModel ?? configuredModel ?? DEFAULT_CONFIG.embedding.model;
  // A configured dimension belongs to the configured model *and* host. Keep
  // it only when neither changes: carrying it to a different model would make
  // the store reject the new vectors (see concepts/embedding-dimension-integrity).
  const sameTarget =
    configuredModel !== undefined &&
    configuredModel === model &&
    provider === (readString(embeddingSection, "provider") ?? DEFAULT_CONFIG.embedding.provider) &&
    baseUrl ===
      (readString(embeddingSection, "baseUrl") ??
        (provider === "ollama" ? "http://127.0.0.1:11434/api" : defaultBaseUrl(provider)));
  const vectorDimension =
    sameTarget && typeof embeddingSection?.vectorDimension === "number"
      ? embeddingSection.vectorDimension
      : undefined;

  const embedding: EmbeddingChoice = {
    provider,
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    model,
    ...(vectorDimension ? { vectorDimension } : {}),
  };

  const descriptionSection = section(existing, "description");
  const descriptionFlag = flags.description ?? (flags.descriptionModel ? true : undefined);
  const chatAvailable = supportsChat(provider) || readString(descriptionSection, "provider") !== undefined;
  // Only touch descriptions when asked, or when a fresh workspace gets a host
  // that can actually serve chat completions.
  const enableDescription =
    descriptionFlag === true ||
    (descriptionFlag === undefined && descriptionSection === undefined && chatAvailable);
  const description: ChatChoice | undefined = enableDescription
    ? {
        provider: readString(descriptionSection, "provider") ?? provider,
        baseUrl: readString(descriptionSection, "baseUrl") ?? baseUrl,
        ...(readString(descriptionSection, "apiKey") ? { apiKey: readString(descriptionSection, "apiKey")! } : {}),
        model:
          flags.descriptionModel ??
          readString(descriptionSection, "model") ??
          DEFAULT_CONFIG.description?.model ??
          "qwen2.5:3b",
      }
    : undefined;
  const descriptionEnabled =
    descriptionFlag === false ? false : enableDescription ? true : undefined;

  const visionSection = section(existing, "imageDescription");
  const visionFlag = flags.vision ?? (flags.visionModel ? true : undefined);
  const imageDescription: ChatChoice | undefined = visionFlag === true && chatAvailable
    ? {
        provider: readString(visionSection, "provider") ?? provider,
        baseUrl: readString(visionSection, "baseUrl") ?? baseUrl,
        ...(readString(visionSection, "apiKey") ? { apiKey: readString(visionSection, "apiKey")! } : {}),
        model:
          flags.visionModel ??
          readString(visionSection, "model") ??
          DEFAULT_CONFIG.imageDescription?.model ??
          "minicpm-v4.6:latest",
      }
    : undefined;
  const imageDescriptionEnabled = visionFlag === false ? false : visionFlag === true ? true : undefined;

  const decisionSection = section(existing, "decision");
  const decisionFlag = flags.decision ?? (flags.decisionModel ? true : undefined);
  let decision: DecisionChoice | undefined;
  if (decisionFlag === true) {
    decision = {
      enabled: true,
      baseUrl: readString(decisionSection, "baseUrl") ?? "http://127.0.0.1:11434/api",
      model: flags.decisionModel ?? readString(decisionSection, "model") ?? DEFAULT_CONFIG.decision?.model ?? "tev1:4b",
      routeBeforeAsking: readBoolean(decisionSection, "routeBeforeAsking") ?? false,
    };
  } else if (decisionFlag === false) {
    decision = { enabled: false };
  }

  const answers: WizardAnswers = {
    embedding,
    ...(descriptionEnabled !== undefined ? { descriptionEnabled } : {}),
    ...(imageDescriptionEnabled !== undefined ? { imageDescriptionEnabled } : {}),
    ...(description ? { description } : {}),
    ...(imageDescription ? { imageDescription } : {}),
    ...(decision ? { decision } : {}),
  };

  if (flags.reranking !== undefined) {
    const rerankSection = section(existing, "reranking");
    answers.reranking = flags.reranking
      ? {
          enabled: true,
          baseUrl: readString(rerankSection, "baseUrl") ?? DEFAULT_CONFIG.reranking?.baseUrl ?? "http://127.0.0.1:8080/v1",
          model: readString(rerankSection, "model") ?? DEFAULT_CONFIG.reranking?.model ?? "qwen3-reranker-0.6b",
        }
      : { enabled: false };
  }
  if (flags.shellGuard !== undefined) {
    answers.shellGuard = { enabled: flags.shellGuard };
  }
  if (flags.memoryCapture !== undefined) {
    answers.memory = {
      passiveCapture: flags.memoryCapture,
      promptEnforcement: flags.memoryCapture,
      sessionEndExtraction: flags.memoryCapture,
    };
  }
  if (flags.vectorStore) {
    const clickhouseSection = section(section(existing, "vectorStore") ?? {}, "clickhouse");
    answers.vectorStore =
      flags.vectorStore === "clickhouse"
        ? {
            provider: "clickhouse",
            clickhouse: {
              url: flags.clickhouseUrl ?? readString(clickhouseSection, "url") ?? "http://localhost:8123",
              database: flags.clickhouseDatabase ?? readString(clickhouseSection, "database") ?? "OpenCodeRAG",
              username: flags.clickhouseUser ?? readString(clickhouseSection, "username") ?? "default",
              passwordEnv:
                flags.clickhousePasswordEnv ??
                readString(clickhouseSection, "passwordEnv") ??
                "OPENCODERAG_CLICKHOUSE_PASSWORD",
              ...(flags.clickhouseNamespace ?? readString(clickhouseSection, "namespace")
                ? { namespace: flags.clickhouseNamespace ?? readString(clickhouseSection, "namespace") }
                : {}),
            },
          }
        : { provider: "lancedb" };
  }

  return answers;
}

/**
 * Offer the one-question recommended setup.
 *
 * Returns `{ kind: "answers" }` when the user accepted the preset,
 * `{ kind: "custom" }` when the full wizard should run instead, and
 * `{ kind: "cancel" }` when the user aborted.
 */
async function offerRecommendedSetup(
  prompter: Prompter,
  options: WizardRunOptions,
): Promise<{ kind: "answers"; answers: WizardAnswers } | { kind: "custom" } | { kind: "cancel" }> {
  const { existing, proxy } = options;
  const embeddingSection = section(existing, "embedding");
  const existingProvider = readString(embeddingSection, "provider");
  // Non-Ollama setups are already deliberate; keep the detailed wizard.
  if (existingProvider && existingProvider !== "ollama") return { kind: "custom" };

  const baseUrl = readString(embeddingSection, "baseUrl") ?? "http://127.0.0.1:11434/api";
  console.log(`\n  ${c.dim(`Checking Ollama at ${baseUrl}…`)}`);
  const catalog = await fetchModelCatalog({ provider: "ollama", baseUrl, proxy });
  if (!catalog.reachable) {
    console.log(`  ${c.warn("Ollama is not reachable.")} ${c.dim(ollamaInstallHint())}`);
    console.log(`  ${c.dim("Continuing with manual setup.")}`);
    return { kind: "custom" };
  }

  const info = await detectOllamaBackend(catalog.baseUrl, proxy);
  const preset = presetForBackend(info.backend);
  console.log(`\n${c.heading("Recommended setup")} ${c.dim(`(${preset.label} — ${preset.description})`)}\n`);
  for (const model of describePreset(preset, catalog)) {
    console.log(`  ${c.value(model)}`);
  }

  const accept = await prompter.confirm({
    message: `Use this recommended ${preset.label} setup?`,
    defaultValue: true,
  });
  if (accept === undefined) return { kind: "cancel" };
  if (!accept) return { kind: "custom" };

  const dimension = await probeEmbeddingDimension({
    provider: "ollama",
    baseUrl: catalog.baseUrl,
    model: preset.embedding,
    proxy,
  });
  // Re-running the preset for the same model/host must not discard a known
  // dimension just because the probe failed (the model may be unloaded).
  const configuredDimension =
    typeof embeddingSection?.vectorDimension === "number" ? embeddingSection.vectorDimension : undefined;
  const sameModel = readString(embeddingSection, "model") === preset.embedding;
  const sameHost = (readString(embeddingSection, "baseUrl") ?? "http://127.0.0.1:11434/api") === catalog.baseUrl;
  const vectorDimension = dimension ?? (sameModel && sameHost ? configuredDimension : undefined);
  if (dimension) {
    console.log(`\n  ${c.success("✓")} ${c.value(preset.embedding)} produces ${dimension}-dimensional vectors`);
  } else if (vectorDimension) {
    console.log(`\n  ${c.dim(`Kept the configured vector dimension (${vectorDimension}).`)}`);
  }

  const decisionSection = section(existing, "decision");
  const decisionEnabled = readBoolean(decisionSection, "enabled") ?? false;
  const decision: DecisionChoice = decisionEnabled
    ? {
        enabled: true,
        baseUrl: readString(decisionSection, "baseUrl") ?? catalog.baseUrl,
        model: readString(decisionSection, "model") ?? DEFAULT_CONFIG.decision?.model ?? "tev1:4b",
        routeBeforeAsking: readBoolean(decisionSection, "routeBeforeAsking") ?? false,
      }
    : { enabled: false };

  const answers: WizardAnswers = {
    embedding: {
      provider: "ollama",
      baseUrl: catalog.baseUrl,
      model: preset.embedding,
      ...(vectorDimension ? { vectorDimension } : {}),
    },
    ...(preset.descriptionModel
      ? {
          description: {
            provider: "ollama",
            baseUrl: catalog.baseUrl,
            model: preset.descriptionModel,
          },
        }
      : {}),
    descriptionEnabled: Boolean(preset.descriptionModel),
    ...(preset.visionModel
      ? {
          imageDescription: {
            provider: "ollama",
            baseUrl: catalog.baseUrl,
            model: preset.visionModel,
          },
        }
      : {}),
    imageDescriptionEnabled: Boolean(preset.visionModel),
    decision,
    recommended: true,
  };
  return { kind: "answers", answers };
}

/**
 * Run the interactive wizard.
 *
 * @returns The collected answers, or `undefined` when the user cancelled or
 *   declined to apply the configuration.
 */
export async function runSetupWizard(options: WizardRunOptions): Promise<WizardAnswers | undefined> {
  const { prompter, existing } = options;
  const flags: WizardFlags = options;
  console.log(`\n${c.heading("OpenCodeRAG setup")}`);

  const recommended = await offerRecommendedSetup(prompter, options);
  if (recommended.kind === "cancel") return undefined;
  if (recommended.kind === "answers") return recommended.answers;

  console.log(`\n  ${c.dim("Answer the questions below. Enter accepts the value in [brackets].")}\n`);

  const primary = await askHost(prompter, {
    message: "Which provider hosts your models?",
    existing,
    flags,
    proxy: options.proxy,
    requireEmbedding: false,
  });
  if (!primary) return undefined;

  let embeddingHost = primary;
  if (!supportsEmbedding(primary.host.provider)) {
    console.log(`\n  ${c.warn(`${primary.host.provider} does not provide embeddings.`)} Choose a separate embedding host.`);
    const separate = await askHost(prompter, {
      message: "Embedding provider",
      existing: {},
      flags: { ...flags, provider: undefined, baseUrl: undefined, apiKey: undefined },
      proxy: options.proxy,
      requireEmbedding: true,
    });
    if (!separate) return undefined;
    embeddingHost = separate;
  }

  const embeddingModel = await pickModel(prompter, {
    message: "Embedding model",
    catalog: embeddingHost.catalog,
    capability: "embedding",
    defaultValue:
      flags.embeddingModel ??
      readString(section(existing, "embedding"), "model") ??
      DEFAULT_CONFIG.embedding.model,
  });
  if (embeddingModel === undefined) return undefined;

  const previousSection = section(existing, "embedding");
  const previousDimension = previousSection?.vectorDimension;
  const previousModel = readString(previousSection, "model");
  const previousProvider = readString(previousSection, "provider");
  const previousBaseUrl = readString(previousSection, "baseUrl");
  const unchangedTarget =
    typeof previousDimension === "number" &&
    previousModel === embeddingModel &&
    (previousProvider === undefined || previousProvider === embeddingHost.host.provider) &&
    (previousBaseUrl === undefined || previousBaseUrl === embeddingHost.host.baseUrl);

  let vectorDimension: number | undefined;
  if (embeddingHost.catalog.reachable) {
    vectorDimension = await probeEmbeddingDimension({
      provider: embeddingHost.host.provider,
      baseUrl: embeddingHost.host.baseUrl,
      model: embeddingModel,
      apiKey: embeddingHost.host.apiKey,
      proxy: options.proxy,
    });
    if (vectorDimension) {
      console.log(`  ${c.success("✓")} ${c.value(embeddingModel)} produces ${vectorDimension}-dimensional vectors`);
    } else if (unchangedTarget) {
      vectorDimension = previousDimension as number;
      console.log(`  ${c.dim(`Kept the configured vector dimension (${vectorDimension}).`)}`);
    } else {
      console.log(`  ${c.warn("Could not probe the vector dimension.")} It will be detected on the first index run.`);
    }
  } else if (unchangedTarget) {
    // Offline reconfigure of the same target: keep the known dimension.
    vectorDimension = previousDimension as number;
  }

  const embedding: EmbeddingChoice = {
    provider: embeddingHost.host.provider,
    baseUrl: embeddingHost.host.baseUrl,
    ...(embeddingHost.host.apiKey ? { apiKey: embeddingHost.host.apiKey } : {}),
    model: embeddingModel,
    ...(vectorDimension ? { vectorDimension } : {}),
  };

  // ── Chat host (shared by description and vision) ──
  const descriptionDefault =
    flags.description ??
    (flags.descriptionModel ? true : undefined) ??
    readBoolean(section(existing, "description"), "enabled") ??
    (supportsChat(primary.host.provider) ? (DEFAULT_CONFIG.description?.enabled ?? true) : false);
  const wantDescription = await prompter.confirm({
    message: "Generate LLM descriptions for indexed code chunks?",
    defaultValue: descriptionDefault,
  });
  if (wantDescription === undefined) return undefined;

  const visionDefault =
    flags.vision ??
    (flags.visionModel ? true : undefined) ??
    readBoolean(section(existing, "imageDescription"), "enabled") ??
    false;
  const wantVision = await prompter.confirm({
    message: "Describe images with a vision model?",
    defaultValue: visionDefault,
  });
  if (wantVision === undefined) return undefined;

  let chatHost = primary;
  if ((wantDescription || wantVision) && !supportsChat(primary.host.provider)) {
    console.log(`\n  ${c.warn(`${primary.host.provider} cannot serve chat completions.`)} Choose a chat/vision host.`);
    const separate = await askHost(prompter, {
      message: "Chat/vision provider",
      existing: {},
      flags: { ...flags, provider: undefined, baseUrl: undefined, apiKey: undefined },
      proxy: options.proxy,
      requireChat: true,
    });
    if (!separate) return undefined;
    chatHost = separate;
  }

  let description: ChatChoice | undefined;
  if (wantDescription) {
    const model = await pickModel(prompter, {
      message: "Description model",
      catalog: chatHost.catalog,
      capability: "chat",
      defaultValue:
        flags.descriptionModel ??
        readString(section(existing, "description"), "model") ??
        DEFAULT_CONFIG.description?.model,
    });
    if (model === undefined) return undefined;
    description = {
      provider: chatHost.host.provider,
      baseUrl: chatHost.host.baseUrl,
      ...(chatHost.host.apiKey ? { apiKey: chatHost.host.apiKey } : {}),
      model,
    };
  }

  let imageDescription: ChatChoice | undefined;
  if (wantVision) {
    const model = await pickModel(prompter, {
      message: "Vision model",
      catalog: chatHost.catalog,
      capability: "vision",
      defaultValue:
        flags.visionModel ??
        readString(section(existing, "imageDescription"), "model") ??
        DEFAULT_CONFIG.imageDescription?.model,
    });
    if (model === undefined) return undefined;
    imageDescription = {
      provider: chatHost.host.provider,
      baseUrl: chatHost.host.baseUrl,
      ...(chatHost.host.apiKey ? { apiKey: chatHost.host.apiKey } : {}),
      model,
    };
  }

  // ── Decision model (Ollama only) ──
  const decisionSection = section(existing, "decision");
  const decisionDefault =
    flags.decision ??
    (flags.decisionModel ? true : undefined) ??
    readBoolean(decisionSection, "enabled") ??
    DEFAULT_CONFIG.decision?.enabled ??
    false;
  const wantDecision = await prompter.confirm({
    message: "Enable the local decision model (make_decision, tev1)?",
    defaultValue: decisionDefault,
  });
  if (wantDecision === undefined) return undefined;

  let decision: DecisionChoice | undefined;
  if (wantDecision) {
    const knownOllama = [primary, embeddingHost, chatHost].find((host) => host.host.provider === "ollama");
    let decisionBaseUrl =
      readString(decisionSection, "baseUrl") ??
      knownOllama?.host.baseUrl ??
      "http://127.0.0.1:11434/api";
    if (!knownOllama) {
      const typed = await prompter.text({
        message: "Ollama base URL for the decision model",
        defaultValue: decisionBaseUrl,
        hint: "tev1 requires Ollama >= 0.35 and `ollama pull tev1:0.8b`",
      });
      if (typed === undefined) return undefined;
      decisionBaseUrl = typed;
    }
    const decisionModel = await prompter.select<string>({
      message: "Decision model",
      options: [
        { label: "tev1:0.8b", value: "tev1:0.8b", description: "Fastest, good default" },
        { label: "tev1:4b", value: "tev1:4b", description: "More accurate, slower" },
        { label: "tev1", value: "tev1", description: "Whichever tag is pulled" },
        { label: "Type a model name…", value: "__custom__" },
      ],
      defaultIndex: 0,
    });
    if (decisionModel === undefined) return undefined;
    let resolvedDecisionModel = decisionModel;
    if (decisionModel === "__custom__") {
      const typed = await prompter.text({
        message: "Decision model",
        defaultValue: flags.decisionModel ?? readString(decisionSection, "model") ?? "tev1:0.8b",
      });
      if (typed === undefined) return undefined;
      resolvedDecisionModel = typed;
    }
    const routeBeforeAsking = await prompter.confirm({
      message: "Let the agent route choices through make_decision before asking you?",
      defaultValue: readBoolean(decisionSection, "routeBeforeAsking") ?? false,
    });
    if (routeBeforeAsking === undefined) return undefined;
    decision = {
      enabled: true,
      baseUrl: ollamaRoot(decisionBaseUrl) + "/api",
      model: resolvedDecisionModel,
      routeBeforeAsking,
    };
  } else {
    decision = { enabled: false };
  }

  // ── Advanced options ──
  const advancedFlagsSet =
    flags.reranking !== undefined ||
    flags.shellGuard !== undefined ||
    flags.memoryCapture !== undefined ||
    flags.vectorStore !== undefined;
  const advanced = advancedFlagsSet || await prompter.confirm({
    message: "Configure advanced options (reranking, shell guard, memory, vector store)?",
    defaultValue: false,
  });
  if (advanced === undefined) return undefined;
  const advancedAnswers = advanced ? await askAdvanced(prompter, existing, flags) : undefined;
  if (advancedAnswers === undefined && advanced) return undefined;

  const answers: WizardAnswers = {
    embedding,
    descriptionEnabled: wantDescription,
    imageDescriptionEnabled: wantVision,
    ...(description ? { description } : {}),
    ...(imageDescription ? { imageDescription } : {}),
    ...(decision ? { decision } : {}),
    ...(advancedAnswers ?? {}),
  };

  printSummary(answers);
  const apply = await prompter.confirm({ message: "Apply this configuration?", defaultValue: true });
  if (apply === undefined) return undefined;
  return apply ? answers : undefined;
}
