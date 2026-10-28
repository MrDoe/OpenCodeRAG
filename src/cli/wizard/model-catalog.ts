/**
 * @fileoverview Model discovery for the `setup` wizard.
 *
 * The wizard offers model pickers instead of asking the user to type names
 * from memory. Discovery is provider-specific:
 *
 * - Ollama: `GET /api/tags` for the list, `POST /api/show` for per-model
 *   capabilities (`embedding`, `vision`, `completion`).
 * - OpenAI-compatible providers: `GET /v1/models` (ids only, so capability is
 *   inferred from the model name).
 * - Cohere: `GET /v1/models` (endpoints include `embed` / `chat`).
 * - Anthropic / Google: `GET /v1/models`, chat/vision only (no embedding API).
 *
 * Everything is best-effort: an unreachable host returns `reachable: false`
 * and the wizard falls back to manual model entry. No call throws.
 */

import { fetchWithProxy, postJson } from "../../embedder/http.js";
import type { ProxyConfig } from "../../core/config.js";

/** Capability buckets the wizard asks for. */
export type ModelCapability = "embedding" | "chat" | "vision";

/** A model discovered on the configured host. */
export interface ModelInfo {
  /** Model identifier as the provider expects it (e.g. `qwen3-embedding:0.6b`). */
  id: string;
  /** Capabilities the provider reported, or inferred from the name when unknown. */
  capabilities: ModelCapability[];
  /** Optional provider detail such as parameter size or family. */
  detail?: string;
}

/** Result of probing a model host. */
export interface ModelCatalog {
  /** Provider id (`ollama`, `openai`, `cohere`, …). */
  provider: string;
  /** Base URL as it should be written into the config (Ollama keeps `/api`). */
  baseUrl: string;
  /** Whether the host answered the list request. */
  reachable: boolean;
  /** Human-readable failure reason when `reachable` is false. */
  error?: string;
  /** Discovered models (possibly empty). */
  models: ModelInfo[];
}

/** Request timeout for discovery calls. Kept short so setup stays snappy. */
const LIST_TIMEOUT_MS = 6_000;
/** Total budget for the per-model Ollama capability probes. */
const CAPABILITY_BUDGET_MS = 5_000;
/** Parallel `/api/show` requests. */
const CAPABILITY_CONCURRENCY = 8;

/**
 * Normalize an Ollama base URL to the API root (`http://host:port`).
 *
 * The config convention is `…/api` because the health checks append `/embed`
 * and `/chat`; the discovery endpoints live at the root (`/api/tags`).
 */
export function ollamaRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/(api|v1)$/i, "");
}

