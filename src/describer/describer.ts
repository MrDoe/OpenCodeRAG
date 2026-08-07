/**
 * @fileoverview OpenAI-compatible LLM description provider for generating natural-language descriptions of code chunks.
 */
import type { BatchDescriptionOptions, Chunk, DescriptionProvider, DescriptionLogger } from "../core/interfaces.js";
import type { DescriptionConfig } from "../core/config.js";
import { postJson } from "../embedder/http.js";
import { buildUserMessage, buildBatchUserMessage, parseBatchDescriptions, sleep } from "./shared.js";
import pLimit from "p-limit";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatResponse {
  message?: { content?: string; thinking?: string };
  choices?: Array<{ message?: { content?: string } }>;
}

/** HTTP status codes that are safe to retry on. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** Consecutive failed batch attempts after which batching is disabled for the rest of the run. */
const BATCH_MAX_STREAK = 2;

/**
 * Description provider that works with any OpenAI-compatible chat API (including Ollama).
 *
 * Supports Bearer-token authentication, optional proxy, and retry with exponential backoff.
 * For Ollama, uses the `/api/chat` endpoint and sends additional options like `num_ctx` and `think`.
 */
export class LlmDescriptionProvider implements DescriptionProvider {
  private readonly config: DescriptionConfig;
  /** Consecutive batches that needed individual fallback; disables batching past BATCH_MAX_STREAK. */
  private batchFailStreak = 0;
  /** Whether multi-chunk batching is still active (adaptive, per provider instance / index run). */
  private adaptiveBatchActive = true;

  /**
   * @param config - Configuration for the LLM provider, including base URL, model, API key, proxy, and retry settings.
   */
  constructor(config: DescriptionConfig) {
    this.config = config;
  }

