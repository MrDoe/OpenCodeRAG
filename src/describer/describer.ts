/**
 * @fileoverview OpenAI-compatible LLM description provider for generating natural-language descriptions of code chunks.
 */
import type { Chunk, DescriptionProvider, DescriptionLogger } from "../core/interfaces.js";
import type { DescriptionConfig } from "../core/config.js";
import { postJson } from "../embedder/http.js";
import { buildUserMessage, sleep } from "./shared.js";
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

/**
 * Description provider that works with any OpenAI-compatible chat API (including Ollama).
 *
 * Supports Bearer-token authentication, optional proxy, and retry with exponential backoff.
 * For Ollama, uses the `/api/chat` endpoint and sends additional options like `num_ctx` and `think`.
 */
export class LlmDescriptionProvider implements DescriptionProvider {
  private readonly config: DescriptionConfig;

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
  async generateBatchDescriptions(chunks: Chunk[], logger?: DescriptionLogger): Promise<Map<string, string>> {
    const log = logger ?? { info: (msg: string) => process.stderr.write(`${msg}\n`), warn: (msg: string) => process.stderr.write(`${msg}\n`), debug: (msg: string) => process.stderr.write(`${msg}\n`) };
    const concurrency = this.config.batchConcurrency ?? 3;
    const total = chunks.length;
    log.info(`Generating descriptions for ${total} chunks via ${this.config.provider}/${this.config.model} (concurrency: ${concurrency})...`);
    const result = new Map<string, string>();
    const limit = pLimit(concurrency);
    let completed = 0;

    await Promise.all(
      chunks.map((chunk) =>
        limit(async () => {
          const userMsg = buildUserMessage(chunk, this.config.maxContentChars);
          log.debug(`[describer] REQUEST chunk ${chunk.id} (${chunk.metadata.filePath}:${chunk.metadata.startLine}):\n${userMsg}`);
          try {
            const desc = await this.generateDescription(chunk);
            result.set(chunk.id, desc);
            log.debug(`[describer] RESPONSE chunk ${chunk.id}: ${desc}`);
          } catch (err) {
            log.warn(`[describer] Failed to describe chunk ${chunk.id} (${chunk.metadata.filePath}:${chunk.metadata.startLine}): ${err instanceof Error ? err.message : String(err)}`);
          }
          completed++;
          if (completed % 25 === 0 || completed === total) {
            log.info(`Descriptions: ${completed}/${total}`);
          }
        }),
      ),
    );

    log.info(`Descriptions: ${result.size}/${total} done.`);
    return result;
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
      ? { model: this.config.model, messages, stream: false, think: this.config.think ?? false, options: { num_ctx: this.config.numCtx } }
      : { model: this.config.model, messages };

    const headers: Record<string, string> = {};
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }

    const retryMax = this.config.retryMax ?? 3;
    const retryBaseDelayMs = this.config.retryBaseDelayMs ?? 1000;

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= retryMax; attempt++) {
      const response = await postJson(url, body, headers, timeoutMs, this.config.proxy);

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
      const delayMs = retryBaseDelayMs * Math.pow(2, attempt);
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
