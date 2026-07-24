# Phase 6: UX Polish & Accessibility

**Duration:** 3 days  |  **Priority:** Medium (production quality)

> **The problem:** The UI is functional but rough — dark-mode only, no keyboard shortcuts, inconsistent loading/error states, poor accessibility (no ARIA, emoji icons without alt text, not keyboard-navigable), and no responsive layout.

> **The vision:** Light/dark theme, keyboard shortcuts, toast notifications, loading skeletons, ARIA attributes, keyboard navigation, responsive layout — the polish that makes a tool feel professional.

---

## Step 6.1: Light/Dark Theme Toggle (Day 1)

### CSS Variable-Based Theming

**File:** `src/web/ui/src/app.css` (or `src/web/ui/src/tailwind-input.css` if using Tailwind directives)

Define CSS variables for both themes. The `dark` class on `<html>` switches the palette.

```css
:root {
  /* Light theme */
  --bg-primary: #ffffff;
  --bg-secondary: #f8fafc;
  --bg-tertiary: #f1f5f9;
  --bg-card: #ffffff;
  --bg-code: #f8fafc;
  --text-primary: #0f172a;
  --text-secondary: #475569;
  --text-muted: #94a3b8;
  --border: #e2e8f0;
  --border-hover: #cbd5e1;
  --accent: #0891b2;
  --accent-hover: #0e7490;
  --chart-grid: #e2e8f0;
}

.dark {
  --bg-primary: #0f172a;
  --bg-secondary: #1e293b;
  --bg-tertiary: #334155;
  --bg-card: #1e293b;
  --bg-code: #0f172a;
  --text-primary: #e2e8f0;
  --text-secondary: #94a3b8;
  --text-muted: #64748b;
  --border: #334155;
  --border-hover: #475569;
  --accent: #06b6d4;
  --accent-hover: #22d3ee;
  --chart-grid: #334155;
}
```

**Update Tailwind classes:** Replace hardcoded `bg-slate-900`, `text-slate-200` etc. with `bg-[var(--bg-primary)]`, `text-[var(--text-primary)]` — or better, define custom Tailwind colors from the CSS variables:

```javascript
// tailwind.config.js
theme: {
  extend: {
    colors: {
      surface: {
        primary: "var(--bg-primary)",
        secondary: "var(--bg-secondary)",
        card: "var(--bg-card)",
        code: "var(--bg-code)",
      },
      text: {
        primary: "var(--text-primary)",
        secondary: "var(--text-secondary)",
        muted: "var(--text-muted)",
      },
      // ... etc
    },
  },
}
```

This way the components use `bg-surface-primary`, `text-text-primary` and Tailwind handles the variable injection.

### Theme Toggle Component

**File:** `src/web/ui/src/components/ThemeToggle.tsx`

```tsx
export function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    return (localStorage.getItem("theme") as "dark" | "light") ?? "dark";
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("theme", theme);
  }, [theme]);

  return (
    <button
      class="p-2 rounded-lg hover:bg-surface-secondary transition-colors"
      onClick={() => setTheme(t => t === "dark" ? "light" : "dark")}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={theme === "dark" ? "Light mode" : "Dark mode"}
    >
      {theme === "dark" ? (
        <svg class="w-5 h-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2}
            d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
      ) : (
        <svg class="w-5 h-5 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2}
            d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
      )}
    </button>
  );
}
```

**Placement:** In the header, next to the global search input.

---

## Step 6.2: Keyboard Shortcuts (Day 2 AM)

### File: `src/web/ui/src/hooks/useKeyboardShortcuts.ts`

A global hook that registers keyboard shortcuts when the App mounts:

```typescript
export function useKeyboardShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

      // Ctrl/Cmd+K or / — focus search (unless already in an input)
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        navigate("search");
        return;
      }

      // ? — show shortcut help overlay
      if (e.key === "?" && !isInput) {
        e.preventDefault();
        showShortcutHelp.value = true;
        return;
      }

      // Esc — close panels, modals, help overlay
      if (e.key === "Escape") {
        showShortcutHelp.value = false;
        // Close global search dropdown
        return;
      }

      // g + key navigation (only when not in input)
      if (!isInput && e.key === "g") {
        const nav = (nextKey: string) => {
          const views: Record<string, string> = {
            "d": "dashboard", "s": "search", "c": "chunks",
            "f": "files", "e": "evaluate", "q": "quirks",
            "m": "embeddings", "x": "config",
          };
          const view = views[nextKey];
          if (view) navigate(view);
        };

        // Listen for the next keypress within 500ms
        const nextHandler = (e2: KeyboardEvent) => {
          nav(e2.key);
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
```

