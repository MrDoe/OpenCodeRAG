# OpenCodeRAG

**Semantic code search for AI coding agents — local-first, token-efficient, and fast.**

OpenCodeRAG indexes your repository as AST-aware chunks with embeddings, then answers natural-language queries with the most relevant code, so an agent no longer has to read whole files to find one function. It installs as an [OpenCode](https://opencode.ai) plugin and also runs as an MCP server or a standalone CLI for other AI harnesses. Everything works locally with [Ollama](https://ollama.ai) by default, and small embedding models run fine on a modern CPU — no dedicated GPU required.

[![npm version](https://img.shields.io/npm/v/opencode-rag-plugin.svg)](https://www.npmjs.com/package/opencode-rag-plugin)

> **Package name:** install `opencode-rag-plugin`. The npm package `opencode-rag` is an unrelated, discontinued project by a different author.

> **Shell Guard (optional):** every `shell`/`bash` command is classified by the local decision model *before it runs*. Flagged commands ask for confirmation with the full verdict (destructive/malicious probabilities plus a risk category); clean commands run unchanged. See [Shell Guard](#shell-guard-optional).

## Contents

- [Why OpenCodeRAG](#why-opencoderag)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Features](#features)
- [Using OpenCodeRAG](#using-opencoderag)
  - [MCP Tools](#mcp-tools)
  - [Plugin-Only Tools](#plugin-only-tools)
  - [With OpenCode](#with-opencode)
  - [With Other MCP Clients](#with-other-mcp-clients)
  - [From the CLI](#from-the-cli)
- [Quirk Memory](#quirk-memory)
- [Decision Model](#decision-model-make_decision)
- [Shell Guard (Optional)](#shell-guard-optional)
- [Documentation and Wiki Modes](#documentation-and-wiki-modes)
- [Image Indexing](#image-indexing)
- [Web UI](#web-ui)
- [Evaluation and Calibration](#evaluation-and-calibration)
- [Configuration](#configuration)
- [Documentation Index](#documentation-index)
- [Privacy and Security](#privacy-and-security)
- [Limitations and Non-Goals](#limitations-and-non-goals)
- [Contributing and Support](#contributing-and-support)
- [License](#license)

## Why OpenCodeRAG

- **Fewer tokens.** Retrieval returns the handful of relevant chunks instead of whole files, so the agent spends its context on the code that actually matters.
- **Search the way code is written.** AST-aware chunking keeps functions and classes intact, and hybrid vector + keyword search catches both meaning ("where is auth handled?") and exact symbol names.
- **Local by default.** Embeddings, the vector store, and the optional decision model run on your machine. No source code leaves the workspace unless you explicitly configure a hosted provider.
- **Scales with the repository.** Incremental indexing, a background watcher, and an optional shared ClickHouse store keep large or multi-machine workspaces searchable.

## Quick Start

**Prerequisites:** Node.js v22+ and [Ollama](https://ollama.ai) (default provider). [OpenCode](https://opencode.ai) is optional — the CLI and MCP server work without it.

```bash
# 1. Install the CLI, the runtime and the OpenCode plugin (once per machine)
npm install -g opencode-rag-plugin

# 2. Set up the workspace and your models
#    (one recommended question; missing Ollama models are pulled for you)
cd /path/to/your/project
opencode-rag setup

# 3. Build the index (setup offers this at the end)
opencode-rag index

# 4. Search from the terminal
opencode-rag query "authentication middleware"
```

Example output:

```text
Querying: "authentication middleware"
Top-K: 10
Searching 1240 indexed chunks...

3 result(s) in 41ms:

  src/auth/middleware.ts:12-48
  Score: 0.8123
  ...
```

That is the whole setup. Open OpenCode in the same directory and the agent can use the retrieval tools right away.

`opencode-rag setup` does the whole onboarding in one command: it installs or verifies the machine-level runtime in `~/.opencode/`, scaffolds the current workspace, and — on the first run, or whenever you pass `--reconfigure` — asks **one** recommended-setup question (Ollama CPU/GPU preset with embedding, description and vision models). Missing models are pulled automatically. Answer “no” to pick every model yourself, or script it with `--yes`, `--provider`, `--base-url`, `--embedding-model`, `--description off`, ….

The OpenCode plugin is installed **once globally** (`~/.config/opencode/plugins/opencode-rag/`); a prepared workspace only contains its config, skills, `AGENTS.md` and the `.gitignore` that protects its local LanceDB store. The plugin also auto-scaffolds a fresh repository on first load (`setup.autoScaffold`, default on). If you prefer the old per-repository plugin layout, pass `--workspace-plugin`. `--skip-runtime` limits a run to the workspace, and `--skip-health-check` skips model probing. Use `opencode-rag update` to upgrade the runtime to a newer release.

**Other package managers:** `pnpm add -g opencode-rag-plugin`, `yarn global add opencode-rag-plugin`, and `bun add -g opencode-rag-plugin` work as drop-in replacements. Setup and update detect the package manager that owns the install, so npm does not need to be on `PATH`.

### Optional add-ons

These switchers are off by default and can be turned on later:

| Add-on | Default | Enable with | Requires |
|---|---|---|---|
| [Shell Guard](#shell-guard-optional) | off | `shellGuard.enabled` (or `setup --shell-guard on`) | tev1 via Ollama ≥ 0.35 |
| [Decision model](#decision-model-make_decision) | off | `decision.enabled` (or `setup --decision on`) | tev1 via Ollama ≥ 0.35 |
| [Documentation mode](#documentation-mode-doc) | off | `documentationMode.enabled` | nothing extra |
| [Shared ClickHouse store](doc/clickhouse.md) | off | `vectorStore.provider: "clickhouse"` (or `setup --vector-store clickhouse`) | a ClickHouse server |

Two more are on by default and worth switching off if they do not fit your setup: [image descriptions](#image-indexing) (`imageDescription.enabled`, needs a vision model) and [wiki mode](#wiki-mode-wiki) (`wikiMode.enabled`, no extra setup).

> **Contributors / developers:** clone the repo and run `npm install --legacy-peer-deps; npm run build` — see the [development docs](doc/development.md).

## How It Works

```text
Workspace files
   │  tree-sitter chunking (AST-aware)
   ▼
Chunks ─────► embeddings ─────► vector store (LanceDB by default)
   │
   └─────────► keyword index (TF×IDF)

Query ─► vector search + keyword search ─► weighted fusion ─► top-K chunks
```

1. **Index** — files are split into semantic chunks, optionally described by a local LLM, embedded, and stored alongside a TF×IDF keyword index. A file-hash manifest means only changed files are reprocessed, and a background watcher keeps the index current while you work.
2. **Retrieve** — the query is embedded and matched against both signals. The scores are fused and post-processed (dedup, per-file chunk limits, adjacent-chunk merging) to fit the context window.
3. **Use** — the agent calls `search_semantic`, `get_file_skeleton`, or `find_usages` instead of reading entire files.

## Features

**Retrieval**

- AST chunking for 26 languages via tree-sitter, plus documents (Markdown, LaTeX, PDF, DOCX, Excel) and images.
- Hybrid search combining vector similarity with TF×IDF keyword matching; the keyword index is repaired from the store whenever it drifts behind it, so the BM25 half never covers only part of the corpus.
- Retrieval calibration with `opencode-rag eval:tune` against a labelled golden set.
- Context optimization: dedup, per-file chunk limits, adjacent-chunk merging.
- Configurable parsers — remap file extensions to any parser via `chunking.parsers` (e.g. `.c` → `cpp`); the override applies to chunking, `get_file_skeleton`, and read labels ([docs](doc/chunking.md#parser-overrides-per-extension-chunkingparsers)).

**Agent integration**

- OpenCode plugin with three discovery paths: skill files, system-prompt guidance, and on-demand RAG context on `Ctrl+Enter` / `Ctrl+Alt+Enter`.
- MCP server for Claude Desktop, Cursor, and any other MCP-compatible client.
- Read-tool override that adds supplementary RAG chunks to normal file reads.
- TUI settings panel for models, retrieval options, and keybindings.
- `AGENTS.md` directive: workspace setup merges a tool-usage directive into `AGENTS.md` via sentinel markers.

**Memory and decisions**

- [Quirk memory](#quirk-memory): persistent, cross-session gotchas and decisions with automatic injection into the agent's context.
- [Decision model](#decision-model-make_decision): local classification, routing, and scoring of short text — no agent tokens spent.
- Failed tool calls are recorded as quirks, so a later session starts with the fix already known.

**Operations**

- Incremental indexing with a file-hash manifest, background watcher, and automatic rebuild on corruption.
- Optional ClickHouse backend for one shared index across many machines and workspaces, with HNSW ANN, epoch rebuilds, and state sync ([docs](doc/clickhouse.md)).
- Session-level token and cost analysis: RAG-on vs RAG-off comparison with tiktoken BPE counting.
- Alternate providers: embedding via Ollama, OpenAI-compatible endpoints, or Cohere; description and vision via Anthropic, Google Gemini, or OpenAI-compatible endpoints, with API-key auto-resolution.
- Proxy-aware HTTP with a raw-socket localhost bypass.

## Using OpenCodeRAG

### MCP Tools

These five tools are the whole retrieval surface. Inside OpenCode the plugin registers them in-process; over MCP they are served by `opencode-rag mcp`.

| Tool | What it does | When the agent uses it |
|---|---|---|
| `search_semantic` | Hybrid vector + keyword search over the indexed code | Before a code task, instead of reading whole files |
| `get_file_skeleton` | AST outline of a file (functions, classes, methods) | To orient in a large file before reading it |
| `find_usages` | Every reference to a symbol | Before editing a function, class, or variable |
| `describe_image` | Describes an image with the configured vision model | When the task involves a screenshot, diagram, or other asset |
| `make_decision` | Classifies, routes, or scores short text (needs `decision.enabled`) | When the answer reduces to a choice, a yes/no check, or a rubric score |

### Plugin-Only Tools

The quirk tools are registered by the OpenCode plugin (not served over MCP):

| Tool | What it does |
|---|---|
| `recall_quirks` | Recalls stored gotchas, preferences, and decisions from past sessions |
| `add_quirk` | Stores a new non-obvious fact, workaround, or convention |
| `update_quirk` | Corrects a stored quirk that is outdated or wrong |
| `delete_quirk` | Removes a quirk that is fixed, obsolete, or no longer applies |

### With OpenCode

**Discovery.** Workspace setup creates `.opencode/skills/opencode-rag/SKILL.md` (tool workflow) and `.opencode/skills/make-decision/SKILL.md` (decision-model guidance). Agents load them on demand, so idle sessions pay almost no token cost. When the index contains chunks, a brief tool list is also prepended to the system prompt so agents know the tools exist — skipped when nothing is indexed, to save tokens.

**Hotkeys.** `Ctrl+Enter` appends a relevant file list to the prompt you are typing; `Ctrl+Alt+Enter` appends full code chunks. The query is taken from your typed text — if the prompt is empty, a toast reminds you to type first. Results land directly in the prompt as code blocks with file paths, line ranges, and relevance scores; no dialog is opened. Keybindings are configurable in the settings menu (Alt+S, or type `/rag-settings`).

**Read override.** A normal `read` can return the file plus supplementary RAG chunks that are relevant to the surrounding work.

### With Other MCP Clients

<a id="mcp-server"></a>

```bash
opencode-rag mcp
```

The MCP server is optional and only needed when an *external* client connects. Inside OpenCode the tools are registered in-process and the hotkey hook runs in-process too. The plugin auto-starts the server only when `mcp.enabled` is `true` (default `false`); clients can also configure it manually, and workspace setup can register it for you.

### From the CLI

```bash
opencode-rag setup        # install the runtime, scaffold the workspace, run the model wizard
opencode-rag index        # build or update the index
opencode-rag query "..."  # search from the terminal
opencode-rag status       # index health and coverage
opencode-rag ui           # open the web dashboard
```

Further commands: `list`, `show <file>`, `dump`, `clear`, `describe-image`, `decide`, `mcp`, `update`, `clickhouse`, `quirk`, and the `eval:*` family. Run `opencode-rag --help` or see the [CLI reference](doc/cli.md) for every command, flag, and example.

## Quirk Memory

Quirk memory gives your agent a **persistent, cross-session memory** of non-obvious facts — gotchas, preferences, decisions, and environment constraints. Quirks are embedded and stored in the same vector store as your code, then injected into the agent's context whenever their relevance clears a configurable threshold. The agent stops repeating the same mistake and accumulates project knowledge over time.

**Enabled by default.** Configure it in `opencode-rag.json`:

```json
{
  "memory": {
    "enabled": true,
    "autoInject": true,
    "minConfidence": 0.5,
    "recallMinScore": 0.72,
    "autoInjectMinScore": 0.75,
    "autoInjectTopK": 1,
    "autoInjectLatencyBudgetMs": 2000,
    "injectOnToolError": true,
    "autoCreateOnToolError": true,
    "toolErrorCreateMaxPerSession": 2,
    "decay": { "enabled": false, "halfLifeDays": 30 }
  }
}
```

**How injection works.** On every user message the plugin searches for quirks related to the combined agent response and user query, and injects only those whose raw vector similarity clears `autoInjectMinScore` (default 0.75). Manual `recall_quirks` calls use the slightly looser `recallMinScore` (default 0.72) — raise it to 0.85 to keep only strongly related quirks out of unrelated tasks. A latency budget (`autoInjectLatencyBudgetMs`, default 2000 ms) keeps a slow embedder from blocking message processing, and each quirk is injected **at most once per session**. Every `add_quirk` and every content-changing `update_quirk` passes an immutable trust monitor that rejects destructive patterns (`rm -rf`, `force push`, `bypass security`).

**Failed tool calls become memory.** When a tool call fails, the plugin looks for a stored quirk that covers the failure and injects it into the next request (`memory.injectOnToolError`). If no quirk covers it, it writes one (`memory.autoCreateOnToolError`) from a deterministic template built from the tool name and the error text — no LLM involved. The new quirk is tagged `tool-error` and recorded for *future* sessions; it is deliberately excluded from the generic auto-injection, so a raw error dump never leaks into an unrelated turn. Creation is bounded by a per-session budget (2) and a per-error cooldown (10 minutes), and it is suppressed when a quirk for the same tool and cause class already exists.

**Prevention, not just learning.** Known failure patterns are also injected into the **system prompt before the model picks a tool** (`memory.toolErrorProactiveInject`), scoped to the tools the session can actually call and to durable failure causes only — a rate limit is never warned about in advance, because the next call will not fail the same way. The first occurrence of a failure is unavoidable; every later session is warned up front.

**CLI — manage quirks directly:**

```bash
opencode-rag quirk add "npm needs --legacy-peer-deps" --type gotcha --tag installation
opencode-rag quirk list
opencode-rag quirk update <id> --content "..." --type decision
opencode-rag quirk rm <id>
opencode-rag quirk lint            # flag low-confidence / stale / duplicate quirks
opencode-rag quirk test "npm needs --legacy-peer-deps"
# ✓ Quirk has been appended:
#   [gotcha] npm needs --legacy-peer-deps (installation)
#   99% confidence
```

See [Plugin documentation](doc/plugin.md#9-quirk-memory-experiential-memory) and [CLI reference: `quirk`](doc/cli.md#quirk).

## Decision Model (`make_decision`)

OpenCodeRAG answers fast **classification, routing, policy, and scoring questions** with a local decision model — Together AI's [tev1](https://ollama.com/library/tev1) via Ollama's `/v1/systemone` endpoint. Unlike chat models, tev1 scores a short `state` against 1–64 named questions and returns the chosen option with probabilities — typically in **40–150 ms warm**, without spending agent tokens.

| Question type | Use it for | Example |
|---|---|---|
| `choice` | Pick one of 2–24 options | "Which support intent is this?" → duplicate_charge / cancel / none |
| `noul` | True/false probability | "Does the customer explicitly ask for a refund?" |
| `score` | Place the input on a rubric | "How severe is this incident?" → cosmetic … critical |

One call, two questions:

```json
{
  "state": "Customer: I was charged twice for the October subscription ($19.99 each). Please refund the extra charge.",
  "questions": [
    { "id": "intent", "type": "choice", "instructions": "Which support intent matches?",
      "criteria": { "duplicate_charge": "Charged more than once", "cancel": "Wants to cancel", "none": "None of the above" } },
    { "id": "refund", "type": "noul", "instructions": "Does the customer explicitly ask for a refund?" }
  ]
}
```

```text
**Decision** — ollama/tev1:0.8b

- **intent** = `duplicate_charge` (confidence 0.97)
- **refund** = true (p=0.96)
```

**Prerequisites:** Ollama ≥ 0.35 and a pulled model:

```bash
ollama pull tev1:0.8b   # 812 MB, fast — good for quick labels and CI
ollama pull tev1:4b     # 4.4 GB, more accurate — recommended when scoring
```

**Disabled by default** — opt in via `decision.enabled`:

```json
{
  "decision": {
    "enabled": true,
    "provider": "ollama",
    "model": "tev1:0.8b",
    "keepAlive": "30m",
    "routeBeforeAsking": false
  }
}
```

**Using it well:** always include a `none` / "cannot be determined" option; keep `state` to the relevant excerpt (the effective context is ~2k tokens); treat `confidence < ~0.3` as undecided; do not use it for factual recall or as the only check for high-stakes decisions.

**Pre-ask routing (optional):** with `decision.routeBeforeAsking: true`, the injected agent guidance tells the agent to resolve option choices through `make_decision` before asking you — proceeding on a confident answer and asking only when the model is undecided or the choice is preference-based. Off by default.

`opencode-rag decide` exposes the same engine from the CLI, and workspace setup creates a dedicated `make-decision` agent skill. See [Plugin documentation](doc/plugin.md#make_decision) and [Configuration](doc/configuration.md#decision).

## Shell Guard (Optional)

The same local decision model can vet **every shell command before it runs**. With `shellGuard.enabled: true`, each `shell`/`bash` call is classified for destructive and malicious intent; a command whose `p(destructive)` or `p(malicious)` reaches the threshold is escalated to OpenCode's confirmation prompt with the full verdict — otherwise it executes unchanged.

```json
{
  "shellGuard": {
    "enabled": true,
    "threshold": 0.5,
    "timeoutMs": 10000,
    "onError": "allow"
  }
}
```

- **Off by default** — enabling adds one local model call to the critical path of every shell command.
- **Fast** — a warm verdict costs ~200–230 ms (`rm -rf ./dist` → 0.96 destructive, `delete_files`; `ls -la src` → 0.23, allowed). Repeated identical commands hit the 10-minute cache.
- **Machine-wide** — put the block in `~/.config/opencode/opencode-rag.json` (the global layer, see [Configuration](doc/configuration.md#config-file-discovery)) and every workspace inherits it; a workspace config can still override or disable it.
- **Fail-open by default** (`onError: "allow"`) — if the classifier is down or times out, the command runs and a warning is logged. Set `onError: "ask"` to require confirmation instead.
- **Verdict cache** (10 min, 256 entries) — repeated identical commands are answered instantly; the key includes the provider/model, so switching models invalidates it, and cached probabilities are re-scored against the current threshold on every call.
- **Config edits apply without a restart** — the guard re-reads `opencode-rag.json` when it changes.
- **Backend** defaults to the `decision` section, and any `/v1/systemone` endpoint works — e.g. llama-swap with `"baseUrl": "http://localhost:11437", "model": "Clef-Flash"`.

Every verdict is logged under `scope: shell.guard`, so you can tune the threshold against real commands. See [Configuration](doc/configuration.md#shellguard) and [Plugin documentation](doc/plugin.md#shell-guard-command-vetting).

## Documentation and Wiki Modes

### Documentation Mode (`/doc`)

When `documentationMode.enabled` is `true`, the plugin exposes a `/doc` slash command that drives the agent to add JSDoc/TSDoc comments to undocumented source files. No agent tools are registered — documentation is driven entirely through the slash command and the documentation system prompt.

```json
{
  "documentationMode": {
    "enabled": true,
    "batchSize": 5
  }
}
```

**Workflow:** type `/doc` to list all undocumented files grouped by subdirectory. The agent picks a subdirectory, documents every public symbol (preserving existing comments and implementation code), then types `/doc src/auth/` to mark that subdirectory complete. Progress is persisted in `.opencode/rag_db/doc-mode-progress.json`, so later sessions resume where you left off.

See [Plugin documentation](doc/plugin.md#5-documentation-mode--slash-command-doc) for details.

### Wiki Mode (`/wiki`)

When `wikiMode.enabled` is `true` (on by default), the plugin injects a wiki-maintainer system prompt that instructs the agent to build and maintain a persistent knowledge wiki at `.opencode/wiki/` — a structured, interlinked collection of markdown pages synthesizing knowledge from the codebase, docs, and conversations.

```json
{
  "wikiMode": {
    "enabled": true
  }
}
```

| Command | Action |
|---|---|
| `/wiki` | Show wiki status (page count, subdirectories, index/log presence, latest log entry) |
| `/wiki seed` | Generate the initial wiki from the README, file structure, and code patterns |
| `/wiki lint` | Health-check for orphan pages, stale source refs, contradictions, missing cross-links |

The agent maintains all wiki pages during normal coding sessions; you never write wiki pages yourself. The wiki is git-trackable in `.opencode/`, so every edit is a diff. See [Plugin documentation](doc/plugin.md#6-wiki-mode--slash-command-wiki) for the full protocol.

## Image Indexing

OpenCodeRAG can index image files (PNG, JPEG, WebP, and others) by sending them to a vision-capable LLM and storing the generated text descriptions as searchable vector chunks. This makes visual assets discoverable through natural-language queries (e.g. "login screen screenshot", "architecture diagram").

**Supported providers:** Ollama, OpenAI, Anthropic, Google Gemini, and OpenCode Zen (`opencode`/`opencode-go`) compatible providers.

**Enabled by default** — set `imageDescription.enabled: false` in `opencode-rag.json` to skip image files entirely (recommended if you have no vision model or no GPU).

## Web UI

A browser-based dashboard for exploring the indexed vector database — browse, visualize, and inspect chunks, and evaluate OpenCode sessions in terms of retrieved chunks and consumed tokens.

![OpenCodeRAG Web UI](doc/assets/webui-3d.png)

Launch with `opencode-rag ui`. See the [Web UI documentation](doc/webui.md) for details.

## Evaluation and Calibration

OpenCodeRAG tracks token usage, RAG injection overhead, and costs across sessions, so you can measure whether semantic retrieval actually saves tokens.

```bash
opencode-rag eval:sessions          # list sessions
opencode-rag eval:analyze <id>      # detailed breakdown
opencode-rag eval:compare <A> <B>   # side-by-side comparison
```

Token counting uses tiktoken BPE (cl100k_base) for accurate code tokenization. See the [Evaluation documentation](doc/evaluation.md) for details.

Retrieval quality has its own harness:

- `opencode-rag eval:gate` runs the labelled golden set and fails when Hit@5 / MRR / nDCG@10 drop below the documented floors.
- `opencode-rag eval:decide` measures tev1's accuracy, ECE, and Brier score on a labelled calibration set.
- `opencode-rag eval:tune` sweeps the retrieval fusion weights against the same golden set and reports the best configuration for your setup. The shipped `keywordWeight=0.4` is a default, not an optimum (on a code embedder it costs ~8 Hit@5 points) — measure it instead of guessing.

## Configuration

Settings live in JSON (no comments). The workspace file `.opencode/opencode-rag.json` is canonical; the global file `~/.config/opencode/opencode-rag.json` holds machine-wide settings (Shell Guard, provider choices) that every workspace inherits. Shown below are the shipped defaults:

```json
{
  "embedding": { "provider": "ollama", "model": "qwen3-embedding:0.6b" },
  "retrieval": {
    "topK": 20,
    "minScore": 0.35,
    "hybridSearch": { "enabled": true, "keywordWeight": 0.4, "symbolKeywordWeight": 0.6 }
  },
  "shellGuard": { "enabled": false, "threshold": 0.5, "onError": "allow" },
  "decision": { "enabled": false, "model": "tev1:4b" }
}
```

The [Configuration reference](doc/configuration.md) documents every option — embedding, indexing, retrieval, description, image description, decision, shell guard, and plugin settings — and how the global and workspace layers merge.

## Documentation Index

| Document | Contents |
|---|---|
| [Architecture](doc/architecture.md) | Module design, data flow, tech stack |
| [Installation](doc/installation.md) | Full install guide, global setup, uninstall |
| [Configuration](doc/configuration.md) | All options: embedding, indexing, retrieval, description, image description, decision, shell guard, plugin |
| [Chunking](doc/chunking.md) | Language matrix, adding new chunkers, custom chunkers |
| [Embedding](doc/embedding.md) | Providers, model recommendations, proxy, dimension probing |
| [ClickHouse store](doc/clickhouse.md) | Central vector store backend: setup, epochs, ANN, multi-machine sync |
| [Retrieval](doc/retrieval.md) | Pipeline, hybrid search, score fusion, caching |
| [Plugin](doc/plugin.md) | OpenCode integration, tools, hooks, TUI, troubleshooting |
| [CLI Reference](doc/cli.md) | All commands, options, examples |
| [Web UI](doc/webui.md) | Dashboard, chunk browser, file explorer, compare view |
| [Evaluation](doc/evaluation.md) | Token analysis, session logging, benchmark runner, accuracy guide |
| [Development](doc/development.md) | Setup, testing, conventions, adding providers |
| [Troubleshooting](doc/troubleshooting.md) | Common issues, logging, debugging |
| [Roadmap](doc/roadmap.md) | Completed items, short/mid/long-term plans |

## Privacy and Security

**100% local by default.** Embeddings are generated locally via Ollama, and the vector database stays in your project directory. **No source code or embeddings leave your machine** unless you explicitly configure a third-party API. The optional [Shell Guard](#shell-guard-optional) likewise sends command text only to the decision-model endpoint you configure (local Ollama or a local proxy).

Every quirk written to memory passes an immutable trust monitor that rejects destructive patterns, and the decision model is only ever asked about short excerpts you (or the agent) pass in.

## Limitations and Non-Goals

- **This README is the entry point, not the manual.** Deep dives live in [`doc/`](doc/); the project does not aim to duplicate API references here.
- **Retrieval quality depends on the embedding model.** Small CPU-friendly models trade accuracy for speed; measure with `eval:gate` and `eval:tune` rather than assuming a default.
- **Image descriptions need a vision model.** They are on by default; set `imageDescription.enabled: false` if you have none — it is the one feature that meaningfully wants a GPU to be pleasant.
- **Shell Guard costs one model call per shell command** (~200 ms warm) and fails open by default; it is a safety net, not a sandbox.
- **The decision model currently supports Ollama's `/v1/systemone` endpoint only.**
- **The ClickHouse backend is opt-in** and requires a running ClickHouse server; LanceDB is the default and needs no server.

## Contributing and Support

- **Development setup, conventions, and testing:** [doc/development.md](doc/development.md)
- **Troubleshooting and logging:** [doc/troubleshooting.md](doc/troubleshooting.md)
- **Bug reports and feature requests:** [GitHub Issues](https://github.com/MrDoe/OpenCodeRAG/issues)
- **Roadmap:** [doc/roadmap.md](doc/roadmap.md)

## License

MIT
