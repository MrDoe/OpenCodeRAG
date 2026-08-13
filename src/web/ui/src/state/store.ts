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
// Read the stored theme synchronously so a light-theme user never gets a
// dark flash before the effect runs.
export const theme = signal<"dark" | "light">(
  typeof localStorage !== "undefined"
    ? (localStorage.getItem("theme") as "dark" | "light" | null) ?? "dark"
    : "dark",
);
export const sidebarOpen = signal<boolean>(true);
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
