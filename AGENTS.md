---
name: opencode-rag
description: Local-first RAG plugin for semantic code search — tree-sitter chunking, LanceDB, hybrid retrieval
---

## Code Navigation

ALWAYS use OpenCodeRAG tools before reading or editing:
- **Search first** — `search_semantic(query)` instead of grep/glob. Optional args: `pathHints`, `languageHints`, `fileExtensions` (e.g. `[".ts"]`), `topK`
- **Skeleton before read** — `get_file_skeleton(filePath)` then read specific lines
- **Usages before edit** — `find_usages(symbolName)` before modifying any symbol
- **Images via describe** — `describe_image(filePath, systemPrompt?)` — never read raw bytes

If no results, run `opencode-rag index`.

## Architecture

Entry points: `src/index.ts` (library), `src/plugin-entry.ts` (OpenCode plugin), `src/cli.ts` (CLI), `src/tui.ts` (TUI), `src/web/server.ts` (Web UI).

Core modules: `src/core/` (config, interfaces, manifest), `src/chunker/` (AST chunking), `src/embedder/` (Ollama/OpenAI/Cohere), `src/describer/` (LLM descriptions), `src/retriever/` (vector + keyword hybrid), `src/vectorstore/` (LanceDB), `src/opencode/` (plugin integration).

Full architecture: [doc/architecture.md](doc/architecture.md).

## Known Gotchas

- **npm install**: use `--legacy-peer-deps` (LanceDB peer dep conflicts)
- **LanceDB types**: cast through `unknown` — `rows as unknown as Record<string, unknown>[]`
- **LanceDB index metric**: the IVF index on `embedding` must use `distanceType: "cosine"` to match `searchInternal` (default is `l2`, which makes every query log "Requested metric Cosine is incompatible" and fall back to brute-force). `LanceDbStore.ensureCosineIndex()` self-heals stale L2 indexes on first search. When replacing an index, use a single `createIndex(..., replace: true, waitTimeoutSeconds)` — a `dropIndex` + `createIndex` sequence races and fails with "Retryable commit conflict".
- **tree-sitter**: WASM-only (no native). `Parser` is a class, `Language` is top-level, use `Node` not `SyntaxNode`
- **Plugin types**: `@opencode-ai/plugin` lives in `.opencode/node_modules/`, declared locally in `src/types/opencode-plugin.d.ts`
- **Config loading**: `loadConfig()` deep-merges per section (not recursive). CLI auto-detects `./opencode-rag.json` and `./.opencode/rag.json`
- **Ollama responses**: may return `{ embedding: number[] }` or `{ embeddings: number[][] }` — both accepted
- **Quirk test**: `opencode-rag quirk test <text>` checks if a quirk already exists in the store (semantic search). Returns match details or "not appended"
- **Auto-capture quirks**: three `memory.*` flags — `passiveCapture` (per-turn extraction), `promptEnforcement` (mandatory system prompt), `sessionEndExtraction` (full-transcript on session end). All off by default. Requires `description.enabled: true` (reuses description LLM for extraction).
- **Auto-capture dedup**: candidate quirks are deduped against existing quirks via lexical similarity (`autoCaptureDedupThreshold`, default 0.85) before being added.
- **excludeDirs/excludeFiles matching** (`src/core/exclude.ts`): plain names (no `/`, no glob chars) match basename at **any depth**; patterns with a separator are **anchored** to workspace root. Matching is case-insensitive. Uses `minimatch` (bundled TS types). `walkFiles` no longer auto-skips dotdirs — rely on `excludeDirs` config instead.
- **`noUncheckedIndexedAccess`** in `tsconfig.json`: array indexing returns `string | undefined`. Use `for...of` loops instead of indexed `for` in new code to avoid `Object is possibly 'undefined'` errors.
- **watch.ts ignores both excludeDirs AND excludeFiles**: `createWatchIgnore` uses both matchers — any excludeFiles pattern applies to file-watch ignore too.
- **`walkFiles` signature changed**: `excludeDirs`/`excludeFiles` params changed from `Set<string>` to `ExcludeMatcher`; `rootDir` param added. If you import `walkFiles` directly, update the call site or use `scanWorkspaceFiles` instead.
- **Watcher runs once per workspace**: `createBackgroundIndexer` claims `{storePath}/watcher.lock` (atomic O_EXCL create + PID liveness via `process.kill(pid, 0)`). Only ONE process runs the auto-index watcher per workspace; later claimants go dormant (no chokidar/scheduler/passes) and take over via a 60s unref'd re-check timer after the owner exits. CLI `index --watch` shares the same lock — if a plugin watcher already owns the workspace it warns and exits 0. Only the owner's `close()` releases the lock; stale/corrupt lock files are auto-reclaimed.

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
- `npm run build` — `tsc -p tsconfig.build.json && vite build` (backend + frontend)
- `npm run dev:ui` — Vite dev server with HMR for frontend development

