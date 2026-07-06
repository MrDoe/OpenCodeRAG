/**
 * @fileoverview Core type definitions for the OpenCodeRAG pipeline: Chunk, SearchResult,
 * Chunker, EmbeddingProvider, VectorStore, KeywordIndex, and related interfaces.
 */

/** A semantic fragment of a file produced by a {@link Chunker}. */
export interface Chunk {
  id: string;
  content: string;
  description?: string;
  embedding?: number[];
  metadata: {
    filePath: string;
    startLine: number;
    endLine: number;
    language: string;
    contentType?: string;
  };
}

/** Logger interface for description generation progress messages. */
export interface DescriptionLogger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

/** Generates natural-language descriptions for code chunks using an LLM. */
export interface DescriptionProvider {
  /** Generate a description for a single chunk. */
  generateDescription(chunk: Chunk): Promise<string>;
  /** Generate descriptions for multiple chunks concurrently. Returns a Map of chunk ID to description. */
  generateBatchDescriptions(chunks: Chunk[], logger?: DescriptionLogger): Promise<Map<string, string>>;
}

/** Explains how a search result score was computed, including vector and keyword contributions. */
export interface SearchExplanation {
  /** Breakdown of the fused score components. */
  scoreBreakdown: {
    /** Normalized vector similarity score. */
    vectorScore: number;
    /** Normalized keyword (TF-IDF) score. */
    keywordScore: number;
    /** Raw (unnormalized) vector similarity score before fusion. */
    rawVectorScore: number;
    /** Raw (unnormalized) keyword score before fusion. */
    rawKeywordScore: number;
    /** Weight applied to keyword score during fusion (0-1). */
    keywordWeight: number;
    /** Rank (0-indexed) in the vector store results. */
    vectorRank?: number;
    /** Rank (0-indexed) in the keyword index results. */
    keywordRank?: number;
  };
  /** Query terms that matched in the keyword index, if hybrid search was used. */
  matchedTerms?: string[];
}

/** A single result from a vector or hybrid search query. */
export interface SearchResult {
  /** The matched chunk of content. */
  chunk: Chunk;
  /** Relevance score between 0 and 1. */
  score: number;
  /** Optional breakdown of how the score was computed. */
  explanation?: SearchExplanation;
}

/** A search result enriched with metadata from context window optimization (adjacent merge, similarity dedup, file cap). */
export interface OptimizedSearchResult extends SearchResult {
  /** Metadata about optimizations applied to this result. */
  optimized?: {
    /** IDs of original chunks that were merged into this result. */
    mergedFrom?: string[];
    /** IDs of chunks that were removed due to high similarity in favor of this one. */
    dedupedFrom?: string[];
    /** Whether this chunk was kept despite its file exceeding the per-file cap. */
    fileCapped?: boolean;
  };
}

/** Splits a source file into semantic chunks based on AST structure or content heuristics. */
export interface Chunker {
  /** Human-readable language name (e.g. "TypeScript", "Python"). */
  readonly language: string;
  /** File extensions this chunker handles (e.g. [".ts", ".tsx"]). */
  readonly fileExtensions?: string[];
  /** Split the file content into chunks. */
  chunk(filePath: string, content: string): Promise<Chunk[]>;
}

/** Generates vector embeddings for text inputs via a configured model (Ollama, OpenAI, Cohere, etc.). */
export interface EmbeddingProvider {
  /** Provider name (e.g. "ollama", "openai", "cohere"). */
  readonly name: string;
  /** Embed one or more text strings. `purpose` may apply a prefix for query vs. document embeddings. */
  embed(texts: string[], purpose?: "query" | "document"): Promise<number[][]>;
}

/** In-memory TF-IDF inverted index for keyword-based search alongside vector search. */
export interface KeywordIndex {
  /** Release resources and free memory. */
  close(): void;
  /** Index a set of chunks by tokenizing their content. */
  addChunks(chunks: Chunk[]): void;
  /** Remove all entries for a given file path from the index. */
  removeByFilePath(filePath: string): void;
  /** Search the index for the top-K matching chunks. */
  search(query: string, topK: number, filter?: MetadataFilter): SearchResult[];
  /** Get the terms from a query that matched a specific chunk. */
  getMatchedTerms(query: string, chunkId: string): string[];
  /** Clear all indexed data. */
  clear(): void;
  /** Return the total number of indexed chunks. */
  count(): number;
  /** Persist the index to disk as JSON. */
  save(filePath?: string): Promise<void>;
}

/** Persistent vector storage and retrieval backend (LanceDB or in-memory). */
export interface VectorStore {
  /** Store a batch of chunks with their embeddings. */
  addChunks(chunks: Chunk[]): Promise<void>;
  /** Search for the top-K nearest neighbor chunks by embedding similarity. */
  search(embedding: number[], topK: number): Promise<SearchResult[]>;
  /** Search with optional metadata filtering. */
  searchWithFilter(embedding: number[], topK: number, filter?: MetadataFilter): Promise<SearchResult[]>;
  /** Return the total number of stored chunks. */
  count(): Promise<number>;
  /** Remove all stored data. */
  clear(): Promise<void>;
  /** Delete all chunks associated with a specific file path. */
  deleteByFilePath(filePath: string): Promise<void>;
  /** Return all unique file paths currently stored in the index. */
  getFilePaths(): Promise<string[]>;
  /** Release any held resources and close the store. */
  close(): Promise<void>;
}

/** Filter criteria for narrowing search results by file path patterns or language. */
export interface MetadataFilter {
  /** Glob-style path patterns (e.g. "src/**", "lib/auth/*"). */
  pathPatterns?: string[];
  /** Language identifiers (e.g. ["typescript", "tsx"]). */
  languages?: string[];
}

/** Callback interface for reporting indexing progress to the UI or CLI. */
export interface IndexProgress {
  /** Set the total number of files to be indexed. */
  setFileCount(count: number): void;
  /** Called when a new file begins indexing. */
  startFile(label: string): void;
  /** Called when a pipeline stage completes for the current file. */
  finishStage(label: string): void;
  /** Called when a file is fully processed. */
  finishFile(label: string): void;
  /** Called when indexing fails for a file. */
  failFile(label: string): void;
}
