import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { EmbeddingProvider, VectorStore, KeywordIndex, SearchResult } from "../core/interfaces.js";
import type { RagConfig } from "../core/config.js";
import { retrieve } from "../retriever/retriever.js";
import { isQuirkAllowed } from "./monitor.js";
import type { Quirk, QuirkInput } from "./types.js";

/** Dependencies required by all quirk-store operations. */
export interface QuirkStoreDeps {
  embedder: EmbeddingProvider;
  store: VectorStore;
  keywordIndex: KeywordIndex;
  cfg: RagConfig;
  storePath: string;
}

const QUIRK_FILE_PREFIX = "quirk:";
const QUIKK_JSONL = "quirks.jsonl";

function jsonlPath(storePath: string): string {
  return path.join(storePath, QUIKK_JSONL);
}

function isMemoryStore(storePath: string): boolean {
  return storePath.startsWith("memory:");
}

/** In-memory backup for memory:// stores, keyed by store path. */
const memQuirksByStore = new Map<string, Map<string, Quirk>>();

function memQuirksFor(storePath: string): Map<string, Quirk> {
  let store = memQuirksByStore.get(storePath);
  if (!store) {
    store = new Map();
    memQuirksByStore.set(storePath, store);
  }
  return store;
}

function readJsonl(filePath: string): Quirk[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf-8").trim();
  if (!raw) return [];
  const quirks: Quirk[] = [];
  for (const line of raw.split("\n")) {
    try {
      quirks.push(JSON.parse(line) as Quirk);
    } catch {
      // Skip corrupt lines â€” a single bad line must never break
      // every quirk operation (readJsonl feeds get/update/remove/list).
    }
  }
  return quirks;
}

function appendJsonl(filePath: string, q: Quirk): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  appendFileSync(filePath, JSON.stringify(q) + "\n", "utf-8");
}

function rewriteJsonl(filePath: string, quirks: Quirk[]): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Atomic write: tmp file + rename, so a crash or concurrent process
  // can never leave a truncated/empty quirks.jsonl behind.
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, quirks.map((q) => JSON.stringify(q)).join("\n") + "\n", "utf-8");
  try {
    renameSync(tmpPath, filePath);
  } catch {
    // Windows: rename can fail with EPERM when another process holds the file;
    // fall back to a direct write (best-effort) rather than losing data.
    writeFileSync(filePath, quirks.map((q) => JSON.stringify(q)).join("\n") + "\n", "utf-8");
    try {
      renameSync(tmpPath, `${filePath}.bak`);
    } catch {
      // ignore
    }
  }
}

function nowISO(): string {
  return new Date().toISOString();
}

/** Look up a single quirk by its ID, or `undefined` when not found. */
export async function getQuirk(deps: QuirkStoreDeps, id: string): Promise<Quirk | undefined> {
  if (!isMemoryStore(deps.storePath)) {
    const jp = jsonlPath(deps.storePath);
    if (existsSync(jp)) {
      const found = readJsonl(jp).find((q) => q.id === id);
      if (found) return found;
    }
    const chunks = await deps.store.getChunksByFilePath(QUIRK_FILE_PREFIX + id);
    const c = chunks[0];
    if (c) {
      return {
        id: c.id,
        content: c.content,
        quirkType: c.metadata.quirkType,
        tags: c.metadata.tags ?? [],
        confidence: c.metadata.confidence ?? 1,
        lastObserved: c.metadata.lastObserved ?? "",
        sourceRef: undefined,
      };
    }
    return undefined;
  }
  return memQuirksFor(deps.storePath).get(id);
}

/**
 * Update an existing quirk by ID. Fields in `patch` override the stored values.
 *
 * When `content` changes, the new text must pass the trust monitor, the quirk
 * is re-embedded, and the vector-store chunk + keyword index entry are replaced
 * (same ID, new embedding). The audit log entry is rewritten in place.
 *
 * @throws If no quirk with the given ID exists, or the new content is rejected
 * by the trust monitor.
 */
