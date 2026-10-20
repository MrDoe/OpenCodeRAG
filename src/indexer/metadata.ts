/**
 * @fileoverview Builds metadata headers (file type, content type, document title) for embedding context.
 */
import path from "node:path";
import {
  normalizeParserOverrides,
  type ParserOverrides,
} from "../core/parser-overrides.js";

const FILE_TYPE_LABELS: Record<string, string> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".doc": "doc",
  ".xls": "excel",
  ".xlsx": "excel",
  ".md": "markdown",
  ".mdx": "markdown",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".html": "html",
  ".css": "css",
  ".csv": "csv",
  ".txt": "text",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".java": "java",
  ".go": "go",
  ".rs": "rust",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".sql": "sql",
  ".sh": "bash",
  ".bash": "bash",
  ".ps1": "powershell",
  ".dockerfile": "dockerfile",
  ".tex": "latex",
  ".razor": "razor",
  ".sln": "sln",
  ".ini": "ini",
};

function classifyContentType(relPath: string): string {
  const lower = relPath.toLowerCase();
  const parts = lower.split("/");
  const basename = parts[parts.length - 1] ?? "";

  if (basename.startsWith("readme")) return "readme";
  if (/^(test|tests|__tests__|spec|specs|__spec__)\b/.test(basename) || /\.(test|spec)\.[^.]+$/.test(basename)) return "test";
  if (parts.some((p) => /^(docs?|documentation|guides?|manual|tutorial|tutorial)s?$/.test(p))) return "documentation";
  if (parts.some((p) => /^(config|conf|configuration|settings|env)s?$/.test(p)) || /\.(config|conf)\.[^.]+$/.test(basename)) return "configuration";
  if (parts.some((p) => /^(src|source|lib|packages?|modules?)$/.test(p))) return "source";
  if (parts.some((p) => /^(ci|cd|\.github|\.gitlab|build|deploy|scripts?)$/.test(p))) return "build";
  if (parts.some((p) => /^(examples?|samples?|demo|demos?)$/.test(p))) return "example";
  return "";
}

function extractDocumentTitle(content: string, filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".md" || ext === ".mdx") {
    const match = content.match(/^#{1,3}\s+(.+)$/m);
    if (match?.[1]) return match[1].trim().slice(0, 80);
  }
  const basename = path.basename(filePath, ext);
  return basename
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .slice(0, 80);
}

/**
 * Build a metadata header string for embedding context that describes the
 * file type, top-level directory, content classification, and document title.
 *
 * @param filePath - Absolute path to the file.
 * @param cwd - Workspace root directory (used to compute relative path).
 * @param content - File content used to extract a document title.
 * @param languageByExtension - Optional `chunking.parsers` override map.
 *   When an extension is remapped to another parser, the header must name
 *   that parser — otherwise the embedded text says `[c]` while the chunk's
 *   `metadata.language` (and therefore the keyword filter) says `cpp`.
 * @returns A space-delimited metadata string such as `"[typescript] [src] [source] MyComponent"`.
 */
export function buildFileMetadataHeader(
  filePath: string,
  cwd: string,
  content: string,
  languageByExtension?: ParserOverrides,
): string {
  const ext = path.extname(filePath).toLowerCase();
  const relPath = path.relative(cwd, filePath).replace(/\\/g, "/");
  const overrides = normalizeParserOverrides(languageByExtension);
  const fileType = overrides[ext] ?? FILE_TYPE_LABELS[ext] ?? ext.slice(1);
  const dirParts = relPath.split("/");
  dirParts.pop();
  const topDir = dirParts[0] ?? "";
  const contentType = classifyContentType(relPath);
  const title = extractDocumentTitle(content, filePath);

  const parts: string[] = [];
  if (fileType) parts.push(`[${fileType}]`);
  if (topDir) parts.push(`[${topDir}]`);
  if (contentType) parts.push(`[${contentType}]`);
  if (title) parts.push(title);

  return parts.length > 0 ? parts.join(" ") : "";
}
