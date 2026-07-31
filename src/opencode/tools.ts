/**
 * @fileoverview Factory functions for OpenCode autonomous-agent tools (file skeleton, find usages, describe image).
 */

/**
 * Specialized tool factories for autonomous agent workflows.
 *
 * Provides smaller, focused tools that are more efficient for agentic use:
 * - search_semantic   → conceptual code search
 * - get_file_skeleton → quick structural overview of a file
 * - find_usages       → find where a symbol is used/referenced
 * - describe_image    → describe an image file using a vision model
 *
 * These complement the general-purpose search_semantic tool.
 */

import { tool } from "@opencode-ai/plugin/tool";
import type { ToolDefinition } from "@opencode-ai/plugin";
import { CODE_SEARCH_FILTER, type EmbeddingProvider, type VectorStore, type KeywordIndex, type SearchResult } from "../core/interfaces.js";
import type { RagConfig } from "../core/config.js";
import { SUPPORTED_IMAGE_EXTENSIONS, createImageVisionProvider, getMimeType, type ImageVisionProvider } from "../chunker/image.js";
import { resizeImage } from "../content/image.js";
import { retrieve } from "../retriever/retriever.js";
import { Parser } from "web-tree-sitter";
import { initParser, loadLanguage, walkTree, type AstNode } from "../chunker/grammar.js";
import { readFileSync } from "node:fs";
import { resolveWorkspacePath } from "./tool-args.js";
import { addQuirk, updateQuirk, removeQuirk, recallQuirks } from "../quirks/quirk-store.js";

// ────────────────────────────────────────────────────────────────────────────
// Skeleton configuration: file extension → tree-sitter grammar + node types
// ────────────────────────────────────────────────────────────────────────────

interface SkeletonConfig {
  grammarName: string;
  nodeTypes: string[];
}

