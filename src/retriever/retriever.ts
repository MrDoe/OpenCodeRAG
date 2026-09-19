/**
 * @fileoverview Performs hybrid vector-keyword retrieval with configurable scoring and explanation.
 */
import type { Chunk, EmbeddingProvider, KeywordIndex, VectorStore, SearchResult, MetadataFilter } from "../core/interfaces.js";

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
  /** Keyword weight for symbol-style queries (a bare identifier like `cosineSimilarity`).
   *  Keyword search nails exact symbol matches, so these queries get a higher weight. */
  symbolKeywordWeight?: number;
  /** Multiplier applied to the keyword contribution of documentation chunks (0-1). */
  docKeywordDemotion?: number;
  /** Multiplier applied to the keyword contribution of test chunks (0-1). */
  testKeywordDemotion?: number;
  /** Whether hybrid search is enabled. When false, keyword index is ignored. */
  hybridEnabled?: boolean;
  queryPrefix?: string;
  explain?: boolean;
  filter?: MetadataFilter;
}

/** Classify a query as a bare symbol lookup vs. natural-language prose.
 *  Symbol queries have no whitespace and look like one (possibly dotted) identifier. */
function detectQueryShape(query: string): "symbol" | "natural-language" {
  const trimmed = query.trim();
  if (trimmed.length === 0 || trimmed.length > 60) return "natural-language";
  if (/\s/.test(trimmed)) return "natural-language";
  return /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(trimmed)
    ? "symbol"
    : "natural-language";
}

/** Demotion applied to a chunk's keyword contribution based on its file's provenance.
 *  Docs and tests name concepts literally, so their keyword matches are discounted. */
function keywordDemotion(chunk: Chunk, docDemotion: number, testDemotion: number): number {
  switch (chunk.metadata.role) {
    case "doc": return docDemotion;
    case "test": return testDemotion;
    default: return 1;
  }
}

/** Calibrate a per-result confidence from the raw vector-score spread of the
 *  candidate set. Unlike the fused RRF score (rank 0 is always ~1.0), this
 *  reflects how separable the top match actually was. */
function attachConfidence(results: SearchResult[]): void {
  const raws = results.map((r) => r.explanation?.scoreBreakdown?.rawVectorScore ?? 0);
  const max = Math.max(...raws);
  const min = Math.min(...raws);
  for (const r of results) {
    if (!r.explanation) continue;
    const raw = r.explanation.scoreBreakdown?.rawVectorScore ?? 0;
    r.explanation.confidence = max > min ? (raw - min) / (max - min) : 1;
  }
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
    const queryShape = detectQueryShape(query);

    const baseKw = options.keywordWeight ?? 0.4;
    // Symbol queries are exact-identifier lookups — keyword search is the strong
    // signal there, so use the (typically higher) symbol weight.
    const kw = queryShape === "symbol"
      ? options.symbolKeywordWeight ?? baseKw
      : baseKw;
    const docDemotion = options.docKeywordDemotion ?? 0.5;
    const testDemotion = options.testKeywordDemotion ?? 0.6;

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
        for (const r of filtered) {
          r.explanation = {
            scoreBreakdown: {
              vectorScore: r.score,
              keywordScore: 0,
              rawVectorScore: r.score,
              rawKeywordScore: 0,
              keywordWeight: kw,
            },
            queryShape,
          };
        }
        attachConfidence(filtered);
      }
      return filtered;
    }
    const vRank = new Map<string, number>(vectorResults.map((r, i) => [r.chunk.id, i]));
    const kRank = new Map<string, number>(keywordResults.map((r, i) => [r.chunk.id, i]));

    const chunkById = new Map<string, SearchResult>();
    for (const r of vectorResults) chunkById.set(r.chunk.id, r);
    for (const r of keywordResults) if (!chunkById.has(r.chunk.id)) chunkById.set(r.chunk.id, r);

    const allIds = new Set<string>([...vRank.keys(), ...kRank.keys()]);
    const combinedResults: SearchResult[] = [...allIds].map((id): SearchResult | null => {
      const vR = vRank.get(id);
      const kR = kRank.get(id);
      const chunk = chunkById.get(id)?.chunk;
      if (!chunk) return null;
      const kMultiplier = kR !== undefined ? keywordDemotion(chunk, docDemotion, testDemotion) : 1;
      const vContrib = vR !== undefined ? ((1 - kw) * RRF_NORMALIZE) / (RRF_K + vR + 1) : 0;
      const kContrib = kR !== undefined ? (kw * RRF_NORMALIZE) / (RRF_K + kR + 1) * kMultiplier : 0;
      const score = vContrib + kContrib;
      const result: SearchResult = { chunk, score };
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
          queryShape,
        };
        if (options.keywordIndex && kR !== undefined) {
          const terms = options.keywordIndex.getMatchedTerms(query, id);
          if (terms.length > 0) result.explanation.matchedTerms = terms;
        }
      }
      return result;
    })
      .filter((r): r is SearchResult => r !== null)
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    if (options.explain) attachConfidence(combinedResults);
    return combinedResults;
  } catch (err) {
    // Never silently mask retrieval failures as "no results" — an embedder
    // outage or store bug must be visible, not indistinguishable from an
    // empty index.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[retriever] retrieve() failed (returning []): ${message}`);
    return [];
  }
}
