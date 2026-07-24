import { useApi } from "../hooks/useApi";
import { API } from "../lib/api";
import { ViewSkeleton } from "../components/ViewSkeleton";
import { ErrorState } from "../components/ErrorState";
import { EmptyState } from "../components/EmptyState";

export function Config() {
  const { data, isLoading, error, refresh } = useApi(() => API.config());

  if (isLoading) return <ViewSkeleton type="card" />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  const config = data?.body?.config ?? data?.config;
  if (!config) return <EmptyState icon="⚙" message="No configuration available." />;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Configuration</h1>
      <p className="text-sm text-slate-400 mb-4">
        Effective configuration from <code className="text-brand-400">opencode-rag.json</code>.
        API keys are redacted.
      </p>

      <div className="space-y-4">
        {Object.entries(config).map(([section, values]) => (
          <details key={section} className="bg-slate-800 rounded-lg border border-slate-700" open>
            <summary className="px-4 py-2 cursor-pointer hover:bg-slate-700 font-mono text-sm font-semibold capitalize text-slate-300">
              {section.replace(/([A-Z])/g, " $1")}
            </summary>
            <div className="px-4 pb-3">
              {typeof values === "object" && values !== null ? (
                Object.entries(values as Record<string, unknown>).map(([key, value]) => (
                  <div key={key} className="flex justify-between py-1 border-b border-slate-700/50 text-sm">
                    <span className="text-slate-400 font-mono">{key}</span>
                    <span className="text-slate-200 font-mono text-xs text-right ml-4">
                      {formatConfigValue(value)}
                    </span>
                  </div>
                ))
              ) : (
                <div className="flex justify-between py-1 text-sm">
                  <span className="text-slate-200 font-mono">{String(values)}</span>
                </div>
              )}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

function formatConfigValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  if (typeof value === "object") return JSON.stringify(value).slice(0, 150);
  return String(value);
}
