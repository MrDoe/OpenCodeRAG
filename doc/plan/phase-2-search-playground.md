# Phase 2: Semantic Search Playground

**Duration:** 4 days  |  **Priority:** Highest user impact

> **The problem:** The UI's global search only calls `keywordIndex.search()` — TF-IDF keyword search. It never uses the `retrieve()` function that powers OpenCodeRAG's core value: vector + hybrid semantic code search. Users have no way to test retrieval quality, tune parameters, or understand *why* chunks were returned.

> **The vision:** A dedicated Search view that exposes the full `retrieve()` pipeline interactively — with real-time parameter tuning, score breakdown visualization, matched terms highlighting, and A/B comparison.

---

## Step 2.1: Backend — Lazy Embedder + `/api/retrieve` Endpoint (Day 1)

### Files to modify: `src/web/server.ts`, `src/web/api.ts`

#### Lazy embedder initialization in `server.ts`

The web server currently creates a `stubEmbedder` (no-op) for quirk memory. For semantic search, we need a real `EmbeddingProvider`.

```typescript
import { createEmbedder } from "../embedder/factory.js";

// In startWebUi(), add to existing params / return value
let embedderPromise: Promise<EmbeddingProvider> | null = null;

async function getEmbedder(cfg: RagConfig): Promise<EmbeddingProvider> {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      return createEmbedder(cfg.embedding);
    })();
  }
  return embedderPromise;
}
```

Pass `getEmbedder` (a lazy getter function, not the embedder itself) to `createApiHandler`:

```typescript
const apiHandler = createApiHandler(
  store, keywordIndex, storePath, cwd, cfg,
  () => getEmbedder(cfg)  // lazy getter
);
```

#### New `/api/retrieve` endpoint in `api.ts`

```typescript
interface RetrieveApiParams {
  q: string;
  topK?: number;       // default 10
  minScore?: number;   // default 0.35
  keywordWeight?: number; // default 0.4
  hybrid?: string;     // "true" | "false"
  explain?: string;    // "true" | "false"
  path?: string;       // path filter (comma-separated)
  lang?: string;       // language filter (comma-separated)
}
```

**Handler logic:**

```typescript
async function handleRetrieve(
  store: LanceDbStore,
  keywordIndex: KeywordIndex,
  getEmbedder: () => Promise<EmbeddingProvider>,
  cfg: RagConfig,
  params: URLSearchParams,
  method: string
): Promise<ApiResponse> {
  const q = params.get("q") ?? "";
  if (!q.trim()) {
    return { status: 400, body: { error: "Missing 'q' query parameter" } };
  }

  let embedder: EmbeddingProvider;
  try {
    embedder = await getEmbedder();
  } catch (err) {
    return { status: 503, body: { error: `Embedding model unavailable: ${(err as Error).message}. Check that your embedding provider (e.g., Ollama) is running.` } };
  }

  const topK = parseInt(params.get("topK") ?? "10", 10);
  const minScore = parseFloat(params.get("minScore") ?? "0.35");
  const keywordWeight = parseFloat(params.get("keywordWeight") ?? "0.4");
  const hybrid = params.get("hybrid") !== "false";
  const explain = params.get("explain") !== "false";

  // Parse path/language filters
  const pathPatterns = params.get("path")?.split(",").filter(Boolean) ?? undefined;
  const languages = params.get("lang")?.split(",").filter(Boolean) ?? undefined;

  const results = await retrieve(q, embedder, store, {
    topK,
    minScore,
    keywordIndex,
    keywordWeight,
    hybridEnabled: hybrid,
    queryPrefix: cfg.embedding.queryPrefix,
    explain,
    filter: { pathPatterns, languages },
  } satisfies RetrieveOptions);

  return {
    status: 200,
    body: {
      query: q,
      params: { topK, minScore, keywordWeight, hybrid, queryPrefix: cfg.embedding.queryPrefix },
      results: results.map(r => ({
        chunk: {
          id: r.chunk.id,
          filePath: r.chunk.metadata.filePath,
          startLine: r.chunk.metadata.startLine,
          endLine: r.chunk.metadata.endLine,
          language: r.chunk.metadata.language,
          content: r.chunk.content,
          description: r.chunk.description,
        },
        score: Math.round(r.score * 1000) / 1000,
        explanation: r.explanation ? {
          scoreBreakdown: {
            vectorScore: r.explanation.scoreBreakdown.vectorScore,
            keywordScore: r.explanation.scoreBreakdown.keywordScore,
            rawVectorScore: r.explanation.scoreBreakdown.rawVectorScore,
            rawKeywordScore: r.explanation.scoreBreakdown.rawKeywordScore,
            keywordWeight: r.explanation.scoreBreakdown.keywordWeight,
            vectorRank: r.explanation.scoreBreakdown.vectorRank,
            keywordRank: r.explanation.scoreBreakdown.keywordRank,
          },
          matchedTerms: r.explanation.matchedTerms,
        } : undefined,
      })),
    },
  };
}
```

