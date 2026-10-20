import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildToolErrorQuirkContent,
  classifyToolError,
  classifyToolErrorCause,
  createToolErrorCreateState,
  createToolErrorQuirk,
  formatToolGotchaBlock,
  hasEquivalentToolGotcha,
  isWorthRecordingToolError,
  selectToolGotchas,
  TOOL_ERROR_AUTO_TAG,
  TOOL_ERROR_CREATE_DEFAULTS,
  TOOL_ERROR_QUIRK_TAG,
} from "../../quirks/tool-error-create.js";
import type { ToolErrorInfo } from "../../quirks/tool-error-recall.js";
import type { Quirk, QuirkInput } from "../../quirks/types.js";

const WRITE_ERROR: ToolErrorInfo = { tool: "write", error: "Unknown tool 'write'. Did you mean something else?" };

describe("tool-error-create", () => {
  describe("classifyToolError", () => {
    it("classifies an unknown tool name", () => {
      assert.match(classifyToolError("Unknown tool 'write'") ?? "", /tool name/);
    });

    it("classifies a missing path", () => {
      assert.match(classifyToolError("ENOENT: no such file or directory, open 'src/x.ts'") ?? "", /path/);
    });

    it("classifies a permission problem", () => {
      assert.match(classifyToolError("EACCES: permission denied") ?? "", /permissions/);
    });

    it("classifies a schema mismatch", () => {
      assert.match(classifyToolError("expected string, received number") ?? "", /schema/);
    });

    it("classifies a rate limit", () => {
      assert.match(classifyToolError("429 Too Many Requests") ?? "", /rate limited/);
    });

    it("returns undefined for an unknown error", () => {
      assert.equal(classifyToolError("something entirely unexpected happened"), undefined);
    });
  });

  describe("buildToolErrorQuirkContent", () => {
    it("includes the tool name and the error text", () => {
      const content = buildToolErrorQuirkContent(WRITE_ERROR);
      assert.match(content, /write/);
      assert.match(content, /Unknown tool/);
    });

    it("appends the classified cause when one is known", () => {
      const content = buildToolErrorQuirkContent(WRITE_ERROR);
      assert.match(content, /—/);
      assert.match(content, /tool name/);
    });

    it("keeps the raw text only for unknown errors", () => {
      const content = buildToolErrorQuirkContent({ tool: "t", error: "something entirely unexpected happened" });
      assert.doesNotMatch(content, /—/);
    });

    it("collapses whitespace and truncates long errors", () => {
      const content = buildToolErrorQuirkContent({ tool: "t", error: "a\n\n  b   c " + "x".repeat(1000) });
      assert.ok(content.length <= TOOL_ERROR_CREATE_DEFAULTS.maxContentChars);
      assert.doesNotMatch(content, /\n/);
    });
  });

  describe("isWorthRecordingToolError", () => {
    it("rejects errors that are too short to carry information", () => {
      assert.equal(isWorthRecordingToolError({ tool: "t", error: "err" }), false);
    });

    it("accepts a normal error", () => {
      assert.equal(isWorthRecordingToolError(WRITE_ERROR), true);
    });
  });

  describe("createToolErrorCreateState", () => {
    it("blocks the same signature during the cooldown and allows it after", () => {
      const state = createToolErrorCreateState({ cooldownMs: 10_000, maxPerSession: 5 });
      const t0 = 1_000_000;
      assert.equal(state.shouldCreate(WRITE_ERROR, t0), true);
      state.record(WRITE_ERROR, true, t0);
      assert.equal(state.shouldCreate(WRITE_ERROR, t0 + 5_000), false);
      assert.equal(state.shouldCreate(WRITE_ERROR, t0 + 10_001), true);
    });

    it("does not consume the budget for a failed creation", () => {
      const state = createToolErrorCreateState({ cooldownMs: 0, maxPerSession: 1 });
      state.record(WRITE_ERROR, false, 0);
      assert.equal(state.creationCount(), 0);
      assert.equal(state.shouldCreate({ tool: "other", error: "boom boom boom" }, 0), true);
    });

    it("stops after maxPerSession creations", () => {
      const state = createToolErrorCreateState({ cooldownMs: 0, maxPerSession: 2 });
      state.record({ tool: "a", error: "one one one" }, true, 0);
      state.record({ tool: "b", error: "two two two" }, true, 0);
      assert.equal(state.creationCount(), 2);
      assert.equal(state.shouldCreate({ tool: "c", error: "three three" }, 0), false);
    });

    it("tracks the created signatures", () => {
      const state = createToolErrorCreateState({ cooldownMs: 0 });
      state.record(WRITE_ERROR, true, 0);
      assert.equal(state.createdSignatures.size, 1);
    });
  });

  describe("createToolErrorQuirk", () => {
    it("stores the quirk with the tool-error tags, gotcha type and a low confidence", async () => {
      const added: QuirkInput[] = [];
      const result = await createToolErrorQuirk(
        {
          add: async (input) => {
            added.push(input);
            return { id: "quirk:1", content: input.content, tags: input.tags ?? [], confidence: input.confidence ?? 1, lastObserved: "" } as Quirk;
          },
        },
        WRITE_ERROR,
      );

      assert.equal(result.created, true);
      assert.equal(result.id, "quirk:1");
      assert.equal(added.length, 1);
      const q = added[0]!;
      assert.equal(q.quirkType, "gotcha");
      assert.equal(q.confidence, TOOL_ERROR_CREATE_DEFAULTS.confidence);
      assert.ok(q.tags?.includes(TOOL_ERROR_QUIRK_TAG));
      assert.ok(q.tags?.includes(TOOL_ERROR_AUTO_TAG));
      assert.ok(q.tags?.includes("tool:write"));
      assert.equal(q.sourceRef, "tool-error:write");
    });

    it("reports — but does not throw — a trust-monitor rejection", async () => {
      const result = await createToolErrorQuirk(
        {
          add: async () => {
            throw new Error("Quirk rejected by trust monitor: Content matches blocked pattern");
          },
        },
        WRITE_ERROR,
      );
      assert.equal(result.created, false);
      assert.match(result.reason ?? "", /trust monitor/);
    });

    it("skips an error that is too short to record", async () => {
      let called = false;
      const result = await createToolErrorQuirk(
        {
          add: async () => {
            called = true;
            return { id: "x", content: "", tags: [], confidence: 1, lastObserved: "" } as Quirk;
          },
        },
        { tool: "t", error: "err" },
      );
      assert.equal(result.created, false);
      assert.equal(called, false);
    });
  });
});

