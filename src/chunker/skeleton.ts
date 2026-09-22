/**
 * @fileoverview Shared file-skeleton extraction: extension → tree-sitter grammar + node types.
 *
 * Historically this table (and {@link extractSkeleton}) was copy-pasted into
 * both the OpenCode plugin tools (`src/opencode/tools.ts`) and the MCP server
 * (`src/mcp/handlers.ts`), and had already drifted from the chunker registry.
 * It now lives here so both surfaces — plus `chunking.parsers` overrides —
 * resolve extensions the same way.
 */
import { Parser } from "web-tree-sitter";
import { initParser, loadLanguage, walkTree, type AstNode } from "./grammar.js";
import { getExtensionsForLanguage, getRegisteredLanguages } from "./factory.js";
import {
  normalizeParserOverrides,
  type ParserOverrides,
} from "../core/parser-overrides.js";

/** Skeleton extraction recipe for one file extension. */
export interface SkeletonConfig {
  /** tree-sitter grammar name (as resolved by {@link loadLanguage}). */
  grammarName: string;
  /** AST node types to collect as structural elements. */
  nodeTypes: string[];
}

/** Extension → tree-sitter grammar + node types for skeleton extraction. */
export const SKELETON_CONFIGS: Record<string, SkeletonConfig> = {
  ".ts":    { grammarName: "typescript", nodeTypes: ["function_declaration", "method_definition", "class_declaration", "interface_declaration", "type_alias_declaration", "enum_declaration"] },
  ".tsx":   { grammarName: "typescript", nodeTypes: ["function_declaration", "method_definition", "class_declaration", "interface_declaration", "type_alias_declaration", "enum_declaration", "arrow_function"] },
  ".mts":   { grammarName: "typescript", nodeTypes: ["function_declaration", "method_definition", "class_declaration", "interface_declaration", "type_alias_declaration", "enum_declaration"] },
  ".cts":   { grammarName: "typescript", nodeTypes: ["function_declaration", "method_definition", "class_declaration", "interface_declaration", "type_alias_declaration", "enum_declaration"] },
  ".js":    { grammarName: "javascript", nodeTypes: ["function_declaration", "method_definition", "class_declaration", "arrow_function"] },
  ".jsx":   { grammarName: "javascript", nodeTypes: ["function_declaration", "method_definition", "class_declaration", "arrow_function"] },
  ".mjs":   { grammarName: "javascript", nodeTypes: ["function_declaration", "method_definition", "class_declaration", "arrow_function"] },
  ".cjs":   { grammarName: "javascript", nodeTypes: ["function_declaration", "method_definition", "class_declaration", "arrow_function"] },
  ".py":    { grammarName: "python", nodeTypes: ["function_definition", "class_definition", "decorated_definition"] },
  ".java":  { grammarName: "java", nodeTypes: ["class_declaration", "method_declaration", "interface_declaration", "enum_declaration"] },
  ".go":    { grammarName: "go", nodeTypes: ["function_declaration", "method_declaration", "type_declaration", "type_spec"] },
  ".rs":    { grammarName: "rust", nodeTypes: ["function_item", "struct_item", "enum_item", "impl_item", "trait_item", "type_item"] },
  ".c":     { grammarName: "c", nodeTypes: ["function_definition", "struct_specifier", "enum_specifier"] },
  ".cpp":   { grammarName: "cpp", nodeTypes: ["function_definition", "class_specifier", "struct_specifier", "enum_specifier"] },
  ".cxx":   { grammarName: "cpp", nodeTypes: ["function_definition", "class_specifier", "struct_specifier", "enum_specifier"] },
  ".h":     { grammarName: "cpp", nodeTypes: ["function_definition", "class_specifier", "struct_specifier", "enum_specifier"] },
  ".hpp":   { grammarName: "cpp", nodeTypes: ["function_definition", "class_specifier", "struct_specifier", "enum_specifier"] },
  ".cs":    { grammarName: "c-sharp", nodeTypes: ["class_declaration", "method_declaration", "interface_declaration", "enum_declaration", "struct_declaration"] },
  ".rb":    { grammarName: "ruby", nodeTypes: ["method", "class", "module"] },
  ".swift": { grammarName: "swift", nodeTypes: ["function_declaration", "class_declaration", "struct_declaration", "enum_declaration", "protocol_declaration"] },
  ".kt":    { grammarName: "kotlin", nodeTypes: ["function_declaration", "class_declaration", "interface_declaration", "object_declaration"] },
  ".kts":   { grammarName: "kotlin", nodeTypes: ["function_declaration", "class_declaration", "interface_declaration", "object_declaration"] },
  ".css":   { grammarName: "css", nodeTypes: ["rule_set"] },
  ".md":    { grammarName: "markdown", nodeTypes: ["atx_heading"] },
};

