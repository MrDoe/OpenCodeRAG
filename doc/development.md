# Development Guide

## Project Setup

```bash
git clone https://github.com/MrDoe/OpenCodeRAG.git
cd OpenCodeRAG
npm install --legacy-peer-deps
opencode-rag init --force
```

> LanceDB and other dependencies have peer dependency conflicts — `--legacy-peer-deps` is required. Run `opencode-rag setup --force` after building to sync the development copy into the runtime.

## Commands

| Command | Description |
|---|---|
| `npm test` | Run all tests (`node --import tsx --test --test-force-exit "src/**/*.test.ts"`) |
| `npm run typecheck` | Type-check without emitting (`tsc --noEmit`) |
| `npm run cli` | Run the CLI via `tsx src/cli.ts` |
| `npm run build` | Build TypeScript to `dist/` |
| `npm run release:patch` | Bump version, build, publish |

## Development Workflow

After making source changes, sync them to the global runtime:

```bash
npm run build                 # compile src/ → dist/
npm link                      # link local package as global npm package
opencode-rag setup --force    # sync symlink at ~/.opencode/ to your local build
opencode-rag init              # (optional) update workspace AGENTS.md + skill
```

> **Note:** `npm i -g opencode-rag-plugin` installs from the npm registry, not your local source. Always use `npm run build && npm link && opencode-rag setup --force` to test local changes. Re-run `opencode-rag init` in target workspaces to pick up AGENTS.md changes.

## Testing

**Framework:** Node.js built-in test runner (`node:test`), no Jest/Mocha/Vitest.

```bash
# Run all tests
npm test

# Run a single test file
node --import tsx --test src/__tests__/chunker/fallback.test.ts

# Run chunker tests
node --import tsx --test "src/__tests__/chunker/*.test.ts"

# Run with typecheck first
npm run typecheck && npm test
```

**Important:** `--test-force-exit` is required because chokidar and LanceDB leave open handles. Without it, the test suite hangs after completion.

**LanceDB tests:** Use `memory://` URI — data is discarded after each test. Requires native binary support (works on Win/Linux/Mac x64+arm).

**Test file structure:** Mirrors `src/` — `src/__tests__/chunker/` tests `src/chunker/`, etc.

The test suite currently has **589+ tests** (1 integration test requiring the OpenCode binary, all others unit tests).

## Type Checking

TypeScript is used for type checking only — there is no build step for development. `tsx` handles TypeScript at runtime.

```bash
npm run typecheck   # tsc --noEmit
```

## Coding Conventions

### ESM Only
All imports use `.js` extensions and `node:` prefixes:

```typescript
import { readFileSync } from "node:fs";
import path from "node:path";
import { Chunk } from "./core/interfaces.js";
```

### Interfaces Over Classes
Module boundaries are defined by interfaces in `core/interfaces.ts`. Concrete implementations implement them:

```typescript
class LanceDbStore implements VectorStore { ... }
class OllamaEmbedder implements EmbeddingProvider { ... }
class TypeScriptChunker extends TreeSitterChunker { ... }
```

### Factory Pattern
Dispatch is handled through factories:

- `getChunker(filePath)` / `chunkFile(filePath, content)`
- `createEmbedder(config)` / `embedBatch(embedder, texts)`
- `createDescriptionProvider(config)`

### Adapter Pattern
`LanceDbStore` implements `VectorStore`; provider classes implement `EmbeddingProvider`.

### Error Resilience
Plugin and CLI catch errors silently where appropriate. Type errors are surfaced via TypeScript.

### UUID Generation
Simple internal `uuid()` in `chunker/uuid.ts` (no external dependency).

## Module Structure

```
src/
  core/              — Interfaces, config, manifest, runtime overrides
  chunker/           — All chunker implementations (25 files)
  embedder/          — Embedding providers + HTTP transport
  describer/         — LLM description providers
  vectorstore/       — LanceDB vector store
  retriever/         — Retrieval pipeline + keyword index
  opencode/          — OpenCode integration utilities
  tui/               — TUI sidebar components
  types/             — Local type declarations
  indexer.ts         — Index pipeline
  watcher.ts         — Background file watcher
  plugin.ts          — Main plugin
  cli.ts             — CLI interface
  tui.ts             — TUI plugin
  index.ts           — Public API exports
  __tests__/         — Test suite
```

## Adding a New Embedding Provider

1. Create `src/embedder/<name>.ts` implementing `EmbeddingProvider`
2. Add dispatch in `createEmbedder()` in `factory.ts`
3. Update `RagConfig.embedding.provider` union type in `config.ts`

## Adding a New Language Chunker

See [Chunking](chunking.md#adding-a-new-language-chunker).

## Release Process

```bash
npm run release:patch
```

This runs `scripts/release-patch.js` which:
1. Creates a new git branch
2. Bumps the patch version
3. Builds the project (`tsc -p tsconfig.build.json`)
4. Runs tests
5. Creates a git tag and commit
6. Publishes to npm (dry-run supported via `--dry` flag)

## Known Gotchas

### npm install
- Use `--legacy-peer-deps` — LanceDB has peer dependency conflicts
- Corporate SSL: `set NODE_TLS_REJECT_UNAUTHORIZED=0` before `npm install`

### LanceDB Type Casts
LanceDB's TS API expects `Record<string, unknown>[]` for data inputs. Cast through `unknown`:

```typescript
await table.add(rows as unknown as Record<string, unknown>[]);
```

### tree-sitter WASM (no native compilation)
- `@vscode/tree-sitter-wasm` provides pre-built WASM grammars for 16 languages
- Self-bundled `.wasm` files in `wasm/` cover 12 additional languages
- All parsing is WASM-based via `web-tree-sitter`
- `web-tree-sitter` uses `Node` type (not `SyntaxNode`)
- `Parser` is a class (not `new Parser()`)
- `Language` is a top-level class

### OpenCode Plugin Types
`@opencode-ai/plugin` lives in `.opencode/node_modules/` — not installed via npm. Types are declared locally in `src/types/opencode-plugin.d.ts`.

### Config File Loading
- `loadConfig()` deep-merges per section (not recursive)
- CLI auto-detects `./opencode-rag.json` and `./.opencode/rag.json`
- Default config is the fallback when no file is found

### Ollama Response Quirks
- Ollama may return `{ embedding: number[] }` or `{ embeddings: number[][] }` — both shapes are accepted
- `embedding.timeoutMs` defaults to 30000ms (was 5000ms, too short for cold starts)
