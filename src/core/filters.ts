/**
 * @fileoverview Shared helpers for MetadataFilter matching across stores
 * (LanceDB, memory, keyword index) so extension handling stays consistent.
 */
import path from "node:path";

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

/**
 * Rewrite `pathPatterns` so they match workspace-relative keys, which is what
 * the stores and the keyword index compare them against: an absolute pattern
 * inside the workspace is relativised, and a leading `**\/` also matches at the
 * workspace root.
 *
 * @param patterns     - Glob-style patterns as the caller wrote them.
 * @param workspaceDir - Workspace root, when known.
 */
export function toKeyPatterns(patterns: string[], workspaceDir?: string): string[] {
  const root = workspaceDir ? `${path.resolve(workspaceDir).replace(/\\/g, "/")}/` : undefined;
  const out = new Set<string>();
  for (const raw of patterns) {
    let pattern = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (root && pattern.startsWith(root)) pattern = pattern.slice(root.length);
    out.add(pattern);
    if (pattern.startsWith("**/")) out.add(pattern.slice(3));
  }
  return [...out];
}
