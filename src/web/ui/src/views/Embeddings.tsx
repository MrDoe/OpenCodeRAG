import { useEffect, useState } from "preact/hooks";
import { useApi } from "../hooks/useApi";
import { useRouter } from "../hooks/useRouter";
import { API } from "../lib/api";
import { langColor } from "../lib/langColors";
import { escapeHtml, truncate } from "../lib/escape";
import { ViewSkeleton } from "../components/ViewSkeleton";
import { ErrorState } from "../components/ErrorState";
import { EmptyState } from "../components/EmptyState";
import { ScatterPlot, type ScatterPlotPoint } from "../charts/ScatterPlot";
import { kmeans, findOutliers } from "../lib/kmeans";
import { navigate, searchResults } from "../state/store";

interface RawPoint {
  id: string;
  x: number;
  y: number;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  description: string;
}

const CLUSTER_COLORS = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b",
  "#a855f7", "#06b6d4", "#ec4899", "#84cc16",
];

type ColorMode = "language" | "file" | "cluster";

export function Embeddings() {
  const { data, isLoading, error, refresh } = useApi(() => API.embeddingProj(5000));
  const [colorMode, setColorMode] = useState<ColorMode>("language");
  const [showClusters, setShowClusters] = useState(false);
  const [showOutliers, setShowOutliers] = useState(false);
  const [showSearchOverlay, setShowSearchOverlay] = useState(false);
  const [searchIds, setSearchIds] = useState<Set<string>>(new Set());

  const [clusterAssignments, setClusterAssignments] = useState<number[] | null>(null);
  const [outliers, setOutliers] = useState<Set<number>>(new Set());

  const rawPoints: RawPoint[] = data?.body?.points ?? data?.points ?? [];
  const totalChunks: number = data?.body?.totalChunks ?? data?.totalChunks ?? 0;

  // Toggle search overlay
  useEffect(() => {
    if (showSearchOverlay && searchResults.value.length > 0) {
      setSearchIds(new Set(searchResults.value.map((r: any) => r.chunk.id)));
    } else {
      setSearchIds(new Set());
    }
  }, [showSearchOverlay, searchResults.value]);

  if (isLoading) return <ViewSkeleton type="chart" />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;
  if (rawPoints.length === 0) return <EmptyState icon="🌐" message="No embedding data available. Index some files first." />;

  // Compute clusters if enabled (client-side k-means)
  useEffect(() => {
    if (showClusters && rawPoints.length > 0) {
      const k = Math.min(8, Math.max(2, Math.floor(rawPoints.length / 20)));
      const assignments = kmeans(rawPoints, k);
      setClusterAssignments(assignments);
      if (showOutliers) {
        const centroids: { x: number; y: number }[] = [];
        for (let i = 0; i < k; i++) {
          const members = rawPoints.filter((_, idx) => assignments[idx] === i);
          if (members.length > 0) {
            centroids.push({
              x: members.reduce((s, m) => s + m.x, 0) / members.length,
              y: members.reduce((s, m) => s + m.y, 0) / members.length,
            });
          }
        }
        setOutliers(findOutliers(rawPoints, assignments, centroids));
      }
    } else {
      setClusterAssignments(null);
      setOutliers(new Set());
    }
  }, [showClusters, showOutliers, rawPoints]);

  // Build display points
  const displayPoints: ScatterPlotPoint[] = rawPoints.map((p, i) => {
    let color: string;
    if (colorMode === "language") {
      // Map language — get a hex from the class name
      const cls = langColor(p.language);
      color = cls === "text-slate-400" ? "#94a3b8" : hexForLang(p.language);
    } else if (colorMode === "file") {
      const dir = p.filePath.split("/")[0] ?? "root";
      color = CLUSTER_COLORS[hashStr(dir) % CLUSTER_COLORS.length]!;
    } else {
      const ci = clusterAssignments?.[i] ?? 0;
      color = CLUSTER_COLORS[ci % CLUSTER_COLORS.length]!;
    }

    const isOutlier = outliers.has(i);
    const isSearchHit = searchIds.has(p.id);
    const highlighted = isSearchHit;

    return {
      id: p.id,
      x: p.x,
      y: p.y,
      color: highlighted ? "#22d3ee" : isOutlier ? "#f97316" : color,
      label: `${p.filePath}:${p.startLine}-${p.endLine} [${p.language}]`,
      radius: highlighted ? 6 : isOutlier ? 5 : 3,
      highlighted,
    };
  });

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Embedding Space Explorer</h1>

      {/* Controls */}
      <div className="flex flex-wrap gap-3 mb-4 items-center">
        <label className="text-xs text-slate-400">Color by:</label>
        <select
          className="bg-slate-800 border border-slate-600 rounded text-xs text-slate-200 px-2 py-1"
          value={colorMode}
          onChange={(e) => setColorMode((e.target as HTMLSelectElement).value as ColorMode)}
        >
          <option value="language">Language</option>
          <option value="file">File</option>
          <option value="cluster">Cluster</option>
        </select>

        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          <input type="checkbox" className="accent-brand-500" checked={showClusters}
            onChange={(e) => setShowClusters((e.target as HTMLInputElement).checked)} />
          Clusters
        </label>

        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          <input type="checkbox" className="accent-brand-500" checked={showOutliers}
            onChange={(e) => setShowOutliers((e.target as HTMLInputElement).checked)} />
          Outliers
        </label>

        {searchResults.value.length > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-slate-400">
            <input type="checkbox" className="accent-brand-500" checked={showSearchOverlay}
              onChange={(e) => setShowSearchOverlay((e.target as HTMLInputElement).checked)} />
            Search overlay ({searchResults.value.length} results)
          </label>
        )}
      </div>

      {/* Legend */}
      {colorMode === "cluster" && clusterAssignments && (
        <div className="flex flex-wrap gap-2 mb-3 text-xs">
          {Array.from(new Set(clusterAssignments)).sort().map((ci) => (
            <span key={ci} className="flex items-center gap-1 text-slate-400">
              <span className="inline-block w-2 h-2 rounded-full" style={{ background: CLUSTER_COLORS[ci % CLUSTER_COLORS.length] }} />
              Cluster {ci + 1}
            </span>
          ))}
        </div>
      )}

      {/* Scatter plot */}
      <ScatterPlot
        points={displayPoints}
        width={900}
        height={600}
        onPointClick={(id) => navigate(`chunks?id=${encodeURIComponent(id)}`)}
        renderTooltip={(p) => {
          const raw = rawPoints.find((rp) => rp.id === p.id);
          return (
            <div>
              <div className="text-yellow-400 font-mono text-xs">{escapeHtml(p.label)}</div>
              {raw?.description && (
                <div className="text-slate-400 text-xs mt-1">{escapeHtml(truncate(raw.description, 80))}</div>
              )}
            </div>
          );
        }}
      />

      <p className="text-xs text-slate-500 mt-2">
        {displayPoints.length} of {totalChunks} chunks displayed
        {displayPoints.length < totalChunks && " (chunks without embeddings omitted)"}
      </p>
    </div>
  );
}

/** Simple string hash for file-based color assignment. */
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Map language name to a hex color for scatter plot points. */
function hexForLang(lang: string): string {
  const map: Record<string, string> = {
    typescript: "#60a5fa",
    javascript: "#facc15",
    python: "#4ade80",
    java: "#f87171",
    go: "#22d3ee",
    rust: "#fb923c",
    ruby: "#f472b6",
    csharp: "#a78bfa",
    cpp: "#818cf8",
    c: "#9ca3af",
    markdown: "#d1d5db",
    html: "#fdba74",
    css: "#60a5fa",
    json: "#fde047",
    kotlin: "#c084fc",
    swift: "#fb923c",
    tex: "#34d399",
    sql: "#67e8f9",
    text: "#94a3b8",
    image: "#a78bfa",
    quirk: "#fbbf24",
  };
  return map[lang] ?? "#94a3b8";
}