export async function updateQuirk(deps: QuirkStoreDeps, id: string, patch: Partial<QuirkInput>): Promise<Quirk> {
  const existing = await getQuirk(deps, id);
  if (!existing) {
    throw new Error(`Quirk not found: ${id}`);
  }

  const content = patch.content ?? existing.content;
  const quirkType = patch.quirkType ?? existing.quirkType;
  const tags = patch.tags ?? existing.tags;
  const confidence = patch.confidence ?? existing.confidence;
  const sourceRef = patch.sourceRef ?? existing.sourceRef;

  if (content !== existing.content) {
    const allowed = isQuirkAllowed(content);
    if (!allowed.ok) {
      throw new Error(`Quirk rejected by trust monitor: ${allowed.reason}`);
    }
  }

  const updated: Quirk = {
    id,
    content,
    quirkType,
    tags,
    confidence,
    lastObserved: existing.lastObserved,
    sourceRef,
  };

  const filePath = QUIRK_FILE_PREFIX + id;

  // Embed FIRST — if embedding fails, the old index entries are untouched
  // (previously the delete happened before the embed, permanently removing
  // the quirk from search while the JSONL still listed it).
  const prefix = deps.cfg.embedding.documentPrefix ?? "";
  const chunkContent = prefix + content;
  const embeddings = await deps.embedder.embed([chunkContent], "document");
  const embedding = embeddings[0];
  if (!embedding || embedding.length === 0) {
    throw new Error("Embedding returned empty vector for quirk content");
  }

  await deps.store.deleteByFilePath(filePath);
  deps.keywordIndex.removeByFilePath(filePath);

  const chunk = {
    id,
    content,
    description: "",
    embedding,
    metadata: {
      filePath,
      startLine: 0,
      endLine: 0,
      language: "quirk",
      kind: "quirk",
      quirkType,
      tags,
      confidence,
      lastObserved: updated.lastObserved,
    },
  };

  await deps.store.addChunks([chunk]);
  deps.keywordIndex.addChunks([chunk]);

  if (!isMemoryStore(deps.storePath)) {
    const jp = jsonlPath(deps.storePath);
    const all = readJsonl(jp).map((q) => (q.id === id ? updated : q));
    rewriteJsonl(jp, all);
  } else {
    memQuirksFor(deps.storePath).set(id, updated);
  }

  return updated;
}

/** Add a new quirk to the vector store, keyword index, and audit log. */
export async function addQuirk(deps: QuirkStoreDeps, input: QuirkInput): Promise<Quirk> {
  const allowed = isQuirkAllowed(input.content);
  if (!allowed.ok) {
    throw new Error(`Quirk rejected by trust monitor: ${allowed.reason}`);
  }

  const id = `quirk:${randomUUID()}`;
  const lastObserved = nowISO();
  const confidence = input.confidence ?? 1;

  const quirk: Quirk = {
    id,
    content: input.content,
    quirkType: input.quirkType,
    tags: input.tags ?? [],
    confidence,
    lastObserved,
    sourceRef: input.sourceRef,
  };

  const prefix = deps.cfg.embedding.documentPrefix ?? "";
  const chunkContent = prefix + input.content;
  const embeddings = await deps.embedder.embed([chunkContent], "document");
  const embedding = embeddings[0];
  if (!embedding || embedding.length === 0) {
    throw new Error("Embedding returned empty vector for quirk content");
  }

  const chunk = quirkChunk(quirk, embedding);

  await deps.store.addChunks([chunk]);
  deps.keywordIndex.addChunks([chunk]);

  if (!isMemoryStore(deps.storePath)) {
    appendJsonl(jsonlPath(deps.storePath), quirk);
  } else {
    memQuirksFor(deps.storePath).set(id, quirk);
  }

  return quirk;
}

/**
 * Build the store/keyword-index chunk shape for a quirk. Shared by `addQuirk`
 * and `reconcileQuirks` — a rebuild-restore must produce the exact same row
 * shape (metadata.filePath in particular drives list/remove/reconcile id maps).
 *
 * `embedding` may be `[]` for keyword-index-only adds: `chunkToRow` skips rows
 * with an empty embedding, and the keyword index only tokenizes content.
 */