**Edge cases:**
- **Embedder not initialized (202):** If this is the very first call and the embedder is still initializing, return `{ status: 202, body: { message: "Initializing embedding model...", retryAfterMs: 2000 } }`. Frontend polls after the delay.
- **Embedder unavailable (503):** Return clear error message suggesting the user check their embedding provider.
- **Empty query (400):** `{ error: "Missing 'q' query parameter" }`
- **Empty results:** `{ results: [], query, params }` — frontend shows "No results" empty state.

**Add to route table** in `createApiHandler`:
```typescript
else if (path === "/api/retrieve" && (method === "GET" || method === "POST")) {
  response = await handleRetrieve(store, keywordIndex, getEmbedder, cfg!, params, method);
}
```

#### Embedder initialization UX

The embedder initialization can take 1-3 seconds (provider probe, model download check). The 202 response lets the frontend show a loading indicator and retry. **Important:** cache the embedder instance after first init (the `embedderPromise` singleton pattern handles this).

---

## Step 2.2: Search View — Frontend Components (Days 2-3)

### `src/web/ui/src/views/Search.tsx`

The main Search Playground page component.

**Layout:**
```
┌─────────────────────────────────────────────────────┐
│ [Search query input                      ] [Search] │
│ Options: [topK: 10] [minScore: 0.35] [kwWeight ...] │
│ Filters: [path...] [lang...] [hybrid ◉]             │
├────────────────────────────────────┬────────────────┤
│ Query History (20)                  │ Results (N)    │
│ ─────────────────                   │ ┌───────────── │
│ • how does auth work     [replay]   │ │ Score 0.92   │
│ • chunking logic         [replay]   │ │ [vec██████]░ │
│ • vector store           [replay]   │ │ [kwd░░░░██]░ │
│                                     │ │ auth.ts:12-34 │
│                                     │ │ ts badge      │
│                                     │ │ Description.. │
│                                     │ │ code snippet  │
│                                     │ └───────────── │
│                                     │ ┌───────────── │
│                                     │ │ Score 0.87   │
│                                     │ │ ...          │
└────────────────────────────────────┴────────────────┘
```

**State:**
```typescript
import { searchQuery, searchParams, searchResults, searchHistory, searchMode, isSearching } from "../state/store";
```

**Query input:** Large textarea (or input) with placeholder "Search your codebase semantically..." (e.g., "how does authentication work?"). The enter key triggers search. `Ctrl/Cmd+Enter` also works.

**Parameter panel** (collapsible via `<details>`):

| Control | Type | Signal binding |
|---|---|---|
| topK | `<input type="range" min="1" max="25" step="1">` | `searchParams.value.topK` |
| minScore | `<input type="range" min="0" max="1" step="0.05">` | `searchParams.value.minScore` |
| keywordWeight | `<input type="range" min="0" max="1" step="0.1">` | `searchParams.value.keywordWeight` |
| Hybrid mode | `<input type="checkbox">` | `searchParams.value.hybrid` |
| Path filter | `<input type="text" placeholder="src/auth/, src/api/">` | `searchParams.value.pathFilter` |
| Lang filter | `<input type="text" placeholder="typescript, python">` | `searchParams.value.langFilter` |

Each change triggers a debounced re-search (300ms) via the `useSearch()` hook.

### `src/web/ui/src/hooks/useSearch.ts`

```typescript
export function useSearch() {
  const [results, setResults] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(false);
  const debouncedParams = useDebounce(searchParams.value, 300);

  useEffect(() => {
    const q = searchQuery.value.trim();
    if (!q) return;

    const doSearch = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const res = await API.retrieve({
          q,
          ...debouncedParams,
          explain: true,
        });
        if (res.status === 202) {
          // Embedder initializing — poll
          setIsInitializing(true);
          setTimeout(doSearch, res.body.retryAfterMs ?? 2000);
          return;
        }
        setIsInitializing(false);
        setResults(res.body.results ?? []);
        // Add to history
        searchHistory.value = [
          { query: q, params: debouncedParams },
          ...searchHistory.value.slice(0, 19),
        ];
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setIsLoading(false);
      }
    };

    doSearch();
  }, [searchQuery.value, debouncedParams]);

  return { results, isLoading, isInitializing, error };
}
```