### Shortcut Reference (available via `?` key)

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd+K` | Focus query input (from any view) |
| `g + d` | Navigate to Dashboard |
| `g + s` | Navigate to Search |
| `g + c` | Navigate to Chunks |
| `g + f` | Navigate to Files |
| `g + e` | Navigate to Evaluate |
| `g + q` | Navigate to Quirks |
| `g + m` | Navigate to Embeddings |
| `g + x` | Navigate to Config |
| `/` | Focus/search within current view |
| `Esc` | Close panels, dropdowns, modals |
| `?` | Show this keyboard shortcut reference |

### Shortcut Help Overlay

A modal overlay triggered by `?` that shows all available shortcuts:

```tsx
function ShortcutHelpOverlay() {
  const [isOpen, setIsOpen] = useState(false);
  // subscribe to showShortcutHelp signal

  if (!isOpen) return null;

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setIsOpen(false)}>
      <div class="bg-surface-card rounded-xl p-6 max-w-lg w-full shadow-2xl border border-border" onClick={e => e.stopPropagation()}>
        <h2 class="text-lg font-bold mb-4">Keyboard Shortcuts</h2>
        <table class="w-full text-sm">
          <thead>
            <tr class="text-text-muted border-b border-border">
              <th class="text-left py-1">Key</th>
              <th class="text-left py-1">Action</th>
            </tr>
          </thead>
          <tbody>
            {SHORTCUTS.map(({ key, action }) => (
              <tr class="border-b border-border/50">
                <td class="py-1.5"><kbd class="bg-surface-secondary px-1.5 py-0.5 rounded text-xs font-mono">{key}</kbd></td>
                <td class="py-1.5 text-text-secondary">{action}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p class="text-xs text-text-muted mt-4">Press Esc to close</p>
      </div>
    </div>
  );
}
```

---

## Step 6.3: Toast Notifications (Day 2 PM)

### File: `src/web/ui/src/components/Toast.tsx`

Already created in Phase 1, but now wired into every async action.

**Global toast API:**

```typescript
// toast.ts — export a module-level signal
import { signal } from "@preact/signals";

interface ToastMessage {
  id: number;
  type: "success" | "error" | "info";
  message: string;
  duration: number; // ms
}

const toasts = signal<ToastMessage[]>([]);
let nextId = 0;

export function toast(type: ToastMessage["type"], message: string, duration = 4000) {
  const id = nextId++;
  toasts.value = [...toasts.value, { id, type, message, duration }];
  setTimeout(() => {
    toasts.value = toasts.value.filter(t => t.id !== id);
  }, duration);
}

export const success = (msg: string) => toast("success", msg);
export const error = (msg: string) => toast("error", msg);
export const info = (msg: string) => toast("info", msg);
```

**ToastContainer component:**

```tsx
export function ToastContainer() {
  return (
    <div class="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.value.map(t => (
        <div
          key={t.id}
          class={`
            pointer-events-auto px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium
            transition-all duration-300 animate-slide-in
            ${t.type === "success" ? "bg-green-600 text-white" : ""}
            ${t.type === "error" ? "bg-red-600 text-white" : ""}
            ${t.type === "info" ? "bg-brand-600 text-white" : ""}
          `}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
```

**Wired actions:** Reindex complete, search error, embedder init, quirk deleted, chunk copied, eval session deleted, reindex started, config load error.

---

## Step 6.4: Loading Skeletons + Error States (Day 2 PM)

### File: `src/web/ui/src/components/ViewSkeleton.tsx`

```tsx
export function ViewSkeleton({ type = "card" }: { type?: "card" | "table" | "chart" | "detail" }) {
  const shimmer = "bg-gradient-to-r from-surface-secondary via-surface-tertiary to-surface-secondary bg-[length:200%_100%] animate-shimmer";

  return (
    <div class="animate-pulse space-y-4">
      {/* Title */}
      <div class={`h-8 ${shimmer} rounded w-48`} />

      {/* KPI cards */}
      {type === "card" && (
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => (
            <div class="h-24 bg-surface-card rounded-lg border border-border p-4">
              <div class={`h-3 ${shimmer} rounded w-16 mb-2`} />
              <div class={`h-6 ${shimmer} rounded w-24`} />
            </div>
          ))}
        </div>
      )}

      {/* Table */}
      {type === "table" && (
        <div class="space-y-2">
          <div class={`h-10 ${shimmer} rounded w-full`} />
          {[1, 2, 3, 4, 5].map(i => (
            <div class={`h-8 ${shimmer} rounded w-full opacity-${60 - i * 10}%`} />
          ))}
        </div>
      )}

      {/* Chart */}
      {type === "chart" && (
        <div class={`h-64 ${shimmer} rounded-lg`} />
      )}
    </div>
  );
}
```

**CSS animation:**
```css
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.animate-shimmer { animation: shimmer 1.5s ease-in-out infinite; }
```

**Error state component:**
```tsx
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div class="flex flex-col items-center justify-center py-12 text-center">
      <span class="text-4xl mb-3">⚠️</span>
      <p class="text-text-secondary mb-4">{message}</p>
      {onRetry && (
        <button class="bg-brand-600 hover:bg-brand-500 text-white px-4 py-2 rounded transition-colors" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
```

**Integration with `useApi` hook:**
```typescript
export function useApi<T>(fetcher: () => Promise<T>, deps: any[] = []): {
  data: T | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
} {
  // ... returns all three states that views can branch on
}
```

Views pattern:
```tsx
const { data, isLoading, error, refresh } = useApi(() => API.stats());

if (isLoading) return <ViewSkeleton type="card" />;
if (error) return <ErrorState message={error} onRetry={refresh} />;
if (!data) return <EmptyState icon="📊" msg="No dashboard data available." />;

return <FullDashboard data={data} />;
```

---

## Step 6.5: Accessibility Improvements (Day 3)

### ARIA Attributes

| Element | Attributes | Location |
|---|---|---|
| Nav buttons | `role="navigation"`, `aria-label="Main navigation"` | `<header>` |
| Nav items | `role="tab"`, `aria-selected` | Each nav button |
| Tables | `role="table"`, `aria-rowcount`, `aria-label` | DataTable component |
| Rows | `role="row"`, `tabindex="0"`, `aria-rowindex` | DataTable rows |
| Icon buttons | `aria-label="Delete session"`, `aria-label="Copy code"` | CopyButton, delete icons |
| File tree | `role="tree"`, `role="treeitem"`, `aria-expanded` | FileTree component |
| Emoji icons | `<span class="sr-only">Search</span>🔍` (+ `role="img"`) | All emoji uses |
| Global search | `role="combobox"`, `aria-expanded`, `aria-controls` | Search input |
| Search results | `role="listbox"`, `role="option"` | Dropdown panel |
| Toast container | `role="alert"`, `aria-live="polite"` | ToastContainer |
| Modal | `role="dialog"`, `aria-modal="true"`, `aria-labelledby` | Shortcut help, confirm dialogs |
| Lang badges | `aria-label="Language: TypeScript"` | Badge component |

### Keyboard Navigation

| Element | Behavior |
|---|---|
| Modals | Focus trap — Tab cycles within modal, Esc closes |
| Tables | Arrow keys navigate rows, Enter selects |
| File tree | Arrow keys navigate, `→` expands, `←` collapses, Enter selects file |
| Dropdowns | Arrow keys navigate items, Enter selects, Esc closes |
| Chips/badges | Tab stops on dismissible badges, Enter/Delete dismisses |
| Sliders | Arrow keys increment/decrement, Home/End for min/max |

### Focus Management

- After navigating to a new view, `document.getElementById("main-content")?.focus()` (with `tabindex="-1"`)
- After modal close, return focus to the triggering element
- After chunk selection, focus the detail pane
- Visible `focus-visible` ring on all interactive elements (using Tailwind's `focus-visible:ring-2 focus-visible:ring-brand-500`)

### Screen Reader Text for Emoji Icons

Emoji icons used as visual indicators must have text alternatives:

```tsx
// Pattern
<span role="img" aria-label={label}>{emoji}</span>

// Usage
<span role="img" aria-label="No chunks found">🔍</span>
<span role="img" aria-label="Loading">⌛</span>
<span role="img" aria-label="Settings">⚙</span>
```

---

## Step 6.6: Responsive Layout (Day 3 PM)

### Breakpoints

| Breakpoint | Sidebar | KPI grids | Nav | Tables |
|---|---|---|---|---|
| ≥ 1024px (desktop) | Fixed w-64 | 4 columns | Full nav bar | Full width |
| 768-1023px (tablet) | Collapsible drawer | 2 columns | Condensed nav | Horizontal scroll |
| < 768px (mobile) | Full-screen overlay | 1 column | Hamburger menu | Card list |

### Responsive Sidebar

```tsx
function Sidebar() {
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [open, setOpen] = useState(!isMobile);

  return (
    <>
      {/* Hamburger toggle (mobile) */}
      {isMobile && (
        <button
          class="fixed bottom-4 left-4 z-50 bg-brand-600 p-3 rounded-full shadow-lg"
          onClick={() => setOpen(o => !o)}
          aria-label="Toggle file tree"
        >
          ☰
        </button>
      )}

      {/* Sidebar panel */}
      <aside
        class={`
          ${isMobile ? "fixed inset-y-0 left-0 z-40 w-80 shadow-2xl translate-x-0" : "w-64 shrink-0"}
          ${isMobile && !open ? "-translate-x-full" : "translate-x-0"}
          bg-surface-primary border-r border-border transition-transform duration-200
          ${isMobile ? "" : "relative"}
        `}
        role="tree"
        aria-label="File tree"
      >
        {/* Sidebar content */}
        <FileTree />
      </aside>

      {/* Backdrop (mobile) */}
      {isMobile && open && (
        <div class="fixed inset-0 z-30 bg-black/50" onClick={() => setOpen(false)} />
      )}
    </>
  );
}
```

### Responsive Tables

For narrow screens, data tables switch to card list layout:

```tsx
function ResponsiveTable({ columns, rows, renderCard }: ResponsiveTableProps) {
  const isNarrow = useMediaQuery("(max-width: 640px)");

  if (isNarrow) {
    return (
      <div class="space-y-3">
        {rows.map(row => renderCard(row))}
      </div>
    );
  }

  return <DataTable columns={columns} rows={rows} />;
}
```

### Responsive Nav

```tsx
function Nav() {
  const isNarrow = useMediaQuery("(max-width: 640px)");

  if (isNarrow) {
    // Bottom tab bar
    return (
      <nav class="flex justify-around bg-surface-card border-t border-border py-2" role="navigation">
        {NAV_ITEMS.map(item => (
          <button class="flex flex-col items-center text-xs" onClick={() => navigate(item.route)}>
            <span class="text-lg">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    );
  }

  // Full nav bar
  return (
    <nav class="flex gap-1" role="tablist">
      {NAV_ITEMS.map(item => (
        <button class="nav-btn" role="tab" aria-selected={currentView.value === item.route} onClick={() => navigate(item.route)}>
          {item.icon} {item.label}
        </button>
      ))}
    </nav>
  );
}
```

---

## Verification

| # | Test | Expected |
|---|---|---|
| 1 | Click theme toggle | Transitions from dark to light and back |
| 2 | Refresh page in light mode | Persists (localStorage) |
| 3 | Ctrl+K from Dashboard | Focuses search query input |
| 4 | g then s | Navigates to Search |
| 5 | Press ? | Shortcut help overlay appears, Esc dismisses |
| 6 | Trigger an error toast | Red toast appears top-right, auto-dismisses after 4s |
| 7 | Trigger a success toast | Green toast, same behavior |
| 8 | Loading state for any view | Shimmer animation placeholder, not "Loading..." text |
| 9 | API failure for any view | Error state with retry button, not hanging "Loading..." |
| 10 | Empty state for any view | Informative message with icon |
| 11 | Tab through the UI | Focus ring visible on all interactive elements |
| 12 | Screen reader (NVDA/VoiceOver) | Nav labeled, table roles correct, emoji has alt text |
| 13 | Resize to 375px width | Sidebar hidden (hamburger), nav → bottom bar, tables → cards |
| 14 | Resize to 768px width | Sidebar collapsible, KPI grids 2-col |
| 15 | Resize to 1440px width | Full layout, 4-col KPI grids |
| 16 | File tree keyboard nav | Arrow keys navigate, Enter selects, →/← expands/collapses |
| 17 | Modal focus trap | Tab cycles within modal, can't tab to background elements |
| 18 | `Esc` while modal is open | Modal closes, focus returns to trigger element |
