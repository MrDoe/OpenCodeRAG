# Phase 3: Chunk Comparison View

**Duration:** 1 day  |  **Priority:** Medium (fix doc drift)

> **The problem:** `doc/webui.md` describes a "Compare" view for side-by-side comparison of 2-3 chunks with a checkbox column in the Chunks table. Neither exists. The `API.compare(ids)` wrapper and `/api/compare` backend endpoint are defined but never called — dead code.

> **The vision:** Implement the documented feature. Checkbox column in the Chunks table → side-by-side diff comparison with syntax highlighting.

---

## Step 3.1: Chunks Table — Checkbox Column (Day 1 AM)

### File: `src/web/ui/src/views/Chunks.tsx`

Add a checkbox column to the chunks table header and rows:

```tsx
{/* In the table header */}
<thead>
  <tr>
    <th class="w-8">
      <input
        type="checkbox"
        checked={selectedChunkIds.value.size === chunks.length && chunks.length > 0}
        onChange={toggleSelectAll}
        class="accent-brand-500"
      />
    </th>
    <th>File</th>
    <th>Lang</th>
    <th>Description</th>
  </tr>
</thead>
```

```tsx
{/* In each row */}
<tr
  class={`chunk-row ${selectedChunkIds.value.has(chunk.id) ? "selected" : ""}`}
  onClick={() => selectChunk(chunk.id)}
>
  <td onClick={e => e.stopPropagation()}>
    <input
      type="checkbox"
      checked={selectedChunkIds.value.has(chunk.id)}
      onChange={() => toggleChunkSelection(chunk.id)}
      class="accent-brand-500"
    />
  </td>
  <td class="font-mono text-sm">{chunk.filePath}:{chunk.startLine}-{chunk.endLine}</td>
  <td><Badge text={chunk.language} color={langColor(chunk.language)} /></td>
  <td class="text-sm text-slate-400">{truncate(chunk.description, 80)}</td>
</tr>
```

**Signal:** `selectedChunkIds` from `state/store.ts` (`Signal<Set<string>>`).

**Helper functions:**
```typescript
function toggleChunkSelection(id: string) {
  const next = new Set(selectedChunkIds.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  selectedChunkIds.value = next;
}

function toggleSelectAll(checked: boolean) {
  selectedChunkIds.value = checked
    ? new Set(currentChunks.map(c => c.id))
    : new Set();
}
```

### Compare Button

Floating button that appears when 2-3 chunks are selected:

```tsx
{selectedChunkIds.value.size >= 2 && selectedChunkIds.value.size <= 3 && (
  <div class="fixed bottom-6 right-6 z-50">
    <button
      class="bg-brand-600 hover:bg-brand-500 text-white px-6 py-3 rounded-full shadow-lg
             font-bold transition-all transform hover:scale-105"
      onClick={() => navigate(`compare?ids=${[...selectedChunkIds.value].join(",")}`)}
    >
      Compare ({selectedChunkIds.value.size})
    </button>
  </div>
)}
```

---

## Step 3.2: Compare View Frontend (Day 1 PM)

### File: `src/web/ui/src/views/Compare.tsx`

**Layout:** Side-by-side panels (2 or 3, depending on `ids` count), each with:

1. File path + line range header
2. Language badge
3. Description card
4. Syntax-highlighted code with line numbers
5. Diff highlighting comparing panel N vs panel 0

