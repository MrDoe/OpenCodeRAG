import { useSearch } from "../hooks/useSearch";
import { useRouter } from "../hooks/useRouter";
import { langBadge } from "../lib/langColors";
import { escapeHtml } from "../lib/escape";
import { navigate, searchQuery, searchParams, searchHistory, searchResults } from "../state/store";
import { ScoreBar } from "../components/ScoreBar";
import { ErrorState } from "../components/ErrorState";
import { useEffect } from "preact/hooks";

export function Search() {
  const router = useRouter();
  const { results, isLoading, isInitializing, error } = useSearch();

  // Restore from URL hash on mount
  useEffect(() => {
    if (router.params.query) {
      searchQuery.value = router.params.query;
      searchParams.value = {
        ...searchParams.value,
        topK: parseInt(router.params.topK ?? "10", 10),
        minScore: parseFloat(router.params.minScore ?? "0.35"),
        keywordWeight: parseFloat(router.params.keywordWeight ?? "0.4"),
        hybrid: router.params.hybrid !== "false",
        pathFilter: router.params.path ?? "",
        langFilter: router.params.lang ?? "",
      };
    }
  }, []);

  // Sync params to hash for shareable URLs
  useEffect(() => {
    if (searchQuery.value.trim()) {
      const p = new URLSearchParams({
        query: searchQuery.value,
        topK: String(searchParams.value.topK),
        minScore: String(searchParams.value.minScore),
        keywordWeight: String(searchParams.value.keywordWeight),
        hybrid: String(searchParams.value.hybrid),
      });
      if (searchParams.value.pathFilter) p.set("path", searchParams.value.pathFilter);
      if (searchParams.value.langFilter) p.set("lang", searchParams.value.langFilter);
      const hash = `search?${p.toString()}`;
      if (location.hash !== `#${hash}`) {
        history.replaceState(null, "", `#${hash}`);
      }
    }
  }, [searchQuery.value, searchParams.value]);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Semantic Search</h1>

      {/* Query input */}
      <div className="flex gap-3 mb-4">
        <input
          type="text"
          value={searchQuery.value}
          onInput={(e) => {
            searchQuery.value = (e.target as HTMLInputElement).value;
            searchResults.value = [];
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && searchQuery.value.trim()) {
              // Search is triggered by useSearch hook on query change
            }
          }}
          placeholder="Search your codebase semantically... (e.g., 'how does authentication work?')"
          className="flex-1 px-4 py-2 bg-slate-800 border border-slate-600 rounded-lg text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-brand-400"
          autoFocus
          aria-label="Semantic search query"
        />
      </div>

      {/* Parameter panel */}
      <details className="mb-4 bg-slate-800 rounded-lg border border-slate-700">
        <summary className="px-3 py-2 text-xs text-slate-400 cursor-pointer hover:text-white font-medium">
          Search Parameters
        </summary>
        <div className="px-3 pb-3 space-y-3">
          <ParamSlider label="topK" min={1} max={25} step={1} value={searchParams.value.topK}
            onChange={(v) => { searchParams.value = { ...searchParams.value, topK: v }; }} />
          <ParamSlider label="minScore" min={0} max={1} step={0.05} value={searchParams.value.minScore}
            onChange={(v) => { searchParams.value = { ...searchParams.value, minScore: v }; }} />
          <ParamSlider label="keywordWeight" min={0} max={1} step={0.1} value={searchParams.value.keywordWeight}
            onChange={(v) => { searchParams.value = { ...searchParams.value, keywordWeight: v }; }} />
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-400 w-28">Hybrid mode</label>
            <input type="checkbox" checked={searchParams.value.hybrid}
              onChange={(e) => { searchParams.value = { ...searchParams.value, hybrid: (e.target as HTMLInputElement).checked }; }}
              className="accent-brand-500" />
          </div>
        </div>
      </details>

      {/* Loading / Error / Results */}
      {isInitializing && (
        <div className="text-center py-10 text-slate-400">
          <span className="animate-spin inline-block mr-2">⟳</span>
          Initializing embedding model...
        </div>
      )}

      {error && (
        <ErrorState message={error} />
      )}

      {!isLoading && !error && searchQuery.value.trim() && results.length === 0 && (
        <div className="text-center py-16 text-slate-500">
          <div className="text-4xl mb-2">🔍</div>
          <div>No results found for "{escapeHtml(searchQuery.value)}"</div>
        </div>
      )}

      {!isLoading && !error && !searchQuery.value.trim() && (
        <div className="text-center py-16 text-slate-500">
          <div className="text-4xl mb-2">🔍</div>
          <div>Enter a query to search your codebase</div>
          {searchHistory.value.length > 0 && (
            <div className="mt-6">
              <p className="text-xs text-slate-600 mb-2">Recent queries:</p>
              <div className="flex flex-wrap gap-2 justify-center">
                {searchHistory.value.slice(0, 10).map((h, i) => (
                  <button
                    key={i}
                    className="px-2 py-1 bg-slate-800 rounded text-xs text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
                    onClick={() => { searchQuery.value = h.query; }}
                  >
                    {escapeHtml(h.query)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm text-slate-400 mb-2">
            <span>{results.length} result{results.length !== 1 ? "s" : ""}</span>
            {isLoading && <span className="text-xs text-brand-400 animate-pulse">Searching...</span>}
          </div>
          {results.map((r: any) => (
            <SearchResultCard key={r.chunk.id} result={r} />
          ))}
        </div>
      )}

      {isLoading && results.length === 0 && (
        <div className="text-center py-10 text-slate-400">
          <span className="animate-spin inline-block mr-2">⟳</span>
          Searching...
        </div>
      )}
    </div>
  );
}

function SearchResultCard({ result }: { result: any }) {
  const c = result.chunk;
  const score = result.score;

  return (
    <div
      className="bg-slate-800 rounded-lg p-4 border border-slate-700 hover:border-brand-500/50 transition-colors cursor-pointer"
      onClick={() => navigate(`chunks?id=${encodeURIComponent(c.id)}`)}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm text-yellow-400 font-mono truncate">
            {escapeHtml(c.filePath)}:{c.startLine}-{c.endLine}
          </span>
          <span dangerouslySetInnerHTML={{ __html: langBadge(c.language) }} />
        </div>
        <span className="text-lg font-bold shrink-0 ml-2" style={{ color: scoreToColor(score) }}>
          {score.toFixed(2)}
        </span>
      </div>

      {/* Score breakdown */}
      {result.explanation && <ScoreBar explanation={result.explanation} />}

      {/* Matched terms */}
      {result.explanation?.matchedTerms?.length > 0 && (
        <div className="flex gap-1 flex-wrap mb-2">
          {result.explanation.matchedTerms.map((term: string) => (
            <span key={term} className="text-xs bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded">
              {escapeHtml(term)}
            </span>
          ))}
        </div>
      )}

      {/* Description */}
      {c.description && (
        <p className="text-sm text-slate-400 mb-2 line-clamp-2">{escapeHtml(c.description)}</p>
      )}

      {/* Code snippet */}
      <pre className="text-xs overflow-x-auto max-h-32 rounded bg-slate-900/50 p-2">
        <code>{escapeHtml(c.content ?? "").slice(0, 500)}</code>
      </pre>
    </div>
  );
}

function scoreToColor(score: number): string {
  if (score >= 0.8) return "#22c55e";
  if (score >= 0.6) return "#06b6d4";
  if (score >= 0.4) return "#f59e0b";
  return "#ef4444";
}

function ParamSlider({ label, min, max, step, value, onChange }: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <label className="text-xs text-slate-400 w-28 shrink-0">{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onInput={(e) => onChange(parseFloat((e.target as HTMLInputElement).value))}
        className="flex-1 accent-brand-500"
      />
      <span className="text-xs text-slate-300 font-mono w-12 text-right">{value}</span>
    </div>
  );
}
