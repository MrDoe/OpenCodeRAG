# Branch Comparison Report

**Generated:** 2026-07-06T08:43:13.404Z
**Main branch:** `main` @ `734fc60` (2026-07-06)
**Feature branch:** `t1-cosine-l2` @ `e922a0b` (2026-07-06)

## Configuration

| Setting | `main` | `t1-cosine-l2` |
|---|---|---|
| Embedding provider | ollama | ollama |
| Embedding model | qwen3-embedding:0.6b | qwen3-embedding:0.6b |
| topK | 20 | 20 |
| minScore | 0.5 | 0.5 |
| Hybrid search | true | true |
| Keyword weight | 0.4 | 0.4 |
| Indexed chunks | 542 | 542 |

## Scoring Method Differences

| Aspect | `main` | `t1-cosine-l2` |
|---|---|---|
| Vector scoring | `1 / (1 + L2 distance)` | Cosine similarity via L2-normalized vectors |
| Hybrid fusion | Weighted linear: `(1-kw)*normV + kw*normK` | Reciprocal Rank Fusion (RRF, K=60) |
| Default minScore | 0.5 | 0.5 |
| Metadata filter | Not supported | `MetadataFilter` support added |

## Top-1 Score Quality

| Metric | `main` | `t1-cosine-l2` | Δ | Δ% |
|---|---|---|---|---|
| Average | 0.567 | 0.010 | -0.557 | -98.3% |
| Median | 0.570 | 0.010 | -0.560 | -98.3% |
| P95 | 0.661 | 0.010 | -0.651 | -98.5% |
| P5 | 0.490 | 0.010 | -0.480 | -98.0% |
| Std Dev | 0.054 | 0.000 | -0.054 | — |

> **Interpretation:** Cosine similarity produces scores in a tighter 0-1 range.
> RRF further shifts scores based on rank rather than raw similarity, so comparing
> absolute scores across branches is misleading. The key metric is **whether the same
> relevant files appear in the top results** (see Rank Stability below).

## Result Count (per query)

| Metric | `main` | `t1-cosine-l2` | Δ |
|---|---|---|---|
| Average | 60.0 | 20.0 | -40.0 |
| Median | 60.0 | 20.0 | -40.0 |
| P95 | 60.0 | 20.0 | — |
| Zero-result queries | 0 | 0 | — |

## Latency (ms per query)

| Metric | `main` | `t1-cosine-l2` | Δ |
|---|---|---|---|
| Average | 144.3 | 147.1 | +2.8 |
| Median | 142.2 | 142.6 | +0.4 |
| P95 | 186.3 | 189.2 | — |

## Threshold Coverage

Shows how many queries would trigger RAG context injection at each `minScore` threshold.

| Threshold | `main` | `t1-cosine-l2` | Δ |
|---|---|---|---|
| 0.85 | 0/25 | 0/25 | +0 |
| 0.75 | 0/25 | 0/25 | +0 |
| 0.65 | 2/25 | 0/25 | -2 |
| 0.50 | 21/25 | 0/25 | -21 |
| 0.35 | 25/25 | 0/25 | -25 |

## Rank Stability (Jaccard Similarity)

For each query, computes the Jaccard similarity of the top-3 file paths between branches.
1.0 = identical top-3 files, 0.0 = completely different.

| Metric | Value |
|---|---|
| Average | 0.000 |
| Median | 0.000 |
| Minimum | 0.000 |
| Maximum | 0.000 |

## Per-Query Results

