/**
 * @fileoverview Batches chunks for embedding generation.
 */
import type { Chunk, EmbeddingProvider } from "../core/interfaces.js";
import { embedBatch } from "../embedder/factory.js";

/** Options for embedding a batch of chunks. */
export interface EmbedChunksOptions {
  chunks: Chunk[];
  embedder: EmbeddingProvider;
  batchSize: number;
  concurrency: number;
}

/**
 * Generate embeddings for chunks that don't already have one.
 * Skips chunks that already have a valid embedding vector.
 *
 * @param chunks - Chunks to embed; existing embeddings are preserved in-place.
 * @param embedder - Embedding provider for vector generation.
 * @param batchSize - Number of texts to embed per batch.
 * @param concurrency - Number of concurrent embedding requests.
 * @returns The same chunk array with embeddings attached.
 */
export async function embedChunks({
  chunks,
  embedder,
  batchSize,
  concurrency,
}: EmbedChunksOptions): Promise<Chunk[]> {
  if (chunks.length === 0) return [];

  const textsToEmbed: string[] = [];
  const chunkIndices: number[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    if (chunk.embedding && chunk.embedding.length > 0) continue;
    const text = "Description: " + "\n" + (chunk.description || "") + "\n" + "Content:" + "\n" + chunk.content;
    textsToEmbed.push(text);
    chunkIndices.push(i);
  }

  if (textsToEmbed.length > 0) {
    const embeddings = await embedBatch(embedder, textsToEmbed, batchSize, "document", concurrency);

    for (let i = 0; i < chunkIndices.length; i++) {
      const chunkIdx = chunkIndices[i]!;
      const emb = embeddings[i];
      if (Array.isArray(emb) && emb.length > 0 && typeof emb[0] === "number") {
        chunks[chunkIdx]!.embedding = emb as number[];
      }
    }
  }

  return chunks;
}
