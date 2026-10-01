import type { RefObject } from "preact";
import { useSidebarResize } from "../hooks/useSidebarResize";
import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, sidebarWidth } from "../state/store";

interface SidebarResizerProps {
  /** The sidebar element whose width the drag controls. */
  targetRef: RefObject<HTMLElement | null>;
}

/**
 * Draggable handle sitting on the sidebar's right border. Desktop only —
 * below `lg` the sidebar is a fixed overlay, so resizing is disabled there.
 */
export function SidebarResizer({ targetRef }: SidebarResizerProps) {
  const { dragging, handleProps } = useSidebarResize(targetRef);

  return (
    <div
      className={`sidebar-resizer hidden lg:block ${dragging ? "dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize file tree"
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      aria-valuenow={sidebarWidth.value}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      {...handleProps}
    />
  );
}