| # | Query | `main` results | `main` top score | `t1-cosine-l2` results | `t1-cosine-l2` top score | Δ score | Jaccard (top-3) |
|---|---|---|---|---|---|---|---|
| 1 | How does the retrieval pipeline work end-to-end? | 60 | 0.577 | 20 | 0.010 | -0.567 | 0.000 |
| 2 | How does the plugin interact with chat messages? | 60 | 0.537 | 20 | 0.010 | -0.527 | 0.000 |
| 3 | How does the keyword index combine with vector ... | 60 | 0.559 | 20 | 0.010 | -0.549 | 0.000 |
| 4 | Where is the embedder factory defined? | 60 | 0.582 | 20 | 0.010 | -0.572 | 0.000 |
| 5 | Where is the LanceDB store implementation? | 60 | 0.573 | 20 | 0.010 | -0.563 | 0.000 |
| 6 | Find all usages of the retrieve function | 60 | 0.555 | 20 | 0.010 | -0.545 | 0.000 |
| 7 | Find all usages of SearchResult type | 60 | 0.576 | 20 | 0.010 | -0.566 | 0.000 |
| 8 | How does the chunker factory register new langu... | 60 | 0.607 | 20 | 0.010 | -0.597 | 0.000 |
| 9 | What is the default minScore configuration? | 60 | 0.489 | 20 | 0.010 | -0.479 | 0.000 |
| 10 | How does the session logger capture token usage? | 60 | 0.650 | 20 | 0.010 | -0.640 | 0.000 |
| 11 | How does L2 normalization affect vector search ... | 60 | 0.534 | 20 | 0.010 | -0.524 | 0.000 |
| 12 | What is the MetadataFilter interface used for? | 60 | 0.502 | 20 | 0.010 | -0.492 | 0.000 |
| 13 | How does the background indexer handle file cha... | 60 | 0.601 | 20 | 0.010 | -0.592 | 0.000 |
| 14 | Where is the config validation logic? | 60 | 0.511 | 20 | 0.010 | -0.501 | 0.000 |
| 15 | How are PDF documents chunked and indexed? | 60 | 0.599 | 20 | 0.010 | -0.589 | 0.000 |
| 16 | What embedding providers are supported? | 60 | 0.661 | 20 | 0.010 | -0.651 | 0.000 |
| 17 | How does the CLI parse and dispatch commands? | 60 | 0.552 | 20 | 0.010 | -0.542 | 0.000 |
| 18 | How does the session logger persist events? | 60 | 0.663 | 20 | 0.010 | -0.653 | 0.000 |
| 19 | What is the manifest schema version used for? | 60 | 0.490 | 20 | 0.010 | -0.480 | 0.000 |
| 20 | How does the OpenCode plugin register tools? | 60 | 0.622 | 20 | 0.010 | -0.613 | 0.000 |
| 21 | Where is the globMatch function defined? | 60 | 0.491 | 20 | 0.010 | -0.481 | 0.000 |
| 22 | How does the proxy-aware HTTP client work? | 60 | 0.547 | 20 | 0.010 | -0.537 | 0.000 |
| 23 | What is the FETCH_OVERFETCH_FACTOR constant? | 60 | 0.497 | 20 | 0.010 | -0.487 | 0.000 |
| 24 | How does the TUI settings menu work? | 60 | 0.570 | 20 | 0.010 | -0.560 | 0.000 |
| 25 | How are image descriptions generated? | 60 | 0.628 | 20 | 0.010 | -0.618 | 0.000 |

## Raw Top-5 Results by Query

Each query shows the top-5 file paths and scores for both branches side by side.

### Query 1: How does the retrieval pipeline work end-to-end?

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.577 | `src/plugin.ts` | 343-367 | typescript |
| 2 | 0.563 | `src/plugin.ts` | 321-336 | typescript |
| 3 | 0.541 | `src/opencode/read-fallback.ts` | 10-17 | typescript |
| 4 | 0.535 | `src/plugin.ts` | 301-315 | typescript |
| 5 | 0.527 | `src/plugin.ts` | 71-80 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/plugin.ts` | 343-367 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/plugin.ts` | 321-336 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/opencode/read-fallback.ts` | 10-17 | typescript |
| 4 | 0.009 | `../OpenCodeRAG-main/src/plugin.ts` | 301-315 | typescript |
| 5 | 0.009 | `../OpenCodeRAG-main/src/plugin.ts` | 71-80 | typescript |

### Query 2: How does the plugin interact with chat messages?

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.537 | `src/plugin.ts` | 460-484 | typescript |
| 2 | 0.527 | `src/describer/anthropic.ts` | 10-13 | typescript |
| 3 | 0.526 | `src/plugin.ts` | 799-898 | typescript |
| 4 | 0.523 | `src/describer/describer.ts` | 15-18 | typescript |
| 5 | 0.520 | `src/types/opencode-plugin.d.ts` | 25-53 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/plugin.ts` | 460-484 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/describer/anthropic.ts` | 10-13 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/plugin.ts` | 799-898 | typescript |
| 4 | 0.009 | `../OpenCodeRAG-main/src/describer/describer.ts` | 15-18 | typescript |
| 5 | 0.009 | `../OpenCodeRAG-main/src/types/opencode-plugin.d.ts` | 25-53 | typescript |

