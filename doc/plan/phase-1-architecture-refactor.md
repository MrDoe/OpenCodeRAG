# Phase 1: Preact + Vite Architecture Refactor

**Duration:** 6 days  |  **Priority:** Foundation  |  **Behavior:** Preserve all existing features

> **Goal:** Migrate the 1639-line SPA monolith (`index.html` with 1560 lines of inline JS) to a modular Preact component architecture with Vite build pipeline, hash routing, and reactive state — with **zero regressions**.

---

## Step 1.1: Build Infrastructure (Day 1)

### Files to create

#### `src/web/ui/vite.config.ts`

```typescript
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  root: "src/web/ui",
  base: "/ui/",
  build: {
    outDir: "../../dist/web/ui",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["preact"],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3210",
    },
  },
});
```

**Design notes:**
- `base: "/ui/"` — all built assets are served under `/ui/assets/...`. This keeps the `/api/` namespace clear and matches the existing `serveUiAsset()` routing in `server.ts`.
- The dev server proxies `/api/` to the running Node.js server (port 3210).
- Production build goes to `dist/web/ui/` (which is in the npm `"files"` whitelist via `"dist"`).

#### `src/web/ui/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["DOM", "DOM.Iterable", "ES2023"],
    "jsx": "react-jsx",
    "jsxImportSource": "preact",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "paths": {
      "@/*": ["./src/*"]
    },
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

#### `src/web/ui/postcss.config.js`

```javascript
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

#### `src/web/ui/index.html`

```html
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>OpenCodeRAG</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔎</text></svg>">
</head>
<body class="h-screen flex flex-col overflow-hidden bg-slate-900 text-slate-200">
  <div id="app"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

### Files to update

#### `package.json`

Add devDependencies:
```json
"@preact/preset-vite": "^2.9.0",
"preact": "^10.19.0",
"vite": "^5.4.0"
```

Update scripts:
```json
"build": "tsc -p tsconfig.build.json && vite build",
"build:ui": "vite build",
"dev:ui": "vite --config src/web/ui/vite.config.ts"
```

#### `src/web/ui/tailwind.config.js`

Update `content` array:
```javascript
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{tsx,ts,jsx,js}"],
  theme: {
    extend: {
      colors: {
        brand: { 400: "#22d3ee", 500: "#06b6d4", 600: "#0891b2" },
      },
    },
  },
  plugins: [],
};
```

#### `src/web/static.ts`

Update to read built HTML from `dist/web/ui/index.html` (production) and fall back to `index.html` from `src/web/ui/` (dev mode):

```typescript
import { existsSync } from "node:fs";

let cachedHtml: string | null = null;

export function getStaticHtml(): string {
  if (cachedHtml) return cachedHtml;

  const __dirname = dirname(fileURLToPath(import.meta.url));
  // Production build output
  const prodPath = join(__dirname, "../../dist/web/ui/index.html");
  // Dev mode fallback (Vite dev server)
  const devPath = join(__dirname, "ui/index.html");
  const targetPath = existsSync(prodPath) ? prodPath : devPath;
  cachedHtml = readFileSync(targetPath, "utf-8");
  return cachedHtml;
}
```

#### `src/web/server.ts`

Update the `serveUiAsset` and routing logic to serve built assets:

```typescript
if (url.startsWith("/ui/")) {
  const decoded = decodeURIComponent(url.slice("/ui/".length));
  if (decoded.includes("..") || decoded === "") {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }
  // Try production build output first
  const distDir = join(uiDir, "../../dist/web/ui");
  const distPath = join(distDir, decoded);
  if (distPath.startsWith(distDir + sep) && existsSync(distPath)) {
    serveDistAsset(res, distPath);
    return;
  }
  // Fall back to dev source
  const devPath = join(uiDir, decoded);
  if (devPath.startsWith(uiDir + sep) && existsSync(devPath)) {
    serveUiAsset(res, devPath);
    return;
  }
  res.writeHead(404);
  res.end("Not Found");
  return;
}
```

Also add proper content-type map for common JS/CSS extensions in `serveUiAsset`/`serveDistAsset`.

#### `src/web/api.ts`

Update the `createApiHandler` signature to accept an optional embedder `getter` for Phase 2:

