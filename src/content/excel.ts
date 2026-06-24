import type { ExtractResult } from "./types.js";

export const EXCEL_EXTENSIONS = new Set([".xls", ".xlsx"]);


/**
 * Extracts text from an Excel file buffer.
 * This function uses the `extractExcelText` function imported from the 'excel.js' chunker module to parse the Excel data and returns it in a structured format.
 * @param filePath - The path to the Excel file.
 * @param buffer - A Buffer containing the Excel data.
 * @returns An object with `content`, indicating the extracted text, `ok` as a boolean representing if the operation was successful, and `error` for any error messages.
 */
export async function extract(filePath: string, buffer: Buffer): Promise<ExtractResult> {
  try {
    const { extractExcelText } = await import("../chunker/excel.js");
    const content = await extractExcelText(buffer);
    return { content, ok: true };
  } catch (err) {
    return { content: "", ok: false, error: (err as Error).message };
  }
}
