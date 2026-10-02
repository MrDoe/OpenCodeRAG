# Rerank A/B Evaluation

**Date:** 2026-10-01T13:51:35.714Z
**Worktree:** C:\Daten\Entwicklung\OpenCodeRAG
**Indexed chunks:** 2223
**Embedder:** openai/Qwen/Qwen3-Embedding-8B-GGUF:F16 (dimension 4096)
**Retrieval:** topK=20, minScore=0.35, hybrid=true, keywordWeight=0.4
**Labels:** 4 from `src/eval/rerank-labels.json`
**Categories:** nl=4
**Warmup:** 2 discarded queries per arm (p50/p95 are warm measurements)

## Arm status

| Arm | Status | Note |
|-----|--------|------|
| `baseline` | ok | current pipeline (reranking disabled) |
| `rerank20` | ok | rerank stage, candidates=20 |

## Aggregate metrics (warm)

| Metric | `baseline` | `rerank20` |
|--------|---|---|
| Hit@1 | 0.0% | 0.0% |
| Hit@3 | 50.0% | 50.0% |
| Hit@5 | 75.0% | 75.0% |
| Hit@10 | 75.0% | 75.0% |
| Precision@5 | 0.150 | 0.150 |
| Recall@10 | 75.0% | 75.0% |
| MRR | 0.274 | 0.274 |
| nDCG@10 | 0.363 | 0.363 |
| Symbol hit rate | 100.0% | 100.0% |
| Latency avg | 96 ms | 488 ms |
| Latency p50 | 90 ms | 88 ms |
| Latency p95 | 90 ms | 149 ms |

## Effect vs. baseline

| Arm | Δ nDCG@10 | Δ MRR | Δ Hit@5 | Δ p50 latency | Top-5 overlap | Changed top-1 |
|-----|-----------|-------|---------|---------------|---------------|---------------|
| `rerank20` | +0.000 | +0.000 | +0.000 | -2 ms | 100.0% | 0/4 |

## Metrics by category

| Arm | Category | Hit@1 | Hit@5 | MRR | nDCG@10 |
|-----|----------|-------|-------|-----|---------|
| `baseline` | nl | 0.0% | 75.0% | 0.274 | 0.363 |
| `rerank20` | nl | 0.0% | 75.0% | 0.274 | 0.363 |

## Per-query results

| ID | Category | Query | Expected files | `baseline` | `rerank20` |
|----|----------|-------|----------------|---|---|
| nl-01 | nl | How does the retrieval pipeline work end-to-end? | src/retriever/retriever.ts | #16 (sym #16) | #16 (sym #16) |
| nl-02 | nl | How does the plugin interact with chat messages? | src/plugin.ts | #3 | #3 |
| nl-03 | nl | How does the keyword index combine with vector se... | src/retriever/retriever.ts, src/retriever/keyword-index.ts | #2 | #2 |
| nl-04 | nl | Where is the embedder factory defined? | src/embedder/factory.ts | #5 (sym #5) | #5 (sym #5) |

## Interpretation notes

- **Rank shown** is the position of the first expected file (1-based); `sym` marks the rank of a chunk
  that also contains the expected symbol.
- **Misses are not necessarily retrieval failures**: a label may map to multiple files and the metric
  counts every expected file; check the per-query table before drawing conclusions.
- **Rerank arms are reorder-only** (`reranking.minScore=0`): the candidate set is unchanged, only the order
  within the top-K differs. A reranker that only churns ranks without improving nDCG@10/MRR is not worth
  the latency cost — that is the decision this report informs.
- Latency was measured warm on a local llama-swap tunnel; p95 includes network jitter. Cold start is not
  included and must be measured separately before enabling the stage by default.