/** Normalize an OpenAI-compatible base URL (`…/v1`). */
export function openAiBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** Build the auth header for a provider, when it needs one. */
function authHeaders(provider: string, apiKey?: string): Record<string, string> {
  if (!apiKey) return {};
  if (provider === "anthropic") {
    return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

/** Name heuristics used when the provider does not report capabilities. */
const EMBEDDING_NAME = /(embed|bge[-_]|e5[-_]|gte[-_]|jina|nomic|mxbai|text-embedding|voyage)/i;
const VISION_NAME = /(vision|llava|vl[-_]|minicpm[-_]v|pixtral|molmo|idefics|internvl|gpt-4o|gpt-4\.1|claude|gemini|gemma3)/i;
const NON_CHAT_NAME = /(whisper|tts|rerank|moderation|dall-e|stable-diffusion|flux|clip)/i;

/** Infer capabilities from a model id when the provider reports none. */
export function inferCapabilities(id: string): ModelCapability[] {
  const capabilities: ModelCapability[] = [];
  if (EMBEDDING_NAME.test(id)) {
    capabilities.push("embedding");
  }
  if (!EMBEDDING_NAME.test(id) && !NON_CHAT_NAME.test(id)) {
    capabilities.push("chat");
  }
  if (VISION_NAME.test(id) && !EMBEDDING_NAME.test(id)) {
    capabilities.push("vision");
  }
  return capabilities;
}

/** GET JSON with a bounded timeout and proxy support. Returns `undefined` on failure. */
async function getJson(
  url: string,
  headers: Record<string, string>,
  proxy?: ProxyConfig,
): Promise<unknown> {
  try {
    const response = await fetchWithProxy(
      url,
      { method: "GET", headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) },
      proxy,
    );
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

/** Extract a human-readable error from a failed list call (best-effort). */
async function describeListFailure(
  url: string,
  headers: Record<string, string>,
  proxy?: ProxyConfig,
): Promise<string> {
  try {
    const response = await fetchWithProxy(
      url,
      { method: "GET", headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) },
      proxy,
    );
    if (response.ok) return "The model list endpoint returned an unexpected response.";
    if (response.status === 401 || response.status === 403) {
      return `HTTP ${response.status}: authentication failed — check the API key.`;
    }
    return `HTTP ${response.status} from ${url}`;
  } catch (err) {
    const message = (err as Error).message || String(err);
    if (/ECONNREFUSED|fetch failed|connect/i.test(message)) {
      return `Cannot reach ${url} — is the server running?`;
    }
    return message.slice(0, 200);
  }
}

/** Read an array-valued property from an unknown JSON object. */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Read a string property from an unknown record. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read a record property from an unknown value. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Probe Ollama model capabilities with `POST /api/show`.
 *
 * Runs with bounded concurrency and a hard total budget so a slow remote host
 * cannot stall setup. Models whose probe did not finish keep name-inferred
 * capabilities.
 */
async function probeOllamaCapabilities(
  root: string,
  models: ModelInfo[],
  apiKey: string | undefined,
  proxy: ProxyConfig | undefined,
): Promise<void> {
  const deadline = Date.now() + CAPABILITY_BUDGET_MS;
  const headers = authHeaders("ollama", apiKey);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (Date.now() > deadline) return;
      const index = cursor;
      cursor += 1;
      const model = models[index];
      if (!model) return;
      try {
        const response = await postJson(
          `${root}/api/show`,
          { model: model.id },
          headers,
          Math.min(LIST_TIMEOUT_MS, Math.max(1_000, deadline - Date.now())),
          proxy,
        );
        if (!response.ok) continue;
        const body = asRecord(await response.json());
        const reported = asArray(body?.capabilities).filter(
          (value): value is string => typeof value === "string",
        );
        if (reported.length > 0) {
          const capabilities: ModelCapability[] = [];
          if (reported.includes("embedding")) capabilities.push("embedding");
          if (reported.includes("completion") || reported.includes("tools")) capabilities.push("chat");
          if (reported.includes("vision")) {
            capabilities.push("vision");
            if (!capabilities.includes("chat")) capabilities.push("chat");
          }
          if (capabilities.length > 0) model.capabilities = capabilities;
        }
        const details = asRecord(body?.details);
        const family = asString(details?.family);
        const parameterSize = asString(details?.parameter_size);
        if (family && parameterSize) model.detail = `${family} · ${parameterSize}`;
        else if (family) model.detail = family;
      } catch {
        // Probe is optional — keep inferred capabilities.
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CAPABILITY_CONCURRENCY, models.length) }, () => worker()),
  );
}

/** Discover Ollama models. */
async function fetchOllamaCatalog(
  baseUrl: string,
  apiKey: string | undefined,
  proxy: ProxyConfig | undefined,
): Promise<ModelCatalog> {
  const root = ollamaRoot(baseUrl);
  const configBaseUrl = /\/api$/i.test(baseUrl.replace(/\/+$/, ""))
    ? baseUrl.replace(/\/+$/, "")
    : /\/v1$/i.test(baseUrl.replace(/\/+$/, ""))
      ? `${root}/api`
      : `${root}/api`;
  const headers = authHeaders("ollama", apiKey);
  const body = asRecord(await getJson(`${root}/api/tags`, headers, proxy));
  if (!body) {
    return {
      provider: "ollama",
      baseUrl: configBaseUrl,
      reachable: false,
      error: await describeListFailure(`${root}/api/tags`, headers, proxy),
      models: [],
    };
  }

  const models: ModelInfo[] = [];
  for (const entry of asArray(body.models)) {
    const record = asRecord(entry);
    const id = asString(record?.name) ?? asString(record?.model);
    if (!id) continue;
    if (models.some((model) => model.id === id)) continue;
    const details = asRecord(record?.details);
    const family = asString(details?.family);
    const parameterSize = asString(details?.parameter_size);
    models.push({
      id,
      capabilities: inferCapabilities(id),
      ...(family || parameterSize
        ? { detail: [family, parameterSize].filter(Boolean).join(" · ") }
        : {}),
    });
  }

  await probeOllamaCapabilities(root, models, apiKey, proxy);
  return { provider: "ollama", baseUrl: configBaseUrl, reachable: true, models };
}

