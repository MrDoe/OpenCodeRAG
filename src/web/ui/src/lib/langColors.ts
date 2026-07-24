const LANG_COLORS: Record<string, string> = {
  typescript: "text-blue-400",
  javascript: "text-yellow-400",
  python: "text-green-400",
  java: "text-red-400",
  go: "text-cyan-400",
  rust: "text-orange-400",
  ruby: "text-pink-400",
  csharp: "text-purple-400",
  cpp: "text-indigo-400",
  c: "text-gray-400",
  markdown: "text-gray-300",
  html: "text-orange-300",
  css: "text-blue-300",
  json: "text-yellow-300",
  kotlin: "text-purple-300",
  swift: "text-orange-400",
  tex: "text-emerald-400",
  sql: "text-cyan-300",
};

export function langColor(lang: string): string {
  return LANG_COLORS[lang] ?? "text-slate-400";
}

export function langBadge(lang: string): string {
  return `<span class="inline-block px-1.5 py-0.5 rounded text-xs font-mono ${langColor(lang)} bg-slate-800">${escapeHtml(lang)}</span>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
