import { useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";
import { useSignalEffect } from "@preact/signals";
import {
  EMBED_PLOT_FRAC_DEFAULT,
  EMBED_PLOT_FRAC_MAX,
  EMBED_PLOT_FRAC_MIN,
  EMBED_PLOT_FRAC_STEP,
  embedPlotFrac,
  persistEmbedPlotFrac,
  setEmbedPlotFrac,
} from "../state/store";

interface SplitDragState {
  pointerId: number;
  startX: number;
  startFrac: number;
  containerWidth: number;
}

interface EmbedSplitterProps {
  /** The flex row whose `--embed-plot-w` variable drives the plot pane width. */
  containerRef: RefObject<HTMLDivElement | null>;
}

/**
 * Draggable vertical handle between the embeddings plot and the selection
 * details pane. Desktop only — below `lg` the panes stack, so the handle is
 * hidden there (see `.splitter-v` in app.css).
 *
 * Like the sidebar resizer, the fraction signal is applied to the DOM
 * imperatively, so a drag never re-renders the charts — only this handle
 * (for `aria-valuenow` and the dragging style) re-renders.
 */
export function EmbedSplitter({ containerRef }: EmbedSplitterProps) {
  const dragRef = useRef<SplitDragState | null>(null);
  const [dragging, setDragging] = useState(false);

  useSignalEffect(() => {
    containerRef.current?.style.setProperty(
      "--embed-plot-w",
      `${Math.round(embedPlotFrac.value * 100)}%`,
    );
  });

  const stopDrag = () => {
    dragRef.current = null;
    setDragging(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return; // left mouse button / touch / pen
    const container = containerRef.current;
    if (!container) return;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // The pointer may already be gone on a very fast click/synthetic event;
      // resizing still works, it just won't be captured outside the handle.
    }
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startFrac: embedPlotFrac.peek(),
      containerWidth: Math.max(1, container.getBoundingClientRect().width),
    };
    setDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const onPointerMove = (e: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setEmbedPlotFrac(drag.startFrac + (e.clientX - drag.startX) / drag.containerWidth);
  };

  const endDrag = (e: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    stopDrag();
    persistEmbedPlotFrac();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const delta = e.key === "ArrowLeft" ? -EMBED_PLOT_FRAC_STEP : EMBED_PLOT_FRAC_STEP;
    setEmbedPlotFrac(embedPlotFrac.peek() + delta);
    persistEmbedPlotFrac();
  };

  const onDblClick = () => {
    setEmbedPlotFrac(EMBED_PLOT_FRAC_DEFAULT);
    persistEmbedPlotFrac();
  };

  return (
    <div
      className={`splitter-v hidden lg:block${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize plot and details"
      aria-valuemin={Math.round(EMBED_PLOT_FRAC_MIN * 100)}
      aria-valuemax={Math.round(EMBED_PLOT_FRAC_MAX * 100)}
      aria-valuenow={Math.round(embedPlotFrac.value * 100)}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDblClick={onDblClick}
    />
  );
}
