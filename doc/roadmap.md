# Roadmap

Current release: **v2.7.0** · last reviewed: **2026-10-20**

This file is the canonical roadmap. [PLANNING.md](../PLANNING.md) is the terse
checkbox mirror of the same three lists.

**Maintenance rule:** an item moves to *Shipped* when it lands in a release —
not when it is designed. The wiki log (`.opencode/wiki/log.md`) records the
reasoning behind the moves.

## ✅ Completed / Shipped

### Chunking & Indexing

- AST-based code chunking for 17 languages
- Per-language node-type overrides (`chunking.nodeTypes`) and per-extension parser
  overrides (`chunking.parsers`) — applied on **every** surface: chunking,
  skeleton, read and indexing (v2.5.0, issue #29)
- Regex/document chunking for Markdown, Razor, `.sln`, LaTeX
- Document text extraction for PDF, DOCX, DOC, Excel
  — DOCX without `mammoth`: `fflate.unzipSync` + `word/document.xml` parsing
  (v2.5.1)
- Image indexing via vision LLM, plus on-demand description overrides
  (`imageDescription.onDemand`)
- Line-based fallback chunking; pluggable chunkers via config
- Incremental indexing (file-hash manifest) with background watching and a
  single-watcher lock per workspace
- Index reporting with exit codes; watcher-staleness reporting
- Orphan sweep after partial passes; salvage of partially embedded files
- Embedding preflight — a dead provider aborts the pass instead of producing a
  6-minute "successful" index with zero chunks
- Dimension-integrity checks: mismatched embeddings are rejected and the store is
  rebuilt atomically instead of silently truncating rows

### Embedding & Storage

- Embedding providers: Ollama, OpenAI, Cohere
- Proxy-aware embedding transport with raw-socket localhost bypass
- Dimension probing at startup, persisted to config
- LanceDB vector storage with a cosine IVF index that self-heals a stale metric,
  plus a `memory://` test mode
- Batch embedding with progress reporting; failed batches split recursively;
  circuit breaker; gateway 5xx fails fast instead of grinding
- Persistent image description cache (reused across sessions)

### Retrieval & Ranking

- Vector search pipeline
- Hybrid search (TF×IDF/BM25 keyword + vector fusion) with symbol-keyword
  weighting and doc/test demotion
- Keyword-index rehydration from the store's own rows — repairs an index that
  silently covered only part of the corpus (v2.7.0)
- Opt-in cross-encoder rerank stage (`reranking.*`, llama-server) — v2.3.0
- Context optimization: adjacent merge, Jaccard dedup, per-file cap
- Session-level retrieval cache
- Metadata filters (path, role, kind, tags) and file-extension filters
- `eval:tune` calibrator: sweeps `keywordWeight` / `symbolKeywordWeight` /
  `minScore` / `topK` against a labelled golden set and reports a paired
  bootstrap CI, an exact sign test and the BM25-only vs vector-only split —
  not a bare argmax (v2.7.0)
- Scale-free `minScore` gate: `retrieval.minScoreMode` ("fused" default |
  "normalized") — the fused score's maximum depends on `keywordWeight`, so a
  fixed threshold silently changed meaning with the weight (at kw=0.4 it
  demanded a dual hit). The default stays "fused" because 48 labels cannot
  settle the quality delta (sign test p=1.00); the case is the contract (v2.9.0)
- Evaluation suite: `eval:sessions`, `eval:analyze`, `eval:compare`,
  `eval:gate`, `eval:decide`, plus RAG-on/RAG-off token analysis

### OpenCode Plugin

- Tools: `search_semantic`, `get_file_skeleton`, `find_usages`,
  `describe_image`, `make_decision`, `recall_quirks`, `add_quirk`,
  `update_quirk`, `delete_quirk`, plus a RAG-backed `read` override
- OpenCode 2 plugin-**directory** layout with a separate TUI plugin (issue #35);
  OpenCode 1.x support dropped in v2.0.0
- `chat.message` hook: file suggestions, hotkey context injection
  (Ctrl+Enter / Ctrl+Alt+Enter), `/doc` and `/wiki` slash commands
- System guidance gated on the session's actual tool catalog; RAG tools granted
  to the built-in `explore` agent
- Config hot-reload: the config file is re-read and the embedder rebuilt when it
  changes (v2.5.2)
- No console flashes on Windows — every child-process spawn passes
  `windowsHide: true`
- Background auto-indexing with watcher status; update / restart notices

### CLI & Distribution

- Commands: `setup`, `index`, `query`, `clear`, `status`, `list`, `show`,
  `dump`, `describe-image`, `decide`, `quirk` (`add`/`update`/`list`/`rm`/
  `lint`/`test`), `eval:sessions`, `eval:analyze`, `eval:compare`, `eval:gate`,
  `eval:decide`, `eval:tune`, `mcp`, `setup`, `ui`, `update`, `backend-detect`
- MCP server (`opencode-rag mcp`) exposing `search_semantic`,
  `get_file_skeleton`, `find_usages`, `describe_image`, `make_decision`
- Web dashboard UI (`opencode-rag ui`): file tree, token analysis, savings
  projection
- `setup` lifecycle with plugin generation, gitignore handling and npm install
- `AGENTS.md` creation/merge via sentinel markers
- Install scripts (`.sh` / `.ps1`) with pnpm/yarn/bun support; `setup`
  auto-inits a workspace and bootstraps the latest npm release; `update`
  self-update

### Memory, Quirks & Decision Model

- Quirk store (JSONL + vector rows) with `recall` / `add` / `update` /
  `delete`, semantic dedup on auto-capture, and store/JSONL reconciliation
- Auto-capture modes: passive per-turn extraction, session-end extraction,
  optional prompt enforcement
- Tool-error auto-create: a failed tool call with no matching memory gets one
  written, bounded by a single recall, a per-session budget, a per-signature
  cooldown and a tag that keeps it out of unrelated turns (v2.6.0)
- `make_decision` — local tev1 decision model via Ollama `/v1/systemone`
  (choice / noul / score), enabled per workspace (v2.4.0)

### Configuration, Quality & Ops

- JSON config with per-section deep merge; runtime overrides for live TUI edits
- Manifest schema versioning with corruption detection
- Path-traversal protection in file resolution
- The CLI never exits the host process (Commander `exitOverride`), and
  live-provider tests probe the real endpoint instead of `/api/tags`
- 1345 unit tests plus an integration suite; `npm run typecheck`; CI publishes
  on the GitHub release event

### Documentation & Wiki

- `doc/` set: architecture, chunking, configuration, plugin, cli, retrieval,
  embedding, evaluation, troubleshooting, webui, development, roadmap
- AI-maintained wiki mode at `.opencode/wiki/` (`/wiki`)

## 🎯 Short Term — Token & cost efficiency (current focus)

The plugin's own context is now the dominant token cost in an agent session.
Measured on the live store (2423 chunks; mean chunk 975 chars ≈ 244 tokens,
p90 3265 chars) — see
[`.opencode/wiki/concepts/token-budget-reduction.md`](../.opencode/wiki/concepts/token-budget-reduction.md)
for the full analysis.

| # | Lever | Where | Expected saving | Risk |
|---|-------|-------|-----------------|------|
| A | Cap the `search_semantic` output: a char/token budget, lowest-scoring chunks dropped first, and a **visible** notice saying what was truncated and how to get more | `formatContext` (`src/plugin.ts`) — currently uncapped, unlike `formatReadOutput` | ~2.4k → ~0.8k tokens per call, times the number of calls and re-sends | Low **if** the truncation is visible; silent truncation is what the decision model rated unsafe (p = 0.25) |
| B | Inject the mandatory guidance **once** — skip the runtime system-prompt block when the workspace `AGENTS.md` already carries the managed directive | system-transform hook (`src/plugin.ts`, `src/opencode/system-guidance.ts`) | ~835 tokens **per model request** | Low; needs a fallback to the runtime block when the marker is missing, and a `setup` re-sync |
| C | Tighten the read override: lower `openCode.maxReadOutputChars` (20000 → ~8000) and prefer the already-retrieved chunks over the whole file when the caller passes a query | `createRagReadTool` (`src/opencode/create-read-tool.ts`) | up to ~5k tokens per read | Medium — may cost an extra read call |
| D | Make the hotkey injection budget configurable and default to the cheap file-list mode | `formatAutoInjectContext` — the 3000-token budget is hardcoded | ~1.5-3k tokens per injected turn | Low |
| E | Keep quirk auto-injection opt-in; raise `memory.autoInjectMinScore` (0.75 → ~0.8) when it is on | `memory.*` | ~150-300 tokens per turn | Low |
| F | Indexing-only: lower `description.maxContentChars` (4000 → ~1200) and set `indexing.embedDescriptions: false` for code-specialized embedders | `description.*`, `indexing.*` | ~30% of the description-LLM bill (≈148k tokens per full re-index of this store) | Low — no effect on agent-side tokens |

Related, because it decides how much context is affordable: **make the fused
score scale-free.** The hybrid score maxes out at `1 - kw` for a vector-only
hit, so with `kw = 0.4` and `minScore = 0.65` a vector-only hit (max 0.60) can
never pass the gate — only chunks both signals found survive (10.3 of 20
results at `kw = 0.4` vs 17.5 at `kw = 0`). Normalize the gate, or apply
`minScore` per signal *before* fusion.

## Short Term — Other

| Feature | Description |
|---|---|
| Query rewriting | Multi-variant expansion for ambiguous queries |
| Persistent query cache | Disk-based cache so repeated queries across restarts are instant |
| Token & cost telemetry | Surface per-turn injected tokens and cost in the Web UI (the session logger already records `ragContextTokens`) |
| Chunk-quality heuristics | Score chunks for size, coherence and boundary quality, and prefer the good ones at query time |

## Mid Term

| Feature | Description |
|---|---|
| Cross-file relationship graph | Import/call graph for dependency-aware search |
| Multi-repo search | Index and search across multiple workspaces |
| IDE context awareness | Use current file, cursor position for relevance boosting |
| Context composition policy | Decide per workspace what is injected verbatim, what is summarized and what is left to a tool call |
| Persistent session memory | Retain coding patterns and decisions across sessions (quirk memory + wiki mode are the first steps) |
| Auto-generated codebase summaries | LLM directory-level summaries from indexed chunks |
| Reranker improvements | Model-agnostic rerank targets, per-signal reranking instead of post-fusion |

## Long Term

| Feature | Description |
|---|---|
| Code execution-aware retrieval | Run code to understand its behavior for better retrieval |
| Semantic refactoring assistant | Code transformations based on natural language |
| Agent-based code navigation | Autonomous exploration of codebase structure |
| Multimodal support | Diagrams, API specs, JSON schemas, YAML configs |
| Access control | Per-folder permissions, sensitive file exclusion |
| Index export/import | Serialize index for CI/CD, team sharing, backup/restore |
| Performance benchmark suite | Measure index time, query latency, memory usage |
| Memory & storage optimization | Quantized embeddings, pruning, garbage collection |

## Key Next Steps

1. **Cap the `search_semantic` output** (A) — the biggest measured win, and it
   needs no retrieval change: the candidate pool stays as it is, only the
   rendering shrinks
2. **De-duplicate the mandatory guidance** (B) — ~835 tokens saved on *every*
   model request in any workspace that ran `opencode-rag setup`
3. **Make the fused score scale-free** so `minScore` means something
4. **Query rewriting** for ambiguous query expansion
5. **Persistent session memory** across coding sessions
