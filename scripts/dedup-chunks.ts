#!/usr/bin/env npx tsx
/**
 * Deduplicate chunks in the vector database.
 *
 * Groups chunks by filePath+startLine+endLine+content and keeps only
 * the one with a non-empty description (or the first if none have descriptions).
 *
 * Usage:
 *   npx tsx scripts/dedup-chunks.ts [--dry-run] [--db-path <path>]
 */

import path from "node:path";
import { LanceDBStore } from "../src/vectorstore/lancedb.js";
import { loadManifest, saveManifest } from "../src/core/manifest.js";
import type { Chunk } from "../src/core/interfaces.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbPathIdx = args.indexOf("--db-path");
const dbPath = path.resolve(dbPathIdx !== -1 ? args[dbPathIdx + 1]! : ".opencode", "rag_db");

/** Metadata for a single chunk used during deduplication. */
interface ChunkInfo {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  description: string;
  language: string;
}

/**
 * Compute a deduplication key for a chunk.
 *
 * Image chunks are keyed by `image:<filePath>`; all other chunks use
 * the full `filePath:startLine:endLine:content` string.
 *
 * @param c - The chunk info to derive a key for.
 * @returns A string key used for grouping duplicates.
 */
function dedupKey(c: ChunkInfo): string {
  if (c.language === "image") {
    return `image:${c.filePath}`;
  }
  return `${c.filePath}:${c.startLine}:${c.endLine}:${c.content}`;
}

/**
 * Main entry point — reads all chunks from the vector store, groups
 * them by deduplication key, keeps the best chunk per group, and
 * rewrites the store with deduplicated data.
 */
async function main(): Promise<void> {
  console.log(`Deduplicating chunks in: ${dbPath}`);
  if (dryRun) console.log("(dry run — no changes will be made)\n");

  const store = new LanceDBStore(dbPath);
  const totalBefore = await store.count();
  console.log(`Total chunks before: ${totalBefore}`);

  if (totalBefore === 0) {
    console.log("Database is empty. Nothing to deduplicate.");
    await store.close();
    return;
  }

  const BATCH = 1000;
  const allChunks: ChunkInfo[] = [];
  let offset = 0;

  while (offset < totalBefore) {
    const batch = await store.getChunks(offset, BATCH);
    allChunks.push(...batch);
    offset += BATCH;
  }

  console.log(`Read ${allChunks.length} chunks from store`);

  const groups = new Map<string, ChunkInfo[]>();
  for (const chunk of allChunks) {
    const key = dedupKey(chunk);
    const existing = groups.get(key);
    if (existing) {
      existing.push(chunk);
    } else {
      groups.set(key, [chunk]);
    }
  }

  const dupGroups = new Map<string, ChunkInfo[]>();
  for (const [key, chunks] of groups) {
    if (chunks.length > 1) {
      dupGroups.set(key, chunks);
    }
  }

  if (dupGroups.size === 0) {
    console.log("No duplicate chunks found.");
    await store.close();
    return;
  }

  console.log(`Found ${dupGroups.size} groups of duplicate chunks\n`);

  const filesToRebuild = new Map<string, ChunkInfo[]>();
  let totalDuplicates = 0;

  for (const [, chunks] of dupGroups) {
    const isImage = chunks[0]!.language === "image";
    let winner: ChunkInfo;
    if (isImage) {
      winner = chunks.reduce((a, b) => (a.content.length >= b.content.length ? a : b));
    } else {
      winner = chunks.find((c) => c.description && c.description.trim().length > 0) ?? chunks[0]!;
    }
    const losers = chunks.filter((c) => c.id !== winner.id);
    totalDuplicates += losers.length;

    const existing = filesToRebuild.get(winner.filePath);
    if (existing) {
      existing.push(winner);
    } else {
      filesToRebuild.set(winner.filePath, [winner]);
    }

    if (dryRun) {
      console.log(`  [DRY RUN] Would keep: ${winner.filePath}:${winner.startLine}-${winner.endLine} (id=${winner.id.slice(0, 8)}...)`);
      console.log(`           Would remove ${losers.length} duplicate(s)`);
    }
  }

  console.log(`\nSummary: ${totalDuplicates} duplicate chunks across ${filesToRebuild.size} files`);

  if (dryRun) {
    console.log("\n(dry run — no changes made)");
    await store.close();
    return;
  }

  console.log("\nCleaning duplicates...");

  let cleaned = 0;
  for (const [filePath, winners] of filesToRebuild) {
    await store.deleteByFilePath(filePath);

    const chunks: Chunk[] = winners.map((w) => ({
      id: w.id,
      content: w.content,
      description: w.description,
      metadata: {
        filePath: w.filePath,
        startLine: w.startLine,
        endLine: w.endLine,
        language: w.language,
      },
    }));

    await store.addChunks(chunks);
    cleaned += winners.length;
    console.log(`  Rebuilt ${filePath} (${winners.length} chunks)`);
  }

  const totalAfter = await store.count();
  console.log(`\nChunks before: ${totalBefore}`);
  console.log(`Chunks after:  ${totalAfter}`);
  console.log(`Removed:       ${totalBefore - totalAfter}`);

  const manifestResult = await loadManifest(dbPath);
  if (manifestResult.status === "ok") {
    const manifest = manifestResult.manifest;
    for (const [filePath, chunks] of filesToRebuild) {
      if (manifest.files[filePath]) {
        manifest.files[filePath]!.chunkCount = chunks.length;
      }
    }
    await saveManifest(dbPath, manifest);
    console.log("Manifest updated.");
  }

  await store.close();
  console.log("Done.");
}


 /** TODO: generated */
main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