describe("tool-error cause classes", () => {
  it("classifies a known cause into a class and guidance", () => {
    const c = classifyToolErrorCause("Unknown tool 'write'");
    assert.equal(c?.cls, "unknown-tool");
    assert.match(c?.cause ?? "", /tool name/);
  });

  it("returns undefined for an unknown error", () => {
    assert.equal(classifyToolErrorCause("something entirely unexpected happened"), undefined);
  });

  it("tags a created quirk with its cause class", async () => {
    const added: QuirkInput[] = [];
    await createToolErrorQuirk(
      {
        add: async (input) => {
          added.push(input);
          return { id: "q", content: input.content, tags: input.tags ?? [], confidence: 1, lastObserved: "" } as Quirk;
        },
      },
      { tool: "write", error: "Unknown tool 'write'. Did you mean something else?" },
    );
    assert.ok(added[0]!.tags?.includes("cause:unknown-tool"));
  });

  it("does not tag a cause when the error is unclassified", async () => {
    const added: QuirkInput[] = [];
    await createToolErrorQuirk(
      {
        add: async (input) => {
          added.push(input);
          return { id: "q", content: input.content, tags: input.tags ?? [], confidence: 1, lastObserved: "" } as Quirk;
        },
      },
      { tool: "write", error: "something entirely unexpected happened here" },
    );
    assert.ok(!added[0]!.tags?.some((t) => t.startsWith("cause:")));
  });
});

