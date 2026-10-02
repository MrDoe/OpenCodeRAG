/**
 * @fileoverview Shared base class for RerankProvider implementations: failure
 * cooldown and a bounded (query, document) score cache. Retrieval hot paths
 * must never be slowed by a dead reranker, and agent sessions re-issue nearly
 * identical queries often enough that a small in-memory cache pays off.
 */
import type { RerankProvider } from "../core/interfaces.js";
import { createHash } from "node:crypto";

/** Options for the cooldown + cache behavior shared by all rerank providers. */
export interface RerankProviderBaseOptions {
  /** Consecutive `noteFailure()` calls before the cooldown trips. Default 3. */
  cooldownThreshold?: number;
  /** How long the provider reports `available() === false` after tripping. Default 300000 ms. */
  cooldownMs?: number;
  /** Maximum cached (query, document) scores. Default 500. */
  cacheMax?: number;
}

/**
 * Base implementation of {@link RerankProvider} supplying the cooldown state
 * machine and an LRU-ish score cache. Subclasses implement `rerank()` and use
 * {@link cacheGet}/{@link cacheSet} for memoization.
 */
export abstract class RerankProviderBase implements RerankProvider {
  abstract readonly name: string;
  readonly model: string;

  private failures = 0;
  private cooldownUntil = 0;
  private readonly cooldownThreshold: number;
  private readonly cooldownMs: number;
  private readonly cacheMax: number;
  /** Insertion/re-touch-ordered Map — the first key is the least recently used. */
  private readonly cache = new Map<string, number>();

  constructor(model: string, options: RerankProviderBaseOptions = {}) {
    this.model = model;
    this.cooldownThreshold = options.cooldownThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 300_000;
    this.cacheMax = options.cacheMax ?? 500;
  }

  /** False while the post-failure cooldown is active. */
  available(): boolean {
    return Date.now() >= this.cooldownUntil;
  }

  /** Counts a failed call; every `cooldownThreshold` failures trip the cooldown. */
  noteFailure(): void {
    this.failures += 1;
    if (this.failures >= this.cooldownThreshold) {
      this.failures = 0;
      this.cooldownUntil = Date.now() + this.cooldownMs;
    }
  }

  /** A success proves the provider is healthy again — reset the streak. */
  noteSuccess(): void {
    this.failures = 0;
  }

  /** Look up a cached score for this provider's model + query + document. */
  protected cacheGet(query: string, document: string): number | undefined {
    const key = this.cacheKey(query, document);
    const score = this.cache.get(key);
    if (score !== undefined) {
      // Touch: move to the most-recently-used end.
      this.cache.delete(key);
      this.cache.set(key, score);
    }
    return score;
  }

  /** Store a score, evicting the least recently used entry past the cap. */
  protected cacheSet(query: string, document: string, score: number): void {
    const key = this.cacheKey(query, document);
    this.cache.delete(key);
    this.cache.set(key, score);
    while (this.cache.size > this.cacheMax) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      this.cache.delete(oldest.value);
    }
  }

  private cacheKey(query: string, document: string): string {
    const hash = createHash("sha1");
    hash.update(this.name);
    hash.update("\0");
    hash.update(this.model);
    hash.update("\0");
    hash.update(query);
    hash.update("\0");
    hash.update(document);
    return hash.digest("hex");
  }

  abstract rerank(query: string, documents: string[], opts?: { timeoutMs?: number }): Promise<number[]>;
}