function quirkChunk(q: Quirk, embedding: number[]) {
  return {
    id: q.id,
    content: q.content,
    description: "",
    embedding,
    metadata: {
      filePath: QUIRK_FILE_PREFIX + q.id,
      startLine: 0,
      endLine: 0,
      language: "quirk",
      kind: "quirk",
      quirkType: q.quirkType,
      tags: q.tags ?? [],
      confidence: q.confidence,
      lastObserved: q.lastObserved,
    },
  };
}

/** Remove a quirk by its ID. Throws if no quirk with the given ID exists. */
export async function removeQuirk(deps: QuirkStoreDeps, id: string): Promise<void> {
  const existing = await getQuirk(deps, id);
  if (!existing) {
    throw new Error(`Quirk not found: ${id}`);
  }

  const filePath = QUIRK_FILE_PREFIX + id;
  await deps.store.deleteByFilePath(filePath);
  deps.keywordIndex.removeByFilePath(filePath);

  if (!isMemoryStore(deps.storePath)) {
    const jp = jsonlPath(deps.storePath);
    const all = readJsonl(jp).filter((q) => q.id !== id);
    rewriteJsonl(jp, all);
  } else {
    memQuirksFor(deps.storePath).delete(id);
  }
}

/** List all quirks sorted by lastObserved descending. */
export async function listQuirks(deps: QuirkStoreDeps): Promise<Quirk[]> {
  if (!isMemoryStore(deps.storePath)) {
    const jp = jsonlPath(deps.storePath);
    if (existsSync(jp)) {
      const all = readJsonl(jp);
      all.sort((a, b) => b.lastObserved.localeCompare(a.lastObserved));
      return all;
    }
    // Fallback: scan the store. Stored filePaths are workspace-absolute
    // (chunkToRow normalizes), so match quirks on basename, not prefix.
    const filePaths = await deps.store.getFilePaths();
    const quirkPaths = filePaths.filter((fp) => path.basename(fp).startsWith(QUIRK_FILE_PREFIX));
    const result: Quirk[] = [];
    for (const fp of quirkPaths) {
      const chunks = await deps.store.getChunksByFilePath(fp);
      for (const c of chunks) {
        result.push({
          id: c.id,
          content: c.content,
          quirkType: c.metadata.quirkType,
          tags: c.metadata.tags ?? [],
          confidence: c.metadata.confidence ?? 1,
          lastObserved: c.metadata.lastObserved ?? "",
          sourceRef: undefined,
        });
      }
    }
    result.sort((a, b) => b.lastObserved.localeCompare(a.lastObserved));
    return result;
  }
  const all = [...memQuirksFor(deps.storePath).values()];
  all.sort((a, b) => b.lastObserved.localeCompare(a.lastObserved));
  return all;
}

/** Dependencies for {@link reconcileQuirks} — like {@link QuirkStoreDeps}, but
 *  the keyword index is optional (index passes may run without one). */
export interface QuirkReconcileDeps extends Omit<QuirkStoreDeps, "keywordIndex"> {
  keywordIndex?: KeywordIndex;
}

/** Outcome of a {@link reconcileQuirks} run. Zeroes mean "already consistent". */
export interface QuirkReconcileResult {
  /** Quirks re-embedded and restored into the vector store (were in quirks.jsonl but not the table). */
  restoredToStore: number;
  /** Quirks added to the in-memory keyword index (lexical only — no embedding involved). */
  addedToKeywordIndex: number;
  /** Store quirk chunks deleted because their quirks.jsonl entry is gone (past the grace window). */
  removedOrphans: number;
}

/**
 * Store-dir artifact recording when each orphaned store quirk (in the table but
 * absent from quirks.jsonl) was FIRST observed as an orphan. Deletion requires
 * the orphan to be seen again at least {@link QUIRK_ORPHAN_GRACE_MS} later.
 *
 * Two-sighting instead of a row timestamp because the table has no
 * `lastObserved` column (ChunkRow never stored it), and because `addQuirk`
 * writes the store BEFORE appending to quirks.jsonl — a quirk that is
 * momentarily store-only is an in-flight add and must never be race-deleted.
 * The file makes the grace window work across processes (plugin/CLI/watcher
 * each run their own reconcile).
 */
