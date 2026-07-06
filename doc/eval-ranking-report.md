# Ranking Order Comparison

**main (734fc60)** vs **t1-cosine-l2 (e922a0b)**
**Generated:** 2026-07-06T08:52:29.409Z

## Config

| Setting | `main` | `t1-cosine-l2` |
|---|---|---|
| Embedding | qwen3-embedding:0.6b | qwen3-embedding:0.6b |
| topK | 20 | 20 |
| minScore | 0.5 | 0.5 |
| Hybrid | true | true |
| keywordWeight | 0.4 | 0.4 |
| Index chunks | 542 | 542 |

## Ranking Agreement

| Metric | Value |
|---|---|
| Top-1 match | 25/25 |
| Top-3 identical | 25/25 |
| Top-5 identical | 25/25 |
| Full top-K identical | 25/25 |
| Avg overlap in top-5 | 5.0 |
| Avg overlap in top-K | 5.0 |
| Kendall's τ (avg) | 1.0000 |
| Queries with keyword contribution | 0/25 |

## Verdict

**Ranking is 100% identical across all queries.**

The `t1-cosine-l2` branch changes two things simultaneously:
- Vector scoring: L2 distance → cosine similarity
- Hybrid fusion: Weighted linear combination → RRF (K=60)

However, in this benchmark, **keyword scores are zero on every query**
because the keyword index doesn't match any query terms. When only one signal
(vector similarity) contributes, both fusion methods produce the same
rank order. This is because both are **monotonically decreasing functions**
of the vector rank:

- **Linear**: `score = (1-kw) · normVectorScore` (monotonic in vector score)
- **RRF**: `score = (1-kw) / (K + rank + 1)` (monotonic in vector rank)

Since vector rank is itself monotonic with vector score, the final ordering
is identical regardless of which formula is used.

### When would RRF make a difference?

RRF excels when **both vector AND keyword signals contribute** to a query.
It can boost results that rank highly in both sources while demoting results
that only rank well in one. To see this effect:
- Index more files (including docs with token-rich content)
- Use queries with specific identifier/keyword terms that match the keyword index
- Increase keywordWeight to amplify keyword contributions

## Per-Query Detail

| # | Query | Top-1 same | Top-5 same | Full same | τ | main score | branch score |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| NaN | How does the retrieval pipeline work end-to-end? | ✓ | ✓ | ✓ | 1.000 | 0.577 | 0.010 |
| NaN | How does the plugin interact with chat messages? | ✓ | ✓ | ✓ | 1.000 | 0.537 | 0.010 |
| NaN | How does the keyword index combine with vecto... | ✓ | ✓ | ✓ | 1.000 | 0.559 | 0.010 |
| NaN | Where is the embedder factory defined? | ✓ | ✓ | ✓ | 1.000 | 0.582 | 0.010 |
| NaN | Where is the LanceDB store implementation? | ✓ | ✓ | ✓ | 1.000 | 0.573 | 0.010 |
| NaN | Find all usages of the retrieve function | ✓ | ✓ | ✓ | 1.000 | 0.555 | 0.010 |
| NaN | Find all usages of SearchResult type | ✓ | ✓ | ✓ | 1.000 | 0.576 | 0.010 |
| NaN | How does the chunker factory register new lan... | ✓ | ✓ | ✓ | 1.000 | 0.607 | 0.010 |
| NaN | What is the default minScore configuration? | ✓ | ✓ | ✓ | 1.000 | 0.489 | 0.010 |
| NaN | How does the session logger capture token usage? | ✓ | ✓ | ✓ | 1.000 | 0.650 | 0.010 |
| NaN | How does L2 normalization affect vector searc... | ✓ | ✓ | ✓ | 1.000 | 0.534 | 0.010 |
| NaN | What is the MetadataFilter interface used for? | ✓ | ✓ | ✓ | 1.000 | 0.502 | 0.010 |
| NaN | How does the background indexer handle file c... | ✓ | ✓ | ✓ | 1.000 | 0.601 | 0.010 |
| NaN | Where is the config validation logic? | ✓ | ✓ | ✓ | 1.000 | 0.511 | 0.010 |
| NaN | How are PDF documents chunked and indexed? | ✓ | ✓ | ✓ | 1.000 | 0.599 | 0.010 |
| NaN | What embedding providers are supported? | ✓ | ✓ | ✓ | 1.000 | 0.661 | 0.010 |
| NaN | How does the CLI parse and dispatch commands? | ✓ | ✓ | ✓ | 1.000 | 0.552 | 0.010 |
| NaN | How does the session logger persist events? | ✓ | ✓ | ✓ | 1.000 | 0.663 | 0.010 |
| NaN | What is the manifest schema version used for? | ✓ | ✓ | ✓ | 1.000 | 0.490 | 0.010 |
| NaN | How does the OpenCode plugin register tools? | ✓ | ✓ | ✓ | 1.000 | 0.622 | 0.010 |
| NaN | Where is the globMatch function defined? | ✓ | ✓ | ✓ | 1.000 | 0.491 | 0.010 |
| NaN | How does the proxy-aware HTTP client work? | ✓ | ✓ | ✓ | 1.000 | 0.547 | 0.010 |
| NaN | What is the FETCH_OVERFETCH_FACTOR constant? | ✓ | ✓ | ✓ | 1.000 | 0.497 | 0.010 |
| NaN | How does the TUI settings menu work? | ✓ | ✓ | ✓ | 1.000 | 0.570 | 0.010 |
| NaN | How are image descriptions generated? | ✓ | ✓ | ✓ | 1.000 | 0.628 | 0.010 |
