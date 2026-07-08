/**
 * @fileoverview Google Gemini description provider for generating natural-language descriptions of code chunks.
 */
import type { Chunk, DescriptionProvider, DescriptionLogger } from "../core/interfaces.js";
import type { DescriptionConfig } from "../core/config.js";
import { postJson } from "../embedder/http.js";
import { buildUserMessage, sleep } from "./shared.js";
import pLimit from "p-limit";

interface GeminiContent {
  role?: string;
  parts: Array<{ text: string }>;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Description provider that uses Google Gemini's generateContent API to describe code chunks.
 *
 * @param config - Configuration for the Gemini provider, including base URL, model, API key, and retry settings.
 */
export class GeminiDescriptionProvider implements DescriptionProvider {
  private readonly config: DescriptionConfig;

  constructor(config: DescriptionConfig) {
    this.config = config;
  }

  async generateDescription(chunk: Chunk): Promise<string> {
    const contents: GeminiContent[] = [
      {
        role: "user",
        parts: [{ text: buildUserMessage(chunk, this.config.maxContentChars) }],
      },
    ];

    return this.chatRequest(contents, this.config.timeoutMs ?? 60000);
  }

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

  private async chatRequest(
    contents: GeminiContent[],
    timeoutMs: number,
  ): Promise<string> {
    const baseUrl = this.config.baseUrl.replace(/\/+$/, "");
    const apiKey = this.config.apiKey ?? "";
    const model = this.config.model;
    const systemPrompt = this.config.systemPrompt;

    const allParts: Array<{ text: string }> = [{ text: systemPrompt }];
    for (const c of contents) {
      allParts.push(...c.parts);
    }

    const body: Record<string, unknown> = {
      contents: [{ role: "user", parts: allParts }],
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    const url = apiKey
      ? `${baseUrl}/models/${model}:generateContent?key=${apiKey}`
      : `${baseUrl}/models/${model}:generateContent`;

    const retryMax = this.config.retryMax ?? 3;
    const retryBaseDelayMs = this.config.retryBaseDelayMs ?? 1000;

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= retryMax; attempt++) {
      const response = await postJson(url, body, headers, timeoutMs);

      if (response.ok) {
        const json = (await response.json()) as GeminiResponse;
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text && text.trim().length > 0) {
          return text.trim();
        }
        throw new Error(`Gemini returned empty response: ${JSON.stringify(json)}`);
      }

      const text = await response.text();
      const error = new Error(
        `Gemini LLM request failed (${response.status}): ${text}`,
      );

      if (!RETRYABLE_STATUSES.has(response.status) || attempt === retryMax) {
        throw error;
      }

      lastError = error;
      const delayMs = retryBaseDelayMs * Math.pow(2, attempt);
      await sleep(delayMs);
    }

    throw lastError ?? new Error("Gemini LLM request failed: unknown error");
  }
}


