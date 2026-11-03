import { useEffect, useRef } from "preact/hooks";
import { settingElementId } from "./SettingRow";

interface ErrorSummaryProps {
  /** Dotted path → message. */
  errors: Record<string, string>;
  /** Dotted path → human label, for a readable list. */
  labels: Record<string, string>;
}

/**
 * Server validation summary. Focusable and focused when it appears so screen
 * readers announce it and keyboard users land on the problem list.
 */
export function ErrorSummary({ errors, labels }: ErrorSummaryProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const entries = Object.entries(errors);

  useEffect(() => {
    if (entries.length > 0) ref.current?.focus();
    // Only when the summary appears or grows, not on every keystroke.
  }, [entries.length]);

  if (entries.length === 0) return null;

  const focusField = (key: string) => {
    const row = document.getElementById(settingElementId(key.split(".")));
    if (!row) return;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    const focusable = row.querySelector<HTMLElement>("input, select, textarea, button[role='switch']");
    focusable?.focus();
  };

  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="mb-4 rounded-lg border p-3"
      style={{
        borderColor: "#dc2626",
        background: "color-mix(in srgb, #dc2626 8%, transparent)",
      }}
    >
      <p className="text-sm font-medium mb-2" style={{ color: "#dc2626" }}>
        {entries.length} setting{entries.length === 1 ? "" : "s"} could not be saved
      </p>
      <ul className="space-y-1">
        {entries.map(([key, message]) => (
          <li key={key} className="text-xs">
            <button
              type="button"
              className="underline underline-offset-2"
              style={{ color: "var(--text-primary)" }}
              onClick={() => focusField(key)}
            >
              {labels[key] ?? key}
            </button>
            <span style={{ color: "var(--text-muted)" }}> — {message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
