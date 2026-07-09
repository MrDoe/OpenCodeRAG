// postinstall: runs after `npm install -g opencode-rag-plugin`.
// Only executes setup when installed globally — skips silently for local dev installs.
// On Windows, also rewrites npm-generated shims so they use node.exe explicitly
// (npm shims invoke .js files via file association, which breaks when .js is
// associated with a text editor instead of Node.js).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const isGlobal = process.env.npm_config_global === "true";
if (!isGlobal) {
  process.exit(0);
}

// ── Fix npm-generated Windows shims ──────────────────────────────
// npm's generated shims invoke .js files via file association, which breaks
// when .js is associated with a text editor instead of Node.js. We replace
// the shims entirely with versions that call node explicitly.
if (process.platform === "win32") {
  const binDir = process.env.npm_config_prefix
    ? path.resolve(process.env.npm_config_prefix)
    : undefined;

  if (binDir) {
    const ps1Path = path.join(binDir, "opencode-rag.ps1");
    const ps1Content = `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$script = Join-Path $basedir "node_modules/opencode-rag-plugin/dist/cli/index.js"
if ($MyInvocation.ExpectingInput) {
  $input | & node $script $args
} else {
  & node $script $args
}
exit $LASTEXITCODE
`;
    try {
      writeFileSync(ps1Path, ps1Content, "utf-8");
      console.error(`OpenCodeRAG: fixed .ps1 shim`);
    } catch { /* skip */ }

    const cmdPath = path.join(binDir, "opencode-rag.cmd");
    const cmdContent = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
node "%dp0%\\node_modules\\opencode-rag-plugin\\dist\\cli\\index.js" %*
`;
    try {
      writeFileSync(cmdPath, cmdContent, "utf-8");
      console.error(`OpenCodeRAG: fixed .cmd shim`);
    } catch { /* skip */ }
  }
}

// ── Runtime setup ────────────────────────────────────────────────
let setupRuntime;
try {
  const mod = await import("../dist/core/setup-runtime.js");
  setupRuntime = mod.setupRuntime;
} catch {
  console.error("OpenCodeRAG: could not find runtime setup module.");
  console.error("Run `opencode-rag setup` manually after install.");
  process.exit(0);
}

const result = await setupRuntime({ silent: true });

if (!result.success) {
  console.error("");
  console.error("OpenCodeRAG runtime setup failed during postinstall.");
  for (const err of result.errors) {
    console.error(`  ${err}`);
  }
  console.error("");
  console.error("Run `opencode-rag setup` manually to retry.");
  console.error("");
}
