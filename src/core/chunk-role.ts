/**
 * @fileoverview Classifies a chunk's provenance (source / test / doc) from its file path.
 *
 * The retrieval fusion uses this to demote documentation and test chunks when they
 * compete on keyword matches — natural-language queries about "how X works" match
 * doc and test files literally (their prose names the concepts), which otherwise
 * lets them outrank the implementation the query is really after.
 */

import type { Chunk } from "./interfaces.js";

export type ChunkRole = "source" | "test" | "doc";

const TEST_PATH_SEGMENTS = ["__tests__", "test", "tests", "spec", "specs", "fixtures"];
const TEST_BASENAME = /\.(?:test|spec|bench)\.[a-z0-9]+$/i;
const DOC_PATH_SEGMENTS = ["doc", "docs", "documentation"];
const DOC_EXTENSIONS = [".md", ".mdx", ".rst", ".adoc"];

/**
 * Classify the role of a file from its path. Test takes precedence over doc
 * (a `*.test.md` is a test artifact), and everything else is source.
 */
export function classifyFilePath(filePath: string): ChunkRole {
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const basename = segments[segments.length - 1] ?? "";

  if (TEST_BASENAME.test(basename)) return "test";
  if (segments.some((s) => TEST_PATH_SEGMENTS.includes(s.toLowerCase()))) return "test";
  if (DOC_EXTENSIONS.some((ext) => basename.toLowerCase().endsWith(ext))) return "doc";
  if (segments.some((s) => DOC_PATH_SEGMENTS.includes(s.toLowerCase()))) return "doc";
  return "source";
}

/**
 * Tag a chunk with its derived role. Idempotent — a chunk that already carries a
 * role is returned unchanged.
 */
export function tagChunkRole(chunk: Chunk): Chunk {
  if (chunk.metadata.role) return chunk;
  chunk.metadata.role = classifyFilePath(chunk.metadata.filePath);
  return chunk;
}

/** Tag all chunks produced for a file with their derived role. */
export function tagChunksRole(chunks: Chunk[]): Chunk[] {
  for (const chunk of chunks) tagChunkRole(chunk);
  return chunks;
}
