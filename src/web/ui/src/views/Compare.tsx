import { useEffect, useState } from "preact/hooks";
import { useRouter } from "../hooks/useRouter";
import { API } from "../lib/api";
import { ViewSkeleton } from "../components/ViewSkeleton";
import { ErrorState } from "../components/ErrorState";
import { EmptyState } from "../components/EmptyState";
import { Badge } from "../components/Badge";
import { langBadge, langColor } from "../lib/langColors";
import { escapeHtml } from "../lib/escape";
import { navigate } from "../state/store";

interface CompareChunk {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  content: string;
  description?: string;
}

export function Compare() {
  const router = useRouter();
  const ids = router.params.ids?.split(",").filter(Boolean) ?? [];
  const [chunks, setChunks] = useState<CompareChunk[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ids.length < 2) {
      setError("Select 2-3 chunks to compare.");
      setLoading(false);
      return;
    }
    API.compare(ids)
      .then((res) => {
        setChunks(res?.body?.chunks ?? res?.chunks ?? []);
        setLoading(false);
      })
      .catch((err) => {
        setError((err as Error).message);
        setLoading(false);
      });
  }, [ids.join(",")]);

  if (loading) return <ViewSkeleton type="detail" />;
  if (error) return <ErrorState message={error} />;
  if (chunks.length < 2)
    return <EmptyState icon="📋" message="Select 2-3 chunks from the Chunks view to compare them." />;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Chunk Comparison</h1>
        <button
          className="text-sm text-slate-400 hover:text-white transition-colors"
          onClick={() => navigate("chunks")}
        >
          ← Back to Chunks
        </button>
      </div>
      <div className={`grid gap-4 ${chunks.length === 2 ? "grid-cols-2" : "grid-cols-3"}`}>
        {chunks.map((chunk, idx) => (
          <ChunkComparePanel key={chunk.id} chunk={chunk} index={idx} baseChunk={idx > 0 ? chunks[0] : undefined} />
        ))}
      </div>
    </div>
  );
}

function ChunkComparePanel({ chunk, index, baseChunk }: { chunk: CompareChunk; index: number; baseChunk?: CompareChunk }) {
  const lines = chunk.content.split("\n");
  const baseLines = baseChunk?.content.split("\n") ?? [];

  return (
    <div className="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden flex flex-col">
      {/* Header */}
      <div className="p-3 border-b border-slate-700 bg-slate-800/80">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-mono text-brand-400 truncate mr-2">
            {escapeHtml(chunk.filePath)}:{chunk.startLine}-{chunk.endLine}
          </span>
          <span className="shrink-0" dangerouslySetInnerHTML={{ __html: langBadge(chunk.language) }} />
        </div>
        {chunk.description && (
          <p className="text-xs text-slate-400 truncate">{escapeHtml(chunk.description)}</p>
        )}
      </div>

      {/* Code with line numbers and diff highlighting */}
      <div className="overflow-x-auto flex-1 max-h-[70vh]">
        <table className="w-full text-xs font-mono border-collapse">
          <tbody>
            {lines.map((line, lineIdx) => {
              const lineNum = (chunk.startLine ?? 1) + lineIdx;
              const diffClass = baseLines[lineIdx] === undefined ? "bg-green-900/30" :
                line === "" && baseLines[lineIdx] !== "" ? "bg-red-900/30" :
                line !== baseLines[lineIdx] ? "bg-amber-900/20" : "";
              return (
                <tr key={lineIdx} className={diffClass}>
                  <td className="text-right text-slate-600 select-none px-2 w-10 border-r border-slate-700 align-top">
                    {lineNum}
                  </td>
                  <td className="px-3 py-0 whitespace-pre-wrap break-all">{escapeHtml(line) || "\u00A0"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Panel label */}
      <div className="px-3 py-1.5 bg-slate-900 border-t border-slate-700 text-xs text-slate-500">
        Chunk {index + 1}
        {index === 0 && <span className="text-slate-600 ml-1">(reference)</span>}
      </div>
    </div>
  );
}
