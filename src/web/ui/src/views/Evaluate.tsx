import { useEffect, useState } from "preact/hooks";
import { useApi } from "../hooks/useApi";
import { useRouter } from "../hooks/useRouter";
import { API } from "../lib/api";
import { ViewSkeleton } from "../components/ViewSkeleton";
import { ErrorState } from "../components/ErrorState";
import { EmptyState } from "../components/EmptyState";
import { KpiCard } from "../components/KpiCard";
import { DonutChart } from "../charts/DonutChart";
import { formatTokens, formatCost, formatMs, formatTimestamp, deltaStr } from "../lib/format";
import { navigate, addToast } from "../state/store";

interface SessionSummary {
  sessionID: string;
  title?: string;
  lastEventAt: number;
  messageCount: number;
  totalTokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  totalCost: number;
  totalSteps: number;
  ragContextCount: number;
  ragToolCalls: number;
  ragContextTokens: number;
  toolCallCounts?: Record<string, number>;
  models: string[];
  avgResponseTimeMs?: number;
  events?: any[];
}

export function Evaluate() {
  const router = useRouter();

  if (router.params.compare) {
    return <EvalComparisonView ids={[router.params.a ?? "", router.params.b ?? ""]} />;
  }
  if (router.params.session) {
    return <EvalDetailView sessionId={router.params.session} />;
  }

  return <EvalSessionListView />;
}