### Query 3: How does the keyword index combine with vector search?

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.559 | `src/plugin.ts` | 321-336 | typescript |
| 2 | 0.554 | `src/mcp/handlers.ts` | 184-236 | typescript |
| 3 | 0.548 | `src/web/api.ts` | 245-275 | typescript |
| 4 | 0.547 | `src/plugin.ts` | 343-367 | typescript |
| 5 | 0.545 | `src/plugin.ts` | 1044-1061 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/plugin.ts` | 321-336 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/mcp/handlers.ts` | 184-236 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/web/api.ts` | 245-275 | typescript |
| 4 | 0.009 | `../OpenCodeRAG-main/src/plugin.ts` | 343-367 | typescript |
| 5 | 0.009 | `../OpenCodeRAG-main/src/plugin.ts` | 1044-1061 | typescript |

### Query 4: Where is the embedder factory defined?

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.582 | `src/embedder/factory.ts` | 23-46 | typescript |
| 2 | 0.545 | `src/core/bootstrap.ts` | 56-66 | typescript |
| 3 | 0.507 | `src/embedder/factory.ts` | 62-101 | typescript |
| 4 | 0.504 | `src/embedder/health.ts` | 45-61 | typescript |
| 5 | 0.501 | `src/embedder/health.ts` | 397-404 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/embedder/factory.ts` | 23-46 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/core/bootstrap.ts` | 56-66 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/embedder/factory.ts` | 62-101 | typescript |
| 4 | 0.009 | `../OpenCodeRAG-main/src/embedder/health.ts` | 45-61 | typescript |
| 5 | 0.009 | `../OpenCodeRAG-main/src/embedder/health.ts` | 397-404 | typescript |

### Query 5: Where is the LanceDB store implementation?

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.573 | `src/web/api.ts` | 165-186 | typescript |
| 2 | 0.565 | `src/web/api.ts` | 189-192 | typescript |
| 3 | 0.555 | `src/vectorstore/factory.ts` | 22-38 | typescript |
| 4 | 0.531 | `src/web/api.ts` | 230-242 | typescript |
| 5 | 0.522 | `src/web/api.ts` | 199-227 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/web/api.ts` | 165-186 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/web/api.ts` | 189-192 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/vectorstore/factory.ts` | 22-38 | typescript |
| 4 | 0.009 | `../OpenCodeRAG-main/src/web/api.ts` | 230-242 | typescript |
| 5 | 0.009 | `../OpenCodeRAG-main/src/web/api.ts` | 199-227 | typescript |

### Query 6: Find all usages of the retrieve function

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.555 | `src/mcp/handlers.ts` | 366-465 | typescript |
| 2 | 0.546 | `src/opencode/tools.ts` | 293-299 | typescript |
| 3 | 0.543 | `src/opencode/tools.ts` | 428-527 | typescript |
| 4 | 0.534 | `src/mcp/handlers.ts` | 290-299 | typescript |
| 5 | 0.532 | `src/mcp/handlers.ts` | 280-287 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/mcp/handlers.ts` | 366-465 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/opencode/tools.ts` | 293-299 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/opencode/tools.ts` | 428-527 | typescript |
| 4 | 0.009 | `../OpenCodeRAG-main/src/mcp/handlers.ts` | 290-299 | typescript |
| 5 | 0.009 | `../OpenCodeRAG-main/src/mcp/handlers.ts` | 280-287 | typescript |

