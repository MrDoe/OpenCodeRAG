/**
 * @fileoverview Cross-platform helper for opening a URL in the user's default browser.
 */

import { spawn } from "node:child_process";

/**
 * Open a URL in the system default browser.
 *
 * Spawns the platform launcher detached so it outlives the CLI process:
 * `cmd.exe /c start` on Windows, `open` on macOS and `xdg-open` elsewhere.
 * Every spawn passes `windowsHide: true` — the plugin also runs inside
 * OpenCode's console-less service, where an un-hidden spawn flashes a
 * terminal window per call.
 *
 * The returned promise resolves once the launcher process either spawned or
 * failed (a missing `xdg-open` emits an `error` event rather than throwing),
 * so callers can tell "no browser available" from "browser opened".
 *
 * @param url - Absolute URL to open.
 * @returns `true` when the launcher process was spawned, `false` otherwise.
 */
export async function openInBrowser(url: string): Promise<boolean> {
  try {
    // The empty title argument keeps `start` from treating the URL as the
    // window title on Windows.
    const child =
      process.platform === "win32"
        ? spawn("cmd.exe", ["/c", "start", "", url], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          })
        : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          });

    const spawned = await new Promise<boolean>((resolve) => {
      child.once("spawn", () => resolve(true));
      child.once("error", () => resolve(false));
    });
    child.unref();
    return spawned;
  } catch {
    // `spawn` throws synchronously only for invalid arguments — treat any
    // throw as "could not open a browser".
    return false;
  }
}
