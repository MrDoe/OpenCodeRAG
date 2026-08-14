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
  "const m = await import('opencode-rag-plugin'); console.log(typeof m.default, typeof m.server)"
```

Both should be `"function"`.

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
# Test dynamic import
node --input-type=module -e \
  "const m = await import('opencode-rag-plugin'); console.log(typeof m.default, typeof m.server)"

# Test require (CommonJS fallback)
node -e \
  "const m = require('opencode-rag-plugin'); console.log(typeof m.default, typeof m.server)"
```

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
