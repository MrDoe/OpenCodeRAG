/**
 * @fileoverview Tree-sitter WASM grammar loading, caching, and AST walking with doc comment extraction.
 */
import { Parser, Language, Node } from "web-tree-sitter";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function resolveMsWasmDir(): string {
  const localDir = resolve(PROJECT_ROOT, "node_modules", "@vscode", "tree-sitter-wasm", "wasm");
  if (existsSync(localDir)) return localDir;

  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve("@vscode/tree-sitter-wasm/package.json");
    return resolve(dirname(pkgJson), "wasm");
  } catch {
    return localDir;
  }
}

const MS_WASM_DIR = resolveMsWasmDir();

const SELF_WASM_DIR = resolve(PROJECT_ROOT, "wasm");

const MS_LANGUAGES = new Set([
  "bash",
  "c_sharp",
  "cpp",
  "css",
  "go",
  "ini",
  "java",
  "javascript",
  "php",
  "powershell",
  "python",
  "regex",
  "ruby",
  "rust",
  "tsx",
  "typescript",
]);

function resolveWasmPath(lang: string): string {
  if (MS_LANGUAGES.has(lang)) {
    const msName = lang.replace(/_/g, "-");
    return resolve(MS_WASM_DIR, `tree-sitter-${msName}.wasm`);
  }
  return resolve(SELF_WASM_DIR, `tree-sitter-${lang}.wasm`);
}

let initialized = false;
let initPromise: Promise<void> | null = null;

/**
 * Ensure the tree-sitter WASM runtime is initialised.
 *
 * Safe to call multiple times — the initialisation promise is cached so that
 * concurrent callers share a single init sequence.
 */
