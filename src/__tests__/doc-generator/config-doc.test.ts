import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../../core/config.js";

describe("DEFAULT_CONFIG.documentationMode", () => {
  it("is disabled by default", () => {
    assert.equal(DEFAULT_CONFIG.documentationMode?.enabled, false);
  });

  it("has batchSize of 5", () => {
    assert.equal(DEFAULT_CONFIG.documentationMode?.batchSize, 5);
  });

  it("has concurrency of 4", () => {
    assert.equal(DEFAULT_CONFIG.documentationMode?.concurrency, 4);
  });

  it("has style set to google", () => {
    assert.equal(DEFAULT_CONFIG.documentationMode?.style, "google");
  });

  it("has skipExisting set to true", () => {
    assert.equal(DEFAULT_CONFIG.documentationMode?.skipExisting, true);
  });

  it("includes TypeScript extensions", () => {
    const exts = DEFAULT_CONFIG.documentationMode?.includeExtensions ?? [];
    assert.ok(exts.includes(".ts"));
    assert.ok(exts.includes(".tsx"));
    assert.ok(exts.includes(".js"));
  });

  it("includes Python, Java, Go, Rust extensions", () => {
    const exts = DEFAULT_CONFIG.documentationMode?.includeExtensions ?? [];
    assert.ok(exts.includes(".py"));
    assert.ok(exts.includes(".java"));
    assert.ok(exts.includes(".go"));
    assert.ok(exts.includes(".rs"));
  });

  it("includes C, C++, C# extensions", () => {
    const exts = DEFAULT_CONFIG.documentationMode?.includeExtensions ?? [];
    assert.ok(exts.includes(".c"));
    assert.ok(exts.includes(".cpp"));
    assert.ok(exts.includes(".cs"));
  });

  it("includes Ruby, Kotlin, Swift, PHP extensions", () => {
    const exts = DEFAULT_CONFIG.documentationMode?.includeExtensions ?? [];
    assert.ok(exts.includes(".rb"));
    assert.ok(exts.includes(".kt"));
    assert.ok(exts.includes(".swift"));
    assert.ok(exts.includes(".php"));
  });

  it("excludes node_modules and .git", () => {
    const dirs = DEFAULT_CONFIG.documentationMode?.excludeDirs ?? [];
    assert.ok(dirs.includes("node_modules"));
    assert.ok(dirs.includes(".git"));
    assert.ok(dirs.includes(".opencode"));
  });

  it("has a system prompt that mentions Google JSDoc", () => {
    const prompt = DEFAULT_CONFIG.documentationMode?.systemPrompt ?? "";
    assert.ok(prompt.includes("Google JSDoc"));
    assert.ok(prompt.includes("@param"));
    assert.ok(prompt.includes("/**"));
  });
});
