# Rerank A/B Evaluation

**Date:** 2026-10-02T07:16:54.018Z
**Worktree:** C:\Daten\Entwicklung\OpenCodeRAG
**Indexed chunks:** 2234
**Embedder:** openai/Qwen3-Embedding-8B (dimension 4096)
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
| Hit@1 | 0.0% | 0.0% | 0.0% | 0.0% |
| Hit@3 | 0.0% | 0.0% | 0.0% | 0.0% |
| Hit@5 | 0.0% | 0.0% | 0.0% | 0.0% |
| Hit@10 | 0.0% | 0.0% | 0.0% | 0.0% |
| Precision@5 | 0.000 | 0.000 | 0.000 | 0.000 |
| Recall@10 | 0.0% | 0.0% | 0.0% | 0.0% |
| MRR | 0.000 | 0.000 | 0.000 | 0.000 |
| nDCG@10 | 0.000 | 0.000 | 0.000 | 0.000 |
| Symbol hit rate | - | - | - | - |
| Latency avg | 12 ms | 12 ms | 14 ms | 14 ms |
| Latency p50 | 8 ms | 8 ms | 8 ms | 7 ms |
| Latency p95 | 48 ms | 22 ms | 51 ms | 50 ms |
| Reranked queries | 0/48 | 0/48 | 0/48 | 0/48 |

## Effect vs. baseline

| Arm | Δ nDCG@10 | Δ MRR | Δ Hit@5 | Δ p50 latency | Top-5 overlap | Changed top-1 |
|-----|-----------|-------|---------|---------------|---------------|---------------|
| `rerank20` | +0.000 | +0.000 | +0.000 | +0 ms | 100.0% | 0/48 |
| `rerank30` | +0.000 | +0.000 | +0.000 | -0 ms | 100.0% | 0/48 |
| `rerank-desc` | +0.000 | +0.000 | +0.000 | -1 ms | 100.0% | 0/48 |

## Metrics by category

| Arm | Category | Hit@1 | Hit@5 | MRR | nDCG@10 |
|-----|----------|-------|-------|-----|---------|
| `baseline` | nl | 0.0% | 0.0% | 0.000 | 0.000 |
| `baseline` | gotcha | 0.0% | 0.0% | 0.000 | 0.000 |
| `baseline` | symbol | 0.0% | 0.0% | 0.000 | 0.000 |
| `baseline` | de | 0.0% | 0.0% | 0.000 | 0.000 |
| `rerank20` | nl | 0.0% | 0.0% | 0.000 | 0.000 |
| `rerank20` | gotcha | 0.0% | 0.0% | 0.000 | 0.000 |
| `rerank20` | symbol | 0.0% | 0.0% | 0.000 | 0.000 |
| `rerank20` | de | 0.0% | 0.0% | 0.000 | 0.000 |
| `rerank30` | nl | 0.0% | 0.0% | 0.000 | 0.000 |
| `rerank30` | gotcha | 0.0% | 0.0% | 0.000 | 0.000 |
| `rerank30` | symbol | 0.0% | 0.0% | 0.000 | 0.000 |
| `rerank30` | de | 0.0% | 0.0% | 0.000 | 0.000 |
| `rerank-desc` | nl | 0.0% | 0.0% | 0.000 | 0.000 |
| `rerank-desc` | gotcha | 0.0% | 0.0% | 0.000 | 0.000 |
| `rerank-desc` | symbol | 0.0% | 0.0% | 0.000 | 0.000 |
| `rerank-desc` | de | 0.0% | 0.0% | 0.000 | 0.000 |

## Per-query results

