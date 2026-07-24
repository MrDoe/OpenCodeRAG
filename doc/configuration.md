# Configuration

Configuration is defined in `opencode-rag.json` (created by `opencode-rag init`). You only need to define values you want to override — missing sections inherit from `DEFAULT_CONFIG`.

## Configuration Layering

```
1. DEFAULT_CONFIG (hardcoded defaults)
2. opencode-rag.json (user overrides, deep-merged per section)
3. runtime-overrides.json (live TUI changes, overrides everything)
```

Runtime overrides are reloaded on a 5-second TTL. See [Architecture](architecture.md#configuration-layering).

## Full Configuration Reference

### `embedding`

Controls how code chunks are converted to vector embeddings.

```json
{
  "embedding": {
    "provider": "ollama",
    "baseUrl": "http://localhost:11434/api",
    "apiKey": null,
    "model": "qwen2.5:3b:latest",
    "timeoutMs": 30000,
    "proxy": {
      "url": "http://proxy.example.com:8080",
      "username": "user",
      "password": "pass",
      "noProxy": "localhost,127.0.0.1,.local"
    },
    "documentPrefix": "search_document: ",
    "queryPrefix": "search_query: "
  }
}
```

| Option | Default | Description |
|---|---|---|
| `provider` | `"ollama"` | `"ollama"`, `"openai"`, or `"cohere"` |
| `baseUrl` | `http://127.0.0.1:11434/api` | API endpoint |
| `apiKey` | `null` | API key (auto-resolved from OpenCode provider config for OpenAI) |
| `model` | `"qwen2.5:3b:latest"` | Model name |
| `timeoutMs` | `30000` | Request timeout (increase for cold starts) |
| `proxy.url` | — | Proxy URL (env vars take precedence) - only needed when need to connect to an external provider behind a firewall /corporatre network |
| `proxy.username` | — | Proxy auth username |
| `proxy.password` | — | Proxy auth password |
| `proxy.noProxy` | — | Comma-separated bypass list |
| `documentPrefix` | — | Prepended to document text before embedding (e.g., `search_document:`) |
| `queryPrefix` | — | Prepended to query text before embedding (e.g., `search_query:`) |

See [Embedding](embedding.md) for model recommendations and proxy details.

### `indexing`

Controls file discovery and chunking behavior.

```json
{
  "indexing": {
    "includeExtensions": [
      ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
      ".py", ".java", ".go", ".md", ".mdx",
      ".c", ".h", ".cpp", ".hpp",
      ".cs", ".razor", ".cshtml",
      ".json", ".html", ".css", ".xml", ".sln",
      ".rs", ".rb", ".kt", ".kts", ".swift",
      ".tex", ".pdf", ".docx", ".doc", ".xls", ".xlsx"
    ],
    "excludeDirs": [
      "node_modules", ".git", ".opencode", "dist", "build",
      "__pycache__", ".venv"
    ],
    "chunkOverlap": 0,
    "minFileSizeBytes": 0,
    "concurrency": 4,
    "embedBatchSize": 100,
    "embedConcurrency": 3,
    "descriptionConcurrency": 4
  }
}
```

| Option | Default | Description |
|---|---|---|
| `includeExtensions` | *(40+ extensions)* | File extensions to index |
| `excludeDirs` | *(7 dirs)* | Directories to skip |
| `chunkOverlap` | `0` | Overlap between adjacent chunks |
| `minFileSizeBytes` | `0` | Skip files smaller than this (files below threshold are also removed from index) |
| `concurrency` | `4` | Max files processed in parallel during indexing. Higher values speed up indexing but increase memory and embedding API pressure |
| `embedBatchSize` | `100` | Texts per embedding API call. Larger batches reduce round-trips. Ollama supports up to ~100 |
| `embedConcurrency` | `3` | Number of embedding batch requests sent in parallel. Higher values speed up embedding but increase API pressure |
| `descriptionConcurrency` | `4` | Number of files processed in parallel during description generation. Higher values speed up descriptions but increase LLM pressure |

### `vectorStore`

```json
{
  "vectorStore": {
    "path": "./.opencode/rag_db"
  }
}
```

| Option | Default | Description |
|---|---|---|
| `path` | `"./.opencode/rag_db"` | Path to the LanceDB database directory |

### `retrieval`

Controls how queries are matched against the index.

```json
{
  "retrieval": {
    "topK": 10,
    "minScore": 0.35,
    "hybridSearch": {
      "enabled": true,
      "keywordWeight": 0.4
    },
    "contextOptimization": {
      "enabled": true,
      "maxPerFile": 3,
      "mergeAdjacent": true,
      "adjacentGapThreshold": 5,
      "similarityThreshold": 0.8
    }
  }
}
```

| Option | Default | Description |
|---|---|---|
| `topK` | `10` | Default number of chunks fetched per query |
| `minScore` | `0.35` | Minimum relevance score (0–1) |
| `hybridSearch.enabled` | `true` | Enable combined TF×IDF + vector search |
| `hybridSearch.keywordWeight` | `0.4` | Keyword weight in RRF fusion: `vContrib = (1-kw)×(K+1)/(K+vRank+1)` |
| `contextOptimization.enabled` | `true` | Enable post-retrieval optimization pipeline |
| `contextOptimization.maxPerFile` | `3` | Max chunks per file in final result (0 = unlimited) |
| `contextOptimization.mergeAdjacent` | `true` | Merge consecutive same-file chunks separated by ≤ gap |
| `contextOptimization.adjacentGapThreshold` | `5` | Max line gap for adjacent merge (lines between end and next start) |
| `contextOptimization.similarityThreshold` | `0.8` | Jaccard similarity threshold (0–1) for same-file dedup |

### `description`

Controls LLM-based description generation for code chunks.

```json
{
  "description": {
    "enabled": true,
    "provider": "ollama",
    "baseUrl": "http://localhost:11434/api",
    "apiKey": null,
    "model": "qwen2.5:3b",
    "timeoutMs": 60000,
    "systemPrompt": "Describe code for embedding search in caveman style...",
    "batchMaxChunks": 25,
    "batchTimeoutMs": 120000,
    "batchConcurrency": 3,
    "retryMax": 3,
    "retryBaseDelayMs": 1000
  }
}
```

| Option | Default | Description |
|---|---|---|
| `enabled` | `true` | Enable description-based embedding. Disable to embed raw code. |
| `provider` | `"ollama"` | LLM provider (`"ollama"`, `"openai"`, `"anthropic"`, `"gemini"`) |
| `model` | `"qwen2.5:3b"` | Model for description generation |
| `systemPrompt` | *(see above)* | Customizable prompt for the LLM |
| `timeoutMs` | `60000` | Timeout per LLM call |
| `batchMaxChunks` | `25` | Maximum chunks per batch description call |
| `batchTimeoutMs` | `120000` | Timeout for batch description calls |
| `batchConcurrency` | `3` | Number of LLM batch description requests sent in parallel. Higher values speed up description generation but increase LLM pressure |
| `retryMax` | `3` | Retry attempts on failure |
| `retryBaseDelayMs` | `1000` | Base delay for exponential backoff |
| `maxContentChars` | `4000` | Maximum content characters sent to the LLM. Chunks exceeding this limit receive fallback descriptions (line range + language) instead of LLM-generated descriptions. Prevents timeouts on large/minified files. |

When enabled, the embedded text is `filePath + "\n\n" + description + "\n\n" + code content`. Even when disabled, descriptions include the line range and language (e.g., `lines 10-42, typescript`). On LLM failure, falls back to embedding filePath + raw content. Files where description generation failed are flagged in the manifest (`descriptionFailed: true`) and automatically retried on the next `opencode-rag index` run.

> **Recommendation:** Disable (`description.enabled: false`) if you don't have a dedicated GPU or want faster indexing.

### `imageDescription`

Controls image-to-text description generation via vision-capable LLMs. Disabled by default; enable to make image files searchable.

```json
{
  "imageDescription": {
    "enabled": false,
    "provider": "ollama",
    "baseUrl": "http://127.0.0.1:11434/api",
    "apiKey": null,
    "model": "minicpm-v4.6",
    "timeoutMs": 60000,
    "proxy": {
      "url": null,
      "username": null,
      "password": null,
      "noProxy": "localhost,127.0.0.1,.local"
    },
    "prompt": "Describe this image in detail for a codebase search index.",
    "concurrency": 2,
    "maxImageBytes": 10485760
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `false` | Enable image description indexing |
| `provider` | `"ollama"` | Vision provider: `"ollama"`, `"openai"`, `"anthropic"`, `"gemini"` |
| `baseUrl` | `http://127.0.0.1:11434/api` | Provider API endpoint |
| `apiKey` | `null` | API key; auto-resolved from OpenCode provider config for OpenAI/Anthropic/Gemini |
| `model` | `"minicpm-v4.6"` | Vision model name |
| `timeoutMs` | `60000` | Request timeout (vision calls can be slower) |
| `proxy` | — | Proxy settings (same shape as `embedding.proxy`) |
| `prompt` | `"Describe this image..."` | System prompt sent to the vision model |
| `concurrency` | `2` | Number of parallel description requests during indexing |
| `maxImageBytes` | `10485760` | Skip images larger than this (bytes) |

**Notes:**

- Supported raster image extensions: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`. SVG is handled by the XML chunker, not the vision pipeline.
- Descriptions are embedded using the standard embedding provider and stored as vector chunks. Re-index after enabling or changing vision settings.

### `openCode`

Controls the OpenCode plugin integration.

```json
{
  "openCode": {
    "enabled": true,
    "maxContextChunks": 10,
    "readOverride": true,
    "readNoResultsBehavior": "hint",
    "maxReadOutputChars": 50000,
    "readRelatedFilesMax": 5,
    "autoIndex": {
      "enabled": false,
      "debounceMs": 2000,
      "intervalMs": 300000,
      "watcher": "chokidar"
    }
  }
}
```

| Option | Default | Description |
|---|---|---|
| `enabled` | `true` | Enable the plugin |
| `maxContextChunks` | `10` | Max chunks passed to context tool |
| `readOverride` | `true` | Override OpenCode's built-in read to append RAG context |
| `maxReadOutputChars` | `50000` | Max characters for read output |
| `readRelatedFilesMax` | `5` | Max related file suggestions per read |
| `autoIndex.enabled` | `false` | Auto-index changed files in background |
| `autoIndex.debounceMs` | `2000` | Debounce delay for file change events |
| `autoIndex.intervalMs` | `300000` | Periodic full-index interval, only used by git backend (ignored with chokidar) |
| `autoIndex.watcher` | `"chokidar"` | File-change detection backend: `"chokidar"` (real-time FS events) or `"git"` (poll-based diff) |
| `readNoResultsBehavior` | `"hint"` | Behavior when read returns no results: `"hint"` (suggest related files), `"empty"`, or `"error"` |
| `injectSystemPrompt` | `true` | Inject RAG tool guidance into the system prompt (disable to save tokens once agents know the tools) |

### `documentationMode`

Controls the automated documentation mode that drives the agent to add JSDoc/TSDoc comments to undocumented source files via the `/doc` slash command. Disabled by default. No agent tools are registered — documentation is driven entirely through the slash command and the injected system prompt.

```json
{
  "documentationMode": {
    "enabled": false,
    "autoStart": true,
    "batchSize": 5,
    "systemPrompt": "You are a code documentation expert..."
  }
}
```

| Option | Default | Description |
|---|---|---|
| `enabled` | `false` | Enable the `/doc` slash command and documentation system prompt |
| `autoStart` | `true` | Start documentation mode automatically on launch |
| `batchSize` | `5` | Number of files to process per batch |
| `systemPrompt` | *(built-in)* | System prompt for the documentation agent. Explains how to document public symbols, preserve existing comments, and avoid restating the obvious. |

Progress is persisted in `.opencode/rag_db/doc-mode-progress.json` so subsequent sessions resume where you left off. See [Plugin documentation](plugin.md#5-documentation-mode--slash-command-doc).

### `wikiMode`

Controls the wiki mode that instructs the AI agent to build and maintain a persistent knowledge wiki at `.opencode/wiki/`. Disabled by default. No agent tools are registered — wiki maintenance is driven entirely through the injected system prompt and the `/wiki` slash command.

```json
{
  "wikiMode": {
    "enabled": false,
    "systemPrompt": "You are a wiki maintainer for this codebase..."
  }
}
```

| Option | Default | Description |
|---|---|---|
| `enabled` | `false` | Enable the `/wiki` slash command and wiki maintainer system prompt |
| `systemPrompt` | *(built-in)* | System prompt defining the wiki layout, frontmatter conventions, and the Ingest/Query/Lint/Seed operations |

The built-in system prompt defines the wiki layout (`.opencode/wiki/index.md`, `log.md`, `entities/`, `concepts/`, `sources/`), page frontmatter (`title`, `tags`, `sourceRefs`, `lastReviewed`), and cross-references via `[[wiki/page-name]]` links. See [Plugin documentation](plugin.md#6-wiki-mode--slash-command-wiki).

### `memory`

Controls the quirk/experiential memory system — persistent storage of gotchas, preferences, decisions, and environment constraints that are recalled across sessions. Quirks are embedded and stored in the vector store alongside code chunks, then recalled via semantic search.

```json
{
  "memory": {
    "enabled": true,
    "autoInject": true,
    "minConfidence": 0.5,
    "recallMinScore": 0.3,
    "decay": {
      "enabled": true,
      "halfLifeDays": 30
    }
  }
}
```

| Option | Default | Description |
|---|---|---|
| `enabled` | `true` | Enable quirk memory. When `false`, the `add_quirk` / `recall_quirks` tools are inert and quirks are not recalled. |
| `autoInject` | `true` | Auto-inject relevant quirks into the prompt during retrieval (via the `chat.message` hook). |
| `minConfidence` | `0.5` | Minimum confidence (0–1) for a quirk to be returned by recall. |
| `recallMinScore` | `0.3` | Minimum query-relevance score (0–1) for a quirk to be recalled. |
| `decay.enabled` | `true` | Enable confidence decay over time for aging quirks. |
| `decay.halfLifeDays` | `30` | Number of days after which a quirk's confidence halves (only when decay is enabled). |
| `passiveCapture` | `false` | Automatically extract quirks from each completed agent turn by running the description LLM on the exchange text (error signals only). Requires `description.enabled`. |
| `promptEnforcement` | `true` | Upgrade the system-prompt quirk nudge into a mandatory trigger with explicit rules (build/test/type errors fixed, undocumented constraints discovered, etc.). |
| `sessionEndExtraction` | `true` | Summarize the full session transcript into quirks on session end (via event hook). Requires `description.enabled`. |
| `autoCaptureMaxPerTurn` | `2` | Maximum number of quirks to auto-capture per turn or session-end pass. |
| `autoCaptureDedupThreshold` | `0.85` | Lexical similarity threshold (0–1) above which a candidate quirk is considered a duplicate of an existing quirk and skipped. |

Quirks can also be managed from the CLI — see [CLI Reference: `quirk`](cli.md#quirk). Every `addQuirk` call is vetted by an immutable trust monitor (`src/quirks/monitor.ts`) that rejects content matching blocked destructive patterns (e.g. `rm -rf`, `force push`, `bypass security`). Auto-captured quirks pass through the same trust boundary before storage.

### `mcp`

Controls the standalone MCP (Model Context Protocol) server.

```json
{
  "mcp": {
    "enabled": false
  }
}
```

| Option | Default | Description |
|---|---|---|
| `enabled` | `false` | Auto-start the standalone MCP server on plugin load. Agent tools (`search_semantic`, `get_file_skeleton`, `find_usages`, `describe_image`) and the `chat.message` hook run in-process regardless. Set to `true` only when an external MCP client needs to connect via `opencode-rag mcp`. |

See the [MCP Server](../ReadMe.md#mcp-server) section in the README and [CLI Reference](cli.md#mcp).

### `ui`

Controls the web dashboard UI server.

```json
{
  "ui": {
    "port": 3210,
    "openBrowser": true
  }
}
```

| Option | Default | Description |
|---|---|---|
| `port` | `3210` | HTTP port for the UI server |
| `openBrowser` | `true` | Automatically open the browser on startup |

Launch with `opencode-rag ui`. See [Web UI documentation](webui.md).

### `tui`

Controls the terminal UI (TUI) keybindings for RAG context injection.

```json
{
  "tui": {
    "fileListKeybinding": "ctrl+enter",
    "chunksKeybinding": "ctrl+alt+enter"
  }
}
```

| Option | Default | Description |
|---|---|---|
| `fileListKeybinding` | `"ctrl+enter"` | Hotkey to append a relevant file list to the prompt |
| `chunksKeybinding` | `"ctrl+alt+enter"` | Hotkey to append full code chunks to the prompt |

Both keybindings read the current prompt text combined with the previous assistant response (if any) as the search query. Configurable in the TUI settings menu under "Keybindings" (open with `Ctrl+Shift+R`).

### `autoUpdate`

Controls automatic update checking for OpenCodeRAG. When enabled, the plugin
checks GitHub for a newer release on startup and, if one is found, asks the
agent to inform you and offer to install it via `opencode-rag update`.

```json
{
  "autoUpdate": {
    "enabled": true,
    "autoInstall": false,
    "cooldownMs": 3600000,
    "maxConsecutiveFailures": 3
  }
}
```

| Option | Default | Description |
|---|---|---|
| `enabled` | `true` | Check for updates on plugin startup and prompt to install |
| `autoInstall` | `false` | Automatically install the update in the background instead of asking. When true, the plugin runs `npm install -g` and re-syncs the runtime on startup without prompting. A one-time "restart needed" notice is added to the system prompt. |
| `cooldownMs` | `3600000` | Minimum time (ms) between auto-install attempts for the same version. Prevents re-installing on every plugin reload. |
| `maxConsecutiveFailures` | `3` | Back off after this many consecutive auto-install failures within the cooldown window. Reset on success. |

When `autoInstall` is `false` (default), the plugin checks GitHub Releases API for new versions on startup. If an update is available, a notification is added to the system prompt. You can then run `npm update -g opencode-rag-plugin && opencode-rag setup` to install the update.

When `autoInstall` is `true`, the install runs silently in the background on startup. A cooldown file (`.auto-update-state.json`) in the store path prevents redundant attempts. After a successful install, a one-time "restart needed" prompt is added to the system transform hook.

### `logging`

```json
{
  "logging": {
    "level": "info",
    "logFilePath": "./.opencode/opencode-rag.log"
  }
}
```

| Option | Default | Description |
|---|---|---|
| `level` | `"info"` | `"debug"`, `"info"`, `"error"`, or `"none"` |
| `logFilePath` | `"./.opencode/opencode-rag.log"` | Path to log file |

### `chunking`

Overrides which AST node types are chunked per language. By default, chunkers use function-level node types. Use this to broaden or narrow chunking granularity.

```json
{
  "chunking": {
    "nodeTypes": {
      "typescript": ["function_declaration", "method_definition", "class_declaration", "arrow_function"],
      "python": ["function_definition", "decorated_definition", "class_definition"]
    }
  }
}
```

| Field | Type | Description |
|---|---|---|
| `nodeTypes` | `Record<string, string[]>` | Map of language name to AST node types to chunk on |

See [chunking.md](chunking.md) for the full strategy and per-language node type details.

### Custom Chunkers

External chunkers can be injected without modifying the source:

```json
{
  "chunkers": [
    { "module": "./path/to/my-chunker.js", "extensions": [".xyz"] }
  ]
}
```

## Config File Discovery

The CLI and plugin auto-detect the config file in this order:
1. `--config <path>` CLI argument
2. `./opencode-rag.json` (project root)
3. `./.opencode/rag.json`

## API Key Auto-Resolution

If `embedding.provider` or `description.provider` is `"openai"` but no `apiKey` is set in `opencode-rag.json`, the plugin auto-resolves the key from OpenCode's own provider configuration:
- `.opencode/opencode.json`
- `opencode.json`
- `~/.config/opencode/opencode.jsonc`

JSONC comments are stripped before parsing.
