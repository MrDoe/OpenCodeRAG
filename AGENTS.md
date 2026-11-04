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

Core modules: `src/core/` (config, interfaces, manifest), `src/chunker/` (AST chunking), `src/embedder/` (Ollama/OpenAI/Cohere), `src/describer/` (LLM descriptions), `src/decision/` (decision models via Ollama `/v1/systemone`), `src/retriever/` (vector + keyword hybrid), `src/vectorstore/` (LanceDB), `src/opencode/` (plugin integration).

Full architecture: [doc/architecture.md](doc/architecture.md).

## Known Gotchas

- **npm install**: use **plain** `npm install` — it resolves cleanly (verified 2026-10-27, npm 11.18/Node 24). Do **not** use `--legacy-peer-deps`: it omits non-optional peer deps, so `@effect/platform-node`'s `redis` peer is left out of `package-lock.json` and the Publish workflow's plain `npm ci` fails with `Missing: redis@6.3.0 from lock file` (v2.4.1 history: `56f789e`; regressed exactly this way on 2026-10-27). Preflight any release with `npm ci --dry-run`.
- **LanceDB types**: cast through `unknown` — `rows as unknown as Record<string, unknown>[]`
- **LanceDB index metric**: the IVF index on `embedding` must use `distanceType: "cosine"` to match `searchInternal` (default is `l2`, which makes every query log "Requested metric Cosine is incompatible" and fall back to brute-force). `LanceDbStore.ensureCosineIndex()` self-heals stale L2 indexes on first search. When replacing an index, use a single `createIndex(..., replace: true, waitTimeoutSeconds)` — a `dropIndex` + `createIndex` sequence races and fails with "Retryable commit conflict".
- **LanceDB "partition N is empty, skipping" warnings**: benign once per index build (IVF KMeans on duplicate/degenerate vectors). Constant spam = retrain churn from a store whose index commits never register (one new `_indices/<uuid>` dir per attempt). `repairIndexMetricOnce` guards: counts only index-version dirs WITH files (empty husks from version pruning never trip it), verifies post-createIndex registration via `indexStats`, gives up after 3 failed attempts per process, and skips IVF creation below `MIN_ROWS_FOR_IVF_INDEX` (4096 rows — Lance's own floor for a "meaningful index"; brute-force is optimal there); `optimize()` sweeps empty husk dirs, and rebuilds pass `optimize({ skipIndex: true })` to temp-store mid-run optimizes so the index is built once at the end. Fix for a truly non-converging store: delete rag_db + reindex. Note: u64-near `_versions/*.manifest` names are NORMAL (counter starts at u64::MAX-1 and decrements) — not corruption.
- **LanceDB "KMeans: more than 10% of clusters are empty" warning** (e.g. `2 of 16 ... 2507 < 4096`): benign and one-time when printed during the single IVF build at the end of a first-time index. Emitted by Lance's native Rust logger (`lance_index::vector::kmeans`), NOT by OpenCodeRAG's logger, so it can't be routed to the plugin log; it repeats once per KMeans training pass. See doc/troubleshooting.md.
- **LanceDB dimension integrity**: LanceDB silently zero-pads/truncates embeddings whose length differs from the table's `FixedSizeList` column — mismatched writes SUCCEED and produce unreachable rows, while queries fail with `No vector column found to match with the query vector dimension: N`. `LanceDbStore` now caches the schema dimension (`getVectorDimension()`) and throws `DimensionMismatchError` on mismatched writes; `searchWithFilter` compares against the *table* dimension, not the handle's. `runIndexPass` treats a schema mismatch as a rebuild condition (clears manifest, atomic `rag_db_tmp` rebuild at the configured dimension — also when the store is empty). `resolveRagContext` dimension precedence: `embedding.vectorDimension` > probe > existing store schema > 384. Full rebuild swaps preserve `quirks.jsonl`/`.desc-cache.json`/`runtime-overrides.json`/`eval-sessions/` (they live in the store dir and are NOT re-derivable).
- **Embedding preflight**: `runIndexPass` probes the embedder before chunking/description and aborts (`embeddingUnavailable: true`, CLI exit 1) when the provider is down or its dimension disagrees with `options.dimension` — prevents a 6-minute "successful" pass that stores 0 chunks.
- **Failed embedding batches SPLIT, they never drop the whole batch**: `embedWithRetry` (src/embedder/factory.ts) halves a batch and retries recursively for every non-permanent failure *and* for llama.cpp `exceed_context_size_error` (which arrives as a permanent HTTP 400). Depth 0 gets the full `embedding.retryMax` budget, sub-batches one attempt each. Permanent errors (401/403/404/422) never split. **Gateway 5xx (502/503/504) never split either** — they mean the *server* is down / over capacity / running a context smaller than our chunks (not one bad text), so shrinking the batch can't help; they get a depth-0 retry only. And `embedBatch` has a **circuit breaker**: after 6 consecutive failed batches (reset by any success) it stops calling the provider and fails fast, logging `Embedding circuit breaker tripped…` — otherwise an undersized embedding server silently grinds and looks like a hang (see `.opencode/wiki/concepts/embedding-server-context-502.md`). Each failed batch logs `Embedding batch failed after N attempt(s)` + `Splitting failed batch of N text(s)` (scope `embedder.batch`) — without those lines a partial index looks like data loss.
- **Index stat semantics**: `Unchanged/New/Modified files` count FILES; `Chunks written this pass` is `stats.totalChunks` (this pass only) and the final `chunks stored` is `store.count()`. A partially embedded file gets no manifest entry, so `storeWindow` deletes its stale rows in-window and every pass that touched the index ends with an orphan sweep (`writtenThisPass` protects fresh partial writes, quirk rows are owned by quirks.jsonl and skipped). `status` exposes the unaccounted delta as `Orphan chunks`.
- **Keyword index can drift behind the vector store**: the BM25 index (`keyword-index.json`) and the LanceDB store are two independent stores of the same corpus, and an incremental pass only calls `keywordIndex.addChunks()` for the files it *reprocessed* — so a once-partial index stays partial forever and the missing files become unreachable through keyword search (measured 2026-10-20: 241 of 440 files had no BM25 entries, and the golden-set labels mapping to them were BM25 *and* retrieval misses). `runIndexPass` now rehydrates the missing entries **from the store's own rows** (`src/indexer/keyword-rehydration.ts` — no re-embedding, no re-chunking) and `opencode-rag status` prints a `Keyword coverage` line. Never add a chunk twice: `addChunks()` is NOT idempotent for the BM25 length statistics and term frequencies, so a double add inflates the scores.
- **`opencode-rag eval:tune`**: sweeps `retrieval.hybridSearch.keywordWeight` / `symbolKeywordWeight` / `minScore` / `topK` against the labelled golden set and reports the winner (`--write` persists it into the config). The shipped `keywordWeight=0.4` is a default, not an optimum, but **do not read the argmax as a measurement**: the report prints a paired-bootstrap CI, the win/loss counts and an exact sign test, and warns "Weak evidence" when the sign test is above 0.05. Measured 2026-10-20 (48 labels, jina-code-embeddings-0.5b, complete keyword index): kw=0.4 → Hit@1 37.5% / Hit@5 68.8% / nDCG@10 0.540, kw=0 → 52.1% / 81.3% / 0.690 — but only 19 vs 11 discordant labels (sign test p ≈ 0.20) and a CI that can include 0, so the direction holds while the sample is too small to justify changing a shipped default. The command also prints a **signal split** (BM25-only Hit@1 20.8% vs vector-only 52.1% here) — a fused ranking is only interpretable next to the quality of the two halves it mixes. The optimum is setup-dependent (the author's Qwen3-Embedding:8B run measured Hit@5 47.9% at kw=0.4), so measure instead of guessing — and rehydrate the keyword index first, or the sweep measures a broken pipeline. Note the fused score's scale depends on kw (a vector-only hit maxes out at `1-kw`), so a fixed `minScore` filters differently per kw.
- **`indexing.embedDescriptions`** (default `true`): set `false` for code-specialized embedders (e.g. jina-code-embeddings) — descriptions are still generated/stored for display but excluded from the embedded text.
- **`describe_image` model split**: on-demand calls (plugin tool, MCP server, `opencode-rag describe-image`) resolve `imageDescription.onDemand` overrides on top of the indexing config via `resolveOnDemandImageConfig` (src/chunker/image.ts); indexing always uses the base `imageDescription.*` and ignores `onDemand`, so it needs no re-index. `imageDescription.enabled` stays the master gate. Health checks emit `image_description_on_demand` when the effective provider/model differs. **Paths are not sandboxed**: all three surfaces resolve the path with `resolveUserPath` (src/core/paths.ts), so absolute paths outside the workspace and `~`-prefixed paths are allowed — only the extension is validated. The workspace-sandboxed tools (`read`, `get_file_skeleton`) keep using `resolveWorkspacePath` / `resolveFilePath`.
- **jina-code-embeddings on llama.cpp**: needs `pooling = last` in the models.ini preset (error otherwise: "Pooling type 'none' is not OAI compatible"); 0.5b = 896 dims, instruction prefixes are `"Find the most relevant code snippet given the following query:\n"` (query) and `"Candidate code snippet:\n"` (document). License is CC-BY-NC-4.0 (non-commercial).
- **tree-sitter**: WASM-only (no native). `Parser` is a class, `Language` is top-level, use `Node` not `SyntaxNode`
- **Plugin types**: `@opencode-ai/plugin` lives in `.opencode/node_modules/`, declared locally in `src/types/opencode-plugin.d.ts`
- **Config loading**: `loadConfig()` deep-merges per section (not recursive). Workspace config is canonical at `.opencode/opencode-rag.json` (legacy reads: root `opencode-rag.json`, `.opencode/rag.json`); `setup` migrates a root file. Global base layer: `~/.config/opencode/opencode-rag.json`. The TUI saves provider options (provider/model/baseUrl/apiKey/vectorDimension of embedding/description/imageDescription/decision/reranking) to the GLOBAL file only and deletes the matching runtime overrides; everything else writes the workspace file + runtime override.
- **Commander must not exit the process**: the CLI's Commander singleton sets `program.exitOverride()` (before registering sub-commands — they inherit `_exitCallback` via `copyInheritedSettings()`). Commander otherwise calls `process.exit()` for `--help` / `--version` / argument-validation errors, which kills the *host* process — in tests that aborted the test file mid-suite, on Windows as `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`. `runCli()` swallows the `commander.helpDisplayed` / `commander.help` / `commander.version` codes and rethrows everything else; the real-CLI path maps a `CommanderError` to `process.exitCode`.
- **Live-provider tests must probe capability, not liveness**: `GET /api/tags` proves Ollama is up, not that it can serve. A GPU-saturated Ollama (a large model holding VRAM) answers `/api/tags` instantly and never answers `/api/embed`. Probe the real endpoint with a bounded timeout and `t.skip()` when it fails — `t.skip()` does NOT halt execution, so `return t.skip(...)`.
- **Ollama responses**: may return `{ embedding: number[] }` or `{ embeddings: number[][] }` — both accepted
- **Quirk test**: `opencode-rag quirk test <text>` checks if a quirk already exists in the store (semantic search). Returns match details or "not appended"
- **Auto-capture quirks**: three `memory.*` flags — `passiveCapture` (per-turn extraction), `promptEnforcement` (mandatory system prompt), `sessionEndExtraction` (full-transcript on session end). All off by default. Requires `description.enabled: true` (reuses description LLM for extraction).
- **Auto-capture dedup**: candidate quirks are deduped against existing quirks via lexical similarity (`autoCaptureDedupThreshold`, default 0.85) before being added.
- **Tool-error quirks are auto-created** (`memory.autoCreateOnToolError`, default true): a failed tool call with no matching memory gets a NEW quirk — a deterministic template (`Tool \`x\` failed: <error>` + a classified cause), no LLM, so it works with `description.enabled: false`. Four rules keep it from polluting memory: (1) the recall runs ONCE and the "does an equivalent quirk already exist?" check is **EXACT** — a metadata match on the `tool:<name>` + `cause:<class>` tags, NOT a loose similarity floor (measured 2026-10-20: an error query scores **0.55-0.63** against arbitrary stored quirks, so a 0.6 floor sits inside the noise band and matches unrelated quirks — it suppressed creation on every real failure); (2) creation is bounded by a per-session budget (`toolErrorCreateMaxPerSession`, 2) + a per-signature cooldown (`toolErrorCreateCooldownMs`, 10 min); (3) the created quirk is tagged `tool-error` and is EXCLUDED from the generic auto-inject paths (`recallQuirks`' new `excludeTags` option) so a raw error dump never leaks into an unrelated turn; (4) the INJECTION budget limits context, not memory, so it no longer blocks creation — the two are decoupled. The created quirk is persisted for future sessions, NOT injected into the failing turn (`toolErrorInjectCreated`, default false). The trust monitor is NOT bypassed: an error text containing a blocked pattern (e.g. a shell error echoing `rm -rf`) is rejected and only logged. Threshold on `rawSimilarity` (`explanation.scoreBreakdown.rawVectorScore`), never on `recallQuirks`' `score` — that one is confidence-discounted (`similarity * confidence`) and is not comparable to a similarity threshold.
- **All errors are intercepted, not just host-reported ones** (`memory.interceptAllErrors`, default true): OpenCode reports only a *host-level* rejection (schema/argument validation) as `status=error` — a command that exits non-zero, a script that raises, a file that cannot be read are all delivered as `status=completed` with the failure mentioned only in the output, so the quirk path was blind to the most common real failure. `src/quirks/error-signals.ts` scans the completed branch's output for **high-precision** markers (OpenCode's own `Exited with code N` — the only machine-readable failure signal in a command's output, measured live 2026-10-21; Node errno codes; Python tracebacks; `npm ERR!`; uncaught JS exceptions; process crashes) plus the `session.execution.failed` event for model/provider failures (V2's name — `session.error` is never emitted). Generic `Error:` anywhere and localized "not found" are deliberately NOT matched: a false positive costs a recall, a possible quirk write, and an injected block in the next request. Detected failures re-use the whole recall→inject→create path; `causeClassOverride` supplies a stable cause class (e.g. `exit-code`) so the EXACT duplicate check still works on raw stderr, which is too varied for the classifier alone. TWO rules keep the false-positive rate at zero, both learned from live probes: (1) the **structured exit code wins** — the shell tool reports `{ status, truncated, exit }` in the result metadata, and a non-zero code is definitive while a ZERO code means the command SUCCEEDED, so a marker-looking string in a successful command's output is not a failure; (2) the **text rules apply only to command-execution tools** (`shell`/`bash`/`run`/`exec`/`command`) — a `grep` or `read` returns FILE CONTENT, and a file documenting "EACCES / EPERM" was reported as a permission failure and wrote a quirk. Non-command tools get one exception: the plugin's own `Could not read file:` message, which is the whole output when it happens.
- **Proactive tool gotchas** (`memory.toolErrorProactiveInject`, default true): the known tool gotchas are injected into the SYSTEM PROMPT *before* the model picks a tool, so a failure that already happened in an earlier session is not repeated. The injection point is `experimental.chat.system.transform` (V2: `ctx.session.hook("context")`) — it is the ONLY pre-decision injection surface: `tool.execute.before` can only mutate `output.args` (and the V2 adapter does not forward it at all), and `tool.transform` can only ADD tools, not modify a built-in tool's description. The block is scoped to the session's **tool catalog** (`input.tools`, measured live: 27 tools incl. write/edit/shell/read) and to **durable** cause classes only (unknown-tool, schema, permissions, path) — a transient failure (rate limit, timeout) must NEVER be warned about in advance, because the next call will not fail the same way. Reads the tool-error quirks from `quirks.jsonl` directly (`listToolErrorQuirks`), NOT via `listQuirks`: that function falls back to scanning the whole vector store when the audit log is missing, which is far too expensive for a per-request path. Cached 30 s, invalidated when a quirk is created.
- **OpenCode reports only SOME failures as tool errors**: a bash command with a non-zero exit is `status=completed` (the exit code is in the output text), and a tool that handles its own error internally (e.g. the RAG `read` override on a missing file) is also `completed`. Only a host-level rejection (schema/argument validation) is `status=error`. With `memory.interceptAllErrors` (default true) the plugin ALSO scans the *completed* branch's output for failure markers, so those failures are recorded too — but only when a high-precision marker is present. A tool that swallows its error with no marker in the output stays invisible, by design.
- **OpenCode V2 renamed the event stream — a V1 event name never fires and fails silently.** The payload lives in `data` and V2 never sets `properties` (measured live 2026-10-21: `hasData=true, hasProperties=false` for every event of a full session); the V1 names `message.updated` / `message.part.updated` had **zero** occurrences. The real names are `session.execution.{started,succeeded,failed}`, `session.text.{started,delta,ended}`, `session.reasoning.*`, `session.step.*`, `session.tool.*`. Two consequences fixed in this release: the session-failure interception listens for **`session.execution.failed`** (`{ sessionID, error }` in `data`) — `session.error` exists in the schema but V2 never emits it; and the assistant-text accumulation (which feeds the 2-message auto-inject query) now listens for `session.text.delta` (`{ sessionID, assistantMessageID, delta }`) — the V1 branch was DEAD on V2, so the query silently fell back to the user message only. RULE: verify the event vocabulary empirically (a probe plugin that logs `{ type, keys, hasData }` over one `opencode run --standalone` gives the whole vocabulary); an event-name mismatch cannot fail loudly, it just makes a feature do nothing forever.
- **The `tool.execute.after` hook fires AFTER the tool result reaches the model**: the hook writes its log line and updates state in the same turn the tool result is delivered, so a log check issued in that turn sees the pre-write state. Read the log in a LATER turn — otherwise the feature looks broken when it is not.
- **The fused hybrid score's scale depends on `keywordWeight`** (`retrieval.minScoreMode`, default `"fused"`): a result's maximum is set by which signals it hit — a DUAL hit reaches `(1-kw)+kw` = 1.0 at every `kw`, a **vector-only** hit reaches `1-kw` (0.6 at kw=0.4), a keyword-only hit `kw`. So a fixed `minScore` means different things at different weights: at `minScore=0.65, kw=0.4` the gate silently demands a DUAL hit (measured on the 48-label golden set: 12.7-13.5 of 20 results admitted vs 17.7-18.0 at kw=0). `minScoreMode: "normalized"` divides the score by the maximum that result could reach, making the gate scale-free — but the DEFAULT stays `"fused"` because 48 labels cannot settle the quality delta (paired sign test p = 1.00). Justify the mode by the CONTRACT, not the metric.
- **excludeDirs/excludeFiles matching** (`src/core/exclude.ts`): plain names (no `/`, no glob chars) match basename at **any depth**; patterns with a separator are **anchored** to workspace root. Matching is case-insensitive. Uses `minimatch` (bundled TS types). `walkFiles` no longer auto-skips dotdirs — rely on `excludeDirs` config instead.
- **`noUncheckedIndexedAccess`** in `tsconfig.json`: array indexing returns `string | undefined`. Use `for...of` loops instead of indexed `for` in new code to avoid `Object is possibly 'undefined'` errors.
- **watch.ts ignores both excludeDirs AND excludeFiles**: `createWatchIgnore` uses both matchers — any excludeFiles pattern applies to file-watch ignore too.
- **`walkFiles` signature changed**: `excludeDirs`/`excludeFiles` params changed from `Set<string>` to `ExcludeMatcher`; `rootDir` param added. If you import `walkFiles` directly, update the call site or use `scanWorkspaceFiles` instead.
- **Watcher runs once per workspace**: `createBackgroundIndexer` claims `{storePath}/watcher.lock` (atomic O_EXCL create + PID liveness via `process.kill(pid, 0)`). Only ONE process runs the auto-index watcher per workspace; later claimants go dormant (no chokidar/scheduler/passes) and take over via a 60s unref'd re-check timer after the owner exits. CLI `index --watch` shares the same lock — if a plugin watcher already owns the workspace it warns and exits 0. Only the owner's `close()` releases the lock; stale/corrupt lock files are auto-reclaimed.
- **Windows console flashes**: every `child_process` spawn in this repo must pass `windowsHide: true` — the plugin runs inside OpenCode's console-less service (`opencode serve --service`), so an un-hidden spawn opens a visible terminal window (a Windows Terminal window/tab on WT-default systems) per spawn. Fixed 2026-10-07 across `git-diff.ts` (8×), `package-manager.ts`, `version-check.ts`, `setup-runtime.ts`, `setup.ts`, `run-branch-compare.ts`, `ui.ts` — see `.opencode/wiki/concepts/windows-console-flashes.md`.
- **Install/setup (2.13.0+)**: the plugin installs **once globally** (`~/.config/opencode/plugins/opencode-rag/{index.js,tui.js}`) and the postinstall does it too; a workspace only gets config + skills + AGENTS.md + `.gitignore`. The plugin auto-scaffolds a fresh repo on load (`setup.autoScaffold`, create-only). `setup` offers a one-question preset (Ollama CPU/GPU) and pulls missing models; the detailed wizard is "Custom"/`--reconfigure`. `--workspace-plugin` restores the per-repo layout. **LanceDB stays per workspace** — `vectorStore.path` resolves against the worktree, never the plugin/global dir. Adding a new OpenCode plugin entry? Verify it loads with `opencode plugin list` (server role) before assuming the TUI role works.
- **V2 TUI plugin layout**: OpenCode 2 loads the TUI from plugin *directories* only. `setup` installs the plugin **once, globally** at `~/.config/opencode/plugins/opencode-rag/{index.js,tui.js}` (relative imports into `~/.opencode/node_modules/opencode-rag-plugin/dist/`); `--workspace-plugin` restores the per-repo `.opencode/plugins/opencode-rag/` layout. A flat `.opencode/plugins/rag-tui.js` is server-role only, so the sidebar silently never appears. `dist/tui.js` must import `@opentui/solid` **lazily** (dynamic import inside the TUI branch of `setup()`; the peers are optional) or registry installs and server-role loads fail with "Cannot find package '@opentui/solid'" (issue #35). TUI context: providers/models via `data.location.provider/model.list(location)`; report the plugin's own version, not `context.app.version`. See `.opencode/wiki/concepts/opencode-v2-plugin-layout.md`.
- **`ctrl+shift+<letter>` is not deliverable everywhere**: VS Code's integrated terminal (xterm.js) sends **nothing** for it until the Kitty keyboard protocol is negotiated; VTE sends the plain control byte. `alt+<letter>` (ESC + letter) and `ctrl+alt+<letter>` (ESC + control byte) are the legacy-safe forms — on Windows `ctrl+alt` is AltGr, so `alt+<letter>` is the most layout-proof. `tui.settingsKeybinding` therefore defaults to **`alt+s`** and binds exactly that one chord (no fallback bindings); configuring a `ctrl+shift+<letter>` chord simply will not fire on those terminals. See `.opencode/wiki/concepts/tui-keybinding-delivery.md`.
- **`make_decision` / tev1**: requires Ollama >= 0.35 (`/v1/systemone` — root-level, so a trailing `/api` base URL is stripped) and a pulled model (`ollama pull tev1:0.8b` / `tev1:4b`); gated behind `decision.enabled` (default `false`), so the tool is only registered when enabled. Keep `state` short (effective context ~2k tokens; 64 KiB request cap); `choice`/`score` take 2–24 options/levels; `confidence` is probability concentration, NOT the chance the answer is right. 404s are split by cause: route missing (Go's "404 page not found") → Ollama >= 0.35 hint; model missing ("try pulling it first") → `ollama pull <model>` hint.
- **ClickHouse backend (opt-in)**: `vectorStore.provider: "clickhouse"` centralizes the index; LanceDB stays the default. `pat06` runs 26.10, so `ann: "hnsw"` (ClickHouse >= 25.8) is supported and enabled there; `ann: "off"` keeps exact `cosineDistance` scans. Reads need `FINAL` (the HNSW index is still used with `FINAL` + `is_deleted = 0`); dedup is insert-first, and tombstones MUST reuse the superseded row's vector because an indexed column rejects empty arrays and wrong lengths. The ANN index is dimension-bound — a model change requires dropping the project tables (the store throws instead of corrupting). Filtered ANN queries use `annFetchMultiplier`/`annWithRescoring`; topK is clamped to `max_limit_for_vector_search_queries` (1000). Full rebuilds write `epoch active+1` and flip `_meta.active_epoch`; `StateSync` makes `vectorStore.path` a disposable cache; the multi-machine lease is advisory (no CAS). `opencode-rag clickhouse setup` configures + initializes it. See `.opencode/wiki/entities/clickhouse-store.md`.
- **Tests must isolate the user config**: `~/.config/opencode/opencode-rag.json` is a real config layer, so a machine with a global `Qwen3-Embedding:8B` setup makes bootstrap tests see `openai`/4096 instead of `DEFAULT_CONFIG`. `src/__tests__/core/bootstrap.test.ts` overrides `USERPROFILE`/`HOME`/`XDG_CONFIG_HOME` for that reason.

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

`npm run release:patch` / `npm run release:minor` (`--dry` for a dry run) — pushes `main`, runs
`npm version` (needs a **clean** working tree: commit or stash everything first, including other
sessions' work), pushes the new tag and opens the GitHub release via `gh`. They do **not** build,
test or `npm publish` — creating the release triggers `.github/workflows/publish.yml`, which builds,
tests and publishes to npm with CI credentials (~2-3 min; check `gh run list`). Push `main` once more
afterwards if you want the bump commit on `origin/main` — the scripts push `main` *before* the bump.

<!-- BEGIN opencode-rag -->
## Code Navigation

ALWAYS use OpenCodeRAG tools before reading or editing:
- **Search first** — `search_semantic(query)` instead of grep/glob
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

### Long-running commands
Long-running commands:
- Any `shell` call expected to take more than 30s MUST set `background: true` (returns immediately; the session is notified on completion) or set an explicit `timeout` (ms).
- Default foreground timeout: 120000ms. Never run builds/tests/indexes in the foreground beyond 30s; if a call is already running, press Ctrl+B to background it (OpenCode: `session.background`).
- OpenCodeRAG measures foreground shell duration and records a quirk when a call exceeds the threshold, so repeated foreground runs become visible.
<!-- END opencode-rag -->

<!-- opencode-crosstalk:begin -->
## OpenCode Crosstalk

Other OpenCode sessions in this workspace are reachable through the
`opencode-crosstalk` plugin: `crosstalk_status`, `crosstalk_peers`,
`crosstalk_send`, `crosstalk_inbox`, `crosstalk_claim`, `crosstalk_wait`.
Talk to each other briefly, but keep working — only stop for coordination that prevents
a real collision.

- **Declare once - precisely and concisely - then keep moving.** `crosstalk_status` sets your role and goal;
  `crosstalk_peers` shows active sessions and their leases. Work that does not
  overlap theirs needs no coordination.
- **Talk before you collide.** If you need something a peer holds, `crosstalk_send`
  a short precise ask and continue elsewhere; replies are injected into live turns (use
  `crosstalk_inbox` to catch up). Never force a claim.
- **Lease what you are editing now.** `crosstalk_claim` takes an exclusive expiring
  lease on exact paths — no globs (`resources`, `note`, `ttlSeconds`). `renew` if the
  work runs long, `release` when done; a refusal names the holder.
- **Identity is automatic** — never pass a "who am I". Blocking calls are capped by
  `maxWaitMs` and may return early; that is normal.

Installed globally - `opencode api get /api/plugin` shows if `opencode.crosstalk` is active.
<!-- opencode-crosstalk:end -->
