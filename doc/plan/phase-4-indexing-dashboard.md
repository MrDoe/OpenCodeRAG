# Phase 4: Indexing & Health Dashboard

**Duration:** 3 days  |  **Priority:** High (operational visibility)

> **The problem:** Users have zero visibility into the indexing pipeline. They can't see when the index is stale, whether the watcher is running, or if the embedding model is responsive. The RAG index is a black box — there's no way to tell if it's healthy, up-to-date, or even initialized.

> **The vision:** Expand the Dashboard with real-time indexing status, staleness detection, embedding model health, a reindex trigger, and a configuration inspector. Give users operational confidence in their RAG index.

---

## Step 4.1: Backend — Indexing Status Endpoint (Day 1)

### File: `src/web/api.ts`

#### `/api/indexing/status` — `GET`

Returns the current state of the indexed corpus and health of the embedding backend.

```typescript
interface IndexStatus {
  manifest: {
    version: string;
    totalChunks: number;
    totalFiles: number;
    schemaVersion: number;
    lastCommit: string | null;
    lastIndexedAt: string | null;
  };
  staleFileCount: number;       // files modified since last index
  orphanedChunkCount: number;   // chunks whose files no longer exist
  watcherActive: boolean;       // is chokidar watcher running?
  embeddingModel: {
    provider: string;
    model: string;
    vectorDimension: number;
    available: boolean;         // can we reach the endpoint?
    latencyMs: number | null;   // probe latency in ms
    error: string | null;       // error message if unavailable
  };
}
```

**Handler logic:**

```typescript
async function handleIndexingStatus(
  storePath: string,
  cfg: RagConfig,
  cwd?: string
): Promise<ApiResponse> {
  const manifestPath = join(storePath, "manifest.json");
  let manifest: Manifest | null = null;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch { /* no manifest — index not yet created */ }

  // Count stale files (modified since last index)
  let staleFileCount = 0;
  if (manifest && cwd) {
    try {
      const storedFiles = await getIndexedFiles(storePath); // reads keyword-index.json
      for (const file of storedFiles) {
        const fullPath = join(cwd, file.filePath);
        try {
          const stat = statSync(fullPath);
          if (stat.mtimeMs > manifest.timestamp) staleFileCount++;
        } catch {
          // File was deleted — count as stale
          staleFileCount++;
        }
      }
    } catch { /* ignore */ }
  }

  // Embedding model probe
  let modelAvailable = false;
  let modelLatency: number | null = null;
  let modelError: string | null = null;
  try {
    const embedder = createEmbedder(cfg.embedding);
    const start = performance.now();
    await embedder.embed(["probe: test"], "query");
    modelLatency = Math.round(performance.now() - start);
    modelAvailable = true;
  } catch (err) {
    modelError = (err as Error).message;
  }

  return {
    status: 200,
    body: {
      manifest: manifest ? {
        version: manifest.version,
        totalChunks: manifest.totalChunks ?? 0,
        totalFiles: manifest.totalFiles ?? 0,
        schemaVersion: manifest.schemaVersion,
        lastCommit: manifest.lastCommit ?? null,
        lastIndexedAt: manifest.timestamp
          ? new Date(manifest.timestamp).toISOString()
          : null,
      } : null,
      staleFileCount,
      orphanedChunkCount: 0,  // future: compute from LanceDB
      watcherActive: false,   // future: UI server can poll watcher status
      embeddingModel: {
        provider: cfg.embedding.provider,
        model: cfg.embedding.model,
        vectorDimension: cfg.embedding.vectorDimension ?? 0,
        available: modelAvailable,
        latencyMs: modelLatency,
        error: modelError,
      },
    },
  };
}
```

#### `/api/indexing/reindex` — `POST`

Trigger a one-shot reindex pass.

```typescript
async function handleReindex(
  cwd: string,
  cfg: RagConfig,
  storePath: string
): Promise<ApiResponse> {
  try {
    // Run reindex in background — don't block the response
    runIndexPass({
      cwd,
      storePath,
      config: cfg,
      onProgress: (current, total) => {
        // Optionally write progress to a status file that /api/indexing/status reads
      },
    }).catch(err => {
      console.error("Background reindex failed:", err);
    });

    return { status: 200, body: { started: true } };
  } catch (err) {
    return { status: 500, body: { error: `Failed to start reindex: ${(err as Error).message}` } };
  }
}
```

**Design note:** The UI server needs access to `runIndexPass()` from `src/indexer.ts`. This function takes a `RunIndexOptions` object with `cwd`, `storePath`, `config`, and optional callbacks. The current signature is:

```typescript
export async function runIndexPass(options: {
  cwd: string;
  storePath: string;
  config: RagConfig;
  signal?: AbortSignal;
  onProgress?: (processed: number, total: number) => void;
}): Promise<IndexResult>;
```

