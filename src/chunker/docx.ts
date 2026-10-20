/**
 * @fileoverview Text extraction and paragraph-based chunker for Word (.docx) documents.
 *
 * A `.docx` file is a ZIP archive containing `word/document.xml`, where the text
 * lives in `<w:t>` runs and paragraph boundaries are `<w:p>` elements. Extraction
 * is done directly with fflate's `unzipSync` so the plugin pulls in no document
 * parser (the previous `mammoth` dependency carried six transitive packages,
 * several of them with known prototype-pollution advisories).
 */
import { unzipSync } from "fflate";
import type { Chunker, Chunk } from "../core/interfaces.js";
import { uuid } from "./uuid.js";

const MAX_CHUNK_CHARS = 4000;
const MIN_GROUP_CHARS = 300;

const PARAGRAPH_SPLIT = /\n\s*\n/;

/** ZIP entry holding the document body. */
const DOCUMENT_XML = "word/document.xml";

/**
 * Upper bound on the decompressed size of `word/document.xml`.
 *
 * `.docx` files are frequently untrusted, and a small archive can inflate to
 * gigabytes (a zip bomb). Anything past this is refused instead of buffered.
 */
const MAX_DOCUMENT_XML_BYTES = 64 * 1024 * 1024;

/**
 * Decode the XML entities Word emits inside text runs.
 * @param text - Raw (escaped) text from a `<w:t>` element.
 * @returns The unescaped text.
 */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Convert raw `word/document.xml` markup into plain text.
 *
 * Mirrors what `mammoth.extractRawText` produced for the chunker's purposes:
 * `<w:t>` text is concatenated, `<w:tab>` becomes a tab, `<w:br>` becomes a
 * newline, and each paragraph is terminated by a blank line so the
 * {@link PARAGRAPH_SPLIT} regex still sees paragraph boundaries.
 * @param xml - Contents of `word/document.xml`.
 * @returns Plain text with paragraphs separated by blank lines.
 */
function documentXmlToText(xml: string): string {
  let out = "";

  // Text outside a <w:p> is document metadata, not body text.
  let inParagraph = false;

  const OPEN_TAG = /<w:(t|tab|br|p)(?:\s[^>]*)?\/?>/g;
  const CLOSE_P = /<\/w:p>/g;

  // Walk both matchers in document order.
  let open = OPEN_TAG.exec(xml);
  let close = CLOSE_P.exec(xml);

  while (open !== null) {
    // A closing </w:p> before the next opening tag wins.
    if (close !== null && close.index < open.index) {
      if (inParagraph) {
        out += "\n\n";
        inParagraph = false;
      }
      close = CLOSE_P.exec(xml);
      continue;
    }

    const [full, name] = open;
    const selfClosing = full.endsWith("/>");

    if (name === "p") {
      if (!selfClosing && !inParagraph) {
        inParagraph = true;
      }
    } else if (inParagraph) {
      if (name === "tab") {
        out += "\t";
      } else if (name === "br") {
        out += "\n";
      } else if (!selfClosing) {
        const endTag = `</w:t>`;
        const end = xml.indexOf(endTag, open.index + full.length);
        const stop = end === -1 ? xml.length : end;
        out += decodeXmlEntities(xml.slice(open.index + full.length, stop));
      }
    }

    open = OPEN_TAG.exec(xml);
  }

  // Unterminated trailing paragraph.
  if (inParagraph) out += "\n\n";

  return out;
}

/**
 * Extract the raw text from a Word (.docx) file buffer.
 *
 * Unzips the archive and reads `word/document.xml` directly. Only that single
 * entry is decompressed, and an inflated-size cap is enforced, so a crafted
 * archive cannot exhaust memory.
 * @param buffer - Raw buffer of the .docx file.
 * @returns The extracted raw text as a string.
 * @throws If the buffer is not a valid ZIP archive or lacks `word/document.xml`.
 */
export function extractDocxText(buffer: Buffer): string {
  let tooLarge = false;

  const entries = unzipSync(new Uint8Array(buffer), {
    filter: (file) => {
      if (file.name !== DOCUMENT_XML) return false;
      if (file.originalSize > MAX_DOCUMENT_XML_BYTES) {
        tooLarge = true;
        return false;
      }
      return true;
    },
  });

  if (tooLarge) {
    throw new Error(
      `DOCX too large: "${DOCUMENT_XML}" exceeds ${MAX_DOCUMENT_XML_BYTES} bytes when decompressed`,
    );
  }

  const doc = entries[DOCUMENT_XML];
  if (!doc) {
    throw new Error(`Not a valid DOCX file: missing "${DOCUMENT_XML}"`);
  }
  return documentXmlToText(Buffer.from(doc).toString("utf8"));
}

/**
 * Chunker for Word (.docx) documents.
 * Splits the extracted plain text by paragraph boundaries, grouping small
 * paragraphs into chunks of up to 4000 characters.
 */
export class DocxChunker implements Chunker {
  readonly language = "docx";
  readonly fileExtensions = [".docx"];

  /**
   * Split the document text into chunks by paragraph grouping.
   * @param filePath - Original file path (for metadata).
   * @param content - Extracted plain-text content of the .docx file.
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
          language: "docx",
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
            language: "docx",
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

/** Default singleton instance of {@link DocxChunker}. */
export const docxChunker = new DocxChunker();
