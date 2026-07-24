interface ViewSkeletonProps {
  type?: "card" | "table" | "chart" | "detail";
}

const shimmer = "bg-gradient-to-r from-slate-700 via-slate-600 to-slate-700 bg-[length:200%_100%]";

export function ViewSkeleton({ type = "card" }: ViewSkeletonProps) {
  return (
    <div className="animate-pulse space-y-4">
      <div className={`h-8 ${shimmer} rounded w-48`} />

      {type === "card" && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 bg-slate-800 rounded-lg border border-slate-700 p-4">
              <div className={`h-3 ${shimmer} rounded w-16 mb-2`} />
              <div className={`h-6 ${shimmer} rounded w-24`} />
            </div>
          ))}
        </div>
      )}

      {type === "table" && (
        <div className="space-y-2">
          <div className={`h-10 ${shimmer} rounded w-full`} />
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className={`h-8 ${shimmer} rounded w-full`} />
          ))}
        </div>
      )}

      {type === "chart" && <div className={`h-64 ${shimmer} rounded-lg`} />}

      {type === "detail" && (
        <div className="flex gap-4">
          <div className="flex-1 space-y-3">
            <div className={`h-6 ${shimmer} rounded w-48`} />
            <div className={`h-4 ${shimmer} rounded w-32`} />
            <div className={`h-32 ${shimmer} rounded-lg`} />
          </div>
          <div className="flex-1 space-y-3">
            <div className={`h-6 ${shimmer} rounded w-48`} />
            <div className={`h-4 ${shimmer} rounded w-32`} />
            <div className={`h-32 ${shimmer} rounded-lg`} />
          </div>
        </div>
      )}
    </div>
  );
}
