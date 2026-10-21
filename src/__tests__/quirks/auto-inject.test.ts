import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SearchResult } from "../../core/interfaces.js";
import {
  contentOverlap,
  describeAutoInjectSelection,
  formatAutoInjectBlock,
  selectAutoInjectQuirks,
  selectAutoInjectQuirksWithinBudget,
  sharedTokenCount,
  tokenize,
  type AutoInjectRecall,
} from "../../quirks/auto-inject.js";

function result(id: string, content: string, rawSimilarity: number, quirkType = "gotcha"): SearchResult {
  return {
    score: rawSimilarity,
    explanation: {
      scoreBreakdown: {
        vectorScore: rawSimilarity,
        keywordScore: 0,
        rawVectorScore: rawSimilarity,
        rawKeywordScore: 0,
        keywordWeight: 0.4,
      },
    },
    chunk: {
      id,
      content,
      metadata: {
        filePath: `quirk:${id}`,
        startLine: 0,
        endLine: 0,
        language: "quirk",
        kind: "quirk",
        quirkType,
      },
    },
  };
}

function recallOf(results: SearchResult[]): AutoInjectRecall {
  return async () => results;
}

const BASE = { topK: 1, minTokenOverlap: 2, minScore: 0.75 };

describe("auto-inject lexical signals", () => {
  it("splits tokens and drops short filler", () => {
    assert.deepEqual(tokenize("A be cat dog"), ["cat", "dog"]);
  });

  it("counts filler tokens in the raw overlap but not in the content overlap", () => {
    const quirk = "the and this with that does not";
    const request = "does this with the and that";
    assert.ok(sharedTokenCount(quirk, request) >= 4, "filler must inflate the raw overlap");
    assert.equal(contentOverlap(quirk, request), 0, "no content word is shared");
    assert.equal(contentOverlap("npm install needs legacy peer deps", "npm install fails"), 2);
  });
});

describe("selectAutoInjectQuirks", () => {
  it("never injects without user text — a quirk must match the request, not the assistant", async () => {
    const selection = await selectAutoInjectQuirks(recallOf([result("q1", "npm peer deps", 0.9)]), {
      query: "assistant said something about npm peer deps",
      userText: "   ",
      options: BASE,
    });
    assert.equal(selection.hits.length, 0);
    assert.equal(selection.reason, "no-user-text");
  });

  it("ranks by content-word overlap before raw similarity", async () => {
    const strongTopic = result("topic", "legacy peer deps break npm install on lancedb", 0.80);
    const highSimilarity = result("similar", "the tool does this and that when you work", 0.95);
    const selection = await selectAutoInjectQuirks(recallOf([highSimilarity, strongTopic]), {
      query: "npm install lancedb",
      userText: "npm install fails because of legacy peer deps",
      options: BASE,
    });
    assert.equal(selection.hits.length, 1);
    assert.equal(selection.hits[0]!.id, "topic", "the topical quirk must win over a higher-similarity filler match");
    assert.equal(selection.hits[0]!.contentOverlap, 5);
  });

  it("rejects a candidate whose overlap is filler only", async () => {
    const filler = result("filler", "the and this with that does not", 0.99);
    const selection = await selectAutoInjectQuirks(recallOf([filler]), {
      query: "does this work with the tool",
      userText: "does this work with the tool",
      options: BASE,
    });
    assert.equal(selection.hits.length, 0);
    assert.equal(selection.reason, "gate");
    assert.equal(selection.droppedByGate, 1);
  });

  it("keeps searching past an ineligible top hit instead of blanking the turn", async () => {
    // The most similar quirk is about the wrong file; the second one is on topic.
    const top = result("top", "vitest snapshot update flow", 0.99);
    const second = result("second", "retry the edit call when path is dropped", 0.78);
    const selection = await selectAutoInjectQuirks(recallOf([top, second]), {
      query: "edit path dropped",
      userText: "edit tool failed because path was dropped",
      options: BASE,
    });
    assert.equal(selection.considered, 2, "both candidates were fetched");
    assert.equal(selection.hits.length, 1);
    assert.equal(selection.hits[0]!.id, "second");
  });

  it("skips quirks already injected in this session", async () => {
    const selection = await selectAutoInjectQuirks(recallOf([result("q1", "npm install peer deps", 0.9)]), {
      query: "npm install peer deps",
      userText: "npm install peer deps",
      options: { ...BASE, injectedIds: new Set(["q1"]) },
    });
    assert.equal(selection.hits.length, 0);
    assert.equal(selection.reason, "already-injected");
    assert.equal(selection.droppedAlreadyInjected, 1);
  });

  it("over-fetches candidates so the lexical gate has something to choose from", async () => {
    let asked = 0;
    const recall: AutoInjectRecall = async (_q, options) => {
      asked = options.topK;
      return [result("q1", "npm install peer deps", 0.9)];
    };
    await selectAutoInjectQuirks(recall, {
      query: "npm install peer deps",
      userText: "npm install peer deps",
      options: BASE,
    });
    assert.ok(asked >= 8, `expected an over-fetch, got topK=${asked}`);
  });

  it("reports a recall failure instead of throwing", async () => {
    const selection = await selectAutoInjectQuirks(
      async () => {
        throw new Error("embedding provider down");
      },
      { query: "npm install", userText: "npm install", options: BASE },
    );
    assert.equal(selection.reason, "recall-error");
    assert.equal(selection.hits.length, 0);
  });
});

describe("selectAutoInjectQuirksWithinBudget", () => {
  it("returns a budget result when recall hangs", async () => {
    const selection = await selectAutoInjectQuirksWithinBudget(
      () => new Promise<SearchResult[]>(() => {}),
      { query: "q", userText: "npm install", options: BASE },
      5,
    );
    assert.equal(selection.reason, "budget");
    assert.equal(selection.hits.length, 0);
  });

  it("passes through when no budget is set", async () => {
    const selection = await selectAutoInjectQuirksWithinBudget(recallOf([]), { query: "q", userText: "npm install", options: BASE }, 0);
    assert.equal(selection.reason, "no-candidates");
  });
});

describe("auto-inject formatting", () => {
  it("renders the quirk block with a type badge", async () => {
    const selection = await selectAutoInjectQuirks(recallOf([result("q1", "npm install peer deps", 0.9, "gotcha")]), {
      query: "npm install peer deps",
      userText: "npm install peer deps",
      options: BASE,
    });
    const block = formatAutoInjectBlock(selection.hits);
    assert.match(block, /Quirk memory/);
    assert.match(block, /\[`gotcha`\] npm install peer deps/);
    const systemBlock = formatAutoInjectBlock(selection.hits, { heading: "Relevant quirks", separator: false });
    assert.doesNotMatch(systemBlock, /^---$/m);
  });

  it("describes a selection for the log", async () => {
    const selection = await selectAutoInjectQuirks(recallOf([result("q1", "npm install peer deps", 0.9)]), {
      query: "npm install peer deps",
      userText: "npm install peer deps",
      options: BASE,
    });
    const line = describeAutoInjectSelection(selection);
    assert.match(line, /injected=1 \[q1 overlap=4 content=4 raw=0\.900\]/);
    assert.match(line, /found=1/);
  });
});
