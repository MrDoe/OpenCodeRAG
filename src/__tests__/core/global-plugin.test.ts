import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getGlobalPluginDir,
  installGlobalPlugin,
  isGlobalPluginInstalled,
  removeGlobalPlugin,
} from "../../core/global-plugin.js";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalXdg = process.env.XDG_CONFIG_HOME;
let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "opencode-rag-global-plugin-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  const dist = join(home, ".opencode", "node_modules", "opencode-rag-plugin", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "plugin-entry.js"), "export default {};\n", "utf-8");
  writeFileSync(join(dist, "tui.js"), "export default {};\n", "utf-8");
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalUserProfile;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = originalXdg;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("global plugin install", () => {
  it("writes both entrypoints with a relative runtime import", () => {
    const result = installGlobalPlugin();
    assert.equal(result.written.length, 2);
    assert.ok(isGlobalPluginInstalled());
    const server = readFileSync(join(getGlobalPluginDir(), "index.js"), "utf-8");
    assert.match(server, /\.\.\/\.\.\/\.\.\/\.\.\/\.opencode\/node_modules\/opencode-rag-plugin\/dist\/plugin-entry\.js/);
    assert.match(server, /export default plugin;/);
    const tui = readFileSync(join(getGlobalPluginDir(), "tui.js"), "utf-8");
    assert.match(tui, /dist\/tui\.js/);
  });

  it("is idempotent and removable", () => {
    installGlobalPlugin();
    const second = installGlobalPlugin();
    assert.deepEqual(second.written, [], "unchanged entries are not rewritten");
    assert.equal(removeGlobalPlugin(), true);
    assert.equal(isGlobalPluginInstalled(), false);
    assert.equal(existsSync(getGlobalPluginDir()), false);
    assert.equal(removeGlobalPlugin(), false);
  });
});
