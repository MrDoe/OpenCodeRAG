import { useEffect, useState } from "preact/hooks";
import { useApi } from "../hooks/useApi";
import { API } from "../lib/api";
import { useDebounce } from "../hooks/useDebounce";
import { langColor } from "../lib/langColors";
import { escapeHtml } from "../lib/escape";
import { selectedFile, collapsedDirs, navigate } from "../state/store";

interface FileInfo {
  filePath: string;
  language: string;
  chunkCount: number;
}

export function FileTree() {
  const { data } = useApi(() => API.files());
  const files: FileInfo[] = data ?? [];
  const [filter, setFilter] = useState("");
  const debouncedFilter = useDebounce(filter, 300);

  const filtered = debouncedFilter
    ? files.filter((f) => f.filePath.toLowerCase().includes(debouncedFilter.toLowerCase()))
    : files;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-2 px-3 pt-3">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Files</h2>
        <span className="text-xs text-slate-500">{filtered.length}</span>
      </div>
      <div className="px-3 mb-2">
        <input
          type="text"
          placeholder="Filter files..."
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
          className="w-full px-2 py-1 bg-slate-900 border border-slate-700 rounded text-xs focus:outline-none focus:border-brand-400 text-slate-200 placeholder-slate-500"
        />
      </div>
      <div className="flex-1 overflow-y-auto px-1">
        <FileTreeRecursive files={filtered} />
      </div>
    </div>
  );
}

function FileTreeRecursive({ files }: { files: FileInfo[] }) {
  const dirs: Record<string, any> = {};
  for (const f of files) {
    const parts = f.filePath.split("/");
    let current = dirs;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) current[parts[i]] = {};
      current = current[parts[i]];
    }
    if (!current.__files) current.__files = [];
    current.__files.push(f);
  }
  return <RenderDir obj={dirs} depth={0} parentPath="" />;
}

function countFiles(obj: any): number {
  let count = (obj.__files || []).length;
  for (const [k, v] of Object.entries(obj)) {
    if (k !== "__files") count += countFiles(v);
  }
  return count;
}

function RenderDir({ obj, depth, parentPath }: { obj: any; depth: number; parentPath: string }) {
  const entries = Object.entries(obj)
    .filter(([k]) => k !== "__files")
    .sort(([a], [b]) => a.localeCompare(b));
  const filesList: FileInfo[] = obj.__files || [];

  return (
    <>
      {entries.map(([name, children]) => {
        const dirPath = parentPath ? `${parentPath}/${name}` : name;
        const childCount = countFiles(children);
        const isCollapsed = collapsedDirs.value.has(dirPath);
        const arrow = isCollapsed ? "▸" : "▾";

        return (
          <div key={dirPath}>
            <div
              className="file-item flex items-center gap-1 py-0.5 px-2 rounded cursor-pointer text-slate-400 hover:text-white"
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              onClick={() => {
                const next = new Set(collapsedDirs.value);
                if (next.has(dirPath)) next.delete(dirPath);
                else next.add(dirPath);
                collapsedDirs.value = next;
              }}
              role="treeitem"
              aria-expanded={!isCollapsed}
            >
              <span className="text-xs">{arrow}</span>
              <span className="text-xs">📁</span>
              <span className="text-xs">{escapeHtml(name)}</span>
              <span className="text-xs text-slate-600 ml-auto">{childCount}</span>
            </div>
            {!isCollapsed && (
              <div className="dir-children">
                <RenderDir obj={children} depth={depth + 1} parentPath={dirPath} />
              </div>
            )}
          </div>
        );
      })}
      {filesList.map((f) => {
        const name = f.filePath.split("/").pop() ?? f.filePath;
        const isActive = selectedFile.value === f.filePath;
        return (
          <div
            key={f.filePath}
            className={`file-item flex items-center gap-1 py-0.5 px-2 rounded cursor-pointer ${isActive ? "active text-white" : "text-slate-400 hover:text-white"}`}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
            onClick={() => {
              selectedFile.value = f.filePath;
              navigate(`chunks?file=${encodeURIComponent(f.filePath)}`);
            }}
            role="treeitem"
            tabIndex={0}
          >
            <span className={`text-xs ${langColor(f.language)}`}>♦</span>
            <span className="text-xs truncate">{escapeHtml(name)}</span>
            <span className="text-xs text-slate-600 ml-auto">{f.chunkCount}</span>
          </div>
        );
      })}
    </>
  );
}
