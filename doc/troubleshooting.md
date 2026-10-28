# Troubleshooting

## Common Issues

### "Plugin export is not a function" in OpenCode

**Cause:** OpenCode tries to load the plugin via the `"plugin"` key in config, triggering module resolution differences in Bun vs Node.js.

**Fix:**
1. Do NOT register via `"plugin": ["opencode-rag-plugin"]` in OpenCode config
2. Rely on `.opencode/plugins/opencode-rag/` auto-discovery instead
3. Run `opencode-rag setup` to regenerate workspace-local plugin files
4. Remove stale `"plugin"` entries from all OpenCode config files

**Verify:**
```bash
node --input-type=module -e \
  "const m = await import('opencode-rag-plugin'); console.log(typeof m.default?.setup)"
```

`function`.

### "Plugin must export a default definition with an id and an effect or setup function"

**Symptom:** OpenCode logs `failed to load plugin … ref=err_… cause=PluginModule.LoadError:
Plugin must export a default definition with an id and an effect or setup function
(SchemaError: Missing key at ["default"]["effect"], Missing key at ["default"]["setup"])`
in `~/.local/share/opencode/log/opencode.log`, and the OpenCode UI shows a server plugin error.

**Cause:** OpenCode V2 validates each plugin's `default` export against `{ id, effect }` or
`{ id, setup }`. A V1-only shape (`{ id, server }` or `{ id, tui }`) fails validation. The
schema check runs *after* module import, so an earlier import-time error (e.g. the
`@opentui/core` env-registry conflict below) hides it until the first error is fixed —
the logged `cause=` is authoritative; do not infer the cause from the `ref=` alone.

**Fix:**
1. Rebuild: `npm run build` (`dist/` is gitignored — a `git pull` updates `src/` but never the loaded `dist/`)
2. Verify the export shape (see *Debugging Plugin Loading* below): the default must expose
   `id` and `setup` (both the server and the TUI plugin)
3. If the TUI sidebar or keybindings never appear, check the plugin **directory** layout:
   `.opencode/plugins/opencode-rag/index.js` (server) + `tui.js` (CLI) must both exist.
   OpenCode 2 only discovers plugin directories (`index.*`/`tui.*`) for the terminal UI —
   a V1-era flat `.opencode/plugins/rag-tui.js` is never loaded there, only in the server
   role. Re-run `opencode-rag setup` to migrate the flat layout (it removes only the files
   it generated itself).

### No Context Returned by OpenCode

**Possible causes:**
1. Workspace not indexed yet — run `opencode-rag index`
2. Embedding call failing — check if the raw socket path is being used correctly (see proxy section)
3. No matching code found — refine your query or run `opencode-rag index` to (re)index the workspace
4. Index is stale — run `opencode-rag index --force` for a full rebuild

### `/doc` Says Documentation Mode Is Disabled But The Config Says `true`

**Symptom:** `documentationMode.enabled` is `true` in `opencode-rag.json`, a standalone
`loadConfig(findConfigFile(cwd))` returns `true`, but `/doc` answers
"Documentation mode is not enabled" — and restarting the TUI does not help.

**First: read the resolution line in the reply.** The command now prints exactly which
file it read:

```
Config resolution — directory: <dir>; workspace: <path|none>; global: <path|none>.
```

- `workspace: none` → the plugin is looking at a **different directory** than the one you
  edited. OpenCode's plugin `location` is the session directory, not necessarily the
  directory you opened the file from.
- `workspace: <path>` pointing at a file you did not edit → a **higher-precedence layer
  shadows your edit**: `.opencode/opencode-rag.json` wins over the legacy root
  `opencode-rag.json` (and the global `~/.config/opencode/opencode-rag.json` is only a
  base layer, always overridden by a workspace file).
- `workspace` correct, file correct, still disabled → **the plugin is running with a
  stale config**. OpenCode V2 starts plugins inside a shared background service that
  survives TUI restarts, so closing the TUI does not reload the plugin:

  ```bash
  opencode service restart
  ```

**Where to check the plugin's view:** `.opencode/opencode-rag.log` records one line per
plugin instance:

```
[config] Config: directory: <dir>; workspace: <path>; global: <path>; documentationMode.enabled=false; wikiMode.enabled=true
```

If that line is older than your config edit, the plugin never reloaded.

