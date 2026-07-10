# OpenCodeRAG Token Usage Report

**Date:** 2026-07-10
**Codebase:** C:\Daten\Entwicklung\OpenCodeRAG
**Indexed chunks:** 0
**Embedding model:** ollama/qwen3-embedding:0.6b
**Tokenizer:** tiktoken cl100k_base (BPE)
**Retrieval:** topK=20, minScore=0.5, hybrid=true

## Summary

| Metric | Value |
|--------|-------|
| Queries tested | 10 |
| Queries with injection | 0 / 10 |
| Avg top relevance score | 0.000 |
| Total RAG context injected | 0 tokens |
| Avg context per query | 0 tokens |
| System guidance overhead | 0 tokens |
| Estimated reads saved | 0 calls |
| Estimated read tokens saved | 0 tokens |
| **Net token savings** | **0 tokens** |
| **Net savings (with guidance)** | **0 tokens** |

## Verdict

**RAG COSTS tokens overall.** The 0 tokens of injected context exceed the estimated 0 tokens saved from fewer file reads. Net overhead: **0 tokens** (0.0%).

## Per-Query Results

| # | Query | Results | Top Score | Injected | Content Type |
|---|-------|---------|-----------|----------|--------------|
| 1 | How does the retrieval pipeline work end-t... | 0 | 0.000 | 0 tok | none |
| 2 | How does the plugin interact with chat mes... | 0 | 0.000 | 0 tok | none |
| 3 | How does the keyword index combine with ve... | 0 | 0.000 | 0 tok | none |
| 4 | Where is the embedder factory defined? | 0 | 0.000 | 0 tok | none |
| 5 | Where is the LanceDB store implementation? | 0 | 0.000 | 0 tok | none |
| 6 | Find all usages of the retrieve function | 0 | 0.000 | 0 tok | none |
| 7 | Find all usages of SearchResult type | 0 | 0.000 | 0 tok | none |
| 8 | How does the chunker factory register new ... | 0 | 0.000 | 0 tok | none |
| 9 | What is the default minScore configuration? | 0 | 0.000 | 0 tok | none |
| 10 | How does the session logger capture token ... | 0 | 0.000 | 0 tok | none |

## Token Breakdown

### Without RAG (estimated)

- Agent must read files to find relevant code: ~2-3 reads × ~1200 tokens = **~2400-3600 tokens per query**
- No injected context overhead
- No system guidance overhead

### With RAG

- Injected context: **0 tokens per query** (avg)
- System guidance: **~150 tokens per query**
- Agent reads fewer files: **~0-1 reads per query**

## Notes

- Read token savings are **estimated** based on typical agent behavior (2-3 extra reads per query without RAG)
- Actual savings depend on query complexity, codebase size, and agent model
- RAG provides **qualitative benefits** beyond token savings: more targeted code context, fewer hallucinations, better grounding
- The `minScore` threshold (0.85) is conservative — lowering it injects more context but catches more relevant code
