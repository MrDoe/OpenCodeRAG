/**
 * @fileoverview Abstract base class for tree-sitter based language chunkers.
 */
import { Parser } from "web-tree-sitter";
import { loadLanguage, loadLanguageFromPath, walkTree, buildByteOffsetMap, type AstNode } from "./grammar.js";
import type { Chunker, Chunk } from "../core/interfaces.js";
import { uuid } from "./uuid.js";

/** Module-level parser pool shared across all TreeSitterChunker instances. */
const parserPool = new Map<string, Parser>();

function poolKey(grammarName: string, wasmFilePath?: string): string {
  return wasmFilePath ? `${grammarName}::${wasmFilePath}` : grammarName;
}

/** Abstract base for tree-sitter based language chunkers. */
export abstract class TreeSitterChunker implements Chunker {
  abstract readonly language: string;
  abstract readonly fileExtensions: string[];
  abstract readonly grammarName: string;
  abstract readonly nodeTypes: Set<string>;

  /**
   * Optional path to a custom WebAssembly file for the tree-sitter grammar.
   * If not provided, the default grammar will be loaded.
   * @default undefined
   */
  readonly wasmFilePath?: string;

  /**
   * Maximum content length in bytes before chunking is skipped.
   * Tree-sitter can hang on very large files (especially SVGs).
   * Set to 0 or negative for no limit.
   * @default 0 (no limit)
   */
  maxContentBytes = 0;

  /**
   * Create a new chunker that only includes nodes of the specified types.
   * @param types - The set of node types to include in the chunking process.
   * @returns A new Chunker instance that filters nodes by the specified types.
   */
  withNodeTypes(types: Set<string>): Chunker {
    const original = this;
    return {
      get language() { return original.language; },
      get fileExtensions() { return original.fileExtensions; },
      async chunk(filePath: string, content: string): Promise<Chunk[]> {
        if (content.trim().length === 0) return [];
        if (original.maxContentBytes > 0 && Buffer.byteLength(content, "utf-8") > original.maxContentBytes) {
          throw new Error(`File exceeds ${original.maxContentBytes} byte limit for ${original.language} chunker`);
        }
        const parser = await original._createParser();
        const tree = parser.parse(content);
        if (!tree) { return []; }
        // tree-sitter ranges are UTF-8 byte offsets; translate for slicing
        const offsetMap = buildByteOffsetMap(content);
        let nodes: AstNode[];
        try {
          nodes = walkTree(tree.rootNode, types, content, 10, 0, offsetMap);
        } finally {
          tree.delete();
        }
        return nodes.map((node: AstNode) => ({
          id: uuid(),
          content: node.text,
          description: node.leadingDoc,
          metadata: {
            filePath,
            startLine: node.startLine,
            endLine: node.endLine,
            language: original.language,
          },
        }));
      },
    };
  }

  /**
   * Returns a cached Tree-sitter parser for the chunker's language.
   * Parsers are created once per grammar and reused across chunk() calls.
   * @returns A Promise that resolves to a Parser instance.
   */
  private async _createParser(): Promise<Parser> {
    const key = poolKey(this.grammarName, this.wasmFilePath);
    const cached = parserPool.get(key);
    if (cached) return cached;

    const lang = this.wasmFilePath
      ? await loadLanguageFromPath(this.grammarName, this.wasmFilePath)
      : await loadLanguage(this.grammarName);
    const parser = new Parser();
    parser.setLanguage(lang);
    parserPool.set(key, parser);
    return parser;
  }

  /**
   * Release all cached parsers for this chunker's language.
   * Call when the chunker is no longer needed.
   */
  dispose(): void {
    const key = poolKey(this.grammarName, this.wasmFilePath);
    const parser = parserPool.get(key);
    if (parser) {
      parser.delete();
      parserPool.delete(key);
    }
  }

  /**
   * Chunks the given content into an array of {@link Chunk} objects based on the specified node types.
   * @param filePath - The path of the file being chunked, used for metadata.
   * @param content - The content of the file to be chunked.
   * @returns A Promise that resolves to an array of {@link Chunk} objects.
   */
  async chunk(filePath: string, content: string): Promise<Chunk[]> {
    if (content.trim().length === 0) return [];

    if (this.maxContentBytes > 0 && Buffer.byteLength(content, "utf-8") > this.maxContentBytes) {
      throw new Error(`File exceeds ${this.maxContentBytes} byte limit for ${this.language} chunker`);
    }

    const parser = await this._createParser();
    const tree = parser.parse(content);
    if (!tree) { return []; }

    // tree-sitter ranges are UTF-8 byte offsets; translate for slicing
    const offsetMap = buildByteOffsetMap(content);
    let nodes: AstNode[];
    try {
      nodes = walkTree(tree.rootNode, this.nodeTypes, content, 10, 0, offsetMap);
    } finally {
      tree.delete();
    }
    return nodes.map((node: AstNode) => ({
      id: uuid(),
      content: node.text,
      description: node.leadingDoc,
      metadata: {
        filePath,
        startLine: node.startLine,
        endLine: node.endLine,
        language: this.language,
      },
    }));
  }
}