**Why it used to stay stale:** the plugin dropped its own config-cache entry right after
loading it, which disabled the live re-read (`refreshConfig`) that every "edit the config
without restarting" feature depends on. The entry now survives, and the slash-command
gates (`/doc`, `/wiki`, `/quirk`) read the workspace config straight from disk instead of
a startup snapshot.

### RAG Settings Dialog Does Not Open (VS Code / PowerShell)

**Symptom:** the settings hotkey does nothing in the PowerShell prompt inside VS Code's integrated terminal. The shipped default `alt+s` is not affected — this happens when `tui.settingsKeybinding` is set to a `ctrl+shift+<letter>` chord.

**Cause:** Legacy terminal encodings cannot carry `ctrl+shift+<letter>`. VS Code's terminal (xterm.js) emits **no bytes at all** for that chord until the Kitty keyboard protocol is negotiated; VTE/gnome-terminal sends the plain control byte instead. The key never reaches OpenCode, so no keybinding can fire.

**Fix:** set `tui.settingsKeybinding` to `"alt+s"` (the default) or another legacy-safe chord in `opencode-rag.json` — `alt+<letter>` (ESC + letter) works on every layout; `ctrl+alt+<letter>` also works but is AltGr on Windows. The plugin binds exactly the configured chord and adds no fallback. Terminals with Kitty keyboard support (kitty, WezTerm, Ghostty, foot, Alacritty, newer VS Code with the protocol enabled) deliver `ctrl+shift+<letter>` itself, so a custom chord remains valid there.

**Immediate workaround:** type **`/rag-settings`** (alias `/rag`) in the prompt. The dialog is also registered in prompt slash completion, and the text-input path needs no keyboard-protocol support.

### Embedding Timeouts

**Symptom:** Indexing fails with `Global embedding failed: Request timed out after Nms`. All files show as "Removed".

**Cause:** The embedding provider (typically Ollama running a local model) takes longer than the configured timeout to process a batch of texts.

**A second, different cause: the server is up but cannot serve.** Ollama
answers `GET /api/tags` instantly while `POST /api/embed` never returns —
typically because the GPU is saturated by a large model already resident in
VRAM (e.g. a 27B model holding ~23 GB), leaving no room for the embedding
model to be scheduled. Check with `GET /api/ps`: if a huge model is listed
with a `size_vram` close to the card's capacity, that is the cause. Raising
`embedding.timeoutMs` will not help — the request never completes. Unload the
resident model (or stop the process holding it) and retry.

**Default values:**
- `embedding.timeoutMs`: `120000` (120s) — maximum time to wait for a single embedding request
- `indexing.ollamaMaxBatchSize`: `100` — smaller batches mean each individual call completes faster

**Fix:** If you still hit timeouts, increase further in `opencode-rag.json`:

```json
{
  "embedding": {
    "timeoutMs": 180000
  },
  "indexing": {
    "ollamaMaxBatchSize": 200
  }
}
```

Lowering `ollamaMaxBatchSize` sends smaller sub-batches to Ollama, so each request completes faster. Raising `timeoutMs` gives each request more time. Combine both for slow models or constrained hardware.

**Note:** If your config file explicitly sets `embedding.timeoutMs`, it overrides the default. Check `opencode-rag.json` for any explicit value.

**A timeout costs more than the batch it timed out on.** A request that times
out usually means one oversized text is still being chewed through by the
server, so the whole request — and with it every healthy text in the same
batch — comes back without a vector. `embedder.batch` therefore splits a batch
that failed for a non-permanent reason in half and retries recursively down to
single texts: only the text(s) that individually fail end up without a vector,
and those chunks are retried on the next pass. Look for
`Embedding batch failed after N attempt(s)` and `Splitting failed batch of N
text(s)` (scope `embedder.batch`) in `.opencode/opencode-rag.log`.

### Chunks Stored Does Not Match The Manifest

**Symptom:** `opencode-rag status` shows more indexed chunks than expected
chunks, or an index pass prints `14038 chunks stored` after reporting only a
handful of processed files.

**Cause:** a file whose chunks only *partially* embedded never gets a manifest
entry (the entry would claim the file is complete), yet the rows an earlier pass
already wrote for it stayed in the table. Dedup only fires for files that write
*new* rows, so nothing ever removed them and the store count kept drifting away
from the manifest. `opencode-rag clear` that was interrupted while it was still
copying its backup produced the same shape: a backup directory, but a store and
manifest that were never touched.

