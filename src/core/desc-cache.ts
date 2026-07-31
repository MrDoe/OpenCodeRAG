/**
 * @fileoverview Persistent description cache keyed by content hash + description config hash.
 * Survives aborted index runs so that descriptions are not regenerated unnecessarily.
 * Two namespaces: "code" (per-chunk descriptions) and "image" (per-file image descriptions).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const CACHE_VERSION = 1;
const MAX_ENTRIES = 50_000;
const MAX_AGE_DAYS = 30;

interface CacheEntry {
  description: string;
  createdAt: number;
}

interface CacheData {
  version: number;
  entries: Record<string, CacheEntry>;
}

export class DescriptionCache {
  private cache: CacheData = { version: CACHE_VERSION, entries: {} };
  private cacheDir: string;
  private dirty = false;
  private savePromise: Promise<void> = Promise.resolve();
  private loadPromise: Promise<void> | null = null;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
  }

  /** Load the cache from disk. */
  async load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      const cachePath = path.join(this.cacheDir, ".desc-cache.json");
      try {
        const raw = await fs.readFile(cachePath, "utf-8");
        const parsed = JSON.parse(raw) as CacheData;
        if (parsed.version === CACHE_VERSION && parsed.entries) {
          this.cache = parsed;
          this.dirty = false;
        }
      } catch {
        // Cache file missing or corrupt — start fresh
      }
    })();
    return this.loadPromise;
  }

  /** Get a cached description for the given key. */
  get(key: string): string | undefined {
    return this.cache.entries[key]?.description;
  }

  /** Set a cached description for the given key. */
  set(key: string, description: string): void {
    this.cache.entries[key] = {
      description,
      createdAt: Date.now(),
    };
    this.dirty = true;
    this.maybeEvict();
  }

  /** Set multiple entries at once. */
  setMany(entries: Array<[string, string]>): void {
    const now = Date.now();
    for (const [key, description] of entries) {
      this.cache.entries[key] = { description, createdAt: now };
    }
    this.dirty = true;
    this.maybeEvict();
  }

  /** Check if a key exists in the cache. */
  has(key: string): boolean {
    return key in this.cache.entries;
  }

  /** Persist the cache to disk if dirty. Safe to call multiple times. */
  async save(): Promise<void> {
    if (!this.dirty) return;
    this.savePromise = this.savePromise.then(async () => {
      const cachePath = path.join(this.cacheDir, ".desc-cache.json");
      const tmpPath = cachePath + ".tmp";
      try {
        await fs.mkdir(this.cacheDir, { recursive: true });
        await fs.writeFile(tmpPath, JSON.stringify(this.cache), "utf-8");
        try {
          await fs.rename(tmpPath, cachePath);
        } catch {
          await fs.unlink(cachePath).catch(() => {});
          await fs.rename(tmpPath, cachePath);
        }
        this.dirty = false;
      } catch {
        // Best-effort save
      }
    });
    return this.savePromise;
  }

  /**
   * Build a cache key for a code chunk.
   *
   * The optional `context` (relative path + line range) is included because
   * the description prompt contains the file path — identical chunk content
   * in two different files must not reuse a contextually wrong description.
   */
  static codeKey(content: string, descConfigHash: string, context?: string): string {
    const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 16);
    const contextHash = context ? createHash("sha256").update(context).digest("hex").slice(0, 8) : "";
    return contentHash + "_" + descConfigHash.slice(0, 16) + (contextHash ? "_" + contextHash : "");
  }

  /** Build a cache key for an image file. */
  static imageKey(imageBytesHash: string, imageDescConfigHash: string): string {
    return imageBytesHash.slice(0, 16) + "_" + imageDescConfigHash.slice(0, 16);
  }

  /** Remove old entries to stay under the limit. */
  private maybeEvict(): void {
    const keys = Object.keys(this.cache.entries);
    if (keys.length <= MAX_ENTRIES) return;

    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const entries = this.cache.entries;
    for (const key of keys) {
      if (entries[key]!.createdAt < cutoff) {
        delete entries[key];
      }
    }

    // If still over limit, delete oldest
    if (Object.keys(entries).length > MAX_ENTRIES) {
      const sorted = Object.entries(entries)
        .sort(([, a], [, b]) => a.createdAt - b.createdAt);
      const toDelete = Object.keys(entries).length - MAX_ENTRIES;
      for (let i = 0; i < toDelete; i++) {
        delete entries[sorted[i]![0]];
      }
    }
  }
}
