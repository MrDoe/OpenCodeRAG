# Ranking Order Comparison

**main (734fc60)** vs **t1-cosine-l2 (95fd596)**
**Generated:** 2026-07-06T11:12:41.259Z

## Config

| Setting | `main` | `t1-cosine-l2` |
|---|---|---|
| Embedding | qwen3-embedding:0.6b | qwen3-embedding:0.6b |
| topK | 20 | 20 |
| minScore | 0.5 | 0.35 |
| Hybrid | true | true |
| keywordWeight | 0.4 | 0.4 |
| Index chunks | 542 | 542 |

## Ranking Agreement

| Metric | Value |
|---|---|
| Top-1 match | 13/35 |
| Top-3 identical | 1/35 |
| Top-5 identical | 0/35 |
| Full top-K identical | 0/35 |
| Avg overlap in top-5 | 2.9 |
| Avg overlap in top-K | 2.9 |
| Kendall's τ (avg) | 0.3619 |
| Queries with keyword contribution | 35/35 |

## Per-Query Detail

| # | Query | Top-1 same | Top-5 same | Full same | τ | main score | branch score |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| 1 | How does the retrieval pipeline work end-to-end? | ✗ | ✗ | ✗ | -0.333 | 0.896 | 0.922 |
| 2 | How does the plugin interact with chat messages? | ✓ | ✗ | ✗ | 0.333 | 0.988 | 0.981 |
| 3 | How does the keyword index combine with vecto... | ✗ | ✗ | ✗ | -1.000 | 0.897 | 0.949 |
| 4 | Where is the embedder factory defined? | ✗ | ✗ | ✗ | 0.333 | 0.900 | 0.877 |
| 5 | Where is the LanceDB store implementation? | ✗ | ✗ | ✗ | 1.000 | 0.900 | 0.968 |
| 6 | Find all usages of the retrieve function | ✓ | ✗ | ✗ | 1.000 | 1.000 | 1.000 |
| 7 | Find all usages of SearchResult type | ✓ | ✗ | ✗ | 1.000 | 0.992 | 0.990 |
| 8 | How does the chunker factory register new lan... | ✗ | ✗ | ✗ | 1.000 | 0.900 | 0.981 |
| 9 | What is the default minScore configuration? | ✗ | ✗ | ✗ | -1.000 | 0.914 | 0.876 |
| 10 | How does the session logger capture token usage? | ✗ | ✗ | ✗ | -0.333 | 0.919 | 0.951 |
| 11 | How does L2 normalization affect vector searc... | ✗ | ✗ | ✗ | 0.333 | 0.900 | 0.925 |
| 12 | What is the MetadataFilter interface used for? | ✗ | ✗ | ✗ | 1.000 | 0.921 | 0.846 |
| 13 | How does the background indexer handle file c... | ✓ | ✗ | ✗ | 1.000 | 0.995 | 0.987 |
| 14 | Where is the config validation logic? | ✗ | ✗ | ✗ | -1.000 | 0.900 | 0.789 |
| 15 | How are PDF documents chunked and indexed? | ✗ | ✗ | ✗ | -1.000 | 0.900 | 0.864 |
| 16 | What embedding providers are supported? | ✗ | ✗ | ✗ | 0.333 | 0.882 | 0.908 |
| 17 | How does the CLI parse and dispatch commands? | ✗ | ✗ | ✗ | 0.333 | 0.938 | 0.959 |
| 18 | How does the session logger persist events? | ✗ | ✗ | ✗ | 1.000 | 0.822 | 0.959 |
| 19 | What is the manifest schema version used for? | ✗ | ✗ | ✗ | -0.333 | 0.962 | 0.852 |
| 20 | How does the OpenCode plugin register tools? | ✗ | ✗ | ✗ | 0.333 | 0.932 | 0.957 |
| 21 | Where is the globMatch function defined? | ✓ | ✗ | ✗ | 0.000 | 0.963 | 0.915 |
| 22 | How does the proxy-aware HTTP client work? | ✗ | ✗ | ✗ | 1.000 | 0.900 | 0.944 |
| 23 | What is the FETCH_OVERFETCH_FACTOR constant? | ✓ | ✗ | ✗ | 1.000 | 0.955 | 0.816 |
| 24 | How does the TUI settings menu work? | ✓ | ✗ | ✗ | 1.000 | 0.954 | 0.984 |
| 25 | How are image descriptions generated? | ✗ | ✗ | ✗ | 1.000 | 0.900 | 0.931 |
| 26 | retrieve function | ✓ | ✗ | ✗ | 0.667 | 1.000 | 0.939 |
| 27 | KeywordIndex class | ✗ | ✗ | ✗ | 1.000 | 0.914 | 0.944 |
| 28 | embedder factory | ✗ | ✗ | ✗ | -0.333 | 0.900 | 0.949 |
| 29 | vector store LanceDB | ✓ | ✗ | ✗ | 1.000 | 1.000 | 0.994 |
| 30 | find usages SearchResult | ✓ | ✗ | ✗ | 0.667 | 1.000 | 1.000 |
| 31 | chunkFile method | ✓ | ✗ | ✗ | 0.333 | 0.950 | 0.901 |
| 32 | embedBatch function | ✓ | ✗ | ✗ | 1.000 | 1.000 | 1.000 |
| 33 | retriever retrieve vector search | ✗ | ✗ | ✗ | 1.000 | 0.872 | 0.959 |
| 34 | session logger token | ✓ | ✗ | ✗ | 0.333 | 0.990 | 0.975 |
| 35 | config validation | ✗ | ✗ | ✗ | -1.000 | 0.900 | 0.790 |
