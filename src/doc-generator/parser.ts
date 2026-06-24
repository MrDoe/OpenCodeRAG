import { Parser } from "web-tree-sitter";
import { initParser, loadLanguage, walkTree } from "../chunker/grammar.js";
import type { DocSymbol, DocSymbolKind } from "./types.js";

interface ChunkDef {
  language: string;
  extensions: string[];
  nodeTypes: string[];
  kindMap: Record<string, DocSymbolKind>;
}

const LANGUAGE_CONFIGS: ChunkDef[] = [
  {
    language: "typescript",
    extensions: [".ts", ".tsx"],
    nodeTypes: [
      "function_declaration", "method_definition", "arrow_function",
      "interface_declaration", "type_alias_declaration",
      "class_declaration", "enum_declaration",
      "abstract_method_signature", "method_signature",
      "property_signature", "public_field_definition",
      "getter", "setter",
    ],
    kindMap: {
      function_declaration: "function",
      method_definition: "method",
      arrow_function: "function",
      interface_declaration: "interface",
      type_alias_declaration: "type",
      class_declaration: "class",
      enum_declaration: "enum",
      abstract_method_signature: "method",
      method_signature: "method",
      property_signature: "property",
      public_field_definition: "property",
      getter: "method",
      setter: "method",
    },
  },
  {
    language: "javascript",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    nodeTypes: [
      "function_declaration", "method_definition", "arrow_function",
      "class_declaration",
    ],
    kindMap: {
      function_declaration: "function",
      method_definition: "method",
      arrow_function: "function",
      class_declaration: "class",
    },
  },
  {
    language: "python",
    extensions: [".py"],
    nodeTypes: [
      "function_definition", "class_definition",
      "decorated_definition",
    ],
    kindMap: {
      function_definition: "function",
      class_definition: "class",
      decorated_definition: "function",
    },
  },
  {
    language: "java",
    extensions: [".java"],
    nodeTypes: [
      "class_declaration", "interface_declaration",
      "enum_declaration", "method_declaration",
      "field_declaration",
    ],
    kindMap: {
      class_declaration: "class",
      interface_declaration: "interface",
      enum_declaration: "enum",
      method_declaration: "method",
      field_declaration: "field",
    },
  },
  {
    language: "go",
    extensions: [".go"],
    nodeTypes: [
      "function_declaration", "method_declaration",
      "type_declaration", "type_spec",
      "struct_type", "interface_type",
    ],
    kindMap: {
      function_declaration: "function",
      method_declaration: "method",
      type_declaration: "type",
      type_spec: "type",
      struct_type: "struct",
      interface_type: "interface",
    },
  },
  {
    language: "rust",
    extensions: [".rs"],
    nodeTypes: [
      "function_item", "struct_item", "enum_item",
      "trait_item", "impl_item", "type_item",
      "const_item", "static_item",
    ],
    kindMap: {
      function_item: "function",
      struct_item: "struct",
      enum_item: "enum",
      trait_item: "trait",
      impl_item: "module",
      type_item: "type",
      const_item: "exported-variable",
      static_item: "exported-variable",
    },
  },
  {
    language: "cpp",
    extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hxx", ".c", ".h"],
    nodeTypes: [
      "function_definition", "class_specifier",
      "struct_specifier", "enum_specifier",
      "union_specifier",
    ],
    kindMap: {
      function_definition: "function",
      class_specifier: "class",
      struct_specifier: "struct",
      enum_specifier: "enum",
      union_specifier: "struct",
    },
  },
  {
    language: "csharp",
    extensions: [".cs"],
    nodeTypes: [
      "class_declaration", "interface_declaration",
      "struct_declaration", "enum_declaration",
      "method_declaration", "property_declaration",
      "field_declaration",
    ],
    kindMap: {
      class_declaration: "class",
      interface_declaration: "interface",
      struct_declaration: "struct",
      enum_declaration: "enum",
      method_declaration: "method",
      property_declaration: "property",
      field_declaration: "field",
    },
  },
  {
    language: "ruby",
    extensions: [".rb"],
    nodeTypes: [
      "method", "singleton_method",
      "class", "module",
    ],
    kindMap: {
      method: "method",
      singleton_method: "method",
      class: "class",
      module: "module",
    },
  },
  {
    language: "kotlin",
    extensions: [".kt", ".kts"],
    nodeTypes: [
      "class_declaration", "interface_declaration",
      "object_declaration", "function_declaration",
      "property_declaration", "enum_entry",
    ],
    kindMap: {
      class_declaration: "class",
      interface_declaration: "interface",
      object_declaration: "module",
      function_declaration: "function",
      property_declaration: "property",
      enum_entry: "enum",
    },
  },
  {
    language: "swift",
    extensions: [".swift"],
    nodeTypes: [
      "class_declaration", "struct_declaration",
      "enum_declaration", "protocol_declaration",
      "function_declaration", "method_declaration",
      "variable_declaration",
    ],
    kindMap: {
      class_declaration: "class",
      struct_declaration: "struct",
      enum_declaration: "enum",
      protocol_declaration: "interface",
      function_declaration: "function",
      method_declaration: "method",
      variable_declaration: "property",
    },
  },
  {
    language: "php",
    extensions: [".php"],
    nodeTypes: [
      "class_declaration", "interface_declaration",
      "trait_declaration", "function_definition",
      "method_declaration", "property_declaration",
    ],
    kindMap: {
      class_declaration: "class",
      interface_declaration: "interface",
      trait_declaration: "module",
      function_definition: "function",
      method_declaration: "method",
      property_declaration: "property",
    },
  },
];

