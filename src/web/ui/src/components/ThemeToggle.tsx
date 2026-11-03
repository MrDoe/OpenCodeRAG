import { nextThemeName, theme, type ThemeName } from "../state/store";
import { persistThemeChoice } from "../state/config";

/**
 * Theme cycler: dark → plasma → drama → light → dark.
 *
 * The icon and label always describe the *next* theme so the button reads as
 * an action ("Switch to drama mode") rather than a state indicator. Each
 * icon carries its theme's signature color, so the button previews the
 * destination: amber sun for light, fuchsia sparkles for plasma, orange
 * flame for drama, slate moon for dark. Colors are picked to stay legible
 * on the header they appear on (the moon only ever renders on the light
 * header, the rest on dark headers).
 */
const NEXT_STYLE: Record<ThemeName, { action: string; title: string; color: string }> = {
  dark: { action: "Switch to dark mode", title: "Dark mode", color: "#64748b" },
  plasma: { action: "Switch to plasma mode", title: "Plasma theme", color: "#e879f9" },
  drama: { action: "Switch to drama mode", title: "Drama theme", color: "#fb923c" },
  light: { action: "Switch to light mode", title: "Light mode", color: "#fbbf24" },
};

export function ThemeToggle() {
  const next = nextThemeName(theme.value);
  const style = NEXT_STYLE[next];

  const toggle = () => {
    theme.value = next;
    void persistThemeChoice(next);
  };

  return (
    <button
      className="p-2 rounded-lg transition-colors shrink-0"
      style={{ color: style.color }}
      onClick={toggle}
      aria-label={style.action}
      title={style.title}
    >
      <span className="sr-only">{style.action}</span>
      {theme.value === "dark" ? (
        // Sun — the current dark-mode glyph; clicking ignites plasma.
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
      ) : theme.value === "plasma" ? (
        // Sparkles — plasma is active; clicking switches to the drama stage.
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z" />
        </svg>
      ) : theme.value === "drama" ? (
        // Flame — drama is active (signal-orange stage lights); clicking cools down to light.
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M12 22c4.4 0 7.5-3 7.5-7 0-3-2-5.5-3.5-7C14.5 6.5 13 5 13 2c-3 2-5 4.5-5.5 7C6 10 4.5 12 4.5 15c0 4 3.1 7 7.5 7z" />
        </svg>
      ) : (
        // Moon — light mode is active; clicking returns to dark.
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
      )}
    </button>
  );
}
