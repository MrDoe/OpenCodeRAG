/**
 * @fileoverview Performs hybrid vector-keyword retrieval with configurable scoring and explanation.
 */
import type { EmbeddingProvider, KeywordIndex, VectorStore, SearchResult, SearchExplanation } from "../core/interfaces.js";

/** Multiplier applied to topK when fetching raw results from vector/keyword stores.
 *  We request extra results up-front, then after hybrid fusion + minScore filtering,
 *  we slice back to the requested topK. */
const FETCH_OVERFETCH_FACTOR = 3;

/** Options controlling the retrieval behavior. */
export interface RetrieveOptions {
  topK?: number;
  minScore?: number;
  keywordIndex?: KeywordIndex;
  keywordWeight?: number;
  /** Whether hybrid search is enabled. When false, keyword index is ignored. */
  hybridEnabled?: boolean;
  queryPrefix?: string;
  explain?: boolean;
}

/**
 * Perform hybrid vector-keyword retrieval with configurable scoring.
 *
 * Embeds the query via the provided embedder, searches the vector store, and optionally
 * fuses results with keyword index hits. Results are scored, filtered by minScore, and
 * sliced to topK.
 *
 * @param query - The search query string
 * @param embedder - Embedding provider for vectorizing the query
 * @param store - Vector store to search
 * @param options - Optional retrieval parameters (topK, minScore, keywordIndex, keywordWeight, queryPrefix, explain)
 * @returns Array of search results sorted by descending score
 */
export async function retrieve(
  query: string,
  embedder: EmbeddingProvider,
  store: VectorStore,
  options: RetrieveOptions = {}
): Promise<SearchResult[]> {
  try {
    const topK = options.topK ?? 10;
    const minScore = options.minScore ?? 0;

    const prefixedQuery = (options.queryPrefix ?? "") + query;
    const embeddings = await embedder.embed([prefixedQuery], "query");
    const embedding = embeddings[0];
    if (!embedding || embedding.length === 0) {
      return [];
    }

    if (typeof embedding[0] !== "number") {
      return [];
    }

    const vectorResults = await store.search(embedding as number[], topK * FETCH_OVERFETCH_FACTOR);

    let keywordResults: SearchResult[] = [];
    if (options.keywordIndex && options.hybridEnabled !== false) {
      keywordResults = options.keywordIndex.search(query, topK * FETCH_OVERFETCH_FACTOR);
    }

    if (keywordResults.length === 0) {
      const filtered = vectorResults.filter((r) => r.score >= minScore).slice(0, topK);
      if (options.explain) {
        const kw = options.keywordWeight ?? 0.4;
        for (const r of filtered) {
          r.explanation = {
            scoreBreakdown: {
              vectorScore: r.score,
              keywordScore: 0,
              rawVectorScore: r.score,
              rawKeywordScore: 0,
              keywordWeight: kw,
            },
          };
        }
      }
      return filtered;
    }

    const kwTopScore = keywordResults.length > 0 ? keywordResults[0]!.score : 1;
    const vTopScore = vectorResults.length > 0 ? vectorResults[0]!.score : 1;

    const combined = new Map<string, {
      chunk: SearchResult["chunk"];
      vScore: number;
      kScore: number;
      rawVScore: number;
      rawKScore: number;
    }>();

    for (const r of vectorResults) {
      combined.set(r.chunk.id, {
        chunk: r.chunk,
        vScore: r.score,
        kScore: 0,
        rawVScore: r.score,
        rawKScore: 0,
      });
    }

    for (const r of keywordResults) {
      const existing = combined.get(r.chunk.id);
      const normalizedK = kwTopScore > 0 ? r.score / kwTopScore : 0;
      if (existing) {
        existing.kScore = normalizedK;
        existing.rawKScore = r.score;
      } else {
        combined.set(r.chunk.id, {
          chunk: r.chunk,
          vScore: 0,
          kScore: normalizedK,
          rawVScore: 0,
          rawKScore: r.score,
        });
      }
    }

    const kw = options.keywordWeight ?? 0.4;
    const combinedResults: SearchResult[] = [...combined.values()]
      .map((entry) => {
        const hasVector = entry.vScore > 0;
        const hasKeyword = entry.kScore > 0;
        const normV = vTopScore > 0 ? entry.vScore / vTopScore : 0;
        const score = hasVector && hasKeyword
          ? (1 - kw) * normV + kw * entry.kScore
          : hasVector
            ? (1 - kw) * normV
            : entry.kScore * 0.9;
        const result: SearchResult = {
          chunk: entry.chunk,
          score,
        };

        if (options.explain) {
          const explanation: SearchExplanation = {
            scoreBreakdown: {
              vectorScore: normV,
              keywordScore: entry.kScore,
              rawVectorScore: entry.rawVScore,
              rawKeywordScore: entry.rawKScore,
              keywordWeight: kw,
            },
          };

          if (options.keywordIndex && entry.rawKScore > 0) {
            const terms = options.keywordIndex.getMatchedTerms(query, entry.chunk.id);
            if (terms.length > 0) {
              explanation.matchedTerms = terms;
            }
          }

          result.explanation = explanation;
        }

        return result;
      })
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return combinedResults;
  } catch {
    return [];
  }
}