/** Discover OpenAI-compatible models (`GET {baseUrl}/models`). */
async function fetchOpenAiCatalog(
  baseUrl: string,
  provider: string,
  apiKey: string | undefined,
  proxy: ProxyConfig | undefined,
): Promise<ModelCatalog> {
  const base = openAiBase(baseUrl);
  const url = `${base}/models`;
  const headers = authHeaders(provider, apiKey);
  const body = asRecord(await getJson(url, headers, proxy));
  if (!body) {
    return {
      provider,
      baseUrl: base,
      reachable: false,
      error: await describeListFailure(url, headers, proxy),
      models: [],
    };
  }

  const models: ModelInfo[] = [];
  for (const entry of asArray(body.data)) {
    const record = asRecord(entry);
    const id = asString(record?.id);
    if (!id || models.some((model) => model.id === id)) continue;
    models.push({ id, capabilities: inferCapabilities(id) });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return { provider, baseUrl: base, reachable: true, models };
}

/** Discover Cohere models (`GET {baseUrl}/models`, endpoints carry capabilities). */
async function fetchCohereCatalog(
  baseUrl: string,
  apiKey: string | undefined,
  proxy: ProxyConfig | undefined,
): Promise<ModelCatalog> {
  const base = openAiBase(baseUrl);
  const url = `${base}/models`;
  const headers = authHeaders("cohere", apiKey);
  const body = asRecord(await getJson(url, headers, proxy));
  if (!body) {
    return {
      provider: "cohere",
      baseUrl: base,
      reachable: false,
      error: await describeListFailure(url, headers, proxy),
      models: [],
    };
  }

  const models: ModelInfo[] = [];
  for (const entry of asArray(body.models)) {
    const record = asRecord(entry);
    const id = asString(record?.name);
    if (!id || models.some((model) => model.id === id)) continue;
    const endpoints = asArray(record?.endpoints)
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.toLowerCase());
    const capabilities: ModelCapability[] = [];
    if (endpoints.includes("embed") || inferCapabilities(id).includes("embedding")) {
      capabilities.push("embedding");
    }
    if (endpoints.includes("chat") || endpoints.includes("generate")) {
      capabilities.push("chat");
    }
    if (capabilities.length === 0) capabilities.push(...inferCapabilities(id));
    models.push({ id, capabilities });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return { provider: "cohere", baseUrl: base, reachable: true, models };
}

/** Discover Anthropic models (`GET {baseUrl}/models`, chat + vision). */
async function fetchAnthropicCatalog(
  baseUrl: string,
  apiKey: string | undefined,
  proxy: ProxyConfig | undefined,
): Promise<ModelCatalog> {
  const base = openAiBase(baseUrl);
  const url = `${base}/models`;
  const headers = authHeaders("anthropic", apiKey);
  const body = asRecord(await getJson(url, headers, proxy));
  if (!body) {
    return {
      provider: "anthropic",
      baseUrl: base,
      reachable: false,
      error: await describeListFailure(url, headers, proxy),
      models: [],
    };
  }
  const models: ModelInfo[] = [];
  for (const entry of asArray(body.data)) {
    const record = asRecord(entry);
    const id = asString(record?.id);
    if (!id || models.some((model) => model.id === id)) continue;
    models.push({ id, capabilities: ["chat", "vision"] });
  }
  return { provider: "anthropic", baseUrl: base, reachable: true, models };
}

/** Discover Google models (`GET {baseUrl}/models?key=...`). */
async function fetchGoogleCatalog(
  baseUrl: string,
  apiKey: string | undefined,
  proxy: ProxyConfig | undefined,
): Promise<ModelCatalog> {
  const base = openAiBase(baseUrl);
  const url = apiKey ? `${base}/models?key=${encodeURIComponent(apiKey)}` : `${base}/models`;
  const body = asRecord(await getJson(url, {}, proxy));
  if (!body) {
    return {
      provider: "google",
      baseUrl: base,
      reachable: false,
      error: await describeListFailure(url, {}, proxy),
      models: [],
    };
  }
  const models: ModelInfo[] = [];
  for (const entry of asArray(body.models)) {
    const record = asRecord(entry);
    const rawName = asString(record?.name);
    if (!rawName) continue;
    const id = rawName.replace(/^models\//, "");
    if (models.some((model) => model.id === id)) continue;
    const methods = asArray(record?.supportedGenerationMethods)
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.toLowerCase());
    const capabilities: ModelCapability[] = [];
    if (methods.includes("embedcontent")) capabilities.push("embedding");
    if (methods.includes("generatecontent")) {
      capabilities.push("chat");
      if (VISION_NAME.test(id)) capabilities.push("vision");
    }
    if (capabilities.length === 0) capabilities.push(...inferCapabilities(id));
    models.push({ id, capabilities });
  }
  return { provider: "google", baseUrl: base, reachable: true, models };
}

/**
 * Discover the models available on a host.
 *
 * Never throws: a failed probe returns `reachable: false` plus an error that
 * the wizard prints before falling back to manual entry.
 */
export async function fetchModelCatalog(options: {
  provider: string;
  baseUrl: string;
  apiKey?: string;
  proxy?: ProxyConfig;
}): Promise<ModelCatalog> {
  const { provider, baseUrl, apiKey, proxy } = options;
  if (!baseUrl.trim()) {
    return {
      provider,
      baseUrl,
      reachable: false,
      error: "No base URL configured.",
      models: [],
    };
  }
  if (provider === "ollama") return fetchOllamaCatalog(baseUrl, apiKey, proxy);
  if (provider === "cohere") return fetchCohereCatalog(baseUrl, apiKey, proxy);
  if (provider === "anthropic") return fetchAnthropicCatalog(baseUrl, apiKey, proxy);
  if (provider === "google") return fetchGoogleCatalog(baseUrl, apiKey, proxy);
  return fetchOpenAiCatalog(baseUrl, provider, apiKey, proxy);
}

/**
 * Probe an embedding model and return its vector dimension.
 *
 * This is what keeps `vectorDimension` honest: writing the wrong dimension
 * makes LanceDB silently pad/truncate embeddings and the store unreachable.
 * Returns `undefined` when the probe fails (the wizard then omits the value
 * and the runtime probe decides).
 */
export async function probeEmbeddingDimension(options: {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  proxy?: ProxyConfig;
  timeoutMs?: number;
}): Promise<number | undefined> {
  const { provider, baseUrl, model, apiKey, proxy, timeoutMs = 15_000 } = options;
  const headers = authHeaders(provider, apiKey);
  const text = "dimension probe";

  const readLength = (value: unknown): number | undefined => {
    const arrays = asArray(value);
    const first = asArray(arrays[0]);
    return first.length > 0 ? first.length : undefined;
  };

  try {
    if (provider === "cohere") {
      const response = await postJson(
        `${openAiBase(baseUrl)}/embed`,
        { model, texts: [text], input_type: "search_document" },
        headers,
        timeoutMs,
        proxy,
      );
      if (!response.ok) return undefined;
      return readLength(asRecord(await response.json())?.embeddings);
    }

    if (provider === "ollama") {
      const root = ollamaRoot(baseUrl);
      const response = await postJson(
        `${root}/api/embed`,
        { model, input: [text] },
        headers,
        timeoutMs,
        proxy,
      );
      if (response.ok) {
        return readLength(asRecord(await response.json())?.embeddings);
      }
      // Some Ollama builds only expose the OpenAI-compatible endpoint.
      const fallback = await postJson(
        `${root}/v1/embeddings`,
        { model, input: [text] },
        headers,
        timeoutMs,
        proxy,
      );
      if (!fallback.ok) return undefined;
      const body = asRecord(await fallback.json());
      const data = asRecord(asArray(body?.data)[0]);
      const embedding = asArray(data?.embedding);
      return embedding.length > 0 ? embedding.length : undefined;
    }

    if (provider === "anthropic" || provider === "google") return undefined;

    const response = await postJson(
      `${openAiBase(baseUrl)}/embeddings`,
      { model, input: [text] },
      headers,
      timeoutMs,
      proxy,
    );
    if (!response.ok) return undefined;
    const body = asRecord(await response.json());
    const data = asRecord(asArray(body?.data)[0]);
    const embedding = asArray(data?.embedding);
    return embedding.length > 0 ? embedding.length : undefined;
  } catch {
    return undefined;
  }
}