const QUIRK_ORPHAN_STATE_FILE = "quirk-orphans.json";
const QUIRK_ORPHAN_GRACE_MS = 60 * 60 * 1000;

/**
 * Reconcile `quirks.jsonl` (the source of truth for quirk memory) into the
 * vector store and the keyword index, in both directions.
 *
 * Why this exists: full store rebuilds rebuild the table from **workspace
 * files only** — `swapStoreDirectories` carries `quirks.jsonl` across the swap,
 * but nothing ever re-embeds those entries, so every quirk added before a
 * rebuild silently vanishes from recall while `quirk list`/`lint` (which read
 * the jsonl) still show it. The keyword index has the same gap: it only gains
 * quirks via in-process `addQuirk`, and any process that saves its in-memory
 * index clobbers entries added elsewhere.
 *
 * Behavior:
 * - Restores jsonl quirks missing from the store (one batched embed call).
 * - Adds jsonl quirks missing from the keyword index (no embedding needed).
 * - Deletes store quirk chunks whose jsonl entry is gone — only when the jsonl
 *   exists and parses non-empty (a missing/unreadable file means "unknown",
 *   never "empty") and only after the orphan was observed twice across
 *   {@link QUIRK_ORPHAN_GRACE_MS} (see QUIRK_ORPHAN_STATE_FILE — the table has
 *   no row timestamps, and addQuirk writes the store before the jsonl append).
 * - Persists the keyword index when it changed (best-effort).
 *
 * Idempotent and safe under concurrent runs: `store.addChunks` dedups by id and
 * `KeywordIndex.addChunks` overwrites by id. Never applied to memory stores
 * (per-process lifetime, nothing on disk to drift). Failures propagate to the
 * caller, which is expected to treat reconcile as best-effort.
 *
 * @param deps - Embedder, store, optional keyword index, config, store path.
 * @returns Counts of what changed (all zero when already consistent).
 */
