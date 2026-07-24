---
name: opencode-rag
description: Local-first RAG plugin for semantic code search — tree-sitter chunking, LanceDB, hybrid retrieval
---

## Code Navigation

ALWAYS use OpenCodeRAG tools before reading or editing:
- **Search first** — `search_semantic(query)` instead of grep/glob
- **Skeleton before read** — `get_file_skeleton(filePath)` then read specific lines
- **Usages before edit** — `find_usages(symbolName)` before modifying any symbol
- **Images via describe** — `describe_image(filePath)` — never read raw bytes

If no results, run `opencode-rag index`.

## Architecture

Entry points: `src/index.ts` (library), `src/plugin-entry.ts` (OpenCode plugin), `src/cli.ts` (CLI), `src/tui.ts` (TUI), `src/web/server.ts` (Web UI).

Core modules: `src/core/` (config, interfaces, manifest), `src/chunker/` (AST chunking), `src/embedder/` (Ollama/OpenAI/Cohere), `src/describer/` (LLM descriptions), `src/retriever/` (vector + keyword hybrid), `src/vectorstore/` (LanceDB), `src/opencode/` (plugin integration).

Full architecture: [doc/architecture.md](doc/architecture.md).

## Known Gotchas

- **npm install**: use `--legacy-peer-deps` (LanceDB peer dep conflicts)
- **LanceDB types**: cast through `unknown` — `rows as unknown as Record<string, unknown>[]`
- **tree-sitter**: WASM-only (no native). `Parser` is a class, `Language` is top-level, use `Node` not `SyntaxNode`
- **Plugin types**: `@opencode-ai/plugin` lives in `.opencode/node_modules/`, declared locally in `src/types/opencode-plugin.d.ts`
- **Config loading**: `loadConfig()` deep-merges per section (not recursive). CLI auto-detects `./opencode-rag.json` and `./.opencode/rag.json`
- **Ollama responses**: may return `{ embedding: number[] }` or `{ embeddings: number[][] }` — both accepted
- **Quirk test**: `opencode-rag quirk test <text>` checks if a quirk already exists in the store (semantic search). Returns match details or "not appended"
- **Auto-capture quirks**: three `memory.*` flags — `passiveCapture` (per-turn extraction), `promptEnforcement` (mandatory system prompt), `sessionEndExtraction` (full-transcript on session end). All off by default. Requires `description.enabled: true` (reuses description LLM for extraction).
- **Auto-capture dedup**: candidate quirks are deduped against existing quirks via lexical similarity (`autoCaptureDedupThreshold`, default 0.85) before being added.

## Resource Lifecycle

Every `new`/`create`/`open` MUST have a matching `close()`/`destroy()`/`cancel()`:
- Use `try/finally` for cleanup (see `src/api.ts` for the pattern)
- Signal handlers: `process.once()`, remove with `removeListener`
- Map/Set growth must be bounded (session maps: max 50, config caches: clean on workspace reload)
- AbortSignal parameters: always wire through, never prefix with `_`
- ReadableStream readers: `reader.cancel()` before `releaseLock()`

## Testing & Build

- `npm test` — unit tests only (Node.js built-in `node:test`, ~5s)
- `npm run test:integration` — integration tests (30s+, spawns opencode)
- `npm run typecheck` — `tsc --noEmit`
- `npm run build` — `tsc -p tsconfig.build.json`

## Release

`npm run release:patch` — bumps version, builds, tests, tags, publishes (dry-run via `--dry`).

<!-- BEGIN opencode-rag -->
## Code Navigation

ALWAYS use OpenCodeRAG tools before reading or editing:
- **Search first** — `search_semantic(query)` instead of grep/glob
- **Skeleton before read** — `get_file_skeleton(filePath)` then read specific lines
- **Usages before edit** — `find_usages(symbolName)` before modifying any symbol
- **Images via describe** — `describe_image(filePath)` — never read raw bytes

If no results, run `opencode-rag index`.
<!-- END opencode-rag -->
