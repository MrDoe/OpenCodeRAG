import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSystemGuidanceLines,
  buildShellBackgroundGuidanceLines,
  buildAgentsMdDirective,
  buildFullAgentsMdLines,
  buildCompactAgentsMdLines,
  resolveAgentsMdDetail,
  FIRST_MOVE_LINES,
  BEGIN_MARKER,
  END_MARKER,
} from "../../opencode/system-guidance.js";

describe("first-move ordering rules", () => {
  it("states the ordering rule before the tool list it governs", () => {
    const lines = buildSystemGuidanceLines({ promptEnforcement: false });
    const firstMoveIdx = lines.findIndex((l) => l === FIRST_MOVE_LINES[0]);
    const toolBulletIdx = lines.findIndex((l) => l.startsWith("- `search_semantic"));
    assert.ok(firstMoveIdx > 0, "first-move block should be present");
    assert.ok(firstMoveIdx < toolBulletIdx, "ordering rule must precede the tool list");
  });

  it("names the authoritative-elsewhere exception", () => {
    const text = buildSystemGuidanceLines({ promptEnforcement: false }).join("\n");
    assert.match(text, /Authoritative elsewhere/, "the rule needs its exception spelled out or it gets routed around");
  });
});

describe("AGENTS.md detail levels", () => {
  it("resolves auto against the runtime injector, and unset to the standalone form", () => {
    assert.equal(resolveAgentsMdDetail(undefined, true), "full");
    assert.equal(resolveAgentsMdDetail("auto", true), "compact");
    assert.equal(resolveAgentsMdDetail("auto", false), "full");
    assert.equal(resolveAgentsMdDetail("full", true), "full");
    assert.equal(resolveAgentsMdDetail("compact", false), "compact");
  });

  it("compact drops the sections the injector already delivers", () => {
    const compact = buildAgentsMdDirective({ promptEnforcement: true, agentsMdDetail: "compact" });
    const full = buildAgentsMdDirective({ promptEnforcement: true, agentsMdDetail: "full" });
    for (const section of ["### Decision tree", "### Proactive triggers", "### Anti-patterns"]) {
      assert.ok(full.includes(section), `full should carry ${section}`);
      assert.ok(!compact.includes(section), `compact should not repeat ${section}`);
    }
    assert.ok(compact.includes(BEGIN_MARKER) && compact.includes(END_MARKER), "markers must survive for in-place replacement");
    assert.ok(compact.includes("search_semantic"), "compact still names the tools");
    assert.ok(compact.length < full.length * 0.6, `compact (${compact.length}) should carry well under two thirds of full (${full.length})`);
  });

  it("keeps the conditional sections in both shapes", () => {
    const compact = buildCompactAgentsMdLines({ promptEnforcement: true, decisionEnabled: true });
    const full = buildFullAgentsMdLines({ promptEnforcement: true, decisionEnabled: true });
    assert.match(compact.join("\n"), /make_decision/);
    assert.match(compact.join("\n"), /add_quirk/);
    assert.match(full.join("\n"), /make_decision/);
  });

  it("auto means compact when the injector is on and full when it is off", () => {
    const on = buildAgentsMdDirective({ promptEnforcement: false, agentsMdDetail: "auto", injectedAtRuntime: true });
    const off = buildAgentsMdDirective({ promptEnforcement: false, agentsMdDetail: "auto", injectedAtRuntime: false });
    assert.ok(!on.includes("### Decision tree"));
    assert.ok(off.includes("### Decision tree"));
  });
});

describe("buildSystemGuidanceLines", () => {
  it("inserts the make_decision line directly after describe_image when enabled", () => {
    const lines = buildSystemGuidanceLines({ promptEnforcement: false, decisionEnabled: true });
    const describeIdx = lines.findIndex((line) => line.startsWith("- `describe_image"));
    const decisionIdx = lines.findIndex((line) => line.startsWith("- `make_decision"));
    assert.ok(describeIdx >= 0, "describe_image line should be present");
    assert.equal(decisionIdx, describeIdx + 1, "make_decision should follow describe_image");
  });

  it("omits the make_decision line by default", () => {
    const lines = buildSystemGuidanceLines({ promptEnforcement: false });
    assert.ok(!lines.some((line) => line.startsWith("- `make_decision`")), "decision line should be hidden");
  });

  it("still appends quirk enforcement rules when enabled", () => {
    const lines = buildSystemGuidanceLines({ promptEnforcement: true, decisionEnabled: true });
    assert.ok(lines.some((line) => line.includes("MANDATORY quirk capture rules")));
  });

  it("adds the route-before-asking line only when routeBeforeAsking is enabled", () => {
    const isRouteLine = (line: string) => line.includes("Before asking the user to choose");
    const off = buildSystemGuidanceLines({ promptEnforcement: false, decisionEnabled: true });
    const on = buildSystemGuidanceLines({ promptEnforcement: false, decisionEnabled: true, routeBeforeAsking: true });
    assert.ok(!off.some(isRouteLine), "routing line should be hidden by default");
    assert.ok(on.some(isRouteLine), "routing line should be present when enabled");

    const noDecision = buildSystemGuidanceLines({ promptEnforcement: false, routeBeforeAsking: true });
    assert.ok(!noDecision.some(isRouteLine), "routing line requires decisionEnabled");
  });

  describe("buildShellBackgroundGuidanceLines", () => {
    it("emits guidance by default", () => {
      const lines = buildShellBackgroundGuidanceLines();
      assert.ok(lines.some((l) => l.includes("background: true")), "should mention background: true");
    });

    it("is disabled when backgroundGuidance is false", () => {
      const lines = buildShellBackgroundGuidanceLines({ backgroundGuidance: false });
      assert.equal(lines.length, 0);
    });

    it("reflects a custom threshold", () => {
      const lines = buildShellBackgroundGuidanceLines({ longRunningThresholdMs: 5000 });
      assert.ok(lines.some((l) => l.includes("5s")), "should use 5s threshold");
    });

    it("is included in buildSystemGuidanceLines when enabled", () => {
      const lines = buildSystemGuidanceLines({ promptEnforcement: false, shell: { backgroundGuidance: true } });
      assert.ok(lines.some((l) => l.includes("Long-running commands:")), "should include long-running section");
    });
  });
});
