import { currentView } from "../state/store";

/**
 * Gear button in the app bar that opens the Configuration view.
 *
 * Settings live in the header action cluster rather than in the content tabs:
 * the tab row lists the data views, while the gear is the conventional,
 * always-visible entry point (the `Ctrl/Cmd+,` shortcut routes to the same
 * view).
 */
export function ConfigButton() {
  const active = currentView.value === "config";
  return (
    <button
      className="p-2 rounded-lg transition-colors shrink-0"
      style={{
        color: active ? "var(--accent)" : "var(--text-muted)",
        background: active ? "var(--bg-tertiary)" : "transparent",
      }}
      onClick={() => { window.location.hash = "config"; }}
      aria-label="Configuration"
      aria-current={active ? "page" : undefined}
      title="Configuration (Ctrl/Cmd+,)"
    >
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
        />
      </svg>
    </button>
  );
}
