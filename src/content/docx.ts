import type { ExtractResult } from "./types.js";

export const DOCX_EXTENSIONS = new Set([".docx"]);


/**
 * Extracts text from a DOCX file.
 * This function uses the extractDocxText method to read and process the DOCX buffer.
 * @param filePath - The path of the DOCX file.
 * @param buffer - The DOCX data as a Buffer.
 * @returns A promise that resolves with an object containing the extracted text content and whether the operation was successful.
 */
export async function extract(filePath: string, buffer: Buffer): Promise<ExtractResult> {
  try {
    const { extractDocxText } = await import("../chunker/docx.js");
    const content = await extractDocxText(buffer);
    return { content, ok: true };
  } catch (err) {
    return { content: "", ok: false, error: (err as Error).message };
  }
}
