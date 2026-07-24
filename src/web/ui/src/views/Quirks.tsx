import { useState } from "preact/hooks";
import { useApi } from "../hooks/useApi";
import { API } from "../lib/api";
import { ViewSkeleton } from "../components/ViewSkeleton";
import { ErrorState } from "../components/ErrorState";
import { EmptyState } from "../components/EmptyState";
import { escapeHtml } from "../lib/escape";
import { addToast } from "../state/store";

interface Quirk {
  id: string;
  content: string;
  type: string;
  tags: string[];
  confidence: number;
  sourceRef?: string;
}

const QUIKTYPE_COLORS: Record<string, string> = {
  gotcha: "text-amber-400 bg-amber-900/20",
  preference: "text-emerald-400 bg-emerald-900/20",
  decision: "text-sky-400 bg-sky-900/20",
  "environment-constraint": "text-rose-400 bg-rose-900/20",
};

function quirkTypeBadge(type: string): string {
  const cls = QUIKTYPE_COLORS[type] ?? "text-slate-400 bg-slate-800";
  return `<span class="inline-block px-1.5 py-0.5 rounded text-xs font-mono ${cls}">${escapeHtml(type || "general")}</span>`;
}

export function Quirks() {
  const { data, isLoading, error, refresh } = useApi(() => API.quirks());
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [lintResult, setLintResult] = useState<any>(null);
  const [linting, setLinting] = useState(false);

  if (isLoading) return <ViewSkeleton type="card" />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  const quirks: Quirk[] = data?.quirks ?? [];
  const types = [...new Set(quirks.map((q) => q.type || "general"))];
  const filtered = typeFilter ? quirks.filter((q) => (q.type || "general") === typeFilter) : quirks;

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this quirk?")) return;
    try {
      await API.deleteQuirk(id);
      addToast("success", "Quirk deleted");
      refresh();
    } catch (err) {
      addToast("error", `Delete failed: ${(err as Error).message}`);
    }
  };

  const handleLint = async () => {
    setLinting(true);
    try {
      const res = await API.quirkLint();
      setLintResult(res);
    } catch (err) {
      setLintResult({ error: (err as Error).message });
    }
    setLinting(false);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Quirks</h1>
        <button
          className="bg-slate-700 hover:bg-slate-600 text-white px-3 py-1 rounded text-sm transition-colors"
          onClick={handleLint}
          disabled={linting}
        >
          {linting ? "Linting..." : "Lint"}
        </button>
      </div>

      <div className="flex gap-2 mb-4 flex-wrap">
        <button
          className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
            typeFilter === null ? "bg-brand-600 text-white" : "bg-slate-700 text-slate-300 hover:bg-slate-600"
          }`}
          onClick={() => setTypeFilter(null)}
        >
          All
        </button>
        {types.map((t) => (
          <button
            key={t}
            className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
              typeFilter === t ? "bg-brand-600 text-white" : "bg-slate-700 text-slate-300 hover:bg-slate-600"
            }`}
            onClick={() => setTypeFilter(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {lintResult && (
        <div className={`mb-4 p-3 rounded-lg border text-sm ${
          lintResult.success ? "bg-green-900/30 border-green-700 text-green-300" :
          lintResult.error ? "bg-red-900/30 border-red-700 text-red-300" :
          "bg-amber-900/30 border-amber-700 text-amber-300"
        }`}>
          <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(lintResult, null, 2)}</pre>
        </div>
      )}

      {filtered.length === 0 ? (
        <EmptyState icon="💡" message="No quirks stored yet." />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {filtered.map((q) => (
            <div
              key={q.id}
              className="bg-slate-900 rounded-lg border border-slate-700 p-3 flex flex-col"
            >
              <div className="flex items-center justify-between mb-2">
                <span dangerouslySetInnerHTML={{ __html: quirkTypeBadge(q.type) }} />
                <span
                  className={`text-xs font-mono ${
                    q.confidence > 0.7 ? "text-green-400" : q.confidence > 0.4 ? "text-amber-400" : "text-red-400"
                  }`}
                >
                  {(q.confidence * 100).toFixed(0)}%
                </span>
              </div>
              <p className="text-sm text-slate-200 mb-2 flex-1">{escapeHtml(q.content)}</p>
              {q.tags && q.tags.length > 0 && (
                <div className="flex gap-1 flex-wrap mb-2">
                  {q.tags.map((tag: string) => (
                    <span key={tag} className="text-xs bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded">
                      #{tag}
                    </span>
                  ))}
                </div>
              )}
              <div className="flex items-center justify-between text-xs text-slate-600 mt-auto">
                {q.sourceRef && <span className="font-mono">{escapeHtml(q.sourceRef)}</span>}
                <span className="font-mono">{q.id}</span>
              </div>
              <button
                className="self-end mt-2 text-xs text-slate-600 hover:text-red-400 transition-colors"
                onClick={() => handleDelete(q.id)}
                aria-label="Delete quirk"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
