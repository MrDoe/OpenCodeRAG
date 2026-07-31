/**
 * @fileoverview Chunker registry, extension-to-chunker mapping, and file chunking orchestration.
 */
import type { Chunker, Chunk } from "../core/interfaces.js";
import { TreeSitterChunker } from "./base.js";
import { typescriptChunker } from "./typescript.js";
import { pythonChunker } from "./python.js";
import { javaChunker } from "./java.js";
import { goChunker } from "./go.js";
import { markdownChunker } from "./markdown.js";
import { cChunker } from "./c.js";
import { cppChunker } from "./cpp.js";
import { csharpChunker } from "./csharp.js";
import { javascriptChunker } from "./javascript.js";
import { razorChunker } from "./razor.js";
import { jsonChunker } from "./json.js";
import { htmlChunker } from "./html.js";
import { cssChunker } from "./css.js";
import { xmlChunker } from "./xml.js";
import { slnChunker } from "./sln.js";
import { rustChunker } from "./rust.js";
import { rubyChunker } from "./ruby.js";
import { kotlinChunker } from "./kotlin.js";
import { swiftChunker } from "./swift.js";
import { bashChunker } from "./bash.js";
import { phpChunker } from "./php.js";
import { powershellChunker } from "./powershell.js";
import { iniChunker } from "./ini.js";
import { yamlChunker } from "./yaml.js";
import { tomlChunker } from "./toml.js";
import { dockerfileChunker } from "./dockerfile.js";
import { sqlChunker } from "./sql.js";
import { texChunker } from "./tex.js";
import { fallbackChunker } from "./fallback.js";
import { pdfChunker } from "./pdf.js";
import { docxChunker } from "./docx.js";
import { docChunker } from "./doc.js";
import { excelChunker } from "./excel.js";
import { sslChunker } from "./ssl.js";
import { uuid } from "./uuid.js";

const chunkers: Chunker[] = [
  typescriptChunker,
  pythonChunker,
  javaChunker,
  goChunker,
  markdownChunker,
  cChunker,
  cppChunker,
  csharpChunker,
  javascriptChunker,
  razorChunker,
  jsonChunker,
  htmlChunker,
  cssChunker,
  xmlChunker,
  slnChunker,
  rustChunker,
  rubyChunker,
  kotlinChunker,
  swiftChunker,
  bashChunker,
  phpChunker,
  powershellChunker,
  iniChunker,
  yamlChunker,
  tomlChunker,
  dockerfileChunker,
  sqlChunker,
  texChunker,
  pdfChunker,
  docxChunker,
  docChunker,
  excelChunker,
  sslChunker,
];

const extensionMap = new Map<string, Chunker>();

for (const chunker of chunkers) {
  if ("fileExtensions" in chunker) {
    const ce = chunker as typeof chunker & { fileExtensions: string[] };
    for (const ext of ce.fileExtensions) {
      extensionMap.set(ext, chunker);
    }
  }
}

/**
 * Register a pluggable chunker for one or more file extensions.
 * If an extension already has a chunker, the new one is silently skipped.
 *
 * @param chunker - The chunker instance to register.
 * @param extensions - File extensions to associate with this chunker.
 *   Defaults to the chunker's own `fileExtensions` property.
 */
export function registerChunker(
  chunker: Chunker,
  extensions?: string[]
): void {
  const exts = extensions ?? ("fileExtensions" in chunker
    ? (chunker as typeof chunker & { fileExtensions: string[] }).fileExtensions
    : []);

  for (const ext of exts) {
    const lower = ext.toLowerCase();
    if (extensionMap.has(lower)) {
      console.warn(
        `[opencode-rag] Chunker for "${lower}" already registered — skipping pluggable chunker "${chunker.language}"`
      );
      continue;
    }
    extensionMap.set(lower, chunker);
  }
}

/**
 * Look up the chunker registered for a given file path by extension.
 * Falls back to the fallback chunker when no extension match is found.
 *
 * @param filePath - Path to the file to chunk.
 * @returns A chunker instance for the file's extension.
 */
export function getChunker(filePath: string): Chunker {
  const dotIdx = filePath.lastIndexOf(".");
  const ext = dotIdx >= 0 ? filePath.slice(dotIdx).toLowerCase() : "";
  if (ext && extensionMap.has(ext)) {
    return extensionMap.get(ext)!;
  }
  const basename = filePath.toLowerCase();
  return extensionMap.get(basename) ?? fallbackChunker;
}

export function getRegisteredExtensions(): string[] {
  return [...extensionMap.keys()].sort();
}

const MAX_CHUNK_LINES = 100;
const MAX_CHUNK_CHARS = 8000;

