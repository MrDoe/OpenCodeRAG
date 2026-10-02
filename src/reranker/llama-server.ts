/**
 * @fileoverview Rerank provider for llama-server's Cohere-style /v1/rerank
 * endpoint (llama.cpp `--reranking --pooling rank`, optionally behind
 * llama-swap which routes v1/rerank natively).
 */
import type { ProxyConfig, RerankingConfig } from "../core/config.js";
import { postJson } from "../embedder/http.js";
import { RerankProviderBase } from "./base.js";

/** Shape of one entry in a /v1/rerank response body. */
interface RerankResultEntry {
  index?: number;
  relevance_score?: number;
}

/**
 * Cross-encoder reranker backed by llama-server.
 *
 * Sends `{ model, query, documents }` to `{baseUrl}/rerank` and maps
 * `results[].relevance_score` back index-aligned with the input documents.
 * Larger document sets are split into batches of at most
 * `maxDocsPerRequest` and issued concurrently. Failures throw; the calling
 * retrieval stage degrades to fusion order and records the failure for the
 * shared cooldown in {@link RerankProviderBase}.
 */
export class LlamaServerReranker extends RerankProviderBase {
  readonly name = "llama-server";

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly defaultTimeoutMs: number;
  private readonly proxy?: ProxyConfig;
  private readonly maxDocsPerRequest: number;

  constructor(
    config: Pick<RerankingConfig, "baseUrl" | "model" | "apiKey" | "timeoutMs" | "proxy">,
    options: { maxDocsPerRequest?: number } = {},
  ) {
    super(config.model);
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.defaultTimeoutMs = config.timeoutMs ?? 1500;
    this.proxy = config.proxy;
    // llama.cpp rerank context is sized for a handful of passages; batches
    // beyond this risk context overflow on small --ctx servers.
    this.maxDocsPerRequest = options.maxDocsPerRequest ?? 16;
  }

  async rerank(query: string, documents: string[], opts?: { timeoutMs?: number }): Promise<number[]> {
    if (documents.length === 0) return [];
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;

    const scores = new Array<number>(documents.length).fill(0);
    const missingIndices: number[] = [];
    for (let i = 0; i < documents.length; i++) {
      const cached = this.cacheGet(query, documents[i] ?? "");
      if (cached !== undefined) {
        scores[i] = cached;
      } else {
        missingIndices.push(i);
      }
    }
    if (missingIndices.length === 0) return scores;

    const batches: number[][] = [];
    for (let i = 0; i < missingIndices.length; i += this.maxDocsPerRequest) {
      batches.push(missingIndices.slice(i, i + this.maxDocsPerRequest));
    }

    const batchScores = await Promise.all(
      batches.map((batch) => this.rerankBatch(query, batch.map((i) => documents[i] ?? ""), timeoutMs)),
    );

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      const batchResult = batchScores[b];
      if (!batch || !batchResult) continue;
      for (let j = 0; j < batch.length; j++) {
        const docIndex = batch[j];
        const score = batchResult[j] ?? 0;
        if (docIndex === undefined) continue;
        scores[docIndex] = score;
        this.cacheSet(query, documents[docIndex] ?? "", score);
      }
    }
    return scores;
  }

  /** One /v1/rerank call; returns scores index-aligned with `documents`. */
  private async rerankBatch(query: string, documents: string[], timeoutMs: number): Promise<number[]> {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await postJson(
      `${this.baseUrl}/rerank`,
      { model: this.model, query, documents },
      headers,
      timeoutMs,
      this.proxy,
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`llama-server rerank failed (${response.status}): ${body.slice(0, 200)}`);
    }

    const json = (await response.json()) as { results?: RerankResultEntry[] };
    if (!Array.isArray(json.results)) {
      throw new Error(`llama-server rerank: unexpected response: ${JSON.stringify(json).slice(0, 200)}`);
    }

    const scores = new Array<number>(documents.length).fill(0);
    let matched = 0;
    for (const entry of json.results) {
      const index = entry?.index;
      const score = entry?.relevance_score;
      if (typeof index !== "number" || index < 0 || index >= documents.length) continue;
      if (typeof score !== "number" || !Number.isFinite(score)) continue;
      scores[index] = score;
      matched++;
    }
    if (matched === 0) {
      throw new Error("llama-server rerank: response contained no usable relevance_score entries");
    }
    return scores;
  }
}
