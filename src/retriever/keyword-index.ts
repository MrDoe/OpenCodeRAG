/**
 * @fileoverview In-memory inverted keyword index with stemming, tokenization, and optional serialization.
 *
 * Memory model: postings live in compressed-sparse-row typed arrays
 * (per-token slices of chunk indices + frequencies, sorted by chunk index),
 * chunk identity is interned to a numeric slot, and per-chunk token sets are
 * never materialized as JS Sets. For a corpus with millions of postings this
 * keeps the resident heap at tens of megabytes instead of gigabytes — the
 * previous Map<token, Map<chunkId, freq>> representation plus a full
 * chunkTokens Map multiplied the serialized size several-fold and dominated
 * the OpenCode server's memory (a 188 MB sidecar index cost >2 GB resident).
 *
 * Mutations between {@link KeywordIndex.save} calls accumulate in small
 * pending structures (addPostings / dels) that {@link retrieve}-time scoring
 * merges on the fly and that {@link KeywordIndex.save} folds into the CSR
 * before serializing, so incremental watcher passes stay O(changed file)
 * while the steady-state structures stay compact.
 */
import type { Chunk, SearchResult, MetadataFilter } from "../core/interfaces.js";
import { normalizeFilePath } from "../core/manifest.js";
import { normalizeFileExtensions, matchesFileExtension } from "../core/filters.js";

const INDEX_VERSION = 4;

/**
 * Characters buffered before a slice of the serialized index is flushed to
 * disk. Keeps every written string far below V8's maximum string length, which
 * a single `JSON.stringify()` of a large index exceeds.
 */
const SAVE_FLUSH_CHARS = 4 * 1024 * 1024;

interface SerializedChunkEntry {
  id: string;
  content: string;
  description?: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  kind?: string;
  role?: string;
  quirkType?: string;
  tags?: string;
}

interface SerializedKeywordIndexV4 {
  version: 4;
  /** Alive chunk ids by posting-local index (postings reference this array). */
  ids: string[];
  chunkMap: Record<string, SerializedChunkEntry>;
  /** Token names; postings entries carry the index into this array. */
  tokens: string[];
  /** [tokenIdx, flat [chunkIdx, freq, chunkIdx, freq, ...]] — chunkIdx sorted. */
  postings: Array<[number, number[]]>;
}

/** Legacy v3 shape (Map-era serialization) — still readable for migration. */
interface SerializedKeywordIndexV3 {
  version: 3;
  tokens: Array<[string, Array<[string, number]>]>;
  chunkMap: Record<string, SerializedChunkEntry>;
}

/**
 * Text indexed for keyword search: chunk content plus its LLM description when
 * one exists. Without this, keyword and vector search would see different text
 * spaces — a description can name a concept the raw code never spells out.
 */
