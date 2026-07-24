import { useEffect } from "preact/hooks";
import { navigate } from "../state/store";

export function useKeyboardShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

      // Ctrl/Cmd+K — focus search
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        navigate("search");
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

        const nextHandler = (e2: KeyboardEvent) => {
          handlers[e2.key]?.();
          window.removeEventListener("keydown", nextHandler);
        };
        window.addEventListener("keydown", nextHandler);
        setTimeout(() => window.removeEventListener("keydown", nextHandler), 500);
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
