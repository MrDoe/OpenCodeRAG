/**
 * @fileoverview Abstract base class for tree-sitter based language chunkers.
 */
import { Parser } from "web-tree-sitter";
import { loadLanguage, loadLanguageFromPath, walkTree, type AstNode } from "./grammar.js";
import type { Chunker, Chunk } from "../core/interfaces.js";
import { uuid } from "./uuid.js";

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
        if (!tree) { parser.delete(); return []; }
        const nodes = walkTree(tree.rootNode, types, content);
        tree.delete();
        parser.delete();
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
   * Creates a new Tree-sitter parser for the chunker's language.
   * @returns  A Promise that resolves to a Parser instance configured for the chunker's language.
   * @private 
   */
  private async _createParser(): Promise<Parser> {
    const lang = this.wasmFilePath
      ? await loadLanguageFromPath(this.grammarName, this.wasmFilePath)
      : await loadLanguage(this.grammarName);
    const parser = new Parser();
    parser.setLanguage(lang);
    return parser;
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
    if (!tree) { parser.delete(); return []; }

    const nodes = walkTree(tree.rootNode, this.nodeTypes, content);
    tree.delete();
    parser.delete();
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
