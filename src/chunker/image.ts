/**
 * @fileoverview Image file chunking via vision provider integration (Ollama, OpenAI, Anthropic, Gemini).
 */
import type { Chunker, Chunk } from "../core/interfaces.js";
import type { ImageDescriptionConfig, ProxyConfig } from "../core/config.js";
import { normalizeKeepAlive } from "../core/ollama.js";
import { postJson } from "../embedder/http.js";
import { uuid } from "./uuid.js";

const MAX_CHUNK_CHARS = 4000;
const MIN_GROUP_CHARS = 300;
const PARAGRAPH_SPLIT = /\n\s*\n/;
const VISION_RETRY_MAX = 2;
const VISION_RETRY_BASE_DELAY_MS = 1000;
const VISION_RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function visionSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Set of image file extensions that can be processed by the vision providers. */
export const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
]);

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

/**
 * Map a file extension to its corresponding MIME type string.
 * Defaults to `image/png` for unknown extensions.
 * @param ext - The file extension (with or without leading dot).
 * @returns The MIME type string.
 */
export function getMimeType(ext: string): string {
  return MIME_TYPES[ext.toLowerCase().replace(/^\./, "")] || "image/png";
}

/**
 * Provider interface for describing images using a vision-language model.
 * Each implementation communicates with a specific provider's API (Ollama,
 * OpenAI, Anthropic, or Google Gemini).
 */
export interface ImageVisionProvider {
  describeImage(
    imageBase64: string,
    mimeType: string,
    prompt: string,
    systemPrompt?: string,
    abort?: AbortSignal
  ): Promise<string>;
}

/**
 * Image vision provider using Ollama's local API.
 * Sends the image as a base64-encoded string in the chat messages array.
 * Supports retries with exponential backoff for retryable HTTP status codes.
 */
