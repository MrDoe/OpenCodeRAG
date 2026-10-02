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
import path from "node:path";
import { appendDebugLog } from "../core/fileLogger.js";

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

/** Result of probing an embedding provider for its output dimension. */
export interface EmbeddingProbeResult {
  /** Detected vector dimension, or `undefined` when the probe failed. */
  dimension?: number;
  /** Error raised by the provider (or an empty response), when the probe failed. */
  error?: Error;
}

/**
 * Probe an embedding provider with a single short text to discover the
 * dimension of the vectors it produces.
 *
 * Used as a health/dimension preflight before expensive index work: a provider
 * that is down (server not running, model not pulled) fails here in
 * milliseconds instead of after chunking and describing every file. Errors are
 * captured in the result rather than thrown.
 *
 * @param embedder - The embedding provider to probe.
 * @returns The detected dimension, or the failure reason.
 */
export async function probeEmbeddingDimension(embedder: EmbeddingProvider): Promise<EmbeddingProbeResult> {
  try {
    const probe = await embedder.embed(["dimension-probe"], "query");
    if (probe && probe[0] && probe[0].length > 0 && typeof probe[0][0] === "number") {
      return { dimension: probe[0].length };
    }
    return { error: new Error("Embedding provider returned an empty probe vector") };
  } catch (err) {
    return { error: err instanceof Error ? err : new Error(String(err)) };
  }
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
 * Provider errors that mean the request exceeded the model context window.
 * llama.cpp rejects the WHOLE request when any single input is over the limit
 * (HTTP 400 exceed_context_size_error), so such batches are split and retried.
 */
const CONTEXT_LIMIT_RE = /exceed_context_size|exceeds the available context size/i;

function isContextLimitError(err: unknown): boolean {
  return CONTEXT_LIMIT_RE.test(err instanceof Error ? err.message : String(err));
}

/**
 * Provider request timeouts. The server usually keeps chewing on an oversized
 * input after the client gave up, so a timeout is the silent twin of a
 * context-limit rejection: without splitting, every healthy text in the batch
 * loses its vector too.
 */
const TIMEOUT_RE = /timed out|timeout/i;

function isTimeoutError(err: unknown): boolean {
  return TIMEOUT_RE.test(err instanceof Error ? err.message : String(err));
}

/** Resolve the workspace debug log file used for batch failure diagnostics. */
function getBatchLogFilePath(): string {
  return path.resolve(process.cwd(), ".opencode", "opencode-rag.log");
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
 * caller can still process successfully embedded batches. Failures are logged
 * to the workspace debug log (scope `embedder.batch`); batches that fail for a
 * non-permanent reason (provider context limit, request timeout, count or
 * dimension mismatch) are split in half and retried recursively down to single
 * texts, so one oversized or slow text cannot discard its healthy siblings.
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

  // `depth` counts split levels: the top-level batch gets the full retry
  // budget, every sub-batch only a single attempt — otherwise one slow text
  // would multiply its retries across the whole split tree and stall the pass.
  async function embedWithRetry(batchTexts: string[], depth = 0): Promise<number[][] | null> {
    const maxRetries = depth === 0 ? retryMax : Math.min(1, retryMax);
    let lastError: unknown;
    let attempts = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      attempts = attempt + 1;
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
        lastError = err;
        if (attempt < maxRetries && !isPermanentError(err)) {
          const delay = retryBaseDelayMs * Math.pow(2, attempt) * (0.8 + Math.random() * 0.4);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else if (attempt >= maxRetries || isPermanentError(err)) {
          break;
        }
      }
    }

    const longestText = batchTexts.reduce((max, text) => Math.max(max, text.length), 0);
    appendDebugLog(getBatchLogFilePath(), {
      scope: "embedder.batch",
      severity: "warn",
      message:
        `Embedding batch failed after ${attempts} attempt(s) ` +
        `(${batchTexts.length} text(s), longest ${longestText} chars): ` +
        `${lastError instanceof Error ? lastError.message : String(lastError)}`,
      error: lastError,
    });

    // A single overlong or slow text can make the provider reject the whole
    // request (llama.cpp HTTP 400 exceed_context_size_error) or time it out.
    // Split the batch recursively so one bad text cannot discard its healthy
    // siblings; text(s) that still fail come back as empty vectors and are
    // counted by the caller. A context-limit rejection carries a permanent 400
    // status, so it needs its own predicate; timeouts are already non-permanent
    // (belt and braces). Genuine permanent errors never split — halving the
    // batch would fail the same way, only slower.
    const splittable =
      !isPermanentError(lastError) || isContextLimitError(lastError) || isTimeoutError(lastError);
    if (batchTexts.length > 1 && splittable) {
      const mid = Math.ceil(batchTexts.length / 2);
      appendDebugLog(getBatchLogFilePath(), {
        scope: "embedder.batch",
        severity: "info",
        message:
          `Splitting failed batch of ${batchTexts.length} text(s) into ${mid}+${batchTexts.length - mid} ` +
          `(depth ${depth + 1}) after: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      });
      const left = await embedWithRetry(batchTexts.slice(0, mid), depth + 1);
      const right = await embedWithRetry(batchTexts.slice(mid), depth + 1);
      return [
        ...(left ?? batchTexts.slice(0, mid).map(() => [] as number[])),
        ...(right ?? batchTexts.slice(mid).map(() => [] as number[])),
      ];
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
