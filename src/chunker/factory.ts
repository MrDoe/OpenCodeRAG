/**
 * @fileoverview Chunker registry, extension-to-chunker mapping, and file chunking orchestration.
 */
import type { Chunker, Chunk } from "../core/interfaces.js";
import {
  normalizeExtensionKey,
  normalizeParserOverrides,
  type ParserOverrides,
} from "../core/parser-overrides.js";
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
 * Parser (chunker) registry keyed by `language` name — the target space of the
 * `chunking.parsers` config (`{ ".c": "cpp" }`). Kept in sync with
 * {@link extensionMap} by {@link registerChunker}.
 */
const languageMap = new Map<string, Chunker>();

for (const chunker of chunkers) {
  if (chunker.language) languageMap.set(chunker.language, chunker);
}
languageMap.set(fallbackChunker.language, fallbackChunker);

/** Override targets already reported as unknown, so a bad config warns once per process. */
const warnedUnknownParsers = new Set<string>();

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
  if (chunker.language) languageMap.set(chunker.language, chunker);

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
 * @param languageByExtension - Optional `chunking.parsers` override map
 *   (extension → parser language). Overrides win over the built-in mapping and
 *   are resolved per call, so they never mutate the process-wide registry
 *   (which is shared across workspaces).
 * @returns A chunker instance for the file's extension.
 */
export function getChunker(filePath: string, languageByExtension?: ParserOverrides): Chunker {
  const dotIdx = filePath.lastIndexOf(".");
  const ext = dotIdx >= 0 ? filePath.slice(dotIdx).toLowerCase() : "";

  const overrides = languageByExtension && Object.keys(languageByExtension).length > 0
    ? normalizeParserOverrides(languageByExtension)
    : undefined;
  const target = ext && overrides ? overrides[ext] : undefined;
  if (target) {
    const overridden = languageMap.get(target);
    if (overridden) return overridden;
    if (!warnedUnknownParsers.has(target)) {
      warnedUnknownParsers.add(target);
      console.warn(
        `[opencode-rag] chunking.parsers maps "${ext}" to unknown parser "${target}" ` +
        `— known parsers: ${getRegisteredLanguages().join(", ")}. Using the default mapping.`
      );
    }
    // Unknown target: fall through to the default mapping for this extension.
  }

  if (ext && extensionMap.has(ext)) {
    return extensionMap.get(ext)!;
  }
  const basename = filePath.toLowerCase();
  return extensionMap.get(basename) ?? fallbackChunker;
}

/** Every parser (chunker language) name accepted as a `chunking.parsers` target. */
export function getRegisteredLanguages(): string[] {
  return [...new Set([...languageMap.values()].map((chunker) => chunker.language))].sort();
}

/**
 * All file extensions currently mapped to a given parser language, in
 * registration order. Used by skeleton extraction to pick a representative
 * extension recipe when an override retargets an extension.
 */
export function getExtensionsForLanguage(language: string): string[] {
  const out: string[] = [];
  for (const [ext, chunker] of extensionMap) {
    if (chunker.language === language) out.push(ext);
  }
  return out;
}

/**
 * Validate a raw `chunking.parsers` map against the registered parsers.
 *
 * @param parsers - Raw (unnormalized) override map from the config.
 * @returns Human-readable warnings; empty when the map is valid or absent.
 */
export function validateParserOverrides(parsers?: ParserOverrides): string[] {
  const warnings: string[] = [];
  if (parsers === undefined || parsers === null) return warnings;
  if (typeof parsers !== "object" || Array.isArray(parsers)) {
    warnings.push('chunking.parsers must be an object mapping file extensions to parser names (e.g. { ".c": "cpp" })');
    return warnings;
  }

  const known = new Set(getRegisteredLanguages());
  for (const [rawKey, rawValue] of Object.entries(parsers)) {
    const ext = normalizeExtensionKey(rawKey);
    if (!ext) {
      warnings.push(`chunking.parsers key "${rawKey}" is not a valid file extension`);
      continue;
    }
    if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
      warnings.push(`chunking.parsers["${rawKey}"] must be a non-empty parser name`);
      continue;
    }
    const language = rawValue.trim().toLowerCase();
    if (!known.has(language)) {
      warnings.push(
        `chunking.parsers["${rawKey}"] → "${language}" is not a registered parser — ` +
        `known parsers: ${[...known].sort().join(", ")}`
      );
    }
  }
  return warnings;
}

