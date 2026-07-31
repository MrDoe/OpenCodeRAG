import { useState, useRef, useEffect } from "preact/hooks";
import { useDebounce } from "../hooks/useDebounce";
import { API } from "../lib/api";
import { langBadge } from "../lib/langColors";
import { escapeHtml } from "../lib/escape";
import { navigate } from "../state/store";

export function GlobalSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debouncedQuery = useDebounce(query, 300);

  useEffect(() => {
    if (!debouncedQuery.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    let cancelled = false;
    API.search(debouncedQuery, 10).then((data) => {
      // Stale-response guard: a slower response for an older query must not
      // overwrite the results of the current one.
      if (!cancelled) {
        setResults(data?.results ?? []);
        setOpen(true);
      }
    }).catch(() => {
      if (!cancelled) setOpen(false);
    });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
  };

  const handleSelect = async (id: string) => {
    setOpen(false);
    setQuery("");
    navigate(`chunks`);
  };

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        placeholder="Search codebase..."
        value={query}
        onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        onKeyDown={handleKeyDown as any}
        className="global-search-input w-56 px-3 py-1.5 bg-slate-800 border border-slate-600 rounded text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-brand-400"
        aria-label="Global search"
        role="combobox"
        aria-expanded={open}
      />

      {open && results.length > 0 && (
        <div
          className="absolute top-full right-0 mt-1 w-96 bg-slate-800 border border-slate-600 rounded-lg shadow-xl z-50 max-h-80 overflow-y-auto"
          role="listbox"
        >
          {results.map((r: any) => (
            <div
              key={r.chunk.id}
              className="search-result p-2 hover:bg-slate-700 cursor-pointer border-b border-slate-700 last:border-0"
              onClick={() => handleSelect(r.chunk.id)}
              role="option"
            >
              <div className="flex items-center gap-2 text-xs">
                <span className="text-yellow-400 font-mono">
                  {escapeHtml(r.chunk.filePath)}:{r.chunk.startLine}-{r.chunk.endLine}
                </span>
                <span dangerouslySetInnerHTML={{ __html: langBadge(r.chunk.language) }} />
                <span className="ml-auto text-slate-500">{r.score}</span>
              </div>
              <div className="text-xs text-slate-400 mt-1 truncate">
                {escapeHtml(r.chunk.content ?? "").slice(0, 80)}
              </div>
            </div>
          ))}
        </div>
      )}

      {open && query.trim() && results.length === 0 && (
        <div className="absolute top-full right-0 mt-1 w-96 bg-slate-800 border border-slate-600 rounded-lg shadow-xl z-50 p-3 text-sm text-slate-500">
          No results
        </div>
      )}
    </div>
  );
}
