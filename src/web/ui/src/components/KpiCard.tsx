interface KpiCardProps {
  label: string;
  value: string | number;
  icon?: string;
}

export function KpiCard({ label, value, icon }: KpiCardProps) {
  return (
    <div className="kpi-card p-4">
      {icon && <span className="text-lg mb-1 block">{icon}</span>}
      <div className="text-slate-400 text-xs mb-1">{label}</div>
      <div className="text-3xl font-bold text-white">{value}</div>
    </div>
  );
}
