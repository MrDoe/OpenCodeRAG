# 🛣️ Roadmap

## Completed
- [x] Concurrent chunking — parallel file scanning/chunking via `p-limit` with configurable concurrency (`indexing.concurrency`)
- [x] Per-language AST node type overrides (`chunking.nodeTypes` in config)

## Short Term
- [ ] LLM-based re-ranking layer (cross-encoder or lightweight model after vector search)
- [ ] Query rewriting / multi-variant expansion
- [ ] Persistent query cache (disk-based, survives restarts)

## Mid Term

- [ ] Multi-repo / cross-workspace search
- [ ] Memory / persistent context across sessions (quirk memory + wiki mode exist as first steps)
- [ ] Auto-generated codebase summaries — LLM produces directory-level summaries from indexed chunks for onboarding and context injection

## Long Term

- [ ] Richer non-code / multimodal support (diagrams, API specs, JSON schemas, YAML configs)
- [ ] Index export/import — serialize the index for CI/CD, team sharing, or backup/restore
- [ ] Performance benchmark suite — measure index time, query latency, memory usage across repo sizes
- [ ] Memory & storage optimization — quantized embeddings to reduce storage, pruning stale entries, garbage collection on unused chunks
