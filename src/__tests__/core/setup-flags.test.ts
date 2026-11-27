import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSetupFlags, setupPhaseSkipped, SKIPPABLE_SETUP_PHASES } from "../../core/setup-flags.js";

describe("setup flags", () => {
  it("defaults to nothing skipped", () => {
    const flags = parseSetupFlags({});
    assert.equal(flags.safeMode, false);
    assert.equal(flags.skip.size, 0);
    for (const phase of SKIPPABLE_SETUP_PHASES) {
      assert.equal(setupPhaseSkipped(flags, phase), false, phase);
    }
  });

  it("accepts each truthy safe-mode spelling", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on", " On "]) {
      assert.equal(parseSetupFlags({ OPENCODE_RAG_SAFE_MODE: value }).safeMode, true, value);
    }
  });

  it("treats other safe-mode values as off", () => {
    for (const value of ["", "0", "false", "no", "off", "enabled"]) {
      assert.equal(parseSetupFlags({ OPENCODE_RAG_SAFE_MODE: value }).safeMode, false, `"${value}"`);
    }
  });

  it("parses the skip list case-insensitively and trims entries", () => {
    const flags = parseSetupFlags({ OPENCODE_RAG_SETUP_SKIP: " Keyword , WATCHER ,, unknown " });
    assert.deepEqual([...flags.skip].sort(), ["keyword", "unknown", "watcher"]);
  });

  it("safe mode skips every skippable phase", () => {
    const flags = parseSetupFlags({ OPENCODE_RAG_SAFE_MODE: "1" });
    for (const phase of SKIPPABLE_SETUP_PHASES) {
      assert.equal(setupPhaseSkipped(flags, phase), true, phase);
    }
  });

  it("explicit skip only affects the named phases", () => {
    const flags = parseSetupFlags({ OPENCODE_RAG_SETUP_SKIP: "keyword" });
    assert.equal(setupPhaseSkipped(flags, "keyword"), true);
    for (const phase of SKIPPABLE_SETUP_PHASES) {
      if (phase === "keyword") continue;
      assert.equal(setupPhaseSkipped(flags, phase), false, phase);
    }
  });
});