**Fix:** run `opencode-rag index`. Any pass that changes the index ends with an
orphan sweep that deletes rows no manifest entry owns (plus their keyword-index
entries) and logs `Orphan cleanup: removed N chunk(s) from M file(s)`. `status`
shows the current delta as `Orphan chunks`; `Indexed chunks` minus
`Expected chunks` minus the quirk rows should be 0 afterwards.

### Keyword Index Covers Only Part Of The Corpus

**Symptom:** `opencode-rag status` prints `Keyword coverage: N file(s) in the store are
missing from the keyword index`, or the keyword half of hybrid search seems to ignore
whole files — a query that should match `src/core/exclude.ts` returns nothing, while the
vector search finds the file fine.

**Cause:** the keyword index (`keyword-index.json`) and the vector store are two
independent stores of the same corpus, and nothing kept them in sync by construction. An
incremental index pass only calls `addChunks()` for the files it *reprocessed*; unchanged
files keep whatever the loaded index had. So once the persisted index lost entries — a
crashed pass that saved a cleared index, a partial indexer, a store rebuild that swapped
the table without rewriting the sidecar — every later pass re-saved the same partial
state and the missing files stayed unreachable through keyword search forever.

**Fix:** run `opencode-rag index`. Every pass now compares the store's file list with the
keyword index and rebuilds the missing entries from the store's own rows (no
re-embedding, no re-chunking — seconds, not minutes). The pass logs
`Keyword rehydration: restored N chunk(s) from M file(s)`. `opencode-rag status` reports
the coverage so a drift is visible before it costs you recall.

### `clear` Appears To Do Nothing

**Symptom:** `opencode-rag clear` prints `Clearing N indexed chunks...` and then
nothing — no `Done.` line — while a `chunks.lance.backup-*` directory appears.

**Cause:** the process was interrupted while the backup of a large store was
still being copied, before anything was actually cleared.

**Fix:** run `clear` again. It now moves the table instead of copying it (so the
window for an interruption is gone), prints the backup path before starting, and
verifies the table is empty afterwards — a clear that did not finish exits with
code 1 and leaves manifest and keyword index untouched.

### LanceDB Connection Issues

**Symptom:** `@lancedb/lancedb` throws errors about missing native binary or peer dependency.

**Fix (end users):**
```bash
npm install -g opencode-rag-plugin
```

**Fix (developers of the plugin):**
```bash
npm install --legacy-peer-deps
```

Ensure `apache-arrow` is installed — it's a peer dependency.

### npm Install Fails with SSL Errors

**Cause:** Corporate proxy or SSL inspection blocking npm.

**Fix:**
```bash
set NODE_TLS_REJECT_UNAUTHORIZED=0   # Windows
export NODE_TLS_REJECT_UNAUTHORIZED=0  # Linux/macOS
npm install -g opencode-rag-plugin
```

### Proxy Issues with OpenCode

When running inside OpenCode, the runtime can interfere with the normal Node HTTP stack, causing localhost Ollama calls to be redirected through the proxy.

**Symptoms:**
- Ollama calls fail or time out
- OpenCode stops returning context

**Fix:** OpenCodeRAG's `directRequest()` in `http.ts` uses raw `net`/`tls` sockets for direct requests, bypassing the patched HTTP stack. Ensure you use `http://127.0.0.1:11434/api` (not `localhost`) in config for the bypass to work.

### Test Suite Hangs

**Cause:** chokidar and LanceDB leave open handles.

**Fix:** Always use `--test-force-exit`:
```bash
node --import tsx --test --test-force-exit "src/**/*.test.ts"
```

### Windows: `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`

**Symptom:** a test file aborts part-way through with
`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94`.
The runner reports the *file* as failed, and the remaining tests in it never
run — often with a different pass count on every attempt.

**Cause:** a libuv teardown race on Windows, triggered when the process is torn
down while an async handle is still closing. The usual trigger is an abrupt
`process.exit()` from inside a test — e.g. Commander's default behaviour for
`--help` and for argument-validation errors, which killed the test runner
mid-suite. OpenCodeRAG's CLI sets `program.exitOverride()` so Commander throws
instead of exiting (see `src/cli/index.ts`); a library that shells out to
Commander needs the same guard.

**Fix:** never let a dependency call `process.exit()` inside a test. Map the
error to `process.exitCode` and let the process drain naturally.

### "oldString not found in content" on ReadMe Edits

The ReadMe is generated and edited by the workflow manager. If you're editing files manually, use the Read tool first to ensure you have the current content.

## Windows: Terminal Windows Flash Repeatedly

