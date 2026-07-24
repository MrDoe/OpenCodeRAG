export function escapeHtml(s: unknown): string {
  if (typeof s !== "string") return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeAttr(s: unknown): string {
  if (typeof s !== "string") return "";
  return s
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/&/g, "&amp;");
}

export function truncate(s: unknown, len = 80): string {
  const str = typeof s === "string" ? s : String(s ?? "");
  return str.length > len ? str.slice(0, len) + "..." : str;
}
