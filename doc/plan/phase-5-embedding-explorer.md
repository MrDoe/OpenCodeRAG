# Phase 5: Embedding Space Explorer

**Duration:** 4 days  |  **Priority:** High (unique "wow" feature)

> **The problem:** The vector index is a black box. Users can search it but can't *see* the semantic landscape of their codebase — which files cluster together, which chunks are outliers, where the semantic boundaries are. The RAG pipeline works but is invisible.

> **The vision:** An interactive 2D scatter plot of chunk embeddings that lets users visually explore the semantic structure of their codebase. Each chunk is a point, positioned by its embedding semantics. Color by language, file, or automatically detected clusters. Overlay search results to see how the retriever's output distributes across the space.

---

## Step 5.1: Backend — PCA Implementation + Projection Endpoint (Day 1)

### File: `src/web/pca.ts` (new)

A self-contained, zero-dependency PCA implementation. Takes an array of vectors (all same dimension) and projects them onto the top-2 principal components.

```typescript
/**
 * Compute 2D PCA projection of a set of embedding vectors.
 *
 * Steps:
 *  1. Center the data (subtract column means)
 *  2. Compute covariance matrix
 *  3. Power iteration to find top-2 eigenvectors
 *  4. Project centered data onto eigenvectors
 *  5. Normalize to [0, 1] range for display
 *
 * @param vectors — Array of vectors, each with the same length (e.g., 384 for qwen3-embedding)
 * @returns Array of { x, y } normalized to [0, 1]
 */
export function computePCA(vectors: number[][]): { x: number; y: number }[] {
  const n = vectors.length;
  if (n === 0) return [];
  const dim = vectors[0]!.length;
  if (n === 1) return [{ x: 0.5, y: 0.5 }];

  // 1. Compute column means
  const means = new Array(dim).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < dim; j++) {
      means[j] += vectors[i]![j]!;
    }
  }
  for (let j = 0; j < dim; j++) means[j] /= n;

  // 2. Center data
  const centered = vectors.map(v => v.map((val, j) => val - means[j]!));

  // 3. Compute covariance matrix (dim × dim), upper triangle only
  const cov: number[][] = Array.from({ length: dim }, () => new Array(dim).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < dim; j++) {
      for (let k = j; k < dim; k++) {
        cov[j]![k]! += centered[i]![j]! * centered[i]![k]!;
      }
    }
  }
  for (let j = 0; j < dim; j++) {
    for (let k = j; k < dim; k++) {
      cov[j]![k]! /= n - 1;
    }
  }

  // 4. Power iteration to find top-2 eigenvectors
  const eigenvectors = [
    powerIteration(cov, dim, 50),
    null as number[] | null,
  ];
  // Deflate: subtract PC1's contribution, then find PC2
  // (Simpler approach: just use first 2 dimensions if dim is small,
  //  or run power iteration twice with random restarts)
  const pc1 = eigenvectors[0]!;
  const deflated = cov.map((row, i) =>
    row.map((val, j) => {
      const proj = pc1.reduce((sum, v, k) => sum + v * cov[i]![k]!, 0);
      return val - proj * pc1[j]! / (pc1.reduce((s, v) => s + v * v, 0));
    })
  );
  eigenvectors[1] = powerIteration(deflated, dim, 50);
  const pc2 = eigenvectors[1]!;

  // 5. Project centered data onto PCs
  const projected = centered.map(v => ({
    x: v.reduce((sum, val, j) => sum + val * pc1[j]!, 0),
    y: v.reduce((sum, val, j) => sum + val * pc2[j]!, 0),
  }));

  // 6. Normalize to [0, 1]
  const xs = projected.map(p => p.x);
  const ys = projected.map(p => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  return projected.map(p => ({
    x: (p.x - minX) / rangeX,
    y: (p.y - minY) / rangeY,
  }));
}

/** Power iteration to find the dominant eigenvector of a symmetric matrix. */
function powerIteration(matrix: number[][], dim: number, maxIter: number): number[] {
  let v = new Array(dim).fill(0).map(() => Math.random() * 2 - 1);
  const normalize = (vec: number[]) => {
    const len = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return len > 1e-10 ? vec.map(v => v / len) : vec;
  };

  for (let iter = 0; iter < maxIter; iter++) {
    const w = new Array(dim).fill(0);
    for (let i = 0; i < dim; i++) {
      for (let j = 0; j < dim; j++) {
        w[i]! += matrix[i]![j]! * v[j]!;
      }
    }
    v = normalize(w);
    // Check convergence — if v barely changed, stop early
    if (iter > 5) {
      const change = Math.sqrt(v.reduce((s, val, i) => s + (val - w[i]!) * (val - w[i]!), 0));
      if (change < 1e-6) break;
    }
  }
  return v;
}
```