On Windows, short-lived terminal windows open and close during indexing. With Windows
Terminal as the default terminal app each flash is a WT window/tab titled `Terminal`
and then the spawned exe path (e.g. `C:\Program Files\Git\cmd\git.exe`). Cause: OpenCode
runs the plugin inside its console-less background service (`opencode serve --service`);
a child process spawned without `windowsHide: true` gets a freshly allocated visible
console. All OpenCodeRAG spawn sites (git detection in `git-diff.ts`, package-manager
probes, update installs, browser opener) pass `windowsHide: true` since 2026-10-07. If
flashes persist, another plugin/tool is spawning without it — check the timestamps
against `.opencode/rag_db/watcher-status.json` (each index pass triggers the git calls)
and see `.opencode/wiki/concepts/windows-console-flashes.md` for the diagnostic recipe.

## Logging

Enable debug logging to diagnose issues:

```json
{
  "logging": {
    "level": "debug",
    "logFilePath": "./.opencode/opencode-rag.log"
  }
}
```

The log file provides detailed information about indexing, retrieval, and plugin events.

## Manifest Corruption

The manifest file (`manifest.json`) uses schema versioning. If the format changes between plugin versions, a full index rebuild is triggered automatically.

To manually force a rebuild:
```bash
opencode-rag index --force
```

## "KMeans: more than 10% of clusters are empty" Warnings

**Symptom:** During the final `Optimizing vector store (compacting fragments,
pruning old versions)...` step of an index run, LanceDB's native logger prints
several copies of:
```
WARN  lance_index::vector::kmeans] KMeans: more than 10% of clusters are empty: 2 of 16.
    Help: this could mean your dataset is too small to have a meaningful index (2507 < 4096) or has many duplicate vectors.
```

**Cause:** This is informational and **benign**. It is emitted by LanceDB's own
Rust logger (not OpenCodeRAG's, so it can't be routed to the plugin log) once
per KMeans training pass during the single IVF index build at the end of a
first-time index. Lance itself considers a store under 4096 rows too small for
a meaningful IVF index — a few of the 16 base partitions end up empty, tripping
its >10%-empty threshold.

**Fix:** none needed — the store is healthy. Verify with `opencode-rag status`
(dimension match, manifest ok, pending files) and a `opencode-rag query`.
Since this was diagnosed, the index repair path skips IVF creation entirely
below `MIN_ROWS_FOR_IVF_INDEX` (4096 rows) and leaves the store on brute-force
flat search, which is optimal at that size — so a fresh index of a small
workspace no longer builds the index and no longer warns. An existing store
that already built an index keeps it (a healthy cosine index is never rebuilt).

Do **not** confuse this with the harmful variant below: constant repetition
plus a growing pile of `rag_db/chunks.lance/_indices/<uuid>` directories and an
explicit `index build did not register` message means the store cannot
converge and must be deleted and re-indexed.

## "partition N is empty, skipping" Warnings

**Symptom:** LanceDB's native logger repeatedly prints
`WARN: [... lance::index::vector::builder] partition N is empty, skipping`
to the terminal while OpenCode is running.

**Cause:** The warning is emitted during IVF index training (KMeans) when the
training sample contains duplicate or degenerate vectors. One or two per index
build are benign — e.g. the index built at the end of a full rebuild. Constant
repetition means the ANN index is being **retrained over and over** because
its commit never registers in the store (typically a store corrupted by
version-manifest accumulation). Each retry leaves a new directory under
`rag_db/chunks.lance/_indices/` and re-trains KMeans, spamming the warning.

**Fix:**
1. If the store is otherwise healthy, the accumulation is harmless and
   self-limiting: `optimize()` prunes old index-version files (leaving empty
   husks that are swept automatically) and the repair only ever builds one
   index. No action needed.
2. If you see the explicit `index build did not register (store cannot
   converge)` message, delete or rename `rag_db` and re-index:
   ```bash
   # while no OpenCode session is using the workspace
   mv .opencode/rag_db .opencode/rag_db.broken   # or: rmdir /s /q .opencode\rag_db
   opencode-rag index
   ```
3. If warnings still repeat after a clean re-index, check
   `opencode-rag status` and the plugin log for `[lancedb]` messages.

**Built-in protection:** since this was diagnosed, the index repair path
(`repairIndexMetricOnce` in `src/vectorstore/lancedb.ts`) has three guards:
- it only counts index-version directories that still carry files — the empty
  directories Lance leaves behind after pruning a version are harmless husks
  and never trip the guard (and `optimize()` sweeps them away),