### Query 7: Find all usages of SearchResult type

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.576 | `src/mcp/handlers.ts` | 290-299 | typescript |
| 2 | 0.568 | `src/mcp/handlers.ts` | 366-465 | typescript |
| 3 | 0.566 | `src/mcp/handlers.ts` | 176-181 | typescript |
| 4 | 0.562 | `src/opencode/tools.ts` | 528-627 | typescript |
| 5 | 0.562 | `src/mcp/handlers.ts` | 280-287 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/mcp/handlers.ts` | 290-299 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/mcp/handlers.ts` | 366-465 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/mcp/handlers.ts` | 176-181 | typescript |
| 4 | 0.009 | `../OpenCodeRAG-main/src/opencode/tools.ts` | 528-627 | typescript |
| 5 | 0.009 | `../OpenCodeRAG-main/src/mcp/handlers.ts` | 280-287 | typescript |

### Query 8: How does the chunker factory register new languages?

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.607 | `src/chunker/factory.ts` | 97-115 | typescript |
| 2 | 0.570 | `src/chunker/base.ts` | 57-64 | typescript |
| 3 | 0.560 | `src/chunker/grammar.ts` | 87-97 | typescript |
| 4 | 0.546 | `src/chunker/grammar.ts` | 110-123 | typescript |
| 5 | 0.543 | `src/chunker/factory.ts` | 134-136 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/chunker/factory.ts` | 97-115 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/chunker/base.ts` | 57-64 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/chunker/grammar.ts` | 87-97 | typescript |
| 4 | 0.009 | `../OpenCodeRAG-main/src/chunker/grammar.ts` | 110-123 | typescript |
| 5 | 0.009 | `../OpenCodeRAG-main/src/chunker/factory.ts` | 134-136 | typescript |

### Query 9: What is the default minScore configuration?

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.489 | `src/chunker/fallback.ts` | 15-17 | typescript |
| 2 | 0.484 | `src/retriever/context-optimizer.ts` | 49-51 | typescript |
| 3 | 0.482 | `src/describer/anthropic.ts` | 34-36 | typescript |
| 4 | 0.477 | `src/embedder/cohere.ts` | 26-32 | typescript |
| 5 | 0.477 | `src/plugin.ts` | 412-448 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/chunker/fallback.ts` | 15-17 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/retriever/context-optimizer.ts` | 49-51 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/describer/anthropic.ts` | 34-36 | typescript |
| 4 | 0.009 | `../OpenCodeRAG-main/src/embedder/cohere.ts` | 26-32 | typescript |
| 5 | 0.009 | `../OpenCodeRAG-main/src/plugin.ts` | 412-448 | typescript |

### Query 10: How does the session logger capture token usage?

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.650 | `src/eval/session-logger.ts` | 26-40 | typescript |
| 2 | 0.624 | `src/eval/session-logger.ts` | 12-24 | typescript |
| 3 | 0.605 | `src/eval/session-logger.ts` | 43-52 | typescript |
| 4 | 0.597 | `src/eval/token-analysis.ts` | 83-182 | typescript |
| 5 | 0.573 | `src/web/api.ts` | 385-407 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/eval/session-logger.ts` | 26-40 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/eval/session-logger.ts` | 12-24 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/eval/session-logger.ts` | 43-52 | typescript |
| 4 | 0.009 | `../OpenCodeRAG-main/src/eval/token-analysis.ts` | 83-182 | typescript |
| 5 | 0.009 | `../OpenCodeRAG-main/src/web/api.ts` | 385-407 | typescript |

