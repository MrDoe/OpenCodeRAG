/**
 * @fileoverview Handler implementations for all MCP tools: semantic search, file skeleton, symbol usage lookup, and image description.
 */
import type { EmbeddingProvider, VectorStore, KeywordIndex, SearchResult } from "../core/interfaces.js";
import type { RagConfig } from "../core/config.js";
import { SUPPORTED_IMAGE_EXTENSIONS, type ImageVisionProvider } from "../chunker/image.js";
import { retrieve, type RetrieveOptions } from "../retriever/retriever.js";
import { optimizeContext, DEFAULT_CONTEXT_OPTIMIZATION } from "../retriever/context-optimizer.js";
import { Parser } from "web-tree-sitter";
import { initParser, loadLanguage, walkTree, type AstNode } from "../chunker/grammar.js";
import { readFileSync } from "node:fs";
import { resolveWorkspacePath } from "../opencode/tool-args.js";

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

function getExtension(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
}

function resolveFilePath(filePath: string, worktree: string): string {
  return resolveWorkspacePath(worktree, filePath);
}

async function extractSkeleton(
  content: string,
  ext: string
): Promise<{ type: string; name: string; startLine: number; endLine: number }[]> {
  const config = SKELETON_CONFIGS[ext];
  if (!config) {
    const patterns = REGEX_SKELETON[ext];
    if (!patterns) {
      const lines = content.split("\n");
      return [{ type: "file", name: `${lines.length} lines`, startLine: 1, endLine: lines.length }];
    }

    const items: { type: string; name: string; startLine: number; endLine: number }[] = [];
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
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

function extractNodeName(text: string, _nodeType: string): string {
  const firstLine = text.split("\n")[0] ?? text;
  const nameMatch = firstLine.match(
    /^(?:export\s+)?(?:async\s+)?(?:function\s+)?(?:\w+\s+)?(?:(\w+))\s*(?:[<(]|$)/
  );
  if (nameMatch) {
    const keywordSet = new Set(["export", "async", "function", "class", "interface", "type", "enum", "struct", "impl", "trait", "def", "fun", "fn"]);
    if (!keywordSet.has(nameMatch[1]!)) {
      return nameMatch[1]!;
    }
    const secondMatch = firstLine.match(/^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|struct|trait|impl|def|fun|fn)\s+(\w+)/);
    if (secondMatch) return secondMatch[1]!;
  }
  return firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
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

function formatSkeleton(
  items: { type: string; name: string; startLine: number; endLine: number }[]
): string {
  if (items.length === 0) return "_(no structural elements found)_";
  const lines: string[] = [];
  for (const item of items) {
    const lineRange = item.startLine === item.endLine
      ? `L${item.startLine}`
      : `L${item.startLine}-${item.endLine}`;
    lines.push(`${typeIcon(item.type)} \`${item.name}\` ${lineRange}`);
  }
  return lines.join("\n");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parameters for the search_semantic MCP tool. */
export interface SearchSemanticParams {
  /** Natural language search query. */
  query: string;
  /** Optional directory/file path hints to narrow results. */
  pathHints?: string[];
  /** Optional language hints to filter by language. */
  languageHints?: string[];
  /** Maximum number of results (1-25). */
  topK?: number;
}

/** Result of a semantic search operation. */
export interface SearchSemanticResult {
  /** Raw search result chunks with scores. */
  chunks: SearchResult[];
  /** Human-readable formatted search output. */
  formatted: string;
}

/** Execute a semantic search against the indexed codebase. */
export async function handleSearchSemantic(
  params: SearchSemanticParams,
  embedder: EmbeddingProvider,
  store: VectorStore,
  cfg: RagConfig,
  keywordIndex?: KeywordIndex,
  retrieveFn?: typeof retrieve
): Promise<SearchSemanticResult> {
  const retrieveFn_ = retrieveFn ?? retrieve;

  const count = await store.count();
  if (count === 0) {
    return { chunks: [], formatted: "The code index is empty. Run indexing first, then try your search again." };
  }

  const parts: string[] = [params.query.trim()];
  if (params.pathHints?.length) parts.push(`Path hints: ${params.pathHints.join(", ")}`);
  if (params.languageHints?.length) parts.push(`Language hints: ${params.languageHints.join(", ")}`);
  const query = parts.join("\n");

  const topK = params.topK ?? cfg.retrieval.topK;
  const retrieveOpts: RetrieveOptions = {
    topK,
    minScore: cfg.retrieval.minScore,
    keywordIndex,
    keywordWeight: cfg.retrieval.hybridSearch?.keywordWeight,
    hybridEnabled: cfg.retrieval.hybridSearch?.enabled,
    queryPrefix: cfg.embedding.queryPrefix,
  };

  const rawResults = await retrieveFn_(query, embedder, store, retrieveOpts);

  if (rawResults.length === 0) {
    return { chunks: [], formatted: `No indexed code matched query: "${params.query}". Try different terms or broaden the search.` };
  }

  const optCfg = cfg.retrieval.contextOptimization ?? DEFAULT_CONTEXT_OPTIMIZATION;
  const results = optimizeContext(rawResults, { topK, config: optCfg });

  const formatted = results.map((r) => {
    const m = r.chunk.metadata;
    const desc = r.chunk.description ? `> ${r.chunk.description}\n` : "";
    return [
      `**${m.filePath}:${m.startLine}-${m.endLine}** (${m.language}, relevance: ${r.score.toFixed(2)})`,
      desc,
      "```" + m.language,
      r.chunk.content,
      "```",
    ].join("\n");
  }).join("\n\n");

  return { chunks: results, formatted };
}

/** Parameters for the get_file_skeleton MCP tool. */
export interface FileSkeletonParams {
  /** Path to the file to skeletonize. */
  filePath: string;
}

/** Result of a file skeleton operation. */
export interface FileSkeletonResult {
  /** Extracted structural elements. */
  elements: { type: string; name: string; startLine: number; endLine: number }[];
  /** Human-readable formatted skeleton output. */
  formatted: string;
  /** Summary string (e.g. "3 function, 1 class"). */
  summary: string;
}

/** Extract the structural skeleton (functions, classes, interfaces) from a source file. */
export async function handleFileSkeleton(
  params: FileSkeletonParams,
  worktree: string
): Promise<FileSkeletonResult> {
  const resolvedPath = resolveFilePath(params.filePath, worktree);
  const content = readFileSync(resolvedPath, "utf-8");
  const ext = getExtension(params.filePath);

  const skeleton = await extractSkeleton(content, ext);

  const declCounts = new Map<string, number>();
  for (const item of skeleton) {
    const baseType = item.type.replace(/_declaration$|_definition$|_specifier$|_item$/, "");
    declCounts.set(baseType, (declCounts.get(baseType) ?? 0) + 1);
  }
  const summary = [...declCounts.entries()]
    .map(([t, c]) => `${c} ${t}`)
    .join(", ");

  const formatted = `${skeleton.length} structural elements (${summary || "—"})\n\n${formatSkeleton(skeleton)}`;

  return { elements: skeleton, formatted, summary };
}

/** Parameters for the find_usages MCP tool. */
export interface FindUsagesParams {
  /** Symbol name to search for. */
  symbolName: string;
  /** Optional file path hint to narrow results. */
  pathHint?: string;
  /** Maximum number of results (1-50). */
  topK?: number;
}

/** Result of a find_usages operation. */
export interface FindUsagesResult {
  /** Individual usage matches with context. */
  matches: { filePath: string; language: string; line: number; content: string; context: string[] }[];
  /** Total number of reference lines found. */
  totalMatches: number;
  /** Number of distinct files containing references. */
  fileCount: number;
  /** Human-readable formatted output. */
  formatted: string;
}

/** Parameters for the describe_image MCP tool. */
export interface DescribeImageParams {
  /** Path to the image file. */
  filePath: string;
}

/** Result of an image description operation. */
export interface DescribeImageResult {
  /** Raw description text from the vision provider. */
  description: string;
  /** Human-readable formatted output with metadata. */
  formatted: string;
}

/** Describe an image file using the configured vision provider (Ollama, OpenAI, Anthropic, or Gemini). */
export async function handleDescribeImage(
  params: DescribeImageParams,
  cfg: RagConfig,
  worktree: string,
  visionProvider?: ImageVisionProvider
): Promise<DescribeImageResult> {
  const { existsSync, readFileSync } = await import("node:fs");
  const path = await import("node:path");

  const resolvedPath = resolveFilePath(params.filePath, worktree);

  if (!existsSync(resolvedPath)) {
    throw new Error(`File not found: ${params.filePath}`);
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
    const exts = [...SUPPORTED_IMAGE_EXTENSIONS].join(", ");
    throw new Error(`Unsupported file extension "${ext}". Supported: ${exts}`);
  }

  const imageDescriptionConfig = cfg.imageDescription;
  if (!imageDescriptionConfig?.enabled) {
    throw new Error("Image description is not enabled in config (imageDescription.enabled)");
  }

  const { getMimeType } = await import("../chunker/image.js");
  const { resizeImage } = await import("../content/image.js");

  const buffer = readFileSync(resolvedPath);
  const mimeType = getMimeType(ext);
  const maxDimension = imageDescriptionConfig.resizeMaxDimension ?? 1024;
  const sized = maxDimension > 0 ? await resizeImage(buffer, resolvedPath, maxDimension) : buffer;
  const b64 = sized.toString("base64");

  const provider = visionProvider ?? (await import("../chunker/image.js")).createImageVisionProvider(imageDescriptionConfig);
  const description = await provider.describeImage(b64, mimeType, imageDescriptionConfig.prompt);

  const formatted = [
    `**Image description** — ${params.filePath}`,
    "",
    description,
    "",
    `_Generated with ${imageDescriptionConfig.provider}/${imageDescriptionConfig.model}_`,
  ].join("\n");

  return { description, formatted };
}

/** Find usages and references of a symbol across the indexed codebase using hybrid (keyword + vector) search. */
export async function handleFindUsages(
  params: FindUsagesParams,
  embedder: EmbeddingProvider,
  store: VectorStore,
  cfg: RagConfig,
  keywordIndex?: KeywordIndex,
  retrieveFn?: typeof retrieve
): Promise<FindUsagesResult> {
  const retrieveFn_ = retrieveFn ?? retrieve;
  const symbolName = params.symbolName.trim();
  const topK = params.topK ?? 30;

  const kwResults: SearchResult[] = keywordIndex
    ? keywordIndex.search(symbolName, topK)
    : [];

  const count = await store.count();
  const vsResults: SearchResult[] = count > 0
    ? await retrieveFn_(symbolName, embedder, store, {
        topK: topK * 2,
        minScore: 0,
        keywordIndex: undefined,
        queryPrefix: cfg.embedding.queryPrefix,
      } satisfies RetrieveOptions)
    : [];

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
      matches: [],
      totalMatches: 0,
      fileCount: 0,
      formatted: `No usages found for \`${symbolName}\`.`,
    };
  }

  type UsageGroup = {
    filePath: string;
    language: string;
    usages: { line: number; content: string; context: string[] }[];
  };
  const fileGroups = new Map<string, UsageGroup>();

  for (const result of merged) {
    const m = result.chunk.metadata;
    const lines = result.chunk.content.split("\n");
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

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNum = i + 1;
      if (definitionLine !== undefined && lineNum === definitionLine) continue;

      const symbolPattern = new RegExp(`\\b${escapeRegex(symbolName)}\\b`);
      if (!symbolPattern.test(line)) continue;

      const ctxStart = Math.max(0, i - 2);
      const ctxEnd = Math.min(lines.length, i + 3);
      const contextLines = lines.slice(ctxStart, ctxEnd).map((l) => l.trimEnd());

      let group = fileGroups.get(m.filePath);
      if (!group) {
        group = { filePath: m.filePath, language: m.language, usages: [] };
        fileGroups.set(m.filePath, group);
      }
      if (!group.usages.some((g) => g.line === lineNum)) {
        group.usages.push({ line: lineNum, content: line.trimEnd(), context: contextLines });
      }
    }
  }

  if (fileGroups.size === 0) {
    return {
      matches: [],
      totalMatches: 0,
      fileCount: 0,
      formatted: `No usages found for \`${symbolName}\`. The symbol appears in indexed chunks but no reference lines were found.`,
    };
  }

  const allMatches: FindUsagesResult["matches"] = [];
  const formattedLines: string[] = [];
  const totalMatches = [...fileGroups.values()].reduce((s, g) => s + g.usages.length, 0);
  formattedLines.push(`**Usages of \`${symbolName}\`** — ${totalMatches} references across ${fileGroups.size} files\n`);

  for (const [filePath, group] of fileGroups) {
    group.usages.sort((a, b) => a.line - b.line);
    formattedLines.push(`### ${filePath} (${group.language})\n`);
    formattedLines.push("| Line | Code |");
    formattedLines.push("|------|------|");
    for (const usage of group.usages) {
      const ctx = usage.context;
      const codeLine = ctx[Math.min(2, ctx.length - 1)] ?? usage.content;
      const escaped = codeLine.length > 100 ? codeLine.slice(0, 97) + "..." : codeLine;
      formattedLines.push(`| ${usage.line} | \`${escaped}\` |`);
      allMatches.push({ ...usage, filePath, language: group.language });
    }
    formattedLines.push("");
  }

  formattedLines.push("---\n");
  formattedLines.push("_Use `get_file_skeleton` for a quick file overview or `search_semantic` for broader context._");

  return {
    matches: allMatches,
    totalMatches,
    fileCount: fileGroups.size,
    formatted: formattedLines.join("\n"),
  };
}
