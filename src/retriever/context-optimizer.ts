/**
 * @fileoverview Post-retrieval optimization: adjacent merging, similarity dedup, and file-level diversity capping.
 */
import { tokenize } from "./keyword-index.js";
import type { Chunk, OptimizedSearchResult, SearchResult } from "../core/interfaces.js";

/** Configuration for post-retrieval context window optimization. */
export interface ContextOptimizationConfig {
  /** Whether context window optimization is enabled. */
  enabled: boolean;
  /** Maximum number of chunks to keep per file (0 = unlimited). */
  maxPerFile: number;
  /** Whether to merge adjacent chunks from the same file. */
  mergeAdjacent: boolean;
  /** Maximum line gap between adjacent chunks that can still be merged. */
  adjacentGapThreshold: number;
  /** Jaccard similarity threshold (0-1) for same-file dedup. */
  similarityThreshold: number;
}

/** Options passed to the optimizeContext function. */
export interface ContextOptimizationOptions {
  /** Target number of results to return after optimization. */
  topK: number;
  /** Optimization configuration. */
  config: ContextOptimizationConfig;
}

/**
 * Default context optimization configuration values.
 *
 * - enabled: true
 * - maxPerFile: 3
 * - mergeAdjacent: true
 * - adjacentGapThreshold: 5
 * - similarityThreshold: 0.8
 */
export const DEFAULT_CONTEXT_OPTIMIZATION: ContextOptimizationConfig = {
  enabled: true,
  maxPerFile: 3,
  mergeAdjacent: true,
  adjacentGapThreshold: 5,
  similarityThreshold: 0.8,
};

/**
 * Wrap a SearchResult as an OptimizedSearchResult with no optimization metadata.
 */
function toOptimized(r: SearchResult): OptimizedSearchResult {
  return { chunk: r.chunk, score: r.score, explanation: r.explanation };
}

/**
 * Compute Jaccard similarity between two strings based on their token sets.
 * Accepts a per-call token cache so repeated comparisons (the dedup loop is
 * O(n²) over same-file pairs) don't re-tokenize the same content every time.
 */
function jaccardSimilarity(a: string, b: string, tokenCache: Map<string, Set<string>>): number {
  let tokensA = tokenCache.get(a);
  if (!tokensA) {
    tokensA = new Set(tokenize(a));
    tokenCache.set(a, tokensA);
  }
  let tokensB = tokenCache.get(b);
  if (!tokensB) {
    tokensB = new Set(tokenize(b));
    tokenCache.set(b, tokensB);
  }
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Phase 1: Merge adjacent chunks from the same file.
 *
 * Given chunks sorted by line number, merges consecutive chunks whose
 * start-to-end gap is <= gapThreshold. Merged chunks concatenate content,
 * take the higher score, and track original IDs in mergedFrom.
 */
function mergeAdjacentChunks(
  results: SearchResult[],
  gapThreshold: number
): OptimizedSearchResult[] {
  if (results.length <= 1) return results.map(toOptimized);

  const sorted = [...results].sort(
    (a, b) => a.chunk.metadata.startLine - b.chunk.metadata.startLine
  );
  const merged: OptimizedSearchResult[] = [];

  let pending: OptimizedSearchResult = toOptimized(sorted[0]!);

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!;
    const gap = current.chunk.metadata.startLine - pending.chunk.metadata.endLine;

    // gapThreshold + 1 to treat L1-40, L41-80 as adjacent (gap=1)
    if (gap <= gapThreshold + 1) {
      const sourceIds: string[] = [
        ...(pending.optimized?.mergedFrom ?? [pending.chunk.id]),
        current.chunk.id,
      ];

      const mergedChunk: Chunk = {
        id: `merged:${sourceIds.join("+")}`,
        content: pending.chunk.content + "\n" + current.chunk.content,
        description: [pending.chunk.description, current.chunk.description]
          .filter(Boolean)
          .join("\n") || undefined,
        metadata: {
          ...pending.chunk.metadata,
          endLine: current.chunk.metadata.endLine,
        },
      };

      pending = {
        chunk: mergedChunk,
        score: Math.max(pending.score, current.score),
        optimized: { mergedFrom: sourceIds },
      };
    } else {
      merged.push(pending);
      pending = toOptimized(current);
    }
  }
  if (pending) merged.push(pending);

  return merged;
}

/**
 * Phase 2: Deduplicate similar chunks from the same file.
 *
 * For each pair within a file group, if Jaccard similarity exceeds the
 * threshold, the lower-scored chunk is removed and its ID tracked on
 * the kept chunk's dedupedFrom list.
 */
