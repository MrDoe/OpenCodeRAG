import { useApi } from "../hooks/useApi";
import { API } from "../lib/api";
import { ViewSkeleton } from "../components/ViewSkeleton";
import { ErrorState } from "../components/ErrorState";
import { EmptyState } from "../components/EmptyState";
import { langBadge } from "../lib/langColors";
import { navigate } from "../state/store";

interface FileInfo {
  filePath: string;
  language: string;
  chunkCount: number;
}

export function Files() {
  const { data, isLoading, error, refresh } = useApi(() => API.files());

  if (isLoading) return <ViewSkeleton type="table" />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  const files: FileInfo[] = data ?? [];
  if (files.length === 0) return <EmptyState icon="📂" message="No files indexed yet." />;

  const totalChunks = files.reduce((sum, f) => sum + f.chunkCount, 0);

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-2xl font-bold">Files</h1>
        <span className="text-sm text-slate-400">
          {files.length} files, {totalChunks} chunks
        </span>
      </div>

      <div className="bg-slate-900 rounded-lg border border-slate-700 overflow-hidden">
        <table className="w-full text-sm" role="table" aria-label="Indexed files">
          <thead>
            <tr className="bg-slate-800 text-slate-400 text-xs">
              <th className="px-3 py-2 text-left">File</th>
              <th className="px-3 py-2 text-left w-28">Language</th>
              <th className="px-3 py-2 text-left w-20">Chunks</th>
              <th className="px-3 py-2 text-left w-24"></th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr
                key={f.filePath}
                className="border-t border-slate-800 hover:bg-slate-800 cursor-pointer"
                onClick={() => navigate(`chunks?file=${encodeURIComponent(f.filePath)}`)}
                role="row"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter") navigate(`chunks?file=${encodeURIComponent(f.filePath)}`); }}
              >
                <td className="px-3 py-2 text-yellow-400 font-mono text-xs">{f.filePath}</td>
                <td className="px-3 py-2" dangerouslySetInnerHTML={{ __html: langBadge(f.language) }} />
                <td className="px-3 py-2 text-slate-300">{f.chunkCount}</td>
                <td className="px-3 py-2 text-slate-500 text-xs">
                  <span className="hover:text-white transition-colors">View chunks</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
