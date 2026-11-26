/**
 * @fileoverview Bind-address resolution for the Web UI server.
 *
 * The dashboard binds to loopback by default. Container and port-forward
 * setups need a wider bind address (`0.0.0.0` / `::`), which is exposed as
 * `ui.host` in the config and `-a, --address` on the CLI (issue #42).
 */

import { networkInterfaces } from "node:os";

/** The default bind address: loopback only. */
export const DEFAULT_UI_HOST = "127.0.0.1";

/** True for the wildcard bind addresses (`0.0.0.0`, `::`, `[::]`). */
export function isWildcardHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]";
}

/**
 * Resolve the host to bind to: explicit CLI value first, then the configured
 * value, then loopback. Blank values are ignored so `--address ""` cannot
 * silently bind every interface.
 */
export function resolveUiBindHost(cliHost?: string, configuredHost?: string): string {
  const candidate = cliHost?.trim() || configuredHost?.trim();
  return candidate && candidate.length > 0 ? candidate : DEFAULT_UI_HOST;
}

/** Wrap an IPv6 literal for use in a URL authority. */
function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Every URL a user can reach the dashboard on, loopback first and without
 * duplicate addresses. A wildcard bind also lists the machine's non-internal
 * IPv4 addresses, so the printed URL is usable from the host / LAN instead of
 * pointing at the container's loopback.
 */
export function uiBaseUrls(host: string, port: number): string[] {
  if (!isWildcardHost(host)) {
    return [`http://${formatHostForUrl(host)}:${port}`];
  }
  const urls = [`http://127.0.0.1:${port}`];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const info of addresses ?? []) {
      if (info.family === "IPv4" && !info.internal) {
        urls.push(`http://${info.address}:${port}`);
      }
    }
  }
  return [...new Set(urls)];
}
