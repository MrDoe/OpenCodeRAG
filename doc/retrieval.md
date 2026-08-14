# Retrieval

## Pipeline

The retrieval pipeline (`src/retriever/retriever.ts`) converts natural language queries into ranked code chunks:

```
User Query
    │
    ├──> Prefix with queryPrefix (e.g., "search_query: ")
    │
    ├──> embed() ──> Vector Search ──> topK × 3 results
    │
    ├──> KeywordIndex.search() ──> topK × 3 results (if hybrid enabled)
    │
    └──> Weighted Fusion
              │
         Filter by minScore
              │
         Sort by score (desc)
              │
         Slice to topK
              │
    ╔════════════════════════════════════════════╗
    ║  Context Window Optimization (post-retrieval) ║
    ║                                              ║
    ║  1. Merge adjacent chunks (same-file)        ║
    ║  2. Jaccard similarity dedup (same-file)     ║
    ║  3. File-level diversity cap (greedy)        ║
    ╚════════════════════════════════════════════╝
              │
         Return OptimizedSearchResult[]
```

## Hybrid Search (Keyword + Vector)

When `retrieval.hybridSearch.enabled` is `true` (default), both searches run and results are fused.

### Keyword Search
The `KeywordIndex` (`src/retriever/keyword-index.ts`) is a zero-dependency inverted index:

- **Tokenizer:** Handles CamelCase, snake_case, and code-specific special characters
- **Scoring:** TF×IDF — term frequency within a chunk × log of inverse document frequency
- **Storage:** Serialized to `${storePath}/keyword-index.json` alongside manifest.json

### Score Fusion

Results are merged via **Reciprocal Rank Fusion (RRF)** with normalization to [0, 1]:

```
vContrib = (1 - kw) × (K + 1) / (K + vRank + 1)
kContrib = kw × (K + 1) / (K + kRank + 1)
score    = vContrib + kContrib
```

Where:
- `kw` = `retrieval.hybridSearch.keywordWeight` (default 0.4)
- `K` = 60 (RRF rank constant)
- `vRank` = rank in vector search results (0-indexed)
- `kRank` = rank in keyword search results
- `(K + 1)` = normalization factor mapping the maximum score to exactly 1.0

This produces scores on a [0, 1] scale. A result at rank 0 in both signals scores **1.0** (perfect). A vector-only result at rank 0 scores **0.6** (= 1 − kw). A keyword-only result at rank 0 scores **0.4** (= kw).

RRF **rewards results that rank highly in both signals** over results that rank well in only one. When only one signal contributes, the ranking matches the raw vector order (normalization preserves monotonicity). Low-scoring chunks that don't meet `minScore` are filtered out.

### `retrieve()` API

```typescript
async function retrieve(
  query: string,           // Natural language query
  embedder: EmbeddingProvider,
  store: VectorStore,
  options?: RetrieveOptions
): Promise<SearchResult[]>
```

Options:

