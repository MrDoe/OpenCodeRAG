/**
 * @fileoverview Package-manager detection for the setup and self-update flows.
 *
 * OpenCodeRAG is usually installed globally with npm, but users also install it
 * via pnpm, yarn, or bun. Earlier releases shelled out to `npm` directly and
 * failed with "/bin/sh: 1: npm: not found" on machines where npm is not on
 * PATH (GitHub issue #34). Every global-package operation now goes through
 * this module: it finds the package manager that actually owns the global
 * install and renders the equivalent commands for it
 * (`npm root -g` / `pnpm root -g` / `yarn global dir` / bun's fixed layout).
 */

import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Package managers with a working global-install mechanism that OpenCodeRAG supports. */
export type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";

/** Location of a global package install, independent of how it was installed. */
export interface GlobalInstall {
  /** Package manager that owns the install, or `null` when only the directory could be located. */
  pm: PackageManagerName | null;
  /** Absolute path of the global `node_modules` directory that contains the package. */
  globalRoot: string;
  /** Absolute path of the package directory itself (the one containing `dist/`). */
  packageDir: string;
}

/** Injectable seams so detection can be unit-tested without real package managers. */
export interface PackageManagerDeps {
  /** Command runner (defaults to `execSync` with utf-8 output). */
  exec?: (command: string, timeoutMs: number) => string;
  /** Existence check (defaults to `fs.existsSync`). */
  exists?: (filePath: string) => boolean;
  /** JSON file reader (defaults to read + JSON.parse). */
  readJson?: (filePath: string) => unknown;
  /** Environment to detect from (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
  /** Module path to derive a fallback install location from (defaults to this file). */
  selfPath?: string;
}

/** Default probe order when no signal identifies the owning package manager. */
const DEFAULT_ORDER: PackageManagerName[] = ["npm", "pnpm", "bun", "yarn"];

const EXEC_TIMEOUT_MS = 15_000;

