/**
 * Unit tests for package-manager detection (GitHub issue #34: setup/update
 * must work with pnpm/yarn/bun installs, even when npm is not on PATH).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  bestAvailablePackageManager,
  candidatePackageManagerOrder,
  globalInstallCommand,
  globalUninstallCommand,
  installHint,
  resolveGlobalInstall,
  type PackageManagerDeps,
} from "../../core/package-manager.js";

/** Neutral self path with no package-manager path markers (keeps tests machine-independent). */
const NEUTRAL_SELF = path.join(path.sep + "opt", "some-app", "src", "core", "package-manager.js");

/** Build an exec seam from a map of command-prefix → stdout; missing/null entries throw. */
function fakeExec(results: Record<string, string | null>): NonNullable<PackageManagerDeps["exec"]> {
  return (command: string): string => {
    for (const [prefix, output] of Object.entries(results)) {
      if (command.startsWith(prefix)) {
        if (output === null) break;
        return output;
      }
    }
    throw new Error(`/bin/sh: 1: ${command.split(" ")[0]}: not found`);
  };
}

/** Build an exists seam from a set of absolute paths. */
function fakeExists(paths: string[]): NonNullable<PackageManagerDeps["exists"]> {
  const set = new Set(paths);
  return (filePath: string): boolean => set.has(filePath);
}

describe("candidatePackageManagerOrder", () => {
  it("prefers the manager from npm_config_user_agent", () => {
    assert.equal(
      candidatePackageManagerOrder({ env: { npm_config_user_agent: "pnpm/9.1.0 npm/? node/v20.0.0" }, selfPath: NEUTRAL_SELF })[0],
      "pnpm",
    );
    assert.equal(
      candidatePackageManagerOrder({ env: { npm_config_user_agent: "yarn/1.22.19 npm/? node/v20.0.0" }, selfPath: NEUTRAL_SELF })[0],
      "yarn",
    );
    assert.equal(
      candidatePackageManagerOrder({ env: { npm_config_user_agent: "bun/1.2.0", npm_execpath: "" }, selfPath: NEUTRAL_SELF })[0],
      "bun",
    );
    assert.equal(
      candidatePackageManagerOrder({ env: { npm_config_user_agent: "npm/10.2.3 node/v20.0.0" }, selfPath: NEUTRAL_SELF })[0],
      "npm",
    );
  });

  it("prefers the manager implied by the install path when env gives nothing", () => {
    const pnpmSelf = path.join(path.sep + "home", "u", ".local", "share", "pnpm", "global", "v10", "node_modules", ".pnpm", "x@1", "node_modules", "x", "dist", "pm.js");
    assert.equal(candidatePackageManagerOrder({ env: {}, selfPath: pnpmSelf })[0], "pnpm");
    const bunSelf = path.join(path.sep + "home", "u", ".bun", "install", "global", "node_modules", "x", "dist", "pm.js");
    assert.equal(candidatePackageManagerOrder({ env: {}, selfPath: bunSelf })[0], "bun");
  });

  it("falls back to the default probe order when nothing is detectable", () => {
    assert.deepEqual(candidatePackageManagerOrder({ env: {}, selfPath: NEUTRAL_SELF }), ["npm", "pnpm", "bun", "yarn"]);
  });
});

describe("global install/uninstall commands", () => {
  it("renders a command per package manager", () => {
    assert.equal(globalInstallCommand("npm", "opencode-rag-plugin@latest"), "npm install -g opencode-rag-plugin@latest --no-fund --no-audit");
    assert.equal(globalInstallCommand("pnpm", "opencode-rag-plugin@latest"), "pnpm add -g opencode-rag-plugin@latest");
    assert.equal(globalInstallCommand("yarn", "opencode-rag-plugin@latest"), "yarn global add opencode-rag-plugin@latest");
    assert.equal(globalInstallCommand("bun", "opencode-rag-plugin@latest"), "bun add -g opencode-rag-plugin@latest");
    assert.equal(globalUninstallCommand("npm", "opencode-rag-plugin"), "npm uninstall -g opencode-rag-plugin");
    assert.equal(globalUninstallCommand("pnpm", "opencode-rag-plugin"), "pnpm remove -g opencode-rag-plugin");
    assert.equal(globalUninstallCommand("yarn", "opencode-rag-plugin"), "yarn global remove opencode-rag-plugin");
    assert.equal(globalUninstallCommand("bun", "opencode-rag-plugin"), "bun remove -g opencode-rag-plugin");
  });

  it("installHint uses the launching manager", () => {
    const hint = installHint("opencode-rag-plugin", {
      env: { npm_config_user_agent: "pnpm/9.1.0 npm/? node/v20.0.0" },
      selfPath: NEUTRAL_SELF,
    });
    assert.equal(hint, "pnpm add -g opencode-rag-plugin");
  });
});

