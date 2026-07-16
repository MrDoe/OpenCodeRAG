# OpenCode Plugin Integration

OpenCodeRAG integrates with OpenCode as a plugin, providing semantic code search directly within agent conversations.

## How the Plugin Works

The plugin (`src/plugin.ts`) registers several integration points with OpenCode:

### 1. General-Purpose Retrieval: `search_semantic`

The primary retrieval tool that any OpenCode agent can invoke to search the indexed codebase:

**Parameters:**

| Param | Required | Description |
|---|---|---|
| `query` | Yes | Narrow, specific search query |
| `pathHints` | No | Up to 10 path filters (e.g., `["src/auth/"]`) |
| `languageHints` | No | Up to 10 language filters (e.g., `["typescript"]`) |
| `topK` | No | Result count (1–25, default 10) |

**Returns:** Formatted markdown with file paths, line ranges, score, language, content preview, and descriptions for each relevant chunk.

### Specialized Agent Tools

For autonomous agent workflows, the plugin also registers smaller, focused tools that are more efficient than the general-purpose tool for specific tasks:

| Tool | Purpose | Args |
|------|---------|------|
| `get_file_skeleton` | Structural file overview via tree-sitter AST | `filePath` (req) |
| `get_file_skeleton` | Structural file overview via tree-sitter AST | `filePath` (req) |
| `find_usages` | Find all references to a symbol | `symbolName` (req), `pathHint?`, `topK?` |
| `describe_image` | Retrieve stored description of an indexed image | `filePath` (req) |

#### `search_semantic`
Conceptual code search — answers questions like *"How does authentication work?"* or *"Where is the chunking logic?"*. Uses vector + hybrid keyword search and returns the most relevant code snippets with file paths, line numbers, and relevance scores.

#### `get_file_skeleton`
Provides a quick structural overview of a source file without reading its full contents. Uses tree-sitter to parse the file's AST and extract top-level declarations:

- Functions, methods, arrow functions
- Classes, interfaces, types, enums
- Struct, trait, impl blocks (Rust), protocol declarations (Swift)
- CSS rule sets, Markdown headings

**Supported languages:** TypeScript, JavaScript, Python, Java, Go, Rust, C, C++, C#, Ruby, Swift, Kotlin, CSS, Markdown. Falls back to regex-based extraction or simple line count for unrecognized formats.

**Example output:**
```
Skeleton — src/plugin.ts
24 structural elements (9 function, 4 class, 3 interface, ...)

ƒ createRagHooks  L398-L605
ƒ buildRetrievalQuery  L193-L207
□ TreeSitterChunker  L22-L58
...
```

#### `find_usages`
**Essential before editing a function, type, or variable.** Searches the indexed codebase for references to a given symbol and returns line-level matches with 2 lines of surrounding context:

1. **Keyword index search** (fast, precise) — matches the symbol token in the inverted index
2. **Vector store search** (broader) — finds semantically related references
3. **Line extraction** — within each matching chunk, identifies the specific lines containing the symbol (excluding its own definition) and returns them with surrounding context

**Output format:** Table grouped by file, showing line numbers and code excerpts.

```
Usages of "createRagHooks" — 5 references across 2 files

### src/plugin.ts (typescript)
| Line | Code |
|------|------|
| 521 | const findUsagesTool = createFindUsagesTool({ ... |
| 615 | return createRagHooks({ cfg, storePath, ... |

### src/__tests__/plugin.test.ts (typescript)
| Line | Code |
|------|------|
| 178 | const hooks = createRagHooks({ ... |
```

#### `describe_image`

Returns the pre-generated natural-language description for an indexed image file. Does not re-run the vision model — it retrieves the stored description created at index time.

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| `filePath` | Yes | Path to the image file (relative or absolute) |

**Returns:** Markdown block with file path and the stored description text.

### 2. `chat.message` Hook — Hotkey-Activated Injection

The plugin captures `message.part.updated` events to accumulate the **last assistant message's text**. When you trigger injection via hotkey, the search query combines:

```
[Last assistant response]
[Current user prompt]
```

This 2-message query provides the embedding model with conversation context for more relevant code retrieval. On the first turn (no prior assistant message), only the user prompt is used.

RAG context is **appended directly to the user's message text** (not pushed as a separate part), matching the `/doc` handler pattern that avoids duplication.

Use the hotkeys:
- **Ctrl+Enter** — Injects a file suggestion list
- **Ctrl+Alt+Enter** — Injects full code chunks

### 3. Agent Skill Discovery

`opencode-rag init` creates `.opencode/skills/opencode-rag/SKILL.md` — an OpenCode skill that teaches agents the recommended tool workflow. This is the primary discovery mechanism:

- Agents see the skill listed in the `skill` tool description
- Loading it injects the workflow guidance into the conversation
- Zero ongoing token cost — only loaded when the agent chooses to load it

The skill teaches the workflow: skeleton → find_usages → search → read → edit.

### 4. System Prompt Guidance (Always)

