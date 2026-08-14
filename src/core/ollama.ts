/**
 * @fileoverview Shared Ollama request-body helpers.
 */

/**
 * Ollama's `keep_alive` field accepts either a duration string with a unit
 * (e.g. "30m", "24h") or a bare integer (e.g. -1 for keep-in-memory forever,
 * 0 to unload immediately). A bare integer passed as a string (e.g. "-1")
 * fails server-side with `time: missing unit in duration "-1"`.
 *
 * Returns the numeric form for bare integers and passes other strings through
 * unchanged.
 */
export function normalizeKeepAlive(keepAlive?: string): string | number | undefined {
  if (keepAlive === undefined || keepAlive === "") {
    return undefined;
  }
  if (/^-?\d+$/.test(keepAlive)) {
    return Number(keepAlive);
  }
  return keepAlive;
}
