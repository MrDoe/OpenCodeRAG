/**
 * @fileoverview Anthropic Messages API description provider for generating natural-language descriptions of code chunks.
 */
import type { Chunk, DescriptionProvider, DescriptionLogger } from "../core/interfaces.js";
import type { DescriptionConfig } from "../core/config.js";
import { postJson } from "../embedder/http.js";
import { buildUserMessage, sleep } from "./shared.js";
import pLimit from "p-limit";

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
}

/** HTTP status codes that are safe to retry on. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Description provider that uses Anthropic's Messages API to generate natural-language descriptions of code chunks.
 *
 * Requires an API key set in the configuration. The system prompt is prepended to each user message within a single
 * message payload. Supports retry with exponential backoff.
 */
export class AnthropicDescriptionProvider implements DescriptionProvider {
  private readonly config: DescriptionConfig;

  /**
   * @param config - Configuration for the Anthropic provider, including base URL, model, API key, and retry settings.
   */
  constructor(config: DescriptionConfig) {
    this.config = config;
  }

  /** @inheritdoc */
  async generateDescription(chunk: Chunk): Promise<string> {
    const messages: AnthropicMessage[] = [
      { role: "user", content: buildUserMessage(chunk, this.config.maxContentChars) },
    ];

    return this.chatRequest(messages, this.config.timeoutMs ?? 60000);
  }

  /** @inheritdoc */
  async generateBatchDescriptions(chunks: Chunk[], logger?: DescriptionLogger): Promise<Map<string, string>> {
    const log = logger ?? { info: (msg: string) => process.stderr.write(`${msg}\n`), warn: (msg: string) => process.stderr.write(`${msg}\n`), debug: (msg: string) => process.stderr.write(`${msg}\n`) };
    const concurrency = this.config.batchConcurrency ?? 3;
    const total = chunks.length;
    log.info(`[describer] Generating descriptions for ${total} chunks (concurrency: ${concurrency})`);

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
            log.info(`[describer] Progress: ${completed}/${total}`);
          }
        }),
      ),
    );

    log.info(`[describer] Descriptions generated: ${result.size}/${total}`);
    return result;
  }

  /**
   * Sends a request to the Anthropic Messages API with retry and exponential backoff.
   * The system prompt is combined with all user messages into a single message payload, and
   * the assistant placeholder is appended to elicit a completion.
   *
   * @param messages - The user messages to send.
   * @param timeoutMs - Request timeout in milliseconds.
   * @returns The trimmed response text from the model.
   * @throws When all retry attempts are exhausted or the response is empty.
   */
  private async chatRequest(
    messages: AnthropicMessage[],
    timeoutMs: number,
  ): Promise<string> {
    const baseUrl = this.config.baseUrl.replace(/\/+$/, "");
    const apiKey = this.config.apiKey ?? "";
    const systemPrompt = this.config.systemPrompt;

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: 4096,
      messages: [{ role: "user", content: systemPrompt + "\n\n" + messages.map((m) => `${m.role}: ${m.content}`).join("\n\n") + "\n\nassistant:" }],
    };

    const headers: Record<string, string> = {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    };

    const retryMax = this.config.retryMax ?? 3;
    const retryBaseDelayMs = this.config.retryBaseDelayMs ?? 1000;

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= retryMax; attempt++) {
      const response = await postJson(
        `${baseUrl}/messages`,
        body,
        headers,
        timeoutMs,
        this.config.proxy,
      );

      if (response.ok) {
        const json = (await response.json()) as AnthropicResponse;
        const text = json.content?.[0]?.text;
        if (text && text.trim().length > 0) {
          return text.trim();
        }
        throw new Error(`Anthropic returned empty response: ${JSON.stringify(json)}`);
      }

      const text = await response.text();
      const error = new Error(
        `Anthropic LLM request failed (${response.status}): ${text}`,
      );

      if (!RETRYABLE_STATUSES.has(response.status) || attempt === retryMax) {
        throw error;
      }

      lastError = error;
      const delayMs = retryBaseDelayMs * Math.pow(2, attempt);
      await sleep(delayMs);
    }

    throw lastError ?? new Error("Anthropic LLM request failed: unknown error");
  }
}


