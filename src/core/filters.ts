/**
 * @fileoverview Shared helpers for MetadataFilter matching across stores
 * (LanceDB, memory, keyword index) so extension handling stays consistent.
 */

/**
 * Normalize a raw file-extension list: lowercase, strip leading dots so both
 * "ts" and ".ts" are accepted, and re-prefix with a single dot.
 * Empty/blank entries are dropped.
 */
export function normalizeFileExtensions(extensions?: string[]): string[] {
  if (!extensions) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of extensions) {
    const ext = raw.trim().toLowerCase().replace(/^\.+/, "");
    if (ext.length === 0) continue;
    const normalized = `.${ext}`;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

/**
 * Case-insensitive suffix match of a file path against a normalized extension
 * list (e.g. "src/auth.ts" matches ".ts"). Returns true when the list is empty.
 */
export function matchesFileExtension(filePath: string, extensions: string[]): boolean {
  if (extensions.length === 0) return true;
  const lower = filePath.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}