```tsx
export function Compare() {
  const router = useRouter();
  const ids = router.params.ids?.split(",") ?? [];
  const [chunks, setChunks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    API.compare(ids).then(res => {
      setChunks(res.body.chunks ?? []);
      setLoading(false);
    });
  }, [ids.join(",")]);

  if (loading) return <ViewSkeleton />;
  if (chunks.length < 2) return <EmptyState icon="📋" msg="Select 2-3 chunks from the Chunks view to compare them." />;

  return (
    <div>
      <div class="flex items-center justify-between mb-4">
        <h1 class="text-2xl font-bold">Chunk Comparison</h1>
        <button class="text-sm text-slate-400 hover:text-white" onClick={() => navigate("chunks")}>
          ← Back to Chunks
        </button>
      </div>
      <div class={`grid gap-4 ${chunks.length === 2 ? "grid-cols-2" : "grid-cols-3"}`}>
        {chunks.map((chunk, idx) => (
          <ChunkComparePanel
            key={chunk.id}
            chunk={chunk}
            index={idx}
            diffAgainst={idx > 0 ? chunks[0] : undefined}
          />
        ))}
      </div>
    </div>
  );
}
```

### `ChunkComparePanel` Component

```tsx
function ChunkComparePanel({ chunk, index, diffAgainst }: ChunkComparePanelProps) {
  const lines = chunk.content.split("\n");

  return (
    <div class="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden">
      {/* Header */}
      <div class="p-3 border-b border-slate-700 bg-slate-800/80">
        <div class="flex items-center justify-between">
          <span class="text-sm font-mono text-brand-400">{chunk.filePath}:{chunk.startLine}-{chunk.endLine}</span>
          <Badge text={chunk.language} color={langColor(chunk.language)} />
        </div>
        {chunk.description && (
          <p class="text-xs text-slate-400 mt-1">{chunk.description}</p>
        )}
      </div>

      {/* Code with line numbers */}
      <div class="overflow-x-auto max-h-[70vh]">
        <table class="w-full text-xs font-mono">
          <tbody>
            {lines.map((line, lineIdx) => {
              const lineNum = (chunk.startLine ?? 1) + lineIdx;
              const diffClass = diffAgainst ? computeDiffClass(line, lineIdx, diffAgainst) : "";
              return (
                <tr class={diffClass}>
                  <td class="text-right text-slate-600 select-none px-2 w-10 border-r border-slate-700">
                    {lineNum}
                  </td>
                  <td class="px-3 py-0 whitespace-pre">{escapeHtml(line) || " "}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

### Diff Highlighting

Simple line-by-line diff between chunk N and chunk 0 (using a basic LCS algorithm):

```typescript
type DiffResult = "added" | "removed" | "unchanged" | "modified";

function computeDiffClass(line: string, lineIdx: number, other: any): string {
  const otherLines = other.content.split("\n");
  const otherLine = otherLines[lineIdx];

  if (!otherLine) return "bg-green-900/30";  // added line
  if (line === "") return otherLine ? "bg-red-900/30" : "";  // removed (if other has content here)

  // Simple comparison: exact match = unchanged, else modified
  if (line === otherLine) return "";  // unchanged
  return "bg-amber-900/20";  // modified
}
```

**Future enhancement:** Replace with a proper text diff algorithm (e.g., `diff` npm package or implement Myers diff). For now, the simple approach handles the 80% case.

---

## Verification

| # | Test | Expected |
|---|---|---|
| 1 | Open Chunks view | Checkbox column present in table header |
| 2 | Click checkbox on row | Row gets cyan border, checkbox checked |
| 3 | Select 2 chunks | Floating "Compare (2)" button appears in bottom-right |
| 4 | Select 3 chunks | Floating "Compare (3)" button |
| 5 | Select 4 chunks | No floating button (compare max is 3) |
| 6 | Click "Compare" button | Navigates to `#/compare?ids=a,b,c` |
| 7 | Compare view renders | 2 or 3 side-by-side panels with correct headers |
| 8 | Line numbers | Correctly numbered from `startLine` |
| 9 | Diff highlighting | Lines present only in one side get green/red tint |
| 10 | "Back to Chunks" button | Navigates back to `#/chunks` |
| 11 | Direct URL navigation | `#/compare?ids=a,b` works, fetches chunks via API |
| 12 | Dead code cleanup | Confirm `API.compare()` is now called (no longer dead) |
