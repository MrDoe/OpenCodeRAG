# CLI Reference

The CLI interface (`opencode-rag`) provides full access to build, manage, and search your project's vector database. It's primarily intended for testing, debugging, and scripting, but works independently of OpenCode.

## Global Options

| Flag | Description |
|---|---|
| `-c, --config <path>` | Path to config file |
| `-h, --help` | Show help |

## Commands

### `init`

Configure the current workspace for OpenCodeRAG.

```bash
opencode-rag init [options]
```

**Options:**
| Flag | Default | Description |
|---|---|---|
| `-f, --force` | `false` | Overwrite existing files (except `opencode-rag.json`, which requires interactive confirmation) |
| `--skip-install` | `false` | Skip npm install step |
| `--skip-health-check` | `false` | Skip provider connectivity and model availability check |

**Creates:**
- `.opencode/` directory structure
- `.opencode/plugins/rag-plugin.js` — workspace-local plugin fallback
- `.opencode/plugins/rag-tui.js` — TUI plugin module
- `.opencode/opencode.json` — OpenCode workspace config
- `.opencode/tui.json` — TUI plugin settings
- `.opencode/package.json` — workspace dependencies
- `opencode-rag.json` — runtime configuration
- `.opencode/.gitignore` — ignores `node_modules/` and `rag_db/`
- `.opencode/skills/opencode-rag/SKILL.md` — AI agent skill file
- `AGENTS.md` — always-loaded tool-usage directive (merged into existing content via sentinel markers; includes mandatory tool guidance, decision tree, proactive triggers, anti-patterns, and conditional quirk-capture rules)
- Runs `npm install` to install workspace dependencies

**Config protection:**
If `opencode-rag.json` already exists, it is **never overwritten without interactive `y/N` confirmation** — not even with `--force`. Non-interactive shells (pipes, CI) skip the overwrite automatically. To reset the config, run `init` in a TTY and type `y` when prompted, or edit the file manually.

**Backend auto-tuning:**
When generating a new `opencode-rag.json`, `init` probes Ollama (`GET /api/ps`) and tunes the embedding batch settings for the detected backend:
- **GPU** (any loaded model has `size_vram > 0`): `embedBatchSize: 40`, `embedConcurrency: 4`, `ollamaMaxBatchSize: 40`
- **CPU**: `embedBatchSize: 20`, `embedConcurrency: 1`, `ollamaMaxBatchSize: 20`
- **Ollama unreachable / undetermined**: default values (100 / 3 / 100)

If nothing is loaded yet, a minimal embed request loads the default embedding model first. The detection is best-effort and never fails `init`.

**Health check:**
After writing config files, `init` validates provider connectivity and model availability for all configured models (embedding + description + image description if enabled). For Ollama, if models are missing, you're prompted to pull them automatically. Use `--skip-health-check` to bypass (e.g., for offline environments).

### `index`

Index workspace files into the vector database.

```bash
opencode-rag index [options]
```

**Options:**
| Flag | Default | Description |
|---|---|---|
| `-f, --force` | `false` | Force full rebuild (clears existing index) |
| `-w, --watch` | `false` | Watch for file changes and re-index automatically |
| `-c, --config <path>` | auto-detected | Path to config file |

**How it works:**
1. Scans workspace files matching `indexing.includeExtensions`
2. Compares file hashes against the manifest
3. Clears any files previously flagged with `descriptionFailed` so they are fully re-indexed
4. Chunks changed/new files via the appropriate chunker
5. Generates descriptions (if enabled) and embeddings
6. Stores vectors in LanceDB and tokens in KeywordIndex
7. Serializes manifest and keyword index

**Incremental:** Only changed files are reprocessed. Unchanged files are skipped. Files with `descriptionFailed` in the manifest are automatically retried.

**Full rebuild (`--force`):** Clears the store, clears keyword index, and re-indexes everything.

**Watch mode (`--watch`):** Uses chokidar to monitor file changes. Re-indexes debounced changes automatically.

### `query`

Search the indexed codebase.

```bash
opencode-rag query <query> [options]
```

**Options:**
| Flag | Default | Description |
|---|---|---|
| `-c, --config <path>` | auto-detected | Path to config file |
| `-s, --system-prompt <text>` | none | Optional system prompt steering the description toward specific features |

**Output:** Formatted results showing:
- File path (relative)
- Relevance score
- Language
- Line range
- Chunk description
- Content preview

### `status`

Show index statistics and health.

```bash
opencode-rag status [options]
```

**Options:**
| Flag | Default | Description |
|---|---|---|
| `-c, --config <path>` | auto-detected | Path to config file |

**Shows:**
- Total chunk count
- Store path
- Embedding provider and model
- Number of indexed extensions
- Manifest status (ok/missing/corrupt)
- Last indexed timestamp
- Up-to-date files vs. pending files
- Keyword index chunk count

### `list`

List all indexed files with chunk counts.

```bash
opencode-rag list [options]
```

**Options:**
| Flag | Default | Description |
|---|---|---|
| `-c, --config <path>` | auto-detected | Path to config file |

