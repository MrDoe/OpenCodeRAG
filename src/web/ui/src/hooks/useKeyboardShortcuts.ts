import { useEffect } from "preact/hooks";
import { navigate } from "../state/store";

export function useKeyboardShortcuts() {
  useEffect(() => {
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingNextHandler: ((e: KeyboardEvent) => void) | null = null;

    const clearPending = () => {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      if (pendingNextHandler) {
        window.removeEventListener("keydown", pendingNextHandler);
        pendingNextHandler = null;
      }
    };

    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

      // Ctrl/Cmd+K — focus search
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        navigate("search");
        // Focus the global search input once the search view renders
        setTimeout(() => {
          document.querySelector<HTMLInputElement>(".global-search-input")?.focus();
        }, 0);
        return;
      }

      // g + key navigation (only when not in input)
      if (!isInput && e.key === "g") {
        const handlers: Record<string, () => void> = {
          "d": () => navigate("dashboard"),
          "s": () => navigate("search"),
          "c": () => navigate("chunks"),
          "f": () => navigate("files"),
          "e": () => navigate("evaluate"),
          "q": () => navigate("quirks"),
        };

        // One pending handler at a time — repeated 'g' presses must not
        // stack listeners, and the timer is tracked for cleanup.
        clearPending();
        const nextHandler = (e2: KeyboardEvent) => {
          handlers[e2.key]?.();
          clearPending();
        };
        pendingNextHandler = nextHandler;
        window.addEventListener("keydown", nextHandler);
        pendingTimer = setTimeout(clearPending, 500);
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      clearPending();
    };
  }, []);
}