export async function reconcileQuirks(deps: QuirkReconcileDeps): Promise<QuirkReconcileResult> {
  const result: QuirkReconcileResult = { restoredToStore: 0, addedToKeywordIndex: 0, removedOrphans: 0 };
  if (isMemoryStore(deps.storePath)) return result;

  const jsonlFile = jsonlPath(deps.storePath);
  const jsonlExists = existsSync(jsonlFile);
  const quirks = jsonlExists ? readJsonl(jsonlFile) : [];
  const jsonlIds = new Set(quirks.map((q) => q.id));

  // Exact enumeration of quirk chunks in the table. The store normalizes
  // filePaths to absolute on write (chunkToRow → normalizeFilePath), so quirk
  // rows read back as "<root>/quirk:<id>" — match on the basename, which is
  // always QUIRK_FILE_PREFIX + id, and keep the stored path for lookups/deletes
  // (deleteByFilePath normalizes its arg; passing the stored absolute path
  // matches regardless of this process's cwd).
  const quirkRows: Array<{ filePath: string; id: string }> = [];
  for (const p of await deps.store.getFilePaths()) {
    const base = path.basename(p);
    if (base.startsWith(QUIRK_FILE_PREFIX)) {
      quirkRows.push({ filePath: p, id: base.slice(QUIRK_FILE_PREFIX.length) });
    }
  }
  const storeIds = new Set(quirkRows.map((r) => r.id));

  // 1. Restore jsonl quirks the table is missing (the rebuild-wipe direction).
  const missing = quirks.filter((q) => !storeIds.has(q.id));
  if (missing.length > 0) {
    const prefix = deps.cfg.embedding.documentPrefix ?? "";
    const embeddings = await deps.embedder.embed(missing.map((q) => prefix + q.content), "document");
    if (embeddings.length !== missing.length || embeddings.some((e) => !e || e.length === 0)) {
      throw new Error("Embedding returned empty vector(s) while reconciling quirks");
    }
    // Single batched write = single transaction; addChunks dedups by id, so a
    // concurrent reconcile adding the same quirks converges instead of duplicating.
    await deps.store.addChunks(missing.map((q, i) => quirkChunk(q, embeddings[i]!)));
    result.restoredToStore = missing.length;
    for (const q of missing) storeIds.add(q.id); // keep orphan pass below consistent
  }

  // 2. Ensure every jsonl quirk is in the keyword index. Lexical only — the
  //    keyword index never looks at embeddings, so this needs no provider.
  let kiDirty = false;
  if (deps.keywordIndex) {
    for (const q of quirks) {
      if (deps.keywordIndex.hasChunk(q.id)) continue;
      deps.keywordIndex.addChunks([quirkChunk(q, [])]);
      result.addedToKeywordIndex++;
      kiDirty = true;
    }
  }

  // 3. Orphan direction: store quirks whose jsonl entry is gone. Runs only when
  //    the jsonl exists AND parses to at least one quirk (a missing or wholly
  //    unreadable jsonl means "unknown", never "empty" — never mass-delete on
  //    it). Each orphan must be observed twice, spanning the grace window,
  //    before deletion — see QUIRK_ORPHAN_STATE_FILE.
  if (jsonlExists && quirks.length > 0) {
    const suspectsPath = path.join(deps.storePath, QUIRK_ORPHAN_STATE_FILE);
    const suspects: Record<string, number> = (() => {
      try {
        const parsed = JSON.parse(readFileSync(suspectsPath, "utf-8")) as Record<string, number>;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    })();
    let suspectsDirty = false;
    const now = Date.now();

    for (const { filePath, id } of quirkRows) {
      if (jsonlIds.has(id)) {
        if (id in suspects) { delete suspects[id]; suspectsDirty = true; } // regained its jsonl entry
        continue;
      }
      const firstSeen = suspects[id];
      if (firstSeen === undefined) {
        suspects[id] = now; // first sighting — keep (may be an in-flight add)
        suspectsDirty = true;
        continue;
      }
      if (now - firstSeen < QUIRK_ORPHAN_GRACE_MS) continue;
      await deps.store.deleteByFilePath(filePath);
      deps.keywordIndex?.removeByFilePath(filePath);
      delete suspects[id];
      result.removedOrphans++;
      kiDirty = true;
      suspectsDirty = true;
    }
    // Prune suspects that no longer exist in the store (jsonl regained them,
    // a rebuild dropped them, or a previous reconcile deleted them).
    for (const id of Object.keys(suspects)) {
      if (!storeIds.has(id)) { delete suspects[id]; suspectsDirty = true; }
    }

    if (suspectsDirty) {
      try {
        if (Object.keys(suspects).length === 0) rmSync(suspectsPath, { force: true });
        else writeFileSync(suspectsPath, JSON.stringify(suspects, null, 2));
      } catch {
        // best-effort — worst case the grace restarts for unmarked orphans
      }
    }
  }

  // 4. Persist the keyword index so the NEXT process to load it inherits the
  //    reconciled state (this is what stops pass-end saves from clobbering
  //    quirks added by other processes). Best-effort: a failed save leaves the
  //    in-memory index correct; the next reconcile re-saves.
  if (kiDirty && deps.keywordIndex) {
    try {
      await deps.keywordIndex.save(deps.storePath);
    } catch {
      // best-effort
    }
  }

  return result;
}

/** Recall quirks matching a query, with confidence re-weighting. */
export async function recallQuirks(
  deps: QuirkStoreDeps,
  query: string,
  options?: {
    topK?: number;
    quirkType?: string;
    tags?: string[];
    /** Override recallMinScore from config. Used by auto-inject for a lower threshold. */
    minScore?: number;
  },
): Promise<SearchResult[]> {
  const topK = options?.topK ?? 10;
  const minConfidence = deps.cfg.memory?.minConfidence ?? 0.5;
  // NOTE: do NOT put quirkType into `filter.languages` — quirk chunks store
  // the type in metadata.quirkType, not metadata.language ("quirk").
  // A languages filter would exclude every quirk chunk and return zero hits.
  // Type filtering happens in the post-filter below instead.
  const filter: { kinds: string[] } = { kinds: ["quirk"] };

  const recallMinScore = options?.minScore ?? deps.cfg.memory?.recallMinScore ?? 0.72;
  const raw = await retrieve(query, deps.embedder, deps.store, {
    topK: topK * 3,
    minScore: recallMinScore,
    keywordIndex: deps.keywordIndex,
    keywordWeight: deps.cfg.retrieval.hybridSearch?.keywordWeight,
    hybridEnabled: true,
    queryPrefix: deps.cfg.embedding.queryPrefix,
    filter,
  });

  // Confidence re-weighting + type/tag filtering
  const filtered = raw.filter((r) => {
    const conf = r.chunk.metadata.confidence ?? 1;
    if (conf < minConfidence) return false;
    if (options?.quirkType && r.chunk.metadata.quirkType !== options.quirkType) return false;
    if (options?.tags?.length) {
      const chunkTags = r.chunk.metadata.tags ?? [];
      if (!options.tags.some((t) => chunkTags.includes(t))) return false;
    }
    return true;
  });

  // Re-weight score by confidence, re-sort
  for (const r of filtered) {
    const conf = r.chunk.metadata.confidence ?? 1;
    r.score = r.score * Math.min(1, Math.max(0.01, conf));
  }
  filtered.sort((a, b) => b.score - a.score);
  return filtered.slice(0, topK);
}

/** Lint quirks for low confidence, staleness, duplicates, and orphan source refs. */
export async function lintQuirks(deps: QuirkStoreDeps): Promise<string[]> {
  const issues: string[] = [];
  const quirks = await listQuirks(deps);
  const cfg = deps.cfg.memory;

  for (const q of quirks) {
    if (q.confidence < (cfg?.minConfidence ?? 0.5)) {
      issues.push(`Low confidence (${q.confidence}): "${q.content}" [${q.id}]`);
    }

    if (cfg?.decay?.enabled && q.lastObserved) {
      const ageDays = (Date.now() - new Date(q.lastObserved).getTime()) / 86_400_000;
      const halfLife = cfg.decay.halfLifeDays;
      if (halfLife > 0 && ageDays > halfLife * 2) {
        issues.push(`Stale (${Math.round(ageDays)}d old): "${q.content}" [${q.id}]`);
      }
    }
  }

  // Duplicate detection (lexically similar content)
  for (let i = 0; i < quirks.length; i++) {
    for (let j = i + 1; j < quirks.length; j++) {
      const sim = lexicalSimilarity(quirks[i]!.content, quirks[j]!.content);
      if (sim > 0.85) {
        issues.push(
          `Near-duplicate (${(sim * 100).toFixed(0)}% similar): "${quirks[i]!.content}" â†” "${quirks[j]!.content}"`,
        );
      }
    }
  }

  return issues;
}

/** Simple Jaccard-based lexical similarity (word overlap). */
export function lexicalSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

/**
 * Count of meaningful word tokens shared between two texts (Jaccard numerator).
 *
 * Tokens are whitespace/punctuation-split, lowercased, and filtered to those
 * with length â‰¥ `minTokenLen` (default 3 â€” skips short filler like "the").
 *
 * Used by the quirk auto-inject gate: candidate quirks that share no tokens
 * with the user's *current* message (i.e. they matched only against the prior
 * assistant text in the combined recall query) are filtered out. This prevents
 * meta-quirks (quirks about quirks themselves) from being injected into
 * unrelated tasks, e.g. when the agent previously explained how quirks work.
 *
 * Set `memory.autoInjectMinTokenOverlap` to `0` to disable the gate.
 */
export function sharedWords(a: string, b: string, minTokenLen = 3): number {
  const tokensA = a.toLowerCase().split(/\W+/).filter((w) => w.length >= minTokenLen);
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length >= minTokenLen));
  let count = 0;
  const seen = new Set<string>();
  for (const tok of tokensA) {
    if (wordsB.has(tok) && !seen.has(tok)) {
      seen.add(tok);
      count++;
    }
  }
  return count;
}
