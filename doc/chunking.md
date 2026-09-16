# Chunking

OpenCodeRAG uses **tree-sitter** (AST-based) parsing for programming languages, regex-based splitting for structured documents, and line-based fallback for everything else.

## Supported Languages & Formats

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
