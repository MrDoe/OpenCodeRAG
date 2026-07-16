/**
 * @fileoverview Version check and self-update functionality. Checks GitHub
 * releases for new versions and installs the newest version via npm, then
 * re-syncs the OpenCode runtime junctions.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { setupRuntime } from "./setup-runtime.js";

/** npm package name (must match the `name` field in package.json). */
const PACKAGE_NAME = "opencode-rag-plugin";
/** GitHub repo used for release checks (owner/repo). */
const GITHUB_REPO = "MrDoe/OpenCodeRAG";
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

/** Information about an available update. */
export interface UpdateInfo {
  /** The currently installed version string. */
  currentVersion: string;
  /** The latest available version on GitHub. */
  latestVersion: string;
  /** Whether a newer version than the current one exists. */
  updateAvailable: boolean;
  /** URL to the GitHub release page. */
  releaseUrl: string;
  /** ISO date string of when the release was published. */
  publishedAt: string;
}

/** Result of an install-update attempt. */
export interface InstallUpdateResult {
  /** Whether the install completed successfully. */
  success: boolean;
  /** Human-readable status message. */
  message: string;
  /** Version before the update. */
  fromVersion: string;
  /** Version after the update (undefined if the install failed). */
  toVersion?: string;
}

/** Callable shape for the npm runner (a subset of execSync's signature). */
type NpmRunner = (command: string, options: { stdio: "inherit" | "pipe"; timeout: number }) => unknown;

/**
 * Read the current version from the package.json sitting next to this module.
 *
 * Resolves the package root via `import.meta.url` so it works both from the
 * source tree and from the compiled `dist/` output. Returns `"0.0.0"` if the
 * file cannot be read or parsed (best-effort — never throws).
 *
 * @returns The current package version string.
 */
export function getCurrentVersion(): string {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8") as string) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Strip a leading 'v' or 'V' prefix from a version tag. */
function normalizeVersion(tag: string): string {
  return tag.replace(/^v/i, "");
}

/**
 * Compare two semver-ish strings.
 * @returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((s) => parseInt(s, 10));
  const pb = b.split(".").map((s) => parseInt(s, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * Check the GitHub releases API for a newer version of OpenCodeRAG.
 *
 * Uses a 5-second timeout; failures (network errors, non-OK responses, missing
 * `tag_name`) are silently caught and reported as "no update available" so the
 * caller never has to handle a rejection.
 *
 * @param currentVersion - The version string to compare against.
 * @returns UpdateInfo indicating whether an update is available.
 */
export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const response = await fetch(GITHUB_API_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "opencode-rag-updater",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return { currentVersion, latestVersion: currentVersion, updateAvailable: false, releaseUrl: "", publishedAt: "" };
    }

    const data = (await response.json()) as { tag_name?: string; html_url?: string; published_at?: string };
    const tagName = data.tag_name;
    if (!tagName) {
      return { currentVersion, latestVersion: currentVersion, updateAvailable: false, releaseUrl: "", publishedAt: "" };
    }

    const latestVersion = normalizeVersion(tagName);
    return {
      currentVersion,
      latestVersion,
      updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
      releaseUrl: data.html_url ?? "",
      publishedAt: data.published_at ?? "",
    };
  } catch {
    return { currentVersion, latestVersion: currentVersion, updateAvailable: false, releaseUrl: "", publishedAt: "" };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Install the newest published version of OpenCodeRAG.
 *
 * Runs `npm install -g <package>@latest` to refresh the global install, then
 * calls {@link setupRuntime} with `force: true` to re-create the
 * `~/.opencode/node_modules/` junctions so OpenCode picks up the new build on
 * the next restart.
 *
 * @param options - Optional verbosity flag. When `verbose` is true, npm output
 *   is streamed to the console; otherwise it is captured silently. The
 *   `_execSync` and `_setupRuntime` seams are for testing only.
 * @returns An {@link InstallUpdateResult} with success status, message, and the
 *   from/to versions.
 */
export async function installLatestUpdate(options?: {
  verbose?: boolean;
  /** Test seam: override the npm runner. */
  _execSync?: NpmRunner;
  /** Test seam: override the runtime sync. */
  _setupRuntime?: typeof setupRuntime;
  /** Test seam: override the version reader for the "to" version. */
  _getCurrentVersion?: typeof getCurrentVersion;
}): Promise<InstallUpdateResult> {
  const verbose = options?.verbose ?? false;
  const stdio: "inherit" | "pipe" = verbose ? "inherit" : "pipe";
  const run: NpmRunner = options?._execSync ?? execSync;
  const syncRuntime = options?._setupRuntime ?? setupRuntime;
  const readVersion = options?._getCurrentVersion ?? getCurrentVersion;
  const fromVersion = readVersion();

  try {
    run(`npm install -g ${PACKAGE_NAME}@latest --no-fund --no-audit`, {
      stdio,
      timeout: 120_000,
    });
  } catch (err) {
    return {
      success: false,
      message: `npm install failed: ${(err as Error).message}`,
      fromVersion,
    };
  }

  const toVersion = readVersion();
  const result = await syncRuntime({ force: true, silent: !verbose, version: toVersion });
  if (!result.success) {
    return {
      success: false,
      message: `installed v${toVersion} but runtime sync failed: ${result.errors.join("; ")}. Run \`opencode-rag setup\` to retry.`,
      fromVersion,
      toVersion,
    };
  }

  if (compareVersions(toVersion, fromVersion) <= 0) {
    return {
      success: true,
      message: `Already up-to-date (v${toVersion}). Runtime re-synced.`,
      fromVersion,
      toVersion,
    };
  }

  return {
    success: true,
    message: `Updated v${fromVersion} → v${toVersion}. Restart OpenCode to load the new version.`,
    fromVersion,
    toVersion,
  };
}
