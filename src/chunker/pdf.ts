/**
 * @fileoverview PDF text extraction and paragraph-based chunker using pdfjs-dist.
 */
import type { Chunker, Chunk } from "../core/interfaces.js";
import { uuid } from "./uuid.js";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const MAX_CHUNK_CHARS = 4000;
const MIN_GROUP_CHARS = 300;
const MAX_PDF_PAGES = 1000;
const MAX_PDF_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
const PARAGRAPH_SPLIT = /\n\s*\n/;

/**
 * Resolve the file URL to the `standard_fonts` directory shipped with pdfjs-dist.
 * Used to provide standard font data when rendering PDF pages.
 */
function getStandardFontsUrl(): string {
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve("pdfjs-dist/package.json");
  const fontsDir = path.join(path.dirname(pkgJson), "standard_fonts");
  const url = pathToFileURL(fontsDir).href;
  return url.endsWith("/") ? url : url + "/";
}

/**
 * Create a pdfjs-dist PDF document from a buffer.
 * Uses `@thednp/dommatrix` for DOMMatrix polyfill (lighter alternative to native canvas).
 * @param buffer - Raw buffer of the PDF file.
 * @returns The pdfjs LoadingTask for the document.
 */
async function getPdfLoadingTask(buffer: Buffer) {
  const { default: CSSMatrix } = await import("@thednp/dommatrix");
  globalThis.DOMMatrix ??= CSSMatrix as unknown as typeof globalThis.DOMMatrix;
  globalThis.DOMMatrixReadOnly ??= CSSMatrix as unknown as typeof globalThis.DOMMatrixReadOnly;

  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl: getStandardFontsUrl(),
    verbosity: 0,
  });
}

/**
 * Extract the full text content from a PDF file buffer.
 * Iterates over every page, collects text items, and joins them with
 * paragraph separators.
 * @param buffer - Raw buffer of the PDF file.
 * @returns The extracted text with double-newline page separators.
 */

export async function extractPdfText(buffer: Buffer): Promise<string> {
  if (buffer.length > MAX_PDF_SIZE_BYTES) {
    throw new Error(`PDF too large: ${(buffer.length / 1024 / 1024).toFixed(1)} MB (max 100 MB)`);
  }

  // loadingTask.destroy() releases the pdfjs worker/document resources —
  // without it long-running watch/plugin processes leak them per PDF.
  const loadingTask = await getPdfLoadingTask(buffer);
  try {
    const pdf = await loadingTask.promise;
    const texts: string[] = [];
    const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);

    for (let i = 1; i <= pageCount; i++) {
      const page = await pdf.getPage(i);
      try {
        const content = await page.getTextContent();
        const strings: string[] = [];
        for (const item of content.items) {
          if (typeof item === "object" && item !== null && "str" in item) {
            strings.push((item as { str: string }).str);
          }
        }
        texts.push(strings.join(" "));
      } finally {
        page.cleanup();
      }
    }

    return texts.join("\n\n");
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}

/**
 * Chunker for PDF documents (.pdf).
 * Splits extracted text by paragraph boundaries, grouping small paragraphs
 * into chunks of up to 4000 characters.
 */
export class PdfChunker implements Chunker {
  readonly language = "pdf";
  readonly fileExtensions = [".pdf"];

  /**
   * Split the PDF text into chunks by paragraph grouping.
   * @param filePath - Original file path (for metadata).
   * @param content - Extracted plain-text content of the PDF.
   * @returns A list of text chunks with file-path and line-range metadata.
   */
  async chunk(filePath: string, content: string): Promise<Chunk[]> {
    if (content.trim().length === 0) return [];

    const paragraphs = content.split(PARAGRAPH_SPLIT).filter((p) => p.trim().length > 0);
    if (paragraphs.length === 0) return [];

    const chunks: Chunk[] = [];
    let currentGroup: string[] = [];
    let currentSize = 0;
    let paragraphIndex = 0;

    function flush() {
      const text = currentGroup.join("\n\n").trim();
      if (text.length === 0) return;
      chunks.push({
        id: uuid(),
        content: text,
        metadata: {
          filePath,
          startLine: paragraphIndex - currentGroup.length + 1,
          endLine: paragraphIndex,
          language: "pdf",
        },
      });
      currentGroup = [];
      currentSize = 0;
    }

    for (const para of paragraphs) {
      paragraphIndex++;
      const paraLen = para.length;

      if (paraLen > MAX_CHUNK_CHARS) {
        if (currentGroup.length > 0) flush();
        chunks.push({
          id: uuid(),
          content: para,
          metadata: {
            filePath,
            startLine: paragraphIndex,
            endLine: paragraphIndex,
            language: "pdf",
          },
        });
        continue;
      }

      if (currentGroup.length > 0 && currentSize + paraLen > MAX_CHUNK_CHARS) {
        flush();
      }

      currentGroup.push(para);
      currentSize += paraLen;

      if (currentSize >= MIN_GROUP_CHARS && currentGroup.length >= 1) {
        const nextParaStillSmall =
          paragraphIndex < paragraphs.length &&
          paragraphs[paragraphIndex]!.length < MIN_GROUP_CHARS;
        if (!nextParaStillSmall) {
          flush();
        }
      }
    }

    if (currentGroup.length > 0) {
      flush();
    }

    return chunks;
  }
}

/** Default singleton instance of {@link PdfChunker}. */
export const pdfChunker = new PdfChunker();
