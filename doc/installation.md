# Installation

## Prerequisites

- **Node.js v22+** (required for native ESM and global `fetch`)
- **Ollama** (default) running locally, OR an OpenAI-compatible API endpoint
- **OpenCode** (optional) for agent plugin features

## Ollama Setup

If you don't have Ollama installed, download it from [ollama.com](https://ollama.com) and start the service. Then pull the required model:

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

> **Tip:** Smaller embedding models (≤3B) work well on CPU. For better search results, use a larger embedding model like `qwen3-embedding:1.7b` and activate description and image descripion model usage in OpenCodeRAG config (dedicated GPU recommended).

## Install

### Quick install (recommended)

```bash
# Install globally via npm
npm install -g opencode-rag-plugin

# Set up the OpenCode runtime
opencode-rag setup

# Initialize in your project
cd /path/to/your/project
opencode-rag init
```

Tree-sitter grammars ship as pre-built WASM files (bundled in `wasm/` and `@vscode/tree-sitter-wasm`). Native dependencies (`sharp`, `@lancedb/lancedb`) use pre-built platform binaries. The plugin is workspace-local — OpenCode loads it from `.opencode/plugins/`. Data (vector store, manifest) lives in the workspace.

### Updating

The global CLI (`~/.local/bin/opencode-rag`) is a thin wrapper that runs `node ~/.opencode/node_modules/opencode-rag-plugin/dist/cli.js`. To update:

**From npm (published release):**
```bash
npm update -g opencode-rag-plugin
opencode-rag setup               # sync the runtime symlink
opencode-rag init                 # update workspace files (AGENTS.md, skill, config)
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

## Workspace Initialization

The install script only installs the CLI globally. Initialize each workspace where you want to use OpenCodeRAG:

```bash
cd /path/to/your/project
opencode-rag init
```

This creates:
- `opencode-rag.json` — Workspace-specific RAG configuration
- `.opencode/plugins/rag-plugin.js` — Plugin entry (re-exports from workspace `node_modules/`)
- `.opencode/plugins/rag-tui.js` — TUI plugin module
- `.opencode/opencode.json` — OpenCode workspace config
- `.opencode/tui.json` — TUI plugin settings
- `.opencode/package.json` — Workspace dependencies (links to the globally-installed plugin)
- `.opencode/skills/opencode-rag/SKILL.md` — AI agent skill file
- `.opencode/.gitignore` — ignores `node_modules/` and `rag_db/`
- `AGENTS.md` — Always-loaded tool-usage directive (merged into existing content, never overwrites)
- Runs `npm install` to install workspace dependencies

The `AGENTS.md` directive is wrapped in sentinel markers (`<!-- BEGIN opencode-rag -->` / `<!-- END opencode-rag -->`) so re-running `init` replaces the section in-place without duplicating it. Existing content outside the markers is always preserved.

Use `--skip-install` to skip the npm install step. Use `--force` to overwrite existing files. Use `--skip-health-check` to skip provider validation (useful in offline environments).

After writing config, `init` validates that your embedding provider is reachable and all configured models (embedding, description & visual) are available. For Ollama, if models are missing, you will be asked to pull them automatically.

## Running Without Global Installation

```bash
npx opencode-rag init
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
opencode-rag status
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

For detailed usage instructions, parameters, and examples, see the `## Code Navigation` section of the workspace's `AGENTS.md` (created by `opencode-rag init`) or the [AGENTS.md](../AGENTS.md) file in the project root.