**Important:** The UI server must not conflict with a concurrently-running plugin indexing pass. Use a lock file (`${storePath}/.indexing.lock`) to prevent concurrent writes.

#### `/api/config` — `GET`

Return the effective configuration (read-only).

```typescript
async function handleConfig(cfg: RagConfig): Promise<ApiResponse> {
  // Deep-clone and redact API keys
  const safe = JSON.parse(JSON.stringify(cfg));
  redactKeys(safe);

  return {
    status: 200,
    body: { config: safe },
  };
}

function redactKeys(obj: any): void {
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase().includes("apikey") || key === "apiKey") {
      obj[key] = "***";
    } else if (typeof obj[key] === "object" && obj[key] !== null) {
      redactKeys(obj[key]);
    }
  }
}
```

---

## Step 4.2: Dashboard Expansion — Frontend (Days 2-3)

### `views/Dashboard.tsx` — Expanded with status cards

Add new sections below the existing KPI cards and language distribution chart:

```tsx
export function Dashboard() {
  const [stats] = useApi(() => API.stats());
  const [files] = useApi(() => API.files());
  const [indexStatus, refreshStatus] = useApi(() => API.indexStatus());

  return (
    <div>
      <h1 class="text-2xl font-bold mb-6">Dashboard</h1>

      {/* KPI cards (existing) */}
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <KpiCard label="Total Chunks" value={...} />
        <KpiCard label="Total Files" value={...} />
        <KpiCard label="Languages" value={...} />
        <KpiCard label="Avg Chunks/File" value={...} />
      </div>

      {/* Language distribution chart (existing) */}
      <BarChart title="Language Distribution" data={...} />

      {/* NEW — Index Status Card */}
      <IndexStatusCard status={indexStatus?.body} onRefresh={refreshStatus} onReindex={triggerReindex} />

      {/* NEW — Embedding Model Health Card */}
      <EmbeddingHealthCard status={indexStatus?.body} />
    </div>
  );
}
```

### `components/IndexStatusCard.tsx`

```tsx
interface IndexStatusCardProps {
  status: IndexStatus | null;
  onRefresh: () => void;
  onReindex: () => void;
}

export function IndexStatusCard({ status, onRefresh, onReindex }: IndexStatusCardProps) {
  const [isReindexing, setIsReindexing] = useState(false);
  const [reindexProgress, setReindexProgress] = useState<string | null>(null);

  const handleReindex = async () => {
    setIsReindexing(true);
    setReindexProgress("Starting reindex...");
    try {
      await API.triggerReindex();
      // Poll for completion
      const poll = setInterval(async () => {
        const s = await API.indexStatus();
        if (s.body?.manifest?.lastIndexedAt !== status?.manifest?.lastIndexedAt) {
          clearInterval(poll);
          setIsReindexing(false);
          setReindexProgress(null);
          onRefresh();
          toast.success("Reindex complete!");
        }
      }, 2000);
    } catch (err) {
      setIsReindexing(false);
      setReindexProgress(null);
      toast.error(`Reindex failed: ${(err as Error).message}`);
    }
  };

  const lastIndexed = status?.manifest?.lastIndexedAt
    ? formatRelativeTime(status.manifest.lastIndexedAt)
    : "Never";

  const staleness = status?.staleFileCount ?? 0;
  const stalenessColor = staleness === 0 ? "green-500"
    : staleness < 50 ? "amber-500"
    : "red-500";

  return (
    <div class="bg-slate-800 rounded-lg p-4 border border-slate-700 mb-6">
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-lg font-semibold">Index Status</h2>
        <div class="flex gap-2">
          <button onClick={onRefresh} class="text-sm text-slate-400 hover:text-white transition-colors">
            ↻ Refresh
          </button>
        </div>
      </div>

      {!status ? (
        <div class="text-sm text-slate-400">No index found. Run `opencode-rag index` first.</div>
      ) : (
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <span class="text-xs text-slate-500 block">Last Indexed</span>
            <span class="text-sm font-mono">{lastIndexed}</span>
          </div>
          <div>
            <span class="text-xs text-slate-500 block">Total Chunks</span>
            <span class="text-sm font-mono">{status.manifest.totalChunks.toLocaleString()}</span>
          </div>
          <div>
            <span class="text-xs text-slate-500 block">Total Files</span>
            <span class="text-sm font-mono">{status.manifest.totalFiles.toLocaleString()}</span>
          </div>
          <div>
            <span class="text-xs text-slate-500 block">Schema Version</span>
            <span class="text-sm font-mono">{status.manifest.schemaVersion}</span>
          </div>
          <div class="col-span-2">
            <span class="text-xs text-slate-500 block">Index Freshness</span>
            <span class={`text-sm font-mono text-${stalenessColor}`}>
              {staleness === 0 ? "✓ Up to date" : `⚠ ${staleness} file${staleness !== 1 ? "s" : ""} modified since last index`}
            </span>
          </div>
          <div class="col-span-2">
            {isReindexing ? (
              <div class="flex items-center gap-2">
                <span class="animate-spin">⟳</span>
                <span class="text-sm text-amber-400">{reindexProgress ?? "Reindexing..."}</span>
              </div>
            ) : (
              <button
                class="bg-brand-600 hover:bg-brand-500 text-white px-4 py-1.5 rounded text-sm transition-colors"
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
```

