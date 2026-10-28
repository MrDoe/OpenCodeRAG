# Installation

## Prerequisites

- **Node.js v22+** (required for native ESM and global `fetch`)
- **Ollama** (default) running locally, OR an OpenAI-compatible API endpoint
- **OpenCode** (optional) for agent plugin features

## Ollama Setup

If you don't have Ollama installed, download it from [ollama.com](https://ollama.com) and start the service. **You do not need to pull models manually** — `opencode-rag setup` detects missing models and pulls them (with progress) as part of the recommended setup. To pre-pull them yourself:

```bash
# Small embedding model (required for vector search)
ollama pull qwen3-embedding:0.6b

# Small description model (optional, for LLM-generated chunk descriptions)
ollama pull qwen2.5:3b

# Small vision model (optional, for describing images)
ollama pull minicpm-v4.6
```

OpenCodeRAG uses three models:
- **Embedding model** - converts code chunks into vectors for semantic search. Configured via `embedding.model` (default: `qwen3-embedding:0.6b`).
- **Description model** - generates natural-language descriptions of code chunks before embedding. Configured via `description.model` (default: `qwen2.5:3b`).
- **Vision model** - generates natural-language descriptions of images before embedding. Configured via `imageDescription.model` (default: `minicpm-v4.6`).

> **`setup` only tests configured models.** The embedding model is always checked (indexing needs it). The description, vision (including its `onDemand` override), and rerank models are checked only when the corresponding section appears in your config file (`opencode-rag.json` or the global config) *and* the feature is enabled. Models that are merely on because of built-in defaults are never probed or offered for `ollama pull`.

> **Tip:** Smaller embedding models (≤3B) work well on CPU. For better search results, use a larger embedding model like `qwen3-embedding:1.7b` and activate description and image descripion model usage in OpenCodeRAG config (dedicated GPU recommended). `opencode-rag setup` auto-detects whether your Ollama runs on CPU or GPU and tunes the embedding batch settings accordingly — no manual tuning needed.

## Install

### Quick install (recommended)

```bash
# Install globally via npm (postinstall sets up the runtime + global plugin)
npm install -g opencode-rag-plugin

# One command: set up the workspace and pick the models
cd /path/to/your/workspace
opencode-rag setup
```

> **Alternative package managers:** `pnpm add -g opencode-rag-plugin`, `yarn global add opencode-rag-plugin`, and `bun add -g opencode-rag-plugin` are equally supported. `opencode-rag setup` and `opencode-rag update` detect the package manager that owns the global install and run its equivalent commands — npm does not need to be on `PATH` at all.

> `opencode-rag setup` is both a **machine-level** step (installs the plugin runtime into `~/.opencode/` once per machine; when outdated, fetches and installs the latest published npm version of itself) and a **workspace-level** step (scaffolds the current project - config, skill, AGENTS.md - and runs the model wizard on first use or with `--reconfigure`). Re-running `setup` syncs the files without asking questions; `opencode-rag init` no longer exists. See `opencode-rag setup --help` for all flags.

Tree-sitter grammars ship as pre-built WASM files (bundled in `wasm/` and `@vscode/tree-sitter-wasm`). Native dependencies (`sharp`, `@lancedb/lancedb`) use pre-built platform binaries. The plugin is installed once in OpenCode's global plugin directory (`~/.config/opencode/plugins/opencode-rag/`); each workspace keeps its own vector store, manifest and configuration.

### Updating

The global CLI (`~/.local/bin/opencode-rag`) is a thin wrapper that runs `node ~/.opencode/node_modules/opencode-rag-plugin/dist/cli.js`. To update:

**From npm (published release):**
```bash
npm update -g opencode-rag-plugin
opencode-rag setup               # sync the runtime + workspace files
```

**From source (local development):**
```bash
cd /path/to/OpenCodeRAG
npm run build                      # compile src/ → dist/
npm link                           # link local package globally
opencode-rag setup --force         # sync runtime
```