### Query 11: How does L2 normalization affect vector search scores?

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.534 | `src/retriever/context-optimizer.ts` | 49-51 | typescript |
| 2 | 0.517 | `src/plugin.ts` | 343-367 | typescript |
| 3 | 0.508 | `src/plugin.ts` | 321-336 | typescript |
| 4 | 0.503 | `src/embedder/ollama.ts` | 51-97 | typescript |
| 5 | 0.498 | `src/eval/token-analysis.ts` | 223-307 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/retriever/context-optimizer.ts` | 49-51 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/plugin.ts` | 343-367 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/plugin.ts` | 321-336 | typescript |
| 4 | 0.009 | `../OpenCodeRAG-main/src/embedder/ollama.ts` | 51-97 | typescript |
| 5 | 0.009 | `../OpenCodeRAG-main/src/eval/token-analysis.ts` | 223-307 | typescript |

### Query 12: What is the MetadataFilter interface used for?

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.502 | `src/mcp/handlers.ts` | 308-313 | typescript |
| 2 | 0.499 | `src/plugin.ts` | 71-80 | typescript |
| 3 | 0.493 | `src/indexer/metadata.ts` | 88-105 | typescript |
| 4 | 0.491 | `src/opencode/tools.ts` | 293-299 | typescript |
| 5 | 0.490 | `src/opencode/create-read-tool.ts` | 261-264 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/mcp/handlers.ts` | 308-313 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/plugin.ts` | 71-80 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/indexer/metadata.ts` | 88-105 | typescript |
| 4 | 0.009 | `../OpenCodeRAG-main/src/opencode/tools.ts` | 293-299 | typescript |
| 5 | 0.009 | `../OpenCodeRAG-main/src/opencode/create-read-tool.ts` | 261-264 | typescript |

### Query 13: How does the background indexer handle file changes?

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.601 | `src/watcher.ts` | 78-177 | typescript |
| 2 | 0.584 | `src/watcher.ts` | 21-24 | typescript |
| 3 | 0.583 | `src/watcher.ts` | 27-46 | typescript |
| 4 | 0.565 | `src/indexer/worker.ts` | 120-125 | typescript |
| 5 | 0.550 | `src/watcher.ts` | 178-189 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/watcher.ts` | 78-177 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/watcher.ts` | 21-24 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/watcher.ts` | 27-46 | typescript |
| 4 | 0.009 | `../OpenCodeRAG-main/src/indexer/worker.ts` | 120-125 | typescript |
| 5 | 0.009 | `../OpenCodeRAG-main/src/watcher.ts` | 178-189 | typescript |

### Query 14: Where is the config validation logic?

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.511 | `src/eval/run-token-test.ts` | 40-48 | typescript |
| 2 | 0.511 | `src/tui.ts` | 265-271 | typescript |
| 3 | 0.505 | `src/cli/format.ts` | 130-134 | typescript |
| 4 | 0.499 | `src/plugin.ts` | 193-215 | typescript |
| 5 | 0.491 | `src/tui.ts` | 361-376 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/eval/run-token-test.ts` | 40-48 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/tui.ts` | 265-271 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/cli/format.ts` | 130-134 | typescript |
| 4 | 0.009 | `../OpenCodeRAG-main/src/plugin.ts` | 193-215 | typescript |
| 5 | 0.009 | `../OpenCodeRAG-main/src/tui.ts` | 361-376 | typescript |