/** Run a command and return trimmed stdout, or `null` on any failure. */
function tryRun(command: string, deps: PackageManagerDeps): string | null {
  try {
    const out = deps.exec
      ? deps.exec(command, EXEC_TIMEOUT_MS)
      : execSync(command, { encoding: "utf-8", timeout: EXEC_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
    const trimmed = out.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

interface PackageManagerSpec {
  name: PackageManagerName;
  /**
   * Absolute global `node_modules` directory for this manager, or `null` when
   * the manager is unavailable or (for Yarn Berry) has no global install mode.
   */
  globalRoot(deps: PackageManagerDeps): string | null;
  /** Shell command that installs `pkg` (optionally `name@version`) globally. */
  installCommand(pkg: string): string;
  /** Shell command that removes `pkg` from the global install. */
  uninstallCommand(pkg: string): string;
}

const SPECS: Record<PackageManagerName, PackageManagerSpec> = {
  npm: {
    name: "npm",
    globalRoot(deps) {
      return tryRun("npm root -g", deps);
    },
    installCommand(pkg) {
      return `npm install -g ${pkg} --no-fund --no-audit`;
    },
    uninstallCommand(pkg) {
      return `npm uninstall -g ${pkg}`;
    },
  },
  pnpm: {
    name: "pnpm",
    globalRoot(deps) {
      // Returns e.g. `~/.local/share/pnpm/global/v10/node_modules` on Linux or
      // `%LOCALAPPDATA%\pnpm\global\v10\node_modules` on Windows. Installed
      // packages are symlinks/junctions inside it, so existence checks follow.
      return tryRun("pnpm root -g", deps);
    },
    installCommand(pkg) {
      return `pnpm add -g ${pkg}`;
    },
    uninstallCommand(pkg) {
      return `pnpm remove -g ${pkg}`;
    },
  },
  yarn: {
    name: "yarn",
    globalRoot(deps) {
      // Yarn 1 ("classic") keeps globals in `<yarn global dir>/node_modules`.
      // Yarn Berry has no global installs and errors on `global` — the null
      // return makes callers skip it.
      const dir = tryRun("yarn global dir", deps);
      return dir ? path.join(dir, "node_modules") : null;
    },
    installCommand(pkg) {
      return `yarn global add ${pkg}`;
    },
    uninstallCommand(pkg) {
      return `yarn global remove ${pkg}`;
    },
  },
  bun: {
    name: "bun",
    globalRoot(deps) {
      // `bun pm` has no root query; the global layout is fixed at
      // `$BUN_INSTALL/install/global/node_modules` (default `~/.bun`).
      if (tryRun("bun --version", deps) === null) return null;
      const base = (deps.env ?? process.env).BUN_INSTALL || path.join(os.homedir(), ".bun");
      return path.join(base, "install", "global", "node_modules");
    },
    installCommand(pkg) {
      return `bun add -g ${pkg}`;
    },
    uninstallCommand(pkg) {
      return `bun remove -g ${pkg}`;
    },
  },
};

/** Package manager that started this process, from `npm_config_user_agent` (set by all four). */
function preferredFromEnv(deps: PackageManagerDeps): PackageManagerName | null {
  const ua = (deps.env ?? process.env).npm_config_user_agent ?? "";
  for (const name of DEFAULT_ORDER) {
    if (ua.startsWith(`${name}/`)) return name;
  }
  return null;
}

/**
 * Package manager implied by the running module's own path.
 *
 * A pnpm-global install lives under `…/pnpm/global/…/node_modules/.pnpm/…`,
 * a bun-global one under `~/.bun/install/global/…`, a Yarn classic global one
 * under `~/.config/yarn/global/…`. npm's global roots carry no such marker.
 */
function preferredFromSelfLocation(deps: PackageManagerDeps): PackageManagerName | null {
  let self: string;
  try {
    self = deps.selfPath ?? fileURLToPath(import.meta.url);
  } catch {
    return null;
  }
  const segments = self.toLowerCase().split(/[\\/]+/);
  if (segments.includes(".pnpm")) return "pnpm";
  for (const segment of segments) {
    if (segment === "pnpm") return "pnpm";
    if (segment === ".bun") return "bun";
    if (segment === "yarn") return "yarn";
  }
  return null;
}

/**
 * Candidate package managers, best guess first.
 *
 * Detection order: the manager that launched this process (user-agent), then
 * the manager implied by where this module is installed, then the default
 * probe order (npm, pnpm, bun, yarn).
 */
export function candidatePackageManagerOrder(deps: PackageManagerDeps = {}): PackageManagerName[] {
  const preferred = preferredFromEnv(deps) ?? preferredFromSelfLocation(deps);
  if (!preferred) return [...DEFAULT_ORDER];
  return [preferred, ...DEFAULT_ORDER.filter((name) => name !== preferred)];
}

/** The first package manager whose global root can be resolved (availability probe). */
export function bestAvailablePackageManager(deps: PackageManagerDeps = {}): PackageManagerName | null {
  for (const name of candidatePackageManagerOrder(deps)) {
    if (SPECS[name].globalRoot(deps) !== null) return name;
  }
  return null;
}

/** Shell command that globally installs `pkg` with the given manager. */
export function globalInstallCommand(pm: PackageManagerName, pkg: string): string {
  return SPECS[pm].installCommand(pkg);
}

/** Shell command that globally removes `pkg` with the given manager. */
export function globalUninstallCommand(pm: PackageManagerName, pkg: string): string {
  return SPECS[pm].uninstallCommand(pkg);
}

/**
 * Human-friendly install hint using the most likely manager for this machine
 * (falls back to npm when nothing can be detected, e.g. npm-less CI probes).
 */
export function installHint(pkg: string, deps: PackageManagerDeps = {}): string {
  const preferred = preferredFromEnv(deps) ?? preferredFromSelfLocation(deps) ?? bestAvailablePackageManager(deps);
  return SPECS[preferred ?? "npm"].installCommand(pkg);
}

/**
 * Locate the global install of `pluginName` and the package manager that owns it.
 *
 * Strategy: ask each candidate manager for its global root and check whether
 * the package sits there. When no package-manager CLI works at all (the
 * issue-#34 case: pnpm install, npm missing), fall back to deriving the
 * location from this module's own resolved path — the running CLI *is* the
 * installed package, so its real path identifies the install even without any
 * package manager on PATH.
 *
 * @param pluginName - npm package name to look for (e.g. `opencode-rag-plugin`).
 * @param deps - Test seams; leave empty in production.
 * @returns The resolved install, or `null` when the package is not globally installed.
 */
export function resolveGlobalInstall(pluginName: string, deps: PackageManagerDeps = {}): GlobalInstall | null {
  for (const name of candidatePackageManagerOrder(deps)) {
    const root = SPECS[name].globalRoot(deps);
    if (!root) continue;
    const packageDir = path.join(root, pluginName);
    if ((deps.exists ?? existsSync)(packageDir)) {
      return { pm: name, globalRoot: root, packageDir };
    }
  }
  return deriveFromSelfLocation(pluginName, deps);
}

/**
 * Derive `{ globalRoot, packageDir }` by walking up from this module's path to
 * the package.json that names `pluginName`, then to the shallowest
 * `node_modules` ancestor that still contains the package (for pnpm that is
 * the outer global root, not the `.pnpm` store directory).
 */
function deriveFromSelfLocation(pluginName: string, deps: PackageManagerDeps): GlobalInstall | null {
  const exists = deps.exists ?? existsSync;
  const readJson = deps.readJson ?? ((filePath: string): unknown => JSON.parse(readFileSync(filePath, "utf-8")));

  let self: string;
  try {
    self = deps.selfPath ?? fileURLToPath(import.meta.url);
    // Resolve junctions/symlinks so a runtime-dir junction points at the real
    // global install instead of back at `~/.opencode/node_modules`.
    if (!deps.selfPath) self = realpathSync(self);
  } catch {
    return null;
  }

  let dir = path.dirname(self);
  for (let depth = 0; depth < 24; depth++) {
    const pkgJson = path.join(dir, "package.json");
    if (exists(pkgJson)) {
      let name: unknown;
      try {
        name = (readJson(pkgJson) as { name?: unknown }).name;
      } catch {
        name = undefined;
      }
      if (name === pluginName) {
        let globalRoot: string | null = null;
        let probe = dir;
        let parent = path.dirname(probe);
        while (parent !== probe) {
          if (path.basename(probe) === "node_modules" && exists(path.join(probe, pluginName))) {
            globalRoot = probe;
          }
          probe = parent;
          parent = path.dirname(probe);
        }
        if (globalRoot) {
          return { pm: null, globalRoot, packageDir: dir };
        }
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