class OllamaImageVisionProvider implements ImageVisionProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private think: boolean;
  private numCtx?: number;
  private keepAlive?: string;
  private proxy?: ProxyConfig;

  constructor(config: ImageDescriptionConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.model = config.model;
    this.timeoutMs = config.timeoutMs;
    this.think = config.think ?? false;
    this.numCtx = config.numCtx;
    this.keepAlive = config.keepAlive;
    this.proxy = config.proxy;
  }

  async describeImage(imageBase64: string, _mimeType: string, prompt: string, systemPrompt?: string, abort?: AbortSignal): Promise<string> {
    const messages: Array<{ role: string; content: string; images?: string[] }> = [];
    if (systemPrompt && systemPrompt.trim().length > 0) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: prompt, images: [imageBase64] });

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
      think: this.think,
      options: { num_ctx: this.numCtx },
    };
    if (this.keepAlive) {
      body.keep_alive = normalizeKeepAlive(this.keepAlive);
    }

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= VISION_RETRY_MAX; attempt++) {
      const response = await postJson(
        `${this.baseUrl}/chat`,
        body,
        {},
        this.timeoutMs,
        this.proxy,
        abort,
      );

      if (!response.ok) {
        const text = await response.text();
        const error = new Error(`Ollama vision request failed (${response.status}): ${text}`);
        if (VISION_RETRYABLE_STATUSES.has(response.status) && attempt < VISION_RETRY_MAX) {
          lastError = error;
          await visionSleep(VISION_RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        throw error;
      }

      const json = (await response.json()) as {
        message?: { content?: string; thinking?: string };
      };
      const content = json.message?.content;
      if (content && content.trim().length > 0) {
        return content.trim();
      }

      lastError = new Error(`Ollama vision returned empty response: ${JSON.stringify(json)}`);
      if (attempt < VISION_RETRY_MAX) {
        await visionSleep(VISION_RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
      }
    }

    throw lastError!;
  }
}

/**
 * Image vision provider using the OpenAI-compatible Chat Completions API.
 * Sends the image as a data URL in a multi-part user message.
 * Supports retries with exponential backoff for retryable HTTP status codes.
 */
class OpenAIImageVisionProvider implements ImageVisionProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private proxy?: ProxyConfig;

  constructor(config: ImageDescriptionConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.model = config.model;
    this.apiKey = config.apiKey ?? "";
    this.timeoutMs = config.timeoutMs;
    this.proxy = config.proxy;
  }

  async describeImage(imageBase64: string, mimeType: string, prompt: string, systemPrompt?: string, abort?: AbortSignal): Promise<string> {
    const url = `${this.baseUrl}${this.baseUrl.endsWith("/v1") ? "" : "/v1"}/chat/completions`;

    const messages: Array<Record<string, unknown>> = [];
    if (systemPrompt && systemPrompt.trim().length > 0) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({
      role: "user",
      content: [
        { type: "text", text: prompt },
        {
          type: "image_url",
          image_url: { url: `data:${mimeType};base64,${imageBase64}` },
        },
      ],
    });

    const body = {
      model: this.model,
      messages,
      max_tokens: 2048,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= VISION_RETRY_MAX; attempt++) {
      const response = await postJson(url, body, headers, this.timeoutMs, this.proxy, abort);

      if (!response.ok) {
        const text = await response.text();
        const error = new Error(`OpenAI vision request failed (${response.status}): ${text}`);
        if (VISION_RETRYABLE_STATUSES.has(response.status) && attempt < VISION_RETRY_MAX) {
          lastError = error;
          await visionSleep(VISION_RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        throw error;
      }

      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content;
      if (content && content.trim().length > 0) {
        return content.trim();
      }

      lastError = new Error(`OpenAI vision returned empty response: ${JSON.stringify(json)}`);
      if (attempt < VISION_RETRY_MAX) {
        await visionSleep(VISION_RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
      }
    }

    throw lastError!;
  }
}

/**
 * Image vision provider using the Anthropic Messages API.
 * Sends the image as a base64 source block in a multi-part user message.
 * Requires an API key. Supports retries with exponential backoff.
 */
class AnthropicImageVisionProvider implements ImageVisionProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private proxy?: ProxyConfig;

  constructor(config: ImageDescriptionConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.model = config.model;
    this.apiKey = config.apiKey ?? "";
    this.timeoutMs = config.timeoutMs;
    this.proxy = config.proxy;
  }

  async describeImage(imageBase64: string, mimeType: string, prompt: string, systemPrompt?: string, abort?: AbortSignal): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mimeType, data: imageBase64 },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    };
    if (systemPrompt && systemPrompt.trim().length > 0) {
      body.system = systemPrompt;
    }

    const headers: Record<string, string> = {
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    };

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= VISION_RETRY_MAX; attempt++) {
      const response = await postJson(
        `${this.baseUrl}/messages`,
        body,
        headers,
        this.timeoutMs,
        this.proxy,
        abort,
      );

      if (!response.ok) {
        const text = await response.text();
        const error = new Error(`Anthropic vision request failed (${response.status}): ${text}`);
        if (VISION_RETRYABLE_STATUSES.has(response.status) && attempt < VISION_RETRY_MAX) {
          lastError = error;
          await visionSleep(VISION_RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        throw error;
      }

      const json = (await response.json()) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const text = json.content?.find((c) => c.type === "text")?.text;
      if (text && text.trim().length > 0) {
        return text.trim();
      }

      lastError = new Error(`Anthropic vision returned empty response: ${JSON.stringify(json)}`);
      if (attempt < VISION_RETRY_MAX) {
        await visionSleep(VISION_RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
      }
    }

    throw lastError!;
  }
}

/**
 * Image vision provider using the Google Gemini API.
 * Sends the image as inline_data in a parts array. Accepts an optional API key.
 * Supports retries with exponential backoff for retryable HTTP status codes.
 */
class GeminiImageVisionProvider implements ImageVisionProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private proxy?: ProxyConfig;

  constructor(config: ImageDescriptionConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs;
    this.proxy = config.proxy;
  }

  async describeImage(imageBase64: string, mimeType: string, prompt: string, systemPrompt?: string, abort?: AbortSignal): Promise<string> {
    const body: Record<string, unknown> = {
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: mimeType,
                data: imageBase64,
              },
            },
          ],
        },
      ],
    };
    if (systemPrompt && systemPrompt.trim().length > 0) {
      body.system_instruction = { parts: [{ text: systemPrompt }] };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    const url = this.apiKey
      ? `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`
      : `${this.baseUrl}/models/${this.model}:generateContent`;

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= VISION_RETRY_MAX; attempt++) {
      const response = await postJson(url, body, headers, this.timeoutMs, this.proxy, abort);

      if (!response.ok) {
        const text = await response.text();
        const error = new Error(`Gemini vision request failed (${response.status}): ${text}`);
        if (VISION_RETRYABLE_STATUSES.has(response.status) && attempt < VISION_RETRY_MAX) {
          lastError = error;
          await visionSleep(VISION_RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        throw error;
      }

      const json = (await response.json()) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
        }>;
      };
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text && text.trim().length > 0) {
        return text.trim();
      }

      lastError = new Error(`Gemini vision returned empty response: ${JSON.stringify(json)}`);
      if (attempt < VISION_RETRY_MAX) {
        await visionSleep(VISION_RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
      }
    }

    throw lastError!;
  }
}