### Results rendering (Day 3)

Each result card renders:

```tsx
<div class="bg-slate-800 rounded-lg p-4 border border-slate-700 hover:border-brand-500 transition-colors">
  <div class="flex items-center justify-between mb-2">
    <span class="text-sm text-brand-400 font-mono">
      {filePath}:{startLine}-{endLine}
    </span>
    <span class="text-lg font-bold" style={{ color: scoreToColor(score) }}>
      {score.toFixed(2)}
    </span>
  </div>

  {/* Score breakdown bar */}
  {explanation && <ScoreBar explanation={explanation} />}

  {/* Matched terms */}
  {explanation?.matchedTerms?.length > 0 && (
    <div class="flex gap-1 flex-wrap mb-2">
      {explanation.matchedTerms.map(term => (
        <span class="text-xs bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded">{term}</span>
      ))}
    </div>
  )}

  {/* Description */}
  <p class="text-sm text-slate-400 mb-2">{escapeHtml(description)}</p>

  {/* Code snippet */}
  <pre class="text-xs overflow-x-auto max-h-32 rounded bg-slate-900/50 p-2">
    <code dangerouslySetInnerHTML={{ __html: highlightCode(content, language) }} />
  </pre>

  {/* Click to open in chunks view */}
  <button
    class="mt-2 text-xs text-brand-500 hover:text-brand-400 transition-colors"
    onClick={() => navigate(`#/chunks/${id}`)}
  >
    View full chunk →
  </button>
</div>
```

### `src/web/ui/src/components/ScoreBar.tsx`

```tsx
interface ScoreBarProps {
  explanation: {
    scoreBreakdown: {
      vectorScore: number;
      keywordScore: number;
      rawVectorScore: number;
      rawKeywordScore: number;
      keywordWeight: number;
      vectorRank?: number;
      keywordRank?: number;
    };
  };
}