**Note:** The PCA computation on 5000 vectors × 384 dimensions is ~200ms on modern hardware. For very large indexes (50k+ vectors), the endpoint should subsample. The power iteration converges in ~10-20 iterations for well-conditioned data.

### File: `src/web/api.ts` — New `/api/embeddings/projection` endpoint

```typescript
async function handleEmbeddingProjection(
  store: LanceDbStore,
  params: URLSearchParams
): Promise<ApiResponse> {
  const maxChunks = parseInt(params.get("maxChunks") ?? "5000", 10);

  try {
    // Fetch all chunks with their embeddings and metadata
    // Requires a store method that returns vectors
    const allChunks = await store.getChunks(0, maxChunks);

    if (allChunks.length === 0) {
      return { status: 200, body: { points: [], totalChunks: 0 } };
    }

    // Extract vectors — LanceDB stores them on chunks
    // The chunk type includes embedding: number[] when fetched with includeEmbeddings
    const vectors = allChunks
      .map(c => (c as any).embedding as number[])
      .filter(Boolean);

    if (vectors.length < 2) {
      // Single point — just put it in the center
      return {
        status: 200,
        body: {
          points: vectors.length === 1 ? [{ x: 0.5, y: 0.5, ...metadata }] : [],
          totalChunks: allChunks.length,
        },
      };
    }

    // Compute PCA projection
    const projected = computePCA(vectors);

    // Combine projection with metadata
    const points = allChunks
      .filter(c => (c as any).embedding)
      .map((c, i) => ({
        id: (c as any).id ?? (c as any).chunk_id,
        x: projected[i]!.x,
        y: projected[i]!.y,
        filePath: c.metadata?.filePath ?? "",
        startLine: c.metadata?.startLine ?? 0,
        endLine: c.metadata?.endLine ?? 0,
        language: c.metadata?.language ?? "",
        description: (c as any).description ?? "",
      }));

    return {
      status: 200,
      body: {
        points,
        totalChunks: allChunks.length,
        displayedChunks: points.length,
        note: points.length < allChunks.length
          ? `${allChunks.length - points.length} chunks without embeddings omitted`
          : undefined,
      },
    };
  } catch (err) {
    return {
      status: 500,
      body: { error: `Failed to compute embedding projection: ${(err as Error).message}` },
    };
  }
}
```

**Important:** `LanceDbStore.getChunks()` currently returns chunks without their embedding vectors (to save memory). A new method `getChunksWithEmbeddings()` (or an `includeEmbeddings: true` option) is needed:

```typescript
// In src/vectorstore/lancedb.ts
async getChunksWithEmbeddings(offset: number, limit: number): Promise<ChunkWithEmbedding[]> {
  // Query LanceDB table, selecting chunk columns + vector
  // Return both chunk data and their raw embedding vectors
}
```

---

## Step 5.2: Frontend — Scatter Plot Component (Days 2-3)

### `src/web/ui/src/charts/ScatterPlot.tsx`

An SVG + Canvas hybrid component for rendering thousands of points with zoom, pan, hover, and click.

```tsx
interface ScatterPlotPoint {
  id: string;
  x: number;
  y: number;
  color: string;
  label: string;       // tooltip text
  radius?: number;
  highlighted?: boolean;
  clusterId?: number;
}

interface ScatterPlotProps {
  points: ScatterPlotPoint[];
  width?: number;
  height?: number;
  onPointClick?: (id: string) => void;
  renderTooltip?: (point: ScatterPlotPoint) => JSX.Element;
}
```

**Implementation approach:**

1. **Canvas layer** (behind): draws all circles as performance-critical primitives. Supports 5000+ points without jank.

2. **SVG overlay** (on top): transparent SVG with invisible circles at each point position (set `fill="transparent"` and a generous hit area `r="8"`). This gives us native DOM events (hover, click) without the Canvas hit-testing complexity.