### Query 15: How are PDF documents chunked and indexed?

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.599 | `src/chunker/docx.ts` | 39-108 | typescript |
| 2 | 0.580 | `src/chunker/doc.ts` | 40-109 | typescript |
| 3 | 0.556 | `src/indexer/worker.ts` | 120-125 | typescript |
| 4 | 0.550 | `src/chunker/excel.ts` | 49-108 | typescript |
| 5 | 0.548 | `src/content/pdf.ts` | 15-23 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/chunker/docx.ts` | 39-108 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/chunker/doc.ts` | 40-109 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/indexer/worker.ts` | 120-125 | typescript |
| 4 | 0.009 | `../OpenCodeRAG-main/src/chunker/excel.ts` | 49-108 | typescript |
| 5 | 0.009 | `../OpenCodeRAG-main/src/content/pdf.ts` | 15-23 | typescript |

### Query 16: What embedding providers are supported?

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.661 | `src/embedder/ollama.ts` | 51-97 | typescript |
| 2 | 0.645 | `src/embedder/openai.ts` | 60-89 | typescript |
| 3 | 0.645 | `src/embedder/health.ts` | 45-61 | typescript |
| 4 | 0.643 | `src/embedder/factory.ts` | 23-46 | typescript |
| 5 | 0.609 | `src/core/bootstrap.ts` | 56-66 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/embedder/ollama.ts` | 51-97 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/embedder/openai.ts` | 60-89 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/embedder/health.ts` | 45-61 | typescript |
| 4 | 0.009 | `../OpenCodeRAG-main/src/embedder/factory.ts` | 23-46 | typescript |
| 5 | 0.009 | `../OpenCodeRAG-main/src/core/bootstrap.ts` | 56-66 | typescript |

### Query 17: How does the CLI parse and dispatch commands?

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.552 | `src/cli/commands/query.ts` | 25-101 | typescript |
| 2 | 0.536 | `src/cli/commands/eval.ts` | 71-134 | typescript |
| 3 | 0.522 | `src/cli/format.ts` | 110-122 | typescript |
| 4 | 0.519 | `src/cli/commands/index.ts` | 1-18 | text |
| 5 | 0.517 | `src/cli/commands/show.ts` | 22-59 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/cli/commands/query.ts` | 25-101 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/cli/commands/eval.ts` | 71-134 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/cli/format.ts` | 110-122 | typescript |
| 4 | 0.009 | `../OpenCodeRAG-main/src/cli/commands/index.ts` | 1-18 | text |
| 5 | 0.009 | `../OpenCodeRAG-main/src/cli/commands/show.ts` | 22-59 | typescript |

### Query 18: How does the session logger persist events?

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.663 | `src/eval/session-logger.ts` | 43-52 | typescript |
| 2 | 0.653 | `src/eval/session-logger.ts` | 58-157 | typescript |
| 3 | 0.623 | `src/eval/session-logger.ts` | 158-183 | typescript |
| 4 | 0.620 | `src/eval/session-logger.ts` | 26-40 | typescript |
| 5 | 0.605 | `src/eval/storage.ts` | 26-35 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/eval/session-logger.ts` | 43-52 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/eval/session-logger.ts` | 58-157 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/eval/session-logger.ts` | 158-183 | typescript |
| 4 | 0.009 | `../OpenCodeRAG-main/src/eval/session-logger.ts` | 26-40 | typescript |
| 5 | 0.009 | `../OpenCodeRAG-main/src/eval/storage.ts` | 26-35 | typescript |

### Query 19: What is the manifest schema version used for?

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.490 | `src/mcp/handlers.ts` | 308-313 | typescript |
| 2 | 0.490 | `src/core/version-check.ts` | 1-7 | typescript |
| 3 | 0.488 | `src/describer/anthropic.ts` | 15-17 | typescript |
| 4 | 0.487 | `src/indexer/pipeline.ts` | 749-819 | typescript |
| 5 | 0.485 | `src/eval/types.ts` | 68-93 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/mcp/handlers.ts` | 308-313 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/core/version-check.ts` | 1-7 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/describer/anthropic.ts` | 15-17 | typescript |
| 4 | 0.009 | `../OpenCodeRAG-main/src/indexer/pipeline.ts` | 749-819 | typescript |
| 5 | 0.009 | `../OpenCodeRAG-main/src/eval/types.ts` | 68-93 | typescript |

### Query 20: How does the OpenCode plugin register tools?

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.622 | `src/plugin.ts` | 1213-1312 | typescript |
| 2 | 0.615 | `src/plugin.ts` | 699-798 | typescript |
| 3 | 0.595 | `src/plugin-entry.ts` | 1-19 | text |
| 4 | 0.586 | `src/cli/commands/setup.ts` | 28-40 | typescript |
| 5 | 0.565 | `src/plugin.ts` | 499-598 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/plugin.ts` | 1213-1312 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/plugin.ts` | 699-798 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/plugin-entry.ts` | 1-19 | text |
| 4 | 0.009 | `../OpenCodeRAG-main/src/cli/commands/setup.ts` | 28-40 | typescript |
| 5 | 0.009 | `../OpenCodeRAG-main/src/plugin.ts` | 499-598 | typescript |

