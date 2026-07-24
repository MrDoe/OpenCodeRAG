interface BarItem {
  label: string;
  value: number;
  color: string;
  subLabel?: string;
}

interface BarChartProps {
  items: BarItem[];
  maxValue?: number;
  title?: string;
}

export function BarChart({ items, maxValue, title }: BarChartProps) {
  const max = maxValue ?? Math.max(...items.map((i) => i.value), 1);

  return (
    <div className="kpi-card p-4">
      {title && <h3 className="text-sm font-semibold text-slate-300 mb-3">{title}</h3>}
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.label} className="flex items-center gap-3">
            <span className="w-24 text-xs text-slate-400 text-right shrink-0">{item.label}</span>
            <div className="flex-1 bg-slate-800 rounded-full h-5 overflow-hidden">
              <div
                className="h-full rounded-full flex items-center pl-2"
                style={{
                  width: `${Math.max(8, (item.value / max) * 100)}%`,
                  backgroundColor: item.color,
                }}
              >
                <span className="text-xs font-medium text-white">{item.value}</span>
              </div>
            </div>
            {item.subLabel && (
              <span className="text-xs text-slate-500 w-12 text-right shrink-0">{item.subLabel}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
