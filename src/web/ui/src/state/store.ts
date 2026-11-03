import { signal } from "@preact/signals";

export interface ToastMessage {
  id: number;
  type: "success" | "error" | "info";
  message: string;
  duration: number;
}

// Navigation
export const currentView = signal<string>("dashboard");

// Chunks view
export const selectedFile = signal<string | null>(null);
export const selectedLang = signal<string | null>(null);
export const selectedChunkId = signal<string | null>(null);
export const chunkOffset = signal<number>(0);
export const chunkLimit = signal<number>(50);
export const selectedChunkIds = signal<Set<string>>(new Set());
export const collapsedDirs = signal<Set<string>>(new Set());

// Search (for Phase 2)
export const searchQuery = signal<string>("");
export const searchParams = signal({
  topK: 10,
  minScore: 0.35,
  keywordWeight: 0.4,
  hybrid: true,
  pathFilter: "",
  langFilter: "",
  extFilter: "",
});
export const searchResults = signal<any[]>([]);
export const searchHistory = signal<{ query: string; params: any }[]>([]);
export const isSearching = signal<boolean>(false);

// Dashboard
export const cachedStats = signal<any>(null);
export const cachedFiles = signal<any[]>([]);

// Evaluate
export const evalSelectedSessions = signal<Set<string>>(new Set());
export const evalSessionDetail = signal<any>(null);

// Quirks
export const quirkTypeFilter = signal<string | null>(null);

// UI
// Read the stored theme synchronously so the first paint already uses the
// right theme (see the inline script in index.html) — no wrong-theme flash.
export type ThemeName = "dark" | "light" | "plasma" | "drama";

function readStoredTheme(): ThemeName {
  if (typeof localStorage === "undefined") return "dark";
  const stored = localStorage.getItem("theme");
  return stored === "light" || stored === "plasma" || stored === "drama" ? stored : "dark";
}

export const theme = signal<ThemeName>(readStoredTheme());

/** Header-toggle order: dark → plasma → drama → light → dark. */
const THEME_ORDER: ThemeName[] = ["dark", "plasma", "drama", "light"];

/** Next theme in the header-toggle cycle. */
export function nextThemeName(current: ThemeName): ThemeName {
  return THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length] ?? "dark";
}
export const sidebarOpen = signal<boolean>(true);

// Sidebar resize (drag the border between file tree and main content)
export const SIDEBAR_WIDTH_DEFAULT = 256; // px — matches the previous fixed w-64
export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 560;
export const SIDEBAR_WIDTH_STEP = 16; // px per arrow-key press on the resize handle

/** Clamp a sidebar width to the supported range and whole pixels. */
export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)));
}

function readStoredSidebarWidth(): number {
  if (typeof localStorage === "undefined") return SIDEBAR_WIDTH_DEFAULT;
  const stored = Number(localStorage.getItem("sidebarWidth"));
  return Number.isFinite(stored) && stored > 0 ? clampSidebarWidth(stored) : SIDEBAR_WIDTH_DEFAULT;
}

/** Sidebar width in px. Applied to the DOM on change; persist with persistSidebarWidth(). */
export const sidebarWidth = signal<number>(readStoredSidebarWidth());

export function setSidebarWidth(width: number): void {
  sidebarWidth.value = clampSidebarWidth(width);
}

export function persistSidebarWidth(): void {
  try {
    localStorage.setItem("sidebarWidth", String(sidebarWidth.value));
  } catch {
    // Storage unavailable — the width still applies for this session.
  }
}

// Embeddings split (drag the handle between the plot and the selection details)
export const EMBED_PLOT_FRAC_DEFAULT = 0.62; // plot share of the split container
export const EMBED_PLOT_FRAC_MIN = 0.25;
export const EMBED_PLOT_FRAC_MAX = 0.85;
export const EMBED_PLOT_FRAC_STEP = 0.04; // fraction per arrow-key press

/** Clamp a plot fraction to the supported range. */
export function clampEmbedPlotFrac(frac: number): number {
  if (!Number.isFinite(frac)) return EMBED_PLOT_FRAC_DEFAULT;
  return Math.min(EMBED_PLOT_FRAC_MAX, Math.max(EMBED_PLOT_FRAC_MIN, frac));
}

function readStoredEmbedPlotFrac(): number {
  if (typeof localStorage === "undefined") return EMBED_PLOT_FRAC_DEFAULT;
  const stored = Number(localStorage.getItem("embedPlotFrac"));
  return Number.isFinite(stored) && stored > 0 ? clampEmbedPlotFrac(stored) : EMBED_PLOT_FRAC_DEFAULT;
}

/** Plot share of the embeddings split container. Applied to the DOM imperatively; persist with persistEmbedPlotFrac(). */
export const embedPlotFrac = signal<number>(readStoredEmbedPlotFrac());

export function setEmbedPlotFrac(frac: number): void {
  embedPlotFrac.value = clampEmbedPlotFrac(frac);
}

export function persistEmbedPlotFrac(): void {
  try {
    localStorage.setItem("embedPlotFrac", String(embedPlotFrac.value));
  } catch {
    // Storage unavailable — the fraction still applies for this session.
  }
}

export const toasts = signal<ToastMessage[]>([]);

let toastNextId = 0;

export function addToast(type: ToastMessage["type"], message: string, duration = 4000) {
  const id = toastNextId++;
  toasts.value = [...toasts.value, { id, type, message, duration }];
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, duration);
}

export function navigate(route: string) {
  window.location.hash = route;
}
