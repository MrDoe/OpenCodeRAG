/**
 * @fileoverview Pure helpers for the `chunking.parsers` extension → parser override map.
 *
 * Kept free of imports so `core/config`, the chunker factory, and the content
 * scanner can all share it without introducing module cycles.
 */

/**
 * Map of file extension (e.g. `".cxx"`) to parser/chunker language name
 * (e.g. `"cpp"`). Keys are normalized to lowercase with a leading dot;
 * values to lowercase language names.
 */
export type ParserOverrides = Record<string, string>;

/**
 * Normalize a single file-extension key: trim, lowercase, ensure a leading dot.
 *
 * @returns The normalized key, or `""` when the key cannot be an extension
 *   (empty after trimming, or containing a path separator).
 */
export function normalizeExtensionKey(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return "";
  if (trimmed.includes("/") || trimmed.includes("\\")) return "";
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

/**
 * Normalize a whole `chunking.parsers` map.
 *
 * Invalid entries (non-string keys/values, empty values, unusable keys) are
 * dropped rather than throwing — validation surfaces them as warnings.
 *
 * @param map - Raw user-supplied map (may be undefined or malformed).
 * @returns A new map with normalized keys and values; `{}` when nothing valid remains.
 */
export function normalizeParserOverrides(map?: ParserOverrides): ParserOverrides {
  const out: ParserOverrides = {};
  if (!map || typeof map !== "object" || Array.isArray(map)) return out;
  for (const [key, value] of Object.entries(map)) {
    const ext = normalizeExtensionKey(key);
    if (!ext) continue;
    if (typeof value !== "string") continue;
    const language = value.trim().toLowerCase();
    if (language.length === 0) continue;
    out[ext] = language;
  }
  return out;
}