export function getRegisteredExtensions(): string[] {
  return [...extensionMap.keys()].sort();
}

const MAX_CHUNK_LINES = 100;
const MAX_CHUNK_CHARS = 8000;

/** Prepend the tail of the previous chunk as context to the next one, so a
 *  construct split across a chunk boundary is still retrievable whole. */
function applyChunkOverlap(chunks: Chunk[], overlap: number): Chunk[] {
  if (overlap <= 0 || chunks.length <= 1) return chunks;
  const result: Chunk[] = [];
  let prevTail: string[] | null = null;
  for (const chunk of chunks) {
    const lines = chunk.content.split("\n");
    if (prevTail && prevTail.length > 0) {
      result.push({
        ...chunk,
        id: uuid(),
        content: [...prevTail, ...lines].join("\n"),
      });
    } else {
      result.push(chunk);
    }
    prevTail = lines.slice(Math.max(0, lines.length - overlap));
  }
  return result;
}

function splitOversized(
  chunks: Chunk[],
  filePath: string,
  maxLines: number = MAX_CHUNK_LINES,
  maxChars: number = MAX_CHUNK_CHARS,
  overlap: number = 0,
): Chunk[] {
  const result: Chunk[] = [];

  for (const chunk of chunks) {
    const lines = chunk.content.split("\n");
    if (lines.length <= maxLines && chunk.content.length <= maxChars) {
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
        (currentLines.length >= maxLines || currentCharCount + lineLen > maxChars)
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
        // Seed the next window with the last `overlap` lines so split chunks
        // still share their boundary context.
        const tail = overlap > 0 ? currentLines.slice(Math.max(0, currentLines.length - overlap)) : [];
        currentLines = [...tail];
        currentCharCount = tail.reduce((sum, l) => sum + l.length + 1, 0);
        lineOffset = i - tail.length;
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
 * @param options - Optional chunking options (maxSvgSizeBytes, parser overrides, etc.).
 * @returns An array of chunks for the file.
 */
export async function chunkFile(
  filePath: string,
  content: string,
  nodeTypesOverrides?: Record<string, string[]>,
  options?: {
    maxSvgSizeBytes?: number;
    /** Maximum lines per chunk; oversized chunks are split into windows. */
    maxChunkSize?: number;
    /** Overlapping lines shared between adjacent/split chunks. */
    chunkOverlap?: number;
    /** Extension → parser overrides from `chunking.parsers`. */
    languageByExtension?: ParserOverrides;
  },
): Promise<Chunk[]> {
  let chunker = getChunker(filePath, options?.languageByExtension);

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

  const overlap = Math.max(0, options?.chunkOverlap ?? 0);
  const maxLines = options?.maxChunkSize && options.maxChunkSize > 0 ? options.maxChunkSize : MAX_CHUNK_LINES;
  const split = splitOversized(chunks, filePath, maxLines, MAX_CHUNK_CHARS, overlap);
  return applyChunkOverlap(split, overlap);
}

export { typescriptChunker, pythonChunker, javaChunker, goChunker, markdownChunker, cChunker, cppChunker, csharpChunker, javascriptChunker, razorChunker, jsonChunker, htmlChunker, cssChunker, xmlChunker, slnChunker, rustChunker, rubyChunker, kotlinChunker, swiftChunker, bashChunker, phpChunker, powershellChunker, iniChunker, yamlChunker, tomlChunker, dockerfileChunker, sqlChunker, texChunker, pdfChunker, fallbackChunker };
