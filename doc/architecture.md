# Architecture

## Overview

OpenCodeRAG is a local-first RAG pipeline for semantic code search. It ingests source files, splits them into semantic chunks, generates embeddings, stores them in a vector database, and retrieves relevant chunks for natural language queries. It integrates as an OpenCode plugin and provides a standalone CLI.

## High-Level Data Flow

```
Workspace Files ──> Chunker ──> Chunks ──> Embedder ──> Vectors ──> VectorStore (LanceDB)
                                           │                                         │
                                           └──> KeywordIndex (TF×IDF) ───────────────┘
                                                                                     │
User Query ──> Embedder (query prefix) ──> Vector Search                             │
           ──> KeywordIndex (tokenize) ──> Keyword Search                            │
                                                                                     ▼
                                                                              Weighted Fusion
                                                                                     │
                                                                              Search Results
```

## Module Design

The project follows **interfaces over classes**, **factory pattern**, and **adapter pattern**:

### Core Interfaces (`src/core/interfaces.ts`)

| Interface | Purpose | Key Methods |
|-----------|---------|-------------|
| `Chunker` | Splits file content into chunks | `chunk(filePath, content): Promise<Chunk[]>` |
| `EmbeddingProvider` | Generates vector embeddings | `embed(texts[], purpose?): Promise<number[][]>` |
| `VectorStore` | Stores/retrieves vectors | `addChunks()`, `search()`, `clear()`, `deleteByFilePath()` |
| `DescriptionProvider` | Generates NL descriptions for chunks | `generateDescription(chunk)`, `generateBatchDescriptions(chunks)` |
| `KeywordIndex` | TF×IDF inverted index | `addChunks()`, `search()`, `removeByFilePath()`, `save()`, `load()` |

### Core Data Types

```typescript
interface Chunk {
  id: string;
  content: string;
  description?: string;   // NL description (LLM-generated or path-based)
  embedding?: number[];    // Vector embedding
  metadata: {
    filePath: string;
    startLine: number;
    endLine: number;
    language: string;
  };
}

interface SearchResult {
  chunk: Chunk;
  score: number;           // 0-1 relevance score
}
```

## Directory Structure

### Entry Points

| File | Role |
|---|---|
| `src/index.ts` | Public API exports (library consumers) |
| `src/plugin-entry.ts` | Plugin entry for OpenCode runtime |
| `src/cli.ts` | Commander-based CLI (`opencode-rag`) |
| `src/tui.ts` | OpenCode TUI settings panel (Solid.js) |
| `src/web/server.ts` | Web UI HTTP server (dashboard, chunk browser) |

### Core (`src/core/`)

| File | Role |
|---|---|
| `interfaces.ts` | All core interfaces and types |
| `config.ts` | `RagConfig`, `DEFAULT_CONFIG`, `loadConfig()` with deep merge |
| `manifest.ts` | File hash manifest with schema versioning and corruption detection |
| `runtime-overrides.ts` | Live config overrides with 5s TTL reload |
| `resolve-api-key.ts` | Auto-resolves OpenAI API key from OpenCode provider config |
| `fileLogger.ts` | Configurable structured file logging |

### Chunking (`src/chunker/`)

| File | Role |
|---|---|
| `base.ts` | `TreeSitterChunker` abstract class |
| `grammar.ts` | tree-sitter WASM initialization and language loading |
| `factory.ts` | `getChunker()` by extension, `chunkFile()`, `registerChunker()` |
| `*.ts` | Per-language chunker implementations (17 AST languages + 5 document/regex + fallback) |

See [doc/chunking.md](chunking.md) for the full language matrix.

### Embedding (`src/embedder/`)

| File | Role |
|---|---|
| `ollama.ts` | Ollama provider (`POST /embed`) |
| `openai.ts` | OpenAI provider (batched, auth header) |
| `cohere.ts` | Cohere provider |
| `factory.ts` | `createEmbedder()` dispatch, `embedBatch()` |
| `http.ts` | HTTP transport with proxy support and raw-socket localhost bypass |

### Description (`src/describer/`)

| File | Role |
|---|---|
| `describer.ts` | `LlmDescriptionProvider` base class |
| `factory.ts` | `createDescriptionProvider()` dispatch |
| `anthropic.ts` | Anthropic provider |
| `gemini.ts` | Gemini provider |

### Retrieval (`src/retriever/`)

| File | Role |
|---|---|
| `retriever.ts` | `retrieve()` — vector + hybrid keyword/vector search |
| `keyword-index.ts` | `KeywordIndex` — zero-dep TF×IDF inverted index with CamelCase/snake_case tokenizer |

### Vector Store (`src/vectorstore/`)

| File | Role |
|---|---|
| `lancedb.ts` | `LanceDbStore` — LanceDB-backed vector store with `memory://` support |

### OpenCode Integration (`src/opencode/`)

