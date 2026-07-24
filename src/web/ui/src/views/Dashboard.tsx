import { useApi } from "../hooks/useApi";
import { API } from "../lib/api";
import { ViewSkeleton } from "../components/ViewSkeleton";
import { ErrorState } from "../components/ErrorState";
import { EmptyState } from "../components/EmptyState";
import { KpiCard } from "../components/KpiCard";
import { langColor } from "../lib/langColors";
import { IndexStatusCard } from "../components/IndexStatusCard";

export function Dashboard() {
  const { data: stats, isLoading, error, refresh } = useApi(() => API.stats());
  const { data: files } = useApi(() => API.files());

  if (isLoading) return <ViewSkeleton type="card" />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;
  if (!stats) return <EmptyState icon="📊" message="No dashboard data available." />;

  const s = stats;
  const totalFiles = files?.body?.length ?? s.totalFiles ?? 0;
  const totalChunks = s.totalChunks ?? 0;
  const langCount = s.languages?.length ?? 0;
  const avgChunks = totalFiles > 0 ? (totalChunks / totalFiles).toFixed(1) : "0";
  const topLangs = (s.languages ?? []).slice(0, 8);
  const maxCount = topLangs[0]?.count ?? 1;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Dashboard</h1>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <KpiCard label="Total Chunks" value={totalChunks.toLocaleString()} icon="🧩" />
        <KpiCard label="Total Files" value={totalFiles.toLocaleString()} icon="📄" />
        <KpiCard label="Languages" value={langCount} icon="🔤" />
        <KpiCard label="Avg Chunks/File" value={avgChunks} icon="📊" />
      </div>

      <div className="kpi-card p-4">
        <h3 className="text-sm font-semibold text-slate-300 mb-3">Language Distribution</h3>
        <div className="space-y-2">
          {topLangs.map((l: { language: string; count: number }) => (
            <div key={l.language} className="flex items-center gap-3">
              <span className={`w-24 text-xs text-right ${langColor(l.language)}`}>
                {l.language}
              </span>
              <div className="flex-1 bg-slate-800 rounded-full h-5 overflow-hidden">
                <div
                  className="h-full rounded-full bg-brand-500 flex items-center pl-2"
                  style={{ width: `${Math.max(8, (l.count / maxCount) * 100)}%` }}
                >
                  <span className="text-xs font-medium text-white">{l.count}</span>
                </div>
              </div>
              <span className="text-xs text-slate-500 w-12 text-right">
                {((l.count / totalChunks) * 100).toFixed(0)}%
              </span>
            </div>
          ))}
        </div>
      </div>

      <IndexStatusCard />

      <div className="mt-6">
        <h2 className="text-lg font-semibold mb-3">
          <a href="#config" className="hover:text-brand-400 transition-colors">Configuration</a>
        </h2>
      </div>
    </div>
  );
}