**Output:** Each indexed file with its chunk count, sorted by file path.

### `show`

Show all chunks for a specific file.

```bash
opencode-rag show <file> [options]
```

**Options:**
| Flag | Default | Description |
|---|---|---|
| `-c, --config <path>` | auto-detected | Path to config file |

**Output:** All chunks for the given file path, including:
- Chunk ID
- Line range
- Description
- Content preview

### `dump`

Dump all indexed chunks (paginated).

```bash
opencode-rag dump [options]
```

**Options:**
| Flag | Default | Description |
|---|---|---|
| `--offset <number>` | `0` | Starting offset |
| `--limit <number>` | `100` | Max chunks to dump |
| `-c, --config <path>` | auto-detected | Path to config file |

### `clear`

Clear all indexed data.

```bash
opencode-rag clear [options]
```

**Options:**
| Flag | Default | Description |
|---|---|---|
| `-c, --config <path>` | auto-detected | Path to config file |

Uses `store.dropDatabase()` for a clean slate, also clears the keyword index and manifest.

### `describe-image`

Describe an image file using the configured vision model. Useful for testing image description settings without running a full index pass.

```bash
opencode-rag describe-image <filePath> [options]
```

**Options:**
| Flag | Default | Description |
|---|---|---|
| `-c, --config <path>` | auto-detected | Path to config file |

**Requirements:** `imageDescription.enabled` must be `true` in config. The image is resized (per `resizeMaxDimension`), base64-encoded, and sent to the configured vision provider, which returns a natural-language description.

### `ui`

Start the web dashboard UI for exploring the indexed vector database.

```bash
opencode-rag ui [options]
```

**Options:**
| Flag | Default | Description |
|---|---|---|
| `-c, --config <path>` | auto-detected | Path to config file |

Launches a local HTTP server (default port `3210`, configurable via `ui.port`). Opens the browser automatically unless `ui.openBrowser` is `false`. See [Web UI documentation](webui.md).

### `mcp`

Start the MCP (Model Context Protocol) server over stdio, exposing semantic code tools to any MCP-compatible client.

```bash
opencode-rag mcp [options]
```

**Options:**
| Flag | Default | Description |
|---|---|---|
| `-c, --config <path>` | auto-detected | Path to config file |

