const BASE = "/api";

function toQuery(params: Record<string, string | number | boolean>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") p.set(k, String(v));
  }
  return p.toString();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const r = await fetch(BASE + url, options);
  const body = await r.json();
  if (!r.ok) {
    throw new Error(body.error ?? r.statusText);
  }
  return body;
}

export const API = {
  stats: () => request<any>("/stats"),
  files: () => request<any>("/files"),
  chunks: (opts: { offset: number; limit: number; lang?: string; file?: string }) =>
    request<any>(`/chunks?${toQuery(opts as any)}`),
  chunk: (id: string) => request<any>(`/chunks/${encodeURIComponent(id)}`),
  search: (q: string, topK = 20) => request<any>(`/search?q=${encodeURIComponent(q)}&topK=${topK}`),
  compare: (ids: string[]) => request<any>(`/compare?ids=${ids.join(",")}`),
  retrieve: (params: Record<string, any>) => request<any>(`/retrieve?${toQuery(params)}`),
  evalSessions: () => request<any>("/eval/sessions"),
  evalSession: (id: string) => request<any>(`/eval/sessions/${encodeURIComponent(id)}`),
  evalDeleteSession: (id: string) =>
    request<any>(`/eval/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  evalCompare: (a: string, b: string) => request<any>(`/eval/compare?a=${a}&b=${b}`),
  evalTokenCompare: (a: string, b: string) => request<any>(`/eval/token-compare?a=${a}&b=${b}`),
  evalAnalysis: (id: string) => request<any>(`/eval/sessions/${encodeURIComponent(id)}/analysis`),
  evalProjectSavings: (params: any) =>
    request<any>("/eval/project-savings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }),
  quirks: () => request<any>("/quirks"),
  quirkLint: () => request<any>("/quirks/lint"),
  deleteQuirk: (id: string) =>
    request<any>(`/quirks/${encodeURIComponent(id)}`, { method: "DELETE" }),
  indexStatus: () => request<any>("/indexing/status"),
  triggerReindex: () => request<any>("/indexing/reindex", { method: "POST" }),
  config: () => request<any>("/config"),
  embeddingProj: (max = 5000) => request<any>(`/embeddings/projection?maxChunks=${max}`),
};