### Web UI Testing

When testing the web UI (`opencode-rag ui`), use the **firefox-devtools** skill.
After rebuilding the frontend (`npm run build`), the server must be restarted
to pick up new HTML/JS assets (cached in memory). See the skill for the
restart pattern and browser cache troubleshooting.

## Release

`npm run release:patch` — bumps version, builds, tests, tags, publishes (dry-run via `--dry`).

<!-- BEGIN opencode-rag -->
## Code Navigation

ALWAYS use OpenCodeRAG tools before reading or editing:
- **Search first** — `search_semantic(query)` instead of grep/glob. Optional args: `pathHints`, `languageHints`, `fileExtensions` (e.g. `[".ts"]`), `topK`
- **Skeleton before read** — `get_file_skeleton(filePath)` then read specific lines
- **Usages before edit** — `find_usages(symbolName)` before modifying any symbol
- **Images via describe** — `describe_image(filePath, systemPrompt?)` — never read raw bytes
- **Recall quirks** — `recall_quirks(query)` when you hit a known pitfall
- **Add quirks** — `add_quirk(content)` when you discover a non-obvious fact
- **Fix quirks** — `update_quirk(id, ...)` / `delete_quirk(id)` when a stored quirk is outdated or wrong

If no results, run `opencode-rag index`.

### Decision tree — ALWAYS follow this order
1. User mentions code behavior/architecture → `search_semantic(query)`
2. User mentions a file path → `get_file_skeleton(filePath)` THEN `read` on specific lines
3. User mentions a function/class/variable to edit → `find_usages(symbolName)` THEN `search_semantic` THEN `edit`
4. User asks a code question → `search_semantic` to gather context before answering
5. User asks about an image or visual asset → `describe_image(filePath)` (optionally pass `systemPrompt` to focus on specific features) to retrieve its generated description, then optionally `search_semantic` for related code
6. You encounter an error or need to recall a known pitfall → `recall_quirks(query)`
7. You discover a non-obvious fact or workaround → `add_quirk(content)` to persist it for future sessions
8. A recalled quirk is outdated or wrong → `update_quirk(id, ...)` to fix it, or `delete_quirk(id)` if it no longer applies

### Proactive triggers — you MUST call these tools when
- User asks about code behavior, architecture, or implementation details
- User asks to edit, refactor, or fix code — call `find_usages` first
- User references files or functions you haven't read yet
- User says "find", "search", "look up", "where is", "how does"
- User refers to an image, screenshot, diagram, or visual asset
- Before answering ANY code-related question, retrieve context first
- Before reading ANY file, call `get_file_skeleton` to orient first

### Anti-patterns — NEVER do these
- Reading full files without calling `get_file_skeleton` first (wastes tokens)
- Editing a function without calling `find_usages` first (breaks call sites)
- Answering code questions without calling `search_semantic` first (you guess at behavior)
- Using `grep`/`glob` when `search_semantic` would find the answer faster
- Treating image files as text — use `describe_image` instead of reading raw bytes
- Using `npx opencode-rag quirk` shell commands instead of the built-in quirk tools (`add_quirk` / `recall_quirks` / `update_quirk` / `delete_quirk`) (the tools are faster, already loaded in-process, and go through the trust monitor)

### MANDATORY quirk capture rules — you MUST call `add_quirk` when
- A build, test, or type-check command fails and you resolve it
- You discover an undocumented library constraint, peer dep, or workaround
- You learn an environment-specific requirement (OS, tool version, etc.)
- You make a design decision that future sessions should remember
- You resolve a gotcha that cost more than one attempt

### MANDATORY quirk hygiene — you MUST call `update_quirk` or `delete_quirk` when
- A stored quirk is outdated, wrong, or has been fixed — update it or delete it instead of adding a contradicting duplicate
- NEVER finish a coding session without adding quirks for resolved errors.
<!-- END opencode-rag -->