```tsx
export function ScatterPlot({
  points,
  width = 800,
  height = 600,
  onPointClick,
  renderTooltip,
}: ScatterPlotProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [hoveredPoint, setHoveredPoint] = useState<ScatterPlotPoint | null>(null);

  // Draw on Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.scale, transform.scale);

    // Draw points
    for (const point of points) {
      const px = point.x * width;
      const py = point.y * height;
      ctx.beginPath();
      ctx.arc(px, py, (point.radius ?? 3) * (point.highlighted ? 2 : 1), 0, Math.PI * 2);
      ctx.fillStyle = point.color;
      ctx.globalAlpha = point.highlighted ? 1 : 0.6;
      ctx.fill();

      if (point.highlighted) {
        ctx.strokeStyle = "#22d3ee"; // cyan ring
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    ctx.restore();
  }, [points, transform, width, height]);

  // Zoom/pan handlers
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const scaleBy = e.deltaY > 0 ? 0.9 : 1.1;
    setTransform(t => ({
      ...t,
      scale: Math.max(0.5, Math.min(10, t.scale * scaleBy)),
    }));
  };

  const [isDragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // ... pan logic on mouse events

  return (
    <div class="relative" style={{ width, height }}>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        class="absolute inset-0 cursor-grab active:cursor-grabbing"
        onWheel={handleWheel}
        // ... mouse event handlers
      />
      {/* SVG overlay for hit testing */}
      <svg
        width={width}
        height={height}
        class="absolute inset-0 pointer-events-none"
      >
        {points.map(p => (
          <circle
            key={p.id}
            cx={p.x * width * transform.scale + transform.x}
            cy={p.y * height * transform.scale + transform.y}
            r={8}
            fill="transparent"
            class="pointer-events-auto cursor-pointer"
            onMouseEnter={() => setHoveredPoint(p)}
            onMouseLeave={() => setHoveredPoint(null)}
            onClick={() => onPointClick?.(p.id)}
          />
        ))}
      </svg>

      {/* Tooltip */}
      {hoveredPoint && renderTooltip && (
        <div
          class="absolute bg-slate-800 border border-slate-600 rounded-lg p-3 shadow-xl text-sm z-10 pointer-events-none"
          style={{
            left: hoveredPoint.x * width * transform.scale + transform.x + 12,
            top: hoveredPoint.y * height * transform.scale + transform.y - 12,
          }}
        >
          {renderTooltip(hoveredPoint)}
        </div>
      )}
    </div>
  );
}
```

### Color Modes

```typescript
type ColorMode = "language" | "file" | "cluster";

function getColorByMode(point: DisplayPoint, mode: ColorMode, clusterColors: Map<number, string>): string {
  switch (mode) {
    case "language":
      return langColor(point.language);
    case "file": {
      const dir = point.filePath.split("/")[0] ?? "root";
      return FILE_COLORS[dir % FILE_COLORS.length] ?? "#888";
    }
    case "cluster":
      return clusterColors.get(point.clusterId ?? 0) ?? "#888";
  }
}
```

### Wire into File Tree

Clicking a point should navigate to the file's chunks. The tooltip shows:
- File path
- Line range
- Language
- First 80 chars of description

---

## Step 5.3: Client-Side Clustering + Outliers (Day 3 PM)

### `src/web/ui/src/lib/kmeans.ts`

