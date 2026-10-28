# CLI Reference

The CLI interface (`opencode-rag`) provides full access to build, manage, and search your project's vector database. It's primarily intended for testing, debugging, and scripting, but works independently of OpenCode.

## Global Options

| Flag | Description |
|---|---|
| `-c, --config <path>` | Path to config file |
| `-h, --help` | Show help |

## Commands

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
| `--json` | `false` | Print a machine-readable JSON summary as the last stdout line of the initial pass |
| `-c, --config <path>` | auto-detected | Path to config file |

**How it works:**
1. Scans workspace files matching `indexing.includeExtensions` plus any extensions named in `chunking.parsers`, restricted to `indexing.includeDirs` folders when set (files directly in the workspace root are skipped then)
2. Compares file hashes against the manifest
3. Clears any files previously flagged with `descriptionFailed` so they are fully re-indexed
4. Chunks changed/new files via the appropriate chunker
5. Generates descriptions (if enabled) and embeddings
6. Stores vectors in LanceDB and tokens in KeywordIndex
7. Serializes manifest and keyword index

**Incremental:** Only changed files are reprocessed. Unchanged files are skipped. Files with `descriptionFailed` in the manifest are automatically retried.

**Scope changes (`includeDirs`):** Files that fall out of scope are removed from the index during a full pass (`index` without `--force` still runs a full scan when the stored manifest doesn't match the current file set). Git-incremental passes only remove git-deleted files, so after changing `includeDirs` run a plain `opencode-rag index` (or reindex from the Web UI) to apply the new scope.

**Full rebuild (`--force`):** Clears the store, clears keyword index, and re-indexes everything.

**End of a pass:** the summary line reports `N chunks written this pass` — the
chunks of the files this run processed, not the size of the store. Files whose
embedding never completed get no manifest entry, so the rows an earlier pass
wrote for them are swept at the end of any pass that changed the index
(`Orphan cleanup: removed …`); `status` reports the current count as
`Orphan chunks`.

**Progress lines:** every progress line reports the percentage of the **whole
pass** completed — one number that rises monotonically from 0 to 100 across
all stages and processing windows. It is never a per-chunk or per-stage
fraction; the stage-local counters ride along as a plain done/total count:

```
Chunking — 9.1% overall (40/440 files)
Describing src/foo.ts — 46.3% overall (55/200 texts)
Embedding — 61.2% overall (64/350 texts)
Storing src/foo.ts — 98.0% overall (12/50 files)
```

Each active (new/modified) file weighs equally and earns one quarter of its
credit per stage (chunk, describe, embed, store), so the number is an honest
estimate of how far through the run you are, not a precise work-meter. An
interrupted pass simply stops short of 100.

**Watch mode (`--watch`):** Uses chokidar to monitor file changes. Re-indexes debounced changes automatically.

**Exit codes:** `0` = complete; `3` = completed with problems (some files failed
extraction, description, or embedding and are retried on the next pass); `1` = incomplete
(nothing stored — e.g. the embedding provider was unavailable) or a hard error; `130` =
interrupted (Ctrl+C). Treat `3` as success-with-warnings, not as failure.

**Machine-readable summary (`--json`):** prints one JSON object as the last stdout line
(`schema: 1`, `status`, all counters, and up to 20 `extractionErrors` with relative
paths). The human output above it is unchanged.

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
| `--quick` | off | Skip the workspace scan. `Up-to-date files` / `Pending files` then print `n/a (not scanned)` — they are unknown, never zero |

**Shows:**
- Total chunk count
- Store path
- Embedding provider and model
- Number of indexed extensions
- Manifest status (ok/missing/corrupt)
- Last indexed timestamp
- Up-to-date files vs. pending files (from a real workspace scan — the default)
- Expected chunks (sum of the chunk counts the manifest records)
- Orphan chunks — stored chunks no manifest entry owns (files whose embedding
  never completed). The next full `index` pass sweeps them.
- Quirk chunks — rows owned by `quirks.jsonl`, so they belong to neither
  expected nor orphan: `Indexed = Expected + Orphan + Quirk` always reconciles.
- Watch mode and watcher health. A live watcher found in a *different* store
  dir than the configured `vectorStore.path` is printed as `Watcher elsewhere`
  with its PID — that is the running OpenCode plugin indexing the old store
  after a config switch; restart OpenCode to fix it.
- Keyword index chunk count

> **Reading the numbers:** `New files` / `Modified files` / `Unchanged files`
> count **files**, while `Indexed chunks` / `Expected chunks` count **chunks** —
> one file produces several chunks, so the two groups are never expected to be
> equal. `Consistency check: OK` means every manifest entry has at least one row
> in the store. `status` also applies the store's `runtime-overrides.json`, so
> it reports the same effective config the plugin uses.

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

Clears the vector store, then removes the manifest and the keyword index.

Before clearing, the existing LanceDB table is backed up by **moving**
`chunks.lance` to `chunks.lance.backup-<timestamp>` inside the store directory —
instantaneous, so a large store does not sit in a multi-minute copy that can be
interrupted. Delete those backup directories yourself once you no longer need
them, they are never cleaned up automatically.

The command then verifies the table really is empty: if rows remain (interrupted
run, or the store is held open by a plugin/watcher process) it prints
`Clear incomplete`, keeps manifest and keyword index in place so the index stays
consistent, and exits with code 1.

### `describe-image`

Describe an image file using the configured vision model. Useful for testing image description settings without running a full index pass.

```bash
opencode-rag describe-image <filePath> [options]
```

**Options:**
| Flag | Default | Description |
|---|---|---|
| `-c, --config <path>` | auto-detected | Path to config file |
| `-s, --system-prompt <text>` | — | Optional system prompt to steer the description toward specific features |

**Requirements:** `imageDescription.enabled` must be `true` in config. The image is resized (per `resizeMaxDimension`), base64-encoded, and sent to the configured vision provider, which returns a natural-language description. When `imageDescription.onDemand` is set, the command uses those overrides (and logs `Source: imageDescription.onDemand override`) instead of the indexing model. The path is not restricted to the project directory: absolute paths, relative paths (resolved against the current directory), and `~`-prefixed paths are all accepted — only the image extension is validated.

### `decide`

Answer classification/decision questions with the configured decision model (tev1 via Ollama's `/v1/systemone`). Useful for testing decision settings without going through an agent.

```bash
opencode-rag decide [question] [options]
```

**Arguments:**
| Arg | Description |
|---|---|
| `[question]` | Question/instruction to decide (single-question mode) |

**Options:**
| Flag | Default | Description |
|---|---|---|
| `--state <text>` | — | Text to judge (alternative: `--state-file`, or pipe via stdin) |
| `--state-file <path>` | — | Read the text to judge from a file (`-` for stdin) |
| `-t, --type <type>` | `choice` | Question type: `choice`, `noul`, or `score` |
| `--options <list>` | — | Comma-separated options (choice) or level descriptions, lowest first (score) |
| `--questions <json>` | — | Full questions array as JSON (advanced, multi-question) |
| `--questions-file <path>` | — | Read the questions array from a JSON file |
| `--json` | `false` | Print the raw answers as JSON |
| `-c, --config <path>` | auto-detected | Path to config file |

**Requirements:** `decision.enabled` must be `true` and `decision` must point at a running Ollama server with a pulled tev1 model. Examples:

```bash
# choice (single question)
opencode-rag decide "Which intent is this?" --state-file ticket.txt \
  --options duplicate_charge,cancel_subscription,none

# true/false probability over piped stdin
cat message.txt | opencode-rag decide "Does the customer ask for a refund?" --type noul

# full passthrough
opencode-rag decide --state "Hello World" --questions \
  '[{"id":"says_hello","type":"noul","instructions":"Does the state contain a greeting?"}]'
```

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

Exposes `search_semantic`, `get_file_skeleton`, `find_usages`, and `describe_image` tools (plus `make_decision` when `decision.enabled` is `true`). Clients configure the server manually. The plugin does not autostart a child MCP server: the agent tools run in-process, and external MCP clients must run `opencode-rag mcp` themselves. See the [MCP Server](../ReadMe.md#mcp-server) section in the README.

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

Set up OpenCodeRAG: install/verify the machine-level runtime, scaffold the current workspace, and run the model configuration wizard.

```bash
opencode-rag setup [options]
```

`setup` is the only workspace-initialization command — it replaces the removed `opencode-rag init`.

**Options:**
| Flag | Default | Description |
|---|---|---|
| `--check` | `false` | Check whether the runtime is correctly installed |
| `-f, --force` | `false` | Force re-setup even if up-to-date |
| `--uninstall` | `false` | Remove the runtime and cleanup |
| `--reconfigure` | `false` | Re-open the model wizard even when a config already exists |
| `-y, --yes` | `false` | Non-interactive: never prompt, keep the existing configuration |
| `--provider <name>` | — | `ollama`, `openai` (OpenAI-compatible), `cohere`, `anthropic`, `google` |
| `--base-url <url>` | provider default | Provider base URL |
| `--api-key <key>` | env auto-detect | API key, or `env:NAME` to read an environment variable |
| `--embedding-model <model>` | from wizard | Embedding model |
| `--description-model <model>` | — | Enable chunk descriptions with this model |
| `--vision-model <model>` | — | Enable image descriptions with this vision model |
| `--decision-model <model>` | — | Enable `make_decision` with this tev1 model |
| `--description [on\|off]` | existing / `on` | Toggle chunk descriptions |
| `--vision [on\|off]` | existing / `off` | Toggle image descriptions |
| `--decision [on\|off]` | existing / `off` | Toggle the decision model |
| `--reranking [on\|off]` | existing | Toggle reranking |
| `--shell-guard [on\|off]` | existing | Toggle the shell-command guard |
| `--memory-capture [on\|off]` | existing | Toggle automatic quirk capture |
| `--vector-store <provider>` | `lancedb` | `lancedb` or `clickhouse` |
| `--clickhouse-*` | — | `url`, `database`, `user`, `password-env`, `namespace` |
| `--skip-install` | `false` | Skip linking workspace-local plugin dependencies |
| `--skip-health-check` | `false` | Skip provider connectivity and model availability checks |
| `--skip-runtime` | `false` | Workspace setup only (no machine-level runtime install) |
| `--workspace-plugin` | `false` | Install the plugin into this workspace instead of the global config |
| `--no-index` | — | Do not offer to build the index after setup |

`--skip-install`, `--skip-health-check` and `--skip-runtime` accept an optional value (`--skip-health-check=false`, `--skip-install off`), like the `[on|off]` toggles.

**Machine step — how it works:**
1. Checks the installed version against the **latest version on npm**; when
   outdated, fetches and installs the new version (self-update, independent of
   how the package was installed - global prefix, runtime junction or dev link)
2. Creates a junction/symlink at `~/.opencode/node_modules/opencode-rag-plugin` pointing to the global npm prefix
3. Installs the plugin entrypoints once in OpenCode's global plugin directory (`~/.config/opencode/plugins/opencode-rag/{index.js,tui.js}`)
4. Links `@opencode-ai/plugin` only when the peer dependency does not resolve from the plugin itself
5. Writes a version marker (`.bundle-version`)
6. Verifies the installation

No `npm install` into `~/.opencode/` is needed - the junction-links resolve transparently through Node.js.

**Workspace step — the wizard:**

On the first run (no provider configuration yet) or with `--reconfigure`, `setup` first offers a **one-question recommended setup**: it probes Ollama, detects CPU vs GPU and proposes a preset (`qwen3-embedding:0.6b` / `qwen2.5:3b` / `minicpm-v4.6`, or the 1.7b embedding model on GPU). Accepting pulls missing models automatically. Declining opens the detailed wizard:

1. **Provider** — Ollama (local/remote), OpenAI-compatible (llama.cpp, LM Studio, vLLM, OpenRouter, …), Cohere, Anthropic or Google.
2. **Base URL** — the host answers a model-list probe (`/api/tags`, `/v1/models`), shown as `✓ reachable, N models` or the exact error.
3. **API key** — only when the provider needs one; an existing `<PROVIDER>_API_KEY` environment variable or a stored key is reused. Masked input, never written as a placeholder.
4. **Embedding model** — picked from the probed list (Ollama capabilities via `/api/show`), with manual entry for models the host does not list. The vector dimension is probed and stored so the store schema stays stable; choosing a different provider, base URL or model clears the stored value so it is probed again (a stale dimension would make the store reject the new vectors).
5. **Description / vision / decision** — each is enabled with a yes/no question and a model picker. The decision model uses Ollama's `/v1/systemone` (`ollama pull tev1:0.8b`).
6. **Advanced** — reranking, shell guard, memory capture, ClickHouse backend, `embedDescriptions`, background indexing.

Every question has a default taken from the current configuration, so pressing Enter keeps an existing setup intact. Ctrl+C cancels the wizard without writing anything.

**Config layering:** provider/model/baseUrl/apiKey/vectorDimension describe the machine and are written to `~/.config/opencode/opencode-rag.json`; feature toggles and repository settings go to `.opencode/opencode-rag.json`. Stale provider keys left in a workspace config by an older `init` are detected and removed (with a `.bak` backup) because the workspace layer would otherwise shadow the global choice.

**Workspace files (global plugin mode, default):** `.opencode/opencode-rag.json`, `.opencode/.gitignore`, `.opencode/skills/opencode-rag/SKILL.md`, `.opencode/skills/make-decision/SKILL.md` and `AGENTS.md` (merged via sentinel markers). No plugin entries, no `.opencode/node_modules` junction. `vectorStore.path` is resolved against the repository, so each workspace keeps its own local LanceDB. The plugin also performs this scaffolding automatically on first load (`setup.autoScaffold`, default on; create-only).

`--workspace-plugin` restores the per-repository layout: `.opencode/plugins/opencode-rag/{index.js,tui.js}`, `.opencode/opencode.json`, `.opencode/package.json` and the `.opencode/node_modules` link.

**Backend auto-tuning:** a fresh workspace config probes Ollama (`GET /api/ps`) and tunes embedding batches for the detected backend:
- **GPU** (`size_vram > 0`): `embedBatchSize: 40`, `embedConcurrency: 4`, `ollamaMaxBatchSize: 40`
- **CPU**: `embedBatchSize: 20`, `embedConcurrency: 1`, `ollamaMaxBatchSize: 20`
- **Ollama unreachable / undetermined**: defaults (100 / 3 / 100)

**Health check:** after applying the configuration, `setup` validates provider connectivity and model availability (embedding + description + image description + on-demand image description + reranking when enabled). API keys are resolved the way the runtime resolves them (config → env var → OpenCode provider config → `~/.local/share/opencode/auth.json`), so an on-demand override with no key of its own is checked with the provider's real key. Missing Ollama models can be pulled in place. When a model fails, an interactive run offers to rebuild that section — provider, base URL, API key (required for a 401) and model — and writes the result into the config layer that already owns the section; an `imageDescription.onDemand` failure first offers to remove the override and fall back to the indexing vision model. `--skip-health-check` skips the whole step (offline environments); `--yes` reports failures without prompting.

**Updating from npm:** After `npm update -g opencode-rag-plugin`, run `opencode-rag setup` to sync the runtime.

**Updating from source (local development):** After `npm run build && npm link`, run `opencode-rag setup --force` to sync. The `--force` flag is required because the version marker (`opencode-rag setup --check`) won't change during local development. `npm i -g opencode-rag-plugin` installs from the **npm registry**, not local source — use `npm link` to point the global install at your local repo instead.

**Examples:**
```bash
# First-time setup: runtime + global plugin + workspace + recommended models
opencode-rag setup

# Re-sync after an update (no questions)
npm update -g opencode-rag-plugin
opencode-rag setup

# Re-open the wizard
opencode-rag setup --reconfigure

# Scripted OpenAI-compatible setup
opencode-rag setup --provider openai --base-url http://127.0.0.1:11437/v1 \
  --api-key env:LLAMA_API_KEY --embedding-model Qwen3-Embedding:8B --description off

# Workspace files only
opencode-rag setup --skip-runtime

# Legacy per-repository plugin layout
opencode-rag setup --workspace-plugin

# Check status only / remove the runtime
opencode-rag setup --check
opencode-rag setup --uninstall
```

## Examples

```bash
# Set up a workspace (runtime + files + wizard)
opencode-rag setup


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

### `eval:gate`

Run the labelled retrieval golden set against the current index and fail when quality
drops below the thresholds.

```bash
opencode-rag eval:gate [options]
```

**Options:**
| Flag | Default | Description |
|---|---|---|
| `--labels <path>` | `src/eval/rerank-labels.json` | Golden-set label file |
| `--topk <n>` | `retrieval.topK` | Top-K retrieved per query |
| `--category <name>` | all | Only run labels of this category |
| `--limit <n>` | all | Only run the first N labels |
| `--min-hit5 <ratio>` | `0.35` | Minimum mean Hit@5 (0-1) |
| `--min-mrr <ratio>` | `0.25` | Minimum mean MRR (0-1) |
| `--min-ndcg10 <ratio>` | `0.32` | Minimum mean nDCG@10 (0-1) |
| `--json` | `false` | Print a machine-readable result as the last stdout line |

Measures the fusion pipeline only — the rerank stage stays off. Requires a live embedder
and an indexed workspace (`0` = passed, `1` = regression below the floors, `2` = could not
run). Reference run (2026-10-05, 48 labels, Qwen3-Embedding:8B): Hit@5 54.2%, MRR 0.405,
nDCG@10 0.461.

### `eval:decide`

Measure accuracy, ECE (10 bins) and Brier score of the tev1 decision model on the labelled
calibration set.

```bash
opencode-rag eval:decide [options]
```

**Options:**
| Flag | Default | Description |
|---|---|---|
| `--labels <path>` | `src/eval/decide-labels.json` | Calibration label file |
| `--model <name>` | `decision.model` | Decision model override (synthesizes an enabled config) |
| `--base-url <url>` | `decision.baseUrl` | Ollama base URL override |
| `--category <name>` | all | Only run items of this category |
| `--limit <n>` | all | Only run the first N items |
| `--report <path>` | – | Write a markdown calibration report |
| `--json` | `false` | Print a machine-readable result as the last stdout line |

Requires `decision.enabled` or `--base-url/--model`; exits `2` when Ollama/tev1 is
unavailable. `confidence` is probability concentration — this command measures how close
it is to correctness, and documents the gap.

### `eval:tune`

Sweep the retrieval fusion weights against the golden set and report the best
configuration. The shipped `retrieval.hybridSearch.keywordWeight` is a single default, but
the optimum depends on the embedder, the corpus and the query mix — this command measures
it for *your* setup instead of guessing.

```bash
opencode-rag eval:tune [options]
```

**Options:**
| Flag | Default | Description |
|---|---|---|
| `--labels <path>` | `src/eval/rerank-labels.json` | Golden-set label file |
| `--category <name>` | all | Only run labels of this category |
| `--limit <n>` | all | Only run the first N labels |
| `--metric <name>` | `ndcg10` | Metric the winner is picked by (`ndcg10` \| `hit5` \| `hit1` \| `mrr`) |
| `--keyword-weights <list>` | `0,0.1,…,0.6` | Comma-separated keyword weights to try |
| `--symbol-weights <list>` | same as keyword weights | Comma-separated symbol keyword weights to try |
| `--min-scores <list>` | the configured one | Comma-separated minScore values to try |
| `--topks <list>` | the configured one | Comma-separated topK values to try |
| `--write` | `false` | Write the winning values into the config file |
| `--json` | `false` | Print a machine-readable result as the last stdout line |

Prints one line per candidate, the winning configuration, and the delta against the
configuration that is currently running. `--write` persists `keywordWeight`,
`symbolKeywordWeight`, `minScore` and `topK` into the config file (the rest of the file is
left untouched). Requires a live embedder and an indexed workspace; exits `2` when it
cannot run.

**The report states how strong the evidence is** — the argmax alone is not a result:

| Line | Meaning |
|---|---|
| `paired bootstrap: Δndcg10 … (95% CI …)` | Paired bootstrap over the labels. A CI that includes 0 means the difference is within noise |
| `N better / N worse / N equal` | How many labels actually flipped |
| `sign test p=…` | Exact two-sided sign test over the discordant labels — the conservative reading (19 vs 11 is still p ≈ 0.20) |
| `Weak evidence` / `Within noise` | Printed when the data does not support a change; **do not change the shipped default on it** |
| `Signal split` | BM25-only vs vector-only vs fused quality, so a fused number can be interpreted instead of believed |

The signal split is the reason a fusion weight can matter more than expected: the keyword
half and the vector half are measured apart, and a fused ranking can only be as good as
the mix of its parts.

Example (2026-10-20, this workspace, `jina-code-embeddings-0.5b`, 48 labels): the shipped
`keywordWeight=0.4` scored Hit@5 72.9% / MRR 0.556 / nDCG@10 0.612, while `keywordWeight=0`
scored Hit@1 52.1% / Hit@5 81.3% / MRR 0.651 / nDCG@10 0.691 — **+8.3 Hit@5 points**. A
code embedder already ranks identifiers well through the vector half, so the keyword
fusion only dilutes it; a general embedder may prefer the opposite. Measure, do not guess.

See [Evaluation documentation](evaluation.md) for interpretation and configuration guidance.

## Programmatic Use

The CLI can also be invoked programmatically:

```typescript
import { runCli } from "opencode-rag-plugin/library";

await runCli(["query", "auth middleware", "--top-k", "5"]);
```
