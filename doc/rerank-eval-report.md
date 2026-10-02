# Rerank A/B Evaluation

**Date:** 2026-10-02T07:36:05.424Z
**Worktree:** C:\Daten\Entwicklung\OpenCodeRAG
**Indexed chunks:** 2234
**Embedder:** openai/Qwen3-Embedding:8B (dimension 4096)
**Retrieval:** topK=20, minScore=0.35, hybrid=true, keywordWeight=0.4
**Labels:** 48 from `src/eval/rerank-labels.json`
**Categories:** nl=20, gotcha=12, symbol=12, de=4
**Warmup:** 2 discarded queries per arm (p50/p95 are warm measurements)

## Arm status

| Arm | Status | Note |
|-----|--------|------|
| `baseline` | ok | current pipeline (reranking disabled) |
| `rerank20` | ok | rerank stage, candidates=20 |
| `rerank30` | ok | rerank stage, candidates=30 |
| `rerank-desc` | ok | rerank stage, docField=content+description |

## Aggregate metrics (warm)

| Metric | `baseline` | `rerank20` | `rerank30` | `rerank-desc` |
|--------|---|---|---|---|
| Hit@1 | 14.6% | 22.9% | 22.9% | 29.2% |
| Hit@3 | 41.7% | 50.0% | 50.0% | 56.3% |
| Hit@5 | 47.9% | 66.7% | 68.8% | 66.7% |
| Hit@10 | 79.2% | 83.3% | 81.3% | 85.4% |
| Precision@5 | 0.100 | 0.133 | 0.138 | 0.133 |
| Recall@10 | 76.0% | 79.2% | 78.1% | 81.3% |
| MRR | 0.339 | 0.414 | 0.408 | 0.466 |
| nDCG@10 | 0.428 | 0.498 | 0.489 | 0.544 |
| Symbol hit rate | 84.2% | 84.2% | 89.5% | 84.2% |
| Latency avg | 94 ms | 2975 ms | 4337 ms | 3102 ms |
| Latency p50 | 92 ms | 3029 ms | 4429 ms | 3139 ms |
| Latency p95 | 102 ms | 3755 ms | 5507 ms | 3864 ms |
| Reranked queries | 0/48 | 48/48 | 47/48 | 48/48 |

## Effect vs. baseline

| Arm | Δ nDCG@10 | Δ MRR | Δ Hit@5 | Δ p50 latency | Top-5 overlap | Changed top-1 |
|-----|-----------|-------|---------|---------------|---------------|---------------|
| `rerank20` | +0.070 | +0.074 | +0.187 | +2937 ms | 53.8% | 35/48 |
| `rerank30` | +0.061 | +0.068 | +0.208 | +4337 ms | 48.8% | 35/48 |
| `rerank-desc` | +0.116 | +0.127 | +0.187 | +3047 ms | 56.7% | 34/48 |

## Metrics by category

| Arm | Category | Hit@1 | Hit@5 | MRR | nDCG@10 |
|-----|----------|-------|-------|-----|---------|
| `baseline` | nl | 5.0% | 45.0% | 0.285 | 0.373 |
| `baseline` | gotcha | 8.3% | 33.3% | 0.252 | 0.319 |
| `baseline` | symbol | 41.7% | 66.7% | 0.554 | 0.658 |
| `baseline` | de | 0.0% | 50.0% | 0.231 | 0.343 |
| `rerank20` | nl | 10.0% | 60.0% | 0.293 | 0.389 |
| `rerank20` | gotcha | 16.7% | 66.7% | 0.403 | 0.490 |
| `rerank20` | symbol | 58.3% | 83.3% | 0.714 | 0.760 |
| `rerank20` | de | 0.0% | 50.0% | 0.149 | 0.277 |
| `rerank30` | nl | 10.0% | 55.0% | 0.262 | 0.341 |
| `rerank30` | gotcha | 16.7% | 83.3% | 0.426 | 0.528 |
| `rerank30` | symbol | 58.3% | 83.3% | 0.695 | 0.744 |
| `rerank30` | de | 0.0% | 50.0% | 0.217 | 0.343 |
| `rerank-desc` | nl | 15.0% | 55.0% | 0.326 | 0.429 |
| `rerank-desc` | gotcha | 33.3% | 75.0% | 0.507 | 0.569 |
| `rerank-desc` | symbol | 58.3% | 91.7% | 0.750 | 0.812 |
| `rerank-desc` | de | 0.0% | 25.0% | 0.193 | 0.237 |

## Per-query results