function indexableText(chunk: Chunk): string {
  return chunk.description ? `${chunk.content}\n${chunk.description}` : chunk.content;
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

export function indexPathFor(storePath: string): string {
  return storePath.replace(/\\/g, "/").replace(/\/+$/, "") + "/keyword-index.json";
}

/**
 * In-memory inverted keyword index with stemming, TF-IDF scoring, and optional JSON serialization.
 *
 * Postings are stored CSR-style: token `t` owns the slice
 * `[tokenStart[t], tokenStart[t+1])` of `postChunk`/`postFreq`, sorted by
 * chunk index. Chunks have an internal numeric slot; the string id exists
 * exactly once per chunk. Deletions are tombstones that a merge (run by
 * `save()`) folds away by rebuilding the CSR without them.
 *
 * @param storePath - Optional path to the vector store directory used for loading/saving the serialized index
 */
export class KeywordIndex {
  // ---- chunk identity & metadata (chunkMap is the source of truth) ----

  private chunkMap = new Map<string, Chunk>();
  /** chunk id -> numeric slot. Dead (deleted) ids are removed; slots are never reused. */
  private idToIdx = new Map<string, number>();
  /** slot -> chunk id (holes for dead slots are simply never consulted). */
  private idxToId: string[] = [];
  /** filePath (normalized) -> slot set, for O(chunks-in-file) removal. */
  private fileToIds = new Map<string, Set<number>>();

  /** Indexed-token length per slot — drives BM25 length normalization. */
  private docLengths: number[] = [];
  private totalTokens = 0;

  // ---- materialized CSR postings (snapshot as of the last merge) ----

  private tokNames: string[] = [];
  private tokIdx = new Map<string, number>();
  /** length tokNames.length + 1; slice bounds into postChunk/postFreq. */
  private tokenStart: Uint32Array = new Uint32Array(1);
  private postChunk: Uint32Array = new Uint32Array(0);
  private postFreq: Uint32Array = new Uint32Array(0);

  // ---- pending mutations folded into the CSR at the next merge ----

  /** token -> slot -> term frequency, recorded at add time. Also plays the
   *  role the old chunkTokens Map played: removal and merging use these
   *  recorded postings rather than re-tokenizing, because the description
   *  stage mutates `chunk.description` AFTER addChunks ran and re-derivation
   *  would leak tokens that were never indexed. */
  private addPostings = new Map<string, Map<number, number>>();
  /** slots deleted since the last merge — filtered by search and save. */
  private dels = new Set<number>();

  /** Set by a v3-format load; the plugin re-saves once to migrate. */
  private migratedFromV3 = false;

  /**
   * @param storePath    - Directory holding `keyword-index.json`.
   * @param workspaceDir - Workspace root that per-file keys are relative to.
   *   Defaults to `process.cwd()`, which is wrong inside a host process (the
   *   OpenCode service) whose cwd is not the indexed workspace.
   */
  constructor(storePath?: string, workspaceDir?: string) {
    this.storePath = storePath;
    this.workspaceDir = workspaceDir;
  }

  private readonly storePath?: string;
  private readonly workspaceDir?: string;

  /** Per-file bookkeeping key, matching the manifest's key for the same file. */
  private fileKey(filePath: string): string {
    return normalizeFilePath(filePath, this.workspaceDir);
  }

  addChunks(chunks: Chunk[]): void {
    for (const chunk of chunks) {
      const id = chunk.id;
      let idx = this.idToIdx.get(id);
      if (idx === undefined) {
        idx = this.idxToId.length;
        this.idxToId.push(id);
        this.idToIdx.set(id, idx);
      }
      this.chunkMap.set(id, chunk);

      const fileKey = this.fileKey(chunk.metadata.filePath);
      let ids = this.fileToIds.get(fileKey);
      if (!ids) {
        ids = new Set();
        this.fileToIds.set(fileKey, ids);
      }
      ids.add(idx);

      const tokens = tokenize(indexableText(chunk));
      this.docLengths[idx] = tokens.length;
      this.totalTokens += tokens.length;

      for (const token of tokens) {
        let postings = this.addPostings.get(token);
        if (!postings) {
          postings = new Map();
          this.addPostings.set(token, postings);
        }
        postings.set(idx, (postings.get(idx) ?? 0) + 1);
      }
    }
  }

  getMatchedTerms(query: string, chunkId: string): string[] {
    const idx = this.idToIdx.get(chunkId);
    if (idx === undefined || this.dels.has(idx)) return [];
    const queryTokens = tokenize(query);
    const matched: string[] = [];
    for (const token of queryTokens) {
      const ti = this.tokIdx.get(token);
      if (ti !== undefined && this.csrContains(ti, idx)) {
        matched.push(token);
        continue;
      }
      if (this.addPostings.get(token)?.has(idx) === true) {
        matched.push(token);
      }
    }
    return matched;
  }

  /** Binary search the sorted CSR slice of token `ti` for slot `idx`. */
  private csrContains(ti: number, idx: number): boolean {
    let lo = this.tokenStart[ti]!;
    let hi = this.tokenStart[ti + 1]!;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const v = this.postChunk[mid]!;
      if (v === idx) return true;
      if (v < idx) lo = mid + 1;
      else hi = mid;
    }
    return false;
  }

  removeByFilePath(filePath: string): void {
    const fileKey = this.fileKey(filePath);

    // Fast path: per-file slot set. Falls back to a full chunkMap scan when
    // the path is not tracked (should not happen for loaded indexes — load()
    // rebuilds fileToIds — but kept for parity with the old behavior).
    let slots: number[];
    const tracked = this.fileToIds.get(fileKey);
    if (tracked) {
      slots = [...tracked];
      this.fileToIds.delete(fileKey);
    } else {
      slots = [];
      for (const [id, chunk] of this.chunkMap) {
        if (this.fileKey(chunk.metadata.filePath) === fileKey) {
          const idx = this.idToIdx.get(id);
          if (idx !== undefined) slots.push(idx);
        }
      }
    }

    for (const idx of slots) {
      const id = this.idxToId[idx];
      if (id === undefined) continue;
      if (!this.chunkMap.has(id)) continue;
      this.chunkMap.delete(id);
      this.idToIdx.delete(id);
      this.dels.add(idx);
      const len = this.docLengths[idx];
      if (len !== undefined) {
        this.totalTokens -= len;
        delete this.docLengths[idx];
      }
    }
  }

  search(query: string, topK: number, filter?: MetadataFilter): SearchResult[] {
    if (this.chunkMap.size === 0) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const totalChunks = this.chunkMap.size;
    const avgDocLength = this.totalTokens > 0 ? this.totalTokens / totalChunks : 0;
    const scores = new Map<number, number>();

    // BM25: term-frequency saturation plus length normalization, so a chunk that
    // merely repeats a term (or is very long) can't outrank a focused match.
    const K1 = 1.2;
    const B = 0.75;

    const hasPending = this.dels.size > 0 || this.addPostings.size > 0;

    for (const token of queryTokens) {
      const ti = this.tokIdx.get(token);
      const start = ti !== undefined ? this.tokenStart[ti]! : 0;
      const end = ti !== undefined ? this.tokenStart[ti + 1]! : 0;
      const added = this.addPostings.get(token);

      // Fast path: merged CSR only, no tombstones and no pending additions —
      // score directly off the typed arrays.
      if (!hasPending && ti !== undefined && !added) {
        const df = end - start;
        if (df === 0) continue;
        const idf = Math.log(1 + (totalChunks - df + 0.5) / (df + 0.5));
        for (let p = start; p < end; p++) {
          const idx = this.postChunk[p]!;
          const freq = this.postFreq[p]!;
          const docLength = this.docLengths[idx] ?? avgDocLength;
          const lengthNorm = avgDocLength > 0 ? 1 - B + B * (docLength / avgDocLength) : 1;
          const tf = (freq * (K1 + 1)) / (freq + K1 * lengthNorm);
          scores.set(idx, (scores.get(idx) ?? 0) + idf * tf);
        }
        continue;
      }

      // Merged view of CSR slice + pending additions, deduplicated by slot and
      // minus tombstones. df counts the same docs that are scored below.
      const entries = new Map<number, number>();
      for (let p = start; p < end; p++) {
        const idx = this.postChunk[p]!;
        if (this.dels.has(idx)) continue;
        entries.set(idx, this.postFreq[p]!);
      }
      if (added) {
        for (const [idx, freq] of added) {
          if (this.dels.has(idx)) continue;
          entries.set(idx, (entries.get(idx) ?? 0) + freq);
        }
      }
      const df = entries.size;
      if (df === 0) continue;
      const idf = Math.log(1 + (totalChunks - df + 0.5) / (df + 0.5));
      for (const [idx, freq] of entries) {
        const docLength = this.docLengths[idx] ?? avgDocLength;
        const lengthNorm = avgDocLength > 0 ? 1 - B + B * (docLength / avgDocLength) : 1;
        const tf = (freq * (K1 + 1)) / (freq + K1 * lengthNorm);
        scores.set(idx, (scores.get(idx) ?? 0) + idf * tf);
      }
    }

    const dangling: number[] = [];
    const sorted = [...scores.entries()]
      .filter(([idx]) => {
        const id = this.idxToId[idx];
        const chunk = id !== undefined ? this.chunkMap.get(id) : undefined;
        if (!chunk) {
          // The posting list references a slot whose chunk is gone. This is
          // the "undefined is not an object (evaluating 'chunk.metadata')"
          // crash site: a removal that raced a persisted index or an
          // interrupted re-index leaves phantom slots behind. Skip and
          // tombstone them so a corrupt index self-heals instead of failing
          // every filtered search.
          dangling.push(idx);
          return false;
        }
        return matchesFilter(chunk, filter);
      })
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK);

    if (dangling.length > 0) {
      for (const idx of dangling) this.dels.add(idx);
    }

    return sorted.map(([idx, score]) => ({
      chunk: this.chunkMap.get(this.idxToId[idx]!)!,
      score,
    }));
  }

  /** Fold pending additions and tombstones into the CSR. Empty token slices
   *  are dropped so the token table does not grow unboundedly across merges. */
  private merge(): void {
    if (this.dels.size === 0 && this.addPostings.size === 0) return;

    const union: string[] = this.tokNames.slice();
    for (const token of this.addPostings.keys()) {
      if (!this.tokIdx.has(token)) union.push(token);
    }

    const keptTokens: string[] = [];
    const perToken: Array<{ chunks: number[]; freqs: number[] }> = [];
    let total = 0;

    for (const token of union) {
      const tiOld = this.tokIdx.get(token);
      const oldList: Array<[number, number]> = [];
      if (tiOld !== undefined) {
        const start = this.tokenStart[tiOld]!;
        const end = this.tokenStart[tiOld + 1]!;
        for (let p = start; p < end; p++) {
          const idx = this.postChunk[p]!;
          if (this.dels.has(idx)) continue;
          oldList.push([idx, this.postFreq[p]!]);
        }
      }
      const added = this.addPostings.get(token);
      const addList: Array<[number, number]> = [];
      if (added) {
        for (const [idx, freq] of added) {
          if (this.dels.has(idx)) continue;
          addList.push([idx, freq]);
        }
      }
      if (oldList.length === 0 && addList.length === 0) continue;

      // Both sources sorted by slot, then a linear merge; a slot present in
      // both (re-added id without a removal) sums its frequencies, matching
      // what search-time scoring computes.
      oldList.sort((a, b) => a[0] - b[0]);
      addList.sort((a, b) => a[0] - b[0]);
      const chunks: number[] = [];
      const freqs: number[] = [];
      let i = 0;
      let j = 0;
      while (i < oldList.length || j < addList.length) {
        if (j >= addList.length || (i < oldList.length && oldList[i]![0] < addList[j]![0])) {
          chunks.push(oldList[i]![0]);
          freqs.push(oldList[i]![1]);
          i++;
        } else if (i >= oldList.length || addList[j]![0] < oldList[i]![0]) {
          chunks.push(addList[j]![0]);
          freqs.push(addList[j]![1]);
          j++;
        } else {
          chunks.push(oldList[i]![0]);
          freqs.push(oldList[i]![1] + addList[j]![1]);
          i++;
          j++;
        }
      }
      keptTokens.push(token);
      perToken.push({ chunks, freqs });
      total += chunks.length;
    }

    this.tokNames = keptTokens;
    this.tokIdx = new Map<string, number>();
    this.tokenStart = new Uint32Array(keptTokens.length + 1);
    this.postChunk = new Uint32Array(total);
    this.postFreq = new Uint32Array(total);
    let cursor = 0;
    for (let t = 0; t < keptTokens.length; t++) {
      this.tokenStart[t] = cursor;
      this.tokIdx.set(keptTokens[t]!, t);
      const entry = perToken[t]!;
      this.postChunk.set(entry.chunks, cursor);
      this.postFreq.set(entry.freqs, cursor);
      cursor += entry.chunks.length;
    }
    this.tokenStart[keptTokens.length] = cursor;

    this.dels.clear();
    this.addPostings.clear();
  }

  close(): void {
    this.tokNames = [];
    this.tokIdx.clear();
    this.tokenStart = new Uint32Array(1);
    this.postChunk = new Uint32Array(0);
    this.postFreq = new Uint32Array(0);
    this.chunkMap.clear();
    this.idToIdx.clear();
    this.fileToIds.clear();
    this.addPostings.clear();
    this.dels.clear();
  }

  clear(): void {
    this.close();
    this.idxToId = [];
    this.docLengths = [];
    this.totalTokens = 0;
  }

  count(): number {
    return this.chunkMap.size;
  }

  /** Total postings (merged + pending). Diagnostic/logging only. */
  postingCount(): number {
    let n = this.postChunk.length;
    for (const postings of this.addPostings.values()) n += postings.size;
    return n;
  }

  /** True when this instance was loaded from the legacy v3 (Map-era) file
   *  format; the caller should persist once to migrate to v4. */
  needsFormatMigration(): boolean {
    return this.migratedFromV3;
  }

  hasChunk(id: string): boolean {
    return this.chunkMap.has(id);
  }

  /**
   * Normalized file paths that currently have at least one indexed chunk.
   *
   * The keyword index and the vector store are two independent stores of the
   * same corpus, and nothing keeps them in sync by construction: an
   * incremental index pass only calls {@link addChunks} for the files it
   * reprocessed, so a once-partial index stays partial forever. Comparing
   * this list with the store's file list is how that drift is detected.
   */
  getIndexedFilePaths(): string[] {
    return [...this.fileToIds.keys()];
  }

  /**
   * Persist the index to `keyword-index.json` next to the store.
   *
   * The payload is several hundred megabytes on a large workspace, so it is
   * serialized and written in pieces to a temporary file that is renamed into
   * place on success. A single `JSON.stringify()` of the whole index exceeds
   * V8's maximum string length ("Invalid string length") and used to lose the
   * entire keyword index — and a crash mid-write can no longer truncate the
   * live file.
   *
   * @param storePath - Store directory to write into; defaults to the store
   *   the index was created with.
   */
  async save(storePath?: string): Promise<void> {
    const effectiveStorePath = storePath ?? this.storePath;
    if (!effectiveStorePath) return;

    this.merge();

    const targetPath = indexPathFor(effectiveStorePath);
    const { mkdir, open, rename, rm } = await import("node:fs/promises");
    const path = await import("node:path");

    await mkdir(path.dirname(targetPath), { recursive: true });

    // Alive slots, in ascending slot order, renumbered for the serialized
    // posting arrays. idToIdx only holds live chunks.
    const aliveSlots = [...this.idToIdx.values()].sort((a, b) => a - b);
    const ids: string[] = new Array(aliveSlots.length);
    const renumber = new Int32Array(this.idxToId.length).fill(-1);
    for (let k = 0; k < aliveSlots.length; k++) {
      const slot = aliveSlots[k]!;
      ids[k] = this.idxToId[slot]!;
      renumber[slot] = k;
    }

    const postings: Array<[number, number[]]> = [];
    for (let t = 0; t < this.tokNames.length; t++) {
      const start = this.tokenStart[t]!;
      const end = this.tokenStart[t + 1]!;
      if (start === end) continue;
      const flat: number[] = [];
      for (let p = start; p < end; p++) {
        const chunkIdx = renumber[this.postChunk[p]!]!;
        if (chunkIdx < 0) continue; // dead slot — defensive, merge() already dropped them
        flat.push(chunkIdx, this.postFreq[p]!);
      }
      if (flat.length === 0) continue;
      postings.push([t, flat]);
    }

    const tmpPath = `${targetPath}.tmp`;
    const handle = await open(tmpPath, "w");
    let buffer: string[] = [];
    let buffered = 0;

    const flush = async (final = false): Promise<void> => {
      if (buffer.length === 0) return;
      if (!final && buffered < SAVE_FLUSH_CHARS) return;
      await handle.write(buffer.join(""));
      buffer = [];
      buffered = 0;
    };
    const emit = async (piece: string): Promise<void> => {
      buffer.push(piece);
      buffered += piece.length;
      await flush();
    };

    try {
      // Shape must stay identical to SerializedKeywordIndexV4 — load() parses
      // the file as a whole.
      await emit(`{"version":${INDEX_VERSION},"ids":`);
      await emit(JSON.stringify(ids));
      await emit(',"chunkMap":{');
      let first = true;
      for (const [id, chunk] of this.chunkMap) {
        const entry: SerializedChunkEntry = {
          id: chunk.id,
          content: chunk.content,
          description: chunk.description ?? "",
          filePath: chunk.metadata.filePath,
          startLine: chunk.metadata.startLine,
          endLine: chunk.metadata.endLine,
          language: chunk.metadata.language,
          kind: chunk.metadata.kind ?? "",
          role: chunk.metadata.role ?? "",
          quirkType: chunk.metadata.quirkType ?? "",
          tags: chunk.metadata.tags ? JSON.stringify(chunk.metadata.tags) : "",
        };
        await emit(`${first ? "" : ","}${JSON.stringify(id)}:${JSON.stringify(entry)}`);
        first = false;
      }
      await emit(`},"tokens":`);
      await emit(JSON.stringify(this.tokNames));
      await emit(',"postings":[');
      first = true;
      for (const [tokenIdx, flat] of postings) {
        await emit(`${first ? "" : ","}[${tokenIdx},[${flat.join(",")}]]`);
        first = false;
      }
      await emit("]}");
      await flush(true);
      await handle.close();
      await rename(tmpPath, targetPath);
    } catch (err) {
      await handle.close().catch(() => {});
      await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }

    this.migratedFromV3 = false;
  }

  /**
   * Load the persisted index, or return an empty one when there is none.
   *
   * @param storePath    - Directory holding `keyword-index.json`.
   * @param workspaceDir - Workspace root that per-file keys are relative to.
   */
  static async load(storePath: string, workspaceDir?: string): Promise<KeywordIndex> {
    const targetPath = indexPathFor(storePath);
    const { readFile, access, stat } = await import("node:fs/promises");

    try {
      await access(targetPath);
    } catch {
      return new KeywordIndex(storePath, workspaceDir);
    }

    const fileStat = await stat(targetPath);
    let parsed: SerializedKeywordIndexV4 | SerializedKeywordIndexV3;
    if (fileStat.size < 256 * 1024 * 1024) {
      const raw = await readFile(targetPath, "utf-8");
      try {
        parsed = JSON.parse(raw) as SerializedKeywordIndexV4 | SerializedKeywordIndexV3;
      } catch {
        return new KeywordIndex(storePath, workspaceDir);
      }
    } else {
      try {
        parsed = await KeywordIndex.loadLargeV4(targetPath, fileStat.size);
      } catch {
        return new KeywordIndex(storePath, workspaceDir);
      }
    }

    if (parsed.version === 3) {
      return KeywordIndex.loadV3(storePath, parsed, workspaceDir);
    }
    if (parsed.version !== INDEX_VERSION) {
      return new KeywordIndex(storePath, workspaceDir);
    }

    const index = new KeywordIndex(storePath, workspaceDir);

    // Chunk slots follow the serialized ids array; ids missing from chunkMap
    // stay a slot so dangling-posting self-healing behaves as it did with v3.
    for (let idx = 0; idx < parsed.ids.length; idx++) {
      const id = parsed.ids[idx]!;
      index.idxToId.push(id);
      index.idToIdx.set(id, idx);
    }
    for (const [id, data] of Object.entries(parsed.chunkMap)) {
      const chunk = decodeChunk(id, data);
      if (!chunk) continue;
      index.chunkMap.set(id, chunk);
      const fileKey = index.fileKey(chunk.metadata.filePath);
      let ids = index.fileToIds.get(fileKey);
      if (!ids) {
        ids = new Set();
        index.fileToIds.set(fileKey, ids);
      }
      const idx = index.idToIdx.get(id);
      if (idx !== undefined) ids.add(idx);
    }

    index.tokNames = parsed.tokens.slice();
    index.tokIdx = new Map<string, number>();
    for (let t = 0; t < index.tokNames.length; t++) {
      index.tokIdx.set(index.tokNames[t]!, t);
    }

    // Flatten [tokenIdx, flat] pairs into CSR typed arrays. save() writes
    // token-ordered, deduplicated entries; sort + filter defensively anyway
    // so a hand-edited or future-written file can never corrupt the CSR.
    const posts = parsed.postings
      .filter(([ti]) => ti >= 0 && ti < index.tokNames.length)
      .sort((a, b) => a[0] - b[0])
      .filter((e, i, arr) => i === 0 || e[0] !== arr[i - 1]![0]);
    let total = 0;
    for (const [, flat] of posts) total += Math.floor(flat.length / 2);
    const tokenStart = new Uint32Array(index.tokNames.length + 1);
    const postChunk = new Uint32Array(total);
    const postFreq = new Uint32Array(total);
    // Occurrence counters for BM25 docLengths (one occurrence per unique
    // token per chunk — tokenize() dedupes per chunk, so counting slices is
    // exactly the number of indexed tokens per chunk).
    const docLen: number[] = new Array(index.idxToId.length).fill(0);
    let t = 0;
    let cursor = 0;
    for (const [tokenIdx, flat] of posts) {
      while (t < tokenIdx) {
        tokenStart[t] = cursor; // token with no postings: empty slice
        t++;
      }
      tokenStart[tokenIdx] = cursor;
      for (let p = 0; p + 1 < flat.length; p += 2) {
        const idx = flat[p]!;
        postChunk[cursor] = idx;
        postFreq[cursor] = flat[p + 1]!;
        cursor++;
        if (idx < docLen.length) docLen[idx] = (docLen[idx] ?? 0) + 1;
      }
      t = tokenIdx + 1;
    }
    while (t <= index.tokNames.length) {
      tokenStart[t] = cursor;
      t++;
    }
    index.tokenStart = tokenStart;
    index.postChunk = postChunk;
    index.postFreq = postFreq;

    for (let idx = 0; idx < docLen.length; idx++) {
      const len = docLen[idx] ?? 0;
      if (len > 0) {
        index.docLengths[idx] = len;
        index.totalTokens += len;
      }
    }

    return index;
  }

  /**
   * Parse a large v4 keyword index without loading the whole file into one string.
   * Node's V8 engine caps strings at ~512 MB (ERR_STRING_TOO_LONG); reading the
   * top-level sections (ids, chunkMap, tokens, postings) individually keeps every
   * intermediate string well within the limit.
   */
  private static async loadLargeV4(
    filePath: string,
    fileSize: number,
  ): Promise<SerializedKeywordIndexV4> {
    const { open } = await import("node:fs/promises");
    const handle = await open(filePath, "r");

    try {
      const scanBuf = Buffer.alloc(10 * 1024 * 1024);
      let offset = 0;
      let chunkMapPos = -1;
      let tokensPos = -1;
      let postingsPos = -1;

      const needleChunkMap = Buffer.from(',"chunkMap":{');
      const needleTokens = Buffer.from('},"tokens":[');
      const needlePostings = Buffer.from(',"postings":[');

      while (offset < fileSize) {
        const toRead = Math.min(scanBuf.length, fileSize - offset);
        const { bytesRead } = await handle.read(scanBuf, 0, toRead, offset);
        if (bytesRead <= 0) break;
        const slice = scanBuf.subarray(0, bytesRead);

        if (chunkMapPos === -1) {
          const idx = slice.indexOf(needleChunkMap);
          if (idx !== -1) chunkMapPos = offset + idx;
        }
        if (tokensPos === -1) {
          const idx = slice.indexOf(needleTokens);
          if (idx !== -1) tokensPos = offset + idx;
        }
        if (postingsPos === -1) {
          const idx = slice.indexOf(needlePostings);
          if (idx !== -1) postingsPos = offset + idx;
        }
        if (chunkMapPos !== -1 && tokensPos !== -1 && postingsPos !== -1) break;

        offset += Math.max(1, bytesRead - 64);
      }

      if (chunkMapPos === -1 || tokensPos === -1 || postingsPos === -1) {
        throw new Error("Could not find section boundaries in large keyword index");
      }

      // 1. Version + IDs
      const idsBuf = Buffer.alloc(chunkMapPos + 1);
      await handle.read(idsBuf, 0, chunkMapPos, 0);
      idsBuf[idsBuf.length - 1] = 0x7d; // '}'
      const meta = JSON.parse(idsBuf.toString("utf8")) as { version: 4; ids: string[] };

      // 2. ChunkMap
      const chunkMapPrefix = ',"chunkMap":{'.length;
      const chunkMapContentLen = tokensPos - (chunkMapPos + chunkMapPrefix);
      const chunkMapBuf = Buffer.alloc(chunkMapContentLen + 2);
      chunkMapBuf[0] = 0x7b; // '{'
      await handle.read(chunkMapBuf, 1, chunkMapContentLen, chunkMapPos + chunkMapPrefix);
      chunkMapBuf[chunkMapBuf.length - 1] = 0x7d; // '}'
      const chunkMap = JSON.parse(chunkMapBuf.toString("utf8")) as Record<string, SerializedChunkEntry>;

      // 3. Tokens
      const tokensPrefix = '},"tokens":'.length;
      const tokensLen = postingsPos - (tokensPos + tokensPrefix);
      const tokensBuf = Buffer.alloc(tokensLen);
      await handle.read(tokensBuf, 0, tokensLen, tokensPos + tokensPrefix);
      const tokens = JSON.parse(tokensBuf.toString("utf8")) as string[];

      // 4. Postings
      const postingsPrefix = ',"postings":'.length;
      const postingsLen = fileSize - 1 - (postingsPos + postingsPrefix);
      const postingsBuf = Buffer.alloc(postingsLen);
      await handle.read(postingsBuf, 0, postingsLen, postingsPos + postingsPrefix);
      const postings = JSON.parse(postingsBuf.toString("utf8")) as Array<[number, number[]]>;

      return {
        version: 4,
        ids: meta.ids,
        chunkMap,
        tokens,
        postings,
      };
    } finally {
      await handle.close();
    }
  }

  /** Read the legacy Map-era format and build the CSR representation.
   *  Transient parse peaks exist for this ONE read; the plugin migrates to v4
   *  immediately after (needsFormatMigration) so later boots are cheap. */
  private static loadV3(
    storePath: string,
    parsed: SerializedKeywordIndexV3,
    workspaceDir?: string,
  ): KeywordIndex {
    const index = new KeywordIndex(storePath, workspaceDir);
    index.migratedFromV3 = true;

    for (const [id, data] of Object.entries(parsed.chunkMap)) {
      const chunk = decodeChunk(id, data);
      if (!chunk) continue;
      const idx = index.idxToId.length;
      index.idxToId.push(id);
      index.idToIdx.set(id, idx);
      index.chunkMap.set(id, chunk);
      const fileKey = index.fileKey(chunk.metadata.filePath);
      let ids = index.fileToIds.get(fileKey);
      if (!ids) {
        ids = new Set();
        index.fileToIds.set(fileKey, ids);
      }
      ids.add(idx);
    }

    // Bucket postings by token, skipping ids that no longer exist (the v3
    // ghost-entry case); each bucket is slot-sorted, then flattened.
    const buckets: Array<[string, Array<[number, number]>]> = [];
    const docLen: number[] = new Array(index.idxToId.length).fill(0);
    for (const [token, docs] of parsed.tokens) {
      const bucket: Array<[number, number]> = [];
      for (const [id, freq] of docs) {
        const idx = index.idToIdx.get(id);
        if (idx === undefined) continue;
        bucket.push([idx, freq]);
        docLen[idx] = (docLen[idx] ?? 0) + 1;
      }
      if (bucket.length === 0) continue;
      bucket.sort((a, b) => a[0] - b[0]);
      buckets.push([token, bucket]);
    }

    index.tokNames = buckets.map(([token]) => token);
    index.tokIdx = new Map<string, number>();
    for (let t = 0; t < index.tokNames.length; t++) {
      index.tokIdx.set(index.tokNames[t]!, t);
    }
    let total = 0;
    for (const [, bucket] of buckets) total += bucket.length;
    index.tokenStart = new Uint32Array(buckets.length + 1);
    index.postChunk = new Uint32Array(total);
    index.postFreq = new Uint32Array(total);
    let cursor = 0;
    for (let t = 0; t < buckets.length; t++) {
      index.tokenStart[t] = cursor;
      for (const [idx, freq] of buckets[t]![1]) {
        index.postChunk[cursor] = idx;
        index.postFreq[cursor] = freq;
        cursor++;
      }
    }
    index.tokenStart[buckets.length] = cursor;

    for (let idx = 0; idx < docLen.length; idx++) {
      const len = docLen[idx] ?? 0;
      if (len > 0) {
        index.docLengths[idx] = len;
        index.totalTokens += len;
      }
    }

    return index;
  }

  static async clearFile(storePath: string): Promise<void> {
    const targetPath = indexPathFor(storePath);
    const { writeFile, mkdir } = await import("node:fs/promises");
    const path = await import("node:path");
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(
      targetPath,
      JSON.stringify({ version: INDEX_VERSION, ids: [], chunkMap: {}, tokens: [], postings: [] }),
      "utf-8"
    );
  }
}

function decodeChunk(id: string, data: SerializedChunkEntry): Chunk | undefined {
  if (!data || typeof data.filePath !== "string") return undefined;
  let tags: string[] | undefined;
  try {
    if (data.tags) tags = JSON.parse(data.tags) as string[];
  } catch {
    tags = undefined;
  }
  return {
    id: data.id ?? id,
    content: data.content ?? "",
    description: data.description ?? "",
    metadata: {
      filePath: data.filePath,
      startLine: data.startLine,
      endLine: data.endLine,
      language: data.language,
      kind: data.kind || undefined,
      role: data.role === "source" || data.role === "test" || data.role === "doc" ? data.role : undefined,
      quirkType: data.quirkType || undefined,
      tags,
    },
  };
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
  if (!matchesFileExtension(chunk.metadata.filePath, normalizeFileExtensions(filter.fileExtensions))) return false;
  return true;
}