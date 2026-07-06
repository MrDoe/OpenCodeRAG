/**
 * @fileoverview Performs hybrid vector-keyword retrieval with configurable scoring and explanation.
 */
import type { EmbeddingProvider, KeywordIndex, VectorStore, SearchResult, MetadataFilter } from "../core/interfaces.js";

/** Multiplier applied to topK when fetching raw results from vector/keyword stores.
 *  We request extra results up-front, then after hybrid fusion + minScore filtering,
 *  we slice back to the requested topK. */
const FETCH_OVERFETCH_FACTOR = 3;
const RRF_K = 60;
/** Multiply raw RRF scores by (K+1) to normalize to ~[0,1]. */
const RRF_NORMALIZE = RRF_K + 1;

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
  filter?: MetadataFilter;
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

    const vectorResults = await store.searchWithFilter(embedding as number[], topK * FETCH_OVERFETCH_FACTOR, options.filter);

    let keywordResults: SearchResult[] = [];
    if (options.keywordIndex && options.hybridEnabled !== false) {
      keywordResults = options.keywordIndex.search(query, topK * FETCH_OVERFETCH_FACTOR, options.filter);
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
    const vRank = new Map<string, number>(vectorResults.map((r, i) => [r.chunk.id, i]));
    const kRank = new Map<string, number>(keywordResults.map((r, i) => [r.chunk.id, i]));

    const chunkById = new Map<string, SearchResult>();
    for (const r of vectorResults) chunkById.set(r.chunk.id, r);
    for (const r of keywordResults) if (!chunkById.has(r.chunk.id)) chunkById.set(r.chunk.id, r);

    const kw = options.keywordWeight ?? 0.4;
    const allIds = new Set<string>([...vRank.keys(), ...kRank.keys()]);
    const combinedResults: SearchResult[] = [...allIds].map((id) => {
      const vR = vRank.get(id);
      const kR = kRank.get(id);
      const vContrib = vR !== undefined ? ((1 - kw) * RRF_NORMALIZE) / (RRF_K + vR + 1) : 0;
      const kContrib = kR !== undefined ? (kw * RRF_NORMALIZE) / (RRF_K + kR + 1) : 0;
      const score = vContrib + kContrib;
      const result: SearchResult = { chunk: chunkById.get(id)!.chunk, score };
      if (options.explain) {
        result.explanation = {
          scoreBreakdown: {
            vectorScore: vContrib,
            keywordScore: kContrib,
            rawVectorScore: vR !== undefined ? vectorResults[vR]!.score : 0,
            rawKeywordScore: kR !== undefined ? keywordResults[kR]!.score : 0,
            keywordWeight: kw,
            vectorRank: vR,
            keywordRank: kR,
          },
        };
        if (options.keywordIndex && kR !== undefined) {
          const terms = options.keywordIndex.getMatchedTerms(query, id);
          if (terms.length > 0) result.explanation.matchedTerms = terms;
        }
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
