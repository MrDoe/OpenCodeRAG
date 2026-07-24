import { useRef, useEffect, useState, type JSX } from "preact/compat";

export interface ScatterPlotPoint {
  id: string;
  x: number;
  y: number;
  color: string;
  label: string;
  radius?: number;
  highlighted?: boolean;
}

interface Transform {
  x: number;
  y: number;
  scale: number;
}

interface ScatterPlotProps {
  points: ScatterPlotPoint[];
  width?: number;
  height?: number;
  onPointClick?: (id: string) => void;
  renderTooltip?: (point: ScatterPlotPoint) => JSX.Element;
}

export function ScatterPlot({
  points,
  width = 800,
  height = 600,
  onPointClick,
  renderTooltip,
}: ScatterPlotProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, scale: 1 });
  const [hoveredPoint, setHoveredPoint] = useState<ScatterPlotPoint | null>(null);
  const [isDragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });

  // Draw on Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.scale, transform.scale);

    for (const point of points) {
      const px = point.x * width;
      const py = point.y * height;
      const r = (point.radius ?? 3) * (point.highlighted ? 2 : 1);
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = point.color;
      ctx.globalAlpha = point.highlighted ? 1 : 0.6;
      ctx.fill();
      if (point.highlighted) {
        ctx.strokeStyle = "#22d3ee";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    ctx.restore();
  }, [points, transform, width, height]);

  // Zoom via scroll wheel
  const handleWheel = (e: WheelEvent) => {
    e.preventDefault();
    const scaleBy = e.deltaY > 0 ? 0.9 : 1.1;
    setTransform((t) => ({
      ...t,
      scale: Math.max(0.5, Math.min(10, t.scale * scaleBy)),
    }));
  };

  // Pan via mouse drag
  const handleMouseDown = (e: MouseEvent) => {
    setDragging(true);
    dragStart.current = { x: e.clientX - transform.x, y: e.clientY - transform.y };
  };
  const handleMouseMove = (e: MouseEvent) => {
    if (!isDragging) return;
    setTransform((t) => ({
      ...t,
      x: e.clientX - dragStart.current.x,
      y: e.clientY - dragStart.current.y,
    }));
  };
  const handleMouseUp = () => setDragging(false);

  return (
    <div className="relative overflow-hidden rounded-lg border border-slate-700 bg-slate-900" style={{ width, height }}>
      {/* Canvas for rendering points */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 cursor-grab active:cursor-grabbing"
        onMouseDown={handleMouseDown as any}
        onMouseMove={handleMouseMove as any}
        onMouseUp={handleMouseUp as any}
        onMouseLeave={handleMouseUp as any}
        onWheel={handleWheel as any}
      />

      {/* SVG overlay for hit-testing */}
      <svg width={width} height={height} className="absolute inset-0 pointer-events-none">
        {points.map((p) => (
          <circle
            key={p.id}
            cx={p.x * width * transform.scale + transform.x}
            cy={p.y * height * transform.scale + transform.y}
            r={8}
            fill="transparent"
            className="pointer-events-auto cursor-pointer"
            onMouseEnter={() => setHoveredPoint(p)}
            onMouseLeave={() => setHoveredPoint(null)}
            onClick={() => onPointClick?.(p.id)}
          />
        ))}
      </svg>

      {/* Tooltip */}
      {hoveredPoint && renderTooltip && (
        <div
          className="absolute bg-slate-800 border border-slate-600 rounded-lg p-3 shadow-xl text-sm z-10 pointer-events-none"
          style={{
            left: Math.min(hoveredPoint.x * width * transform.scale + transform.x + 12, width - 200),
            top: Math.min(hoveredPoint.y * height * transform.scale + transform.y - 12, height - 80),
          }}
        >
          {renderTooltip(hoveredPoint)}
        </div>
      )}

      {/* Reset zoom button */}
      {transform.scale !== 1 && (
        <button
          className="absolute bottom-3 right-3 px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded text-xs text-white transition-colors z-20"
          onClick={() => setTransform({ x: 0, y: 0, scale: 1 })}
        >
          Reset zoom
        </button>
      )}
    </div>
  );
}
