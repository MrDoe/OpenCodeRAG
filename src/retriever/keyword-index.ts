/**
 * @fileoverview In-memory inverted keyword index with stemming, tokenization, and optional serialization.
 */
import type { Chunk, SearchResult, MetadataFilter } from "../core/interfaces.js";
import { normalizeFilePath } from "../core/manifest.js";

const INDEX_VERSION = 2;

interface SerializedKeywordIndex {
  version: number;
  tokens: Array<[string, Array<[string, number]>]>;
  chunkMap: Record<string, {
    id: string;
    content: string;
    description?: string;
    filePath: string;
    startLine: number;
    endLine: number;
    language: string;
    kind?: string;
    quirkType?: string;
    tags?: string;
  }>;
}

/** Suffix-stripping stemmer. Only stems words >= 6 characters to reduce false positives. */
function stem(word: string): string {
  if (word.length < 6) return word;
  if (word.endsWith("ing") && word.length >= 6) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length >= 6) return word.slice(0, -2);
  if (word.endsWith("ly") && word.length >= 6) return word.slice(0, -2);
  if (word.endsWith("es") && word.length >= 6) {
    const beforeEs = word[word.length - 3];
    if (beforeEs === "s" || beforeEs === "x" || beforeEs === "z" || beforeEs === "h") {
      return word.slice(0, -2);
    }
  }
  if (word.endsWith("er") && word.length >= 6) return word.slice(0, -2);
  if (word.endsWith("en") && word.length >= 6) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length >= 5) return word.slice(0, -1);
  if (word.endsWith("e") && word.length >= 6) return word.slice(0, -1);
  return word;
}

/**
 * Tokenize text into normalized tokens including stems, camelCase parts, and snake_case parts.
 *
 * @param text - The text to tokenize
 * @returns Array of unique normalized tokens
 */
export function tokenize(text: string): string[] {
  const tokens = new Set<string>();

  const words = text.split(/[^a-zA-Z0-9_]+/);

  for (const word of words) {
    if (word.length < 2) continue;

    const lower = word.toLowerCase();
    tokens.add(lower);
    tokens.add(stem(lower));

    const camelParts = word.split(/(?=[A-Z])/);
    for (const part of camelParts) {
      if (part.length >= 2) {
        const p = part.toLowerCase();
        tokens.add(p);
        tokens.add(stem(p));
      }
    }

    const snakeParts = word.split("_");
    for (const part of snakeParts) {
      if (part.length >= 2) {
        const p = part.toLowerCase();
        tokens.add(p);
        tokens.add(stem(p));
      }
    }
  }

  return [...tokens];
}

function indexPathFor(storePath: string): string {
  return storePath.replace(/\\/g, "/").replace(/\/+$/, "") + "/keyword-index.json";
}

/**
 * In-memory inverted keyword index with stemming, TF-IDF scoring, and optional JSON serialization.
 *
 * @param storePath - Optional path to the vector store directory used for loading/saving the serialized index
 */
export class KeywordIndex {
  private invertedIndex = new Map<string, Map<string, number>>();
  private chunkMap = new Map<string, Chunk>();
  private readonly storePath?: string;

  /** filePath (normalized) → chunk IDs, for O(chunks-in-file) removal. */
  private fileToIds = new Map<string, Set<string>>();

  constructor(storePath?: string) {
    this.storePath = storePath;
  }

  addChunks(chunks: Chunk[]): void {
    for (const chunk of chunks) {
      const id = chunk.id;
      this.chunkMap.set(id, chunk);

      const fileKey = normalizeFilePath(chunk.metadata.filePath);
      let ids = this.fileToIds.get(fileKey);
      if (!ids) {
        ids = new Set();
        this.fileToIds.set(fileKey, ids);
      }
      ids.add(id);

      const tokens = tokenize(chunk.content);

      for (const token of tokens) {
        let docs = this.invertedIndex.get(token);
        if (!docs) {
          docs = new Map();
          this.invertedIndex.set(token, docs);
        }
        docs.set(id, (docs.get(id) ?? 0) + 1);
      }
    }
  }

  getMatchedTerms(query: string, chunkId: string): string[] {
    const queryTokens = tokenize(query);
    const matched: string[] = [];
    for (const token of queryTokens) {
      const docs = this.invertedIndex.get(token);
      if (docs && docs.has(chunkId)) {
        matched.push(token);
      }
    }
    return matched;
  }

  removeByFilePath(filePath: string): void {
    const fileKey = normalizeFilePath(filePath);

    // Fast path: per-file id index. Falls back to a full chunkMap scan when
    // the path is not tracked (entries loaded from an older persisted index).
    let idsToRemove: string[];
    const tracked = this.fileToIds.get(fileKey);
    if (tracked) {
      idsToRemove = [...tracked];
      this.fileToIds.delete(fileKey);
    } else {
      idsToRemove = [];
      for (const [id, chunk] of this.chunkMap) {
        if (normalizeFilePath(chunk.metadata.filePath) === fileKey) {
          idsToRemove.push(id);
        }
      }
    }

    for (const id of idsToRemove) {
      const chunk = this.chunkMap.get(id);
      if (chunk) {
        const tokens = tokenize(chunk.content);
        for (const token of tokens) {
          const docs = this.invertedIndex.get(token);
          if (docs) {
            docs.delete(id);
            if (docs.size === 0) {
              this.invertedIndex.delete(token);
            }
          }
        }
        this.chunkMap.delete(id);
      }
    }
  }