```typescript
export function createApiHandler(
  store: LanceDbStore,
  keywordIndex: KeywordIndex,
  storePath: string,
  cwd?: string,
  cfg?: RagConfig,
  getEmbedder?: () => Promise<EmbeddingProvider>  // NEW — lazy embedder getter
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
```

---

## Step 1.2: Core Infrastructure Components (Day 2)

### `src/web/ui/src/state/store.ts` — Reactive global state

Uses `@preact/signals` (or a tiny custom signal implementation). Each signal is a `Signal<T>` with `.value` getter/setter.

```typescript
import { signal, computed } from "@preact/signals";

// Navigation
export const currentView = signal<string>("dashboard");
export const currentHash = signal<string>("");

// Chunks view
export const selectedFile = signal<string | null>(null);
export const selectedLang = signal<string | null>(null);
export const selectedChunkId = signal<string | null>(null);
export const chunkOffset = signal<number>(0);
export const chunkLimit = signal<number>(50);
export const selectedChunkIds = signal<Set<string>>(new Set());
export const collapsedDirs = signal<Set<string>>(new Set());

// Search
export const searchQuery = signal<string>("");
export const searchParams = signal({
  topK: 10,
  minScore: 0.35,
  keywordWeight: 0.4,
  hybrid: true,
  pathFilter: "",
  langFilter: "",
});
export const searchResults = signal<SearchResult[]>([]);
export const searchHistory = signal<{ query: string; params: typeof searchParams.value }[]>([]);
export const searchMode = signal<"hybrid" | "vector" | "keyword">("hybrid");
export const isSearching = signal<boolean>(false);

// Dashboard
export const stats = signal<Stats | null>(null);
export const files = signal<FileInfo[]>([]);

// Evaluate
export const evalSelectedSessions = signal<Set<string>>(new Set());
export const evalSessionDetail = signal<any>(null);

// Quirks
export const quirkTypeFilter = signal<string | null>(null);

// UI
export const theme = signal<"dark" | "light">("dark");
export const sidebarCollapsed = signal<boolean>(false);
export const toasts = signal<Toast[]>([]);

// Helper: navigate hash-based route
export function navigate(route: string) {
  window.location.hash = route;
}
```

### `src/web/ui/src/hooks/useRouter.ts`

```typescript
import { useEffect, useState } from "preact/hooks";

interface Route {
  view: string;
  params: Record<string, string>;
}

export function useRouter(): Route {
  const [route, setRoute] = useState<Route>(parseHash());

  useEffect(() => {
    const handler = () => setRoute(parseHash());
    addEventListener("hashchange", handler);
    return () => removeEventListener("hashchange", handler);
  }, []);

  return route;
}

function parseHash(): Route {
  const hash = location.hash.slice(1) || "dashboard";
  const [path, qs] = hash.split("?");
  const params: Record<string, string> = {};
  if (qs) {
    for (const part of qs.split("&")) {
      const [k, v] = part.split("=");
      params[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
    }
  }
  return { view: path.split("/")[0] || "dashboard", params };
}
```

### `src/web/ui/src/lib/api.ts` — API client

Each method is an `async` function that wraps `fetch()`, checks `r.ok`, and throws typed errors. Matches the current `const API = {...}` object's interface but with error handling.