describe("selectToolGotchas", () => {
  const gotcha = (id: string, tags: string[], content = "Tool `write` failed: unknown tool") => ({
    id,
    content,
    tags,
  });

  it("keeps a gotcha whose tool is in the catalog", () => {
    const gotchas = selectToolGotchas(
      [gotcha("q1", ["tool-error", "auto-created", "tool:write", "cause:unknown-tool"])],
      ["write", "read"],
    );
    assert.equal(gotchas.length, 1);
    assert.equal(gotchas[0]!.tool, "write");
  });

  it("drops a gotcha whose tool is not callable", () => {
    const gotchas = selectToolGotchas(
      [gotcha("q1", ["tool-error", "tool:deploy", "cause:unknown-tool"])],
      ["write", "read"],
    );
    assert.equal(gotchas.length, 0);
  });

  it("drops a transient cause — warning about it in advance is misleading", () => {
    const gotchas = selectToolGotchas(
      [
        gotcha("q1", ["tool-error", "tool:bash", "cause:rate-limit"]),
        gotcha("q2", ["tool-error", "tool:bash", "cause:timeout"]),
      ],
      ["bash"],
    );
    assert.equal(gotchas.length, 0);
  });

  it("drops an unclassified gotcha — we do not know if it is durable", () => {
    const gotchas = selectToolGotchas([gotcha("q1", ["tool-error", "tool:write"])], ["write"]);
    assert.equal(gotchas.length, 0);
  });

  it("keeps the durable causes", () => {
    for (const cls of ["unknown-tool", "schema", "permissions", "path"]) {
      const gotchas = selectToolGotchas(
        [gotcha("q1", ["tool-error", "tool:write", `cause:${cls}`])],
        ["write"],
      );
      assert.equal(gotchas.length, 1, `cause ${cls} should be proactive`);
    }
  });

  it("caps the number of gotchas", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      gotcha(`q${i}`, ["tool-error", "tool:write", "cause:schema"]),
    );
    assert.equal(selectToolGotchas(many, ["write"], 3).length, 3);
  });

  it("returns nothing without a tool catalog", () => {
    const gotchas = selectToolGotchas([gotcha("q1", ["tool-error", "tool:write", "cause:schema"])], []);
    assert.equal(gotchas.length, 0);
  });
});

describe("formatToolGotchaBlock", () => {
  it("returns an empty string without gotchas", () => {
    assert.equal(formatToolGotchaBlock([]), "");
  });

  it("renders the gotchas with a heading", () => {
    const block = formatToolGotchaBlock([
      { tool: "write", content: "Tool `write` failed: unknown tool", quirkId: "q1" },
    ]);
    assert.match(block, /Known tool gotchas/);
    assert.match(block, /Tool `write` failed: unknown tool/);
  });
});

describe("hasEquivalentToolGotcha", () => {
  const q = (tags: string[]) => ({ id: "q", content: "c", tags });

  it("finds an exact duplicate (same tool + same cause class)", () => {
    const quirks = [q(["tool-error", "tool:write", "cause:schema"])];
    assert.equal(hasEquivalentToolGotcha(quirks, "write", "schema"), true);
  });

  it("does not match a different cause class for the same tool", () => {
    const quirks = [q(["tool-error", "tool:write", "cause:schema"])];
    assert.equal(hasEquivalentToolGotcha(quirks, "write", "unknown-tool"), false);
  });

  it("does not match a different tool with the same cause class", () => {
    const quirks = [q(["tool-error", "tool:write", "cause:schema"])];
    assert.equal(hasEquivalentToolGotcha(quirks, "bash", "schema"), false);
  });

  it("matches case-insensitively on the tool name", () => {
    const quirks = [q(["tool-error", "tool:write", "cause:schema"])];
    assert.equal(hasEquivalentToolGotcha(quirks, "Write", "schema"), true);
  });

  it("returns false for an empty store", () => {
    assert.equal(hasEquivalentToolGotcha([], "write", "schema"), false);
  });
});
