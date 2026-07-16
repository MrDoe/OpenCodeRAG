/**
 * @fileoverview Provider health checks (embedding, description, image description) and Ollama model pull utility.
 */
import type { RagConfig } from "../core/config.js";
import type { ProxyConfig } from "../core/config.js";
import { postJson } from "./http.js";

/** Result of a single provider health check. */
export interface HealthCheckResult {
  /** Provider name (e.g. "ollama", "openai", "cohere") */
  provider: string;
  /** Model identifier that was tested */
  model: string;
  /** Which capability was checked */
  type: "embedding" | "description" | "image_description";
  /** Whether the provider is reachable and the model is available */
  status: "ok" | "missing" | "error";
  /** Human-readable error message when status is not "ok" */
  error?: string;
}

/**
 * Check connectivity and model availability for all configured providers.
 * Returns one result per configured model (embedding + description + image_description if enabled).
 */
export async function checkProviderHealth(config: RagConfig): Promise<HealthCheckResult[]> {
  const timeoutMs = config.embedding.timeoutMs ?? 120000;

  const checks: Promise<HealthCheckResult>[] = [
    checkEmbeddingModel(config, timeoutMs),
  ];

  if (config.description?.enabled) {
    checks.push(checkDescriptionModel(config, timeoutMs));
  }

  if (config.imageDescription?.enabled) {
    checks.push(checkImageDescriptionModel(config, timeoutMs));
  }

  return Promise.all(checks);
}

/** Dispatch the embedding-model check to the correct provider-specific handler. */
async function checkEmbeddingModel(config: RagConfig, timeoutMs: number): Promise<HealthCheckResult> {
  const { provider, baseUrl, model, apiKey, proxy } = config.embedding;

  if (provider === "ollama") {
    return checkOllamaEmbed(baseUrl, model, timeoutMs, proxy);
  }

  if (provider === "cohere") {
    return checkCohereEmbed(baseUrl, model, apiKey, timeoutMs, proxy);
  }

  if (isOpenAiCompatible(provider)) {
    return checkOpenAiEmbed(baseUrl, model, apiKey, timeoutMs, proxy);
  }

  return { provider, model, type: "embedding", status: "error", error: `Unknown provider: ${provider}` };
}

/** Dispatch the description-model check to the correct provider-specific handler. */
async function checkDescriptionModel(config: RagConfig, _timeoutMs: number): Promise<HealthCheckResult> {
  const desc = config.description;
  if (!desc) {
    return { provider: "unknown", model: "unknown", type: "description", status: "error", error: "Description config is undefined" };
  }
  const { provider, baseUrl, model, apiKey } = desc;
  const descTimeout = desc.timeoutMs ?? 60000;

  if (provider === "ollama") {
    return checkOllamaChat(baseUrl, model, descTimeout, desc.proxy);
  }

  if (provider === "anthropic") {
    return checkAnthropicChat(baseUrl, model, apiKey, descTimeout);
  }

  if (provider === "google") {
    return checkGoogleChat(baseUrl, model, apiKey, descTimeout);
  }

  // OpenAI-compatible chat endpoint
  return checkOpenAiChat(baseUrl, model, apiKey, descTimeout, desc.proxy);
}

/** Dispatch the image-description model check to the correct provider-specific handler. */
async function checkImageDescriptionModel(config: RagConfig, _timeoutMs: number): Promise<HealthCheckResult> {
  const img = config.imageDescription;
  if (!img) {
    return { provider: "unknown", model: "unknown", type: "image_description", status: "error", error: "Image description config is undefined" };
  }
  const { provider, baseUrl, model, apiKey } = img;
  const imgTimeout = img.timeoutMs ?? 60000;

  if (provider === "ollama") {
    return checkOllamaChat(baseUrl, model, imgTimeout, img.proxy, "image_description");
  }

  if (provider === "anthropic") {
    return checkAnthropicChat(baseUrl, model, apiKey, imgTimeout, "image_description");
  }

  if (provider === "google") {
    return checkGoogleChat(baseUrl, model, apiKey, imgTimeout, "image_description");
  }

  // OpenAI-compatible chat endpoint
  return checkOpenAiChat(baseUrl, model, apiKey, imgTimeout, img.proxy, "image_description");
}

/** Check whether a provider name matches a known OpenAI-compatible provider. */
function isOpenAiCompatible(provider: string): boolean {
  const openaiCompatible = new Set(["openai", "nvidia", "azure", "mistral", "together", "fireworks"]);
  return openaiCompatible.has(provider);
}

// ── Ollama checks ──────────────────────────────────────────────

