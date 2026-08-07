/**
 * @fileoverview Factory for creating embedding providers and utility for batch-embedding texts with concurrency control.
 */
import type { EmbeddingProvider } from "../core/interfaces.js";
import type { RagConfig } from "../core/config.js";
import { isOpenAiCompatible, supportsEmbedding } from "../core/provider-defaults.js";
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
  // Fail fast for chat-only providers (groq, deepseek, anthropic, google)
  // — proceeding would surface a cryptic failure at index time.
  if (!supportsEmbedding(provider)) {
    throw new Error(
      `Provider "${provider}" does not support embeddings. ` +
      "Use an embedding-capable provider (ollama, openai, cohere, nvidia, azure, mistral, together, fireworks).",
    );
  }

  if (provider === "ollama") {
    return new OllamaProvider(baseUrl, model, apiKey, effectiveTimeoutMs, proxy, config.logging.level, config.embedding.keepAlive);
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
 * HTTP statuses that indicate a permanent failure — retrying cannot help
 * (auth errors, bad requests, missing resources). Providers raise these as
 * Error objects whose messages contain the status code.
 */
const PERMANENT_STATUS_RE = /\(?(400|401|403|404|422)\)?/;

function isPermanentError(err: unknown): boolean {
  return PERMANENT_STATUS_RE.test(err instanceof Error ? err.message : String(err));
}

/**
 * Embed a list of texts in batches with optional concurrency control and per-batch retry.
 *
 * Splits the input texts into chunks of `batchSize` and embeds them sequentially
 * (or concurrently when `concurrency > 1`). When concurrency is limited, uses
 * `p-limit` to cap the number of in-flight requests.
 *
 * Each batch is retried up to `retryMax` times with exponential backoff (only
 * for transient failures — auth/validation errors are not retried). If all
 * retries are exhausted or the provider returns a mismatched embedding count,
 * the batch is skipped and empty arrays are returned for those texts so the
 * caller can still process successfully embedded batches.
 *
 * @param embedder - The embedding provider to use
 * @param texts - Array of text strings to embed
 * @param batchSize - Number of texts per batch (default 10)
 * @param purpose - Optional hint for query vs. document embedding
 * @param concurrency - Maximum number of concurrent batch requests (default 1)
 * @param onProgress - Optional callback invoked after each batch with the running
 *   completed count and total; per-text granularity when `concurrency <= 1`.
 * @param retryMax - Maximum retry attempts per batch (default 3)
 * @param retryBaseDelayMs - Base delay for exponential backoff (default 1000)
 * @returns A promise resolving to a flat array of embedding vectors (one per input text);
 *   failed batches return empty arrays
 */
export async function embedBatch(
  embedder: EmbeddingProvider,
  texts: string[],
  batchSize: number = 10,
  purpose?: "query" | "document",
  concurrency: number = 1,
  onProgress?: (completed: number, total: number) => void,
  retryMax: number = 3,
  retryBaseDelayMs: number = 1000,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const batches: { index: number; texts: string[] }[] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    batches.push({ index: i, texts: texts.slice(i, i + batchSize) });
  }

  async function embedWithRetry(batchTexts: string[]): Promise<number[][] | null> {
    for (let attempt = 0; attempt <= retryMax; attempt++) {
      try {
        const embeddings = await embedder.embed(batchTexts, purpose);
        // Validate the response shape: a count mismatch would silently attach
        // vectors to the wrong chunks downstream; a dimension mismatch would
        // poison the store. Treat both as a retryable batch failure.
        if (embeddings.length !== batchTexts.length) {
          throw new Error(
            `Embedding provider returned ${embeddings.length} vectors for ${batchTexts.length} texts`,
          );
        }
        const dims = new Set(embeddings.map((v) => v.length));
        if (dims.size > 1 || dims.has(0)) {
          throw new Error(
            `Embedding provider returned inconsistent vector dimensions: ${[...dims].join(", ")}`,
          );
        }
        return embeddings;
      } catch (err) {
        if (attempt < retryMax && !isPermanentError(err)) {
          const delay = retryBaseDelayMs * Math.pow(2, attempt) * (0.8 + Math.random() * 0.4);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else if (attempt >= retryMax || isPermanentError(err)) {
          return null;
        }
      }
    }
    return null;
  }

  if (concurrency <= 1 || batches.length <= 1) {
    const results: number[][] = [];
    for (const batch of batches) {
      const embeddings = await embedWithRetry(batch.texts);
      if (embeddings) {
        results.push(...embeddings);
      } else {
        for (let i = 0; i < batch.texts.length; i++) {
          results.push([]);
        }
      }
      onProgress?.(results.length, texts.length);
    }
    return results;
  }

  let completedCount = 0;
  const limit = pLimit(concurrency);
  const batchResults = await Promise.all(
    batches.map((batch) =>
      limit(async () => {
        const embeddings = await embedWithRetry(batch.texts);
        const flatResult = embeddings ?? batch.texts.map(() => []);
        // Count processed TEXTS (not returned vectors) so failed batches
        // still advance progress towards the total.
        completedCount += batch.texts.length;
        onProgress?.(completedCount, texts.length);
        return { index: batch.index, embeddings: flatResult };
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