const SKELETON_CONFIGS: Record<string, SkeletonConfig> = {
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
const REGEX_SKELETON: Record<string, RegExp[]> = {
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
 * Return the file extension from a path (lowercase).
 */
function getExtension(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
}

/**
 * Resolve a file path relative to the workspace root.
 */
function resolveFilePath(filePath: string, worktree: string): string {
  return resolveWorkspacePath(worktree, filePath);
}

/**
 * Extract structural outline from source code using tree-sitter.
 * Falls back to regex patterns for languages without WASM grammars.
 */
async function extractSkeleton(
  content: string,
  ext: string
): Promise<{ type: string; name: string; startLine: number; endLine: number }[]> {
  const config = SKELETON_CONFIGS[ext];
  if (!config) {
    // Fallback: use regex patterns
    const patterns = REGEX_SKELETON[ext];
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
      const key = `${item.type}:${item.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
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

  const nodeTypes = new Set(config.nodeTypes);
  const astNodes: AstNode[] = walkTree(tree.rootNode, nodeTypes, content, 15);
  tree.delete();
  parser.delete();
  return astNodes.map((node) => ({
    type: node.type,
    name: extractNodeName(node.text, node.type),
    startLine: node.startLine,
    endLine: node.endLine,
  }));
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

/**
 * Format a skeleton outline as a compact markdown string.
 */
function formatSkeleton(
  items: { type: string; name: string; startLine: number; endLine: number }[]
): string {
  if (items.length === 0) return "_(no structural elements found)_";

  const lines: string[] = [];

  for (const item of items) {
    const depth = item.type === "file" ? 0 : 1;
    const indent = "  ".repeat(depth);
    const lineRange = item.startLine === item.endLine
      ? `L${item.startLine}`
      : `L${item.startLine}-${item.endLine}`;
    const icon = typeIcon(item.type);

    lines.push(`${indent}${icon} \`${item.name}\` ${lineRange}`);
  }

  return lines.join("\n");
}

function typeIcon(type: string): string {
  if (type.includes("class") || type === "struct_specifier" || type === "struct_item" || type === "struct_declaration") return "□";
  if (type.includes("interface") || type === "protocol_declaration" || type === "trait_item") return "◇";
  if (type.includes("function") || type === "method" || type === "method_declaration" || type === "method_definition" || type === "arrow_function") return "ƒ";
  if (type.includes("enum")) return "§";
  if (type.includes("type") || type === "type_alias_declaration") return "τ";
  if (type === "impl_item") return "⊞";
  if (type === "rule_set") return "#";
  if (type === "atx_heading") return "¶";
  return "·";
}

// ────────────────────────────────────────────────────────────────────────────
// Tool 1: get_file_skeleton
// ────────────────────────────────────────────────────────────────────────────

/** Options for creating the `get_file_skeleton` tool. */
export interface FileSkeletonToolOptions {
  worktree: string;
}

/**
 * Create the `get_file_skeleton` tool.
 *
 * Purpose: Quickly orient in a file without reading it entirely.
 * Returns a structural outline (functions, classes, interfaces, etc.)
 * with line numbers, using tree-sitter for parsing.
 */
export function createFileSkeletonTool(
  options: FileSkeletonToolOptions
): ToolDefinition {
  const { worktree } = options;

  return tool({
    description:
      "Get a quick structural overview of a source file — functions, classes, " +
      "interfaces, methods, and other top-level declarations with their line numbers. " +
      "MANDATORY before reading any file — calling read without this wastes tokens on irrelevant sections. " +
      "Supports TypeScript, JavaScript, Python, Java, Go, Rust, C/C++, C#, Ruby, Swift, Kotlin, and more.",

    args: {
      filePath: tool.schema.string().min(1, "A file path is required."),
    },

    async execute(args) {
      try {
        const resolvedPath = resolveFilePath(args.filePath, worktree);
        const content = readFileSync(resolvedPath, "utf-8");
        const ext = getExtension(args.filePath);

        const skeleton = await extractSkeleton(content, ext);

        const declCounts = new Map<string, number>();
        for (const item of skeleton) {
          const baseType = item.type.replace(/_declaration$|_definition$|_specifier$|_item$/, "");
          declCounts.set(baseType, (declCounts.get(baseType) ?? 0) + 1);
        }
        const summary = [...declCounts.entries()]
          .map(([t, c]) => `${c} ${t}`)
          .join(", ");

        return {
          title: `Skeleton — ${args.filePath}`,
          output: `**${args.filePath}**  \n${skeleton.length} structural elements (${summary || "—"})\n\n` +
            formatSkeleton(skeleton) +
            `\n\n_Use the read tool for full content._`,
          metadata: {
            tool: "get_file_skeleton",
            filePath: args.filePath,
            elements: skeleton.length,
            language: ext.slice(1),
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          title: "Skeleton",
          output: `Could not read file: ${message}`,
          metadata: { tool: "get_file_skeleton", filePath: args.filePath, error: message },
        };
      }
    },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Tool 3: find_usages
// ────────────────────────────────────────────────────────────────────────────

/** Options for creating the `find_usages` tool. */
export interface FindUsagesToolOptions {
  store: VectorStore;
  embedder: EmbeddingProvider;
  cfg: RagConfig;
  keywordIndex?: KeywordIndex;
  retrieveFn?: typeof retrieve;
}

/**
 * Create the `find_usages` tool.
 *
 * Purpose: Find where a specific symbol/identifier is used or referenced
 * in the codebase. Essential for agents before they modify a function.
 *
 * Strategy:
 * 1. Use the keyword index for exact/similar token matches (fast, precise)
 * 2. Fall back to vector search for broader referral discovery
 * 3. Within matching chunks, extract the specific lines containing the symbol
 *    plus 2 lines of surrounding context
 */
// ────────────────────────────────────────────────────────────────────────────
// Tool 4: describe_image
// ────────────────────────────────────────────────────────────────────────────

/** Options for creating the `describe_image` tool. */
export interface DescribeImageToolOptions {
  worktree: string;
  config: RagConfig;
  visionProvider?: ImageVisionProvider;
}

/**
 * Create the `describe_image` tool.
 *
 * Reads an image file from disk and sends it to the configured vision provider
 * for natural-language description. Supports Ollama, OpenAI, Anthropic, and
 * Google Gemini providers with automatic resizing.
 *
 * @param options - Tool configuration including workspace root and vision provider.
 * @returns A tool definition suitable for OpenCode plugin registration.
 */
export function createDescribeImageTool(
  options: DescribeImageToolOptions
): ToolDefinition {
  const { worktree, config, visionProvider } = options;

  return tool({
    description:
      "Describe an image file using a vision model. " +
      "Reads the file from disk, sends it to the configured vision provider (Ollama, OpenAI, Anthropic, or Google Gemini), " +
      "and returns a natural language description of what the image shows. " +
      "Use when the user refers to a screenshot, diagram, mockup, or any image in the workspace.",

    args: {
      filePath: tool.schema.string().min(1, "An image file path is required."),
    },

    async execute(args) {
      try {
        const { existsSync, readFileSync } = await import("node:fs");
        const path = await import("node:path");

        const resolvedPath = resolveWorkspacePath(worktree, args.filePath);

        if (!existsSync(resolvedPath)) {
          return {
            title: "Describe image",
            output: `File not found: ${args.filePath}`,
            metadata: { tool: "describe_image", filePath: args.filePath, error: "not_found" },
          };
        }

        const ext = path.extname(resolvedPath).toLowerCase();
        if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
          const exts = [...SUPPORTED_IMAGE_EXTENSIONS].join(", ");
          return {
            title: "Describe image",
            output: `Unsupported file extension "${ext}". Supported: ${exts}`,
            metadata: { tool: "describe_image", filePath: args.filePath, error: "unsupported_extension" },
          };
        }

        const imageDescriptionConfig = config.imageDescription;
        if (!imageDescriptionConfig?.enabled) {
          return {
            title: "Describe image",
            output: "Image description is not enabled in config (imageDescription.enabled).",
            metadata: { tool: "describe_image", filePath: args.filePath, error: "disabled" },
          };
        }

        const buffer = readFileSync(resolvedPath);
        const mimeType = getMimeType(ext);
        const maxDimension = imageDescriptionConfig.resizeMaxDimension ?? 1024;
        const sized = maxDimension > 0 ? await resizeImage(buffer, resolvedPath, maxDimension) : buffer;
        const b64 = sized.toString("base64");

        const provider = visionProvider ?? createImageVisionProvider(imageDescriptionConfig);
        const description = await provider.describeImage(b64, mimeType, imageDescriptionConfig.prompt);

        return {
          title: `Image description — ${args.filePath}`,
          output: `**${args.filePath}**\n\n${description}\n\n_Generated with ${imageDescriptionConfig.provider}/${imageDescriptionConfig.model}_`,
          metadata: {
            tool: "describe_image",
            filePath: args.filePath,
            description,
            provider: imageDescriptionConfig.provider,
            model: imageDescriptionConfig.model,
          },
        };
      } catch (err) {
        return {
          title: "Describe image",
          output: `Failed to describe image: ${err instanceof Error ? err.message : String(err)}`,
          metadata: { tool: "describe_image", filePath: args.filePath, error: String(err) },
        };
      }
    },
  });
}

/**
 * Create the `find_usages` tool.
 *
 * Searches the indexed codebase for references to a given symbol by combining
 * keyword index matches (fast, precise) with vector-store fallback (broader
 * referral discovery). Extracts line-level matches with surrounding context
 * and groups results by file.
 *
 * @param options - Store, embedder, config, and optional keyword index.
 * @returns A tool definition suitable for OpenCode plugin registration.
 */
export function createFindUsagesTool(
  options: FindUsagesToolOptions
): ToolDefinition {
  const { store, embedder, cfg, keywordIndex } = options;
  const retrieveFn = options.retrieveFn ?? retrieve;

  /**
   * Given a list of lines and a symbol, return the lines that reference it
   * with 2 lines of surrounding context. Avoids returning the definition line.
   */
  function extractUsageLines(
    lines: string[],
    symbol: string,
    definitionLine?: number
  ): { line: number; content: string; context: string[] }[] {
    const usages: { line: number; content: string; context: string[] }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNum = i + 1;

      // Skip the definition line
      if (definitionLine !== undefined && lineNum === definitionLine) continue;

      // Check if line contains the symbol as a word (not just substring)
      const symbolPattern = new RegExp(
        `\\b${escapeRegex(symbol)}\\b`
      );
      if (!symbolPattern.test(line)) continue;

      // Gather context lines (2 before, 2 after)
      const ctxStart = Math.max(0, i - 2);
      const ctxEnd = Math.min(lines.length, i + 3);
      const contextLines = lines.slice(ctxStart, ctxEnd).map((l) => l.trimEnd());

      usages.push({
        line: lineNum,
        content: line.trimEnd(),
        context: contextLines,
      });
    }

    return usages;
  }

  async function searchViaKeywordIndex(
    symbol: string,
    topK: number
  ): Promise<SearchResult[]> {
    if (!keywordIndex) return [];
    return keywordIndex.search(symbol, topK, CODE_SEARCH_FILTER);
  }

  async function searchViaVectorStore(
    symbol: string,
    topK: number
  ): Promise<SearchResult[]> {
    const count = await store.count();
    if (count === 0) return [];

    return retrieveFn(symbol, embedder, store, {
      topK,
      minScore: 0,
      keywordIndex: undefined,
      queryPrefix: cfg.embedding.queryPrefix,
      filter: CODE_SEARCH_FILTER,
    });
  }

  function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  return tool({
    description:
      "Find usages and references of a symbol (function, variable, class, etc.) " +
      "across the indexed codebase. REQUIRED before editing any function, variable, or class — " +
      "skipping this breaks unseen call sites. Shows every line that references the symbol with surrounding context.",

    args: {
      symbolName: tool.schema.string().min(1, "A symbol name is required."),
      pathHint: tool.schema.string().optional(),
      topK: tool.schema.number().int().min(1).max(50).optional(),
    },

    async execute(args) {
      const symbolName = args.symbolName.trim();
      const topK = args.topK ?? 30;

      try {
        // Phase 1: keyword index search (fast, precise)
        const kwResults = await searchViaKeywordIndex(symbolName, topK);

        // Phase 2: vector store search (broader)
        const vsResults = await searchViaVectorStore(symbolName, topK * 2);

        // Merge results: prefer keyword matches, deduplicate
        const seen = new Set<string>();
        const merged: SearchResult[] = [];

        const addIfNew = (r: SearchResult) => {
          const key = `${r.chunk.metadata.filePath}:${r.chunk.metadata.startLine}`;
          if (seen.has(key)) return;
          seen.add(key);
          merged.push(r);
        };

        for (const r of kwResults) addIfNew(r);
        for (const r of vsResults) addIfNew(r);

        if (merged.length === 0) {
          return {
            title: `Usages of "${symbolName}"`,
            output: `No usages found for \`${symbolName}\`. The symbol may not be indexed or may not exist in the codebase.`,
            metadata: { tool: "find_usages", symbolName, matches: 0 },
          };
        }

        // Process results: extract usages at line level
        type UsageGroup = {
          filePath: string;
          language: string;
          usages: { line: number; content: string; context: string[] }[];
        };

        const fileGroups = new Map<string, UsageGroup>();

        for (const result of merged) {
          const m = result.chunk.metadata;
          const lines = result.chunk.content.split("\n");

          // Try to find where the symbol is *defined* in this chunk
          const defPattern = new RegExp(
            `(?:function|class|interface|type|enum|const|let|var|def|fun|fn)\\s+${escapeRegex(symbolName)}\\b`
          );
          let definitionLine: number | undefined;
          for (let i = 0; i < lines.length; i++) {
            if (defPattern.test(lines[i]!)) {
              definitionLine = m.startLine + i;
              break;
            }
          }

          const usages = extractUsageLines(lines, symbolName, definitionLine);

          if (usages.length === 0) continue;

          let group = fileGroups.get(m.filePath);
          if (!group) {
            group = { filePath: m.filePath, language: m.language, usages: [] };
            fileGroups.set(m.filePath, group);
          }

          for (const u of usages) {
            // Avoid duplicates within the same file
            if (!group.usages.some((g) => g.line === u.line)) {
              group.usages.push(u);
            }
          }
        }

        if (fileGroups.size === 0) {
          return {
            title: `Usages of "${symbolName}"`,
            output: `No usages found for \`${symbolName}\`. The symbol appears in indexed chunks but no reference lines were found.`,
            metadata: { tool: "find_usages", symbolName, matches: 0 },
          };
        }

        // Format output
        const lines: string[] = [];
        const totalMatches = [...fileGroups.values()].reduce((s, g) => s + g.usages.length, 0);
        lines.push(`**Usages of \`${symbolName}\`** — ${totalMatches} references across ${fileGroups.size} files\n`);

        for (const [filePath, group] of fileGroups) {
          // Sort usages by line number
          group.usages.sort((a, b) => a.line - b.line);

          lines.push(`### ${filePath} (${group.language})\n`);
          lines.push("| Line | Code |");
          lines.push("|------|------|");

          for (const usage of group.usages) {
            const ctx = usage.context;
            const codeLine = ctx[Math.min(2, ctx.length - 1)] ?? usage.content;
            const escaped = codeLine.length > 100
              ? codeLine.slice(0, 97) + "..."
              : codeLine;
            lines.push(`| ${usage.line} | \`${escaped}\` |`);
          }
          lines.push("");
        }

        lines.push("---\n");
        lines.push(`_Use \`get_file_skeleton\` for a quick file overview or \`search_semantic\` for broader context._`);

        return {
          title: `Usages of "${symbolName}" (${totalMatches} matches)`,
          output: lines.join("\n"),
          metadata: {
            tool: "find_usages",
            symbolName,
            matches: totalMatches,
            files: fileGroups.size,
          },
        };
      } catch (err) {
        return {
          title: `Usages of "${symbolName}"`,
          output: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
          metadata: { tool: "find_usages", symbolName, error: String(err) },
        };
      }
    },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Tool 5: recall_quirks
// ────────────────────────────────────────────────────────────────────────────

/** Options for creating the `recall_quirks` tool. */
export interface RecallQuirksToolOptions {
  store: VectorStore;
  embedder: EmbeddingProvider;
  cfg: RagConfig;
  keywordIndex: KeywordIndex;
  storePath: string;
}

/**
 * Create the `recall_quirks` tool.
 *
 * Queries experiential quirk memory (gotchas, preferences, decisions,
 * environment constraints) via hybrid vector-keyword search filtered to
 * `kind === "quirk"`. Results are re-weighted by confidence.
 *
 * @param options - Store, embedder, config, keyword index, store path.
 * @returns A tool definition suitable for OpenCode plugin registration.
 */
export function createRecallQuirksTool(options: RecallQuirksToolOptions): ToolDefinition {
  const { store, embedder, cfg, keywordIndex, storePath } = options;

  return tool({
    description:
      "Query experiential quirk memory — gotchas, preferences, decisions, and " +
      "environment constraints discovered during previous sessions. " +
      "Leverage when you encounter an error, need to recall how something works, " +
      "or want to avoid known pitfalls. Results are filtered by confidence and " +
      "relevance.",

    args: {
      query: tool.schema.string().min(1, "A search query is required."),
      topK: tool.schema.number().int().min(1).max(25).optional(),
      quirkType: tool.schema.string().optional(),
      tags: tool.schema.array(tool.schema.string().min(1)).max(10).optional(),
    },

    async execute(args) {
      try {
        const deps = { embedder, store, keywordIndex, cfg, storePath };
        const results = await recallQuirks(deps, args.query, {
          topK: args.topK ?? 10,
          quirkType: args.quirkType,
          tags: args.tags,
        });

        if (results.length === 0) {
          return {
            title: "Quirk memory recall",
            output: "No quirks matched your query.",
            metadata: { tool: "recall_quirks", query: args.query, matches: 0 },
          };
        }

        const lines: string[] = [];
        lines.push(`**${results.length} quirk(s) found:**\n`);
        for (const r of results) {
          const m = r.chunk.metadata;
          const badge = m.quirkType ? `[\`${m.quirkType}\`] ` : "";
          const tags =
            m.tags && m.tags.length > 0 ? ` _(${m.tags.join(", ")})_` : "";
          const confidence = m.confidence != null
            ? ` confidence=${(m.confidence * 100).toFixed(0)}%`
            : "";
          const score = r.score.toFixed(3);
          lines.push(
            `- ${badge}${r.chunk.content}${tags}`,
            `  _score=${score}${confidence}_`,
          );
        }

        return {
          title: `Quirk memory recall (${results.length})`,
          output: lines.join("\n"),
          metadata: {
            tool: "recall_quirks",
            query: args.query,
            matches: results.length,
          },
        };
      } catch (err) {
        return {
          title: "Quirk memory recall",
          output: `Recall failed: ${err instanceof Error ? err.message : String(err)}`,
          metadata: { tool: "recall_quirks", error: String(err) },
        };
      }
    },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Tool 6: add_quirk
// ────────────────────────────────────────────────────────────────────────────

/** Options for creating the `add_quirk` tool. */
export interface AddQuirkToolOptions {
  store: VectorStore;
  embedder: EmbeddingProvider;
  cfg: RagConfig;
  keywordIndex: KeywordIndex;
  storePath: string;
}

/**
 * Create the `add_quirk` tool.
 *
 * Stores a new quirk into experiential memory. The quirk is embedded as a
 * synthetic chunk (kind="quirk") in the vector store and indexed in the
 * keyword index. An audit trail is written to quirks.jsonl.
 *
 * @param options - Store, embedder, config, keyword index, store path.
 * @returns A tool definition suitable for OpenCode plugin registration.
 */
export function createAddQuirkTool(options: AddQuirkToolOptions): ToolDefinition {
  const { store, embedder, cfg, keywordIndex, storePath } = options;

  return tool({
    description:
      "Store a new experiential memory (quirk) — a gotcha, preference, decision, or " +
      "environment constraint you discovered. The quirk is embedded and indexed so " +
      "future sessions can recall it via `recall_quirks`. Use when you hit a " +
      "non-obvious behavior, workaround, or coding convention.",

    args: {
      content: tool.schema.string().min(1, "Quirk content is required."),
      quirkType: tool.schema
        .string()
        .optional(),
      tags: tool.schema.array(tool.schema.string().min(1)).max(10).optional(),
      sourceRef: tool.schema.string().optional(),
    },

    async execute(args) {
      try {
        const deps = { embedder, store, keywordIndex, cfg, storePath };
        const quirk = await addQuirk(deps, {
          content: args.content,
          quirkType: args.quirkType,
          tags: args.tags,
          sourceRef: args.sourceRef,
        });

        return {
          title: "Quirk added",
          output: `**Quirk recorded** (id: \`${quirk.id}\`)\n\`${args.quirkType ?? "general"}\` | confidence=${(quirk.confidence * 100).toFixed(0)}% | tags=${(quirk.tags ?? []).join(", ") || "none"}`,
          metadata: {
            tool: "add_quirk",
            quirkId: quirk.id,
            quirkType: quirk.quirkType,
            confidence: quirk.confidence,
          },
        };
      } catch (err) {
        return {
          title: "Quirk add",
          output: `Failed to add quirk: ${err instanceof Error ? err.message : String(err)}`,
          metadata: { tool: "add_quirk", error: String(err) },
        };
      }
    },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Tool 7: update_quirk
// ────────────────────────────────────────────────────────────────────────────

/** Options for creating the `update_quirk` tool. */
export interface UpdateQuirkToolOptions {
  store: VectorStore;
  embedder: EmbeddingProvider;
  cfg: RagConfig;
  keywordIndex: KeywordIndex;
  storePath: string;
}

/**
 * Create the `update_quirk` tool.
 *
 * Updates an existing quirk by ID — replaces content, type, tags, confidence,
 * or source ref. When content changes, the quirk is re-embedded so recall
 * matches the corrected text. The new content passes the trust monitor.
 *
 * @param options - Store, embedder, config, keyword index, store path.
 * @returns A tool definition suitable for OpenCode plugin registration.
 */
export function createUpdateQuirkTool(options: UpdateQuirkToolOptions): ToolDefinition {
  const { store, embedder, cfg, keywordIndex, storePath } = options;

  return tool({
    description:
      "Update an existing experiential memory (quirk) by its ID — fix outdated " +
      "content, change its type, tags, or source ref. Use when a quirk from a " +
      "past session is outdated, wrong, or superseded. Find the ID via " +
      "`recall_quirks` (it is listed in the recall output) or `quirk list` " +
      "in the CLI.",

    args: {
      id: tool.schema.string().min(1, "Quirk ID is required."),
      content: tool.schema.string().optional(),
      quirkType: tool.schema.string().optional(),
      tags: tool.schema.array(tool.schema.string().min(1)).max(10).optional(),
      confidence: tool.schema.number().min(0).max(1).optional(),
      sourceRef: tool.schema.string().optional(),
    },

    async execute(args) {
      try {
        const deps = { embedder, store, keywordIndex, cfg, storePath };
        const fields = [
          args.content,
          args.quirkType,
          args.tags,
          args.confidence,
          args.sourceRef,
        ];
        if (fields.every((f) => f === undefined)) {
          return {
            title: "Quirk update",
            output: "Nothing to update — provide at least one of `content`, `quirkType`, `tags`, `confidence`, or `sourceRef`.",
            metadata: { tool: "update_quirk", quirkId: args.id, error: "no fields provided" },
          };
        }

        const quirk = await updateQuirk(deps, args.id, {
          content: args.content,
          quirkType: args.quirkType,
          tags: args.tags,
          confidence: args.confidence,
          sourceRef: args.sourceRef,
        });

        return {
          title: "Quirk updated",
          output:
            `**Quirk updated** (id: \`${quirk.id}\`)\n` +
            `\`${quirk.quirkType ?? "general"}\` | confidence=${(quirk.confidence * 100).toFixed(0)}% | tags=${(quirk.tags ?? []).join(", ") || "none"}\n` +
            quirk.content,
          metadata: {
            tool: "update_quirk",
            quirkId: quirk.id,
            quirkType: quirk.quirkType,
            confidence: quirk.confidence,
          },
        };
      } catch (err) {
        return {
          title: "Quirk update",
          output: `Failed to update quirk: ${err instanceof Error ? err.message : String(err)}`,
          metadata: { tool: "update_quirk", error: String(err) },
        };
      }
    },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Tool 8: delete_quirk
// ────────────────────────────────────────────────────────────────────────────

/** Options for creating the `delete_quirk` tool. */
export interface DeleteQuirkToolOptions {
  store: VectorStore;
  embedder: EmbeddingProvider;
  cfg: RagConfig;
  keywordIndex: KeywordIndex;
  storePath: string;
}

/**
 * Create the `delete_quirk` tool.
 *
 * Removes a quirk by ID from the vector store, keyword index, and audit log.
 * Use when a quirk is wrong, no longer applies, or has been superseded by an
 * updated version.
 *
 * @param options - Store, embedder, config, keyword index, store path.
 * @returns A tool definition suitable for OpenCode plugin registration.
 */
export function createDeleteQuirkTool(options: DeleteQuirkToolOptions): ToolDefinition {
  const { store, embedder, cfg, keywordIndex, storePath } = options;

  return tool({
    description:
      "Delete an experiential memory (quirk) by its ID. Use when a quirk is " +
      "wrong, outdated, or superseded — for example a gotcha that was fixed " +
      "or a decision that was reversed. Find the ID via `recall_quirks` (it " +
      "is listed in the recall output) or `quirk list` in the CLI.",

    args: {
      id: tool.schema.string().min(1, "Quirk ID is required."),
    },

    async execute(args) {
      try {
        const deps = { embedder, store, keywordIndex, cfg, storePath };
        await removeQuirk(deps, args.id);

        return {
          title: "Quirk deleted",
          output: `**Quirk deleted** (id: \`${args.id}\`). It will no longer be recalled or auto-injected.`,
          metadata: { tool: "delete_quirk", quirkId: args.id },
        };
      } catch (err) {
        return {
          title: "Quirk delete",
          output: `Failed to delete quirk: ${err instanceof Error ? err.message : String(err)}`,
          metadata: { tool: "delete_quirk", error: String(err) },
        };
      }
    },
  });
}
