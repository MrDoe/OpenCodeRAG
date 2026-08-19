import { useRouter } from "./hooks/useRouter";
import { useTheme } from "./hooks/useTheme";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { sidebarOpen, currentView } from "./state/store";
import { ToastContainer } from "./components/Toast";
import { ThemeToggle } from "./components/ThemeToggle";
import { GlobalSearch } from "./components/GlobalSearch";
import { FileTree } from "./components/FileTree";
import { ScopeSelector } from "./components/ScopeSelector";

import { Dashboard } from "./views/Dashboard";
import { Chunks } from "./views/Chunks";
import { Files } from "./views/Files";
import { Evaluate } from "./views/Evaluate";
import { Quirks } from "./views/Quirks";
import { Search } from "./views/Search";
import { Compare } from "./views/Compare";
import { Config } from "./views/Config";
import { Embeddings } from "./views/Embeddings";

const NAV_ITEMS = [
  { view: "dashboard", label: "Dashboard", icon: "📊" },
  { view: "search", label: "Search", icon: "🔍" },
  { view: "embeddings", label: "Embeddings", icon: "🌐" },
  { view: "chunks", label: "Chunks", icon: "🧩" },
  { view: "files", label: "Files", icon: "📄" },
  { view: "evaluate", label: "Evaluate", icon: "📈" },
  { view: "quirks", label: "Quirks", icon: "💡" },
];

export function App() {
  useTheme();
  useKeyboardShortcuts();
  const route = useRouter();

  // Sync currentView with route
  currentView.value = route.view;

  const toggleSidebar = () => {
    sidebarOpen.value = !sidebarOpen.value;
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-2 border-b shrink-0" style={{ borderColor: "var(--border)" }}>
        <h1 className="text-lg font-bold shrink-0" style={{ color: "var(--accent)" }}>OpenCodeRAG</h1>
        <nav className="flex gap-1 flex-1" role="navigation" aria-label="Main navigation">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.view}
              id={`nav-${item.view}`}
              className={`nav-btn ${currentView.value === item.view ? "active" : ""}`}
              onClick={() => window.location.hash = item.view}
              role="tab"
              aria-selected={currentView.value === item.view}
            >
              {item.icon} {item.label}
            </button>
          ))}
        </nav>
        <GlobalSearch />
        <ThemeToggle />
        <button
          className="p-2 rounded-lg transition-colors hidden lg:block"
          style={{ color: "var(--text-muted)" }}
          onClick={toggleSidebar}
          aria-label="Toggle file tree"
          title="Toggle file tree"
        >
          ☰
        </button>
        {/* Mobile sidebar toggle */}
        <button
          className="p-2 rounded-lg transition-colors lg:hidden"
          style={{ color: "var(--text-muted)" }}
          onClick={toggleSidebar}
          aria-label="Toggle file tree"
          title="Toggle file tree"
        >
          ☰
        </button>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        {sidebarOpen.value && (
          <>
            {/* Mobile overlay */}
            <div
              className="fixed inset-0 z-30 lg:hidden"
              style={{ background: "rgba(0,0,0,0.5)" }}
              onClick={() => { sidebarOpen.value = false; }}
            />
            <aside
              className="w-64 overflow-y-auto shrink-0 border-r z-40 fixed lg:relative inset-y-0 left-0"
              style={{ background: "var(--bg-secondary)", borderColor: "var(--border)" }}
              role="tree"
              aria-label="File tree"
            >
              <ScopeSelector />
              <FileTree />
            </aside>
          </>
        )}

        {/* Main content */}
        <main className="flex-1 overflow-y-auto p-6" id="main-content" tabIndex={-1}>
          {route.view === "dashboard" && <Dashboard />}
          {route.view === "search" && <Search />}
          {route.view === "embeddings" && <Embeddings />}
          {route.view === "compare" && <Compare />}
          {route.view === "chunks" && <Chunks />}
          {route.view === "files" && <Files />}
          {route.view === "evaluate" && <Evaluate />}
          {route.view === "quirks" && <Quirks />}
          {route.view === "config" && <Config />}
        </main>
      </div>

      <ToastContainer />
    </div>
  );
}
