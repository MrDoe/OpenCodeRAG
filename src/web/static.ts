/**
 * @fileoverview Static HTML file reader and cache for the Web UI entry page.
 * Supports both the Vite production build output and the development source.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the project root directory regardless of whether running from source (tsx)
 * or compiled output (dist/). The static.ts module lives at src/web/static.ts or
 * dist/web/static.ts, so going up two directories reaches the project root.
 */
function projectRoot(): string {
  return resolve(__dirname, "..", "..");
}

let cachedHtml: string | null = null;

/**
 * Read and cache the Web UI `index.html` from disk.
 *
 * Reads from the Vite production build output (`dist/web/ui/index.html`).
 * There is deliberately NO fallback to `src/web/ui/index.html`: the dev
 * source references `/src/main.tsx`, which the embedded server does not
 * serve — a "working" fallback would render a blank page. Use
 * `npm run build` (or `npm run dev:ui` with the Vite dev server) instead.
 *
 * @returns The full HTML string of the Web UI entry page.
 */
export function getStaticHtml(): string {
  if (cachedHtml) return cachedHtml;

  const root = projectRoot();
  const prodPath = join(root, "dist", "web", "ui", "index.html");
  if (!existsSync(prodPath)) {
    throw new Error(
      "Web UI not built — run `npm run build` (or use `npm run dev:ui` with the Vite dev server).",
    );
  }

  cachedHtml = readFileSync(prodPath, "utf-8");
  return cachedHtml;
}

/**
 * Resolve the path to a built UI asset from the Vite output directory.
 * Returns null if the path escapes the dist directory or does not exist.
 */
export function resolveDistAsset(path: string): string | null {
  const root = projectRoot();
  const distDir = join(root, "dist", "web", "ui").replace(/\\/g, "/");
  const resolved = join(distDir, path).replace(/\\/g, "/");
  if (!resolved.startsWith(distDir + "/")) return null;
  return existsSync(resolved) ? resolved : null;
}