- it verifies after a successful `createIndex` that the index actually
  registered (`indexStats` reports it) — a store whose index commits never
  register is detected immediately instead of being retrained forever, and
- it gives up after 3 failed repair attempts per process and skips index
  creation on the temporary store during full rebuilds (the index is built
  exactly once on the final store).

If you still get the "cannot converge" message, the store is genuinely broken
(no index build ever registers) and must be rebuilt — nothing else works.

## Embedding Dimension Mismatch

**Symptoms:**
- `GenericFailure, Invalid input, No vector column found to match with the query vector dimension: 1024`
  (the number is whatever the current embedder produces)
- Search returns nothing while the log reports chunks were "stored"
- `opencode-rag status` shows a `Dimension mismatch: yes` line (store dimension vs. embedder dimension)

**Cause:** the vector store was built with a different embedding model than the
one currently configured (e.g. you switched from `qwen3-embedding:4b`, 2560-dim,
to a 1024-dim model). LanceDB fixes the vector column length at table creation.
Mismatched **writes do not fail** — Lance silently zero-pads or truncates the
vectors into the fixed-size column, so rows become unreachable garbage. Mismatched
**queries** fail with the cryptic error above.

**Built-in protection:**
- `LanceDbStore` validates every write against the table's real schema dimension
  and throws `DimensionMismatchError` instead of silently padding.
- Search compares the query vector against the table's schema dimension (not the
  handle's expected dimension) and returns empty with an actionable warning.
- `runIndexPass` treats a schema mismatch as a rebuild condition: the manifest is
  cleared and the index is rebuilt atomically into `rag_db_tmp` at the configured
  dimension (works for `opencode-rag index`, `--force`, and the auto-index watcher).
- Full rebuilds preserve `quirks.jsonl`, `.desc-cache.json`, `keyword-index.json`,
  `runtime-overrides.json` and `eval-sessions/` when swapping directories.

**Fix:** make the config match the model actually being served, then rebuild:

```bash
opencode-rag status          # check "Store dimension" vs "Embedder dim"
opencode-rag index           # auto-rebuilds on dimension drift
```

If a provider outage caused a wrong-dimension store (e.g. the CLI used to fall
back to 384), the next successful `index` run now rebuilds it automatically. To
pin the dimension explicitly, set `embedding.vectorDimension` in the config.



## Description Generation Failures

If the LLM description provider is unavailable or times out, affected files are automatically flagged in the manifest with `descriptionFailed: true`. On the next `opencode-rag index` run, these files are fully re-indexed (re-chunked and re-described) without requiring `--force`.

**Symptoms:**
- Logs show `Description generation failed for <chunkId>` warnings
- `opencode-rag status` shows `descriptionFailedFiles > 0`

**Fix:**
1. Ensure the description provider is running (e.g., `ollama serve`)
2. Run `opencode-rag index` — flagged files will be retried automatically
3. If the issue persists, check `description.timeoutMs` and `description.retryMax` in your config

## Debugging Plugin Loading

```bash
# Test dynamic import (V2 shape: default must expose id + setup)
node --input-type=module -e \
  "const m = await import('opencode-rag-plugin'); console.log(typeof m.default?.setup)"

# Test require (CommonJS fallback)
node -e \
  "const m = require('opencode-rag-plugin'); console.log(typeof m.default?.setup)"

# TUI module: must expose id + setup
node --input-type=module -e \
  "const m = await import('./.opencode/plugins/opencode-rag/tui.js'); console.log(Object.keys(m.default), typeof m.default.setup)"
```

Plugin load failures are logged to `~/.local/share/opencode/log/opencode.log`:

```bash
grep -a "failed to load plugin" ~/.local/share/opencode/log/opencode.log | tail -5
```

Read the `cause=` field of the matching `ref=err_…` entry — it is the original error.

## Proxy Debugging

Test whether proxy configuration is working:
```bash
# Check if HTTP_PROXY env var is set
echo $HTTP_PROXY

# Check if proxy auth header is correctly formed
# The buildProxyAuthHeader() in http.ts Base64-encodes username:password
echo -n "user:pass" | base64
```

## Watch Mode Debugging

The watcher writes status to `watcher-status.json` in the store path:
```bash
cat .opencode/rag_db/watcher-status.json
```

This shows `running` status and `lastRunAt` timestamp for the background indexer.
