import path from "node:path";
import os from "node:os";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  lstatSync,
} from "node:fs";
import { execSync } from "node:child_process";
import {
  bestAvailablePackageManager,
  globalInstallCommand,
  installHint,
  resolveGlobalInstall,
  type GlobalInstall,
} from "./package-manager.js";

const PLUGIN_NAME = "opencode-rag-plugin";

export interface SetupResult {
  success: boolean;
  errors: string[];
}

export function getRuntimeDir(): string {
  return path.join(os.homedir(), ".opencode");
}

function createJunction(targetPath: string, linkPath: string): void {
  const type = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(targetPath, linkPath, type);
}

function removeIfExists(targetPath: string): void {
  if (existsSync(targetPath)) {
    rmSync(targetPath, { recursive: true, force: true });
  }
}

export function getVersionFile(runtimeDir: string): string {
  return path.join(runtimeDir, ".bundle-version");
}

export function readVersionFile(versionFile: string): string | null {
  try {
    return readFileSync(versionFile, "utf-8").trim();
  } catch {
    return null;
  }
}

/** Bin name npm generates for this package (without .cmd/.ps1). */
function getBinName(packageDir: string): string {
  const pkgJson = path.join(packageDir, "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgJson, "utf-8")) as { bin?: Record<string, string> | string };
    if (pkg.bin && typeof pkg.bin === "object") {
      return Object.keys(pkg.bin)[0] ?? PLUGIN_NAME;
    }
    if (typeof pkg.bin === "string") {
      return PLUGIN_NAME;
    }
  } catch {
    // fall through
  }
  return PLUGIN_NAME;
}

/**
 * npm-generated .cmd / .ps1 wrappers on Windows invoke `.js` files directly
 * via file association. If the `.js` association points to a text editor
 * (e.g. Notepad++) instead of Node.js, the CLI opens the editor instead of
 * running. This function patches the wrappers to call `node` explicitly.
 *
 * npm only: pnpm/bun/yarn shims already invoke `node` explicitly, and their
 * global bin directories are not laid out relative to the global root the way
 * npm's are (`<prefix>\node_modules` next to `<prefix>`). Runs only on
 * Windows; safe to call on every setup — detects already-patched wrappers by
 * checking for the `node` prefix.
 */
export function patchWindowsWrappers(install: GlobalInstall): void {
  if (process.platform !== "win32") return;
  if (install.pm !== "npm") return;

  const binDir = path.resolve(install.globalRoot, "..");
  const binName = getBinName(install.packageDir);

  // ── .cmd wrapper ──────────────────────────────────────────────
  const cmdFile = path.join(binDir, `${binName}.cmd`);
  if (existsSync(cmdFile)) {
    const content = readFileSync(cmdFile, "utf-8");
    // npm generates: "%dp0%\node_modules\opencode-rag-plugin\dist\cli\index.js"   %*
    // We want:       node "%dp0%\node_modules\opencode-rag-plugin\dist\cli\index.js"   %*
    const cmdJsLine = /^(?!node\s)("[^"]+\.js"\s+%\*)$/m;
    if (cmdJsLine.test(content)) {
      const patched = content.replace(cmdJsLine, "node $1");
      writeFileSync(cmdFile, patched, "utf-8");
    }
  }

  // ── PowerShell wrapper ────────────────────────────────────────
  const ps1File = path.join(binDir, `${binName}.ps1`);
  if (existsSync(ps1File)) {
    let content = readFileSync(ps1File, "utf-8");
    // Skip if already patched
    if (content.includes('node "$basedir')) return;
    // npm generates:
    //   $input | & "$basedir/node_modules/.../index.js"   $args
    //   & "$basedir/node_modules/.../index.js"   $args
    // Replace to: & node "$basedir/.../index.js"   $args
    const ps1DirectLine = /(&\s+)("\$basedir\/[^"]+\.js"\s+\$args)/g;
    if (ps1DirectLine.test(content)) {
      content = content.replace(ps1DirectLine, "$1node $2");
      writeFileSync(ps1File, content, "utf-8");
    }
  }
}

