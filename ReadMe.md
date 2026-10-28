# OpenCodeRAG

**A local-first toolkit that gives AI coding agents search, memory, judgment, and guardrails.**

[![npm version](https://img.shields.io/npm/v/opencode-rag-plugin.svg)](https://www.npmjs.com/package/opencode-rag-plugin)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

AI coding agents are capable, but they have four recurring weaknesses: they read whole files to find one function, they forget everything between sessions, they interrupt you with questions they could settle themselves, and they may run insecure shell commands without a second opinion.

OpenCodeRAG addresses all four in one package. This project started as semantic code search — meaning-based search over your repository — and that is still its foundation. 


- **search** (the retrieval tools)
- **memory** (quirk memory)
- **judgment** (the decision model)
- **guardrails** (Shell Guard).

 such as a **persistent memory**, **image descriptions** by a local model, integrating a **decision model** for a **pre-execution shell safety check**, and agent-maintained **knowledge documentation**.

OpenCodeRAG is primarily intended to run as an [OpenCode](https://opencode.ai) plugin, but it can also be used as a MCP server for other AI platforms, or as a shell-based standalone CLI tool.   
  
OpenCodeRAG is works fully locally by default via Ollama or OpenAI-compatible APIs.

No GPU is required to run this tool (although it is recommended). Smaller embedding models run fine on modern CPUs.


---

## Contents

- [What you get](#what-you-get)
- [Quick start](#quick-start)
- [Key terms](#key-terms)
- [How it works](#how-it-works)
- [Ways to use it](#ways-to-use-it)
- [Capabilities in detail](#capabilities-in-detail)
  - [1. Semantic code search](#1-semantic-code-search)
  - [2. Quirk memory](#2-quirk-memory)
  - [3. Decision model](#3-decision-model)
  - [4. Shell Guard](#4-shell-guard)
  - [5. Documentation and wiki modes](#5-documentation-and-wiki-modes)
  - [6. Image indexing](#6-image-indexing)
  - [7. Web UI, evaluation, and calibration](#7-web-ui-evaluation-and-calibration)
- [Tool reference](#tool-reference)
- [Configuration](#configuration)
- [Privacy and security](#privacy-and-security)
- [Limitations](#limitations)
- [Documentation index](#documentation-index)
- [Contributing and support](#contributing-and-support)
- [License](#license)

---

## What you get

| Capability | What it does for your agent | On by default |
|---|---|:---:|
| **Search** | Finds relevant code by meaning and by exact name, so the agent reads a few chunks instead of whole files | Yes |
| **Memory** | Remembers gotchas, decisions, and past tool failures across sessions | Yes |
| **Decisions** | Answers small classification, routing, and scoring questions locally, without spending agent tokens | No |
| **Protection** | Checks every shell command for destructive or malicious intent before it runs | No |
| **Documentation** | Drives the agent to document undocumented code (`/doc`) and to maintain a project wiki (`/wiki`) | Wiki: yes, Doc: no |
| **Vision** | Makes screenshots and diagrams searchable by generating descriptions | Yes |
| **Measurement** | Reports token use, retrieval quality, and decision accuracy through CLI commands and a web dashboard | CLI + dashboard |

**Why it is built this way**

- **Fewer tokens.** The agent gets the handful of relevant chunks, not entire files. A token is the unit AI models read and bill in, so this is the main cost saving.
- **Search the way code is written.** Syntax-aware chunking keeps functions and classes intact, so a result is a complete unit rather than a random slice of lines. Hybrid search catches both meaning ("where is auth handled?") and exact names.
- **Local by default.** Embeddings, the vector store, and the optional decision model run on your machine. No source code leaves the workspace unless you configure a hosted provider.
- **Scales with the repository.** Incremental indexing means only changed files are reprocessed. An optional background watcher can keep the index current while you work.

---

## Quick start

**Prerequisites:** Node.js v22+ and [Ollama](https://ollama.ai) (the default provider). Ollama is a free app that runs AI models on your own computer. OpenCode is optional; the command-line tool and the MCP server work without it.

```bash
# 1. Install the plugin and the command-line tool (once per machine)
npm install -g opencode-rag-plugin

# 2. Set up this repository and choose your models
cd /path/to/your/project
opencode-rag setup

# 3. Build the searchable index
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

Open OpenCode in the same directory and the agent can use the tools right away.

<details>
<summary><strong>What does <code>opencode-rag setup</code> do?</strong></summary>

`setup` is the only onboarding command, and it works on two levels:

- **Once per machine:** it installs the shared runtime in `~/.opencode/` and the OpenCode plugin in `~/.config/opencode/plugins/opencode-rag/`. Other repositories reuse that install; `opencode-rag update` upgrades it.
- **Once per repository:** it writes `.opencode/opencode-rag.json`, the two skill files (`.opencode/skills/opencode-rag/` and `.opencode/skills/make-decision/`), the `AGENTS.md` directive, and `.opencode/.gitignore` (which keeps the vector store out of git). The store itself lives at `.opencode/rag_db/`, so two repositories never share embeddings.

On a first run it asks **one** question — accept the recommended setup for the detected backend (usually an Ollama CPU or GPU preset with embedding, description, and vision models) — and pulls any missing models. Answer "no", or re-run with `--reconfigure`, to choose every model yourself; `--yes` never prompts and keeps the existing configuration. `--workspace-plugin` restores the per-repository plugin layout instead of the global one, and `--skip-runtime` limits a run to the workspace. Use `opencode-rag update` to upgrade the runtime to a newer release.

</details>

**The first index is the expensive step.** By default every chunk gets a one-sentence description from a local 3B model (`description.enabled`), and every image gets a vision-model description (`imageDescription.enabled`). On a CPU-only machine, `setup --description off --vision off` makes the first pass much faster. After that, indexing is incremental — a file-hash record means only changed files are reprocessed — but it is **manual by default**. Re-run `opencode-rag index` after changes, or opt into the watcher with `opencode-rag index --watch` (or `openCode.autoIndex.enabled`). `opencode-rag index --force` rebuilds from scratch.

### Optional add-ons

These are off by default and can be enabled later:

| Add-on | Enable with | Requires |
|---|---|---|
| [Shell Guard](#4-shell-guard) | `shellGuard.enabled` or `setup --shell-guard on` | tev1 via Ollama ≥ 0.35 |
| [Decision model](#3-decision-model) | `decision.enabled` or `setup --decision on` | tev1 via Ollama ≥ 0.35 |
| [Documentation mode](#documentation-mode-doc) | `documentationMode.enabled` | nothing extra |
| [Shared ClickHouse store](doc/clickhouse.md) | `vectorStore.provider: "clickhouse"` or `setup --vector-store clickhouse` | a ClickHouse server |

Two features are **on** by default and worth disabling if they do not fit your setup: [image descriptions](#6-image-indexing) (`imageDescription.enabled`, needs a vision model) and [wiki mode](#wiki-mode-wiki) (`wikiMode.enabled`).

> **Contributors:** clone the repository and run `npm install` (no special flags) followed by `npm run build`. See the [development docs](doc/development.md).

---

## Key terms

A few words recur throughout this README. None of them require a background in AI.

- **Agent** — the AI assistant that reads your request and uses tools. OpenCode is one such agent; Claude Desktop and Cursor are others.
- **Token** — the unit AI models read and bill in. Roughly ¾ of an English word; code uses more tokens per line than prose.
- **Index** — a searchable copy of your repository. Building it is a one-time or occasional step; searching it is fast.
- **Embedding** — a numeric fingerprint of a piece of text. Texts with similar meaning get similar fingerprints, which is what makes meaning-based search possible.
- **Vector store** — the database that holds embeddings and finds near neighbours quickly. LanceDB is the default; ClickHouse is an optional shared alternative.
- **Chunk** — one complete unit of code or documentation: a function, method, class, interface, or section.
- **Quirk** — one short fact worth remembering across sessions: a gotcha, preference, decision, or environment constraint.
- **MCP** — Model Context Protocol, a standard plug that lets AI tools call external services. OpenCodeRAG can serve its tools over MCP to clients other than OpenCode.

---

## How it works

```text
Workspace files
   │  syntax-aware chunking
   ▼
Chunks ─────► embeddings ─────► vector store (LanceDB by default)
   │
   └─────────► keyword index (word frequencies)

Query ─► meaning search + keyword search ─► weighted rank fusion ─► top chunks
```

1. **Index.** Files are split into semantic chunks, described by a local model by default, embedded, and stored next to a keyword index. A file-hash record means only changed files are reprocessed.
2. **Retrieve.** The query is embedded and matched against both signals. The two ranked lists are fused and post-processed (deduplication, per-file limits, adjacent-chunk merging) to fit the context window.
3. **Use.** The agent calls `search_semantic`, `get_file_skeleton`, or `find_usages` instead of reading entire files.

A few details make the difference:

- **A chunk is a complete unit.** It is a function, method, class, interface, or documentation section — not a fixed window of lines. That is why a result can be quoted directly into the conversation without splicing in unrelated code, and why `get_file_skeleton` shows the same boundaries.
- **The two searches answer different questions.** The meaning search handles paraphrase ("where is authentication handled?"). The keyword search rescues exact identifiers that embeddings blur, such as `resolveWorkspacePath`.
- **The rankings are combined with weights.** Each result earns points for ranking high in the meaning list and points for ranking high in the word list. `keywordWeight` decides how much the word list counts. A result near the top of both lists wins; a result found by only one list can still qualify, but its maximum score is lower.
- **Indexing is incremental, but not automatic.** A file-hash record keeps a rebuild cheap. The background watcher is opt-in; otherwise the index is a snapshot until you run `opencode-rag index` again.

The other capabilities build on the same foundation. Quirk memories, for example, are embedded and stored in the same vector store as your code.

---

## Ways to use it

| Mode | Best for | How to start |
|---|---|---|
| **OpenCode plugin** | Day-to-day agent work with the full feature set (hotkeys, memory, Shell Guard, `/doc`, `/wiki`) | `opencode-rag setup`, then open OpenCode |
| **MCP server** | Claude Desktop, Cursor, and any other MCP-compatible client | `opencode-rag mcp` (your client launches it) |
| **CLI** | Scripts, CI, and manual exploration | `opencode-rag <command>` |

### With OpenCode

- **Discovery.** Workspace setup creates `.opencode/skills/opencode-rag/SKILL.md` (tool workflow) and `.opencode/skills/make-decision/SKILL.md` (decision-model guidance). Agents load them on demand, so idle sessions pay almost no token cost. When the index contains chunks, a brief tool list is also added to the system prompt; it is skipped when nothing is indexed.
- **Hotkeys.** While typing a prompt, `Ctrl+Enter` appends a list of relevant files, and `Ctrl+Alt+Enter` appends the actual code chunks. The search uses the text you have typed; if the prompt is empty, a toast reminds you to type first. Results land directly in the prompt as code blocks with file paths, line ranges, and relevance scores.
- **Read override.** A normal `read` can return the file plus supplementary RAG chunks that are relevant to the surrounding work.
- **Settings.** Models, retrieval options, and keybindings are configurable in the TUI settings panel (`Alt+S` or `/rag-settings`). If you rebind the settings key, prefer `alt+<letter>`: some terminals, including VS Code's integrated terminal, do not deliver `ctrl+shift+<letter>`.
- **`AGENTS.md` directive.** Workspace setup merges a tool-usage directive into `AGENTS.md` using sentinel markers.

### With other MCP clients

```bash
opencode-rag mcp
```

This starts an MCP server over standard input/output. Your client must launch it — a server cannot attach itself to a client. The OpenCode plugin does not start it, because inside OpenCode the same tools are registered directly; `mcp.enabled` only writes a hint to the log. Configure the command in your MCP client (Claude Desktop, Cursor, and others), and the client will expose the five tools listed below.

### From the CLI

```bash
opencode-rag setup        # install the runtime, scaffold the workspace, run the model wizard
opencode-rag index        # build or update the index
opencode-rag query "..."  # search from the terminal
opencode-rag status       # index health and coverage
opencode-rag ui           # open the web dashboard
```

Further commands: `list`, `show <file>`, `dump`, `clear`, `describe-image`, `decide`, `mcp`, `update`, `clickhouse`, `quirk`, and the `eval:*` family. Run `opencode-rag --help` or see the [CLI reference](doc/cli.md).

---

## Capabilities in detail

### 1. Semantic code search

The core of the project. It answers natural-language queries with the most relevant code. "Semantic" means the query does not need to contain the same words as the code; the meaning search finds code that does the same thing, while the keyword half adds precision for exact names.

- **Languages and formats.** Syntax-aware chunking for 26 languages via tree-sitter, a parser that understands code structure. It also handles documents (Markdown, LaTeX, PDF, DOCX, Excel) and images.
- **Hybrid search.** Meaning-based vector search combined with a word-frequency keyword index. The keyword index is repaired from the store whenever it drifts behind, so it never covers only part of the corpus.
- **Context optimization.** Deduplication, per-file chunk limits, and adjacent-chunk merging keep the result set small and coherent.
- **Configurable parsers.** Remap file extensions to any parser (for example `.c` → `cpp`). The override applies to chunking, `get_file_skeleton`, and read labels ([docs](doc/chunking.md#parser-overrides-per-extension-chunkingparsers)).
- **Alternate providers.** Embeddings via Ollama, OpenAI-compatible endpoints, or Cohere. Descriptions and vision via Ollama, Anthropic, Google Gemini, OpenAI-compatible endpoints, or OpenCode Zen.
- **Scale.** Incremental indexing and automatic rebuild on corruption. The optional ClickHouse backend provides one shared index across machines and workspaces, with an approximate-nearest-neighbour index, epoch rebuilds, and state sync ([docs](doc/clickhouse.md)).

### 2. Quirk memory

Quirk memory gives the agent a **persistent, cross-session memory** of non-obvious facts: gotchas, preferences, decisions, and environment constraints. The agent stops repeating the same mistake and accumulates project knowledge over time.

A **quirk** is one short, self-contained fact that a future session cannot infer from the code. Example: "LanceDB's IVF index must use cosine; the default `l2` silently falls back to brute force." Quirks live in `.opencode/rag_db/quirks.jsonl` (the source of truth) and are mirrored into the same vector store as your code. Recall is therefore an ordinary similarity search, and a full rebuild does not forget them.

**Where memories come from**

Four things write memory:

- **You.** The `add_quirk` tool or `opencode-rag quirk add`.
- **A failed tool call.** A deterministic template built from the tool name and error text, with no LLM involved. These quirks are tagged `tool-error` and kept for *future* sessions.
- **Passive capture.** A turn that contains an error signal is summarized by the description model. It does not run on every turn.
- **Session-end extraction.** The full transcript is summarized by the description model when a session ends.

The last two are enabled in the shipped configuration (`memory.passiveCapture`, `memory.sessionEndExtraction`) and require `description.enabled`; each pass adds at most 2 quirks and drops candidates that are 0.85 lexically similar to an existing quirk.

**How memory reaches the agent**

- **Auto-injection.** On each user message, matching quirks are added to the prompt only when their raw similarity is at least `autoInjectMinScore` (0.75) and they share at least 2 word tokens with the current message. Each quirk is injected at most once per session, and a 2-second latency budget skips injection rather than delaying the turn.
- **After a failure.** If a tool call fails, the plugin looks for a matching quirk and injects it into the next request. If none exists, it creates one. Creation is limited to 2 per session, with a 10-minute cooldown per error, and is skipped when a quirk for the same tool and cause already exists.
- **Before the model picks a tool.** Known, repeatable failure patterns are added to the system prompt in advance, scoped to the tools available in that session. Transient problems such as rate limits are never predicted, because the next call will not fail the same way.
- **Manual recall.** `recall_quirks` uses the looser `recallMinScore` (0.72). Raise it to 0.85 to keep unrelated quirks out of unrelated tasks.

**Safety.** Every `add_quirk` and every content-changing `update_quirk` passes an immutable trust monitor that rejects destructive patterns (`rm -rf`, `force push`, `bypass security`).

**Manual control from the CLI**

```bash
opencode-rag quirk add "npm needs --legacy-peer-deps" --type gotcha --tag installation
opencode-rag quirk list
opencode-rag quirk update <id> --content "..." --type decision
opencode-rag quirk rm <id>
opencode-rag quirk lint            # flag low-confidence, stale, or duplicate quirks
opencode-rag quirk test "npm needs --legacy-peer-deps"
```

See the [plugin docs](doc/plugin.md#9-quirk-memory-experiential-memory) and the [CLI reference](doc/cli.md#quirk).

### 3. Decision model

A small local model answers fast **classification, routing, policy, and scoring questions**, so the agent does not spend its own tokens on them. OpenCodeRAG uses Together AI's [tev1](https://ollama.com/library/tev1) via Ollama's `/v1/systemone` endpoint.

It is not a chat model. It does not write prose; it scores a short `state` against 1 to 64 named questions and returns the chosen option with probabilities, typically in **40 to 150 ms warm**.

| Question type | Use it for | Example |
|---|---|---|
| `choice` | Pick one of 2 to 24 options | "Which support intent is this?" → duplicate_charge / cancel / none |
| `noul` | True/false probability | "Does the customer explicitly ask for a refund?" |
| `score` | Place the input on a rubric | "How severe is this incident?" → cosmetic … critical |

For example, a support message can be classified as `duplicate_charge` with 0.97 confidence, and a second question can answer "Does the customer explicitly ask for a refund?" with p=0.96 — both in one call. The answer is a probability distribution over the options you named, not generated text.

**Setup**

```bash
ollama pull tev1:0.8b   # 812 MB, fast: good for quick labels and CI
ollama pull tev1:4b     # 4.4 GB, more accurate: recommended for scoring
```

Requires Ollama ≥ 0.35. **Disabled by default.** Opt in with `decision.enabled`; the shipped default model is `tev1:4b`, while `tev1:0.8b` is the faster choice. Every option is in the [configuration reference](doc/configuration.md#decision).

**Using it well**

- Always include a `none` or "cannot be determined" option.
- Keep `state` to the relevant excerpt. The effective context is about 2k tokens, and the request is capped at 8,000 characters.
- `confidence` is how concentrated the answer is, not the chance that it is correct. A 0.97 means the model barely hesitated; it does not mean the answer is right. Treat anything below about 0.3 as undecided.
- Do not use it for factual recall, or as the only check for high-stakes decisions.

**Endpoint note.** `decision.provider` is fixed to `ollama` because the request and response shape is Ollama's `/v1/systemone`. `baseUrl` can point at any server that speaks that protocol, including a llama-swap or llama.cpp proxy.

**Pre-ask routing (optional).** With `decision.routeBeforeAsking: true`, the agent is told to resolve option choices through `make_decision` before asking you. It proceeds on a confident answer and asks only when the model is undecided or the choice is a matter of preference. Off by default.

`opencode-rag decide` exposes the same engine from the CLI, and workspace setup creates a dedicated `make-decision` agent skill. See the [plugin docs](doc/plugin.md#make_decision) and the [configuration reference](doc/configuration.md#decision).

### 4. Shell Guard

The same decision model can vet **every shell command before it runs**. With `shellGuard.enabled: true`, each `shell` or `bash` call is classified for destructive and malicious intent. If the probability of either intent reaches the threshold, the command is escalated to OpenCode's confirmation prompt with the full verdict — the probabilities plus a risk category. Otherwise it runs unchanged.

Shell Guard is a policy hook, not a wrapper around the shell. It runs in OpenCode's permission `evaluate` step: it reads the command text, asks the decision model two questions, and sets the permission effect to `ask` when either answer crosses the line. It never executes the command and never sees its output. A clean verdict simply leaves the normal permission flow untouched.

| Aspect | Behavior |
|---|---|
| **Default** | Off. Enabling it adds one local model call to every shell command. |
| **Speed** | A warm verdict takes about 200 to 230 ms. Example: `rm -rf ./dist` → 0.96 destructive; `ls -la src` → 0.23, allowed. |
| **What it sees** | The command string only, capped at 8,000 characters with the middle elided. Head and tail are kept because destructive payloads usually sit at one end; a payload hidden in the middle of a very long command can therefore survive. |
| **On failure** | Fail-open by default (`onError: "allow"`): if the classifier is down or times out, the command runs and a warning is logged. Set `"ask"` to require confirmation instead. |
| **Cache** | Verdicts are cached for 10 minutes (256 entries). The key includes the provider, base URL, model, and command, and cached probabilities are re-scored against the current threshold on every call. |
| **Scope** | Put the block in `~/.config/opencode/opencode-rag.json` to apply it to every workspace. A workspace config can still override or disable it. |
| **Live config** | Edits to `opencode-rag.json` apply without a restart. |
| **Backend** | Defaults to the `decision` section. Any `/v1/systemone` endpoint works, for example a llama-swap proxy serving Clef-Flash. |

Every verdict is logged under `scope: shell.guard`, so you can tune the threshold against real commands. Shell Guard is a safety net, not a sandbox: a command you approve runs with your full permissions, and a harmful command the model misses is not caught. See the [configuration reference](doc/configuration.md#shellguard) and the [plugin docs](doc/plugin.md#shell-guard-command-vetting).

### 5. Documentation and wiki modes

Two documentation modes turn the agent into a documentation maintainer.

#### Documentation mode (`/doc`)

Off by default. When `documentationMode.enabled` is `true`, the plugin adds a `/doc` slash command that drives the agent to add JSDoc/TSDoc comments to undocumented source files. No agent tools are registered; it works entirely through the slash command and a documentation system prompt.

**Workflow**

1. Type `/doc` to list all undocumented files, grouped by subdirectory.
2. The agent picks a subdirectory and documents every public symbol, preserving existing comments and implementation code.
3. Type `/doc src/auth/` to mark that subdirectory complete.

Progress is saved in `.opencode/rag_db/doc-mode-progress.json`, so later sessions resume where you left off. See the [plugin docs](doc/plugin.md#5-documentation-mode--slash-command-doc).

#### Wiki mode (`/wiki`)

On by default. When `wikiMode.enabled` is `true`, the plugin injects a wiki-maintainer system prompt. The agent builds and maintains a persistent knowledge wiki in `.opencode/wiki/`: interlinked markdown pages that synthesize knowledge from the codebase, docs, and conversations.

The wiki has a small, predictable shape:

- `index.md` — the catalog of every page.
- `log.md` — an append-only timeline of changes.
- `entities/` — modules, services, and key classes.
- `concepts/` — patterns, conventions, and gotchas.
- `sources/` — summaries of external material.

| Command | Action |
|---|---|
| `/wiki` | Show wiki status (page count, subdirectories, index and log presence, latest log entry) |
| `/wiki seed` | Generate the initial wiki from the README, file structure, and code patterns |
| `/wiki lint` | Health-check for orphan pages, stale source references, contradictions, and missing cross-links |

The agent maintains the pages during normal coding sessions; you do not write them yourself. The wiki lives in `.opencode/`, so it is git-trackable and every edit is a diff. Because the wiki prompt is injected into every session, it costs some context; disable `wikiMode.enabled` if you do not want it. See the [plugin docs](doc/plugin.md#6-wiki-mode--slash-command-wiki).

### 6. Image indexing

Image files (PNG, JPEG, WebP, and others) are sent to a vision-capable LLM, and the generated descriptions are stored as searchable chunks. Visual assets then become discoverable with natural-language queries such as "login screen screenshot" or "architecture diagram".

- **Providers:** Ollama, OpenAI, Anthropic, Google Gemini, and OpenCode Zen (`opencode` / `opencode-go`) compatible providers.
- **On by default.** Set `imageDescription.enabled: false` to skip image files entirely. This is recommended if you have no vision model or no GPU, because image descriptions are the one feature that really wants a GPU to be pleasant.
- **On-demand inspection.** The `describe_image` tool lets an agent inspect an image on demand, without waiting for an index pass. It uses the `imageDescription.onDemand` overrides, so you can point it at a different model without re-indexing.
- **Privacy.** The image bytes are sent to the configured vision provider. With the default Ollama setup, that provider is local.

### 7. Web UI, evaluation, and calibration

**Web UI.** A browser dashboard for exploring the vector database: browse, visualize, and inspect chunks, and evaluate OpenCode sessions by retrieved chunks and consumed tokens. Launch it with `opencode-rag ui` (the default port is 3210). See the [Web UI docs](doc/webui.md).

[![OpenCodeRAG Web UI](doc/assets/webui-3d.png)](doc/assets/webui-3d.png)

**Does it actually save tokens?** Session-level analysis compares RAG-on against RAG-off, using tiktoken BPE (`cl100k_base`) for code tokenization:

```bash
opencode-rag eval:sessions          # list sessions
opencode-rag eval:analyze <id>      # detailed breakdown
opencode-rag eval:compare <A> <B>   # side-by-side comparison
```

**Is retrieval good enough?** A separate harness measures quality:

| Command | Purpose |
|---|---|
| `opencode-rag eval:gate` | Runs the labelled golden set and exits non-zero when Hit@5, MRR, or nDCG@10 drop below the floors (defaults 0.35 / 0.25 / 0.32). Useful as a CI regression gate. |
| `opencode-rag eval:decide` | Measures the decision model's accuracy, calibration (ECE), and Brier score on a labelled set. |
| `opencode-rag eval:tune` | Sweeps the retrieval fusion weights and cut-offs against the golden set and reports the best configuration for your setup. |

The labels are repository-local: `src/eval/rerank-labels.json` for retrieval and `src/eval/decide-labels.json` for decisions, or pass `--labels` with your own file. This is a regression harness for a project with labelled queries, not a generic benchmark.

`eval:tune` reports how strong the evidence is: a paired-bootstrap confidence interval, win/loss counts, and an exact sign test. When the interval includes zero or the sign test is above 0.05, it prints "weak evidence" instead of pretending that an argmax on a small sample is a measurement. A reference run on 48 labels with a code embedding model scored 68.8% Hit@5 at `keywordWeight=0.4` and 81.3% at `keywordWeight=0`, with a sign test of p≈0.20. The direction is consistent; the sample is too small to treat either number as settled. See the [evaluation docs](doc/evaluation.md).

---

## Tool reference

### MCP tools (plugin and MCP server)

Inside OpenCode the plugin registers these in-process. Over MCP they are served by `opencode-rag mcp`.

| Tool | What it does | When the agent uses it |
|---|---|---|
| `search_semantic` | Hybrid vector and keyword search over the indexed code | Before a code task, instead of reading whole files |
| `get_file_skeleton` | Structural outline of a file (functions, classes, methods) | To orient in a large file before reading it |
| `find_usages` | Every reference to a symbol | Before editing a function, class, or variable |
| `describe_image` | Describes an image with the configured vision model | When the task involves a screenshot, diagram, or other asset |
| `make_decision` | Classifies, routes, or scores short text (needs `decision.enabled`) | When the answer reduces to a choice, a yes/no check, or a rubric score |

### Plugin-only tools (OpenCode)

Registered by the OpenCode plugin, not served over MCP.

| Tool | What it does |
|---|---|
| `recall_quirks` | Recalls stored gotchas, preferences, and decisions from past sessions |
| `add_quirk` | Stores a new non-obvious fact, workaround, or convention |
| `update_quirk` | Corrects a stored quirk that is outdated or wrong |
| `delete_quirk` | Removes a quirk that is fixed, obsolete, or no longer applies |

### Slash commands and hotkeys (OpenCode)

| Input | Action |
|---|---|
| `Ctrl+Enter` | Append a relevant file list to the prompt |
| `Ctrl+Alt+Enter` | Append full code chunks to the prompt |
| `/rag-settings` or `Alt+S` | Open the settings panel |
| `/doc` | Documentation mode (if enabled) |
| `/wiki`, `/wiki seed`, `/wiki lint` | Wiki mode |

### A typical retrieval loop

1. `search_semantic` finds candidate code by meaning or exact name.
2. `get_file_skeleton` shows the structure of a promising file.
3. The agent reads only the relevant lines.
4. `find_usages` checks every place a symbol is used before it is changed.

This is the loop that replaces "read the whole file and hope".

---

## Configuration

Settings are stored as JSON, but you rarely edit them by hand: `setup` writes the model choices, and the TUI settings panel edits the rest. Two files are used:

| File | Purpose |
|---|---|
| `.opencode/opencode-rag.json` | Workspace settings, committed with the project |
| `~/.config/opencode/opencode-rag.json` | Machine-wide settings, including provider, model, base URL, and API key choices |

Provider options describe which models *this machine* serves, so the settings panel saves them only in the global file; they never land in a committed repository file when you configure models through setup or the UI. The layers merge recursively: shipped defaults < global file < workspace file. A workspace file overrides only the keys it sets.

The [configuration reference](doc/configuration.md) documents every option and every default. This README deliberately keeps configuration examples there rather than here.

**What is on by default**

| Feature | Default | Where to change it |
|---|---|---|
| Search | on | always available |
| Memory | on | `memory.enabled` |
| Auto-index watcher | off | `openCode.autoIndex.enabled` or `index --watch` |
| Shell Guard | off | `shellGuard.enabled` |
| Decision model | off | `decision.enabled` |
| Image descriptions | on | `imageDescription.enabled` |
| Wiki mode | on | `wikiMode.enabled` |
| Documentation mode | off | `documentationMode.enabled` |
| Update check | on | `autoUpdate.enabled` |

One small difference worth knowing: `retrieval.topK` defaults to 20 for the agent's retrieval, while `opencode-rag query` defaults to 10 results. Use `--top-k` to change the CLI.

---

## Privacy and security

- **Local by default.** Embeddings are generated locally via Ollama, and the vector database stays in `.opencode/rag_db/` inside your project. `.opencode/.gitignore` keeps it out of git. No source code or embeddings leave your machine unless you explicitly configure a third-party API.
- **Hosted providers.** If you configure a hosted embedding, description, or vision provider, the code chunks, descriptions, or image bytes are sent to that provider. With the default Ollama setup, all three stay local.
- **Shell Guard** sends the command text only to the decision-model endpoint you configure (local Ollama or a local proxy), never the command's output.
- **Decision model** is only asked about short excerpts that you or the agent pass in.
- **Memory** uses the description model for passive capture and session-end extraction. If the description provider is hosted, that exchange text leaves the machine. Set `memory.passiveCapture` and `memory.sessionEndExtraction` to `false` to keep extraction manual.
- **Update check.** With `autoUpdate.enabled` on (the default), the plugin asks GitHub whether a newer release exists. No source code is sent, and `autoInstall` is off unless you turn it on.
- **Trust monitor.** Every quirk write passes an immutable trust monitor that rejects destructive patterns.
- **No analytics.** There is no telemetry service; the only network calls are the model providers you configure and the update check.

---

## Limitations

- **Retrieval quality depends on the embedding model.** Small CPU-friendly models trade accuracy for speed. Measure with `eval:gate` and `eval:tune` rather than assuming a default.
- **Image descriptions need a vision model.** This is the one feature that meaningfully wants a GPU to be pleasant. Disable it with `imageDescription.enabled: false` if you have none.
- **Shell Guard costs one model call per shell command** (about 200 ms warm) and fails open by default. It is a safety net, not a sandbox, and it sees only the command text — a payload hidden in the middle of a very long command can survive.
- **The decision model needs an endpoint that speaks `/v1/systemone`.** Ollama ≥ 0.35 works; so does a compatible llama-swap or llama.cpp proxy. The provider setting itself is fixed to the `ollama` request shape.
- **ClickHouse is opt-in** and needs a running server. LanceDB is the default and needs none.
- **Wiki and documentation modes add context.** Wiki mode injects a system prompt into every session; documentation mode adds a slash command and a system prompt only when enabled.
- **Node.js v22+ is required.**
- **This README is the entry point, not the manual.** Deep dives live in [`doc/`](doc/).

---

## Documentation index

This README is the entry point. Deep dives live in [`doc/`](doc).

| Document | Contents |
|---|---|
| [Architecture](doc/architecture.md) | Module design, data flow, tech stack |
| [Installation](doc/installation.md) | Full install guide, global setup, uninstall |
| [Configuration](doc/configuration.md) | All options, defaults, and merge rules |
| [Chunking](doc/chunking.md) | Language matrix, adding new chunkers, custom chunkers |
| [Embedding](doc/embedding.md) | Providers, model recommendations, proxy, dimension probing |
| [ClickHouse store](doc/clickhouse.md) | Central vector store: setup, epochs, ANN, multi-machine sync |
| [Retrieval](doc/retrieval.md) | Pipeline, hybrid search, score fusion, caching |
| [Plugin](doc/plugin.md) | OpenCode integration, tools, hooks, TUI, troubleshooting |
| [CLI reference](doc/cli.md) | All commands, options, examples |
| [Web UI](doc/webui.md) | Dashboard, chunk browser, file explorer, compare view |
| [Evaluation](doc/evaluation.md) | Token analysis, session logging, benchmark runner, accuracy guide |
| [Development](doc/development.md) | Setup, testing, conventions, adding providers |
| [Troubleshooting](doc/troubleshooting.md) | Common issues, logging, debugging |
| [Roadmap](doc/roadmap.md) | Completed items, short-, mid-, and long-term plans |

---

## Contributing and support

- **Development setup, conventions, and testing:** clone the repository, run `npm install` (no special flags) and `npm run build`. Then `npm test`, `npm run typecheck`, and `npm run test:integration` as needed. See [doc/development.md](doc/development.md).
- **Troubleshooting and logging:** [doc/troubleshooting.md](doc/troubleshooting.md)
- **Bugs and feature requests:** [GitHub Issues](https://github.com/MrDoe/OpenCodeRAG/issues)
- **Roadmap:** [doc/roadmap.md](doc/roadmap.md)

## License

[MIT](LICENSE)
