/**
 * @fileoverview Ollama embedding provider that generates vector embeddings via the Ollama /api/embed endpoint.
 */
import type { EmbeddingProvider } from "../core/interfaces.js";
import type { ProxyConfig } from "../core/config.js";
import { normalizeKeepAlive } from "../core/ollama.js";
import { postJson } from "./http.js";
import path from "node:path";
import { appendDebugLog } from "../core/fileLogger.js";

/**
 * Ollama embedding provider that generates vector embeddings via the Ollama /api/embed endpoint.
 *
 * @param baseUrl - Ollama server base URL (e.g. http://localhost:11434)
 * @param model - Model name to use for embedding
 * @param apiKey - Optional API key for authenticated endpoints
   * @param timeoutMs - Request timeout in milliseconds (default 120000)
 * @param proxy - Optional proxy configuration
 * @param logLevel - Optional logging level for debug output
 * @param keepAlive - Optional Ollama keep_alive value sent with /api/embed requests (e.g. "-1")
 */
export class OllamaProvider implements EmbeddingProvider {
  readonly name = "ollama";

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private proxy?: ProxyConfig;
  private readonly logLevel?: string;
  private readonly keepAlive?: string;

  constructor(baseUrl: string, model: string, apiKey?: string, timeoutMs: number = 120000, proxy?: ProxyConfig, logLevel?: string, keepAlive?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.proxy = proxy;
    this.logLevel = logLevel;
    this.keepAlive = keepAlive;
  }

  private getLogFilePath(): string {
    return path.resolve(process.cwd(), ".opencode", "opencode-rag.log");
  }

  private debug(message: string, error?: unknown): void {
    appendDebugLog(this.getLogFilePath(), {
      scope: "embedder.ollama",
      message,
      error,
    }, this.logLevel);
  }

  async embed(texts: string[], _purpose?: "query" | "document"): Promise<number[][]> {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    this.debug(`OllamaProvider requesting ${texts.length} embedding vector${texts.length === 1 ? "" : "s"}`);

    try {
      const body: Record<string, unknown> = {
        model: this.model,
        input: texts.length === 1 ? texts[0] : texts,
      };
      const keepAlive = normalizeKeepAlive(this.keepAlive);
      if (keepAlive !== undefined) {
        body.keep_alive = keepAlive;
      }

      const response = await postJson(
        `${this.baseUrl}/embed`,
        body,
        headers,
        this.timeoutMs,
        this.proxy
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Ollama embedding failed (${response.status}): ${body}`);
      }

      const json = (await response.json()) as {
        embedding?: number[];
        embeddings?: number[][];
      };

      if (Array.isArray(json.embeddings) && json.embeddings.every((item) => Array.isArray(item))) {
        this.debug(`OllamaProvider received ${json.embeddings.length} embedding vector${json.embeddings.length === 1 ? "" : "s"}`);
        return json.embeddings;
      }

      if (Array.isArray(json.embedding)) {
        this.debug("OllamaProvider received 1 embedding vector");
        return [json.embedding];
      }

      throw new Error(`Ollama: unexpected response: ${JSON.stringify(json)}`);
    } catch (error) {
      if ((error as Error).name === "AbortError" || (error as Error).message === "Aborted") {
        throw new Error(`Ollama embedding request timed out after ${this.timeoutMs}ms`);
      }

      this.debug("OllamaProvider embedding request failed", error);
      throw error;
    }
  }
}