function EvalSessionListView() {
  const { data, isLoading, error, refresh } = useApi(() => API.evalSessions());
  const [selected, setSelected] = useState<Set<string>>(new Set());

  if (isLoading) return <ViewSkeleton type="table" />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  const sessions: SessionSummary[] = data?.sessions ?? [];
  if (sessions.length === 0) {
    return <EmptyState icon="📊" message="No sessions recorded yet." />;
  }

  const toggleSelect = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Evaluate</h1>
        <div className="flex gap-2">
          {selected.size === 2 && (
            <button
              className="bg-brand-600 hover:bg-brand-500 text-white px-3 py-1 rounded text-sm transition-colors"
              onClick={() => {
                const [a, b] = [...selected];
                navigate(`evaluate?compare&a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
              }}
            >
              Compare Selected
            </button>
          )}
          {selected.size > 0 && (
            <button
              className="text-xs text-slate-400 hover:text-white"
              onClick={() => setSelected(new Set())}
            >
              Clear ({selected.size})
            </button>
          )}
        </div>
      </div>

      <div className="bg-slate-900 rounded-lg border border-slate-700 overflow-x-auto">
        <table className="w-full text-sm" role="table">
          <thead>
            <tr className="bg-slate-800 text-slate-400 text-xs">
              <th className="px-2 py-2 w-8"></th>
              <th className="px-3 py-2 text-left">Session</th>
              <th className="px-3 py-2 text-left">Last Activity</th>
              <th className="px-3 py-2 text-right">Messages</th>
              <th className="px-3 py-2 text-right">Input Tokens</th>
              <th className="px-3 py-2 text-right">Output Tokens</th>
              <th className="px-3 py-2 text-right">Cost</th>
              <th className="px-3 py-2 text-right">RAG Calls</th>
              <th className="px-3 py-2 text-right">RAG Tokens</th>
              <th className="px-3 py-2 text-left">Model</th>
              <th className="px-3 py-2 w-8"></th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr
                key={s.sessionID}
                className="border-t border-slate-800 hover:bg-slate-800 cursor-pointer"
                onClick={() => navigate(`evaluate?session=${encodeURIComponent(s.sessionID)}`)}
              >
                <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    className="accent-brand-500"
                    checked={selected.has(s.sessionID)}
                    onChange={() => toggleSelect(s.sessionID)}
                    aria-label={`Select session ${s.title ?? s.sessionID}`}
                  />
                </td>
                <td className="px-3 py-2 text-slate-200 font-mono text-xs">
                  {s.title ?? s.sessionID.slice(0, 8)}
                </td>
                <td className="px-3 py-2 text-slate-400 text-xs">{formatTimestamp(s.lastEventAt)}</td>
                <td className="px-3 py-2 text-slate-300 text-right">{s.messageCount}</td>
                <td className="px-3 py-2 text-slate-300 text-right">{formatTokens((s.totalTokens?.input ?? 0) + (s.totalTokens?.cacheRead ?? 0))}</td>
                <td className="px-3 py-2 text-slate-300 text-right">{formatTokens(s.totalTokens?.output ?? 0)}</td>
                <td className="px-3 py-2 text-slate-300 text-right">{formatCost(s.totalCost ?? 0)}</td>
                <td className="px-3 py-2 text-slate-300 text-right">{s.ragContextCount ?? 0}</td>
                <td className="px-3 py-2 text-slate-300 text-right">{formatTokens(s.ragContextTokens ?? 0)}</td>
                <td className="px-3 py-2 text-slate-400 text-xs">{s.models?.[0] ?? "-"}</td>
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="text-slate-600 hover:text-red-400 text-xs"
                    onClick={async () => {
                      if (confirm("Delete this session?")) {
                        try {
                          await API.evalDeleteSession(s.sessionID);
                          addToast("success", "Session deleted");
                          refresh();
                        } catch (err) {
                          addToast("error", `Delete failed: ${(err as Error).message}`);
                        }
                      }
                    }}
                    aria-label="Delete session"
                  >
                    🗑
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EvalDetailView({ sessionId }: { sessionId: string }) {
  const { data, isLoading, error, refresh } = useApi(() => API.evalSession(sessionId));

  if (isLoading) return <ViewSkeleton type="detail" />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  // The API returns { events: SessionEvent[], summary: SessionSummary }
  const s = data?.summary ?? data;
  const events = data?.events ?? [];

  const tools = s.toolCallCounts ?? {};
  const ragTools = ["search_semantic", "get_file_skeleton", "find_usages", "describe_image"];
  const ragToolCount = ragTools.reduce((sum: number, t: string) => sum + (tools[t] ?? 0), 0);

  const donutSegments = [
    { label: "Input", value: (s.totalTokens?.input ?? 0) + (s.totalTokens?.cacheRead ?? 0), color: "#3b82f6" },
    { label: "Output", value: s.totalTokens?.output ?? 0, color: "#a855f7" },
    { label: "RAG", value: s.ragContextTokens ?? 0, color: "#06b6d4" },
    { label: "Reasoning", value: s.totalTokens?.reasoning ?? 0, color: "#f59e0b" },
  ].filter((seg) => seg.value > 0);

  const totalTok = donutSegments.reduce((sum, seg) => sum + seg.value, 0);

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <button
          className="text-sm text-slate-400 hover:text-white"
          onClick={() => navigate("evaluate")}
        >
          ← Back
        </button>
        <h1 className="text-xl font-bold">
          {s.title ?? s.sessionID?.slice(0, 12)}
        </h1>
      </div>

      <div className="grid grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        <KpiCard label="Total Tokens" value={formatTokens(totalTok)} />
        <KpiCard label="Input" value={formatTokens((s.totalTokens?.input ?? 0) + (s.totalTokens?.cacheRead ?? 0))} />
        <KpiCard label="Output" value={formatTokens(s.totalTokens?.output ?? 0)} />
        <KpiCard label="Cost" value={formatCost(s.totalCost ?? 0)} />
        <KpiCard label="RAG Context" value={formatTokens(s.ragContextTokens ?? 0)} />
      </div>

      <div className="flex items-center gap-6 mb-6">
        <DonutChart segments={donutSegments} centerLabel={formatTokens(totalTok)} />
        <div className="flex flex-wrap gap-3">
          {donutSegments.map((seg) => (
            <div key={seg.label} className="flex items-center gap-1.5 text-xs text-slate-400">
              <span className="inline-block w-3 h-3 rounded-sm" style={{ background: seg.color }} />
              {seg.label}: {formatTokens(seg.value)} ({((seg.value / totalTok) * 100).toFixed(1)}%)
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <KpiCard label="Messages" value={s.messageCount ?? 0} />
        <KpiCard label="Steps" value={s.totalSteps ?? 0} />
        <KpiCard label="RAG Injections" value={s.ragContextCount ?? 0} />
        <KpiCard label="Avg Response" value={formatMs(s.avgResponseTimeMs ?? 0)} />
      </div>

      {Object.keys(tools).length > 0 && (
        <div className="kpi-card p-4 mb-6">
          <h3 className="text-sm font-semibold text-slate-300 mb-3">Tool Calls</h3>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            {Object.entries(tools).map(([name, count]) => (
              <div key={name} className="flex justify-between text-xs text-slate-400">
                <span className="font-mono">{name}</span>
                <span className="text-white">{String(count)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {s.models && s.models.length > 0 && (
        <div className="kpi-card p-4 mb-6">
          <h3 className="text-sm font-semibold text-slate-300 mb-2">Models</h3>
          <div className="flex flex-wrap gap-2">
            {s.models.map((m: string) => (
              <span key={m} className="px-2 py-0.5 rounded text-xs font-mono bg-slate-800 text-slate-300">
                {m}
              </span>
            ))}
          </div>
        </div>
      )}

      {events.length > 0 && (
        <div className="kpi-card p-4">
          <h3 className="text-sm font-semibold text-slate-300 mb-3">Event Timeline</h3>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {events.map((evt: any, i: number) => (
              <div key={i} className="flex gap-2 text-xs border-b border-slate-700/50 py-1">
                <span className="text-slate-500 shrink-0 w-16">
                  {formatTimestamp(evt.ts)}
                </span>
                <span className="text-slate-400">{evt.event}</span>
                {evt.tool && (
                  <span className="text-slate-500 font-mono">{evt.tool}</span>
                )}
                {evt.toolStatus && (
                  <span className={`text-xs ${evt.toolStatus === "completed" ? "text-green-400" : evt.toolStatus === "running" ? "text-amber-400" : "text-slate-500"}`}>
                    {evt.toolStatus}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EvalComparisonView({ ids }: { ids: string[] }) {
  const [aId, bId] = ids;
  const { data, isLoading, error } = useApi(
    () => Promise.all([API.evalCompare(aId, bId), API.evalTokenCompare(aId, bId)]),
    [aId, bId]
  );

  if (isLoading) return <ViewSkeleton type="chart" />;
  if (error) return <ErrorState message={error} />;
  if (!data) return null;

  const compare = data[0];
  const tokenCompare = data[1];

  const savingsA = tokenCompare.sessionA?.savings ?? 0;
  const savingsB = tokenCompare.sessionB?.savings ?? 0;
  const verdict = savingsA > 0 && savingsB > 0 ? "RAG saves tokens" : "Mixed results";

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <button
          className="text-sm text-slate-400 hover:text-white"
          onClick={() => navigate("evaluate")}
        >
          ← Back
        </button>
        <h1 className="text-xl font-bold">Session Comparison</h1>
      </div>

      <div
        className={`px-4 py-3 rounded-lg mb-4 font-semibold text-sm ${
          savingsA > 0 && savingsB > 0
            ? "bg-green-900/50 text-green-300 border border-green-700"
            : "bg-amber-900/50 text-amber-300 border border-amber-700"
        }`}
      >
        {verdict}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="kpi-card p-4">
          <h3 className="text-sm font-semibold text-slate-300 mb-2">
            {compare.sessionA?.title ?? "Session A"}
          </h3>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-400">Total Tokens</span>
              <span>{formatTokens(compare.sessionA?.totalTokens ?? 0)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Cost</span>
              <span>{formatCost(compare.sessionA?.totalCost ?? 0)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">RAG Savings</span>
              <span className={savingsA > 0 ? "text-green-400" : "text-red-400"}>
                {formatTokens(Math.abs(savingsA))} ({savingsA > 0 ? "+" : ""}{savingsA > 0 ? "+" : ""})
              </span>
            </div>
          </div>
        </div>
        <div className="kpi-card p-4">
          <h3 className="text-sm font-semibold text-slate-300 mb-2">
            {compare.sessionB?.title ?? "Session B"}
          </h3>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-400">Total Tokens</span>
              <span>{formatTokens(compare.sessionB?.totalTokens ?? 0)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Cost</span>
              <span>{formatCost(compare.sessionB?.totalCost ?? 0)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">RAG Savings</span>
              <span className={savingsB > 0 ? "text-green-400" : "text-red-400"}>
                {formatTokens(Math.abs(savingsB))}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
