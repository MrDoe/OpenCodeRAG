interface Segment {
  label: string;
  value: number;
  color: string;
}

interface DonutChartProps {
  segments: Segment[];
  size?: number;
  innerRadius?: number;
  centerLabel?: string;
}

export function DonutChart({ segments, size = 180, innerRadius, centerLabel }: DonutChartProps) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 10;
  const ir = innerRadius ?? r * 0.6;
  const total = segments.reduce((s, seg) => s + seg.value, 0);

  if (total === 0) {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#334155" stroke-width={r - ir} />
        <circle cx={cx} cy={cy} r={ir} fill="#0f172a" />
      </svg>
    );
  }

  let currentAngle = 0;
  const arcs = segments.map((seg) => {
    const angle = (seg.value / total) * 360;
    const startAngle = currentAngle;
    const endAngle = currentAngle + angle;
    currentAngle += angle;
    const arc = describeArc(cx, cy, r, startAngle, endAngle, ir);
    return `<path d="${arc}" fill="${seg.color}" />`;
  }).join("");

  const pctLabel = centerLabel ?? "";

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="chart-svg">
      <g dangerouslySetInnerHTML={{ __html: arcs }} />
      <text x={cx} y={cy - 6} text-anchor="middle" fill="white" font-size="22" font-weight="bold">
        {pctLabel}
      </text>
      <text x={cx} y={cy + 14} text-anchor="middle" fill="#64748b" font-size="11">
        tokens
      </text>
    </svg>
  );
}

function describeArc(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
  innerR: number
): string {
  const span = endAngle - startAngle;
  if (span >= 359.99) {
    return (
      `M${cx},${cy - r} A${r},${r} 0 1,1 ${cx - 0.01},${cy - r} ` +
      `L${cx - 0.01},${cy - innerR} A${innerR},${innerR} 0 1,0 ${cx},${cy - innerR} Z`
    );
  }
  const toRad = (a: number) => ((a - 90) * Math.PI) / 180;
  const x1 = cx + r * Math.cos(toRad(startAngle));
  const y1 = cy + r * Math.sin(toRad(startAngle));
  const x2 = cx + r * Math.cos(toRad(endAngle));
  const y2 = cy + r * Math.sin(toRad(endAngle));
  const ix1 = cx + innerR * Math.cos(toRad(endAngle));
  const iy1 = cy + innerR * Math.sin(toRad(endAngle));
  const ix2 = cx + innerR * Math.cos(toRad(startAngle));
  const iy2 = cy + innerR * Math.sin(toRad(startAngle));
  const large = span > 180 ? 1 : 0;
  return [
    `M${x1},${y1}`,
    `A${r},${r} 0 ${large} 1 ${x2},${y2}`,
    `L${ix1},${iy1}`,
    `A${innerR},${innerR} 0 ${large} 0 ${ix2},${iy2}`,
    "Z",
  ].join(" ");
}