function getConfigForFile(filePath: string, language: string): ChunkDef | undefined {
  const ext = filePath.toLowerCase().split(".").pop() ?? "";
  return LANGUAGE_CONFIGS.find(
    (c) => c.language === language || c.extensions.some((e) => e.endsWith(`.${ext}`)),
  );
}

const NAME_PATTERNS: Record<string, RegExp> = {
  function_declaration: /\b(?:async\s+)?function\s+(\w+)/,
  method_definition: /(\w+)\s*\(/,
  arrow_function: /(?:const|let|var)\s+(\w+)\s*=/,
  interface_declaration: /\binterface\s+(\w+)/,
  type_alias_declaration: /\btype\s+(\w+)/,
  class_declaration: /\bclass\s+(\w+)/,
  enum_declaration: /\benum\s+(\w+)/,
  abstract_method_signature: /(\w+)\s*\(/,
  method_signature: /(\w+)\s*\(/,
  property_signature: /(\w+)\s*[?:;]/,
  public_field_definition: /(\w+)\s*[=;]/,
  getter: /\bget\s+(\w+)/,
  setter: /\bset\s+(\w+)/,
  function_definition: /\b(?:async\s+)?def\s+(\w+)/,
  class_definition: /\bclass\s+(\w+)/,
  decorated_definition: /\b(?:async\s+)?def\s+(\w+)/,
  class_specifier: /\bclass\s+(\w+)/,
  struct_specifier: /\bstruct\s+(\w+)/,
  enum_specifier: /\benum\s+(\w+)/,
  union_specifier: /\bunion\s+(\w+)/,
  function_item: /\bfn\s+(\w+)/,
  struct_item: /\bstruct\s+(\w+)/,
  enum_item: /\benum\s+(\w+)/,
  trait_item: /\btrait\s+(\w+)/,
  type_item: /\btype\s+(\w+)/,
  const_item: /\bconst\s+(\w+)/,
  static_item: /\bstatic\s+(\w+)/,
  method_declaration: /(\w+)\s*\(/,
  field_declaration: /(\w+)\s*[=;]/,
  method: /\bdef\s+(\w+)/,
  singleton_method: /\bdef\s+self\.(\w+)/,
  object_declaration: /\bobject\s+(\w+)/,
  property_declaration: /(\w+)\s*[=:]/,
  enum_entry: /(\w+)/,
  protocol_declaration: /\bprotocol\s+(\w+)/,
  variable_declaration: /(\w+)\s*[=:]/,
  trait_declaration: /\btrait\s+(\w+)/,
  function_definition_php: /\bfunction\s+(\w+)/,
};

function extractName(nodeType: string, text: string): string {
  const pattern = NAME_PATTERNS[nodeType];
  if (pattern) {
    const match = text.match(pattern);
    if (match && match[1]) return match[1];
  }

  const words = text.match(/\b(\w+)\b/);
  if (words && words[1]) return words[1];

  return `anonymous_${nodeType}`;
}

export async function parseFileForSymbols(
  filePath: string,
  content: string,
  language: string,
  skipExisting: boolean,
): Promise<DocSymbol[]> {
  const config = getConfigForFile(filePath, language);
  if (!config) return [];

  await initParser();
  const lang = await loadLanguage(config.language);
  const parser = new Parser();
  parser.setLanguage(lang);

  const tree = parser.parse(content);
  if (!tree) return [];

  const root = tree.rootNode;

  const symbols: DocSymbol[] = [];
  const nodeTypesSet = new Set(config.nodeTypes);

  const astNodes = walkTree(root, nodeTypesSet, content, 10);

  for (const node of astNodes) {
    const kind = config.kindMap[node.type] as DocSymbolKind | undefined;
    if (!kind) continue;

    const name = extractName(node.type, node.text);

    // Source-text scanning: detects any comment block preceding the symbol in raw source.
    // Works even when tree-sitter AST nesting (e.g. export_statement wrapping
    // class_declaration) prevents previousSibling traversal from finding the comment.
    const sourceComment = extractLeadingComment(content, node.startIndex);

    // Tree-sitter AST-level sibling traversal: handles Python docstrings inside
    // function/class bodies (which source-text scanning cannot see).
    const hasExistingDoc = sourceComment !== null || node.leadingDoc !== undefined;

    if (hasExistingDoc && skipExisting) continue;

    symbols.push({
      name,
      kind,
      startLine: node.startLine,
      endLine: node.endLine,
      hasExistingDoc,
      signature: node.text,
    });
  }

  return symbols;
}

/**
 * Scan raw source text before a given byte offset to detect any existing doc
 * comment block. Walks backward line-by-line, collecting consecutive comment
 * lines until non-comment content or the start of the file is reached.
 *
 * Handles:
 * - Multi-line `/** ... *``/ (no longer breaks on the closing `*``/ line)
 * - Single-line `/** ... *``/
 * - Line comments: `//`, `///`, `//!`
 * - Hash comments: `#` (Python, Ruby, shell)
 */
export function extractLeadingComment(content: string, symbolStart: number): string | null {
  const before = content.slice(0, Math.max(0, symbolStart)).trimEnd();
  const lines = before.split("\n");

  const commentLines: string[] = [];
  let foundComment = false;
  let inBlock = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const trimmed = line.trim();

    // Skip trailing blank lines before any comment is found
    if (!trimmed && !foundComment && !inBlock) continue;

    // Closing of a block comment: `*/`
    if (trimmed.endsWith("*/")) {
      commentLines.unshift(line);
      foundComment = true;
      // Single-line block comment like `/** foo */`
      if (trimmed.startsWith("/**") || trimmed.startsWith("/*")) {
        break;
      }
      inBlock = true;
      continue;
    }

    // Inside a block comment — keep collecting until we find the opening
    if (inBlock) {
      commentLines.unshift(line);
      if (trimmed.startsWith("/**") || trimmed.startsWith("/*")) {
        inBlock = false;
        break;
      }
      continue;
    }

    // Line comments
    if (trimmed.startsWith("///") || trimmed.startsWith("//!") || trimmed.startsWith("//") || trimmed.startsWith("#")) {
      commentLines.unshift(line);
      foundComment = true;
      continue;
    }

    // Doc continuation asterisk (e.g., ` * @param`)
    if (trimmed.startsWith("*")) {
      commentLines.unshift(line);
      foundComment = true;
      continue;
    }

    // Non-comment, non-empty → stop, we've gone too far
    if (trimmed.length > 0) break;

    // Empty line after finding comments → stop
    if (foundComment) break;
  }

  // If we ended with inBlock still true, we found `*/` without a matching `/**`
  // — still valid as an existing comment.
  return foundComment ? commentLines.join("\n") : null;
}
