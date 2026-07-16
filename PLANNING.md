# 🛣️ Roadmap

## Completed ✓

- [x] AST-aware chunking for JavaScript/TypeScript (+ 25 languages via tree-sitter: Python, Java, Go, C#, Kotlin, Swift, Rust, Ruby, PHP, SQL, YAML, TOML, XML, HTML, CSS, JSON, Markdown, Bash, Dockerfile, PowerShell, INI, TeX, Razor, SLN, StarLIMS SSL)
- [x] Document chunking for PDF, DOCX, DOC, Excel
- [x] Hybrid keyword + vector search with configurable fusion weights
- [x] LanceDB vector storage with incremental indexing
- [x] Background indexing with file watching (chokidar-based live re-indexing)
- [x] Configurable embeddings with proxy support (custom HTTP client with connection pooling, raw TCP/TLS sockets, NO_PROXY matching)
- [x] API key auto-resolution from OpenCode provider config
- [x] Manifest schema versioning with auto-rebuild
- [x] Runtime overrides system (no JSON editing required)
- [x] OpenCode plugin integration with `search_semantic`, `get_file_skeleton`, `find_usages`, `describe_image` tools
- [x] TUI settings menu with model picker for embedding and description providers
- [x] RAG-backed read tool with related code enrichment
- [x] Install/uninstall scripts for global setup
- [x] Workspace-native bootstrap (`opencode-rag init`)
- [x] Web UI with chunk browser, file explorer, and evaluation dashboard
- [x] MCP server (`opencode-rag mcp`) — expose `search_semantic`, `get_file_skeleton`, `find_usages`, `describe_image` via stdio MCP for any MCP-compatible client
- [x] Programmatic TypeScript API (`search()`, `indexWorkspace()`, `getContext()`, `validateConfig()`, `scanWorkspace()`, `createBackgroundIndexer()`, `getIndexStatusSummary()`)
- [x] Retrieval debug surfaces (explain why files/chunks were returned) — `SearchExplanation` type, `getMatchedTerms()`, `--explain` CLI flag, `explain` param on API calls
- [x] Image description via vision LLMs — `describe_image` tool in OpenCode plugin, MCP server, and CLI; 4 vision providers (Ollama, OpenAI, Anthropic, Gemini); image resizing via sharp; image chunking with searchable vector chunks
- [x] Evaluation framework — session event capture, token usage analysis, RAG impact measurement, cross-session comparison (`eval:sessions`, `eval:analyze`, `eval:compare` commands)
- [x] Multi-provider description generation — Anthropic Claude, Google Gemini, and OpenAI-compatible providers with batch description support
- [x] Self-updater via npm — check/install updates via `npm update -g opencode-rag-plugin`
- [x] Provider health checking — validates all configured providers (embedding, description, image_description) at startup
- [x] Enhanced CLI — 16 commands: `index`, `query`, `show`, `dump`, `status`, `init`, `clear`, `list`, `eval`, `describe-image`, `mcp`, `ui`, `update`, plus progress tracking
- [x] Pluggable chunker loading — dynamic import of custom chunker modules from config
- [x] In-memory vector store — ephemeral alternative to LanceDB for testing/embedding
- [x] Lock-file concurrency protection for index passes
- [x] Data-loss detection in indexing pipeline
- [x] Batch description generation with failure tracking and retry
- [x] Live terminal progress table with pipeline breadcrumbs (Chunking → Description → Embedding → Finished)
- [x] Documentation mode progress tracking (`doc-mode-progress.json`)
- [x] SSL/STARLIMS chunker for procedural script files
- [x] Cohere embedding provider with health check
- [x] Config validation at startup — validate `opencode-rag.json` schema with clear error messages
- [x] Better ranking/diversity for `chat.message` file suggestions
- [x] Git-aware incremental indexing — `git diff --name-only` since last indexed commit, skips unchanged tracked files (`src/indexer/git-diff.ts`, `manifest.lastGitCommit`)
- [x] Context window optimization — adjacent chunk merging, Jaccard similarity dedup, per-file diversity cap (`src/retriever/context-optimizer.ts`)

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