| ID | Category | Query | Expected files | `baseline` | `rerank20` | `rerank30` | `rerank-desc` |
|----|----------|-------|----------------|---|---|---|---|
| nl-01 | nl | How does the retrieval pipeline work end-to-end? | src/retriever/retriever.ts | miss (sym miss) | miss (sym miss) | miss (sym miss) | miss (sym miss) |
| nl-02 | nl | How does the plugin interact with chat messages? | src/plugin.ts | miss | miss | miss | miss |
| nl-03 | nl | How does the keyword index combine with vector se... | src/retriever/retriever.ts, src/retriever/keyword-index.ts | miss | miss | miss | miss |
| nl-04 | nl | Where is the embedder factory defined? | src/embedder/factory.ts | miss (sym miss) | miss (sym miss) | miss (sym miss) | miss (sym miss) |
| nl-05 | nl | Where is the LanceDB store implementation? | src/vectorstore/lancedb.ts | miss (sym miss) | miss (sym miss) | miss (sym miss) | miss (sym miss) |
| nl-06 | nl | Find all usages of the retrieve function | src/retriever/retriever.ts | miss (sym miss) | miss (sym miss) | miss (sym miss) | miss (sym miss) |
| nl-07 | nl | Find all usages of SearchResult type | src/core/interfaces.ts | miss (sym miss) | miss (sym miss) | miss (sym miss) | miss (sym miss) |
| nl-08 | nl | How does the chunker factory register new languages? | src/chunker/factory.ts | miss | miss | miss | miss |
| nl-09 | nl | What is the default minScore configuration? | src/core/config.ts | miss (sym miss) | miss (sym miss) | miss (sym miss) | miss (sym miss) |
| nl-10 | nl | How does the session logger capture token usage? | src/eval/session-logger.ts | miss (sym miss) | miss (sym miss) | miss (sym miss) | miss (sym miss) |
| nl-11 | nl | How are files scanned and excluded during indexing? | src/content/reader.ts, src/core/exclude.ts | miss (sym miss) | miss (sym miss) | miss (sym miss) | miss (sym miss) |
| nl-12 | nl | How does incremental indexing detect changed files? | src/indexer/git-diff.ts, src/indexer/pipeline.ts | miss | miss | miss | miss |
| nl-13 | nl | How does the background watcher lock a workspace? | src/watcher.ts | miss (sym miss) | miss (sym miss) | miss (sym miss) | miss (sym miss) |
| nl-14 | nl | How does quirk recall work? | src/quirks/quirk-store.ts | miss (sym miss) | miss (sym miss) | miss (sym miss) | miss (sym miss) |
| nl-15 | nl | How does description generation work for code chu... | src/describer/describer.ts | miss | miss | miss | miss |
| nl-16 | nl | How are images described during indexing? | src/chunker/image.ts | miss (sym miss) | miss (sym miss) | miss (sym miss) | miss (sym miss) |
| nl-17 | nl | How does the MCP server expose tools? | src/mcp/server.ts, src/mcp/handlers.ts | miss | miss | miss | miss |
| nl-18 | nl | How are runtime config overrides applied? | src/core/runtime-overrides.ts | miss | miss | miss | miss |
| nl-19 | nl | How does token counting estimate RAG context size? | src/eval/token-counter.ts | miss (sym miss) | miss (sym miss) | miss (sym miss) | miss (sym miss) |
| nl-20 | nl | How is the vector store dimension resolved at sta... | src/core/bootstrap.ts | miss (sym miss) | miss (sym miss) | miss (sym miss) | miss (sym miss) |
| gotcha-01 | gotcha | LanceDB IVF index metric cosine incompatible fall... | src/vectorstore/lancedb.ts | miss (sym miss) | miss (sym miss) | miss (sym miss) | miss (sym miss) |
| gotcha-02 | gotcha | LanceDB partition is empty skipping warning disca... | src/vectorstore/lancedb.ts | miss (sym miss) | miss (sym miss) | miss (sym miss) | miss (sym miss) |
| gotcha-03 | gotcha | embedding dimension mismatch silently zero pads v... | src/vectorstore/lancedb.ts | miss (sym miss) | miss (sym miss) | miss (sym miss) | miss (sym miss) |
| gotcha-04 | gotcha | watcher lock stale reclaim pid liveness | src/watcher.ts | miss | miss | miss | miss |
| gotcha-05 | gotcha | quirk auto capture dedup threshold | src/quirks/auto-capture.ts | miss (sym miss) | miss (sym miss) | miss (sym miss) | miss (sym miss) |
| gotcha-06 | gotcha | excludeDirs matches basename at any depth | src/core/exclude.ts | miss | miss | miss | miss |
| gotcha-07 | gotcha | tree-sitter WASM parser Language Node API | src/chunker/grammar.ts | miss | miss | miss | miss |
| gotcha-08 | gotcha | Ollama embedding response embedding vs embeddings | src/embedder/ollama.ts | miss | miss | miss | miss |
| gotcha-09 | gotcha | embedding preflight aborts when provider dimensio... | src/indexer/pipeline.ts | miss | miss | miss | miss |
| gotcha-10 | gotcha | describe image on demand model override | src/chunker/image.ts | miss (sym miss) | miss (sym miss) | miss (sym miss) | miss (sym miss) |
| gotcha-11 | gotcha | quirks jsonl reconcile store keyword index | src/quirks/quirk-store.ts | miss (sym miss) | miss (sym miss) | miss (sym miss) | miss (sym miss) |
| gotcha-12 | gotcha | noUncheckedIndexedAccess array indexing possibly ... | tsconfig.json | miss | miss | miss | miss |
| symbol-01 | symbol | resolveRagContext | src/core/bootstrap.ts | miss | miss | miss | miss |
| symbol-02 | symbol | ensureCosineIndex | src/vectorstore/lancedb.ts | miss | miss | miss | miss |
| symbol-03 | symbol | detectQueryShape | src/retriever/retriever.ts | miss | miss | miss | miss |
| symbol-04 | symbol | createBackgroundIndexer | src/watcher.ts | miss | miss | miss | miss |
| symbol-05 | symbol | walkFiles | src/content/reader.ts | miss | miss | miss | miss |
| symbol-06 | symbol | createEmbedder | src/embedder/factory.ts | miss | miss | miss | miss |
| symbol-07 | symbol | LanceDbStore | src/vectorstore/lancedb.ts | miss | miss | miss | miss |
| symbol-08 | symbol | KeywordIndex | src/retriever/keyword-index.ts | miss | miss | miss | miss |
| symbol-09 | symbol | analyzeTokenUsage | src/eval/token-analysis.ts | miss | miss | miss | miss |
| symbol-10 | symbol | buildAgentsMdDirective | src/opencode/system-guidance.ts | miss | miss | miss | miss |
| symbol-11 | symbol | reconcileQuirks | src/quirks/quirk-store.ts | miss | miss | miss | miss |
| symbol-12 | symbol | resolveOnDemandImageConfig | src/chunker/image.ts | miss | miss | miss | miss |
| de-01 | de | Wie funktioniert die Hybrid-Suche aus Vektor- und... | src/retriever/retriever.ts | miss | miss | miss | miss |
| de-02 | de | Wo wird die Ausschlussliste für Verzeichnisse ang... | src/core/exclude.ts | miss | miss | miss | miss |
| de-03 | de | Wie wird der Index inkrementell aktualisiert? | src/indexer/pipeline.ts | miss | miss | miss | miss |
| de-04 | de | Wie funktioniert die Quirk-Erinnerung? | src/quirks/quirk-store.ts | miss | miss | miss | miss |

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