```typescript
const BASE = "/api";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const r = await fetch(BASE + url, options);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new ApiError(r.status, body.error ?? r.statusText);
  }
  return r.json();
}

// Endpoints
export const API = {
  stats:         ()                                        => request<{ body: any }>("/stats"),
  files:         ()                                        => request<{ body: any }>("/files"),
  chunks:        (opts: ChunkOpts)                         => request<{ body: any }>(`/chunks?offset=${opts.offset}&limit=${opts.limit}&lang=${opts.lang}&file=${opts.file}`),
  chunk:         (id: string)                              => request<{ body: any }>(`/chunks/${encodeURIComponent(id)}`),
  search:        (q: string, topK = 10)                    => request<{ body: any }>(`/search?q=${encodeURIComponent(q)}&topK=${topK}`),
  compare:       (ids: string[])                           => request<{ body: any }>(`/compare?ids=${ids.join(",")}`),
  retrieve:      (params: RetrieveParams)                  => request<{ body: any }>(`/retrieve?${toQuery(params)}`),
  evalSessions:  ()                                        => request<{ body: any }>("/eval/sessions"),
  evalSession:   (id: string)                              => request<{ body: any }>(`/eval/sessions/${encodeURIComponent(id)}`),
  evalDelete:    (id: string)                              => request<{ body: any }>(`/eval/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  evalCompare:   (a: string, b: string)                    => request<{ body: any }>(`/eval/compare?a=${a}&b=${b}`),
  evalTokenComp: (a: string, b: string)                    => request<{ body: any }>(`/eval/token-compare?a=${a}&b=${b}`),
  evalAnalysis:  (id: string)                              => request<{ body: any }>(`/eval/sessions/${encodeURIComponent(id)}/analysis`),
  evalProject:   (params: any)                             => request<{ body: any }>("/eval/project-savings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) }),
  quirks:        ()                                        => request<{ body: any }>("/quirks"),
  quirkLint:     ()                                        => request<{ body: any }>("/quirks/lint"),
  deleteQuirk:   (id: string)                              => request<{ body: any }>(`/quirks/${encodeURIComponent(id)}`, { method: "DELETE" }),
  indexStatus:   ()                                        => request<{ body: IndexStatus }>("/indexing/status"),
  triggerReindex:()                                        => request<{ body: any }>("/indexing/reindex", { method: "POST" }),
  config:        ()                                        => request<{ body: any }>("/config"),
  embeddingProj: (max?: number)                            => request<{ body: ProjectionData[] }>(`/embeddings/projection?maxChunks=${max ?? 5000}`),
};
```

### Additional infrastructure files

| File | Contents |
|---|---|
| `src/web/ui/src/hooks/useDebounce.ts` | `useDebounce(value, delay)` — returns debounced value |
| `src/web/ui/src/hooks/useTheme.ts` | Reads `localStorage("theme")`, toggles `dark` class on `<html>`, returns `{ theme, toggle }` |
| `src/web/ui/src/lib/escape.ts` | `escapeHtml`, `escapeAttr` — quote-safe |
| `src/web/ui/src/lib/format.ts` | `formatTokens`, `formatCost`, `formatMs`, `formatTimestamp`, `deltaStr`, `truncate`, `debounce` |
| `src/web/ui/src/lib/langColors.ts` | Language → hex color map (13 languages, extracted from inline) |
| `src/web/ui/src/components/Toast.tsx` | Toast notification system with auto-dismiss, stacking, success/error/info variants |
| `src/web/ui/src/components/ViewSkeleton.tsx` | Animated shimmer loading skeleton |

---

## Step 1.3: View Migration — Dashboard, Files, Chunks (Days 3-4)

### Migration strategy

Each view follows the same pattern:

1. Create `views/<Name>.tsx` — a Preact functional component
2. Use `useRouter()` to determine if this view is active
3. Use the `API` client (via `useApi` hook) for data fetching
4. Use `components/*.tsx` for reusable UI elements
5. Subscribe to relevant signals from `state/store.ts`
6. Navigation via `navigate()` from store

### `src/web/ui/src/App.tsx` — Application shell

```typescript
import { useRouter } from "./hooks/useRouter";
import { useTheme } from "./hooks/useTheme";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { sidebarCollapsed, theme } from "./state/store";

export function App() {
  const route = useRouter();
  const { toggle: toggleTheme } = useTheme();
  useKeyboardShortcuts();

  return (
    <div class="h-screen flex flex-col overflow-hidden bg-slate-900 text-slate-200">
      <Header onThemeToggle={toggleTheme} />
      <div class="flex flex-1 overflow-hidden">
        {!sidebarCollapsed.value && <Sidebar />}
        <main class="flex-1 overflow-y-auto p-6">
          {route.view === "dashboard" && <Dashboard />}
          {route.view === "chunks" && <Chunks />}
          {route.view === "search" && <Search />}
          {route.view === "files" && <Files />}
          {route.view === "evaluate" && <Evaluate />}
          {route.view === "quirks" && <Quirks />}
          {route.view === "compare" && <Compare />}
          {route.view === "embeddings" && <Embeddings />}
          {route.view === "config" && <Config />}
        </main>
      </div>
      <ToastContainer />
    </div>
  );
}
```

### Views to migrate (clean-room rewrite using Preact)

#### Dashboard (`views/Dashboard.tsx`)

**Source lines:** 381-417

**Components:**
- 4 `<KpiCard>` components (chunks, files, languages, avg chunks/file)
- `<BarChart>` for language distribution (top 8 languages)
- Index status card (stub — full implementation in Phase 4)
- Embedding model health card (stub)

```typescript
export function Dashboard() {
  const [stats] = useApi(() => API.stats());
  const [files] = useApi(() => API.files());

  const totalChunks = stats?.body?.totalChunks ?? 0;
  const totalFiles = files?.length ?? 0;
  const languages = stats?.body?.languages?.length ?? 0;
  const avgChunks = totalFiles > 0 ? (totalChunks / totalFiles).toFixed(1) : "0";

  return (
    <div>
      <h1 class="text-2xl font-bold mb-6">Dashboard</h1>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <KpiCard label="Total Chunks" value={totalChunks.toLocaleString()} icon="🧩" />
        <KpiCard label="Total Files" value={totalFiles.toLocaleString()} icon="📄" />
        <KpiCard label="Languages" value={languages} icon="🔤" />
        <KpiCard label="Avg Chunks/File" value={avgChunks} icon="📊" />
      </div>
      <BarChart
        title="Language Distribution"
        data={stats?.body?.languages ?? []}
        valueKey="count"
        labelKey="language"
        colorFn={langColor}
      />
    </div>
  );
}
```

#### Files (`views/Files.tsx`)

**Source lines:** 647-715

**Components:** `<DataTable>`, row click → `navigate("#/chunks?file=" + file)`.

**Columns:** File path, language badge, chunk count, "View chunks" action link.

#### Chunks (`views/Chunks.tsx`) — Master-detail split

**Source lines:** 419-565

**Master pane (left 50%):**
- `<DataTable>` with paginated chunk list
- Filter badges (file, language) — dismissible
- Checkbox column (`selectedChunkIds` signal) — added for Phase 3 Compare support
- Page navigation buttons

**Detail pane (right 50%):**
- File path, line range, language badge, chunk ID
- Description card (rendered markdown-light)
- **Image Preview** panel (for image chunks — `/api/file?path=...`)
- Source code panel with `<CopyButton>` and `<SyntaxHighlighter>` (uses highlight.js)
- For image chunks: panel header changes to "Vision Analysis"

**Hook used:**
```typescript
function useChunks(offset: number, limit: number, lang: string | null, file: string | null) {
  return useApi(() => API.chunks({ offset, limit, lang: lang ?? "", file: file ?? "" }), [offset, lang, file]);
}
```

#### File tree sidebar (`components/FileTree.tsx`)

**Source lines:** 567-645

Recursive component. Filter input at top with `useDebounce(300)`. Directory entries use `collapsedDirs` signal for expanded/collapsed state. File entries show language color dot. Clicking a file navigates to `#/chunks?file=...`.

#### Global search (`components/GlobalSearch.tsx`)

**Source lines:** 751-797

Search input in the header with `useDebounce(300)`. Calls `API.search(q, 10)`. Results dropdown with file path, line range, language badge, description snippet. Click → fetch chunk via `API.chunk(id)` → `navigate("#/chunks")` with selected chunk. Click-outside-to-close.

---

## Step 1.4: Evaluate View Migration (Day 5)

**Source lines:** 857-1510

This is the most feature-dense view. Split into sub-components:

### `views/Evaluate.tsx` — Main evaluate view
- Session list table with 11 columns + checkboxes
- "Select All" / "Clear" controls
- "Compare Selected" button (active when 2 sessions selected)
- Trash icon for delete (with confirmation)
- "What-If Projection" panel (5 sliders, live KPI tiles, debounced 200ms API calls)

**Sub-components:**
| Component | File | Responsibility |
|---|---|---|
| `views/eval/SessionList.tsx` | Session table, checkbox selection, delete | |
| `views/eval/WhatIfProjection.tsx` | 5 sliders (chunk size, chunks/query, reads w/o RAG, reads w/ RAG, query count), live KPI tiles | |
| `views/eval/SessionDetail.tsx` | KPI cards (total tokens, input, output, cost, RAG context), donut chart, metrics row, models-used badges | |
| `views/eval/TokenAnalysis.tsx` | Savings projection (3 KPI cards), 4-totals grid, per-query breakdown table with cyan border for RAG queries | |
| `views/eval/EventTimeline.tsx` | Chronological event log with 6 event type renderers | |
| `views/eval/SessionComparison.tsx` | Verdict banner (green/red), stacked bar chart, 12-row delta table with % change, RAG-on/off savings KPI pair | |

### `charts/DonutChart.tsx` — Token composition donut

**Source lines:** 342-379

Props: `{ data: { label: string; value: number; color: string }[]; size?: number; innerRadius?: number }`
Renders SVG donut with arc path math (handles 359.99° full-circle edge case).

### `charts/BarChart.tsx` — Comparison bars

**Source lines:** 253-340

Props: `{ groups: { label: string; bars: { label: string; value: number; color: string }[] }[] }`
Renders grouped SVG bar chart.

---

## Step 1.5: Quirks + App Shell + Init (Day 6 AM)

### `views/Quirks.tsx`

**Source lines:** 1532-1625

**Components:**
- Type filter pill buttons (All + dynamic types derived from data)
- Card grid (1 col → 2 cols at `lg`)
- Each card: type badge (color-coded), confidence % bar (color-coded: green > 0.7, amber > 0.4, red below), tags as `#tag` chips, sourceRef link, ID, delete button with confirmation dialog
- Lint button → collapsible lint results area (success card / issue list / error card)
- Empty state with 💡

### `main.tsx`

```typescript
import { render } from "preact";
import { App } from "./App";
import "./app.css";  // Vite processes this via PostCSS/Tailwind

render(<App />, document.getElementById("app")!);
```

---

## Step 1.6: Parity Verification (Day 6 PM)

Run through every feature of the old UI and verify identical behavior in the new Preact UI:

| View | Feature | Verify |
|---|---|---|
| Dashboard | 4 KPI cards render with correct values | All numeric values match |
| Dashboard | Language distribution bar chart | Top 8 languages, correct counts, percentage labels |
| Chunks | Paginated table renders | Page size 50, Previous/Next works |
| Chunks | Filter badges | Dismissible lang/file badges, re-filter on badge click |
| Chunks | Row selection | Click to select, detail pane updates |
| Chunks | Detail pane — description | Renders correctly |
| Chunks | Detail pane — source code | Syntax highlighted, scrollable |
| Chunks | Detail pane — Copy button | "Copied!" feedback on click |
| Chunks | Image chunks | Image loads from `/api/file?path=`, "Vision Analysis" header |
| Chunks | Empty state | "No chunks found" with 🔍 when no data |
| Files | Table renders | All files listed with lang badge and chunk count |
| Files | Row click → Chunks view | Navigates to Chunks filtered by that file |
| File tree | Directory collapse/expand | State persists across view switches |
| File tree | Filter input | Narrow by path substring |
| File tree | File click → Chunks | Navigates to Chunks filtered by that file |
| Global search | Debounced input | Fires after 300ms idle |
| Global search | Results dropdown | Shows file, lines, lang, description |
| Global search | Click result → chunk detail | Navigates to chunk detail |
| Evaluate | Session list table | 11 columns, sortable by any column, paginated |
| Evaluate | Session checkboxes | Select All / Clear, compare button enables at 2 selected |
| Evaluate | Session delete | Confirmation dialog, row removed |
| Evaluate | What-If sliders | 5 sliders, live KPI updates, debounced 200ms API |
| Evaluate | Session detail | 5 KPI cards, donut chart, metrics row, models badges |
| Evaluate | Token analysis | Savings projection, per-query table with RAG highlights |
| Evaluate | Event timeline | Chronological, 6 event types rendered correctly |
| Evaluate | Session comparison | Verdict banner, bar chart, delta table |
| Quirks | Card grid | All quirks render with type badge, confidence, tags, id |
| Quirks | Type filter pills | Filter works and updates card list |
| Quirks | Lint button | Results render (success/error/issues) |
| Quirks | Delete | Confirmation dialog, row removed |
| Theme | Dark mode | All surfaces `bg-slate-900`, text `slate-200` |
| Theme | Light mode (if toggle active) | `bg-white`, text `slate-900` |

## Migration Safety Net

During each day of migration, the old `index.html` remains functional via `static.ts`'s fallback path. Rollback is instant — just re-add the old file's path to the fallback list.

**Risk:** The most complex view (Evaluate, ~650 lines of inline JS) is the riskiest migration. Mitigation: split it into the 6 sub-components listed above and test each one individually with Storybook-style rendering (render the component with mock data and verify output).
