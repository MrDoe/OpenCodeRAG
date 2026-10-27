import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { CommanderError } from "commander";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const originalCwd = process.cwd;

describe("opencode-rag init", () => {
  let tmpDir: string;
  let symlinkPath: string;

  before(() => {
    tmpDir = join(tmpdir(), `opencode-rag-init-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    symlinkPath = join(tmpDir, "opencode-rag-cli-symlink.js");
  });

  after(() => {
    try {
      rmSync(symlinkPath, { force: true });
    } catch {
      // ignore cleanup failures
    }
    process.cwd = originalCwd;
  });

  it("creates .opencode/opencode-rag.json and .opencode/.gitignore and .opencode/ dir", async () => {
    process.cwd = () => tmpDir;

    // Dynamic import so commander registers the 'init' command
    const { runCli } = await import("../cli.js");
    await runCli(["node", "cli.ts", "init", "--skip-install", "--skip-health-check"]);

    const configPath = join(tmpDir, ".opencode", "opencode-rag.json");
    const opencodeDir = join(tmpDir, ".opencode");
    const gitignorePath = join(opencodeDir, ".gitignore");
    const opencodeConfigPath = join(opencodeDir, "opencode.json");
    const opencodePackagePath = join(opencodeDir, "package.json");
    const pluginEntryPath = join(opencodeDir, "plugins", "opencode-rag", "index.js");
    const tuiPluginEntryPath = join(opencodeDir, "plugins", "opencode-rag", "tui.js");

    assert.ok(existsSync(opencodeDir), ".opencode/ should exist");
    assert.ok(existsSync(gitignorePath), ".opencode/.gitignore should exist");
    assert.ok(existsSync(opencodeConfigPath), ".opencode/opencode.json should exist");
    assert.ok(existsSync(opencodePackagePath), ".opencode/package.json should exist");
    assert.ok(existsSync(pluginEntryPath), ".opencode/plugins/opencode-rag/index.js should exist");
    assert.ok(existsSync(tuiPluginEntryPath), ".opencode/plugins/opencode-rag/tui.js should exist");
    // V1 flat entries must not be written anymore (the TUI never loads them).
    assert.equal(existsSync(join(opencodeDir, "plugins", "rag-plugin.js")), false);
    assert.equal(existsSync(join(opencodeDir, "plugins", "rag-tui.js")), false);
    assert.equal(existsSync(join(opencodeDir, "tui.json")), false);
    assert.ok(existsSync(configPath), ".opencode/opencode-rag.json should exist");
    assert.equal(existsSync(join(tmpDir, "opencode-rag.json")), false, "config must not be created at the project root");

    // Check opencode-rag.json is valid JSON
    const configContent = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(configContent);
    assert.equal(parsed.embedding.provider, "ollama");
    assert.equal(parsed.embedding.baseUrl, "http://127.0.0.1:11434/api");
    assert.equal(parsed.vectorStore.path, "./.opencode/rag_db");

    // Check .gitignore content
    const gitignoreContent = readFileSync(gitignorePath, "utf-8");
    assert.ok(gitignoreContent.includes("node_modules/"));
    assert.ok(gitignoreContent.includes("package-lock.json"));
    assert.ok(gitignoreContent.includes("rag_db/"));
    assert.ok(gitignoreContent.includes("opencode-rag.log"));

    const opencodeConfig = JSON.parse(readFileSync(opencodeConfigPath, "utf-8"));
    assert.equal(opencodeConfig.$schema, "https://opencode.ai/config.json");

    const opencodePackage = JSON.parse(readFileSync(opencodePackagePath, "utf-8"));
    assert.equal(opencodePackage.type, "module");
    assert.equal(opencodePackage.private, true);
    // init copies the version from this package's devDependencies (see
    // buildWorkspacePackageJson) — derive it here so the test never goes stale.
    const rootPackage = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf-8"));
    assert.equal(
      opencodePackage.dependencies["@opencode-ai/plugin"],
      rootPackage.devDependencies["@opencode-ai/plugin"],
    );
    // The RAG plugin is extracted directly into node_modules/, not via npm
    assert.equal("opencode-rag-plugin" in opencodePackage.dependencies, false);

    const pluginEntry = readFileSync(pluginEntryPath, "utf-8");
    assert.match(pluginEntry, /\.\.\/\.\.\/node_modules\/opencode-rag-plugin\/dist\/plugin-entry\.js/);

    const tuiPluginEntry = readFileSync(tuiPluginEntryPath, "utf-8");
    assert.match(tuiPluginEntry, /\.\.\/\.\.\/node_modules\/opencode-rag-plugin\/dist\/tui\.js/);
  });

  it("does not overwrite existing files without --force", async () => {
    process.cwd = () => tmpDir;

    // Replace .opencode/opencode-rag.json with custom content
    const configPath = join(tmpDir, ".opencode", "opencode-rag.json");
    const customContent = JSON.stringify({ embedding: { provider: "openai" } });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(configPath, customContent, "utf-8");

    // Re-run init without force
    const { runCli } = await import("../cli.js");
    await runCli(["node", "cli.ts", "init", "--skip-install", "--skip-health-check"]);

    // Content should be unchanged (still our custom content)
    const afterContent = readFileSync(configPath, "utf-8");
    assert.equal(afterContent, customContent, "should not overwrite without --force");
  });

  it("moves a legacy root-level opencode-rag.json into .opencode/", async () => {
    const legacyDir = join(tmpdir(), `opencode-rag-legacy-${Date.now()}`);
    mkdirSync(legacyDir, { recursive: true });
    try {
      writeFileSync(join(legacyDir, "opencode-rag.json"), JSON.stringify({ embedding: { model: "legacy-model" } }), "utf-8");
      process.cwd = () => legacyDir;

      const { runCli } = await import("../cli.js");
      await runCli(["node", "cli.ts", "init", "--skip-install", "--skip-health-check"]);

      assert.equal(existsSync(join(legacyDir, "opencode-rag.json")), false, "root file moved away");
      const moved = join(legacyDir, ".opencode", "opencode-rag.json");
      assert.ok(existsSync(moved), ".opencode/opencode-rag.json should exist");
      const parsed = JSON.parse(readFileSync(moved, "utf-8"));
      assert.equal(parsed.embedding.model, "legacy-model", "existing config preserved, not overwritten");
    } finally {
      process.cwd = originalCwd;
      try {
        rmSync(legacyDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    }
  });

  it("does not overwrite opencode-rag.json even with --force in non-interactive shell", async () => {
    process.cwd = () => tmpDir;

    const configPath = join(tmpDir, "opencode-rag.json");
    const customContent = JSON.stringify({ embedding: { provider: "custom-preserved" } });
    writeFileSync(configPath, customContent, "utf-8");

    const { runCli } = await import("../cli.js");
    await runCli(["node", "cli.ts", "init", "--force", "--skip-install", "--skip-health-check"]);

    // Config must NOT be overwritten in non-TTY even with --force; requires interactive y/N
    const afterContent = readFileSync(configPath, "utf-8");
    assert.equal(afterContent, customContent, "should not overwrite config without interactive confirmation");
    assert.ok(!existsSync(configPath + ".bak"), "should not create .bak file");
  });

  it("removes stale plugin registration from .opencode/opencode.json", async () => {
    process.cwd = () => tmpDir;

    const opencodeDir = join(tmpDir, ".opencode");
    mkdirSync(opencodeDir, { recursive: true });
    const opencodeConfigPath = join(opencodeDir, "opencode.json");
    writeFileSync(
      opencodeConfigPath,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugin: ["opencode-rag-plugin"],
      }),
      "utf-8"
    );

    const { runCli } = await import("../cli.js");
    await runCli(["node", "cli.ts", "init", "--skip-install", "--skip-health-check"]);

    const opencodeConfig = JSON.parse(readFileSync(opencodeConfigPath, "utf-8"));
    assert.equal(opencodeConfig.$schema, "https://opencode.ai/config.json");
    assert.equal("plugin" in opencodeConfig, false, "stale plugin registration should be removed");
  });

  it("removes stale global OpenCode plugin registrations", async () => {
    const fakeHome = join(tmpDir, "fake-home");
    const globalConfigDir = join(fakeHome, ".config", "opencode");
    mkdirSync(globalConfigDir, { recursive: true });
    const globalConfigPath = join(globalConfigDir, "opencode.jsonc");
    writeFileSync(
      globalConfigPath,
      JSON.stringify({
        plugin: ["opencode-rag-plugin", "other-plugin"],
      }),
      "utf-8"
    );

    const { removeStaleGlobalPluginRegistrations } = await import("../cli.js");
    const updatedPaths = removeStaleGlobalPluginRegistrations(fakeHome, "opencode-rag-plugin");

    assert.deepEqual(updatedPaths, [globalConfigPath]);
    const opencodeConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
    assert.deepEqual(opencodeConfig.plugin, ["other-plugin"]);
  });

  it("skips health check with --skip-health-check", async () => {
    process.cwd = () => tmpDir;

    const { runCli } = await import("../cli.js");
    // Write a config with an unreachable provider (non-existent host)
    const configPath = join(tmpDir, "opencode-rag.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        embedding: { provider: "ollama", baseUrl: "http://127.0.0.1:19999/api", model: "nonexistent" },
      }),
      "utf-8"
    );

    // Without --skip-health-check, this would fail with "Connection refused"
    // With --skip-health-check, it should complete successfully
    await runCli(["node", "cli.ts", "init", "--skip-install", "--skip-health-check"]);

    // Config should not be overwritten since it already exists and no --force
    const content = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.embedding.model, "nonexistent", "config should not be overwritten");
  });

  it("migrates the V1 flat plugin entries to the plugin directory layout", async () => {
    const legacyDir = join(tmpdir(), `opencode-rag-init-migrate-${Date.now()}`);
    const legacyPluginsDir = join(legacyDir, ".opencode", "plugins");
    mkdirSync(legacyPluginsDir, { recursive: true });
    // Exact V1-generated contents (init only removes files it wrote itself).
    writeFileSync(
      join(legacyPluginsDir, "rag-plugin.js"),
      'import plugin from "../node_modules/opencode-rag-plugin/dist/plugin-entry.js";\nexport default plugin;\n',
      "utf-8"
    );
    writeFileSync(
      join(legacyPluginsDir, "rag-tui.js"),
      'import plugin from "../node_modules/opencode-rag-plugin/dist/tui.js";\nexport default plugin;\n',
      "utf-8"
    );
    writeFileSync(join(legacyDir, ".opencode", "tui.json"), JSON.stringify({ plugin: ["./plugins/rag-tui.js"] }), "utf-8");
    // A hand-written plugin file must survive the migration.
    writeFileSync(join(legacyPluginsDir, "my-plugin.js"), "export default {};\n", "utf-8");

    process.cwd = () => legacyDir;
    const { runCli } = await import("../cli.js");
    await runCli(["node", "cli.ts", "init", "--skip-install", "--skip-health-check"]);

    try {
      assert.equal(existsSync(join(legacyPluginsDir, "rag-plugin.js")), false, "legacy server entry should be removed");
      assert.equal(existsSync(join(legacyPluginsDir, "rag-tui.js")), false, "legacy TUI entry should be removed");
      assert.equal(existsSync(join(legacyDir, ".opencode", "tui.json")), false, "legacy V1 tui config should be removed");
      assert.ok(existsSync(join(legacyPluginsDir, "my-plugin.js")), "hand-written plugin files must be preserved");
      assert.ok(existsSync(join(legacyPluginsDir, "opencode-rag", "index.js")), "server entrypoint should exist");
      assert.ok(existsSync(join(legacyPluginsDir, "opencode-rag", "tui.js")), "TUI entrypoint should exist");
    } finally {
      try {
        rmSync(legacyDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    }
  });

  it("resolves symlinked cli entrypoints", async () => {
    // Skip on Windows due to symlink permission requirements
    if (process.platform === "win32") {
      return;
    }
    const cliModuleFileUrl = new URL("../cli.ts", import.meta.url);
    const cliModuleUrl = cliModuleFileUrl.href;
    symlinkSync(fileURLToPath(cliModuleFileUrl), symlinkPath);
    assert.ok(existsSync(symlinkPath));

    const { shouldAutoRunCli } = await import("../cli.js");

    assert.equal(shouldAutoRunCli(cliModuleUrl, symlinkPath), true);
    assert.equal(shouldAutoRunCli(cliModuleUrl, join(tmpDir, "missing-cli.js")), false);
    assert.equal(shouldAutoRunCli(cliModuleUrl, undefined), false);
  });
});

describe("opencode-rag init AGENTS.md", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = join(tmpdir(), `opencode-rag-init-agents-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    process.cwd = originalCwd;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("creates AGENTS.md with the OpenCodeRAG directive on fresh workspace", async () => {
    process.cwd = () => tmpDir;

    const { runCli } = await import("../cli.js");
    await runCli(["node", "cli.ts", "init", "--skip-install", "--skip-health-check"]);

    const agentsPath = join(tmpDir, "AGENTS.md");
    assert.ok(existsSync(agentsPath), "AGENTS.md should exist at workspace root");
    const content = readFileSync(agentsPath, "utf-8");
    assert.ok(content.includes("ALWAYS use OpenCodeRAG tools before reading or editing"), "should contain the directive");
    assert.ok(content.includes("`search_semantic`"), "should mention search_semantic");
    assert.ok(content.includes("`get_file_skeleton`"), "should mention get_file_skeleton");
    assert.ok(content.includes("`find_usages`"), "should mention find_usages");
    assert.ok(content.includes("`describe_image`"), "should mention describe_image");
    assert.ok(content.includes("Decision tree"), "should contain decision tree");
    assert.ok(content.includes("Proactive triggers"), "should contain proactive triggers");
    assert.ok(content.includes("Anti-patterns"), "should contain anti-patterns");
    assert.ok(content.includes("quirk capture rules"), "should contain quirk capture rules (default promptEnforcement=true)");
    assert.ok(content.includes("<!-- BEGIN opencode-rag -->"), "should contain begin sentinel");
    assert.ok(content.includes("<!-- END opencode-rag -->"), "should contain end sentinel");
    assert.ok(!content.includes("### Decision model (`make_decision`)"), "decision section should be hidden while decision.enabled is false");

    const decisionSkillPath = join(tmpDir, ".opencode", "skills", "make-decision", "SKILL.md");
    assert.ok(existsSync(decisionSkillPath), "make-decision skill should be created");
    const decisionSkill = readFileSync(decisionSkillPath, "utf-8");
    assert.ok(decisionSkill.includes("name: make-decision"), "skill frontmatter should name the skill");
    assert.ok(decisionSkill.includes("`make_decision(state, questions)`"), "skill should document the tool signature");
    assert.ok(decisionSkill.includes("decision.enabled"), "skill should document the enablement gate");
    assert.ok(decisionSkill.includes("tev1"), "skill should document the model requirement");
  });

  it("preserves existing custom content and appends the directive", async () => {
    const sub = join(tmpDir, "preserve-test");
    mkdirSync(sub, { recursive: true });
    const custom = "# My Project\n\nCustom notes about the workspace.\n";
    writeFileSync(join(sub, "AGENTS.md"), custom, "utf-8");
    process.cwd = () => sub;

    const { runCli } = await import("../cli.js");
    await runCli(["node", "cli.ts", "init", "--skip-install", "--skip-health-check"]);

    const content = readFileSync(join(sub, "AGENTS.md"), "utf-8");
    assert.ok(content.includes("Custom notes about the workspace."), "should preserve custom content");
    assert.ok(content.includes("<!-- BEGIN opencode-rag -->"), "should append the directive section");
    assert.ok(content.includes("ALWAYS use OpenCodeRAG tools"), "should include the directive body");
  });

  it("replaces the section in place on re-run without duplicating", async () => {
    const sub = join(tmpDir, "rerun-test");
    mkdirSync(sub, { recursive: true });
    process.cwd = () => sub;

    const { runCli } = await import("../cli.js");
    await runCli(["node", "cli.ts", "init", "--skip-install", "--skip-health-check"]);
    await runCli(["node", "cli.ts", "init", "--skip-install", "--skip-health-check"]);

    const content = readFileSync(join(sub, "AGENTS.md"), "utf-8");
    const beginCount = (content.match(/<!-- BEGIN opencode-rag -->/g) ?? []).length;
    const endCount = (content.match(/<!-- END opencode-rag -->/g) ?? []).length;
    assert.equal(beginCount, 1, "should have exactly one begin sentinel");
    assert.equal(endCount, 1, "should have exactly one end sentinel");
    assert.ok(content.includes("ALWAYS use OpenCodeRAG tools"), "directive body should be present");
  });
});

describe("mergeAgentsMdContent helper", () => {
  let mergeAgentsMdContent: typeof import("../cli/commands/init-helpers.js").mergeAgentsMdContent;

  before(async () => {
    ({ mergeAgentsMdContent } = await import("../cli/commands/init-helpers.js"));
  });

  it("returns the section alone when no existing content", () => {
    const out = mergeAgentsMdContent(undefined);
    assert.ok(out.startsWith("<!-- BEGIN opencode-rag -->"));
    assert.ok(out.trimEnd().endsWith("<!-- END opencode-rag -->"));
    assert.ok(out.endsWith("\n"), "should end with newline");
    assert.ok(out.includes("search_semantic"));
    assert.ok(out.includes("Decision tree"), "should include decision tree");
    assert.ok(out.includes("Proactive triggers"), "should include proactive triggers");
    assert.ok(out.includes("Anti-patterns"), "should include anti-patterns");
    assert.ok(out.includes("quirk capture rules"), "should include quirk rules by default");
  });

  it("appends section preserving custom content", () => {
    const out = mergeAgentsMdContent("# Cool Project\n\nSome notes.\n");
    assert.ok(out.includes("Some notes."), "custom content preserved");
    assert.ok(out.includes("<!-- BEGIN opencode-rag -->"), "section appended");
    assert.ok(out.includes("<!-- END opencode-rag -->"));
  });

  it("replaces existing section in place", () => {
    const existing = "# Project\n\n<!-- BEGIN opencode-rag -->\nOLD BODY\n<!-- END opencode-rag -->\n\nTrailing.\n";
    const out = mergeAgentsMdContent(existing);
    assert.ok(out.includes("<!-- BEGIN opencode-rag -->"));
    assert.ok(out.includes("ALWAYS use OpenCodeRAG tools"), "old body replaced with new directive");
    assert.ok(!out.includes("OLD BODY"), "stale body removed");
    assert.ok(out.includes("Trailing."), "trailing content preserved");
    assert.ok(out.includes("Decision tree"), "new sections should be present");
    assert.ok(out.includes("Proactive triggers"), "proactive triggers should be present");
    assert.ok(out.includes("Anti-patterns"), "anti-patterns should be present");
    const beginCount = (out.match(/<!-- BEGIN opencode-rag -->/g) ?? []).length;
    assert.equal(beginCount, 1, "no duplicate sections");
  });

  it("hides quirk rules when promptEnforcement is false", () => {
    const out = mergeAgentsMdContent(undefined, { promptEnforcement: false });
    assert.ok(out.includes("Decision tree"), "decision tree should still be present");
    assert.ok(!out.includes("quirk capture rules"), "quirk rules should be hidden");
  });

  it("includes quirk rules when promptEnforcement is true (default)", () => {
    const out = mergeAgentsMdContent(undefined, { promptEnforcement: true });
    assert.ok(out.includes("quirk capture rules"), "quirk rules should be present");
  });

  it("includes the decision-model section when decisionEnabled is true", () => {
    const out = mergeAgentsMdContent(undefined, { decisionEnabled: true });
    assert.ok(out.includes("### Decision model (`make_decision`)"), "decision section should be present");
    assert.ok(out.includes("1-64 questions"), "should describe the question limit");
    assert.ok(out.includes("`choice`"), "should describe the question types");
    assert.ok(out.includes("high-stakes"), "should warn against sole reliance for high-stakes calls");
  });

  it("omits the decision-model section by default", () => {
    const out = mergeAgentsMdContent(undefined);
    assert.ok(!out.includes("### Decision model (`make_decision`)"), "decision section should be hidden by default");
  });

  it("adds the route-before-asking rule only when routeBeforeAsking is enabled", () => {
    const on = mergeAgentsMdContent(undefined, { decisionEnabled: true, routeBeforeAsking: true });
    assert.ok(on.includes("route option choices through `make_decision`"), "routing rule should be present");
    const off = mergeAgentsMdContent(undefined, { decisionEnabled: true });
    assert.ok(!off.includes("route option choices through `make_decision`"), "routing rule should be hidden by default");
  });
});

describe("opencode-rag describe-image", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = join(tmpdir(), `opencode-rag-describe-cli-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    process.cwd = originalCwd;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("describe-image command is registered and shows help", async () => {
    process.cwd = () => tmpDir;

    const { runCli } = await import("../cli.js");
    // --help should exit with code 0 and show describe-image in output.
    // Commander's default is process.exit(0) here, which would kill the
    // test runner mid-suite — runCli must return instead.
    await assert.doesNotReject(
      () => runCli(["node", "cli.ts", "describe-image", "--help"]),
    );
  });

  it("rejects missing file path argument", async () => {
    process.cwd = () => tmpDir;
    const { runCli } = await import("../cli.js");
    // Missing file argument should throw — and must NOT terminate the
    // process, so the remaining tests still run.
    await assert.rejects(
      () => runCli(["node", "cli.ts", "describe-image"]),
      (err: unknown) => {
        assert.ok(err instanceof CommanderError, `expected a CommanderError, got ${String(err)}`);
        assert.equal(err.exitCode, 1);
        assert.equal(err.code, "commander.missingArgument");
        return true;
      },
    );
  });

  it("runCli resolves for --version instead of exiting the process", async () => {
    const { runCli } = await import("../cli.js");
    await assert.doesNotReject(
      () => runCli(["node", "cli.ts", "--version"]),
    );
  });
});

describe("CLI process exit codes", () => {
  const cliEntry = fileURLToPath(new URL("../cli/index.ts", import.meta.url));

  /** Run the CLI as a real subprocess and capture its exit status. */
  function runCliProcess(args: string[]): { status: number | null; stderr: string } {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", cliEntry, ...args],
      { encoding: "utf-8", windowsHide: true, timeout: 120_000 },
    );
    return { status: result.status, stderr: result.stderr ?? "" };
  }

  // The in-process `runCli()` tests above cover the "do not exit the host"
  // contract. These cover the other half: as a real CLI, the process must
  // still exit with the documented code.
  it("exits 0 for --help", () => {
    assert.equal(runCliProcess(["--help"]).status, 0);
  });

  it("exits 0 for --version", () => {
    assert.equal(runCliProcess(["--version"]).status, 0);
  });

  it("exits 1 for an unknown command", () => {
    const { status, stderr } = runCliProcess(["definitely-not-a-command"]);
    assert.equal(status, 1);
    assert.match(stderr, /unknown command/);
  });
});

describe("workspace detection helpers (setup integration)", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = join(tmpdir(), `opencode-rag-detect-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  });

  it("isLikelyProjectRoot detects git repos and manifest files", async () => {
    const { isLikelyProjectRoot } = await import("../cli/commands/init.js");

    // An empty directory is not a project root.
    assert.equal(isLikelyProjectRoot(tmpDir), false);

    // A manifest file makes it one.
    writeFileSync(join(tmpDir, "package.json"), "{}", "utf-8");
    assert.equal(isLikelyProjectRoot(tmpDir), true);

    // A .git directory also makes it one (fresh checkout without manifests).
    rmSync(join(tmpDir, "package.json"), { force: true });
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    assert.equal(isLikelyProjectRoot(tmpDir), true);
  });

  it("isWorkspaceInitialized requires the plugin directory layout", async () => {
    const { isWorkspaceInitialized } = await import("../cli/commands/init.js");

    assert.equal(isWorkspaceInitialized(tmpDir), false);

    // Only the server plugin entry exists -> not initialized yet.
    const pluginDir = join(tmpDir, ".opencode", "plugins", "opencode-rag");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "index.js"), "x", "utf-8");
    assert.equal(isWorkspaceInitialized(tmpDir), false);

    // TUI entrypoint beside it -> initialized.
    writeFileSync(join(pluginDir, "tui.js"), "x", "utf-8");
    assert.equal(isWorkspaceInitialized(tmpDir), true);
  });

  it("treats the V1 flat layout as uninitialized so setup migrates it", async () => {
    const { isWorkspaceInitialized } = await import("../cli/commands/init.js");

    const legacyDir = join(tmpdir(), `opencode-rag-legacy-test-${Date.now()}`);
    mkdirSync(join(legacyDir, ".opencode", "plugins"), { recursive: true });
    writeFileSync(join(legacyDir, ".opencode", "plugins", "rag-plugin.js"), "x", "utf-8");
    writeFileSync(join(legacyDir, ".opencode", "plugins", "rag-tui.js"), "x", "utf-8");
    writeFileSync(join(legacyDir, ".opencode", "tui.json"), '{"plugin":["./plugins/rag-tui.js"]}', "utf-8");

    try {
      assert.equal(isWorkspaceInitialized(legacyDir), false);
    } finally {
      try {
        rmSync(legacyDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    }
  });
});
