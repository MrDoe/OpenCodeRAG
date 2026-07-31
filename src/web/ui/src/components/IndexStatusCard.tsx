import { useState, useEffect, useRef } from "preact/hooks";
import { API } from "../lib/api";
import { formatRelativeTime, formatTokens } from "../lib/format";
import { addToast } from "../state/store";

interface IndexStatus {
  manifest: {
    totalChunks: number;
    totalFiles: number;
    schemaVersion: number;
    lastIndexedAt: string | null;
  } | null;
  staleFileCount: number;
  watcherActive: boolean;
}

export function IndexStatusCard() {
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [reindexing, setReindexing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = async () => {
    try {
      const res = await API.indexStatus();
      setStatus(res.body ?? res);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { fetchStatus(); }, []);

  // Clear any running completion poll on unmount — without this the
  // interval fires every 2s forever (calling setState on an unmounted
  // component) when the reindex fails or the card is hidden.
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleReindex = async () => {
    setReindexing(true);
    try {
      await API.triggerReindex();
      addToast("info", "Reindex started in background");
      // Poll for completion (bounded: 10 minutes max, then give up)
      const initialLastIndexed = status?.manifest?.lastIndexedAt;
      const startedAt = Date.now();
      pollRef.current = setInterval(async () => {
        if (Date.now() - startedAt > 10 * 60_000) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setReindexing(false);
          addToast("info", "Reindex is still running — check back later");
          return;
        }
        try {
          const res = await API.indexStatus();
          const s = res.body ?? res;
          if (s.manifest?.lastIndexedAt !== initialLastIndexed) {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            setStatus(s);
            setReindexing(false);
            addToast("success", "Reindex complete!");
          }
        } catch {
          // transient network hiccup — keep polling
        }
      }, 2000);
    } catch (err) {
      const message = (err as Error).message ?? "";
      addToast("error", /already running/i.test(message) ? "A reindex is already running" : `Reindex failed: ${message}`);
      setReindexing(false);
    }
  };

  if (loading) return null; // silently hide until loaded

  const lastIndexed = status?.manifest?.lastIndexedAt
    ? formatRelativeTime(status.manifest.lastIndexedAt)
    : "Never";
  const staleness = status?.staleFileCount ?? 0;
  const stalenessColor = staleness === 0 ? "text-green-400" : staleness < 50 ? "text-amber-400" : "text-red-400";

  return (
    <div className="kpi-card p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">Index Status</h2>
      </div>

      {!status?.manifest ? (
        <div className="text-sm text-slate-400">
          No index found. Run <code className="text-brand-400">opencode-rag index</code> first.
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <span className="text-xs text-slate-500 block">Last Indexed</span>
            <span className="text-sm font-mono">{lastIndexed}</span>
          </div>
          <div>
            <span className="text-xs text-slate-500 block">Total Chunks</span>
            <span className="text-sm font-mono">{formatTokens(status.manifest.totalChunks)}</span>
          </div>
          <div>
            <span className="text-xs text-slate-500 block">Total Files</span>
            <span className="text-sm font-mono">{formatTokens(status.manifest.totalFiles)}</span>
          </div>
          <div>
            <span className="text-xs text-slate-500 block">Schema Version</span>
            <span className="text-sm font-mono">{status.manifest.schemaVersion}</span>
          </div>
          <div className="col-span-2">
            <span className="text-xs text-slate-500 block">Index Freshness</span>
            <span className={`text-sm font-mono ${stalenessColor}`}>
              {staleness === 0
                ? "✓ Up to date"
                : `⚠ ${staleness} file${staleness !== 1 ? "s" : ""} modified since last index`}
            </span>
          </div>
          <div className="col-span-2 flex items-end">
            {reindexing ? (
              <div className="flex items-center gap-2">
                <span className="animate-spin">⟳</span>
                <span className="text-sm text-amber-400">Reindexing...</span>
              </div>
            ) : (
              <button
                className="bg-brand-600 hover:bg-brand-500 text-white px-4 py-1.5 rounded text-sm transition-colors"
                onClick={handleReindex}
              >
                Reindex Now
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
