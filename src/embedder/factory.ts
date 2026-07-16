/**
 * @fileoverview Factory for creating embedding providers and utility for batch-embedding texts with concurrency control.
 */
import type { EmbeddingProvider } from "../core/interfaces.js";
import type { RagConfig } from "../core/config.js";
import { isOpenAiCompatible } from "../core/provider-defaults.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAIProvider } from "./openai.js";
import { CohereProvider } from "./cohere.js";
import pLimit from "p-limit";

/**
 * Create an embedding provider instance based on the application configuration.
 *
 * Dispatches to the correct provider class (Ollama, Cohere, or OpenAI-compatible)
 * depending on the `provider` field in `config.embedding`. Throws if the provider
 * is unknown or if a required API key is missing.
 *
 * @param config - Full application configuration, including embedding settings
 * @returns An initialized EmbeddingProvider instance
 * @throws If the provider is unsupported or a required apiKey is not set
 */
export function createEmbedder(config: RagConfig): EmbeddingProvider {
  const { provider, baseUrl, model, apiKey, proxy, timeoutMs } = config.embedding;
  const effectiveTimeoutMs = timeoutMs ?? 120000;

  if (provider === "ollama") {
    return new OllamaProvider(baseUrl, model, apiKey, effectiveTimeoutMs, proxy, config.logging.level);
  }

  if (provider === "cohere") {
    if (!apiKey) {
      throw new Error("Cohere provider requires an apiKey");
    }
    return new CohereProvider(baseUrl, model, apiKey, effectiveTimeoutMs, proxy);
  }

  if (isOpenAiCompatible(provider)) {
    if (!apiKey) {
      throw new Error(`${provider} provider requires an apiKey`);
    }
    return new OpenAIProvider(baseUrl, model, apiKey, effectiveTimeoutMs, proxy);
  }

  throw new Error(`Unknown embedding provider: ${provider}`);
}

/**
 * Embed a list of texts in batches with optional concurrency control.
 *
 * Splits the input texts into chunks of `batchSize` and embeds them sequentially
 * (or concurrently when `concurrency > 1`). When concurrency is limited, uses
 * `p-limit` to cap the number of in-flight requests.
 *
 * @param embedder - The embedding provider to use
 * @param texts - Array of text strings to embed
 * @param batchSize - Number of texts per batch (default 10)
 * @param purpose - Optional hint for query vs. document embedding
 * @param concurrency - Maximum number of concurrent batch requests (default 1)
 * @param onProgress - Optional callback invoked after each batch with the running
 *   completed count and total; per-text granularity when `concurrency <= 1`.
 * @returns A promise resolving to a flat array of embedding vectors (one per input text)
 */
export async function embedBatch(
  embedder: EmbeddingProvider,
  texts: string[],
  batchSize: number = 10,
  purpose?: "query" | "document",
  concurrency: number = 1,
  onProgress?: (completed: number, total: number) => void,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const batches: { index: number; texts: string[] }[] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    batches.push({ index: i, texts: texts.slice(i, i + batchSize) });
  }

  if (concurrency <= 1 || batches.length <= 1) {
    const results: number[][] = [];
    for (const batch of batches) {
      const embeddings = await embedder.embed(batch.texts, purpose);
      results.push(...embeddings);
      onProgress?.(results.length, texts.length);
    }
    return results;
  }

  const limit = pLimit(concurrency);
  let completedCount = 0;
  const batchResults = await Promise.all(
    batches.map((batch) =>
      limit(async () => {
        const embeddings = await embedder.embed(batch.texts, purpose);
        completedCount += embeddings.length;
        onProgress?.(completedCount, texts.length);
        return { index: batch.index, embeddings };
      }),
    ),
  );

  batchResults.sort((a, b) => a.index - b.index);
  const results: number[][] = [];
  for (const { embeddings } of batchResults) {
    results.push(...embeddings);
  }
  return results;
}
