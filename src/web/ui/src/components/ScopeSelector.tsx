import { useEffect, useState } from "preact/hooks";
import { useApi } from "../hooks/useApi";
import { API } from "../lib/api";
import { addToast } from "../state/store";

interface TreeDir {
  name: string;
  path: string;
  children: TreeDir[];
}

interface ConfigShape {
  indexing?: { includeDirs?: string[] };
}

type TriState = "checked" | "partial" | "unchecked";

/** Drop redundant entries whose ancestor is already selected. */
function normalize(paths: string[]): string[] {
  const sorted = [...paths].sort();
  const result: string[] = [];
  for (const p of sorted) {
    if (!result.some((r) => p.startsWith(`${r}/`))) result.push(p);
  }
  return result;
}

/** True when `path` lies inside one of the selected roots (or is one). */
function isCovered(path: string, selection: string[]): boolean {
  return selection.some((r) => path === r || path.startsWith(`${r}/`));
}

function stateOf(path: string, selection: string[]): TriState {
  if (selection.includes(path)) return "checked";
  if (selection.some((r) => r.startsWith(`${path}/`))) return "partial";
  return "unchecked";
}

/**
 * Sidebar editor for `indexing.includeDirs`. Shows the workspace directory
 * tree (from `/api/tree`) as a tri-state checkbox list; the saved selection
 * is written to opencode-rag.json via PUT /api/config. Saving asks whether a
 * reindex should run now — the background watcher picks the new scope up on
 * the next plugin restart.
 */
export function ScopeSelector() {
  const treeApi = useApi(() => API.tree());
  const configApi = useApi(() => API.config());
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [saved, setSaved] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const config = (configApi.data?.body?.config ?? configApi.data?.config) as ConfigShape | null;
  const treeData = (treeApi.data?.body?.tree ?? treeApi.data?.tree) as TreeDir[] | null;

  useEffect(() => {
    if (config && !loaded) {
      const initial = config.indexing?.includeDirs ?? [];
      setSelection(initial);
      setSaved(initial);
      setLoaded(true);
    }
  }, [config, loaded]);

  const normalized = normalize(selection);
  const dirty = normalize(saved).join("|") !== normalized.join("|");
  const wholeWorkspace = normalized.length === 0;

  function toggleDir(path: string): void {
    const next = new Set(selection);
    if (stateOf(path, selection) === "checked") {
      for (const r of selection) {
        if (r === path || r.startsWith(`${path}/`)) next.delete(r);
      }
    } else {
      next.add(path);
      for (const r of selection) {
        if (r.startsWith(`${path}/`)) next.delete(r);
      }
    }
    setSelection([...next]);
  }

  function backToWholeWorkspace(): void {
    setSelection([]);
  }

  async function save(): Promise<void> {
    if (saving) return;
    setSaving(true);
    try {
      await API.updateConfig({ indexing: { includeDirs: normalized } });
      setSelection(normalized);
      setSaved(normalized);
      setDialogOpen(true);
    } catch (err) {
      addToast("error", `Failed to save scope: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function reindexNow(): Promise<void> {
    setDialogOpen(false);
    addToast("info", "Scope saved — starting reindex…");
    try {
      await API.triggerReindex();
      addToast("success", "Reindex started in the background.");
    } catch (err) {
      addToast("error", `Reindex failed to start: ${(err as Error).message}`);
    }
  }

  return (
    <div className="border-b" style={{ borderColor: "var(--border)" }}>
      <button
        type="button"
        className="w-full flex items-center gap-1 px-3 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wide hover:text-white"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="text-xs">{open ? "▾" : "▸"}</span>
        <span>Indexing scope</span>
        {normalized.length > 0 && (
          <span className="ml-auto text-xs text-slate-500">{normalized.length} folder{normalized.length === 1 ? "" : "s"}</span>
        )}
      </button>

      {open && (
        <div className="px-2 pb-3 text-xs">
          {treeApi.error && (
            <p className="text-red-400 px-2 py-1">
              Could not load workspace tree: {treeApi.error}
              <button type="button" className="ml-2 underline" onClick={treeApi.refresh}>Retry</button>
            </p>
          )}
          {!treeApi.error && !treeData && <p className="px-2 py-1 text-slate-500">Loading folders…</p>}
          {treeData && (
            <>
              <label className="flex items-center gap-1.5 py-1 px-2 rounded cursor-pointer text-slate-300 hover:text-white">
                <input
                  type="checkbox"
                  checked={wholeWorkspace}
                  onChange={backToWholeWorkspace}
                />
                <span>Whole workspace</span>
                {!wholeWorkspace && <span className="text-slate-500">(include all folders)</span>}
              </label>
              <p className="px-2 py-1 text-slate-600">
                Selecting a folder includes all of its subfolders. Files directly in the
                workspace root are only indexed with "Whole workspace".
              </p>
              <div className="max-h-48 overflow-y-auto border rounded" style={{ borderColor: "var(--border)" }}>
                <DirNode dirs={treeData} depth={0} selection={selection} onToggle={toggleDir} />
              </div>
              <button
                type="button"
                disabled={!dirty || saving}
                className="mt-2 w-full px-3 py-1.5 rounded font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: "var(--accent)", color: "#fff" }}
                onClick={save}
              >
                {saving ? "Saving…" : dirty ? "Save scope" : "Saved"}
              </button>
              <p className="mt-1.5 px-2 text-slate-600">
                Saved to <code>opencode-rag.json</code>. The background watcher applies the
                new scope after an OpenCode restart.
              </p>
            </>
          )}
        </div>
      )}

      {dialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.55)" }}>
          <div className="rounded-lg p-5 max-w-sm w-full shadow-xl" style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)" }}>
            <h3 className="text-base font-bold mb-2">Scope saved</h3>
            <p className="text-sm mb-4" style={{ color: "var(--text-muted)" }}>
              The includeDirs setting was written to opencode-rag.json. Reindex now so the
              index matches the new scope?
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="px-3 py-1.5 rounded text-sm"
                style={{ background: "var(--bg-primary)", border: "1px solid var(--border)" }}
                onClick={() => { setDialogOpen(false); addToast("success", "Scope saved — applies on the next index pass."); }}
              >
                Later
              </button>
              <button
                type="button"
                className="px-3 py-1.5 rounded text-sm font-semibold text-white"
                style={{ background: "var(--accent)" }}
                onClick={reindexNow}
              >
                Reindex now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DirNode({ dirs, depth, selection, onToggle }: {
  dirs: TreeDir[];
  depth: number;
  selection: string[];
  onToggle: (path: string) => void;
}) {
  return (
    <>
      {dirs.map((dir) => {
        const state = stateOf(dir.path, selection);
        return (
          <div key={dir.path}>
            <label
              className="flex items-center gap-1.5 py-0.5 px-2 rounded cursor-pointer text-slate-400 hover:text-white"
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
            >
              <input
                type="checkbox"
                checked={state === "checked"}
                ref={(el) => { if (el) el.indeterminate = state === "partial"; }}
                onChange={() => onToggle(dir.path)}
              />
              <span className="text-xs">📁</span>
              <span className="text-xs truncate">{dir.name}</span>
            </label>
            {dir.children.length > 0 && (
              <DirNode dirs={dir.children} depth={depth + 1} selection={selection} onToggle={onToggle} />
            )}
          </div>
        );
      })}
    </>
  );
}