import { useEffect, useState } from "preact/hooks";
import { useApi } from "../hooks/useApi";
import { useRouter } from "../hooks/useRouter";
import { API } from "../lib/api";
import { ViewSkeleton } from "../components/ViewSkeleton";
import { ErrorState } from "../components/ErrorState";
import { EmptyState } from "../components/EmptyState";
import { Badge } from "../components/Badge";
import { langBadge, langColor } from "../lib/langColors";
import { escapeHtml } from "../lib/escape";
import { selectedFile, selectedLang, selectedChunkId, selectedChunkIds, chunkOffset, chunkLimit, navigate, addToast } from "../state/store";
import type { Route } from "../hooks/useRouter";

interface ChunkData {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  content: string;
  description: string | null;
}

export function Chunks() {
  const router = useRouter();

  useEffect(() => {
    if (router.params.file) selectedFile.value = router.params.file;
    if (router.params.lang) selectedLang.value = router.params.lang;
  }, [router.params.file, router.params.lang]);

  const offset = chunkOffset.value;
  const limit = chunkLimit.value;
  const file = selectedFile.value;
  const lang = selectedLang.value;

  const { data, isLoading, error, refresh } = useApi(
    () => API.chunks({ offset, limit, lang: lang ?? "", file: file ?? "" }),
    [offset, limit, file, lang]
  );

  if (isLoading) return <ViewSkeleton type="detail" />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  const chunks: ChunkData[] = data?.chunks ?? [];
  const total: number = data?.total ?? chunks.length;
  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  return (
    <div className="flex gap-4 h-full">
      {/* Master pane */}
      <div className="w-1/2 flex flex-col">
        <div className="flex items-center gap-3 mb-3 flex-wrap">
          <h2 className="text-lg font-semibold text-white">Chunks</h2>
          <span className="text-sm text-slate-400">{total} total</span>
          {selectedLang.value && (
            <Badge text={selectedLang.value} color={langColor(selectedLang.value)} onDismiss={() => { selectedLang.value = null; selectedChunkId.value = null; chunkOffset.value = 0; }} />
          )}
          {selectedFile.value && (
            <Badge text={selectedFile.value} onDismiss={() => { selectedFile.value = null; selectedChunkId.value = null; chunkOffset.value = 0; }} />
          )}
        </div>

        <div className="bg-slate-900 rounded-lg border border-slate-700 overflow-hidden flex-1">
          <table className="w-full text-sm" role="table">
            <thead>
              <tr className="bg-slate-800 text-slate-400 text-xs">
                <th className="px-2 py-2 w-8">
                  <input
                    type="checkbox"
                    className="accent-brand-500"
                    checked={chunks.length > 0 && chunks.every((c) => selectedChunkIds.value.has(c.id || `chunk-${chunks.indexOf(c)}`))}
                    onChange={() => {
                      const allIds = chunks.map((c, i) => c.id || `chunk-${i}`);
                      const allSelected = allIds.every((id) => selectedChunkIds.value.has(id));
                      const next = new Set(selectedChunkIds.value);
                      for (const id of allIds) {
                        if (allSelected) next.delete(id); else next.add(id);
                      }
                      selectedChunkIds.value = next;
                    }}
                    aria-label="Select all chunks on this page"
                  />
                </th>
                <th className="px-3 py-2 text-left">File</th>
                <th className="px-3 py-2 text-left w-20">Lang</th>
                <th className="px-3 py-2 text-left">Description</th>
              </tr>
            </thead>
            <tbody>
              {chunks.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-slate-500">
                    <span className="text-2xl block mb-2">🔍</span>
                    No chunks found
                  </td>
                </tr>
              ) : (
                chunks.map((c, i) => {
                  const id = c.id || `chunk-${i}`;
                  const isSelected = selectedChunkId.value === id;
                  const isChecked = selectedChunkIds.value.has(id);
                  return (
                    <tr
                      key={id}
                      className={`chunk-row border-t border-slate-800 cursor-pointer ${isSelected ? "selected" : ""}`}
                      onClick={() => { selectedChunkId.value = id; }}
                      role="row"
                      tabIndex={0}
                    >
                      <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="accent-brand-500"
                          checked={isChecked}
                          onChange={() => {
                            const next = new Set(selectedChunkIds.value);
                            if (next.has(id)) next.delete(id); else next.add(id);
                            selectedChunkIds.value = next;
                          }}
                          aria-label={`Select chunk ${id}`}
                        />
                      </td>
                      <td className="px-3 py-2 text-yellow-400 font-mono text-xs">
                        {escapeHtml(c.filePath)}:{c.startLine}-{c.endLine}
                      </td>
                      <td className="px-3 py-2" dangerouslySetInnerHTML={{ __html: langBadge(c.language) }} />
                      <td className="px-3 py-2 text-slate-400 text-xs">
                        {escapeHtml(c.description ?? "").slice(0, 50)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between mt-3">
          <button
            className="px-3 py-1 bg-slate-700 rounded text-sm hover:bg-slate-600 disabled:opacity-50"
            disabled={currentPage <= 1}
            onClick={() => { chunkOffset.value = Math.max(0, offset - limit); }}
          >
            Previous
          </button>
          <span className="text-sm text-slate-400">
            Page {currentPage} of {totalPages || 1}
          </span>
          <button
            className="px-3 py-1 bg-slate-700 rounded text-sm hover:bg-slate-600 disabled:opacity-50"
            disabled={currentPage >= totalPages}
            onClick={() => { chunkOffset.value += limit; }}
          >
            Next
          </button>
        </div>

        {/* Floating Compare button */}
        {selectedChunkIds.value.size >= 2 && selectedChunkIds.value.size <= 3 && (
          <div className="fixed bottom-6 right-6 z-50">
            <button
              className="bg-brand-600 hover:bg-brand-500 text-white px-6 py-3 rounded-full shadow-lg font-bold transition-all transform hover:scale-105"
              onClick={() => {
                const ids = [...selectedChunkIds.value];
                selectedChunkIds.value = new Set();
                navigate(`compare?ids=${ids.join(",")}`);
              }}
            >
              Compare ({selectedChunkIds.value.size})
            </button>
          </div>
        )}
      </div>

      {/* Detail pane */}
      <div className="w-1/2 overflow-y-auto">
        {selectedChunkId.value ? (
          <ChunkDetail chunkId={selectedChunkId.value} chunks={chunks} />
        ) : (
          <div className="flex items-center justify-center h-full text-slate-500">
            <div className="text-center">
              <div className="text-4xl mb-2">📄</div>
              <div className="text-sm">Select a chunk to view details</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ChunkDetail({ chunkId, chunks }: { chunkId: string; chunks: ChunkData[] }) {
  const [detail, setDetail] = useState<ChunkData | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const local = chunks.find((c) => c.id === chunkId);
    if (local) {
      setDetail(local);
    } else {
      API.chunk(chunkId).then((res) => {
      setDetail(res);
    });
    }
  }, [chunkId, chunks]);

  if (!detail) return <ViewSkeleton type="detail" />;

  const c = detail;
  const isImage = c.language === "image";

  const handleCopy = () => {
    navigator.clipboard.writeText(c.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div>
      <div className="mb-3">
        <div className="flex items-center gap-3 mb-1">
          <span className="text-yellow-400 font-mono text-sm">{escapeHtml(c.filePath)}</span>
        </div>
        <div className="flex items-center gap-3 text-sm text-slate-400">
          <span>Lines {c.startLine}-{c.endLine}</span>
          <span dangerouslySetInnerHTML={{ __html: langBadge(c.language) }} />
          {c.id && <span className="text-xs text-slate-600 font-mono">{c.id}</span>}
        </div>
      </div>

      {c.description && (
        <div className="kpi-card p-3 mb-3">
          <h3 className="text-xs font-semibold text-slate-400 mb-1">Description</h3>
          <p className="text-sm text-slate-300">{escapeHtml(c.description)}</p>
        </div>
      )}

      {isImage && (
        <div className="bg-slate-900 rounded-lg border border-slate-700 overflow-hidden mb-3">
          <div className="px-3 py-1.5 bg-slate-800 border-b border-slate-700">
            <span className="text-xs text-slate-400">Image Preview</span>
          </div>
          <div className="p-3 flex items-center justify-center bg-slate-950">
            <img
              src={`/api/file?path=${encodeURIComponent(c.filePath)}`}
              alt={c.filePath}
              className="max-w-full max-h-[60vh] object-contain rounded"
              onError={(e) => {
                const target = e.currentTarget;
                target.style.display = "none";
                target.parentElement!.innerHTML = '<span class="text-slate-500 text-sm">Image not available</span>';
              }}
            />
          </div>
        </div>
      )}

      <div className="bg-slate-900 rounded-lg border border-slate-700 overflow-hidden">
        <div className="px-3 py-1.5 bg-slate-800 border-b border-slate-700 flex items-center justify-between">
          <span className="text-xs text-slate-400">
            {isImage ? "Vision Analysis" : "Source Code"}
          </span>
          <button
            className="text-xs text-slate-500 hover:text-white transition-colors"
            onClick={handleCopy}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        <pre className="p-3 overflow-x-auto text-sm max-h-[calc(100vh-220px)]">
          <code className={`language-${isImage ? "text" : c.language}`}>
            {escapeHtml(c.content)}
          </code>
        </pre>
      </div>
    </div>
  );
}