### `components/EmbeddingHealthCard.tsx`

```tsx
interface EmbeddingHealthCardProps {
  status: IndexStatus | null;
}

export function EmbeddingHealthCard({ status }: EmbeddingHealthCardProps) {
  if (!status?.embeddingModel) return null;

  const { provider, model, vectorDimension, available, latencyMs, error } = status.embeddingModel;

  return (
    <div class="bg-slate-800 rounded-lg p-4 border border-slate-700 mb-6">
      <h2 class="text-lg font-semibold mb-3">Embedding Model</h2>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div>
          <span class="text-xs text-slate-500 block">Provider</span>
          <span class="text-sm font-mono">{provider}</span>
        </div>
        <div>
          <span class="text-xs text-slate-500 block">Model</span>
          <span class="text-sm font-mono">{model}</span>
        </div>
        <div>
          <span class="text-xs text-slate-500 block">Vector Dim</span>
          <span class="text-sm font-mono">{vectorDimension}</span>
        </div>
        <div>
          <span class="text-xs text-slate-500 block">Status</span>
          {available ? (
            <span class="text-sm text-green-400">
              ● Online {latencyMs !== null && `(${latencyMs}ms)`}
            </span>
          ) : (
            <span class="text-sm text-red-400">● Offline</span>
          )}
        </div>
        {error && (
          <div class="col-span-full">
            <span class="text-xs text-red-400">Error: {error}</span>
          </div>
        )}
      </div>
    </div>
  );
}
```

### `views/Config.tsx` — Config Inspector

```tsx
export function Config() {
  const [configData] = useApi(() => API.config());

  return (
    <div>
      <h1 class="text-2xl font-bold mb-6">Configuration</h1>

      {!configData?.body?.config ? (
        <EmptyState icon="⚙" msg="No configuration available." />
      ) : (
        <div class="space-y-4">
          <p class="text-sm text-slate-400">
            Effective configuration from <code class="text-brand-400">opencode-rag.json</code>.
            API keys are redacted.
          </p>

          {/* Render collapsible sections */}
          {Object.entries(configData.body.config).map(([section, values]) => (
            <details class="bg-slate-800 rounded-lg border border-slate-700" open>
              <summary class="px-4 py-2 cursor-pointer hover:bg-slate-750 font-mono text-sm font-semibold capitalize">
                {section.replace(/([A-Z])/g, " $1")}
              </summary>
              <div class="px-4 pb-3">
                {typeof values === "object" && values !== null ? (
                  Object.entries(values).map(([key, value]) => (
                    <div class="flex justify-between py-1 border-b border-slate-700/50 text-sm">
                      <span class="text-slate-400 font-mono">{key}</span>
                      <span class="text-slate-200 font-mono">{formatConfigValue(value)}</span>
                    </div>
                  ))
                ) : (
                  <div class="flex justify-between py-1 text-sm">
                    <span class="text-slate-400 font-mono">{String(values)}</span>
                  </div>
                )}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

function formatConfigValue(value: any): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  if (typeof value === "object") return JSON.stringify(value).slice(0, 100);
  return String(value);
}
```

### Nav entry

- Add a gear icon (⚙) in the header → opens Config view
- Add "Config" to the nav bar (or access via a footer link on Dashboard)

---

## Verification

| # | Test | Expected |
|---|---|---|
| 1 | Navigate to Dashboard | Index status card visible below language chart |
| 2 | Index never created | Status card shows "No index found" |
| 3 | Index exists | Shows last indexed time, total chunks, total files, schema version |
| 4 | Modify a file, refresh dashboard | Staleness count > 0, amber badge |
| 5 | Click "Reindex Now" | Loading indicator, polling begins, toast on completion |
| 6 | Embedding model running | Embedding health card shows "● Online (Xms)" |
| 7 | Embedding model stopped | Embedding health card shows "● Offline" with error message |
| 8 | Open Config view | All config sections visible, collapsible |
| 9 | Config view — API keys | All `apiKey` fields show `***` |
| 10 | `/api/indexing/status` direct call | Returns valid JSON with all fields |
