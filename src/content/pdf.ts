import type { ExtractResult } from "./types.js";

export const PDF_EXTENSIONS = new Set([".pdf"]);


/**
 * Extracts text from a PDF file.
 * This function uses the `extractPdfText` method from `pdf.js` to read the content of the PDF and returns it in a format suitable for processing. If an error occurs during extraction, it includes details about the error.
 * @param filePath - The path to the PDF file.
 * @param buffer - A Buffer containing the PDF data.
 * @returns An object with `content`, indicating the extracted text, `ok` as a boolean representing if the operation was successful, and `error` for any error messages.
 */
export async function extract(filePath: string, buffer: Buffer): Promise<ExtractResult> {
  try {
    const { extractPdfText } = await import("../chunker/pdf.js");
    const content = await extractPdfText(buffer);
    return { content, ok: true };
  } catch (err) {
    return { content: "", ok: false, error: (err as Error).message };
  }
}
