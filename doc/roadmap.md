# Roadmap

See [PLANNING.md](../PLANNING.md) for the full detailed roadmap and brainstorming document.

## ✅ Completed / Shipped

### Chunking & Indexing

- AST-based code chunking for 17 languages
- Regex/document chunking for Markdown, Razor, .sln, LaTeX
- Document text extraction for PDF, DOCX, DOC, Excel
- Image indexing via vision LLM (descriptions stored as searchable vector chunks)
- Line-based fallback chunking
- Pluggable chunkers via config
- Per-language chunking config (`chunking.nodeTypes`)
- Incremental indexing (file-hash-based, manifest-backed)
- File watching and background re-indexing
- Enhanced chunk descriptions with relative paths and line numbers

### Embedding & Storage

- Embedding providers: Ollama, OpenAI, Cohere
- Proxy-aware embedding transport with raw socket localhost bypass
- Dimension probing at startup (persisted to config to reduce startup time)
- LanceDB vector storage with `memory://` test mode
- Batch embedding with progress reporting
- Auto-detection of LanceDB schema for seamless upgrades
- Persistent image description cache (reused across sessions)

### Retrieval

- Vector search pipeline
- Hybrid search (TF×IDF keyword + vector fusion)
- Session-level retrieval cache
- Auto-context injection on `chat.message`
- Configurable auto-inject settings
- Context window optimization (per-file chunk limits, adjacent merge, Jaccard dedup)

### OpenCode Plugin

- `search_semantic` tool
- `chat.message` hook with file suggestions and auto-injection
- RAG-backed read override tool
- TUI settings panel with model picker dropdowns
- OpenCode v1.17.0 compatible PluginModule export
- Background auto-indexing with watcher status
- API key auto-resolution from OpenCode provider config
- Documentation mode (`/doc` slash command, per-subdirectory progress tracking)
- Wiki mode (`/wiki` slash command, AI-maintained knowledge wiki at `.opencode/wiki/`)
- Hotkey-activated context injection (Ctrl+Enter / Ctrl+Alt+Enter)

### CLI & Distribution

- Full CLI: `init`, `index`, `query`, `clear`, `status`, `list`, `show`, `dump`, `describe-image`, `ui`, `mcp`, `setup`
- Evaluation CLI: `eval:sessions`, `eval:analyze`, `eval:compare`
- `init` command lifecycle with plugin generation, gitignore, npm install
- `AGENTS.md` creation/merge via sentinel markers
- MCP server (`opencode-rag mcp`) exposing semantic search tools over stdio
- Web dashboard UI (`opencode-rag ui`)
- Install scripts (`.sh` / `.ps1`) with uninstall support
- Release automation script
- Published npm package: `opencode-rag-plugin`

### Configuration & Quality

- JSON config with deep-merged partial overrides
- Runtime overrides system for live TUI changes
- Configurable file logging
- Manifest schema versioning with corruption detection
- Persisted embedding vector dimension (probed once, cached in config)
- Path traversal protection in file resolution
- 589+ automated tests

## Short Term

| Feature | Description |
|---|---|
| LLM-based re-ranking | Cross-encoder or lightweight model after vector search |
| Query rewriting | Multi-variant expansion for ambiguous queries |
| Persistent query cache | Disk-based cache so repeated queries across restarts are instant |
| Concurrent chunking | Parallel file scanning/chunking for large repos |

## Mid Term

| Feature | Description |
|---|---|
| Cross-file relationship graph | Import/call graph for dependency-aware search |
| Multi-repo search | Index and search across multiple workspaces |
| IDE context awareness | Use current file, cursor position for relevance boosting |
| Prompt customization | Customize how retrieved context is formatted |
| Persistent session memory | Retain coding patterns and decisions across sessions |
| Auto-generated codebase summaries | LLM directory-level summaries from indexed chunks |
| Chunk quality heuristics | Score chunks for size, coherence, boundary quality |

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

1. **LLM-based re-ranking** for retrieval precision
2. **Code graph integration** for structural code understanding
3. **Query rewriting** for ambiguous query expansion
4. **Persistent session memory** across coding sessions
5. **Concurrent chunking** for faster indexing of large repos
