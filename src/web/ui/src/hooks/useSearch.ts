import { useEffect, useState } from "preact/hooks";
import { useDebounce } from "./useDebounce";
import { API } from "../lib/api";
import { searchQuery, searchParams, searchHistory, searchResults } from "../state/store";

export function useSearch() {
  const [results, setResults] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(false);
  const debouncedParams = useDebounce(searchParams.value, 300);

  useEffect(() => {
    const q = searchQuery.value.trim();
    if (!q) {
      setResults([]);
      setError(null);
      setIsLoading(false);
      searchResults.value = [];
      return;
    }

    let cancelled = false;
    const doSearch = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const res = await API.retrieve({
          q,
          topK: debouncedParams.topK,
          minScore: debouncedParams.minScore,
          keywordWeight: debouncedParams.keywordWeight,
          hybrid: debouncedParams.hybrid ? "true" : "false",
          explain: "true",
        });
        if (cancelled) return;

        if (res.status === 503) {
          setError(res.body?.error ?? "Embedding model unavailable");
          setIsLoading(false);
          return;
        }

        setIsInitializing(false);
        const newResults = res.body?.results ?? res.results ?? [];
        setResults(newResults);
        // Mirror into the global signal so the Embeddings search overlay
        // (which reads searchResults.value) can activate.
        searchResults.value = newResults;

        // Add to history
        const entry = { query: q, params: { ...debouncedParams } };
        searchHistory.value = [entry, ...searchHistory.value.filter((h) => h.query !== q).slice(0, 19)];
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    doSearch();
    return () => { cancelled = true; };
  }, [searchQuery.value, debouncedParams]);

  return { results, isLoading, isInitializing, error, setResults };
}