| Option | Default | Description |
|---|---|---|
| `topK` | `10` | Max results |
| `minScore` | `0` | Minimum relevance threshold |
| `keywordIndex` | — | Keyword index instance |
| `keywordWeight` | `0.4` | Hybrid fusion weight |
| `queryPrefix` | — | Prefix applied to query before embedding |
| `filter` | — | [`MetadataFilter`](#metadata-filtering) to narrow results before scoring |
| `explain` | `false` | Include score breakdown / matched terms in results |

## Metadata Filtering

An optional `MetadataFilter` can narrow results **before** scoring in every store (LanceDB, in-memory, keyword index):

| Field | Description |
|---|---|
| `pathPatterns` | Glob-style path patterns (e.g. `["src/**"]`) |
| `languages` | Exact `metadata.language` matches (e.g. `["typescript"]`) |
| `kinds` | Exact `metadata.kind` matches (`""` = code, `"quirk"` = quirk memory) |
| `fileExtensions` | Dot-prefixed file extensions (e.g. `[".ts", ".py"]`) — case-insensitive suffix match; accepts `ts` or `.ts`, normalized + deduped by `normalizeFileExtensions` (`src/core/filters.ts`) |

`CODE_SEARCH_FILTER` (`{ kinds: [""] }`) is applied by all code-search paths so quirk memory never surfaces as code results.

**Soft vs hard hints in tool surfaces:** `search_semantic`'s `pathHints`/`languageHints` (plugin tool + MCP handler) are *soft* — appended to the query text to bias the embedding, not a real filter. `fileExtensions` is a *hard* filter everywhere: the plugin tool and MCP handler build a `MetadataFilter`, and the library `search()` / web `/api/retrieve?ext=` pass it straight through.

## Vector Search

Vector search uses LanceDB's native ANN (Approximate Nearest Neighbor) index. The query text is:

1. Prefixed with `queryPrefix` (e.g., `"search_query: "`)
2. Embedded via the configured provider
3. Searched against the LanceDB store

The vector search multiplier (`vectorFactor = 3`) returns 3× the `topK` results to allow the hybrid fusion to consider more candidates.

## Description-Based Embedding

When `description.enabled` is `true`, the embedded text for each chunk is:

```
[description] + "\n\n" + [code content]
```

This captures both semantic meaning (from the description) and code-level similarity (from the code itself). Keyword search always uses the raw code content regardless of this setting.

See [Configuration](configuration.md#description) for details.

### Image Description Chunks

When image indexing is enabled, images are converted to text descriptions by a vision provider and then embedded and stored like any other chunk. This means:

- Queries like "login screen" or "architecture diagram" can match image descriptions via the same vector and hybrid search pipeline.
- No special retrieval call is needed; use `search_semantic` as usual.
- To retrieve the raw description for a specific image, use the `describe_image` tool instead of `search_semantic`.

## Caching

The plugin maintains a **session-level retrieval cache** that avoids re-embedding repeated queries within the same session. This cache is ephemeral and does not persist across sessions.

## Code Autocomplete Integration

Preparing for `processAutocompleteRequest`: The architecture is designed to support autocomplete-time retrieval, allowing relevant code context to be injected at cursor position. This is planned for a future release.

## Context Window Optimization

After retrieval, the results are passed through a three-phase optimization pipeline (`src/retriever/context-optimizer.ts`) to improve the quality of the context window:

### Phase 1: Adjacent Merge
Consecutive chunks from the same file that are within the `adjacentGapThreshold` line gap are merged into a single chunk. The merged chunk concatenates their content, takes the higher score, and records the original chunk IDs in `optimized.mergedFrom`.

### Phase 2: Similarity Dedup
Same-file chunks with Jaccard similarity exceeding `similarityThreshold` are deduplicated — the lower-scored chunk is removed and its ID is tracked in `optimized.dedupedFrom`. This avoids redundant near-identical code appearing in results. Dedup is same-file only; cross-file duplicates are kept.

### Phase 3: File Diversity Cap
A greedy selection picks the best-scoring chunks while enforcing at most `maxPerFile` chunks per file. Files that contributed more than `maxPerFile` items to the pre-cap pool are marked with `optimized.fileCapped: true`. If the per-file cap exhausts the available items before reaching `topK`, fewer results are returned.

### Optimized Result Metadata

Results are wrapped as `OptimizedSearchResult` which extends `SearchResult` with an optional `optimized` field:

| Field | Type | Description |
|---|---|---|
| `optimized.mergedFrom` | `string[]` | Original chunk IDs merged into this result |
| `optimized.dedupedFrom` | `string[]` | Chunk IDs removed as duplicates of this result |
| `optimized.fileCapped` | `boolean` | Whether the source file exceeded `maxPerFile` |

### Configuration

See [Configuration: `retrieval.contextOptimization`](configuration.md#retrieval) for all available knobs.

### Disabling

Set `retrieval.contextOptimization.enabled: false` in `opencode-rag.json` to return raw `retrieve()` results unchanged.

## Future Improvements

| Feature | Status | Description |
|---|---|---|
| LLM-based re-ranking | Planned | Cross-encoder after vector search for precision |
| Query rewriting | Planned | Multi-variant query expansion |
| Retrieval explainability | Planned | Debug surfaces for why chunks were returned |
| Cross-file graph | Planned | Dependency-aware search via import/call graphs |
