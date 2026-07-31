import { useRef, useEffect, useState, useCallback, type JSX } from "preact/compat";

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

const HIT_RADIUS_PX = 10;

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
  const pendingTransform = useRef<Transform | null>(null);
  const rafRef = useRef<number | null>(null);
  const pointsRef = useRef(points);
  pointsRef.current = points;

  // Throttle transform updates through requestAnimationFrame so drag/wheel
  // events (mousemove fire at display rate) cannot re-render the canvas
  // and hit-testing state multiple times per frame.
  const scheduleTransform = useCallback((updater: (t: Transform) => Transform) => {
    pendingTransform.current = updater(pendingTransform.current ?? transform);
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (pendingTransform.current) {
        setTransform(pendingTransform.current);
        pendingTransform.current = null;
      }
    });
  }, [transform]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Hit-test a mouse position against all points in canvas space.
  const hitTest = useCallback((clientX: number, clientY: number): ScatterPlotPoint | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const t = pendingTransform.current ?? transform;
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    let best: ScatterPlotPoint | null = null;
    let bestDist = HIT_RADIUS_PX;
    for (const p of pointsRef.current) {
      const px = p.x * width * t.scale + t.x;
      const py = p.y * height * t.scale + t.y;
      const dx = mx - px;
      const dy = my - py;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= bestDist) {
        bestDist = dist;
        best = p;
      }
    }
    return best;
  }, [transform, width, height]);

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
    scheduleTransform((t) => ({
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
    if (isDragging) {
      scheduleTransform((t) => ({
        ...t,
        x: e.clientX - dragStart.current.x,
        y: e.clientY - dragStart.current.y,
      }));
      return;
    }
    // Canvas-space hit-testing replaces the old 5000-node SVG overlay —
    // only update state when the hovered point actually changes.
    const hit = hitTest(e.clientX, e.clientY);
    setHoveredPoint((prev) => (prev?.id === hit?.id ? prev : hit));
  };
  const handleMouseUp = () => setDragging(false);
  const handleClick = (e: MouseEvent) => {
    if (isDragging) return;
    const hit = hitTest(e.clientX, e.clientY);
    if (hit) onPointClick?.(hit.id);
  };

  return (
    <div className="relative overflow-hidden rounded-lg border border-slate-700 bg-slate-900" style={{ width, height }}>
      {/* Canvas for rendering points + hit-testing */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 cursor-grab active:cursor-grabbing"
        onMouseDown={handleMouseDown as any}
        onMouseMove={handleMouseMove as any}
        onMouseUp={handleMouseUp as any}
        onMouseLeave={handleMouseUp as any}
        onClick={handleClick as any}
        onWheel={handleWheel as any}
      />

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
          onClick={() => { setTransform({ x: 0, y: 0, scale: 1 }); pendingTransform.current = null; }}
        >
          Reset zoom
        </button>
      )}
    </div>
  );
}