function splitOversized(chunks: Chunk[], filePath: string): Chunk[] {
  const result: Chunk[] = [];

  for (const chunk of chunks) {
    const lines = chunk.content.split("\n");
    if (lines.length <= MAX_CHUNK_LINES && chunk.content.length <= MAX_CHUNK_CHARS) {
      result.push(chunk);
      continue;
    }

    const subChunks: Chunk[] = [];
    let currentLines: string[] = [];
    let currentCharCount = 0;
    let lineOffset = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineLen = line.length + 1;

      if (
        currentLines.length > 0 &&
        (currentLines.length >= MAX_CHUNK_LINES || currentCharCount + lineLen > MAX_CHUNK_CHARS)
      ) {
        subChunks.push({
          id: uuid(),
          content: currentLines.join("\n"),
          metadata: {
            filePath,
            startLine: chunk.metadata.startLine + lineOffset,
            endLine: chunk.metadata.startLine + i - 1,
            language: chunk.metadata.language,
          },
        });
        currentLines = [];
        currentCharCount = 0;
        lineOffset = i;
      }

      currentLines.push(line);
      currentCharCount += lineLen;
    }

    if (currentLines.length > 0) {
      subChunks.push({
        id: uuid(),
        content: currentLines.join("\n"),
        metadata: {
          filePath,
          startLine: chunk.metadata.startLine + lineOffset,
          endLine: chunk.metadata.startLine + lines.length - 1,
          language: chunk.metadata.language,
        },
      });
    }

    for (const sub of subChunks) {
      if (sub.content.trim().length > 0) {
        result.push(sub);
      }
    }
  }

  return result;
}

/**
 * Wrap a chunker with a per-file byte limit.
 *
 * Previously the limit was assigned onto the shared chunker singleton
 * (`chunker.maxContentBytes = ...`) — under pLimit concurrency one file's
 * limit could bleed into unrelated concurrent files, and it was never
 * reset, so a later large XML/SVG file was silently skipped.
 */
function withByteLimit(
  chunker: TreeSitterChunker,
  limit: number,
): Chunker {
  const language = chunker.language;
  return {
    language,
    fileExtensions: chunker.fileExtensions,
    async chunk(filePath: string, content: string): Promise<Chunk[]> {
      if (limit > 0 && Buffer.byteLength(content, "utf-8") > limit) {
        throw new Error(`File exceeds ${limit} byte limit for ${language} chunker`);
      }
      return chunker.chunk(filePath, content);
    },
  };
}

/**
 * Chunk a file by looking up its registered chunker, applying node-type
 * overrides if provided, and splitting oversized chunks to stay within
 * size limits. Falls back to the fallback chunker on empty results.
 *
 * @param filePath - Path to the file to chunk.
 * @param content - The full text content of the file.
 * @param nodeTypesOverrides - Optional language-specific node type overrides
 *   for tree-sitter based chunkers.
 * @param options - Optional chunking options (maxSvgSizeBytes, etc.).
 * @returns An array of chunks for the file.
 */
export async function chunkFile(
  filePath: string,
  content: string,
  nodeTypesOverrides?: Record<string, string[]>,
  options?: { maxSvgSizeBytes?: number },
): Promise<Chunk[]> {
  let chunker = getChunker(filePath);

  if (nodeTypesOverrides && chunker instanceof TreeSitterChunker) {
    const overrideTypes = nodeTypesOverrides[chunker.language];
    if (overrideTypes && overrideTypes.length > 0) {
      chunker = chunker.withNodeTypes(new Set(overrideTypes));
    }
  }

  // Per-file byte limit (SVG/XML/csproj) without mutating the shared singleton
  if (options?.maxSvgSizeBytes && chunker instanceof TreeSitterChunker) {
    const ext = filePath.toLowerCase();
    if (ext.endsWith(".svg") || ext.endsWith(".xml") || ext.endsWith(".csproj")) {
      chunker = withByteLimit(chunker, options.maxSvgSizeBytes);
    }
  }

  const chunks = await chunker.chunk(filePath, content);

  if (chunks.length === 0) {
    return fallbackChunker.chunk(filePath, content);
  }

  return splitOversized(chunks, filePath);
}

export { typescriptChunker, pythonChunker, javaChunker, goChunker, markdownChunker, cChunker, cppChunker, csharpChunker, javascriptChunker, razorChunker, jsonChunker, htmlChunker, cssChunker, xmlChunker, slnChunker, rustChunker, rubyChunker, kotlinChunker, swiftChunker, bashChunker, phpChunker, powershellChunker, iniChunker, yamlChunker, tomlChunker, dockerfileChunker, sqlChunker, texChunker, pdfChunker, fallbackChunker };