  /** @inheritdoc */
  async generateDescription(chunk: Chunk): Promise<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: this.config.systemPrompt },
      { role: "user", content: buildUserMessage(chunk, this.config.maxContentChars) },
    ];

    return this.chatRequest(messages, this.config.timeoutMs ?? 60000);
  }

  /** @inheritdoc */
  async generateText(system: string, user: string, opts?: { timeoutMs?: number }): Promise<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    return this.chatRequest(messages, opts?.timeoutMs ?? this.config.timeoutMs ?? 60000);
  }

  /** @inheritdoc */
  async generateBatchDescriptions(chunks: Chunk[], logger?: DescriptionLogger, opts?: BatchDescriptionOptions): Promise<Map<string, string>> {
    const log = logger ?? { info: (msg: string) => process.stderr.write(`${msg}\n`), warn: (msg: string) => process.stderr.write(`${msg}\n`), debug: (msg: string) => process.stderr.write(`${msg}\n`) };
    const concurrency = this.config.batchConcurrency ?? 3;
    // Batching is an EXPERIMENTAL opt-in (description.batchEnabled). Off by
    // default — a batch size of 1 routes every group through the individual
    // request path below, which is exactly the per-chunk behavior.
    const batchEnabled = this.config.batchEnabled === true;
    const batchMaxChunks = batchEnabled ? (this.config.batchMaxChunks ?? 25) : 1;
    const total = chunks.length;
    log.debug(`[describer] Generating descriptions for ${total} chunks via ${this.config.provider}/${this.config.model} (concurrency: ${concurrency}, batch: ${batchEnabled ? batchMaxChunks : "off"})`);
    const result = new Map<string, string>();
    const limit = pLimit(concurrency);
    let completed = 0;
    const emitProgress = (chunk: Chunk) => {
      completed++;
      opts?.onProgress?.(chunk, completed, opts.total ?? total);
    };

    // Group chunks so that up to batchMaxChunks share a single LLM request,
    // cutting round trips (one prefill + one generation per group instead of
    // per chunk). Groups with a single chunk use the individual path for
    // consistent error handling.
    const groups: Chunk[][] = [];
    for (let i = 0; i < chunks.length; i += batchMaxChunks) {
      groups.push(chunks.slice(i, i + batchMaxChunks));
    }

    await Promise.all(
      groups.map((group) =>
        limit(async () => {
          if (group.length === 1) {
            const chunk = group[0]!;
            try {
              const desc = await this.generateDescription(chunk);
              result.set(chunk.id, desc);
            } catch (err) {
              log.warn(`[describer] Failed to describe chunk ${chunk.id} (${chunk.metadata.filePath}:${chunk.metadata.startLine}): ${err instanceof Error ? err.message : String(err)}`);
            }
            emitProgress(chunk);
            return;
          }

          // Small models are unreliable at structured multi-item output — if a
          // batch response can't be parsed, fall back to individual requests
          // and degrade to per-chunk mode for the rest of the run after
          // BATCH_MAX_STREAK consecutive failures.
          let resolved: Map<string, string>;
          let batchFailed = false;
          if (this.adaptiveBatchActive) {
            try {
              resolved = await this.batchDescribe(group, log);
            } catch (err) {
              log.warn(`[describer] Batch description failed for ${group.length} chunks, falling back to individual: ${err instanceof Error ? err.message : String(err)}`);
              resolved = new Map();
              batchFailed = true;
            }
          } else {
            resolved = new Map();
          }

          // Batch labels are ordinals (1..N); map back to chunks by position.
          const missing: Chunk[] = [];
          for (let i = 0; i < group.length; i++) {
            const chunk = group[i]!;
            const desc = resolved.get(String(i + 1));
            if (desc && desc.trim().length > 0) {
              result.set(chunk.id, desc.trim());
              emitProgress(chunk);
            } else {
              missing.push(chunk);
            }
          }

          if (batchFailed || missing.length > 0) {
            this.batchFailStreak++;
            if (this.adaptiveBatchActive && this.batchFailStreak >= BATCH_MAX_STREAK) {
              this.adaptiveBatchActive = false;
              log.warn(`[describer] Batch descriptions unreliable (${this.batchFailStreak} consecutive failures), switching to individual requests for the rest of the run`);
            }
          } else {
            this.batchFailStreak = 0;
          }

          // Fall back to individual requests for chunks the batch did not cover.
          for (const chunk of missing) {
            try {
              const desc = await this.generateDescription(chunk);
              result.set(chunk.id, desc);
            } catch (err) {
              log.warn(`[describer] Failed to describe chunk ${chunk.id} (${chunk.metadata.filePath}:${chunk.metadata.startLine}): ${err instanceof Error ? err.message : String(err)}`);
            }
            emitProgress(chunk);
          }
        }),
      ),
    );

    log.debug(`[describer] Descriptions generated: ${result.size}/${total}`);
    return result;
  }

  /**
   * Describe a group of chunks in a single LLM request and parse the response.
   *
   * Builds one chat request whose user message contains all chunks wrapped in
   * `[CHUNK <n>]` markers and expects a `<n>: <description>` line per chunk.
   * Labels are ordinals and are mapped back to chunks by position in the
   * calling group; labels outside the group's range (hallucinations) are
   * naturally dropped, prompting the caller to fall back to individual
   * requests for the missing chunks.
   *
   * @param group - Chunks to describe in one request (length > 1)
   * @param log - Logger for diagnostic messages
   * @returns Map of ordinal label to description (may be partial or empty)
   * @throws When the LLM request itself fails (caller falls back per chunk)
   */
  private async batchDescribe(group: Chunk[], log: DescriptionLogger): Promise<Map<string, string>> {
    const messages: ChatMessage[] = [
      { role: "system", content: this.config.systemPrompt },
      { role: "user", content: buildBatchUserMessage(group, this.config.maxContentChars) },
    ];
    const timeoutMs = this.config.batchTimeoutMs ?? this.config.timeoutMs ?? 120000;
    log.debug(`[describer] BATCH REQUEST ${group.length} chunks (${group[0]!.metadata.filePath}):\n${messages[1]!.content}`);
    const content = await this.chatRequest(messages, timeoutMs);
    const parsed = parseBatchDescriptions(content);
    log.debug(`[describer] BATCH RESPONSE parsed ${parsed.size}/${group.length} chunks`);
    return parsed;
  }

  /**
   * Sends a chat completion request to the LLM API with retry and exponential backoff.
   * For Ollama, uses the `/api/chat` endpoint with streaming disabled; otherwise uses the standard `/v1/chat/completions` endpoint.
   *
   * @param messages - The conversation messages including system prompt and user content.
   * @param timeoutMs - Request timeout in milliseconds.
   * @returns The trimmed response text extracted from the API response.
   * @throws When all retry attempts are exhausted or the response is empty.
   */
  private async chatRequest(
    messages: ChatMessage[],
    timeoutMs: number
  ): Promise<string> {
    const baseUrl = this.config.baseUrl.replace(/\/+$/, "");
    const isOllama = this.config.provider === "ollama";

    const url = isOllama
      ? `${baseUrl}/chat`
      : `${baseUrl}${baseUrl.endsWith("/v1") ? "" : "/v1"}/chat/completions`;

    const body = isOllama
      ? { model: this.config.model, messages, stream: false, think: this.config.think ?? false, options: { num_ctx: this.config.numCtx }, keep_alive: this.config.keepAlive }
      : { model: this.config.model, messages };

    const headers: Record<string, string> = {};
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }

    const retryMax = this.config.retryMax ?? 3;
    const retryBaseDelayMs = this.config.retryBaseDelayMs ?? 1000;

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= retryMax; attempt++) {
      let response: import("../embedder/http.js").HttpResponseLike;
      try {
        response = await postJson(url, body, headers, timeoutMs, this.config.proxy);
      } catch (err) {
        // Network-level failures (ECONNREFUSED, socket timeouts) are transient —
        // treat them like retryable HTTP statuses.
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt === retryMax) throw lastError;
        const delayMs = retryBaseDelayMs * Math.pow(2, attempt) * (0.8 + Math.random() * 0.4);
        await sleep(delayMs);
        continue;
      }

      if (response.ok) {
        const json = (await response.json()) as ChatResponse;
        return extractResponseText(json, isOllama);
      }

      const text = await response.text();
      const error = new Error(
        `Description LLM request failed (${response.status}): ${text}`
      );

      if (!RETRYABLE_STATUSES.has(response.status) || attempt === retryMax) {
        throw error;
      }

      lastError = error;
      const delayMs = retryBaseDelayMs * Math.pow(2, attempt) * (0.8 + Math.random() * 0.4);
      await sleep(delayMs);
    }

    throw lastError ?? new Error("Description LLM request failed: unknown error");
  }
}



/**
 * Extracts the response text from a chat completion response.
 * For Ollama, reads from `message.content`; for OpenAI-compatible APIs, reads from `choices[0].message.content`.
 *
 * @param json - The parsed chat response object.
 * @param isOllama - Whether the response is from an Ollama API (different response shape).
 * @returns The trimmed response text.
 * @throws If the response contains no usable text content.
 */
function extractResponseText(json: ChatResponse, isOllama: boolean): string {
  if (isOllama) {
    const content = json.message?.content;
    if (typeof content === "string" && content.trim().length > 0) {
      return content.trim();
    }
  }

  const content = json.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim().length > 0) {
    return content.trim();
  }

  throw new Error(
    `Description LLM returned empty response: ${JSON.stringify(json)}`
  );
}
