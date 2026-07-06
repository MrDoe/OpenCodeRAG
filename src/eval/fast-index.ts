/**
 * @fileoverview Fast indexer that uses pre-dumped descriptions instead of LLM generation.
 * Indexes only files unchanged between the current branch and main.
 * Run on the main branch after copying chunk-descriptions.json from t1-cosine-l2.
 *
 * Usage: node --import tsx src/eval/fast-index.ts --descriptions doc/chunk-descriptions.json
 */

import { readFileSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, DEFAULT_CONFIG } from "../core/config.js";
import { createEmbedder } from "../embedder/factory.js";
import { createVectorStore } from "../vectorstore/factory.js";
import {
  loadRuntimeOverrides,
  applyRuntimeOverrides,
} from "../core/runtime-overrides.js";
import { resolveApiKey } from "../core/resolve-api-key.js";
import { chunkFile } from "../chunker/factory.js";
import { embedBatch } from "../embedder/factory.js";
import { normalizeFilePath } from "../core/manifest.js";
import { KeywordIndex } from "../retriever/keyword-index.js";
import type { Chunk } from "../core/interfaces.js";

const WORKTREE = process.cwd();
const STORE_PATH = path.join(WORKTREE, ".opencode", "rag_db");

/** Directories to skip entirely when scanning for files. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".opencode",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  ".claude",
  ".github",
  "memory:",
  "wasm",
  ".commandcode",
  ".agents",
  "graphify-out",
  "__tests__",
]);

/** File extensions to include. */
const INCLUDE_EXTS = new Set([".ts", ".tsx"]);

/** Changed files between main and t1-cosine-l2 (relative paths, / separators). */
const CHANGED_FILES = new Set([
  "src/api.ts",
  "src/chunker/pdf.ts",
  "src/cli/commands/init-helpers.ts",
  "src/core/config.ts",
  "src/core/interfaces.ts",
  "src/core/manifest.ts",
  "src/core/setup-runtime.ts",
  "src/indexer/embed-stage.ts",
  "src/retriever/keyword-index.ts",
  "src/retriever/retriever.ts",
  "src/vectorstore/lancedb.ts",
  "src/vectorstore/memory.ts",
]);

/** Our own eval scripts (not part of the index). */
const EVAL_FILES = new Set([
  "src/eval/run-branch-compare.ts",
  "src/eval/compare-merge.ts",
  "src/eval/dump-descriptions.ts",
  "src/eval/update-descriptions.ts",
  "src/eval/fast-index.ts",
]);

function isChangedFile(relPath: string): boolean {
  return CHANGED_FILES.has(relPath) || EVAL_FILES.has(relPath);
}

function walkFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          results.push(...walkFiles(fullPath));
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (INCLUDE_EXTS.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  } catch {
    // directory not found or no permissions
  }
  return results;
}

function parseArgs(): { descriptionsPath: string } {
  const args = process.argv.slice(2);
  let descriptionsPath = path.join(WORKTREE, "doc", "chunk-descriptions.json");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--descriptions" && args[i + 1]) {
      descriptionsPath = path.resolve(WORKTREE, args[i + 1]!);
      break;
    }
  }
  return { descriptionsPath };
}

function getConfig() {
  const configPath = path.join(WORKTREE, "opencode-rag.json");
  let cfg;
  try {
    cfg = loadConfig(configPath);
  } catch {
    cfg = DEFAULT_CONFIG;
  }
  const overrides = loadRuntimeOverrides(STORE_PATH);
  cfg = applyRuntimeOverrides(cfg, overrides);
  resolveApiKey(cfg, WORKTREE);
  return cfg;
}