/** Check Ollama embedding endpoint by sending a minimal health-check request. */
async function checkOllamaEmbed(
  baseUrl: string,
  model: string,
  timeoutMs: number,
  proxy?: RagConfig["embedding"]["proxy"]
): Promise<HealthCheckResult> {
  const url = `${baseUrl.replace(/\/+$/, "")}/embed`;
  try {
    const response = await postJson(
      url,
      { model, input: "health-check" },
      {},
      Math.min(timeoutMs, 15000),
      proxy
    );

    if (response.ok) {
      return { provider: "ollama", model, type: "embedding", status: "ok" };
    }

    const body = await response.text();
    if (isModelNotFoundError(body)) {
      return { provider: "ollama", model, type: "embedding", status: "missing" };
    }

    return { provider: "ollama", model, type: "embedding", status: "error", error: `HTTP ${response.status}: ${body.slice(0, 200)}` };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    if (isConnectionError(msg)) {
      return { provider: "ollama", model, type: "embedding", status: "error", error: "Connection refused. Is Ollama running?" };
    }
    return { provider: "ollama", model, type: "embedding", status: "error", error: msg.slice(0, 200) };
  }
}

/** Check Ollama chat endpoint by sending a minimal conversation. */
async function checkOllamaChat(
  baseUrl: string,
  model: string,
  timeoutMs: number,
  proxy?: { url?: string; username?: string; password?: string; noProxy?: string },
  type: "description" | "image_description" = "description"
): Promise<HealthCheckResult> {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat`;
  try {
    const response = await postJson(
      url,
      { model, messages: [{ role: "user", content: "hi" }], stream: false },
      {},
      Math.min(timeoutMs, 15000),
      proxy
    );

    if (response.ok) {
      return { provider: "ollama", model, type, status: "ok" };
    }

    const body = await response.text();
    if (isModelNotFoundError(body)) {
      return { provider: "ollama", model, type, status: "missing" };
    }

    return { provider: "ollama", model, type, status: "error", error: `HTTP ${response.status}: ${body.slice(0, 200)}` };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    if (isConnectionError(msg)) {
      return { provider: "ollama", model, type, status: "error", error: "Connection refused. Is Ollama running?" };
    }
    return { provider: "ollama", model, type, status: "error", error: msg.slice(0, 200) };
  }
}

// ── OpenAI-compatible checks ───────────────────────────────────

/**
 * Check OpenAI-compatible embedding endpoint via the /models endpoint
 * to validate the API key without consuming embedding tokens.
 */
async function checkOpenAiEmbed(
  baseUrl: string,
  model: string,
  apiKey?: string,
  timeoutMs?: number,
  _proxy?: RagConfig["embedding"]["proxy"]
): Promise<HealthCheckResult> {
  if (!apiKey) {
    return { provider: "openai", model, type: "embedding", status: "error", error: "No API key configured" };
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(Math.min(timeoutMs ?? 15000, 15000)),
    });

    if (response.ok) {
      return { provider: "openai", model, type: "embedding", status: "ok" };
    }

    if (response.status === 401 || response.status === 403) {
      return { provider: "openai", model, type: "embedding", status: "error", error: `Invalid API key (HTTP ${response.status})` };
    }

    const body = await response.text();
    return { provider: "openai", model, type: "embedding", status: "error", error: `HTTP ${response.status}: ${body.slice(0, 200)}` };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    return { provider: "openai", model, type: "embedding", status: "error", error: msg.slice(0, 200) };
  }
}

/** Check OpenAI-compatible chat endpoint via the /models endpoint. */
async function checkOpenAiChat(
  baseUrl: string,
  model: string,
  apiKey?: string,
  timeoutMs?: number,
  _proxy?: { url?: string; username?: string; password?: string; noProxy?: string },
  type: "description" | "image_description" = "description"
): Promise<HealthCheckResult> {
  if (!apiKey) {
    return { provider: "openai", model, type, status: "error", error: "No API key configured" };
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(Math.min(timeoutMs ?? 15000, 15000)),
    });

    if (response.ok) {
      return { provider: "openai", model, type, status: "ok" };
    }

    if (response.status === 401 || response.status === 403) {
      return { provider: "openai", model, type, status: "error", error: `Invalid API key (HTTP ${response.status})` };
    }

    const body = await response.text();
    return { provider: "openai", model, type, status: "error", error: `HTTP ${response.status}: ${body.slice(0, 200)}` };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    return { provider: "openai", model, type, status: "error", error: msg.slice(0, 200) };
  }
}

// ── Cohere check ───────────────────────────────────────────────

/** Check Cohere embedding endpoint by sending a minimal health-check request. */
async function checkCohereEmbed(
  baseUrl: string,
  model: string,
  apiKey?: string,
  timeoutMs?: number,
  proxy?: RagConfig["embedding"]["proxy"]
): Promise<HealthCheckResult> {
  if (!apiKey) {
    return { provider: "cohere", model, type: "embedding", status: "error", error: "No API key configured" };
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/embed`;
  try {
    const response = await postJson(
      url,
      { texts: ["health-check"], model, input_type: "search_document" },
      { Authorization: `Bearer ${apiKey}` },
      Math.min(timeoutMs ?? 15000, 15000),
      proxy
    );

    if (response.ok) {
      return { provider: "cohere", model, type: "embedding", status: "ok" };
    }

    const body = await response.text();
    return { provider: "cohere", model, type: "embedding", status: "error", error: `HTTP ${response.status}: ${body.slice(0, 200)}` };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    return { provider: "cohere", model, type: "embedding", status: "error", error: msg.slice(0, 200) };
  }
}

