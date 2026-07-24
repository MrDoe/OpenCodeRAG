import { useEffect } from "preact/hooks";
import { theme } from "../state/store";

export function useTheme() {
  useEffect(() => {
    const stored = localStorage.getItem("theme") as "dark" | "light" | null;
    if (stored) theme.value = stored;
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme.value === "dark");
    localStorage.setItem("theme", theme.value);
  }, [theme.value]);

  const toggle = () => {
    theme.value = theme.value === "dark" ? "light" : "dark";
  };

  return { theme: theme.value, toggle };
}