async function main() {
  const { descriptionsPath } = parseArgs();
  console.log(`\n  Fast Indexer — skipping description generation`);
  console.log(`  Descriptions: ${descriptionsPath}\n`);

  // Helper: split "absPath:startLine:endLine" key (handles Windows drive letters)
  function splitLocationKey(k: string): { absPath: string; startLine: number; endLine: number } {
    const lastColon = k.lastIndexOf(":");
    const secondLastColon = k.lastIndexOf(":", lastColon - 1);
    return {
      absPath: k.substring(0, secondLastColon),
      startLine: parseInt(k.substring(secondLastColon + 1, lastColon), 10),
      endLine: parseInt(k.substring(lastColon + 1), 10),
    };
  }

  // Load pre-dumped descriptions and remap paths to this worktree
  const rawDescs: Record<string, string> = JSON.parse(
    readFileSync(descriptionsPath, "utf-8"),
  );
  // Detect source worktree from first key
  const sampleKey = Object.keys(rawDescs)[0] ?? "";
  const sampleParts = splitLocationKey(sampleKey);
  const samplePath = sampleParts.absPath;
  const srcIdx = samplePath.lastIndexOf("/src/");
  const docIdx = samplePath.lastIndexOf("/doc/");
  const cutIdx = Math.max(srcIdx, docIdx);
  const sourceWorktree = cutIdx > 0 ? samplePath.substring(0, cutIdx) : "";

  const thisWorktree = WORKTREE.replace(/\\/g, "/");
  const descriptions: Record<string, string> = {};

  for (const [key, desc] of Object.entries(rawDescs)) {
    if (!sourceWorktree) {
      descriptions[key] = desc;
      continue;
    }
    const { absPath, startLine, endLine } = splitLocationKey(key);
    if (!absPath.startsWith(sourceWorktree + "/")) {
      descriptions[key] = desc;
      continue;
    }
    const relativePath = absPath.substring(sourceWorktree.length);
    const newKey = `${thisWorktree}${relativePath}:${startLine}:${endLine}`;
    descriptions[newKey] = desc;
  }

  console.log(`  Loaded ${Object.keys(rawDescs).length} descriptions from dump`);
  console.log(`  Source worktree: ${sourceWorktree}`);
  console.log(`  This worktree:  ${thisWorktree}`);

  // Set up config, embedder, store
  const cfg = getConfig();
  const embedder = createEmbedder(cfg);

  // Probe dimension
  const probe = await embedder.embed(["dimension-probe"], "query");
  const dimension = probe[0]?.length ?? 384;
  console.log(`  Embedding dimension: ${dimension}\n`);

  // Clear existing store
  const store = createVectorStore(cfg, STORE_PATH, dimension);
  await store.clear();
  console.log("  Cleared existing store\n");

  // Walk files
  const srcDir = path.join(WORKTREE, "src");
  const allFiles = walkFiles(srcDir);
  const filteredFiles = allFiles
    .map((f) => path.relative(WORKTREE, f).replace(/\\/g, "/"))
    .filter((f) => !isChangedFile(f));
  console.log(`  Found ${allFiles.length} .ts files in src/`);
  console.log(`  After filtering out changed files: ${filteredFiles.length}\n`);

  // Process files sequentially (chunking + description lookup)
  const allChunks: Chunk[] = [];
  let skippedNoDesc = 0;

  for (let i = 0; i < filteredFiles.length; i++) {
    const relPath = filteredFiles[i]!;
    const absPath = path.join(WORKTREE, relPath);
    process.stdout.write(
      `  [${i + 1}/${filteredFiles.length}] ${relPath}...`,
    );

    try {
      const content = await fs.readFile(absPath, "utf-8");
      if (!content.trim()) {
        console.log(" empty");
        continue;
      }

      const chunks = await chunkFile(absPath, content);
      if (!chunks || chunks.length === 0) {
        console.log(" no chunks");
        continue;
      }

      // Attach descriptions from dump
      const normalizedPath = normalizeFilePath(absPath);
      let attached = 0;
      for (const chunk of chunks) {
        const key = `${normalizedPath}:${chunk.metadata.startLine}:${chunk.metadata.endLine}`;
        const desc = descriptions[key];
        if (desc) {
          chunk.description = desc;
          attached++;
        } else {
          // Try alternate key ending (some chunkers add +1 to endLine)
          const altKey = `${normalizedPath}:${chunk.metadata.startLine}:${chunk.metadata.startLine + (chunk.metadata.endLine - chunk.metadata.startLine) + 1}`;
          const altDesc = descriptions[altKey];
          if (altDesc) {
            chunk.description = altDesc;
            attached++;
          }
        }
      }

      if (attached === 0) {
        skippedNoDesc++;
      }

      allChunks.push(...chunks);
      console.log(` ${chunks.length} chunks, ${attached} descriptions`);
    } catch (err) {
      console.log(` error: ${(err as Error).message}`);
    }
  }

  console.log(`\n  Total chunks to embed: ${allChunks.length}`);
  console.log(`  Files with no description match: ${skippedNoDesc}`);

  // Build texts to embed and batch-embed
  const textsToEmbed: string[] = [];
  for (const chunk of allChunks) {
    const desc = chunk.description ?? "";
    if (desc.trim()) {
      textsToEmbed.push(
        `${path.relative(WORKTREE, chunk.metadata.filePath).replace(/\\/g, "/")}\n\n${desc}\n\n${chunk.content}`,
      );
    } else {
      textsToEmbed.push(
        `${path.relative(WORKTREE, chunk.metadata.filePath).replace(/\\/g, "/")}\n\n${chunk.content}`,
      );
    }
  }

  console.log(`  Embedding ${textsToEmbed.length} texts...`);
  const embeddings = await embedBatch(
    embedder,
    textsToEmbed,
    cfg.indexing.embedBatchSize ?? 100,
    "document",
    cfg.indexing.embedConcurrency ?? 3,
  );
  console.log(`  Got ${embeddings.length} embeddings`);

  // Attach embeddings to chunks and store
  for (let i = 0; i < allChunks.length; i++) {
    const emb = embeddings[i];
    if (emb && emb.length > 0 && typeof emb[0] === "number") {
      allChunks[i]!.embedding = emb as number[];
    }
  }

  const validChunks = allChunks.filter(
    (c) => c.embedding && c.embedding.length > 0,
  );
  console.log(`  Storing ${validChunks.length} chunks...`);

  await store.addChunks(validChunks);
  const count = await store.count();
  console.log(`  Store now has ${count} chunks`);

  await store.close();

  // Build keyword index from the same chunks
  console.log("  Building keyword index...");
  const ki = new KeywordIndex();
  ki.addChunks(validChunks);
  await ki.save(STORE_PATH);
  console.log(`  Keyword index saved (${ki.count()} entries)`);

  console.log("\n  Fast indexing complete!\n");
}

main().catch((err) => {
  console.error("Fast index failed:", err);
  process.exit(1);
});
