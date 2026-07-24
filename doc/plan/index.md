# Web UI — Next Level Implementation Plan

## Overview

This plan transforms the OpenCodeRAG Web UI from a 1639-line monolith into a modular, professional-grade dashboard that exposes the full power of the RAG pipeline. Six phases, ~20-24 days total.

## Architecture Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Frontend framework | **Preact** + Vite | Lightweight (~3KB), React-compatible, hooks for complex state (search playground, embedding explorer). JSX enables clean component composition. |
| Build tool | **Vite** | Zero-config Preact preset, built-in PostCSS/Tailwind, HMR for dev, efficient production builds. |
| State management | **Preact Signals** | Fine-grained reactivity without virtual DOM overhead. Ideal for real-time search results and dashboard data. |
| Routing | **Hash-based** | `#/search?query=auth&topK=10` — no server-side routing needed, back/forward works, shareable URLs. |
| Embedding projection | **PCA (self-implemented)** | ~100 lines of TS. Simple, no deps, fast. Good enough for an overview visualization. |
| Embedder lifecycle | **Lazy-init** on first `/api/retrieve` call | No startup delay for non-search views. Initialization indicator shown to user. |
| Styling | **Tailwind CSS** (already in use) | Keep existing setup, extend with CSS variables for light/dark theme. |

## Dependency Graph

```
Phase 0 (Critical Fixes) ─────┐
                              ▼
Phase 1 (Architecture) ───────────────────────┐
                    │                         │
                    ▼                         ▼
         Phase 2 (Search)          Phase 3 (Compare)
                    │
         ┌──────────┴──────────┐
         ▼                     ▼
Phase 4 (Indexing)    Phase 5 (Embeddings)
                              │
                              ▼
                    Phase 6 (UX Polish)  ← can start after Phase 1
```

## Phases Summary

| Phase | Title | Duration | Impact |
|---|---|---|---|
| 0 | [Critical Fixes](phase-0-critical-fixes.md) | 1 day | Security, correctness |
| 1 | [Preact + Vite Architecture Refactor](phase-1-architecture-refactor.md) | 6 days | Foundation for everything |
| 2 | [Semantic Search Playground](phase-2-search-playground.md) | 4 days | **Highest user impact** |
| 3 | [Chunk Comparison View](phase-3-chunk-comparison.md) | 1 day | Fix doc drift |
| 4 | [Indexing & Health Dashboard](phase-4-indexing-dashboard.md) | 3 days | Operational visibility |
| 5 | [Embedding Space Explorer](phase-5-embedding-explorer.md) | 4 days | Unique "wow" feature |
| 6 | [UX Polish & Accessibility](phase-6-ux-polish.md) | 3 days | Production quality |

## New Directory Structure (after Phase 1)

```
src/web/
  server.ts                    HTTP server — serves dist/web/ui/index.html + API
  api.ts                       REST API — expands with /retrieve, /indexing, /config, /embeddings
  static.ts                    Serves built assets from dist/web/ui/
  pca.ts                       NEW — lightweight PCA implementation (~100 lines)
  ui/                          Frontend source (consumed by Vite)
    vite.config.ts
    index.html                 Minimal shell
    tsconfig.json              Frontend TS config (DOM libs, jsx: preserve)
    tailwind.config.js         Updated: scan src/**/*.{tsx,ts}
    postcss.config.js
    src/
      main.tsx                 Entry: render <App/>
      App.tsx                  Shell: layout, router, theme, keyboard shortcuts
      components/              Reusable UI: KpiCard, Badge, DataTable, Toast, ScoreBar, FileTree, GlobalSearch
      charts/                  SVG chart components: BarChart, DonutChart, ScatterPlot, ChartUtils
      views/                   Page-level components per view
      hooks/                   useApi, useDebounce, useRouter, useTheme, useKeyboardShortcuts
      state/store.ts           Preact signals-based global store
      lib/api.ts               API client (extracted from inline object)
      lib/format.ts            Formatting utilities
      lib/escape.ts            Fixed escapeHtml
      lib/langColors.ts        Language → color mappings
      lib/kmeans.ts            Simple k-means for clustering in embedding explorer
```

## First-Time Reader Guide

- **Plan author**: Christoph Döllinger (OpenCodeRAG maintainer)
- **Current UI state**: `src/web/ui/index.html` — 1639 lines, inline vanilla JS SPA
- **Before starting Phase 1**: read `doc/webui.md` to understand current feature set
- **Key constraint**: preserve 100% feature parity through Phase 1 (architecture is pure migration)