Exposes `search_semantic`, `get_file_skeleton`, `find_usages`, and `describe_image` tools. Clients can configure the server manually, or `opencode-rag init` auto-registers it. The plugin auto-starts the MCP server only when `mcp.enabled` is `true` (default: `false`). Running `opencode-rag mcp` manually always starts the server regardless of `mcp.enabled`. See the [MCP Server](../ReadMe.md#mcp-server) section in the README.

### `quirk`

Manage experiential quirk memory — gotchas, preferences, decisions, and environment constraints.

```bash
opencode-rag quirk <subcommand> [options]
```

**Subcommands:**

| Subcommand | Description |
|---|---|
| `add` | Add a new quirk |
| `list` | List all quirks |
| `update` | Update a quirk by ID (content, type, tags, confidence, source ref) |
| `rm` | Remove a quirk by ID |
| `lint` | Health-check quirks (low confidence, stale, duplicates) |
| `test` | Test whether a quirk with similar content already exists |

#### `quirk add`

```bash
opencode-rag quirk add <content> [options]
```

**Arguments:**
| Arg | Description |
|---|---|
| `<content>` | Quirk text |

**Options:**
| Flag | Description |
|---|---|
| `-t, --type <type>` | Quirk type: gotcha, preference, decision, environment-constraint |
| `--tag <tags...>` | Tags for filtering |
| `--source-ref <path>` | Source file path reference |

#### `quirk list`

```bash
opencode-rag quirk list [options]
```

**Options:**
| Flag | Default | Description |
|---|---|---|
| `-c, --config <path>` | auto-detected | Path to config file |

#### `quirk update`

```bash
opencode-rag quirk update <id> [options]
```

Update an existing quirk by ID. When `--content` changes, the new text must pass the trust monitor, the quirk is re-embedded, and the vector-store chunk + keyword index entry are replaced under the same ID. At least one update option is required.

**Arguments:**
| Arg | Description |
|---|---|
| `<id>` | Quirk ID to update (shown in `quirk list` and `recall_quirks` output) |

**Options:**
| Flag | Description |
|---|---|
| `--content <text>` | Replacement quirk text |
| `-t, --type <type>` | Quirk type: gotcha, preference, decision, environment-constraint |
| `--tag <tags...>` | Replacement tags for filtering |
| `--confidence <0-1>` | Replacement confidence value |
| `--source-ref <path>` | Source file path reference |
| `-c, --config <path>` | Path to config file (default: auto-detected) |

#### `quirk rm`

```bash
opencode-rag quirk rm <id> [options]
```

**Arguments:**
| Arg | Description |
|---|---|
| `<id>` | Quirk ID to remove |

**Options:**
| Flag | Default | Description |
|---|---|---|
| `-c, --config <path>` | auto-detected | Path to config file |

#### `quirk lint`

```bash
opencode-rag quirk lint [options]
```

**Options:**
| Flag | Default | Description |
|---|---|---|
| `-c, --config <path>` | auto-detected | Path to config file |

#### `quirk test`

Test whether a quirk with similar content already exists. Uses semantic search to find matching quirks and reports whether one has been appended before.

```bash
opencode-rag quirk test <content> [options]
```

**Arguments:**
| Arg | Description |
|---|---|
| `<content>` | Quirk text to test |

**Options:**
| Flag | Default | Description |
|---|---|---|
| `-c, --config <path>` | auto-detected | Path to config file |

**Output:**
- If a matching quirk exists → shows quirk details (type, content preview, tags, confidence)
- If no match → `No matching quirk found — quirk has not been appended`

**Example:**
```bash
$ opencode-rag quirk test "npm needs --legacy-peer-deps"
✓ Quirk has been appended:
  [gotcha] npm needs --legacy-peer-deps (installation)
  99% confidence

$ opencode-rag quirk test "some brand new fact"
✗ No matching quirk found — quirk has not been appended
```

### `setup`

Set up the OpenCodeRAG runtime at `~/.opencode/` so OpenCode can discover the plugin.

```bash
opencode-rag setup [options]
```

**Options:**
| Flag | Default | Description |
|---|---|---|
| `--check` | `false` | Check whether the runtime is correctly installed |
| `-f, --force` | `false` | Force re-setup even if up-to-date |
| `--uninstall` | `false` | Remove the runtime and cleanup |

**How it works:**
1. Detects the globally-installed package (`npm install -g opencode-rag-plugin`)
2. Creates a junction/symlink at `~/.opencode/node_modules/opencode-rag-plugin` pointing to the global npm prefix
3. Also links `@opencode-ai/plugin` for OpenCode compatibility
4. Writes a version marker (`.bundle-version`)
5. Verifies the installation

No `npm install` into `~/.opencode/` is needed — the junction-links resolve transparently through Node.js.

**Updating from npm:** After `npm update -g opencode-rag-plugin`, run `opencode-rag setup` to sync the runtime.

**Updating from source (local development):** After `npm run build && npm link`, run `opencode-rag setup --force` to sync. The `--force` flag is required because the version marker (`opencode-rag setup --check`) won't change during local development. `npm i -g opencode-rag-plugin` installs from the **npm registry**, not local source — use `npm link` to point the global install at your local repo instead.

**Examples:**
```bash
# Set up the runtime (after global install)
opencode-rag setup

# Re-sync after update
npm update -g opencode-rag-plugin
opencode-rag setup

# Check status only
opencode-rag setup --check

# Remove the runtime
opencode-rag setup --uninstall
```

## Examples

```bash
# Initialize a workspace
opencode-rag init

# Full index
opencode-rag index

# Incremental index with file watching
opencode-rag index --watch

# Force rebuild
opencode-rag index --force

# Semantic search
opencode-rag query "How is authentication handled?"

# Limit results
opencode-rag query "database connection pool" --top-k 5

# Show index status
opencode-rag status

# List indexed files
opencode-rag list

# Show chunks for a file
opencode-rag show src/auth.ts

# Dump first 50 chunks
opencode-rag dump --limit 50

# Clear all data
opencode-rag clear

# Describe an image file (requires imageDescription.enabled)
opencode-rag describe-image ./docs/architecture.png

# Launch the web dashboard
opencode-rag ui

# Start the MCP server
opencode-rag mcp

# Use a custom config
opencode-rag index --config ./config/my-rag-config.json
```

## Evaluation Commands

### `eval:sessions`

List all logged evaluation sessions.

```bash
opencode-rag eval:sessions [options]
```

**Options:**
| Flag | Default | Description |
|---|---|---|
| `-c, --config <path>` | auto-detected | Path to config file |

**Output:** Table of sessions with ID, message count, input tokens, RAG context tokens, and cost.

### `eval:analyze <sessionID>`

Analyze token usage for a specific session with RAG impact projection.

```bash
opencode-rag eval:analyze <sessionID> [options]
```

**Options:**
| Flag | Default | Description |
|---|---|---|
| `-c, --config <path>` | auto-detected | Path to config file |

**Output sections:**
- Total input/output/reasoning tokens, cache stats, cost
- RAG impact: context injected, system guidance overhead, tool call counts
- Projection: estimated tokens with vs without RAG, net savings percentage
- Per-query breakdown: input tokens, RAG context, reads, RAG tools, top score

### `eval:compare <sessionA> <sessionB>`

Compare token usage between two sessions (e.g. RAG-on vs RAG-off).

```bash
opencode-rag eval:compare <sessionA> <sessionB> [options]
```

**Options:**
| Flag | Default | Description |
|---|---|---|
| `-c, --config <path>` | auto-detected | Path to config file |

**Output:** Formatted comparison table with delta and percentage change for each metric.

See [Evaluation documentation](evaluation.md) for interpretation and configuration guidance.

## Programmatic Use

The CLI can also be invoked programmatically:

```typescript
import { runCli } from "opencode-rag-plugin/library";

await runCli(["query", "auth middleware", "--top-k", "5"]);
```
