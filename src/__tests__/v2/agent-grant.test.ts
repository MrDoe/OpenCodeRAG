import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { grantExploreToolPermissions } from "../../v2/v2-adapter.js";

type Rule = { action: string; resource: string; effect: "allow" | "deny" | "ask" };

/** Minimal structural editor matching the subset used by the grant. */
function makeEditor(agents: Record<string, { permissions?: Rule[] }>) {
  return {
    get: (id: string) => agents[id],
    update: (id: string, update: (agent: { permissions?: Rule[] }) => void) => {
      const agent = agents[id];
      if (agent) update(agent);
    },
  };
}

describe("grantExploreToolPermissions", () => {
  it("appends allow rules AFTER the shipped deny-all policy (last match wins)", () => {
    const explore = {
      permissions: [
        { action: "*", resource: "*", effect: "deny" as const },
        { action: "read", resource: "*", effect: "allow" as const },
      ],
    };
    const editor = makeEditor({ explore });

    grantExploreToolPermissions(editor);

    const denyIndex = explore.permissions.findIndex((rule) => rule.action === "*");
    const allowIndex = explore.permissions.findIndex((rule) => rule.action === "search_semantic");
    assert.ok(allowIndex > denyIndex, "allow rules must come after the wildcard deny");
    assert.ok(explore.permissions.some((rule) => rule.action === "find_usages" && rule.effect === "allow"));

    // Re-applying must not duplicate rules (idempotent on reloads).
    grantExploreToolPermissions(editor);
    assert.equal(explore.permissions.filter((rule) => rule.action === "search_semantic").length, 1);
  });

  it("never overrides an explicit user rule for a tool action", () => {
    const explore = {
      permissions: [{ action: "search_semantic", resource: "*", effect: "deny" as const }],
    };
    const editor = makeEditor({ explore });

    grantExploreToolPermissions(editor);

    const searchRules = explore.permissions.filter((rule) => rule.action === "search_semantic");
    assert.equal(searchRules.length, 1);
    assert.equal(searchRules[0]!.effect, "deny");
  });

  it("is a no-op when the explore agent does not exist", () => {
    const editor = makeEditor({});
    grantExploreToolPermissions(editor); // must not throw
  });
});
