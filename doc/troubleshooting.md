# Troubleshooting

## Common Issues

### "Plugin export is not a function" in OpenCode

**Cause:** OpenCode tries to load the plugin via the `"plugin"` key in config, triggering module resolution differences in Bun vs Node.js.

**Fix:**
1. Do NOT register via `"plugin": ["opencode-rag-plugin"]` in OpenCode config
2. Rely on `.opencode/plugins/*.js` auto-discovery instead
3. Run `opencode-rag init` to regenerate workspace-local plugin files
4. Remove stale `"plugin"` entries from all OpenCode config files

**Verify:**
```bash
node --input-type=module -e \
  "const m = await import('opencode-rag-plugin'); console.log(typeof m.default?.setup, typeof m.default?.server)"
```

Both should be `function`.

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
   `id` and `setup` (server plugin) or `id`, `setup`, and `tui` (TUI plugin)
3. If the TUI plugin still fails with `Environment variable "OPENTUI_FORCE_WCWIDTH" is
   already registered with different configuration`, keep the env-registry normalization
   shim in `.opencode/plugins/rag-tui.js` (it must run after the `dist/tui.js` import)

### No Context Returned by OpenCode

**Possible causes:**
1. Workspace not indexed yet — run `opencode-rag index`
2. Embedding call failing — check if the raw socket path is being used correctly (see proxy section)
3. No matching code found — refine your query or run `opencode-rag index` to (re)index the workspace
4. Index is stale — run `opencode-rag index --force` for a full rebuild

### Embedding Timeouts

**Symptom:** Indexing fails with `Global embedding failed: Request timed out after Nms`. All files show as "Removed".

**Cause:** The embedding provider (typically Ollama running a local model) takes longer than the configured timeout to process a batch of texts.

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

### "oldString not found in content" on ReadMe Edits

The ReadMe is generated and edited by the workflow manager. If you're editing files manually, use the Read tool first to ensure you have the current content.

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
  "const m = await import('opencode-rag-plugin'); console.log(typeof m.default?.setup, typeof m.default?.server)"

# Test require (CommonJS fallback)
node -e \
  "const m = require('opencode-rag-plugin'); console.log(typeof m.default?.setup, typeof m.default?.server)"

# TUI module: must expose id, setup, and tui
node --input-type=module -e \
  "const m = await import('./.opencode/plugins/rag-tui.js'); console.log(Object.keys(m.default), typeof m.default.setup)"
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