### Query 21: Where is the globMatch function defined?

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.491 | `src/chunker/ssl.ts` | 145-165 | typescript |
| 2 | 0.483 | `src/mcp/handlers.ts` | 290-299 | typescript |
| 3 | 0.468 | `src/opencode/tools.ts` | 628-642 | typescript |
| 4 | 0.467 | `src/mcp/handlers.ts` | 159-161 | typescript |
| 5 | 0.465 | `src/core/provider-defaults.ts` | 100-105 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/chunker/ssl.ts` | 145-165 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/mcp/handlers.ts` | 290-299 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/opencode/tools.ts` | 628-642 | typescript |
| 4 | 0.009 | `../OpenCodeRAG-main/src/mcp/handlers.ts` | 159-161 | typescript |
| 5 | 0.009 | `../OpenCodeRAG-main/src/core/provider-defaults.ts` | 100-105 | typescript |

### Query 22: How does the proxy-aware HTTP client work?

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.547 | `src/embedder/http.ts` | 152-164 | typescript |
| 2 | 0.543 | `src/embedder/http.ts` | 484-501 | typescript |
| 3 | 0.540 | `src/embedder/http.ts` | 143-149 | typescript |
| 4 | 0.533 | `src/embedder/http.ts` | 504-557 | typescript |
| 5 | 0.528 | `src/embedder/cohere.ts` | 26-32 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/embedder/http.ts` | 152-164 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/embedder/http.ts` | 484-501 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/embedder/http.ts` | 143-149 | typescript |
| 4 | 0.009 | `../OpenCodeRAG-main/src/embedder/http.ts` | 504-557 | typescript |
| 5 | 0.009 | `../OpenCodeRAG-main/src/embedder/cohere.ts` | 26-32 | typescript |

### Query 23: What is the FETCH_OVERFETCH_FACTOR constant?

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.497 | `src/core/runtime-overrides.ts` | 12-54 | typescript |
| 2 | 0.491 | `src/eval/token-analysis.ts` | 397-420 | typescript |
| 3 | 0.490 | `src/chunker/fallback.ts` | 15-17 | typescript |
| 4 | 0.480 | `src/eval/token-analysis.ts` | 223-307 | typescript |
| 5 | 0.479 | `src/web/api.ts` | 416-440 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/core/runtime-overrides.ts` | 12-54 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/eval/token-analysis.ts` | 397-420 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/chunker/fallback.ts` | 15-17 | typescript |
| 4 | 0.009 | `../OpenCodeRAG-main/src/eval/token-analysis.ts` | 223-307 | typescript |
| 5 | 0.009 | `../OpenCodeRAG-main/src/web/api.ts` | 416-440 | typescript |

### Query 24: How does the TUI settings menu work?

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.570 | `src/tui.ts` | 283-294 | typescript |
| 2 | 0.568 | `src/tui.ts` | 608-707 | typescript |
| 3 | 0.556 | `src/tui.ts` | 297-306 | typescript |
| 4 | 0.531 | `src/tui.ts` | 527-602 | typescript |
| 5 | 0.516 | `src/tui.ts` | 427-526 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/tui.ts` | 283-294 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/tui.ts` | 608-707 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/tui.ts` | 297-306 | typescript |
| 4 | 0.009 | `../OpenCodeRAG-main/src/tui.ts` | 527-602 | typescript |
| 5 | 0.009 | `../OpenCodeRAG-main/src/tui.ts` | 427-526 | typescript |

### Query 25: How are image descriptions generated?

