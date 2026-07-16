# 🛣️ Roadmap
## Short Term
- [ ] LLM-based re-ranking layer (cross-encoder or lightweight model after vector search)
- [ ] Query rewriting / multi-variant expansion
- [ ] Persistent query cache (disk-based, survives restarts)
- [ ] Per-language chunking config — per-extension overrides for `nodeTypes`, `chunkSize`, `overlap` (e.g. Python gets smaller AST nodes than Java)
- [ ] Concurrent chunking — parallel file scanning/chunking for large repos (bottleneck is sequential chunking in `runIndexPass`)

## Mid Term

- [ ] Cross-file relationship graph (imports, call graph)
- [ ] Dependency-aware search
- [ ] Multi-repo / cross-workspace search
- [ ] IDE context awareness (current file, cursor position)
- [ ] Prompt template customization
- [ ] Memory / persistent context across sessions
- [ ] Auto-generated codebase summaries — LLM produces directory-level summaries from indexed chunks for onboarding and context injection
- [ ] Chunk quality heuristics — score chunks during indexing for size, coherence, boundary quality; flag poorly-chunked files

## Long Term

- [ ] Code execution-aware retrieval
- [ ] Semantic refactoring assistant
- [ ] Agent-based code navigation
- [ ] Richer non-code / multimodal support (diagrams, API specs, JSON schemas, YAML configs)
- [ ] Access control (per-folder permissions, sensitive file exclusion)
- [ ] Index export/import — serialize the index for CI/CD, team sharing, or backup/restore
- [ ] Performance benchmark suite — measure index time, query latency, memory usage across repo sizes
- [ ] Memory & storage optimization — quantized embeddings to reduce storage, pruning stale entries, garbage collection on unused chunks
