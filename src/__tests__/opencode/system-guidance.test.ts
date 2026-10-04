import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSystemGuidanceLines } from "../../opencode/system-guidance.js";

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
});
