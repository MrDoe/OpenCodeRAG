import { createHash } from "node:crypto";
import path from "node:path";

/** Stable prefix for a workspace participating in an explicitly shared store. */
export function workspaceKeyPrefix(workspaceDir: string, pinnedNamespace?: string): string {
  if (!pinnedNamespace?.trim()) return "";
  const absolute = path.resolve(workspaceDir);
  const canonical = process.platform === "win32"
    ? absolute.replace(/^([a-z])(:)/, (_m, drive: string, sep: string) => drive.toUpperCase() + sep)
    : absolute;
  return `ws:${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}:`;
}

/** Prefix a workspace-relative key when a shared namespace requires isolation. */
export function workspaceKey(filePath: string, workspaceDir: string, pinnedNamespace?: string): string {
  if (filePath.startsWith("ws:")) return filePath;
  return workspaceKeyPrefix(workspaceDir, pinnedNamespace) + filePath;
}