  search(query: string, topK: number, filter?: MetadataFilter): SearchResult[] {
    if (this.chunkMap.size === 0) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const totalChunks = this.chunkMap.size;
    const scores = new Map<string, number>();

    for (const token of queryTokens) {
      const docs = this.invertedIndex.get(token);
      if (!docs) continue;

      const df = docs.size;
      const idf = Math.log(1 + totalChunks / (df || 1));

      for (const [chunkId, freq] of docs) {
        const score = freq * idf;
        scores.set(chunkId, (scores.get(chunkId) ?? 0) + score);
      }
    }

    const sorted = [...scores.entries()]
      .filter(([id]) => matchesFilter(this.chunkMap.get(id)!, filter))
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK);

    return sorted.map(([chunkId, score]) => {
      const chunk = this.chunkMap.get(chunkId)!;
      return { chunk, score };
    });
  }

  close(): void {
    this.invertedIndex.clear();
    this.chunkMap.clear();
    this.fileToIds.clear();
  }

  clear(): void {
    this.invertedIndex.clear();
    this.chunkMap.clear();
    this.fileToIds.clear();
  }

  count(): number {
    return this.chunkMap.size;
  }

  async save(storePath?: string): Promise<void> {
    const effectiveStorePath = storePath ?? this.storePath;
    if (!effectiveStorePath) return;

    const targetPath = indexPathFor(effectiveStorePath);
    const { mkdir, writeFile } = await import("node:fs/promises");
    const path = await import("node:path");

    await mkdir(path.dirname(targetPath), { recursive: true });

    const serialized: SerializedKeywordIndex = {
      version: INDEX_VERSION,
      tokens: [...this.invertedIndex.entries()].map(
        ([token, docs]) => [token, [...docs.entries()]] as [string, Array<[string, number]>]
      ),
      chunkMap: Object.fromEntries(
        [...this.chunkMap.entries()].map(([id, chunk]) => [
          id,
          {
            id: chunk.id,
            content: chunk.content,
            description: chunk.description ?? "",
            filePath: chunk.metadata.filePath,
            startLine: chunk.metadata.startLine,
            endLine: chunk.metadata.endLine,
            language: chunk.metadata.language,
            kind: chunk.metadata.kind ?? "",
            quirkType: chunk.metadata.quirkType ?? "",
            tags: chunk.metadata.tags ? JSON.stringify(chunk.metadata.tags) : "",
          },
        ])
      ),
    };

    await writeFile(targetPath, JSON.stringify(serialized), "utf-8");
  }

  static async load(storePath: string): Promise<KeywordIndex> {
    const targetPath = indexPathFor(storePath);
    const { readFile, access } = await import("node:fs/promises");

    try {
      await access(targetPath);
    } catch {
      return new KeywordIndex(storePath);
    }

    const raw = await readFile(targetPath, "utf-8");
    let parsed: SerializedKeywordIndex;
    try {
      parsed = JSON.parse(raw) as SerializedKeywordIndex;
    } catch {
      return new KeywordIndex(storePath);
    }

    if (parsed.version !== INDEX_VERSION) {
      return new KeywordIndex(storePath);
    }

    const index = new KeywordIndex(storePath);

    for (const [token, docs] of parsed.tokens) {
      const docMap = new Map<string, number>(docs);
      index.invertedIndex.set(token, docMap);
    }

    for (const [id, data] of Object.entries(parsed.chunkMap)) {
      let tags: string[] | undefined;
      try {
        if (data.tags) tags = JSON.parse(data.tags) as string[];
      } catch {
        tags = undefined;
      }
      index.chunkMap.set(id, {
        id: data.id,
        content: data.content,
        description: data.description ?? "",
        metadata: {
          filePath: data.filePath,
          startLine: data.startLine,
          endLine: data.endLine,
          language: data.language,
          kind: data.kind || undefined,
          quirkType: data.quirkType || undefined,
          tags,
        },
      });
    }

    // Rebuild the per-file id index from the loaded chunk map so removals
    // work even for entries persisted by older versions.
    for (const [id, chunk] of index.chunkMap) {
      const fileKey = normalizeFilePath(chunk.metadata.filePath);
      let ids = index.fileToIds.get(fileKey);
      if (!ids) {
        ids = new Set();
        index.fileToIds.set(fileKey, ids);
      }
      ids.add(id);
    }

    return index;
  }

  static async clearFile(storePath: string): Promise<void> {
    const targetPath = indexPathFor(storePath);
    const { writeFile, mkdir } = await import("node:fs/promises");
    const path = await import("node:path");
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, JSON.stringify({ version: INDEX_VERSION, tokens: [], chunkMap: {} }), "utf-8");
  }
}

function globMatch(pattern: string, filePath: string): boolean {
  const GLOBSTAR = "\x00GS\x00";
  let re = pattern.replace(/\*\*/g, GLOBSTAR);
  re = re.replace(/([.+^${}()|[\]\\])/g, "\\$1");
  re = re.replace(new RegExp(GLOBSTAR, "g"), ".*");
  re = re.replace(/\*/g, "[^/]*");
  re = re.replace(/\?/g, ".");
  return new RegExp("^" + re + "$").test(filePath);
}

function matchesFilter(chunk: Chunk, filter?: MetadataFilter): boolean {
  if (!filter) return true;
  if (filter.languages?.length && !filter.languages.includes(chunk.metadata.language)) return false;
  if (filter.kinds?.length && !filter.kinds.includes(chunk.metadata.kind ?? "")) return false;
  if (filter.pathPatterns?.length) {
    return filter.pathPatterns.some((p) => globMatch(p, chunk.metadata.filePath));
  }
  return true;
}