The `experimental.chat.system.transform` hook prepends a tool list to the system prompt on every message, ensuring agents always know the tools are available — even before the index is built.

### 5. Documentation Mode — Slash Command (`/doc`)

When `documentationMode.enabled` is `true`, the plugin provides a `/doc` slash command for documenting the codebase. No agent tools are registered — documentation is driven entirely through the slash command.

**Configuration:**

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | Enable documentation mode |
| `systemPrompt` | *(built-in)* | System prompt for the documentation agent |

**How it works:**

1. **User types `/doc`** — The `chat.message` hook intercepts the slash command and returns a list of all undocumented files, grouped by subdirectory.

2. **Agent picks a subdirectory** — The agent reads the file list, chooses a subdirectory, and documents all files within it:
   - Calls `get_file_skeleton(filePath)` to understand file structure
   - Calls `read` to get full file contents
   - Adds/updates JSDoc/TSDoc comments on public symbols
   - Preserves existing comments

3. **Agent marks subdirectory complete** — When done, the agent types `/doc src/auth/` (or similar) to mark that subdirectory as documented. The plugin updates the progress tracker and shows remaining files.

4. **Progress tracking** — Documented files are recorded in `.opencode/rag_db/doc-mode-progress.json`. On subsequent sessions, the `/doc` command resumes where it left off.

**Workflow:**
```
User:     /doc
Plugin:   ## Documentation — lists all files grouped by subdirectory
Agent:    picks a subdirectory, documents files
Agent:    /doc src/auth/
Plugin:   marks src/auth/* as documented, shows remaining files
Agent:    picks next subdirectory, repeats
```

**Config example:**
```json
{
  "documentationMode": {
    "enabled": true,
    "batchSize": 5
  }
}
```

### 6. Wiki Mode — Slash Command (`/wiki`)

When `wikiMode.enabled` is `true`, the plugin injects a system prompt that instructs the host agent to build and maintain a persistent knowledge wiki at `.opencode/wiki/`. No agent tools are registered — wiki maintenance is driven entirely through the injected system prompt and the `/wiki` slash command.

**Configuration:**

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | Enable wiki mode |
| `systemPrompt` | *(built-in)* | System prompt for the wiki maintainer agent |

**How it works:**

1. **System prompt injection** — When wiki mode is enabled, the plugin injects the wiki maintenance protocol into the system prompt at session start. The protocol defines the wiki layout (`.opencode/wiki/index.md`, `log.md`, `entities/`, `concepts/`), page frontmatter conventions, and the three operations: **Ingest** (extract and synthesize new knowledge), **Query** (route through the index first, fall back to `search_semantic`), and **Lint** (health-check for orphans, stale pages, contradictions).

2. **Agent writes the wiki** — The host agent creates and maintains all wiki pages during coding sessions, following the injected protocol. The user never writes wiki pages directly.

3. **`/wiki` status** — Shows the current state of `.opencode/wiki/`: page count, subdirectories, whether `index.md` and `log.md` exist, and the latest log entry.

4. **`/wiki lint`** — Instructs the agent to health-check the wiki for orphan pages, stale entries (source drift), contradictions, and missing cross-references. Findings are appended to `log.md`.

5. **`/wiki seed`** — Instructs the agent to generate the initial wiki from existing sources: README, file structure via `get_file_skeleton`, common conventions from code patterns. Creates `index.md`, `log.md`, and initial entity/concept pages.

**Workflow:**
```
User:     /wiki seed
Agent:   scans README, file tree, code patterns → creates initial wiki pages
User:     /wiki
Plugin:  shows wiki status (pages, index, log, last entry)
Agent:   maintains wiki during normal coding sessions (ingest on learning)
User:     /wiki lint
Agent:   health-checks wiki → appends findings to log.md
```

**Config example:**
```json
{
  "wikiMode": {
    "enabled": true
  }
}
```

### 7. Read Tool Override

When `openCode.readOverride` is `true`:

- The plugin registers a `read` tool that shadows OpenCode's built-in read
- **Always returns full file contents** from disk
- When RAG chunks are available for the file (score ≥ threshold), they are appended as "Related code chunks" after the file content
- If retrieval fails, the file is still returned without RAG context
- If no relevant chunks are found but the file has indexed chunks, related files are suggested

### 8. Session Logging & Evaluation

The plugin automatically captures session events for token usage analysis:

- **Event hook** (`event`): Logs every OpenCode event — messages, tool calls, steps, session status
- **RAG context hook** (`chat.message`): After each retrieval, logs chunk count, context tokens (tiktoken BPE), top score, and retrieval time

Events are stored as JSONL at `${storePath}/eval-sessions/${sessionID}.jsonl`.

**Token counting:** RAG context tokens are counted per-chunk using tiktoken (cl100k_base BPE encoding) at injection time. This provides accurate counts for code, which tokenizes differently than prose (~4 chars/token is a rough heuristic, but BPE is 20-40% more accurate).

See [Evaluation documentation](evaluation.md) for CLI commands, analysis interpretation, and benchmarking.

