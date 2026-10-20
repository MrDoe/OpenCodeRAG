# 🛣️ Roadmap (checklist)

Terse mirror of [doc/roadmap.md](doc/roadmap.md) — that file is canonical and
carries the rationale for every item. Keep the two in sync: an item moves to
*Completed* when it lands in a release.

Last reviewed: 2026-10-20 · current release: **v2.7.0**

## Completed

- [x] AST chunking for 17 languages + `chunking.nodeTypes` / `chunking.parsers` overrides on every surface
- [x] Document extraction (PDF, DOCX without mammoth, DOC, Excel) and image indexing
- [x] Incremental indexing, background watcher (single per workspace), index reporting + exit codes
- [x] Embedding preflight, dimension-integrity checks, orphan sweep, atomic rebuild
- [x] Hybrid search + keyword-index rehydration (v2.7.0)
- [x] Opt-in cross-encoder rerank stage (v2.3.0)
- [x] Context optimization (adjacent merge, Jaccard dedup, per-file cap) and session retrieval cache
- [x] `eval:tune` calibrator with bootstrap CI + sign test + per-signal split (v2.7.0)
- [x] OpenCode 2 plugin-directory layout with a separate TUI plugin (issue #35)
- [x] Quirk memory with auto-capture and bounded tool-error auto-create (v2.6.0)
- [x] `make_decision` decision model via tev1 (v2.4.0)
- [x] MCP server, Web dashboard UI, install scripts, self-update

## Short Term — token & cost efficiency

- [ ] **A.** Cap the `search_semantic` output (`formatContext` is uncapped) — budget + visible truncation notice
- [ ] **B.** Inject the mandatory guidance once — skip the runtime block when `AGENTS.md` carries the directive
- [ ] **C.** Tighten the read override — lower `openCode.maxReadOutputChars`, prefer chunks over the whole file
- [ ] **D.** Make the hotkey injection budget configurable; default to the file-list mode
- [ ] **E.** Raise `memory.autoInjectMinScore`; keep quirk auto-inject opt-in
- [ ] **F.** Indexing-only — lower `description.maxContentChars`, `indexing.embedDescriptions: false` for code embedders
- [ ] Make the fused hybrid score scale-free so `minScore` is not kw-dependent
- [ ] Query rewriting / multi-variant expansion
- [ ] Persistent query cache (disk-based, survives restarts)
- [ ] Token & cost telemetry in the Web UI (per-turn injected tokens + cost)
- [ ] Chunk-quality heuristics (size, coherence, boundary quality)

## Mid Term

- [ ] Multi-repo / cross-workspace search
- [ ] Cross-file relationship graph (import/call graph)
- [ ] Context composition policy (inject vs summarize vs tool-call)
- [ ] IDE context awareness (current file, cursor position)
- [ ] Persistent session memory (quirk memory + wiki mode exist as first steps)
- [ ] Auto-generated codebase summaries — LLM directory-level summaries from indexed chunks
- [ ] Reranker improvements (per-signal reranking, model-agnostic targets)

## Long Term

- [ ] Richer non-code / multimodal support (diagrams, API specs, JSON schemas, YAML configs)
- [ ] Index export/import — serialize the index for CI/CD, team sharing, or backup/restore
- [ ] Performance benchmark suite — index time, query latency, memory usage across repo sizes
- [ ] Memory & storage optimization — quantized embeddings, pruning stale entries, garbage collection
- [ ] Code execution-aware retrieval and agent-based code navigation
