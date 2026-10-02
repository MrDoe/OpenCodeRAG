/**
 * @fileoverview Factory for rerank providers. Mirrors the embedder/describer
 * factory pattern: dispatch by config, return null when the feature is off.
 * `getRerankerFor` memoizes one provider per distinct configuration so the
 * failure cooldown and score cache survive across retrievals within a process.
 */
import type { RerankingConfig } from "../core/config.js";
import type { RerankProvider } from "../core/interfaces.js";
import { LlamaServerReranker } from "./llama-server.js";

/** Create a rerank provider from config, or null when reranking is disabled/unknown. */
export function createReranker(config?: RerankingConfig): RerankProvider | null {
  if (!config?.enabled) return null;

  const provider = config.provider ?? "llama-server";
  if (provider === "llama-server") {
    if (!config.baseUrl) {
      console.warn("[reranker] reranking.enabled is true but reranking.baseUrl is empty — reranking disabled");
      return null;
    }
    if (!config.model) {
      console.warn("[reranker] reranking.enabled is true but reranking.model is empty — reranking disabled");
      return null;
    }
    return new LlamaServerReranker(config);
  }

  console.warn(`[reranker] unknown reranking.provider "${provider}" — reranking disabled`);
  return null;
}

/** Distinct-provider cache bound so config churn cannot grow it unboundedly. */
const RERANKER_CACHE_MAX = 8;
const providerCache = new Map<string, RerankProvider | null>();

/**
 * Process-wide singleton lookup keyed by endpoint identity (provider|baseUrl|
 * model|apiKey). Disabled configs return null without caching; an empty
 * baseUrl/model returns a non-cached null so a later valid config still works.
 */
export function getRerankerFor(config?: RerankingConfig): RerankProvider | null {
  if (!config?.enabled) return null;
  if (!config.baseUrl || !config.model) return createReranker(config);

  const key = `${config.provider ?? "llama-server"}|${config.baseUrl}|${config.model}|${config.apiKey ?? ""}`;
  const cached = providerCache.get(key);
  if (cached !== undefined) return cached;

  const provider = createReranker(config);
  if (providerCache.size >= RERANKER_CACHE_MAX) {
    const oldest = providerCache.keys().next();
    if (!oldest.done) providerCache.delete(oldest.value);
  }
  providerCache.set(key, provider);
  return provider;
}