/** Regex-based fallback for languages without tree-sitter WASM support. */
export const REGEX_SKELETON: Record<string, RegExp[]> = {
  ".json": [/^(\s*)"(\w+)":/gm],
  ".yaml": [/^(\w+):/gm],
  ".yml":  [/^(\w+):/gm],
  ".toml": [/^\[(\w+)\]/gm],
  ".sh":   [/^(function\s+\w+|^\w+\s*\(\)\s*\{)/gm],
  ".bash": [/^(function\s+\w+|^\w+\s*\(\)\s*\{)/gm],
  ".zsh":  [/^(function\s+\w+|^\w+\s*\(\)\s*\{)/gm],
  ".sql":  [/^(CREATE|ALTER|DROP|SELECT|INSERT|UPDATE|DELETE)\s/gim],
};

/**
 * Sentinel lookup key that matches neither config map. Used when a
 * `chunking.parsers` override targets a parser with no skeleton recipe —
 * the extension's own (now wrong) recipe must NOT be used, so fall through
 * to the line-count fallback instead.
 */
const NO_SKELETON = "\u0000no-skeleton";

/** Unknown override targets already reported, so a bad config warns once per process. */
const warnedUnknownTargets = new Set<string>();

/** Optional skeleton extraction options. */
export interface SkeletonOptions {
  /** Extension → parser overrides from `chunking.parsers`. */
  languageByExtension?: ParserOverrides;
}

/**
 * Return the file extension from a path (lowercase, dot-prefixed when present).
 */
export function getExtension(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
}

/**
 * Resolve the skeleton-config lookup key for an extension, honoring
 * `chunking.parsers` overrides.
 *
 * Non-overridden extensions resolve to themselves, so per-extension recipes
 * that legitimately differ (`.ts` vs `.tsx`) are untouched. Overridden ones
 * jump to a representative extension of the target parser.
 */
function resolveSkeletonKey(ext: string, overrides: ParserOverrides): string {
  const target = overrides[ext];
  if (!target) return ext;

  if (!getRegisteredLanguages().includes(target)) {
    if (!warnedUnknownTargets.has(target)) {
      warnedUnknownTargets.add(target);
      const known = getRegisteredLanguages();
      console.warn(
        `[opencode-rag] chunking.parsers maps "${ext}" to unknown parser "${target}" ` +
        `— known parsers: ${known.join(", ")}. Using the default skeleton for "${ext}".`
      );
    }
    return ext;
  }

  const candidates = getExtensionsForLanguage(target);
  const hit = candidates.find((c) => SKELETON_CONFIGS[c] || REGEX_SKELETON[c]);
  // Known parser but no skeleton recipe for it (e.g. plain text, PDF): the
  // extension's own recipe would be the wrong parser, so fall through to the
  // line-count fallback instead of using it.
  return hit ?? NO_SKELETON;
}

/**
 * Extract structural outline from source code using tree-sitter.
 * Falls back to regex patterns for languages without WASM grammars, and to a
 * plain line count when neither recipe applies.
 *
 * @param content - Full file content.
 * @param ext     - Lowercase, dot-prefixed file extension.
 * @param options - Optional `chunking.parsers` override map.
 */
export async function extractSkeleton(
  content: string,
  ext: string,
  options?: SkeletonOptions
): Promise<{ type: string; name: string; startLine: number; endLine: number }[]> {
  const overrides = normalizeParserOverrides(options?.languageByExtension);
  const key = resolveSkeletonKey(ext, overrides);

  const config = SKELETON_CONFIGS[key];
  if (!config) {
    // Fallback: use regex patterns
    const patterns = REGEX_SKELETON[key];
    if (!patterns) {
      // Last fallback: line count
      const lines = content.split("\n");
      return [{ type: "file", name: `${lines.length} lines`, startLine: 1, endLine: lines.length }];
    }

    const items: { type: string; name: string; startLine: number; endLine: number }[] = [];
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      // Reset lastIndex
      pattern.lastIndex = 0;
      while ((match = pattern.exec(content)) !== null) {
        const name = match[1] ?? match[0].trim();
        const lineNum = content.slice(0, match.index).split("\n").length;
        items.push({ type: ext.slice(1), name, startLine: lineNum, endLine: lineNum });
      }
    }
    const seen = new Set<string>();
    return items.filter((item) => {
      const seenKey = `${item.type}:${item.name}`;
      if (seen.has(seenKey)) return false;
      seen.add(seenKey);
      return true;
    });
  }

  // Tree-sitter skeleton extraction
  await initParser();
  const lang = await loadLanguage(config.grammarName);
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(content);
  if (!tree) return [];

  try {
    const nodeTypes = new Set(config.nodeTypes);
    const astNodes: AstNode[] = walkTree(tree.rootNode, nodeTypes, content, 15);
    return astNodes.map((node) => ({
      type: node.type,
      name: extractNodeName(node.text, node.type),
      startLine: node.startLine,
      endLine: node.endLine,
    }));
  } finally {
    tree.delete();
    parser.delete();
  }
}

/**
 * Extract a human-readable name from a code node.
 * For declarations, this is typically the identifier after the keyword.
 */
function extractNodeName(text: string, _nodeType: string): string {
  // Try first line only for large nodes
  const firstLine = text.split("\n")[0] ?? text;

  // Common patterns: "function foo(...)" or "class Foo ..." or "foo(...)" (arrow, method)
  const nameMatch = firstLine.match(
    /^(?:export\s+)?(?:async\s+)?(?:function\s+)?(?:\w+\s+)?(?:(\w+))\s*(?:[<(]|$)/
  );

  if (nameMatch) {
    // Skip keywords
    const keywordSet = new Set(["export", "async", "function", "class", "interface", "type", "enum", "struct", "impl", "trait", "def", "fun", "fn"]);
    if (!keywordSet.has(nameMatch[1]!)) {
      return nameMatch[1]!;
    }
    // Try next word
    const secondMatch = firstLine.match(/^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|struct|trait|impl|def|fun|fn)\s+(\w+)/);
    if (secondMatch) return secondMatch[1]!;
  }

  // Last resort: return first 80 chars of first line
  return firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
}