```typescript
interface Point2D { x: number; y: number; }

export function kmeans(points: Point2D[], k: number = 8, maxIter: number = 20): number[] {
  // Random initialization (k-means++)
  const n = points.length;
  const assignments = new Array(n).fill(0);
  const centroids: Point2D[] = [];

  // Pick first centroid randomly
  centroids.push(points[Math.floor(Math.random() * n)]!);

  // Pick remaining centroids with probability proportional to distance²
  for (let c = 1; c < k; c++) {
    const dists = points.map(p =>
      Math.min(...centroids.map(cent => dist(p, cent)))
    );
    const totalDist = dists.reduce((s, d) => s + d * d, 0);
    let r = Math.random() * totalDist;
    for (let i = 0; i < n; i++) {
      r -= dists[i]! * dists[i]!;
      if (r <= 0) { centroids.push(points[i]!); break; }
    }
  }

  // Iterate
  for (let iter = 0; iter < maxIter; iter++) {
    // Assign each point to nearest centroid
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDist = dist(points[i]!, centroids[0]!);
      for (let c = 1; c < centroids.length; c++) {
        const d = dist(points[i]!, centroids[c]!);
        if (d < bestDist) { bestDist = d; best = c; }
      }
      assignments[i] = best;
    }

    // Update centroids
    const sums = centroids.map(() => ({ x: 0, y: 0, count: 0 }));
    for (let i = 0; i < n; i++) {
      const c = assignments[i]!;
      sums[c]!.x += points[i]!.x;
      sums[c]!.y += points[i]!.y;
      sums[c]!.count++;
    }
    centroids.forEach((cent, i) => {
      if (sums[i]!.count > 0) {
        cent.x = sums[i]!.x / sums[i]!.count;
        cent.y = sums[i]!.y / sums[i]!.count;
      }
    });
  }

  return assignments;
}

function dist(a: Point2D, b: Point2D): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}


// Outlier detection: points > 2σ from nearest cluster centroid
export function findOutliers(
  points: Point2D[],
  assignments: number[],
  centroids: Point2D[]
): Set<number> {
  const stds = centroids.map(cent => {
    const clusterPoints = points.filter((_, i) => assignments[i] === centroids.indexOf(cent));
    const dists = clusterPoints.map(p => dist(p, cent));
    const mean = dists.reduce((s, d) => s + d, 0) / dists.length;
    const variance = dists.reduce((s, d) => s + (d - mean) ** 2, 0) / dists.length;
    return Math.sqrt(variance);
  });

  const outliers = new Set<number>();
  for (let i = 0; i < points.length; i++) {
    const c = assignments[i]!;
    const d = dist(points[i]!, centroids[c]!);
    if (d > 2 * stds[c]!) outliers.add(i);
  }
  return outliers;
}
```

### `views/Embeddings.tsx` — Cluster labels

For each cluster, compute a label from the top-3 most frequent file path prefixes among its members. Display these as a legend overlay on the scatter plot.

---

## Step 5.4: Search Overlay (Day 4)

When the user has run a semantic search (from the Search view, Phase 2), the result chunk IDs are available via the `searchResults` signal. The Embeddings view can overlay these results:

```tsx
export function Embeddings() {
  const [points, setPoints] = useState<DisplayPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [colorMode, setColorMode] = useState<ColorMode>("language");
  const searchResults = useSignal(searchResults);  // from Phase 2's store

  useEffect(() => {
    API.embeddingProj(5000).then(res => {
      // Map raw points to display points with colors
      const searchIds = new Set(searchResults.value.map(r => r.chunk.id));
      const display = res.body.points.map(p => ({
        ...p,
        color: getColorByMode(p, colorMode, clusterColors),
        highlighted: searchIds.has(p.id),
        radius: searchIds.has(p.id) ? 6 : 3,
      }));
      setPoints(display);
      setLoading(false);
    });
  }, [colorMode]);

  // ... rest of rendering
}
```

### UI Controls

| Control | Position | Action |
|---|---|---|
| Color mode dropdown | Top-left | Switch between Language, File, Cluster |
| Cluster toggle | Top-left | Enable/disable k-means overlay |
| Search overlay toggle | Top-left | Show/hide search result highlights |
| Zoom reset button | Bottom-right | Reset transform to default |
| Outlier toggle | Top-left | Highlight outlier points |

### Nav entry

Add "Embeddings" to the nav bar (between "Search" and "Files"):

```tsx
<button class="nav-btn" onClick={() => navigate("embeddings")}>
  🌐 Embeddings
</button>
```

Router: `#/embeddings?mode=language` or `#/embeddings?overlay=search`.

---

## Verification

| # | Test | Expected |
|---|---|---|
| 1 | Navigate to Embeddings view | Loading skeleton, then scatter plot appears |
| 2 | Index has < 5000 chunks | All points rendered |
| 3 | Index has > 5000 chunks | Subsampled to 5000 with note |
| 4 | Single chunk | Point centered at (0.5, 0.5) |
| 5 | No chunks | Empty state message |
| 6 | Hover over a point | Tooltip with file path, lines, language, description |
| 7 | Click a point | Navigates to chunk detail |
| 8 | Mouse wheel scroll | Zoom in/out centered on cursor |
| 9 | Mouse drag | Pan the view |
| 10 | Toggle color mode to "file" | Points re-color by directory |
| 11 | Toggle color mode to "cluster" | Points re-color by k-means assignment |
| 12 | Enable cluster labels | Cluster centroid labels appear |
| 13 | Enable outliers | Outlier points get pulsing animation |
| 14 | Run a search in Search view, then switch to Embeddings | Search result points are larger, cyan-ringed |
| 15 | Toggle search overlay off | Search highlights removed |
| 16 | Zoom reset button | View resets to default scale/position |