## Plugin Architecture

```
                    OpenCode Runtime
                           │
            ┌──────────────┴──────────────┐
            │                             │
    ragPlugin()                    BackgroundIndexer
            │                             │
    createRagHooks()                file watcher
            │                        (chokidar/git)
    ┌───────┼───────────┐         debounced scheduler
    │       │           │                 │
  Tool   chat.message  read          periodic timer
  hook    hook        override        (git only)
```

## Plugin Export Pattern

For OpenCode v1.17.0 compatibility, the plugin uses the `PluginModule` export pattern:

```typescript
import { ragPlugin } from "./plugin.js";

export const server = ragPlugin;
export const id = "opencode-rag-plugin";
export default { id: "opencode-rag-plugin", server: ragPlugin };
```

Key requirements:
- The `default` export MUST be an **object** `{ id, server }`, not a bare function
- Named exports are kept for backward compatibility but not used by the V1 loader
- The TUI plugin (`rag-tui.js`) must also default-export an object with `server()`:

```javascript
const plugin = {
  id: "opencode-rag-plugin:tui",
  server: async () => ({}),
};
export default plugin;
```

## Plugin Registration

Do NOT register the plugin via `"plugin": ["opencode-rag-plugin"]` in OpenCode config. Instead, rely on `.opencode/plugins/*.js` auto-discovery:

1. Run `opencode-rag init` to create `.opencode/plugins/rag-plugin.js` and `.opencode/skills/opencode-rag/SKILL.md`
2. The generated plugin file re-exports from `node_modules/`:

```javascript
import plugin from "../node_modules/opencode-rag-plugin/dist/plugin-entry.js";
export const id = plugin.id;
export const server = plugin.server;
export default plugin;
```

## Background Auto-Indexing

The plugin spawns one `BackgroundIndexer` per workspace directory (via `src/watcher.ts`):

- **File watcher**: Monitors file changes in the workspace (backend configurable via `autoIndex.watcher`)
  - **chokidar** (default): Real-time filesystem events, minimal overhead
  - **git**: Poll-based diff against last indexed commit
- **Debounced scheduler**: Waits `autoIndex.debounceMs` (2000ms) after changes before re-indexing (disabled by default; enable via `autoIndex.enabled`)
- **Periodic timer**: Only for `git` backend — runs a full pass every `autoIndex.intervalMs` (default 5 min). Not used with `chokidar` (real FS events are sufficient)
- **Error recovery**: Detects LanceDB corruption and triggers auto-rebuild
- **Status file**: Writes `watcher-status.json` to the store path for observability

## TUI Settings Menu

The TUI plugin (`src/tui.ts`) registers a settings panel in the OpenCode sidebar:

### Categories

| Category | Settings |
|---|---|
| Retrieval | `topK`, `minScore`, `maxChunks`, hybrid search toggle |
| Embedding | Model picker dropdown (populated from OpenCode's registered providers) |
| LLM Descriptions | Enable/disable toggle, model picker dropdown |

### Features

- **Model picker**: Groups models by provider name, sorted alphabetically, with "Custom…" option for manual entry
- **Auto-sets provider and base URL** when a model is selected
- **Runtime overrides**: Settings are persisted to `${storePath}/runtime-overrides.json` and take precedence over `opencode-rag.json`
- **Status sidebar**: Shows chunk count, provider/model info, last indexed time, watcher state
- **Keyboard shortcut**: `Ctrl+Shift+R` opens the settings dialog
- **Auto-refresh**: Status refreshes every 30 seconds

### TUI Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| **Ctrl+Enter** | Retrieve and append a relevant file list to the prompt |
| **Ctrl+Alt+Enter** | Retrieve and append full code chunks to the prompt |
| **Ctrl+Shift+R** | Open the settings dialog |

Both shortcuts read the current prompt text combined with the previous assistant response (if any) as the search query. If the prompt is empty, a toast reminds you to type first — no dialogs are opened. Keybindings are configurable in the settings menu under "Keybindings".

## Plugin Troubleshooting

### "Plugin export is not a function" Error

This occurs when OpenCode's Bun runtime tries to load the plugin via the `"plugin"` key in OpenCode config, causing module resolution issues.

**Fix:**
1. Ensure the plugin is loaded via `.opencode/plugins/*.js` auto-discovery, NOT via `"plugin"` config key
2. Run `opencode-rag init` to regenerate the workspace-local plugin files
3. Remove stale `"plugin"` entries from all OpenCode config files

### Debugging Plugin Loading

```bash
node --input-type=module -e \
  "const m = await import('opencode-rag-plugin'); console.log(typeof m.default, typeof m.server)"
```

## API Key Auto-Resolution

When using OpenAI as the embedding or description provider, the plugin auto-resolves the API key from OpenCode's own provider configuration if not specified in `opencode-rag.json`:

- Searches `.opencode/opencode.json`, `opencode.json`, `~/.config/opencode/opencode.jsonc`
- Strips JSONC comments before parsing
- Finds the `apiKey` for the `openai` provider