**`main`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.628 | `src/chunker/image.ts` | 151-208 | typescript |
| 2 | 0.611 | `src/chunker/image.ts` | 231-292 | typescript |
| 3 | 0.606 | `src/mcp/handlers.ts` | 308-313 | typescript |
| 4 | 0.597 | `src/opencode/tools.ts` | 334-415 | typescript |
| 5 | 0.594 | `src/indexer/description-stage.ts` | 32-119 | typescript |

**`t1-cosine-l2`**  
| Rank | Score | File | Lines | Language |
|------|-------|------|-------|----------|
| 1 | 0.010 | `../OpenCodeRAG-main/src/chunker/image.ts` | 151-208 | typescript |
| 2 | 0.010 | `../OpenCodeRAG-main/src/chunker/image.ts` | 231-292 | typescript |
| 3 | 0.010 | `../OpenCodeRAG-main/src/mcp/handlers.ts` | 308-313 | typescript |
| 4 | 0.009 | `../OpenCodeRAG-main/src/opencode/tools.ts` | 334-415 | typescript |
| 5 | 0.009 | `../OpenCodeRAG-main/src/indexer/description-stage.ts` | 32-119 | typescript |

## Explanation / Score Breakdown (Sample)

First 3 queries with explanation details when available.

### Query 1: How does the retrieval pipeline work end-to-end?

**`main`** (top-1 explanation)  
| Component | Value |
|-----------|-------|
| vectorScore | 0.577 |
| keywordScore | 0.000 |
| rawVectorScore | 0.577 |
| rawKeywordScore | 0.000 |
| keywordWeight | 0.400 |

**`t1-cosine-l2`** (top-1 explanation)  
| Component | Value |
|-----------|-------|
| vectorScore | 0.010 |
| keywordScore | 0.000 |
| rawVectorScore | 0.817 |
| rawKeywordScore | 0.000 |
| keywordWeight | 0.400 |
| vectorRank | 0 |

### Query 2: How does the plugin interact with chat messages?

**`main`** (top-1 explanation)  
| Component | Value |
|-----------|-------|
| vectorScore | 0.537 |
| keywordScore | 0.000 |
| rawVectorScore | 0.537 |
| rawKeywordScore | 0.000 |
| keywordWeight | 0.400 |

**`t1-cosine-l2`** (top-1 explanation)  
| Component | Value |
|-----------|-------|
| vectorScore | 0.010 |
| keywordScore | 0.000 |
| rawVectorScore | 0.784 |
| rawKeywordScore | 0.000 |
| keywordWeight | 0.400 |
| vectorRank | 0 |

### Query 3: How does the keyword index combine with vector search?

**`main`** (top-1 explanation)  
| Component | Value |
|-----------|-------|
| vectorScore | 0.559 |
| keywordScore | 0.000 |
| rawVectorScore | 0.559 |
| rawKeywordScore | 0.000 |
| keywordWeight | 0.400 |

**`t1-cosine-l2`** (top-1 explanation)  
| Component | Value |
|-----------|-------|
| vectorScore | 0.010 |
| keywordScore | 0.000 |
| rawVectorScore | 0.803 |
| rawKeywordScore | 0.000 |
| keywordWeight | 0.400 |
| vectorRank | 0 |

## Verdict

The `t1-cosine-l2` branch shows:

- **notable rank shift (Jaccard 0.000)**

### Caveats

- Cosine similarity + RRF produce fundamentally different score distributions than L2 + linear fusion.
  **Absolute scores are not directly comparable** between the two approaches.
- The key quality indicator is **whether relevant files rank highly**, not the raw score value.
- RRF de-emphasizes raw similarity magnitude and focuses on rank agreement between vector and keyword signals.
- This means an RRF score of 0.05 can be just as meaningful as an L2 score of 0.85 — they are different scales.

### Recommendation

Review the raw top-5 results per query above to confirm that the cosine+RRF approach
retrieves the same or better files. If rank stability is high (Jaccard > 0.5) and
threshold coverage improves, the new scoring is likely a net positive.