| File | Role |
|---|---|
| `create-read-tool.ts` | RAG-backed read tool override |
| `read-fallback.ts` | Read fallback logic |
| `read-format.ts` | Read result formatting |
| `read-query.ts` | Read query construction |
| `tool-args.ts` | Tool argument parsing |

### Plugin & Indexing

| File | Role |
|---|---|
| `src/plugin.ts` | Main plugin: context tool, `chat.message` hook, auto-injection, read override |
| `src/indexer.ts` | `runIndexPass()`, `scanWorkspace()`, `createWatchPassScheduler()`, `createWatchIgnore()` |
| `src/watcher.ts` | `createBackgroundIndexer()` — chokidar watcher + debounced scheduler + periodic timer (git backend only) |

### Web UI (`src/web/`)

| File | Role |
|---|---|
| `server.ts` | HTTP server entry point (localhost only) |
| `api.ts` | REST API handler (stats, files, chunks, search, compare) |
| `static.ts` | Serves the single-page HTML app |
| `ui/index.html` | Self-contained SPA (Tailwind + highlight.js, inline JS) |

See [Web UI](webui.md) for the full dashboard reference.

## Pipeline Stages

### 1. Scanning (`scanWorkspace` in `indexer.ts`)
Walks the workspace directory tree, filtering by `includeExtensions`, `includeDirs` (root-anchored folder whitelist; root files are skipped when set) and `excludeDirs`. Reads text files as UTF-8, binary files (PDF, DOCX, DOC, Excel) via extraction libraries. Supports incremental scanning via git-diff — when a previous git commit is recorded in the manifest, only changed/untracked files are scanned. Out-of-scope files (e.g. after an `includeDirs` change) are removed from the index by the pipeline's stale-path cleanup during a full pass; git-incremental passes only remove git-deleted files.

### 2. Chunking (`chunkFile` in `chunker/factory.ts`)
Dispatches to the appropriate `Chunker` based on file extension. Each chunker splits content into semantically meaningful units (AST nodes, headings, paragraphs, etc.).

### 3. Description (Optional, `DescriptionProvider`)
An LLM generates a natural-language description of each chunk. By default every chunk gets its own request; the experimental `description.batchEnabled` flag makes the Ollama provider group several chunks into one request (configurable via `description.batchMaxChunks`), with concurrent requests governed by `description.batchConcurrency`. The embedded text becomes `filePath + "\n\n" + description + "\n\n" + content`. If disabled, the description defaults to `lines N-M, language`.

### 4. Embedding (`embedBatch` in `embedder/factory.ts`)
Texts are optionally prefixed with `documentPrefix` (e.g., `search_document:`) and sent to the embedding provider in batches. Multiple batches are sent concurrently (configurable via `indexing.embedConcurrency`). The resulting vectors are written to the chunk objects.

### 5. Storage (`LanceDbStore`)
Chunks and their embeddings are stored in LanceDB in **bulk window writes**: all chunks of a processing window go in as a single `table.add`, followed by one `table.delete` per modified file (dedup of the prior revision). During a full rebuild (`--force`) the writes are append-only — the temporary rebuild store starts empty, so dedup deletes are skipped entirely. This keeps the number of LanceDB version commits proportional to the number of modified files instead of the number of chunks (previously K+2 transactions per file caused version-manifest accumulation that made the store phase degrade quadratically as the index grew). The store phase is launched as a non-awaited promise so it overlaps the next window's prepare/describe/embed phases, and it is compacted periodically (`indexing.optimizeIntervalWindows`) plus once at the end of a pass to prune old versions. The keyword index is maintained separately as an in-memory TF×IDF inverted index, serialized to `keyword-index.json`.

### 6. Retrieval (`retrieve` in `retriever/retriever.ts`)
The query is prefixed with `queryPrefix` and embedded. Vector search returns results. If hybrid search is enabled, keyword search runs in parallel. Results are fused via weighted score: `(1 - kw) * vScore + kw * kScore`.

## Configuration Layering

```
opencode-rag.json ──> loadConfig() ──> DEFAULT_CONFIG deep merge
                          │
runtime-overrides.json ───┼──> applyRuntimeOverrides() (5s TTL)
                          │
                    Effective Config
```

- **`opencode-rag.json`**: User-defined overrides, deep-merged per section.
- **`runtime-overrides.json`**: Live overrides written by the TUI, take precedence.
- **`DEFAULT_CONFIG`**: Hard-coded defaults in `config.ts`.

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js v22.14 + `tsx` (ESM, `type: "module"`) |
| Language | TypeScript 5.8 |
| Package manager | npm |
| Chunking | `web-tree-sitter` (WASM, v0.26.9) |
| Grammars | `@vscode/tree-sitter-wasm` + self-bundled `wasm/` (pre-built WASM) |
| Vector DB | `@lancedb/lancedb` (v0.29.0) |
| Arrow types | `apache-arrow` (peer dep) |
| CLI framework | `commander` (v13.1.0) |
| Test runner | Node.js built-in (`node:test`) |
| Plugin types | Local `.d.ts` (no npm dep) |