/**
 * Factory function that creates the appropriate {@link ImageVisionProvider}
 * implementation based on the `provider` field in the config.
 * @param config - The image description configuration.
 * @returns A provider instance for the configured vision backend.
 * @throws If `provider` is `"openai"` or `"anthropic"` but no `apiKey` is provided.
 */
export function createImageVisionProvider(config: ImageDescriptionConfig): ImageVisionProvider {
  if (config.provider === "anthropic") {
    if (!config.apiKey) {
      throw new Error("Anthropic image provider requires an apiKey");
    }
    return new AnthropicImageVisionProvider(config);
  }
  if (config.provider === "google") {
    return new GeminiImageVisionProvider(config);
  }
  if (config.provider === "openai") {
    if (!config.apiKey) {
      throw new Error("OpenAI image provider requires an apiKey");
    }
    return new OpenAIImageVisionProvider(config);
  }
  return new OllamaImageVisionProvider(config);
}

/**
 * Chunker for image description text.
 * This chunker is used after an image has been processed by a vision provider;
 * it splits the resulting description text by paragraph boundaries, grouping
 * small paragraphs into chunks of up to 4000 characters.
 */
export class ImageChunker implements Chunker {
  readonly language = "image";
  readonly fileExtensions: string[];

  constructor(extensions: string[]) {
    this.fileExtensions = extensions;
  }

  /**
   * Split the image description text into chunks by paragraph grouping.
   * @param filePath - Original file path (for metadata).
   * @param content - The description text produced by a vision provider.
   * @returns A list of text chunks with file-path and line-range metadata.
   */
  async chunk(filePath: string, content: string): Promise<Chunk[]> {
    if (content.trim().length === 0) return [];

    const paragraphs = content.split(PARAGRAPH_SPLIT).filter((p) => p.trim().length > 0);
    if (paragraphs.length === 0) return [];

    const chunks: Chunk[] = [];
    let currentGroup: string[] = [];
    let currentSize = 0;
    let paragraphIndex = 0;

    function flush() {
      const text = currentGroup.join("\n\n").trim();
      if (text.length === 0) return;
      chunks.push({
        id: uuid(),
        content: text,
        metadata: {
          filePath,
          startLine: paragraphIndex - currentGroup.length + 1,
          endLine: paragraphIndex,
          language: "image",
        },
      });
      currentGroup = [];
      currentSize = 0;
    }

    for (const para of paragraphs) {
      paragraphIndex++;
      const paraLen = para.length;

      if (paraLen > MAX_CHUNK_CHARS) {
        if (currentGroup.length > 0) flush();
        chunks.push({
          id: uuid(),
          content: para,
          metadata: {
            filePath,
            startLine: paragraphIndex,
            endLine: paragraphIndex,
            language: "image",
          },
        });
        continue;
      }

      if (currentGroup.length > 0 && currentSize + paraLen > MAX_CHUNK_CHARS) {
        flush();
      }

      currentGroup.push(para);
      currentSize += paraLen;

      if (currentSize >= MIN_GROUP_CHARS && currentGroup.length >= 1) {
        const nextParaStillSmall =
          paragraphIndex < paragraphs.length &&
          paragraphs[paragraphIndex]!.length < MIN_GROUP_CHARS;
        if (!nextParaStillSmall) {
          flush();
        }
      }
    }

    if (currentGroup.length > 0) {
      flush();
    }

    return chunks;
  }
}