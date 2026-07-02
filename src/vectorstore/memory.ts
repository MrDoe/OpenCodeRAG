/**
 * @fileoverview Ephemeral in-memory vector store using cosine similarity search.
 */
import type { VectorStore, Chunk, SearchResult, MetadataFilter } from "../core/interfaces.js";

/** Ephemeral in-memory vector store using cosine similarity search. */
export class InMemoryVectorStore implements VectorStore {
  private chunks: Chunk[] = [];

  async addChunks(chunks: Chunk[]): Promise<void> {
    this.chunks.push(...chunks.filter((c) => c.embedding && c.embedding.length > 0));
  }

  async search(embedding: number[], topK: number): Promise<SearchResult[]> {
    return this.searchWithFilter(embedding, topK);
  }

  async searchWithFilter(embedding: number[], topK: number, filter?: MetadataFilter): Promise<SearchResult[]> {
    const withEmbeddings = this.chunks.filter(
      (c): c is Chunk & { embedding: number[] } =>
        c.embedding !== undefined && c.embedding.length === embedding.length
    );
    const scored = withEmbeddings
      .filter((c) => matchesFilter(c, filter))
      .map((chunk) => {
        const sim = cosineSimilarity(embedding, chunk.embedding);
        return { chunk, score: sim };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored;
  }

  async count(): Promise<number> {
    return this.chunks.length;
  }

  async clear(): Promise<void> {
    this.chunks = [];
  }

  async getFilePaths(): Promise<string[]> {
    const paths = new Set(this.chunks.map((c) => c.metadata.filePath));
    return Array.from(paths);
  }

  /**
   * Remove all chunks associated with a given file path.
   * @param filePath - The file path whose chunks should be removed.
   */
  async deleteByFilePath(filePath: string): Promise<void> {
    this.chunks = this.chunks.filter((c) => c.metadata.filePath !== filePath);
  }

  /** Release any held resources. No-op for the in-memory store. */
  async close(): Promise<void> {
  }
}

/**
 * Compute the cosine similarity between two equal-length vectors.
 * @param a - First vector.
 * @param b - Second vector.
 * @returns The cosine similarity (0 if either vector has zero magnitude).
 */
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
  if (filter.pathPatterns?.length) {
    return filter.pathPatterns.some((p) => globMatch(p, chunk.metadata.filePath));
  }
  return true;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
