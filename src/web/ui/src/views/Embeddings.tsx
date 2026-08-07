import { useEffect, useState, useMemo, useRef } from "preact/hooks";
import { lazy, Suspense } from "preact/compat";
import { useApi } from "../hooks/useApi";
import { API } from "../lib/api";
import { langColor, langBadge } from "../lib/langColors";
import { escapeHtml, truncate } from "../lib/escape";
import { ViewSkeleton } from "../components/ViewSkeleton";
import { ErrorState } from "../components/ErrorState";
import { EmptyState } from "../components/EmptyState";
import { ScatterPlot, type ScatterPlotPoint } from "../charts/ScatterPlot";
import { kmeans, findOutliers } from "../lib/kmeans";
import { navigate, searchResults } from "../state/store";

const ScatterPlot3D = lazy(() =>
  import("../charts/ScatterPlot3D").then((m) => ({ default: m.ScatterPlot3D }))
);

interface RawPoint {
  id: string;
  x: number;
  y: number;
  z?: number;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  description: string;
}

/** Superset point shape shared by the 2D ScatterPlot and the 3D ScatterPlot3D. */
interface DisplayPoint {
  id: string;
  x: number;
  y: number;
  z: number;
  color: string;
  label: string;
  radius: number;
  highlighted: boolean;
}

interface ChunkDetail {
  id: string;
  content: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  description: string | null;
}

const CLUSTER_COLORS = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b",
  "#a855f7", "#06b6d4", "#ec4899", "#84cc16",
  "#f97316", "#14b8a6", "#8b5cf6", "#e11d48", "#65a30d",
  "#0ea5e9", "#d946ef", "#ca8a04", "#64748b", "#4ade80",
  "#fb7185", "#38bdf8",
];

const CLUSTER_K_MIN = 2;
const CLUSTER_K_MAX = 50;
const CLUSTER_ITER_MIN = 5;
const CLUSTER_ITER_MAX = 200;
const CLUSTER_LEGEND_MAX = 20;

const LEGEND_MAX = 12;

type ColorMode = "language" | "file" | "cluster";
type ViewMode = "2d" | "3d";

