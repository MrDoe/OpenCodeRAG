import { useEffect } from "preact/hooks";
import { theme } from "../state/store";

export function useTheme() {
  // The theme signal initializer already reads localStorage synchronously
  // (see store.ts), so there is no dark-flash for light-theme users.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme.value === "dark");
    localStorage.setItem("theme", theme.value);
  }, [theme.value]);

  const toggle = () => {
    theme.value = theme.value === "dark" ? "light" : "dark";
  };

  return { theme: theme.value, toggle };
}