// ── Anthropic check ────────────────────────────────────────────

/** Check Anthropic chat endpoint by sending a minimal message. */
async function checkAnthropicChat(
  baseUrl: string,
  model: string,
  apiKey?: string,
  timeoutMs?: number,
  type: "description" | "image_description" = "description"
): Promise<HealthCheckResult> {
  if (!apiKey) {
    return { provider: "anthropic", model, type, status: "error", error: "No API key configured" };
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/messages`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(Math.min(timeoutMs ?? 15000, 15000)),
    });

    if (response.ok) {
      return { provider: "anthropic", model, type, status: "ok" };
    }

    if (response.status === 401 || response.status === 403) {
      return { provider: "anthropic", model, type, status: "error", error: `Invalid API key (HTTP ${response.status})` };
    }

    const body = await response.text();
    return { provider: "anthropic", model, type, status: "error", error: `HTTP ${response.status}: ${body.slice(0, 200)}` };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    return { provider: "anthropic", model, type, status: "error", error: msg.slice(0, 200) };
  }
}

// ── Google Gemini check ────────────────────────────────────────

/** Check Google Gemini chat endpoint by sending a minimal generateContent request. */
async function checkGoogleChat(
  baseUrl: string,
  model: string,
  apiKey?: string,
  timeoutMs?: number,
  type: "description" | "image_description" = "description"
): Promise<HealthCheckResult> {
  if (!apiKey) {
    return { provider: "google", model, type, status: "error", error: "No API key configured" };
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/models/${model}:generateContent?key=${apiKey}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "hi" }] }],
      }),
      signal: AbortSignal.timeout(Math.min(timeoutMs ?? 15000, 15000)),
    });

    if (response.ok) {
      return { provider: "google", model, type, status: "ok" };
    }

    if (response.status === 401 || response.status === 403) {
      return { provider: "google", model, type, status: "error", error: `Invalid API key (HTTP ${response.status})` };
    }

    const body = await response.text();
    return { provider: "google", model, type, status: "error", error: `HTTP ${response.status}: ${body.slice(0, 200)}` };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    return { provider: "google", model, type, status: "error", error: msg.slice(0, 200) };
  }
}

// ── Ollama model pull ──────────────────────────────────────────

/** A model entry to pull from an Ollama server. */
interface PullModelEntry {
  /** Model name (e.g. "nomic-embed-text") */
  model: string;
  /** Base URL of the Ollama server */
  baseUrl: string;
  /** Optional proxy configuration */
  proxy?: ProxyConfig;
}

/**
 * Pull missing Ollama models sequentially via the /api/pull HTTP endpoint.
 * Streams NDJSON progress and renders a progress bar via onProgress.
 */
export async function pullOllamaModels(
  models: PullModelEntry[],
  onProgress?: (model: string, line: string) => void
): Promise<void> {
  const PULL_TIMEOUT_MS = 600_000; // 10 minutes per model

  for (const entry of models) {
    const pullUrl = `${entry.baseUrl.replace(/\/+$/, "")}/pull`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PULL_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(pullUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: entry.model }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
      }

      if (!response.body) {
        throw new Error("Empty response body");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const status = JSON.parse(line) as {
                status?: string;
                completed?: number;
                total?: number;
              };
              if (onProgress) {
                if (status.completed != null && status.total != null && status.total > 0) {
                  const pct = Math.round((status.completed / status.total) * 100);
                  const mb = (status.completed / 1048576).toFixed(1);
                  const totalMb = (status.total / 1048576).toFixed(1);
                  onProgress(entry.model, `${status.status ?? "downloading"} ${pct}% (${mb}/${totalMb} MB)`);
                } else if (status.status) {
                  onProgress(entry.model, status.status);
                }
              }
            } catch {
              // Not JSON — pass raw line
              if (onProgress) {
                onProgress(entry.model, line.trim());
              }
            }
          }
        }
      } finally {
        try { await reader.cancel(); } catch {}
        reader.releaseLock();
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(`Pull timed out after ${PULL_TIMEOUT_MS / 1000}s: ${entry.model}`);
      }
      const msg = (err as Error).message || String(err);
      throw new Error(`Failed to pull ${entry.model}: ${msg}`);
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────

/** Check whether an error body indicates the model was not found. */
function isModelNotFoundError(body: string): boolean {
  const lower = body.toLowerCase();
  return (
    lower.includes("not found") ||
    lower.includes("does not exist") ||
    lower.includes("model") && lower.includes("not") && lower.includes("available")
  );
}

/** Check whether an error message indicates a TCP-level connection failure. */
function isConnectionError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("econnrefused") ||
    lower.includes("connection refused") ||
    lower.includes("connect econnrefused")
  );
}
