export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

export function formatCost(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "$" + n.toFixed(4);
  return "$" + n.toFixed(2);
}

export function formatMs(ms: number): string {
  if (ms >= 60_000) return (ms / 60_000).toFixed(1) + "m";
  if (ms >= 1_000) return (ms / 1_000).toFixed(1) + "s";
  return ms + "ms";
}

export function formatTimestamp(ts: string | number | null | undefined): string {
  if (!ts) return "-";
  const d = new Date(ts);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatRelativeTime(ts: string | number): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function deltaStr(val: number, suffix?: string): string {
  if (val === 0) return "-";
  const sign = val > 0 ? "+" : "";
  const color = val > 0 ? "text-red-400" : "text-green-400";
  let formatted: string;
  if (suffix === "$") formatted = formatCost(Math.abs(val));
  else if (suffix === "%") formatted = Math.abs(val).toFixed(1) + "%";
  else formatted = formatTokens(Math.abs(val));
  return `<span class="${color}">${sign}${formatted}</span>`;
}
