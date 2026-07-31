import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

/** In-memory backup for memory:// stores. */
const memQuirks = new Map<string, Quirk>();

function readJsonl(filePath: string): Quirk[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf-8").trim();
  if (!raw) return [];
  return raw.split("\n").map((l) => JSON.parse(l) as Quirk);
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
  writeFileSync(filePath, quirks.map((q) => JSON.stringify(q)).join("\n") + "\n", "utf-8");
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
  return memQuirks.get(id);
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
  await deps.store.deleteByFilePath(filePath);
  deps.keywordIndex.removeByFilePath(filePath);

  const prefix = deps.cfg.embedding.documentPrefix ?? "";
  const chunkContent = prefix + content;
  const embeddings = await deps.embedder.embed([chunkContent], "document");
  const embedding = embeddings[0];
  if (!embedding || embedding.length === 0) {
    throw new Error("Embedding returned empty vector for quirk content");
  }

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
    memQuirks.set(id, updated);
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

  const chunk = {
    id,
    content: input.content,
    description: "",
    embedding,
    metadata: {
      filePath: QUIRK_FILE_PREFIX + id,
      startLine: 0,
      endLine: 0,
      language: "quirk",
      kind: "quirk",
      quirkType: input.quirkType,
      tags: input.tags ?? [],
      confidence,
      lastObserved,
    },
  };

  await deps.store.addChunks([chunk]);
  deps.keywordIndex.addChunks([chunk]);

  if (!isMemoryStore(deps.storePath)) {
    appendJsonl(jsonlPath(deps.storePath), quirk);
  } else {
    memQuirks.set(id, quirk);
  }

  return quirk;
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
    memQuirks.delete(id);
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
    // Fallback: scan the store
    const filePaths = await deps.store.getFilePaths();
    const quirkPaths = filePaths.filter((fp) => fp.startsWith(QUIRK_FILE_PREFIX));
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
  const all = [...memQuirks.values()];
  all.sort((a, b) => b.lastObserved.localeCompare(a.lastObserved));
  return all;
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
  const filter: { kinds: string[]; languages?: string[] } = { kinds: ["quirk"] };
  if (options?.quirkType) {
    filter.languages = [options.quirkType];
  }

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
          `Near-duplicate (${(sim * 100).toFixed(0)}% similar): "${quirks[i]!.content}" ↔ "${quirks[j]!.content}"`,
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
 * with length ≥ `minTokenLen` (default 3 — skips short filler like "the").
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