export async function setupRuntime(options?: {
  force?: boolean;
  silent?: boolean;
  version?: string;
}): Promise<SetupResult> {
  const errors: string[] = [];

  const pluginVersion = options?.version || process.env.OPCODE_RAG_VERSION || "0.0.0";
  const runtimeDir = getRuntimeDir();
  const versionFile = getVersionFile(runtimeDir);
  const runtimePluginDir = path.join(runtimeDir, "node_modules", PLUGIN_NAME);
  const runtimeSdkDir = path.join(runtimeDir, "node_modules", "@opencode-ai");
  const runtimeSdkPluginDir = path.join(runtimeSdkDir, "plugin");

  const installedVersion = readVersionFile(versionFile);
  const runtimeDist = path.join(runtimePluginDir, "dist");
  const alreadyInstalled = existsSync(runtimeDist);

  if (alreadyInstalled && installedVersion === pluginVersion && !options?.force) {
    return { success: true, errors: [] };
  }

  // Locate the global install with any package manager (issue #34: npm may be
  // absent entirely — pnpm/yarn/bun installs must work too).
  const install = resolveGlobalInstall(PLUGIN_NAME);
  if (!install) {
    errors.push(
      `Could not find a global ${PLUGIN_NAME} install (checked npm, pnpm, yarn, and bun). ` +
        `Install it first: ${installHint(PLUGIN_NAME)}`,
    );
    return { success: false, errors };
  }

  const globalPluginDir = install.packageDir;
  const globalSdkPluginDir = path.join(install.globalRoot, "@opencode-ai", "plugin");

  if (!existsSync(path.join(globalPluginDir, "dist", "cli.js"))) {
    errors.push(`Global install seems incomplete: dist/ not found in ${globalPluginDir}`);
    return { success: false, errors };
  }

  mkdirSync(runtimeDir, { recursive: true });
  const runtimePkg = path.join(runtimeDir, "package.json");
  if (!existsSync(runtimePkg)) {
    writeFileSync(runtimePkg, JSON.stringify({ private: true, type: "module" }, null, 2) + "\n", "utf-8");
  }

  removeIfExists(runtimePluginDir);
  // Ensure stale directory is fully gone before creating junction
  let retries = 3;
  while (retries > 0 && existsSync(runtimePluginDir)) {
    try { rmSync(runtimePluginDir, { recursive: true, force: true }); } catch { /* retry */ }
    retries--;
  }
  mkdirSync(path.dirname(runtimePluginDir), { recursive: true });

  let junctionOk = false;
  try {
    createJunction(globalPluginDir, runtimePluginDir);
    junctionOk = process.platform !== "win32";
    if (process.platform === "win32") {
      const stat = lstatSync(runtimePluginDir);
      junctionOk = stat.isSymbolicLink();
    }
  } catch {
    // fall through to cpSync
  }

  if (!junctionOk) {
    if (!options?.silent) {
      console.error("  [warn] Junction not supported, falling back to copy...");
    }
    const { cpSync } = await import("node:fs") as typeof import("node:fs");
    cpSync(globalPluginDir, runtimePluginDir, { recursive: true });
  }

  // Ensure the @opencode-ai/plugin SDK is available globally.
  // We must NOT run a package install inside the runtime dir because the
  // package manager re-resolves all of node_modules/ and replaces the plugin
  // junction with the published npm version (corrupting the local link).
  if (!existsSync(globalSdkPluginDir)) {
    const sdkPm = install.pm ?? bestAvailablePackageManager();
    if (!sdkPm) {
      errors.push(
        "No package manager (npm/pnpm/yarn/bun) found on PATH — cannot install the @opencode-ai/plugin SDK globally.",
      );
      return { success: false, errors };
    }
    const sdkInstallCommand = globalInstallCommand(sdkPm, "@opencode-ai/plugin");
    try {
      execSync(sdkInstallCommand, {
        stdio: "pipe",
        timeout: 60_000,
      });
    } catch (cause) {
      errors.push(`Failed to install @opencode-ai/plugin SDK globally (${sdkInstallCommand}): ${(cause as Error).message}`);
      return { success: false, errors };
    }
  }

  // Create junction from global SDK to runtime (same pattern as plugin above)
  if (existsSync(globalSdkPluginDir)) {
    removeIfExists(runtimeSdkPluginDir);
    retries = 3;
    while (retries > 0 && existsSync(runtimeSdkPluginDir)) {
      try { rmSync(runtimeSdkPluginDir, { recursive: true, force: true }); } catch { /* retry */ }
      retries--;
    }
    mkdirSync(runtimeSdkDir, { recursive: true });

    let sdkJunctionOk = false;
    try {
      createJunction(globalSdkPluginDir, runtimeSdkPluginDir);
      sdkJunctionOk = process.platform !== "win32";
      if (process.platform === "win32") {
        const stat = lstatSync(runtimeSdkPluginDir);
        sdkJunctionOk = stat.isSymbolicLink();
      }
    } catch {
      // fall through to cpSync
    }

    if (!sdkJunctionOk) {
      if (!options?.silent) {
        console.error("  [warn] SDK junction not supported, falling back to copy...");
      }
      const { cpSync } = await import("node:fs") as typeof import("node:fs");
      cpSync(globalSdkPluginDir, runtimeSdkPluginDir, { recursive: true });
    }
  } else {
    errors.push(`@opencode-ai/plugin SDK not available after global install`);
    return { success: false, errors };
  }

  writeFileSync(versionFile, pluginVersion, "utf-8");

  patchWindowsWrappers(install);

  const cliEntry = path.join(runtimePluginDir, "dist", "cli.js");
  const pluginEntry = path.join(runtimePluginDir, "dist", "plugin-entry.js");
  const sdkPkg = path.join(runtimeSdkPluginDir, "package.json");

  const success = existsSync(cliEntry) && existsSync(pluginEntry) && existsSync(sdkPkg);
  if (!success) {
    if (!existsSync(cliEntry)) errors.push(`CLI entry missing: ${cliEntry}`);
    if (!existsSync(pluginEntry)) errors.push(`Plugin entry missing: ${pluginEntry}`);
    if (!existsSync(sdkPkg)) errors.push(`Plugin SDK missing: ${sdkPkg}`);
  }

  return { success, errors };
}
