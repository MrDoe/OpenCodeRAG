/**
 * @fileoverview Auto-detect the Ollama backend (CPU vs GPU) during `init` and
 * pick embedding batch settings tuned for the detected backend.
 */
/**
 * Auto-detect whether Ollama runs models on the GPU or on the CPU and return
 * matching embedding batch tuning.
 *
 * Detection uses `GET /api/ps`: loaded models report `size_vram` (bytes
 * resident in VRAM). `size_vram > 0` means the model is (at least partially)
 * offloaded to the GPU. If no model is loaded yet, a minimal `/api/embed`
 * warmup loads the default embedding model first.
 *
 * Tuning is derived from benchmarks (see quirk memory):
 * - GPU:  batch 40 + concurrency 4 ≈ 86 texts/s (~97% of the ~88 texts/s ceiling)
 * - CPU:  flat ~3.5 texts/s regardless of batch size → small batches (20) with
 *         concurrency 1 keep each request fast and under the 4096-token context
 * - unreachable/unknown: defaults (100 / 3 / 100)
 */

import { DEFAULT_CONFIG, type ProxyConfig } from "../../core/config.js";
import { fetchWithProxy, postJson } from "../../embedder/http.js";

/** Detected Ollama backend kind. */
export type OllamaBackend = "gpu" | "cpu" | "unreachable" | "unknown";

/** Embedding batch settings written into the generated config. */
export interface IndexingTuning {
  embedBatchSize: number;
  embedConcurrency: number;
  ollamaMaxBatchSize: number;
}

/** Result of the backend detection. */
export interface OllamaBackendInfo {
  backend: OllamaBackend;
  /** Tuning to write into the generated config. */
  tuning: IndexingTuning;
  /** Human-readable summary for the init output. */
  message: string;
}

/** Benchmarked optimum on a GPU-backed Ollama (RTX 4090, qwen3-embedding:0.6b). */
const GPU_TUNING: IndexingTuning = {
  embedBatchSize: 40,
  embedConcurrency: 4,
  ollamaMaxBatchSize: 40,
};

/** CPU-backed Ollama: throughput is flat, so keep batches small and sequential. */
const CPU_TUNING: IndexingTuning = {
  embedBatchSize: 20,
  embedConcurrency: 1,
  ollamaMaxBatchSize: 20,
};

/** Fallback when Ollama is unreachable or the backend cannot be determined. */
const DEFAULT_TUNING: IndexingTuning = {
  embedBatchSize: DEFAULT_CONFIG.indexing.embedBatchSize,
  embedConcurrency: DEFAULT_CONFIG.indexing.embedConcurrency ?? 3,
  ollamaMaxBatchSize: DEFAULT_CONFIG.indexing.ollamaMaxBatchSize ?? 100,
};

interface PsModel {
  name: string;
  size_vram?: number;
}

/**
 * Classify loaded Ollama models into a backend + tuning profile.
 *
 * Prefers the configured default embedding model when it is loaded, falling
 * back to any loaded model (a loaded GPU model means the host has a working
 * GPU that Ollama will also use for embeddings).
 *
 * @param models - The `models` array from `GET /api/ps`.
 * @returns The backend info with the matching tuning profile.
 */
export function classifyOllamaModels(models: PsModel[]): OllamaBackendInfo {
  if (!models || models.length === 0) {
    return {
      backend: "unknown",
      tuning: DEFAULT_TUNING,
      message: "Could not determine the Ollama backend (no models loaded) — using default batch settings.",
    };
  }

  const embedModel = DEFAULT_CONFIG.embedding.model;
  const probe = models.find((m) => m.name === embedModel) ?? models[0];
  const onGpu = probe ? (probe.size_vram ?? 0) > 0 : false;

  if (onGpu) {
    return {
      backend: "gpu",
      tuning: GPU_TUNING,
      message: `Ollama detected on GPU — tuned embedding for batch 40 / concurrency 4 (${(probe?.size_vram ?? 0) / (1024 * 1024) | 0} MiB in VRAM).`,
    };
  }

  return {
    backend: "cpu",
    tuning: CPU_TUNING,
    message: "Ollama detected on CPU — tuned embedding for batch 20 / concurrency 1.",
  };
}

/** Fetch `GET /api/ps`, returning null when Ollama is unreachable or errors. */
async function getOllamaPs(
  baseUrl: string,
  proxy?: ProxyConfig,
): Promise<PsModel[] | null> {
  const url = `${baseUrl.replace(/\/+$/, "")}/ps`;
  try {
    const res = await fetchWithProxy(
      url,
      { method: "GET", signal: AbortSignal.timeout(3000) },
      proxy,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: PsModel[] };
    return data.models ?? null;
  } catch {
    return null;
  }
}

/**
 * Detect the Ollama backend by probing `/api/ps`, warming up the default
 * embedding model when nothing is loaded yet.
 *
 * @param baseUrl - Ollama API base URL (defaults to the config default).
 * @param proxy - Optional proxy configuration.
 * @returns Backend info; never throws.
 */
export async function detectOllamaBackend(
  baseUrl: string = DEFAULT_CONFIG.embedding.baseUrl,
  proxy?: ProxyConfig,
): Promise<OllamaBackendInfo> {
  let models = await getOllamaPs(baseUrl, proxy);
  if (models === null) {
    return {
      backend: "unreachable",
      tuning: DEFAULT_TUNING,
      message: "Ollama not reachable — using default batch settings.",
    };
  }

  if (models.length === 0) {
    // Nothing loaded yet: a minimal embed request loads the default
    // embedding model so /api/ps can report its backend.
    const embedUrl = `${baseUrl.replace(/\/+$/, "")}/embed`;
    try {
      await postJson(
        embedUrl,
        { model: DEFAULT_CONFIG.embedding.model, input: "warmup" },
        {},
        15000,
        proxy,
      );
    } catch {
      // Model missing or request failed — classification will stay unknown.
    }
    models = (await getOllamaPs(baseUrl, proxy)) ?? [];
  }

  return classifyOllamaModels(models);
}
