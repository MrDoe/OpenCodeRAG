/**
 * @fileoverview Extracts text content from DOCX files for indexing.
 */

import type { ExtractResult } from "./types.js";

/** Recognized DOCX file extension set. */
export const DOCX_EXTENSIONS = new Set([".docx"]);

/**
 * Extract text content from a DOCX buffer.
 * @param _filePath - Unused, retained for API consistency.
 * @param buffer - Raw DOCX file bytes.
 */
export async function extract(_filePath: string, buffer: Buffer): Promise<ExtractResult> {
  try {
    const { extractDocxText } = await import("../chunker/docx.js");
    const content = extractDocxText(buffer);
    return { content, ok: true };
  } catch (err) {
    return { content: "", ok: false, error: (err as Error).message };
  }
}