function dedupeSimilar(
  results: OptimizedSearchResult[],
  threshold: number
): OptimizedSearchResult[] {
  if (results.length <= 1) return results;

  const kept: OptimizedSearchResult[] = [...results];
  // Token cache shared across all pair comparisons of this group — the
  // dedup loop is O(n²) over pairs and was re-tokenizing full chunk
  // contents on every comparison.
  const tokenCache = new Map<string, Set<string>>();
  let changed = true;

  while (changed) {
    changed = false;
    for (let i = 0; i < kept.length; i++) {
      for (let j = i + 1; j < kept.length; j++) {
        const sim = jaccardSimilarity(
          kept[i]!.chunk.content,
          kept[j]!.chunk.content,
          tokenCache,
        );
        if (sim > threshold) {
          const [keepIdx, removeIdx] =
            kept[i]!.score >= kept[j]!.score ? [i, j] : [j, i];
          const removedId = kept[removeIdx]!.chunk.id;
          kept.splice(removeIdx, 1);
          kept[keepIdx] = {
            ...kept[keepIdx]!,
            optimized: {
              ...kept[keepIdx]!.optimized,
              dedupedFrom: [
                ...(kept[keepIdx]!.optimized?.dedupedFrom ?? []),
                removedId,
              ],
            },
          };
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }

  return kept;
}

/**
 * Optimize search results by applying adjacent merging, similarity dedup,
 * and file-level diversity capping. The optimization is O(N log N) with no
 * additional LLM calls.
 *
 * Pipeline: merge adjacent -> dedup similar (same-file) -> file-level cap ->
 * backfill from reserve -> sort + slice to topK.
 *
 * @param results - Raw search results from retrieve()
 * @param options - Optimization parameters including target topK and config
 * @returns Optimized results wrapped as OptimizedSearchResult[]
 */
export function optimizeContext(
  results: SearchResult[],
  options: ContextOptimizationOptions
): OptimizedSearchResult[] {
  if (!options.config.enabled) {
    return results.map(toOptimized);
  }
  if (results.length === 0) return [];

  // Group by file path for same-file optimizations (Phases 1 & 2)
  const byFile = new Map<string, SearchResult[]>();
  for (const r of results) {
    const fp = r.chunk.metadata.filePath;
    const group = byFile.get(fp);
    if (group) group.push(r);
    else byFile.set(fp, [r]);
  }

  const allProcessed: (OptimizedSearchResult & { filePath: string })[] = [];
  const fileTotalCounts = new Map<string, number>();

  for (const [, fileResults] of byFile) {
    // Phase 1: Adjacent merge
    let processed = options.config.mergeAdjacent
      ? mergeAdjacentChunks(fileResults, options.config.adjacentGapThreshold)
      : fileResults.map(toOptimized);

    // Phase 2: Similarity dedup (same-file only)
    processed = dedupeSimilar(processed, options.config.similarityThreshold);

    fileTotalCounts.set(fileResults[0]!.chunk.metadata.filePath, processed.length);

    for (const r of processed) {
      allProcessed.push({ ...r, filePath: r.chunk.metadata.filePath });
    }
  }

  // Phase 3: Greedy selection — sort all items by score, pick best while
  // respecting per-file diversity cap. This ensures strictly at most
  // maxPerFile items per file in the final result.
  allProcessed.sort((a, b) => b.score - a.score);

  const selected: (OptimizedSearchResult & { filePath: string })[] = [];
  const selectedCounts = new Map<string, number>();
  const maxPerFile = options.config.maxPerFile;

  for (const item of allProcessed) {
    if (selected.length >= options.topK) break;
    const fp = item.filePath;
    const count = selectedCounts.get(fp) ?? 0;
    if (maxPerFile > 0 && count >= maxPerFile) continue;
    selectedCounts.set(fp, count + 1);
    selected.push(item);
  }

  // Track fileCapped: a file was "capped" if it had more items in the input
  // than maxPerFile, and at least one of its items was excluded by the cap.
  for (const s of selected) {
    const totalFromFile = fileTotalCounts.get(s.filePath) ?? 0;
    const selectedFromFile = selectedCounts.get(s.filePath) ?? 0;
    const fileWasCapped = maxPerFile > 0 && totalFromFile > maxPerFile && selectedFromFile >= maxPerFile;
    (s as { optimized?: { fileCapped: boolean } }).optimized = { ...s.optimized, fileCapped: fileWasCapped };
  }

  // Strip the temporary filePath field and return
  return selected.map(({ filePath: _fp, ...rest }) => rest);
}