| ID | Category | Query | Expected files | `baseline` | `rerank20` | `rerank30` | `rerank-desc` |
|----|----------|-------|----------------|---|---|---|---|
| nl-01 | nl | How does the retrieval pipeline work end-to-end? | src/retriever/retriever.ts | #17 (sym #17) | #12 (sym #12) | #14 (sym #14) | #11 (sym #11) |
| nl-02 | nl | How does the plugin interact with chat messages? | src/plugin.ts | #3 | #3 | #3 | #5 |
| nl-03 | nl | How does the keyword index combine with vector se... | src/retriever/retriever.ts, src/retriever/keyword-index.ts | #2 | #10 | #14 | #10 |
| nl-04 | nl | Where is the embedder factory defined? | src/embedder/factory.ts | #2 (sym #7) | #10 (sym #12) | #14 (sym #16) | #6 (sym #6) |
| nl-05 | nl | Where is the LanceDB store implementation? | src/vectorstore/lancedb.ts | #2 (sym miss) | #2 (sym miss) | #5 (sym miss) | #1 (sym miss) |
| nl-06 | nl | Find all usages of the retrieve function | src/retriever/retriever.ts | miss (sym miss) | miss (sym miss) | #14 (sym #14) | miss (sym miss) |
| nl-07 | nl | Find all usages of SearchResult type | src/core/interfaces.ts | #6 (sym #6) | #5 (sym #5) | #5 (sym #5) | #3 (sym #3) |
| nl-08 | nl | How does the chunker factory register new languages? | src/chunker/factory.ts | #2 | #1 | #1 | #1 |
| nl-09 | nl | What is the default minScore configuration? | src/core/config.ts | #2 (sym #2) | #4 (sym #4) | #4 (sym #4) | #4 (sym #4) |
| nl-10 | nl | How does the session logger capture token usage? | src/eval/session-logger.ts | #11 (sym #14) | #4 (sym #4) | #4 (sym #4) | #9 (sym #9) |
| nl-11 | nl | How are files scanned and excluded during indexing? | src/content/reader.ts, src/core/exclude.ts | #10 (sym #10) | #4 (sym #4) | #6 (sym #6) | #9 (sym #10) |
| nl-12 | nl | How does incremental indexing detect changed files? | src/indexer/git-diff.ts, src/indexer/pipeline.ts | #2 | #7 | #9 | #8 |
| nl-13 | nl | How does the background watcher lock a workspace? | src/watcher.ts | #8 (sym #13) | #3 (sym #11) | #3 (sym #12) | #3 (sym #10) |
| nl-14 | nl | How does quirk recall work? | src/quirks/quirk-store.ts | #8 (sym #8) | #2 (sym #2) | #3 (sym #3) | #2 (sym #2) |
| nl-15 | nl | How does description generation work for code chu... | src/describer/describer.ts | #8 | #6 | #7 | #2 |
| nl-16 | nl | How are images described during indexing? | src/chunker/image.ts | #18 (sym miss) | #14 (sym miss) | #12 (sym miss) | #9 (sym miss) |
| nl-17 | nl | How does the MCP server expose tools? | src/mcp/server.ts, src/mcp/handlers.ts | #6 | #5 | #5 | #4 |
| nl-18 | nl | How are runtime config overrides applied? | src/core/runtime-overrides.ts | #4 | #4 | #4 | #5 |
| nl-19 | nl | How does token counting estimate RAG context size? | src/eval/token-counter.ts | #10 (sym #10) | #8 (sym #8) | #10 (sym #10) | #7 (sym #7) |
| nl-20 | nl | How is the vector store dimension resolved at sta... | src/core/bootstrap.ts | #1 (sym #11) | #1 (sym #2) | #1 (sym #2) | #1 (sym #2) |
| gotcha-01 | gotcha | LanceDB IVF index metric cosine incompatible fall... | src/vectorstore/lancedb.ts | #2 (sym #2) | #6 (sym #6) | #5 (sym #5) | #2 (sym #2) |
| gotcha-02 | gotcha | LanceDB partition is empty skipping warning disca... | src/vectorstore/lancedb.ts | #2 (sym #2) | #3 (sym #9) | #4 (sym #11) | #4 (sym #9) |
| gotcha-03 | gotcha | embedding dimension mismatch silently zero pads v... | src/vectorstore/lancedb.ts | #1 (sym #1) | #1 (sym #1) | #1 (sym #1) | #1 (sym #1) |
| gotcha-04 | gotcha | watcher lock stale reclaim pid liveness | src/watcher.ts | #7 | #3 | #3 | #1 |
| gotcha-05 | gotcha | quirk auto capture dedup threshold | src/quirks/auto-capture.ts | #13 (sym #14) | #2 (sym #2) | #2 (sym #3) | #2 (sym #2) |
| gotcha-06 | gotcha | excludeDirs matches basename at any depth | src/core/exclude.ts | #9 | #2 | #2 | #2 |
| gotcha-07 | gotcha | tree-sitter WASM parser Language Node API | src/chunker/grammar.ts | #9 | #2 | #2 | #3 |
| gotcha-08 | gotcha | Ollama embedding response embedding vs embeddings | src/embedder/ollama.ts | miss | miss | #2 | miss |
| gotcha-09 | gotcha | embedding preflight aborts when provider dimensio... | src/indexer/pipeline.ts | miss | miss | miss | miss |
| gotcha-10 | gotcha | describe image on demand model override | src/chunker/image.ts | #13 (sym #15) | #2 (sym #2) | #3 (sym #3) | #1 (sym #1) |
| gotcha-11 | gotcha | quirks jsonl reconcile store keyword index | src/quirks/quirk-store.ts | #2 (sym #5) | #1 (sym #2) | #1 (sym #2) | #1 (sym #2) |
| gotcha-12 | gotcha | noUncheckedIndexedAccess array indexing possibly ... | tsconfig.json | miss | miss | miss | miss |
| symbol-01 | symbol | resolveRagContext | src/core/bootstrap.ts | #3 | #1 | #1 | #1 |
| symbol-02 | symbol | ensureCosineIndex | src/vectorstore/lancedb.ts | #1 | #1 | #1 | #1 |
| symbol-03 | symbol | detectQueryShape | src/retriever/retriever.ts | #1 | #1 | #1 | #1 |
| symbol-04 | symbol | createBackgroundIndexer | src/watcher.ts | #9 | #1 | #1 | #1 |
| symbol-05 | symbol | walkFiles | src/content/reader.ts | #6 | #2 | #3 | #2 |
| symbol-06 | symbol | createEmbedder | src/embedder/factory.ts | #1 | #3 | #3 | #2 |
| symbol-07 | symbol | LanceDbStore | src/vectorstore/lancedb.ts | #1 | #6 | #9 | #2 |
| symbol-08 | symbol | KeywordIndex | src/retriever/keyword-index.ts | #2 | #14 | #16 | #6 |
| symbol-09 | symbol | analyzeTokenUsage | src/eval/token-analysis.ts | #8 | #2 | #2 | #3 |
| symbol-10 | symbol | buildAgentsMdDirective | src/opencode/system-guidance.ts | #4 | #1 | #1 | #1 |
| symbol-11 | symbol | reconcileQuirks | src/quirks/quirk-store.ts | #1 | #1 | #1 | #1 |
| symbol-12 | symbol | resolveOnDemandImageConfig | src/chunker/image.ts | #6 | #1 | #1 | #1 |
| de-01 | de | Wie funktioniert die Hybrid-Suche aus Vektor- und... | src/retriever/retriever.ts | #5 | #7 | #5 | #8 |
| de-02 | de | Wo wird die Ausschlussliste für Verzeichnisse ang... | src/core/exclude.ts | #2 | #5 | #6 | #2 |
| de-03 | de | Wie wird der Index inkrementell aktualisiert? | src/indexer/pipeline.ts | #18 | #19 | miss | #18 |
| de-04 | de | Wie funktioniert die Quirk-Erinnerung? | src/quirks/quirk-store.ts | #6 | #5 | #2 | #11 |

## Interpretation notes

- **Rank shown** is the position of the first expected file (1-based); `sym` marks the rank of a chunk
  that also contains the expected symbol.
- **Reranked queries** counts queries where the rerank stage actually reordered (`rerankScore` present in
  the explanation). Fewer than N means the provider timed out/errored or the cooldown was active; those
  queries measured the fusion order, so rerank deltas are conservative.
- **Misses are not necessarily retrieval failures**: a label may map to multiple files and the metric
  counts every expected file; check the per-query table before drawing conclusions.
- **Rerank arms are reorder-only** (`reranking.minScore=0`): the candidate set is unchanged, only the order
  within the top-K differs. A reranker that only churns ranks without improving nDCG@10/MRR is not worth
  the latency cost — that is the decision this report informs.
- Latency was measured warm on a local llama-swap tunnel; p95 includes network jitter. Cold start is not
  included and must be measured separately before enabling the stage by default.
