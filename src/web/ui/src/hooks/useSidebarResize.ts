import { useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";
import { useSignalEffect } from "@preact/signals";
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_STEP,
  persistSidebarWidth,
  setSidebarWidth,
  sidebarWidth,
} from "../state/store";

interface DragState {
  pointerId: number;
  startX: number;
  startWidth: number;
}

/**
 * Pointer + keyboard resizing for the file-tree sidebar.
 *
 * The width signal is applied to the sidebar by a signal effect, so a drag
 * never re-renders the view tree (charts, file lists). Only the resizer
 * handle — which reads `dragging` and the current width — re-renders.
 * The width is persisted to localStorage when a gesture ends.
 */
export function useSidebarResize(targetRef: RefObject<HTMLElement | null>) {
  const dragRef = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);

  useSignalEffect(() => {
    const el = targetRef.current;
    if (el) el.style.width = `${sidebarWidth.value}px`;
  });

  const stopDrag = () => {
    dragRef.current = null;
    setDragging(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return; // left mouse button / touch / pen
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // The pointer may already be gone on a very fast click/synthetic event;
      // resizing still works, it just won't be captured outside the handle.
    }
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startWidth: sidebarWidth.peek(),
    };
    setDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const onPointerMove = (e: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setSidebarWidth(drag.startWidth + (e.clientX - drag.startX));
  };

  const endDrag = (e: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    stopDrag();
    persistSidebarWidth();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const delta = e.key === "ArrowLeft" ? -SIDEBAR_WIDTH_STEP : SIDEBAR_WIDTH_STEP;
    setSidebarWidth(sidebarWidth.peek() + delta);
    persistSidebarWidth();
  };

  const onDblClick = () => {
    setSidebarWidth(SIDEBAR_WIDTH_DEFAULT);
    persistSidebarWidth();
  };

  return {
    dragging,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onKeyDown,
      onDblClick,
    },
  };
}
