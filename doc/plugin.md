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
| `find_usages` | Find all references to a symbol | `symbolName` (req), `pathHint?`, `topK?` |
| `describe_image` | Retrieve stored description of an indexed image | `filePath` (req) |
| `doc` | Start or continue autonomous documentation | `reset?` (optional) |
| `mark_documented` | Mark a file as documented after processing | `filePath` (req) |

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

### 2. `chat.message` Hook — Auto-Injection

After each user message, the plugin runs automatic retrieval. The `contentType` setting controls what gets injected:

- **`"file_paths"` (default)**: A lightweight file suggestion list is appended — `path (lang, lines N-M, relevance X.XX)`. Agents must call `search_semantic`, `get_file_skeleton`, or `find_usages` to retrieve actual code. This nudges proactive tool usage.
- **`"chunks"`**: Full code chunks are injected under an **Auto-retrieved code context** header. Saves a tool-call round-trip but uses more tokens.

Both modes only inject when score ≥ `openCode.autoInject.minScore` (default 0.85).

The auto-injection respects:
- `maxChunks` (default 5) — maximum chunks/files to inject
- `maxTokens` (default 3000) — token budget (~4 chars/token estimate)
- Low-scoring chunks are evicted first to fit the budget
- Paths are made relative via `path.relative(worktree, ...)`

### 3. Agent Skill Discovery

`opencode-rag init` creates `.opencode/skills/opencode-rag/SKILL.md` — an OpenCode skill that teaches agents the recommended tool workflow. This is the primary discovery mechanism:

- Agents see the skill listed in the `skill` tool description
- Loading it injects the workflow guidance into the conversation
- Zero ongoing token cost — only loaded when the agent chooses to load it

The skill teaches the workflow: skeleton → find_usages → search → read → edit.

### 4. System Prompt Guidance (Always)

The `experimental.chat.system.transform` hook prepends a tool list to the system prompt on every message, ensuring agents always know the tools are available — even before the index is built.

### 5. `/doc` Slash Command

When `documentationMode.enabled` is `true`, the plugin registers a `doc` tool and a `command.execute.before` hook. Typing `/doc` in the prompt (or the agent calling the `doc` tool) kicks off autonomous documentation of the codebase.

**Configuration:**

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | Enable documentation mode |
| `batchSize` | `5` | Files to process per batch |

**How it works:**

1. **`/doc` command** — The user types `/doc` in the prompt, or the agent calls the `doc` tool. The plugin loads the index manifest and progress tracker, then returns a batch of files to document with instructions.

2. **Autonomous workflow** — The LLM processes each file in the batch:
   - Calls `get_file_skeleton` to understand file structure
   - Calls `read` to get full file contents
   - Adds/updates JSDoc/TSDoc comments following Google JSDoc style
   - Calls `mark_documented(filePath)` to record progress

3. **Progress tracking** — Documented files are recorded in `.opencode/rag_db/doc-mode-progress.json`. The LLM can call `doc` again for the next batch, or the user can type `/doc` again.

4. **`mark_documented` tool** — A dedicated tool that the LLM calls after documenting each file. It persists the file path to the progress tracker.

5. **`doc` tool** — The `doc` tool accepts an optional `reset` argument. Calling `doc(reset: true)` resets all documentation progress, allowing a fresh run.

**Config example:**
```json
{
  "documentationMode": {
    "enabled": true,
    "batchSize": 5
  }
}
```

### 6. Read Tool Override

When `openCode.readOverride` is `true`:

- The plugin registers a `read` tool that shadows OpenCode's built-in read
- **Always returns full file contents** from disk
- When RAG chunks are available for the file (score ≥ threshold), they are appended as "Related code chunks" after the file content
- If retrieval fails, the file is still returned without RAG context
- If no relevant chunks are found but the file has indexed chunks, related files are suggested

### 7. Session Logging & Evaluation

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
    createRagHooks()                chokidar watcher
            │                             │
    ┌───────┼───────┬───────┐     debounced scheduler
    │       │       │       │             │
  Tool   command  chat.   read      periodic timer
  hook  .execute  message override
        .before   hook
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

- **chokidar watcher**: Monitors file changes in the workspace
- **Debounced scheduler**: Waits `autoIndex.debounceMs` (2000ms) after changes before re-indexing (disabled by default; enable via `autoIndex.enabled`)
- **Periodic timer**: Runs a full pass every `autoIndex.intervalMs` (default 5 min)
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

Both shortcuts read the current prompt text as the search query. If the prompt is empty, a toast reminds you to type first — no dialogs are opened. Keybindings are configurable in the settings menu under "Keybindings".

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