export function ScoreBar({ explanation }: ScoreBarProps) {
  const { vectorScore, keywordScore, rawVectorScore, rawKeywordScore, keywordWeight, vectorRank, keywordRank } = explanation.scoreBreakdown;
  const total = Math.max(vectorScore + keywordScore, 0.001);

  return (
    <div class="mb-2">
      <div class="flex items-center gap-2 text-xs mb-1">
        <span class="text-cyan-400">Vector {((vectorScore / total) * 100).toFixed(0)}%</span>
        <span class="text-amber-400">Keyword {((keywordScore / total) * 100).toFixed(0)}%</span>
        <span class="text-slate-500 ml-auto">kw={keywordWeight.toFixed(1)}</span>
      </div>
      <div class="h-2 bg-slate-700 rounded-full overflow-hidden flex">
        <div
          class="h-full bg-cyan-500 transition-all duration-200"
          style={{ width: `${(vectorScore / total) * 100}%` }}
          title={`Vector score: ${vectorScore.toFixed(3)}\nRaw vector: ${rawVectorScore.toFixed(3)}${vectorRank !== undefined ? `\nVector rank: #${vectorRank + 1}` : ""}`}
        />
        <div
          class="h-full bg-amber-500 transition-all duration-200"
          style={{ width: `${(keywordScore / total) * 100}%` }}
          title={`Keyword score: ${keywordScore.toFixed(3)}\nRaw keyword: ${rawKeywordScore.toFixed(3)}${keywordRank !== undefined ? `\nKeyword rank: #${keywordRank + 1}` : ""}`}
        />
      </div>
    </div>
  );
}
```

---

## Step 2.3: Retrieval Explainability Features (Day 4)

### View Mode Toggle

Three buttons in the results header. Each mode calls `API.retrieve()` with different parameters:

| Mode | `hybrid` | `keywordWeight` | Behavior |
|---|---|---|---|
| Hybrid (default) | `true` | current value | Full RRF fusion — shows what `search_semantic` returns |
| Vector-only | `false` | 0 | Only vector search, no keyword influence |
| Keyword-only | `true` | 1 | Only keyword search, no vector influence |

### Rank Shift Indicators

When the user switches between modes, compute rank deltas:

```typescript
function computeRankDelta(prevResults: Result[], currResults: Result[]): Map<string, number> {
  const delta = new Map<string, number>();
  const prevRank = new Map(prevResults.map((r, i) => [r.chunk.id, i]));
  const currRank = new Map(currResults.map((r, i) => [r.chunk.id, i]));

  for (const [id, cr] of currRank) {
    const pr = prevRank.get(id);
    if (pr !== undefined) delta.set(id, pr - cr); // positive = moved up
  }
  return delta;
}
```

Each result card shows `↑N` (green, moved up) or `↓N` (red, moved down) badge.

### Matched Terms Highlighting

When `explanation.matchedTerms` is populated, highlight those tokens in the code snippet:

```typescript
function highlightMatchedTerms(code: string, terms: string[]): string {
  const escaped = escapeHtml(code);
  if (!terms.length) return hljs.highlight(escaped, { language: "plaintext" }).value;

  // Create regex from matched terms (case-insensitive, word boundaries)
  const pattern = new RegExp(`\\b(${terms.map(t => escapeRegex(t)).join("|")})\\b`, "gi");
  return escaped.replace(pattern, '<mark class="bg-amber-500/30 text-amber-200 rounded px-0.5">$1</mark>');
}
```

**Important:** Apply matching *after* highlight.js syntax highlighting so the `<mark>` tags don't break the highlighted HTML.

### Overlap Indicator

When comparing modes, show "X of Y results (Z%) also appear in hybrid mode":

```typescript
function overlapIndicator(modeResults: Result[], hybridIds: Set<string>): string {
  const overlap = modeResults.filter(r => hybridIds.has(r.chunk.id)).length;
  const pct = ((overlap / modeResults.length) * 100).toFixed(0);
  return `${overlap} of ${modeResults.length} (${pct}%) also appear in hybrid mode`;
}
```

---

## Step 2.4: Integration (Day 4 PM)

### Nav Entry

Add "Search" to the top nav bar (first position after Dashboard for prominence):

```tsx
<button class="nav-btn" onClick={() => navigate("search")}>
  🔍 Search
</button>
```

### Keyboard Shortcut

`Ctrl/Cmd+K` focuses the search query input from any view. If the search view is not active, switch to it first:

```typescript
// In useKeyboardShortcuts hook
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    navigate("search");
    // Focus query input — will be handled by Search component's autoFocus
  }
});
```

### Router Integration

Search parameters are encoded in the hash fragment:
```
#/search?query=auth+middleware&topK=15&minScore=0.5&hybrid=true
```

This means:
- Users can bookmark a specific search
- Browser back/forward works
- Sharing a URL reproduces the exact search state

**On mount**, the `Search` component reads `router.params` and initializes the signals accordingly:

```typescript
export function Search() {
  const router = useRouter();

  useEffect(() => {
    if (router.view === "search" && router.params.query) {
      searchQuery.value = router.params.query;
      searchParams.value = {
        topK: parseInt(router.params.topK ?? "10"),
        minScore: parseFloat(router.params.minScore ?? "0.35"),
        keywordWeight: parseFloat(router.params.keywordWeight ?? "0.4"),
        hybrid: router.params.hybrid !== "false",
        pathFilter: router.params.path ?? "",
        langFilter: router.params.lang ?? "",
      };
    }
  }, [router]);

  // ... render
}
```

---

## Verification

| # | Test | Expected |
|---|---|---|
| 1 | Navigate to Search view | Empty state with query input and default parameter values |
| 2 | Type a query and press Enter | Loading indicator appears, API called |
| 3 | First search with no embedder (Ollama down) | Error toast: "Embedding model unavailable: ..." |
| 4 | First search with embedder available | Results appear after embedder init (2-3s delay on first call, instant after) |
| 5 | Adjust topK slider from 1 to 25 | Results count changes, debounced re-search |
| 6 | Adjust keywordWeight from 0 to 1 | Score bars shift from cyan-heavy to amber-heavy |
| 7 | Toggle hybrid off | Results change (keyword-only weighting) |
| 8 | Add path filter "src/retriever/" | Results restricted to that path |
| 9 | Click result card | Navigates to Chunks view with selected chunk detail |
| 10 | Switch to Vector-only mode | Results show only vector contribution in bars |
| 11 | Switch to Keyword-only mode | Results show only keyword contribution, rank shift indicators |
| 12 | Matched terms present in explanation | Terms are `<mark>`-highlighted in code snippet |
| 13 | Re-run a query from history | Same results returned |
| 14 | Share URL with hash fragment | Reproduces exact search state on page load |
| 15 | `Ctrl/Cmd+K` from any view | Focuses search query input |
