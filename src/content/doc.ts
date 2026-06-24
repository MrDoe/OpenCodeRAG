import type { ExtractResult } from "./types.js";

export const DOC_EXTENSIONS = new Set([".doc"]);


/**
 * Extracts text from a DOC file.
 * This function uses the `extractDocText` method to read and process the DOC buffer.
 * @param filePath - The file path of the document to be extracted.
 * @param buffer - A Buffer containing the document's contents.
 * @returns An object with `content` indicating the extracted text, `ok` as a boolean representing if the operation was successful, and `error` for any error messages.
 */
export async function extract(filePath: string, buffer: Buffer): Promise<ExtractResult> {
  try {
    const { extractDocText } = await import("../chunker/doc.js");
    const content = await extractDocText(buffer);
    return { content, ok: true };
  } catch (err) {
    return { content: "", ok: false, error: (err as Error).message };
  }
}