describe("resolveGlobalInstall", () => {
  it("finds a pnpm global install when npm is missing (issue #34)", () => {
    const pnpmRoot = path.join(path.sep + "home", "u", ".local", "share", "pnpm", "global", "v10", "node_modules");
    const deps: PackageManagerDeps = {
      env: {},
      selfPath: NEUTRAL_SELF,
      exec: fakeExec({
        "pnpm root -g": `${pnpmRoot}\n`,
        "yarn global dir": null,
        "bun --version": null,
        // npm not in map → throws like a machine without npm on PATH
      }),
      exists: fakeExists([path.join(pnpmRoot, "opencode-rag-plugin")]),
    };
    const install = resolveGlobalInstall("opencode-rag-plugin", deps);
    assert.ok(install);
    assert.equal(install.pm, "pnpm");
    assert.equal(install.globalRoot, pnpmRoot);
    assert.equal(install.packageDir, path.join(pnpmRoot, "opencode-rag-plugin"));
  });

  it("skips Yarn Berry (no global dir) without failing", () => {
    const deps: PackageManagerDeps = {
      env: {},
      selfPath: NEUTRAL_SELF,
      exec: fakeExec({
        "npm root -g": null,
        "pnpm root -g": null,
        "bun --version": null,
        "yarn global dir": null, // Berry errors on `global`
      }),
      exists: () => false,
    };
    assert.equal(resolveGlobalInstall("opencode-rag-plugin", deps), null);
  });

  it("uses $BUN_INSTALL for bun's fixed global layout", () => {
    const root = path.join(path.sep + "opt", "bunhome", "install", "global", "node_modules");
    const deps: PackageManagerDeps = {
      env: { BUN_INSTALL: path.join(path.sep + "opt", "bunhome"), npm_config_user_agent: "bun/1.2.0" },
      selfPath: NEUTRAL_SELF,
      exec: fakeExec({
        "bun --version": "1.2.0\n",
        "npm root -g": null,
        "pnpm root -g": null,
        "yarn global dir": null,
      }),
      exists: fakeExists([path.join(root, "opencode-rag-plugin")]),
    };
    const install = resolveGlobalInstall("opencode-rag-plugin", deps);
    assert.ok(install);
    assert.equal(install.pm, "bun");
    assert.equal(install.globalRoot, root);
  });

  it("derives the install location from itself when no package manager CLI exists", () => {
    // Real pnpm global layout after `pnpm add -g`: the outer global root holds
    // a symlink; the real dir lives inside the .pnpm store.
    const outerRoot = path.join(path.sep + "home", "u", "AppData", "Local", "pnpm", "global", "v10", "node_modules");
    const packageDir = path.join(outerRoot, ".pnpm", "opencode-rag-plugin@2.3.0", "node_modules", "opencode-rag-plugin");
    const selfPath = path.join(packageDir, "dist", "core", "package-manager.js");
    const pkgJson = path.join(packageDir, "package.json");
    const deps: PackageManagerDeps = {
      env: {},
      selfPath,
      exec: fakeExec({}), // every manager unavailable
      exists: fakeExists([
        pkgJson,
        path.join(outerRoot, "opencode-rag-plugin"), // outer symlink
        path.join(outerRoot, ".pnpm", "opencode-rag-plugin@2.3.0", "node_modules", "opencode-rag-plugin"), // inner
      ]),
      readJson: (filePath: string): unknown => {
        assert.equal(filePath, pkgJson);
        return { name: "opencode-rag-plugin", version: "2.3.0" };
      },
    };
    const install = resolveGlobalInstall("opencode-rag-plugin", deps);
    assert.ok(install);
    assert.equal(install.pm, null);
    assert.equal(install.globalRoot, outerRoot, "must resolve the OUTER global root, not the .pnpm store dir");
    assert.equal(install.packageDir, packageDir);
  });
});

describe("bestAvailablePackageManager", () => {
  it("returns the first manager whose global root resolves", () => {
    const pnpmRoot = path.join(path.sep + "srv", "pnpm", "global", "v10", "node_modules");
    const pm = bestAvailablePackageManager({
      env: {},
      selfPath: NEUTRAL_SELF,
      exec: fakeExec({ "pnpm root -g": pnpmRoot }),
      exists: () => false,
    });
    assert.equal(pm, "pnpm");
  });

  it("returns null when every manager is unavailable", () => {
    const pm = bestAvailablePackageManager({
      env: {},
      selfPath: NEUTRAL_SELF,
      exec: fakeExec({}),
      exists: () => false,
    });
    assert.equal(pm, null);
  });
});