> `npm i -g opencode-rag-plugin` installs the **latest published npm version**. After making local source changes in this repo, run `npm run build && npm link && opencode-rag setup --force` instead. Running `npm i -g` from the repo directory replaces the local symlink with the published version.

### Installing without network (air-gapped)

Download the package tarball from the [GitHub Releases](https://github.com/MrDoe/OpenCodeRAG/releases) page and run:

```bash
npm install -g ./opencode-rag-plugin-<version>.tgz
opencode-rag setup
```

### Installing from source (contributors/developers)

```bash
git clone https://github.com/MrDoe/OpenCodeRAG.git
cd OpenCodeRAG
npm install --legacy-peer-deps
npm run build
opencode-rag setup --force
```

> **Note:** `--legacy-peer-deps` is only needed when developing in the cloned repo (where `@opencode-ai/plugin` is both a dev and peer dependency). End users installing via `npm install -g` never need this flag.

### Uninstall

```bash
opencode-rag setup --uninstall
npm uninstall -g opencode-rag-plugin
```

This removes all copies and config entries of OpenCodeRAG.

## Workspace Setup

The plugin, runtime and provider settings are machine-wide after `npm install -g`. Set up each workspace where you want to use OpenCodeRAG:

```bash
cd /path/to/your/workspace
opencode-rag setup
```

On the first run, `setup` offers a **one-question recommended setup** based on your Ollama backend; missing models are pulled automatically. Answer `n` to use the full wizard. Re-running `setup` syncs the files without questions.

**Recommended presets:**

| Preset | Embedding | Description | Vision |
|---|---|---|---|
| Ollama · CPU | `qwen3-embedding:0.6b` | `qwen2.5:3b` | `minicpm-v4.6` |
| Ollama · GPU | `qwen3-embedding:1.7b` | `qwen2.5:3b` | `minicpm-v4.6` |

### What a workspace contains

With the default global plugin install, a prepared workspace is small:

- `.opencode/opencode-rag.json` — repository settings only (indexing scope, chunking, retrieval, feature toggles). Provider/model settings live in the global config (`~/.config/opencode/opencode-rag.json`)
- `.opencode/skills/opencode-rag/SKILL.md` — AI agent skill file
- `.opencode/skills/make-decision/SKILL.md` — decision-model skill
- `.opencode/.gitignore` — ignores the local `rag_db/` and the log file
- `AGENTS.md` — always-loaded tool-usage directive (merged into existing content via sentinel markers; never overwrites custom text)

There are **no plugin files in the repository** and no `.opencode/node_modules` junction. OpenCode loads the plugin once from `~/.config/opencode/plugins/opencode-rag/`.

The `AGENTS.md` directive is wrapped in sentinel markers (`<!-- BEGIN opencode-rag -->` / `<!-- END opencode-rag -->`) so re-running `setup` replaces the section in-place without duplicating it.

**Vector data stays local to the workspace.** `vectorStore.path` is resolved against the repository (default `.opencode/rag_db`), so every project keeps its own LanceDB store. A shared ClickHouse backend remains an explicit opt-in (`--vector-store clickhouse`).

**Auto-scaffold:** the globally installed plugin also creates the missing workspace files on first load — useful when a repository is opened in OpenCode before running the CLI. It only creates files that do not exist and can be disabled with `setup.autoScaffold: false`.

**Legacy workspace plugin layout:** pass `--workspace-plugin` to install the plugin into `.opencode/plugins/opencode-rag/` instead of globally. This restores the previous per-repository layout (plugin entries, `.opencode/package.json`, `.opencode/node_modules` link).

### The setup wizard

`setup` asks one recommended question on the first run and with `--reconfigure`. Choosing “Custom setup” (or declining the preset) opens the detailed wizard:

1. **Provider** — Ollama (local/remote), OpenAI-compatible (llama.cpp, LM Studio, vLLM, OpenRouter, …), Cohere, Anthropic or Google.
2. **Base URL** — probed immediately; the wizard shows `✓ reachable, N models` or the exact error.
3. **API key** — only when needed. An existing `<PROVIDER>_API_KEY` environment variable or a stored key is reused; input is masked.
4. **Models** — embedding (required), description, vision and decision model (tev1), each picked from the probed model list with a manual-entry fallback. The embedding dimension is probed and stored.
5. **Optional features** — descriptions, vision, decision model, reranking, shell guard, quirk capture, ClickHouse backend.

Every question defaults to the current value, so Enter keeps an existing setup. Ctrl+C cancels without writing anything. Non-interactive runs (`--yes`, CI, piped stdin) never prompt: flags win, then the stored config, then defaults.

### Flags

- `--reconfigure` — re-open the wizard
- `--yes` — never prompt; keep the stored configuration (or use explicit flags)
- `--provider`, `--base-url`, `--api-key`, `--embedding-model`, `--description-model`, `--vision-model`, `--decision-model` — scripted configuration
- `--description [on|off]`, `--vision [on|off]`, `--decision [on|off]`, `--reranking`, `--shell-guard`, `--memory-capture` — feature toggles
- `--vector-store lancedb|clickhouse` (+ `--clickhouse-*`) — backend
- `--workspace-plugin` — per-repository plugin layout
- `--skip-install`, `--skip-health-check`, `--skip-runtime`, `--no-index` — skip steps
- `--check` — runtime and plugin-mode report

After applying the configuration, `setup` validates that your embedding provider is reachable and all configured models are available. With the recommended setup, missing Ollama models are pulled automatically; otherwise you are asked first. A failing model (expired key, wrong URL) triggers a repair prompt for that section — provider, base URL, key and model — and an on-demand image override can be removed entirely.

### Auto-tuned embedding batches (Ollama)

When generating a new `.opencode/opencode-rag.json`, `setup` probes Ollama (`GET /api/ps`) and detects whether models run on the **GPU** or **CPU**, then writes matching embedding batch settings into the `indexing` section:

| Detected backend | `embedBatchSize` | `embedConcurrency` | `ollamaMaxBatchSize` |
|---|---|---|---|
| GPU (any model in VRAM) | `40` | `4` | `40` |
| CPU | `20` | `1` | `20` |
| Ollama unreachable / undetermined | `100` (default) | `3` (default) | `100` (default) |

GPU settings (batch 40 + concurrency 4) reach ~97% of the measured GPU throughput ceiling on a GeForce RTX 4090 with `qwen3-embedding:0.6b`, while keeping batches safely under Ollama's 4096-token context window. CPU settings keep batches small and sequential since CPU throughput is flat regardless of batch size. Override any of these via `indexing.*` in the config if your workload differs.

## Running Without Global Installation

```bash
npx opencode-rag setup
npx opencode-rag index
npx opencode-rag query "your search query"
```

## npm Package

The package is published as `opencode-rag-plugin` on npm:

```bash
npm install --save-dev opencode-rag-plugin
```

> ⚠️ **Note:** Do not confuse with the npm package `opencode-rag`, which is a discontinued project by a different author.

## Verifying Your Installation

```bash
opencode-rag setup --check   # runtime + plugin mode (global/workspace)
opencode-rag status          # index statistics, store path, provider, model
```

This shows the index statistics, store path, provider, model, manifest status, and keyword index status.

## Recommended: Enable LSP

OpenCode supports Language Server Protocol (LSP) for richer code intelligence. It is recommended to enable LSP in your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "lsp": true
}
```

Then ask OpenCode to install the LSPs for the programming languages you are using. This gives agents more info about code structure and definitions, and error diagnostics to complement OpenCodeRAG's semantic search with precise type-aware context. 

## Agent Tools

Once installed, OpenCodeRAG provides three tools for AI agents to retrieve and explore code:

| Tool | Purpose |
|------|---------|
| `search_semantic` | Retrieve relevant code chunks by query or meaning |
| `get_file_skeleton` | Get structural overview of a file (functions, classes, interfaces) |
| `find_usages` | Find all references to a symbol across the codebase |

For detailed usage instructions, parameters, and examples, see the `## Code Navigation` section of the workspace's `AGENTS.md` (created by `opencode-rag setup`) or the [AGENTS.md](../AGENTS.md) file in the project root.
