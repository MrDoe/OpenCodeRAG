import { useEffect } from "preact/hooks";
import { nextThemeName, theme } from "../state/store";

export function useTheme() {
  // The theme signal initializer already reads localStorage synchronously
  // (see store.ts + the inline script in index.html), so there is no
  // wrong-theme flash before the effect runs.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme.value === "dark");
    root.classList.toggle("theme-plasma", theme.value === "plasma");
    root.classList.toggle("theme-drama", theme.value === "drama");
    try {
      localStorage.setItem("theme", theme.value);
    } catch {
      // Storage unavailable — the theme still applies for this session.
    }
  }, [theme.value]);

  const toggle = () => {
    theme.value = nextThemeName(theme.value);
  };

  return { theme: theme.value, toggle };
}
