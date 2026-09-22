# Chunking

OpenCodeRAG uses **tree-sitter** (AST-based) parsing for programming languages, regex-based splitting for structured documents, and line-based fallback for everything else.

## Supported Languages & Formats

The extension → parser mapping below is the built-in default; remap it per workspace with [`chunking.parsers`](#parser-overrides-per-extension-chunkingparsers) (no source changes needed).

### AST-Based (tree-sitter) — 26 Languages

| Language | Chunker | Extensions |
|---|---|---|
| TypeScript | `typescript.ts` | `.ts`, `.tsx` |
| JavaScript | `javascript.ts` | `.js`, `.jsx`, `.mjs`, `.cjs` |
| Python | `python.ts` | `.py` |
| Java | `java.ts` | `.java` |
| Go | `go.ts` | `.go` |
| C | `c.ts` | `.c`, `.h` |
| C++ | `cpp.ts` | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hxx` |
| C# | `csharp.ts` | `.cs` |
| Rust | `rust.ts` | `.rs` |
| Ruby | `ruby.ts` | `.rb` |
| Kotlin | `kotlin.ts` | `.kt`, `.kts` |
| Swift | `swift.ts` | `.swift` |
| Bash | `bash.ts` | `.sh`, `.bash`, `.zsh` |
| PHP | `php.ts` | `.php` |
| PowerShell | `powershell.ts` | `.ps1`, `.psm1`, `.psd1` |
| SQL | `sql.ts` | `.sql` |
| JSON | `json.ts` | `.json` |
| HTML | `html.ts` | `.html`, `.htm` |
| CSS | `css.ts` | `.css` |
| XML | `xml.ts` | `.xml`, `.csproj`, `.svg` |
| YAML | `yaml.ts` | `.yaml`, `.yml` |
| TOML | `toml.ts` | `.toml` |
| INI | `ini.ts` | `.ini`, `.cfg` |
| Dockerfile | `dockerfile.ts` | `Dockerfile`, `Containerfile` |
| Markdown | `markdown.ts` | `.md`, `.mdx` |

### Regex / Structure-Based

| Format | Chunker | Extensions | Strategy |
|---|---|---|---|
| LaTeX | `tex.ts` | `.tex` | Section-splitter (chapter/section/subsection), comment-aware |
| Razor | `razor.ts` | `.razor`, `.cshtml` | Tag/block based |
| Solution | `sln.ts` | `.sln` | Project-section based |

### Document Text Extraction

| Format | Chunker | Extensions | Backend |
|---|---|---|---|
| PDF | `pdf.ts` | `.pdf` | `pdfjs-dist` + DOMMatrix polyfill |
| DOCX | `docx.ts` | `.docx` | `mammoth` |
| DOC | `doc.ts` | `.doc` | `word-extractor` |
| Excel | `excel.ts` | `.xls`, `.xlsx` | `@e965/xlsx` |

### Fallback

| Language | Chunker | Strategy |
|---|---|---|
| All others | `fallback.ts` | 100-line raw text blocks |

## Image Indexing (Vision-based Chunking)

Raster images are not parsed as text. Instead, OpenCodeRAG sends each image to a vision-capable LLM and stores the generated description as a single chunk.

- **Chunker:** `src/chunker/image.ts`
- **Supported extensions:** `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`
- **Process:**
  1. Read image file as a Buffer
  2. Base64-encode and detect MIME type
  3. Call the configured vision provider (`imageDescription.*`) with the prompt
  4. Store the resulting description as a chunk (file path, line range 1–1)
  5. Embed and index the description using the standard embedding pipeline

- **Notes:**
  - Disabled by default; enable via `imageDescription.enabled` in `opencode-rag.json`.
  - SVG files are indexed as XML via the AST chunker, not the vision pipeline.
  - Indexing always uses the base `imageDescription.*` settings. On-demand calls (`describe_image` tool, MCP server, CLI) may use `imageDescription.onDemand` overrides instead — see [Configuration](configuration.md#imagedescription).

## How Chunkers Work

### TreeSitterChunker (Abstract Base)
Defined in `src/chunker/base.ts`. Each AST-based chunker:

1. Loads the tree-sitter grammar via `loadGrammar()` (WASM bundled in `tree-sitter-wasm`)
2. Parses the file content into a CST (Concrete Syntax Tree)
3. Walks top-level declarations (functions, classes, methods, interfaces, etc.)
4. Produces a `Chunk` per declaration with accurate line ranges

Key parameters in `TreeSitterChunker`:

```typescript
abstract class TreeSitterChunker {
  abstract language: string;
  abstract fileExtensions: string[];
  abstract grammarName: string;     // tree-sitter grammar name
  abstract nodeTypes: string[];     // AST node types to chunk on
  // ...
}
```

### Regex Chunkers
Markdown splits on `#` headings, respecting code-fence boundaries. LaTeX splits on `\chapter`, `\section`, `\subsection`, skipping comments.

### Document Chunkers
Binary formats are extracted to text first (via dedicated libraries), then split into paragraph-based chunks. Small paragraphs are grouped; oversized chunks are split further.

### Fallback Chunker
Simply splits text into 100-line blocks. Used for any extension not handled by a specialized chunker.

## Adding a New Language Chunker

1. Create `src/chunker/<lang>.ts` extending `TreeSitterChunker`
2. Set `language`, `fileExtensions`, `grammarName`, `nodeTypes`
3. Add the new chunker instance to the `chunkers` array in `factory.ts`
4. Add the extension to `DEFAULT_CONFIG.indexing.includeExtensions`
5. If the language is available in `@vscode/tree-sitter-wasm` (`node_modules/@vscode/tree-sitter-wasm/wasm/`), it's automatically resolved. Otherwise, build the WASM from an official grammar package and place it in `wasm/`.

## Adding a Non-Code Chunker (e.g., PDF)

1. Create `src/chunker/<format>.ts` implementing `Chunker` directly (not `TreeSitterChunker`)
2. Use dynamic imports for heavy dependencies to avoid startup overhead
3. Register in `factory.ts`
4. Update `scanWorkspace` in `indexer.ts` to read binary files as `Buffer`

## Custom Chunkers via Config

You can inject custom chunkers without modifying source code via `opencode-rag.json`:

```json
{
  "chunkers": [
    { "module": "./path/to/my-chunker.js", "extensions": [".xyz"] }
  ]
}
```

The module must export a class implementing the `Chunker` interface.

## Function-Level Chunking Strategy

By default, AST-based chunkers use **function-level chunking** — they split code at function/method boundaries rather than class or file boundaries. This is optimized for AI agent workflows where the agent typically needs to find, understand, and modify specific functions.

### What's chunked per language

| Language | Chunked node types | NOT chunked |
|---|---|---|
| TypeScript | functions, methods, arrows, interfaces, type aliases | classes, export statements |
| JavaScript | functions, methods, arrows | classes, export statements |
| Python | functions, decorated definitions (preserves @decorators) | classes |
| Java | methods, interfaces, enums | classes |
| Go | functions, methods | type declarations |
| Rust | functions, structs, enums, traits, impls, type aliases | modules |
| C# | methods, interfaces, structs, records, enums | classes, namespaces |
| C++ | functions, structs, enums, unions | classes, namespaces, templates |
| Kotlin | functions, objects, properties | classes, interfaces (use class_declaration in grammar) |
| Swift | functions, enums, protocols | classes, structs, extensions (use class_declaration in grammar) |
| Ruby | methods, singleton_methods | classes, modules |
| Bash | function definitions | — |
| PHP | functions, methods | classes, interfaces |
| PowerShell | function statements | — |
| SQL | statements | — |
| YAML | block mapping pairs, block sequence items | — |
| TOML | tables, table array elements, pairs | — |
| INI | sections | — |
| Dockerfile | instructions (FROM, RUN, CMD, COPY, etc.) | — |

### Why function-level?

- **Precision**: Each chunk contains exactly one function/method, so retrieval results are focused
- **Token efficiency**: With `maxChunks=5` and `maxTokens=3000`, smaller chunks let the agent see more relevant code
- **Keyword quality**: TF-IDF scoring is more precise when computed per-function rather than per-class
- **Agent alignment**: Agents typically search for specific functions, not entire classes

### Grammar limitations

Some tree-sitter grammars don't have distinct node types for all constructs:
- **Kotlin**: `interface` and `class` both use `class_declaration` — interfaces can't be distinguished at the AST level
- **Swift**: `struct`, `extension`, and `class` all use `class_declaration` — only `protocol_declaration` is distinct

### Configurable nodeTypes

You can override which AST node types are chunked per language in `opencode-rag.json`:

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

This is useful when you want broader or narrower chunking granularity for specific languages. The overrides apply during indexing — re-index after changing them.

**Scope:** `nodeTypes` affects **indexing/chunking only**. `get_file_skeleton` (plugin tool and MCP) uses its own per-extension recipe (`SKELETON_CONFIGS` in `src/chunker/skeleton.ts`) and is *not* influenced by this setting — to change which parser a skeleton uses, use [`chunking.parsers`](#parser-overrides-per-extension-chunkingparsers).

### Parser overrides per extension (`chunking.parsers`)

The parser used for a file extension is normally fixed by the chunker registry (see the tables above). `chunking.parsers` remaps extensions at config level — both **new** extensions and **existing** entries:

```json
{
  "chunking": {
    "parsers": {
      ".c": "cpp",
      ".cu": "cpp"
    }
  }
}
```

- **Keys** are file extensions; they are normalized (lowercased, leading dot added), so `"CXX"` and `".cxx"` are the same entry.
- **Values** are registered parser languages: any `language` from the chunker table (`typescript`, `cpp`, `python`, …) plus `text` for the fallback parser. Unknown names produce a config warning listing the valid ones.
- The mapping applies consistently to **all four** extension-sensitive surfaces:
  1. **Indexing/chunking** — `getChunker()` picks the target parser, and `chunking.nodeTypes` is looked up under the *target* language (so `nodeTypes.cpp` applies to remapped `.c` files).
  2. **`get_file_skeleton` tool** — resolves to the target parser's grammar recipe (shared module: `src/chunker/skeleton.ts`).
  3. **MCP `get_file_skeleton`** — same shared module, same result.
  4. **Read-tool code fences** — the language label comes from the override.
- Extensions named in `chunking.parsers` are **implicitly added to the scan set** — you do not need to repeat them in `indexing.includeExtensions`.
- If the target parser has no skeleton recipe (e.g. `text`), the skeleton tool falls back to a line count rather than using the extension's previous (now wrong) grammar.
- Overrides are resolved per call and never mutate the process-wide registry, so they are workspace-scoped and coexist safely with pluggable `chunkers[]`.

**Re-index required**: changing a mapping changes chunk boundaries for already-indexed files without touching their content hashes. Run `opencode-rag index --force` after editing (the TUI warns about this when you edit under the Chunking category).

Known limits: the web dashboard config editor only accepts `indexing.*` keys (use the file or the TUI), and `imageDescription` handling bypasses the chunker, so remapping an image extension has no effect.