export async function initParser(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;
  initPromise = Parser.init().then(() => {
    initialized = true;
    initPromise = null;
  }).catch((err) => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

const grammarCache = new Map<string, Language>();

/**
 * Load a tree-sitter grammar WASM by language name.
 *
 * The grammar is resolved from either the `@vscode/tree-sitter-wasm` package
 * or the project's own `wasm/` directory (see {@link resolveWasmPath}).
 * Results are cached so each grammar is loaded at most once.
 *
 * @param lang - Language identifier (e.g. `"typescript"`, `"python"`).
 * @returns A promise that resolves to the loaded {@link Language}.
 */
export async function loadLanguage(lang: string): Promise<Language> {
  const cached = grammarCache.get(lang);
  if (cached) return cached;

  await initParser();
  const wasmPath = resolveWasmPath(lang);
  const buffer = readFileSync(wasmPath);
  const language = await Language.load(buffer);
  grammarCache.set(lang, language);
  return language;
}

/**
 * Load a tree-sitter grammar WASM from an arbitrary filesystem path.
 *
 * Useful when a custom chunker provides its own grammar file rather than
 * relying on the bundled WASM directory.
 *
 * @param cacheKey - Key under which the loaded grammar is cached (typically
 *   the chunker's {@link language} identifier).
 * @param wasmPath - Absolute or relative path to the `.wasm` grammar file.
 * @returns A promise that resolves to the loaded {@link Language}.
 */
export async function loadLanguageFromPath(
  cacheKey: string,
  wasmPath: string
): Promise<Language> {
  const cached = grammarCache.get(cacheKey);
  if (cached) return cached;

  await initParser();
  const resolvedPath = resolve(wasmPath);
  const buffer = readFileSync(resolvedPath);
  const language = await Language.load(buffer);
  grammarCache.set(cacheKey, language);
  return language;
}

/**
 * Describes a single extracted AST node and its surrounding documentation.
 *
 * Produced by {@link walkTree} and consumed by chunkers to build
 * {@link import("../core/interfaces.js").Chunk | Chunk} objects.
 */
export interface AstNode {
  /** Source text spanned by this AST node. */
  text: string;
  /** 1-based start line in the source file. */
  startLine: number;
  /** 1-based end line in the source file. */
  endLine: number;
  /** 0-based start byte offset in the source. */
  startIndex: number;
  /** 0-based end byte offset (exclusive) in the source. */
  endIndex: number;
  /** tree-sitter node type (e.g. `"function_definition"`). */
  type: string;
  /**
   * Doc comment or docstring text extracted from comments immediately
   * preceding the node, if any.
   */
  leadingDoc?: string;
}

const COMMENT_NODE_TYPES = new Set([
  "comment",
  "line_comment",
  "multiline_comment",
  "marginalia",
  "Comment",
]);

/**
 * Build a byte-offset → UTF-16-index map for a source string.
 *
 * tree-sitter reports node ranges as UTF-8 BYTE offsets, but JavaScript
 * `String.prototype.slice` counts UTF-16 code units. For any file containing
 * multi-byte characters the two disagree, so slicing with raw node indices
 * truncates/garbles chunk content and doc comments. Tree-sitter node
 * boundaries always align to code-point boundaries, so an exact map from
 * byte offset to UTF-16 index is sufficient.
 *
 * Returns `null` for pure-ASCII sources (byte offsets == UTF-16 offsets),
 * which is the common case and avoids the allocation.
 *
 * @param source - The full source text.
 * @returns A Map from UTF-8 byte offset to UTF-16 index, or `null` for ASCII.
 */
export function buildByteOffsetMap(source: string): Map<number, number> | null {
  if (!/[\u0080-\uffff]/u.test(source)) return null;
  const map = new Map<number, number>();
  let byteOffset = 0;
  let utf16Index = 0;
  for (const ch of source) {
    map.set(byteOffset, utf16Index);
    byteOffset += Buffer.byteLength(ch, "utf-8");
    utf16Index += ch.length;
  }
  map.set(byteOffset, utf16Index);
  return map;
}

/** Slice `source` by tree-sitter byte offsets, translating through the map when present. */
function sliceByBytes(
  source: string,
  startByte: number,
  endByte: number,
  offsetMap?: Map<number, number> | null,
): string {
  if (!offsetMap) return source.slice(startByte, endByte);
  const start = offsetMap.get(startByte) ?? startByte;
  const end = offsetMap.get(endByte) ?? endByte;
  return source.slice(start, end);
}

function cleanCommentText(text: string): string {
  const lines = text.split("\n");

  if (text.startsWith("/*")) {
    let cleaned = lines.map((line) => {
      let l = line;
      l = l.replace(/^\/\*+\s?/, "");
      l = l.replace(/\s?\*+\/$/, "");
      l = l.replace(/^\s*\*\s?/, "");
      return l;
    });
    return cleaned.filter((l) => l.trim().length > 0).join("\n");
  }

  if (text.startsWith("<!--")) {
    let cleaned = lines.map((line) =>
      line.replace(/^<!--\s?/, "").replace(/\s?-->$/, ""),
    );
    return cleaned.filter((l) => l.trim().length > 0).join("\n");
  }

  if (text.startsWith('"""') || text.startsWith("'''")) {
    const quote = text.startsWith('"""') ? '"""' : "'''";
    let cleaned = lines.map((line) => {
      let l = line.trim();
      if (l.startsWith(quote)) l = l.slice(quote.length);
      if (l.endsWith(quote)) l = l.slice(0, -quote.length);
      return l;
    });
    return cleaned.filter((l) => l.trim().length > 0).join("\n");
  }

  const prefix = /^(?:\/\/\/?|#|--|;|%)\s?/;
  let cleaned = lines.map((line) => line.replace(prefix, ""));
  return cleaned.filter((l) => l.trim().length > 0).join("\n");
}

function extractLeadingComments(
  node: Node,
  source: string,
  offsetMap?: Map<number, number> | null,
): string | undefined {
  const comments: string[] = [];
  let sibling = node.previousSibling;

  while (sibling) {
    if (COMMENT_NODE_TYPES.has(sibling.type)) {
      const raw = sliceByBytes(source, sibling.startIndex, sibling.endIndex, offsetMap);
      comments.unshift(cleanCommentText(raw));
      sibling = sibling.previousSibling;
    } else if (sibling.type === "expression_statement") {
      const firstChild = sibling.namedChildren[0];
      if (firstChild?.type === "string") {
        const raw = sliceByBytes(source, firstChild.startIndex, firstChild.endIndex, offsetMap);
        comments.unshift(cleanCommentText(raw));
        sibling = sibling.previousSibling;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  if (comments.length === 0) return undefined;
  return comments.join("\n\n");
}

function extractDocstringFromBody(
  node: Node,
  source: string,
  offsetMap?: Map<number, number> | null,
): string | undefined {
  if (node.type !== "function_definition" && node.type !== "class_definition") {
    return undefined;
  }

  const body = node.children.find((c) => c.type === "block");
  if (!body) return undefined;

  const firstStmt = body.namedChildren[0];
  if (!firstStmt || firstStmt.type !== "expression_statement") return undefined;

  const stringNode = firstStmt.namedChildren[0];
  if (!stringNode || stringNode.type !== "string") return undefined;

  return cleanCommentText(sliceByBytes(source, stringNode.startIndex, stringNode.endIndex, offsetMap));
}

/**
 * Recursively walk a tree-sitter AST and collect nodes matching the given
 * type set.
 *
 * For each matching node, leading comments and (for function/class
 * definitions) body docstrings are extracted and joined into a single
 * description.
 *
 * The root node is never returned as a chunk (depth must be > 0) so that
 * the file itself is not treated as one large chunk.
 *
 * @param node - The current tree-sitter AST node.
 * @param nodeTypes - Set of node type names to extract.
 * @param source - Full source text (used to slice node text and comments).
 * @param maxDepth - Maximum recursion depth (default: 10).
 * @param depth - Current recursion depth (internal, start at 0).
 * @returns An array of {@link AstNode} objects for matching declarations.
 */
export function walkTree(
  node: Node,
  nodeTypes: Set<string>,
  source: string,
  maxDepth: number = 10,
  depth: number = 0,
  offsetMap?: Map<number, number> | null,
): AstNode[] {
  const results: AstNode[] = [];

  if (nodeTypes.has(node.type) && depth > 0) {
    const leadingComments = extractLeadingComments(node, source, offsetMap);
    const bodyDocstring = extractDocstringFromBody(node, source, offsetMap);
    const leadingDoc = [leadingComments, bodyDocstring]
      .filter((d): d is string => d !== undefined && d.length > 0)
      .join("\n\n");

    results.push({
      text: sliceByBytes(source, node.startIndex, node.endIndex, offsetMap),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startIndex: node.startIndex,
      endIndex: node.endIndex,
      type: node.type,
      leadingDoc: leadingDoc.length > 0 ? leadingDoc : undefined,
    });
    return results;
  }

  if (depth < maxDepth) {
    for (const child of node.children) {
      results.push(
        ...walkTree(child, nodeTypes, source, maxDepth, depth + 1, offsetMap)
      );
    }
  }

  return results;
}