export function Embeddings() {
  // Always fetch the 3D projection: the 2D chart simply ignores z, so
  // switching modes is instant and shares one server-side cache entry.
  const { data, isLoading, error, refresh } = useApi(() => API.embeddingProj(5000, 3));
  const [colorMode, setColorMode] = useState<ColorMode>("language");
  const [viewMode, setViewMode] = useState<ViewMode>("3d");
  const [showOutliers, setShowOutliers] = useState(false);
  const [clusterK, setClusterK] = useState(8);
  const [clusterMaxIter, setClusterMaxIter] = useState(20);
  const [showSearchOverlay, setShowSearchOverlay] = useState(false);
  const [searchIds, setSearchIds] = useState<Set<string>>(new Set());
  const [pointSize, setPointSize] = useState(5);
  const [resetKey, setResetKey] = useState(0);
  const [selectedChunk, setSelectedChunk] = useState<ChunkDetail | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);
  const clickSeqRef = useRef(0);

  const [clusterAssignments, setClusterAssignments] = useState<number[] | null>(null);
  const [outliers, setOutliers] = useState<Set<number>>(new Set());

  const rawPoints: RawPoint[] = data?.body?.points ?? data?.points ?? [];
  const totalChunks: number = data?.body?.totalChunks ?? data?.totalChunks ?? 0;

  // Compute clusters when "Color by: Cluster" is active (client-side k-means,
  // 2D or 3D depending on whether the projection carries a z coordinate).
  // K and the iteration cap are user-configurable; K is clamped to the point
  // count.
  // NOTE: this effect MUST live above the early returns below — conditional
  // hooks (effect after `if (isLoading) return …`) shift hook slots between
  // renders and break Preact's cleanup pairing.
  useEffect(() => {
    if (colorMode === "cluster" && rawPoints.length > 0) {
      const k = Math.max(CLUSTER_K_MIN, Math.min(clusterK, rawPoints.length));
      const assignments = kmeans(rawPoints, k, clusterMaxIter);
      setClusterAssignments(assignments);
      if (showOutliers) {
        const centroids: { x: number; y: number; z?: number }[] = [];
        for (let i = 0; i < k; i++) {
          const members = rawPoints.filter((_, idx) => assignments[idx] === i);
          if (members.length > 0) {
            const hasZ = members[0]?.z !== undefined;
            centroids.push({
              x: members.reduce((s, m) => s + m.x, 0) / members.length,
              y: members.reduce((s, m) => s + m.y, 0) / members.length,
              ...(hasZ
                ? { z: members.reduce((s, m) => s + (m.z ?? 0), 0) / members.length }
                : {}),
            });
          }
        }
        setOutliers(findOutliers(rawPoints, assignments, centroids));
      }
    } else {
      setClusterAssignments(null);
      setOutliers(new Set());
    }
  }, [colorMode, showOutliers, clusterK, clusterMaxIter, rawPoints]);

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

  // Per-file colors: files are ordered by their projected centroid position,
  // then each gets the hue farthest from all previously assigned hues, so
  // every file is unique and spatially adjacent files never share a color.
  const fileColors: Map<string, string> = useMemo(() => buildFileColors(rawPoints), [rawPoints]);

  // Build display points (memoized — rebuilding 5000 objects per render was
  // wasted work on every state change)
  const displayPoints: DisplayPoint[] = useMemo(() => rawPoints.map((p, i) => {
    let color: string;
    if (colorMode === "language") {
      // Map language — get a hex from the class name
      const cls = langColor(p.language);
      color = cls === "text-slate-400" ? "#94a3b8" : hexForLang(p.language);
    } else if (colorMode === "file") {
      color = fileColors.get(p.filePath) ?? "#94a3b8";
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
        z: p.z ?? 0.5,
        color: highlighted ? "#22d3ee" : isOutlier ? "#f97316" : color,
        label: `${p.filePath}:${p.startLine}-${p.endLine} [${p.language}]`,
        radius: highlighted ? 6 : isOutlier ? 5 : 3,
        highlighted,
      };
    }), [rawPoints, colorMode, clusterAssignments, outliers, searchIds, fileColors]);

  // Select a chunk: fetch its details (content + description) and show them
  // in the panel below the plot. Out-of-order guard: clicking point A then B
  // must not render A's details while B is selected.
  // Legend data for file mode: the top files by chunk count with their
  // per-file colors, labeled relative to the workspace root.
  const fileLegend: { label: string; count: number; color: string }[] = useMemo(() => {
    if (colorMode !== "file") return [];
    const commonRoot = commonRootOf(rawPoints.map((p) => p.filePath));
    const counts = new Map<string, number>();
    for (const p of rawPoints) {
      counts.set(p.filePath, (counts.get(p.filePath) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, LEGEND_MAX)
      .map(([file, count]) => ({
        label: file.slice(commonRoot.length) || file,
        count,
        color: fileColors.get(file) ?? "#94a3b8",
      }));
  }, [colorMode, rawPoints, fileColors]);

  const fileLegendRest = useMemo(() => {
    if (colorMode !== "file") return 0;
    return new Set(rawPoints.map((p) => p.filePath)).size - fileLegend.length;
  }, [colorMode, rawPoints, fileLegend]);

  const handlePointClick = (id: string) => {
    const seq = ++clickSeqRef.current;
    setSelectedChunk(null);
    setSelectedLoading(true);
    API.chunk(id).then((res) => {
      if (seq === clickSeqRef.current) {
        setSelectedChunk(res);
        setSelectedLoading(false);
      }
    }).catch(() => {
      if (seq === clickSeqRef.current) {
        setSelectedChunk({
          id, content: "", filePath: "not found", language: "",
          startLine: 0, endLine: 0, description: "Error loading chunk details.",
        });
        setSelectedLoading(false);
      }
    });
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Embedding Space Explorer</h1>

      {/* Controls */}
      <div className="flex flex-wrap gap-3 mb-4 items-center">
        <div className="flex items-center gap-1 bg-slate-800 border border-slate-600 rounded-lg p-0.5">
          {(["2d", "3d"] as ViewMode[]).map((mode) => (
            <button
              key={mode}
              className={`px-2 py-0.5 rounded text-xs transition-colors ${
                viewMode === mode
                  ? "bg-slate-600 text-white"
                  : "text-slate-400 hover:text-slate-200"
              }`}
              onClick={() => setViewMode(mode)}
            >
              {mode.toUpperCase()}
            </button>
          ))}
        </div>

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

        {colorMode === "cluster" && (
          <>
            <label className="text-xs text-slate-400">K:</label>
            <input
              type="number"
              min={CLUSTER_K_MIN}
              max={CLUSTER_K_MAX}
              value={clusterK}
              onChange={(e) => setClusterK(clampInt(e.target, CLUSTER_K_MIN, CLUSTER_K_MAX, 8))}
              className="bg-slate-800 border border-slate-600 rounded text-xs text-slate-200 px-2 py-1 w-16"
              title="Number of clusters"
            />
            <label className="text-xs text-slate-400">Iterations:</label>
            <input
              type="number"
              min={CLUSTER_ITER_MIN}
              max={CLUSTER_ITER_MAX}
              value={clusterMaxIter}
              onChange={(e) => setClusterMaxIter(clampInt(e.target, CLUSTER_ITER_MIN, CLUSTER_ITER_MAX, 20))}
              className="bg-slate-800 border border-slate-600 rounded text-xs text-slate-200 px-2 py-1 w-20"
              title="Maximum k-means iterations"
            />
          </>
        )}

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

        {viewMode === "3d" && (
          <>
            <label className="text-xs text-slate-400">Point size:</label>
            <input
              type="range"
              min={1}
              max={20}
              value={pointSize}
              onChange={(e) => setPointSize(Number((e.target as HTMLInputElement).value))}
              className="w-24 accent-brand-500"
            />
            <button
              className="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded text-xs text-white transition-colors"
              onClick={() => setResetKey((k) => k + 1)}
            >
              Reset camera
            </button>
          </>
        )}
      </div>

      {/* Legend */}
      {colorMode === "cluster" && clusterAssignments && (
        <div className="flex flex-wrap gap-2 mb-3 text-xs">
          {(() => {
            const clusters = Array.from(new Set(clusterAssignments)).sort((a, b) => a - b);
            const shown = clusters.slice(0, CLUSTER_LEGEND_MAX);
            const rest = clusters.length - shown.length;
            return (
              <>
                {shown.map((ci) => (
                  <span key={ci} className="flex items-center gap-1 text-slate-400">
                    <span className="inline-block w-2 h-2 rounded-full" style={{ background: CLUSTER_COLORS[ci % CLUSTER_COLORS.length] }} />
                    Cluster {ci + 1}
                  </span>
                ))}
                {rest > 0 && <span className="text-slate-500">+{rest} more</span>}
              </>
            );
          })()}
        </div>
      )}

      {colorMode === "file" && fileLegend.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3 text-xs">
          {fileLegend.map(({ label, count, color }) => (
            <span key={label} className="flex items-center gap-1 text-slate-400" title={label}>
              <span className="inline-block w-2 h-2 rounded-full" style={{ background: color }} />
              {escapeHtml(truncate(label, 40))} ({count})
            </span>
          ))}
          {fileLegendRest > 0 && <span className="text-slate-500">+{fileLegendRest} more files</span>}
        </div>
      )}

      {/* Plot */}
      {viewMode === "3d" ? (
        <Suspense fallback={<ViewSkeleton type="chart" />}>
          <ScatterPlot3D
            points={displayPoints}
            width={900}
            height={600}
            onPointClick={handlePointClick}
            pointSize={pointSize}
            resetKey={resetKey}
            selectedId={selectedChunk?.id ?? null}
          />
        </Suspense>
      ) : (
        <ScatterPlot
          points={displayPoints}
          width={900}
          height={600}
          onPointClick={handlePointClick}
          renderTooltip={(p: ScatterPlotPoint) => {
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
      )}

      {/* Selected chunk details */}
      {selectedLoading && <ViewSkeleton type="detail" />}
      {selectedChunk && !selectedLoading && (
        <div className="kpi-card p-4 mt-4">
          <div className="flex items-center gap-3 mb-1 flex-wrap">
            <span className="text-yellow-400 font-mono text-sm">{escapeHtml(selectedChunk.filePath)}</span>
            <span className="text-slate-400 text-xs">Lines {selectedChunk.startLine}-{selectedChunk.endLine}</span>
            <span dangerouslySetInnerHTML={{ __html: langBadge(selectedChunk.language) }} />
            {selectedChunk.id && <span className="text-xs text-slate-600 font-mono">{selectedChunk.id}</span>}
            <button
              className="ml-auto px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded text-xs text-white transition-colors"
              onClick={() => navigate(`chunks?id=${encodeURIComponent(selectedChunk.id)}`)}
            >
              Open in Chunks
            </button>
          </div>
          {selectedChunk.description && (
            <div className="mb-3">
              <h3 className="text-xs font-semibold text-slate-400 mb-1">Description</h3>
              <p className="text-sm text-slate-300">{escapeHtml(selectedChunk.description)}</p>
            </div>
          )}
          {selectedChunk.content && (
            <div>
              <h3 className="text-xs font-semibold text-slate-400 mb-1">Content</h3>
              <pre className="text-xs text-slate-300 bg-slate-900 border border-slate-700 rounded p-3 overflow-auto max-h-64 font-mono whitespace-pre">
                {escapeHtml(selectedChunk.content)}
              </pre>
            </div>
          )}
        </div>
      )}

      <p className="text-xs text-slate-500 mt-2">
        {displayPoints.length} of {totalChunks} chunks displayed
        {displayPoints.length < totalChunks && " (chunks without embeddings omitted)"}
      </p>
    </div>
  );
}

/** Parse a number input and clamp it into [min, max]; falls back to `fallback` when empty/invalid. */
function clampInt(el: EventTarget | null, min: number, max: number, fallback: number): number {
  const v = parseInt((el as HTMLInputElement | null)?.value ?? "", 10);
  if (Number.isNaN(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

/** Longest common path prefix shared by all file paths, trimmed at a '/' boundary. */
function commonRootOf(paths: string[]): string {
  if (paths.length === 0) return "";
  let prefix = paths[0] ?? "";
  for (const p of paths) {
    while (p && prefix && !p.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  const idx = prefix.lastIndexOf("/");
  return idx >= 0 ? prefix.slice(0, idx + 1) : "";
}

/**
 * Assign one distinct color per file for "file" color mode.
 *
 * Files are ordered by their projected centroid position (dominant axis
 * first), then colored with the golden-angle hue sequence (137.508° steps)
 * and alternating lightness. Consecutive files — i.e. spatially adjacent
 * files — are therefore always ~137.5° apart in hue, so neighboring chunks
 * of different files never look alike, and the (hue, lightness) combination
 * is unique per file.
 */
function buildFileColors(rawPoints: RawPoint[]): Map<string, string> {
  const sums = new Map<string, { x: number; y: number; z: number; n: number }>();
  for (const p of rawPoints) {
    const s = sums.get(p.filePath) ?? { x: 0, y: 0, z: 0, n: 0 };
    s.x += p.x;
    s.y += p.y;
    s.z += p.z ?? 0;
    s.n++;
    sums.set(p.filePath, s);
  }
  const files: { file: string; x: number; y: number; z: number }[] = [];
  for (const [file, s] of sums) files.push({ file, x: s.x / s.n, y: s.y / s.n, z: s.z / s.n });

  const cx = files.reduce((a, f) => a + f.x, 0) / files.length;
  const cy = files.reduce((a, f) => a + f.y, 0) / files.length;
  const cz = files.reduce((a, f) => a + f.z, 0) / files.length;
  const varX = files.reduce((a, f) => a + (f.x - cx) ** 2, 0);
  const varY = files.reduce((a, f) => a + (f.y - cy) ** 2, 0);
  const varZ = files.reduce((a, f) => a + (f.z - cz) ** 2, 0);
  const axis: "x" | "y" | "z" = varX >= varY && varX >= varZ ? "x" : varY >= varZ ? "y" : "z";
  const other: ("x" | "y" | "z")[] = (["x", "y", "z"] as const).filter((a) => a !== axis);
  files.sort(
    (a, b) => a[axis] - b[axis] || a[other[0]!] - b[other[0]!] || a[other[1]!] - b[other[1]!]
  );

  const colors = new Map<string, string>();
  const GOLDEN_ANGLE = 137.508;
  for (let i = 0; i < files.length; i++) {
    const hue = (i * GOLDEN_ANGLE) % 360;
    const lightness = i % 2 === 0 ? 55 : 40;
    colors.set(files[i]!.file, `hsl(${hue.toFixed(1)}, 80%, ${lightness}%)`);
  }
  return colors;
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
