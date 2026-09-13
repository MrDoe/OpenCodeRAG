import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { optimizeContext, DEFAULT_CONTEXT_OPTIMIZATION, type ContextOptimizationOptions } from "../../retriever/context-optimizer.js";
import type { SearchResult } from "../../core/interfaces.js";

function makeResult(
  id: string,
  filePath: string,
  startLine: number,
  endLine: number,
  content: string,
  score: number,
  language = "typescript"
): SearchResult {
  return {
    chunk: {
      id,
      content,
      metadata: { filePath, startLine, endLine, language },
    },
    score,
  };
}

function defaultOptions(overrides?: Partial<ContextOptimizationOptions>): ContextOptimizationOptions {
  return {
    topK: 10,
    config: { ...DEFAULT_CONTEXT_OPTIMIZATION, ...overrides?.config },
    ...overrides,
  };
}

describe("optimizeContext", () => {
  // ── Adjacent merge ──

  it("merges touching adjacent chunks", () => {
    const results = [
      makeResult("a", "file.ts", 1, 40, "function foo() {\n  return 1;\n}", 0.9),
      makeResult("b", "file.ts", 41, 80, "function bar() {\n  return 2;\n}", 0.8),
    ];
    const opt = optimizeContext(results, defaultOptions());
    assert.equal(opt.length, 1);
    assert.equal(opt[0]!.chunk.metadata.startLine, 1);
    assert.equal(opt[0]!.chunk.metadata.endLine, 80);
    assert.equal(opt[0]!.score, 0.9);
    assert.ok(opt[0]!.optimized?.mergedFrom);
    assert.equal(opt[0]!.optimized!.mergedFrom!.length, 2);
    assert.ok(opt[0]!.chunk.id.startsWith("merged:"));
  });

  it("merges adjacent chunks with a small gap", () => {
    const results = [
      makeResult("a", "file.ts", 1, 40, "function foo() {}", 0.9),
      makeResult("b", "file.ts", 44, 80, "function bar() {}", 0.8),
    ];
    // gap = 44 - 40 = 4, threshold default is 5, so 4 <= 5+1 → merged
    const opt = optimizeContext(results, defaultOptions());
    assert.equal(opt.length, 1);
    assert.equal(opt[0]!.chunk.metadata.endLine, 80);
  });

  it("does NOT merge chunks with a large gap", () => {
    const results = [
      makeResult("a", "file.ts", 1, 40, "function foo() {}", 0.9),
      makeResult("b", "file.ts", 60, 80, "function bar() {}", 0.8),
    ];
    // gap = 60 - 40 = 20 > 5+1 → not merged
    const opt = optimizeContext(results, defaultOptions());
    assert.equal(opt.length, 2);
  });

  it("does not merge when mergeAdjacent is disabled", () => {
    const results = [
      makeResult("a", "file.ts", 1, 40, "function foo() {}", 0.9),
      makeResult("b", "file.ts", 41, 80, "function bar() {}", 0.8),
    ];
    const opt = optimizeContext(results, defaultOptions({
      config: { ...DEFAULT_CONTEXT_OPTIMIZATION, mergeAdjacent: false },
    }));
    assert.equal(opt.length, 2);
  });

  it("merges multiple adjacent chunks in sequence", () => {
    const results = [
      makeResult("a", "file.ts", 1, 20, "part1", 0.9),
      makeResult("b", "file.ts", 21, 40, "part2", 0.85),
      makeResult("c", "file.ts", 41, 60, "part3", 0.8),
    ];
    const opt = optimizeContext(results, defaultOptions());
    assert.equal(opt.length, 1);
    assert.equal(opt[0]!.chunk.metadata.startLine, 1);
    assert.equal(opt[0]!.chunk.metadata.endLine, 60);
    assert.equal(opt[0]!.score, 0.9);
    assert.equal(opt[0]!.optimized!.mergedFrom!.length, 3);
  });

  it("merges across a gap with space between chunks", () => {
    const results = [
      makeResult("a", "file.ts", 1, 40, "chunk a with some content here", 0.9),
      makeResult("b", "file.ts", 45, 80, "chunk b with some other content", 0.85),
    ];
    // gap = 45 - 40 = 5, threshold = 5, 5 <= 6 → merged
    const opt = optimizeContext(results, defaultOptions({
      config: { ...DEFAULT_CONTEXT_OPTIMIZATION, adjacentGapThreshold: 5 },
    }));
    assert.equal(opt.length, 1);
  });

  // ── Similarity dedup ──

  it("deduplicates similar same-file chunks by Jaccard similarity", () => {
    const results = [
      makeResult("a", "file.ts", 1, 40, "function foo() { return x + y; }", 0.9),
      makeResult("b", "file.ts", 50, 90, "function foo() { return x + y; }", 0.7),
    ];
    const opt = optimizeContext(results, defaultOptions({
      config: { ...DEFAULT_CONTEXT_OPTIMIZATION, mergeAdjacent: false, similarityThreshold: 0.3 },
    }));
    assert.equal(opt.length, 1);
    assert.equal(opt[0]!.chunk.id, "a");
    assert.equal(opt[0]!.optimized!.dedupedFrom!.length, 1);
    assert.equal(opt[0]!.optimized!.dedupedFrom![0], "b");
  });

  it("keeps the later chunk without crashing when it outscores the earlier one (regression)", () => {
    const results = [
      makeResult("a", "file.ts", 1, 40, "function foo() { return x + y; }", 0.7),
      makeResult("b", "file.ts", 50, 90, "function foo() { return x + y; }", 0.9),
    ];
    const opt = optimizeContext(results, defaultOptions({
      config: { ...DEFAULT_CONTEXT_OPTIMIZATION, mergeAdjacent: false, similarityThreshold: 0.3 },
    }));
    assert.equal(opt.length, 1);
    assert.equal(opt[0]!.chunk.id, "b");
    assert.equal(opt[0]!.score, 0.9);
    assert.deepEqual(opt[0]!.optimized!.dedupedFrom, ["a"]);
  });

  it("keeps both chunks when similarity is below threshold", () => {
    const results = [
      makeResult("a", "file.ts", 1, 40, "function foo() { return x; }", 0.9),
      makeResult("b", "file.ts", 50, 90, "class Bar { constructor() {} }", 0.7),
    ];
    const opt = optimizeContext(results, defaultOptions({
      config: { ...DEFAULT_CONTEXT_OPTIMIZATION, mergeAdjacent: false },
    }));
    assert.equal(opt.length, 2);
  });

  it("keeps both chunks from different files even with identical content", () => {
    const content = "function foo() { return x + y; }";
    const results = [
      makeResult("a", "file1.ts", 1, 40, content, 0.9),
      makeResult("b", "file2.ts", 1, 40, content, 0.8),
    ];
    const opt = optimizeContext(results, defaultOptions({
      config: { ...DEFAULT_CONTEXT_OPTIMIZATION, mergeAdjacent: false, similarityThreshold: 0.1 },
    }));
    assert.equal(opt.length, 2);
  });

  it("handles single chunk (no dedup needed)", () => {
    const results = [
      makeResult("a", "file.ts", 1, 40, "unique content", 0.9),
    ];
    const opt = optimizeContext(results, defaultOptions({
      config: { ...DEFAULT_CONTEXT_OPTIMIZATION, mergeAdjacent: false },
    }));
    assert.equal(opt.length, 1);
    assert.equal(opt[0]!.chunk.id, "a");
  });

  // ── File-level cap ──

  it("caps chunks per file to maxPerFile — strict per-file limit", () => {
    const results = [
      makeResult("a", "file.ts", 1, 10, "function foo() {}", 0.95),
      makeResult("b", "file.ts", 20, 30, "function bar() {}", 0.9),
      makeResult("c", "file.ts", 40, 50, "function baz() {}", 0.85),
      makeResult("d", "file.ts", 60, 70, "function qux() {}", 0.8),
      makeResult("e", "file.ts", 80, 90, "function quux() {}", 0.75),
    ];
    const opt = optimizeContext(results, defaultOptions({
      topK: 10,
      config: { ...DEFAULT_CONTEXT_OPTIMIZATION, mergeAdjacent: false, maxPerFile: 2 },
    }));
    // Strict per-file cap: only 2 from file.ts even though topK=10 has room
    const fileResults = opt.filter((r) => r.chunk.metadata.filePath === "file.ts");
    assert.equal(fileResults.length, 2);
    assert.equal(fileResults[0]!.chunk.id, "a");
    assert.equal(fileResults[1]!.chunk.id, "b");
  });

  it("enforces per-file cap — does NOT exceed maxPerFile from any single file", () => {
    const results = [
      makeResult("a1", "fileA.ts", 1, 10, "function fooA() {}", 0.95),
      makeResult("a2", "fileA.ts", 20, 30, "function barA() {}", 0.9),
      makeResult("a3", "fileA.ts", 40, 50, "function bazA() {}", 0.85),
      makeResult("a4", "fileA.ts", 60, 70, "function quxA() {}", 0.8),
      makeResult("b1", "fileB.ts", 1, 10, "function fooB() {}", 0.88),
      makeResult("c1", "fileC.ts", 1, 10, "function fooC() {}", 0.7),
    ];
    const opt = optimizeContext(results, defaultOptions({
      topK: 6,
      config: { ...DEFAULT_CONTEXT_OPTIMIZATION, mergeAdjacent: false, maxPerFile: 2 },
    }));
    // fileA has 4 items cap at 2; fileB 1; fileC 1 → capped count = 4
    // backfill from fileA reserve fills remaining 2 → total 6
    const fileACount = opt.filter((r) => r.chunk.metadata.filePath === "fileA.ts").length;
    assert.ok(fileACount <= 2);
  });

  it("returns fewer than topK when per-file caps exhaust available items", () => {
    // fileA has 4 items but maxPerFile=2, so only 2 from fileA are eligible.
    // With fileB (1) and fileC (1), total eligible = 4, but topK=5.
    // The result should be 4 — we can't include items from fileA beyond its cap.
    const results = [
      makeResult("a1", "fileA.ts", 1, 10, "function fooA() {}", 0.95),
      makeResult("a2", "fileA.ts", 20, 30, "function barA() {}", 0.9),
      makeResult("a3", "fileA.ts", 40, 50, "function bazA() {}", 0.85),
      makeResult("a4", "fileA.ts", 60, 70, "function quxA() {}", 0.8),
      makeResult("b1", "fileB.ts", 1, 10, "function fooB() {}", 0.88),
      makeResult("c1", "fileC.ts", 1, 10, "function fooC() {}", 0.7),
    ];
    const opt = optimizeContext(results, defaultOptions({
      topK: 5,
      config: { ...DEFAULT_CONTEXT_OPTIMIZATION, mergeAdjacent: false, maxPerFile: 2 },
    }));
    // Only 4 items are eligible (2 from fileA + 1 from fileB + 1 from fileC)
    assert.equal(opt.length, 4);
    assert.equal(opt[0]!.chunk.id, "a1");
    assert.equal(opt[1]!.chunk.id, "a2");
    assert.equal(opt[2]!.chunk.id, "b1");
    assert.equal(opt[3]!.chunk.id, "c1");
  });

  it("is a no-op when maxPerFile is 0", () => {
    const results = [
      makeResult("a", "file.ts", 1, 10, "function foo() {}", 0.95),
      makeResult("b", "file.ts", 20, 30, "function bar() {}", 0.9),
      makeResult("c", "file.ts", 40, 50, "function baz() {}", 0.85),
    ];
    const opt = optimizeContext(results, defaultOptions({
      config: { ...DEFAULT_CONTEXT_OPTIMIZATION, mergeAdjacent: false, maxPerFile: 0 },
    }));
    assert.equal(opt.length, 3);
  });

  it("sets fileCapped=true on kept chunks when file exceeded maxPerFile", () => {
    const results = [
      makeResult("a", "file.ts", 1, 10, "function foo() {}", 0.95),
      makeResult("b", "file.ts", 20, 30, "function bar() {}", 0.9),
      makeResult("c", "file.ts", 40, 50, "function baz() {}", 0.85),
    ];
    const opt = optimizeContext(results, defaultOptions({
      topK: 3,
      config: { ...DEFAULT_CONTEXT_OPTIMIZATION, mergeAdjacent: false, maxPerFile: 2 },
    }));
    // file.ts exceeds 2 cap; topK=3 allows backfill of 1 reserve → all 3 come back
    assert.equal(opt.filter((r) => r.optimized?.fileCapped === true).length, 2);
  });

  it("does NOT set fileCapped when file is within limit", () => {
    const results = [
      makeResult("a", "file.ts", 1, 10, "a", 0.95),
      makeResult("b", "file.ts", 20, 30, "b", 0.9),
    ];
    const opt = optimizeContext(results, defaultOptions({
      config: { ...DEFAULT_CONTEXT_OPTIMIZATION, mergeAdjacent: false, maxPerFile: 3 },
    }));
    // Both are within limit, fileCapped should be false for both
    for (const r of opt) {
      assert.equal(r.optimized?.fileCapped, false);
    }
  });

  // ── Edge cases ──

  it("returns empty array for empty input", () => {
    const opt = optimizeContext([], defaultOptions());
    assert.deepStrictEqual(opt, []);
  });

  it("passes through results unchanged when disabled", () => {
    const results = [
      makeResult("a", "file.ts", 1, 40, "some content", 0.9),
      makeResult("b", "file.ts", 41, 80, "other content", 0.8),
    ];
    const opt = optimizeContext(results, defaultOptions({
      config: { ...DEFAULT_CONTEXT_OPTIMIZATION, enabled: false },
    }));
    assert.equal(opt.length, 2);
    // No optimized metadata
    for (const r of opt) {
      assert.equal(r.optimized, undefined);
    }
  });

  it("respects topK limit", () => {
    const results = [
      makeResult("a", "file1.ts", 1, 10, "a", 0.95),
      makeResult("b", "file2.ts", 1, 10, "b", 0.9),
      makeResult("c", "file3.ts", 1, 10, "c", 0.85),
      makeResult("d", "file4.ts", 1, 10, "d", 0.8),
    ];
    const opt = optimizeContext(results, defaultOptions({ topK: 2 }));
    assert.equal(opt.length, 2);
    assert.equal(opt[0]!.chunk.id, "a");
    assert.equal(opt[1]!.chunk.id, "b");
  });

  it("preserves explanation metadata when present", () => {
    const results: SearchResult[] = [{
      chunk: {
        id: "a",
        content: "function foo() { return 1; }",
        metadata: { filePath: "file.ts", startLine: 1, endLine: 40, language: "ts" },
      },
      score: 0.9,
      explanation: {
        scoreBreakdown: {
          vectorScore: 0.9, keywordScore: 0, rawVectorScore: 0.9, rawKeywordScore: 0, keywordWeight: 0.4,
        },
        matchedTerms: ["foo"],
      },
    }];
    const opt = optimizeContext(results, defaultOptions());
    assert.equal(opt.length, 1);
    assert.notEqual(opt[0]!.explanation, undefined);
    assert.equal(opt[0]!.explanation!.matchedTerms![0], "foo");
  });

  // ── Combined pipeline ──

  it("applies merge -> dedup -> cap in sequence", () => {
    const results = [
      // fileA: two adjacent chunks that will merge
      makeResult("a1", "fileA.ts", 1, 20, "function a() {}", 0.95),
      makeResult("a2", "fileA.ts", 21, 40, "function b() {}", 0.9),
      // fileB: two near-identical chunks (dedup)
      makeResult("b1", "fileB.ts", 1, 20, "function foo() { return x; }", 0.88),
      makeResult("b2", "fileB.ts", 30, 50, "function foo() { return x; }", 0.7),
      // fileC: single chunk
      makeResult("c1", "fileC.ts", 1, 30, "class Bar {}", 0.85),
    ];
    const opt = optimizeContext(results, defaultOptions({
      topK: 3,
      config: { ...DEFAULT_CONTEXT_OPTIMIZATION, mergeAdjacent: true, maxPerFile: 1, similarityThreshold: 0.3 },
    }));
    // After merge: fileA -> 1 merged chunk (score 0.95)
    // After dedup: fileB -> 1 chunk (b1, score 0.88)
    // After cap (maxPerFile=1): fileA: 1, fileB: 1, fileC: 1
    // topK=3 means all 3 are kept
    assert.equal(opt.length, 3);
    assert.ok(opt[0]!.chunk.id.startsWith("merged:"));
    assert.equal(opt[1]!.chunk.id, "b1");
    assert.equal(opt[2]!.chunk.id, "c1");
  });

  it("handles results from multiple files with no overlaps", () => {
    const results = [
      makeResult("a", "src/a.ts", 1, 10, "aaa", 0.9),
      makeResult("b", "src/b.ts", 1, 10, "bbb", 0.85),
      makeResult("c", "src/c.ts", 1, 10, "ccc", 0.8),
    ];
    const opt = optimizeContext(results, defaultOptions({
      config: { ...DEFAULT_CONTEXT_OPTIMIZATION, mergeAdjacent: false },
    }));
    assert.equal(opt.length, 3);
  });

  it("merges then dedupes the merged result correctly", () => {
    // Two adjacent near-identical chunks: merge first, then the merged result
    // should not get deduped further since it's the only one left in its file
    const results = [
      makeResult("a", "file.ts", 1, 20, "function dup() { return 1; }", 0.9),
      makeResult("b", "file.ts", 21, 40, "function dup() { return 1; }", 0.8),
    ];
    const opt = optimizeContext(results, defaultOptions({
      config: { ...DEFAULT_CONTEXT_OPTIMIZATION, mergeAdjacent: true, similarityThreshold: 0.1 },
    }));
    // They merge first, then the merged chunk is alone so no dedup
    assert.equal(opt.length, 1);
    assert.equal(opt[0]!.optimized!.mergedFrom!.length, 2);
    assert.equal(opt[0]!.optimized!.dedupedFrom, undefined);
  });

  it("preserves content order after merge", () => {
    const results = [
      makeResult("a", "file.ts", 1, 10, "first chunk content", 0.9),
      makeResult("b", "file.ts", 11, 20, "second chunk content", 0.8),
    ];
    const opt = optimizeContext(results, defaultOptions());
    assert.equal(opt.length, 1);
    assert.ok(opt[0]!.chunk.content.includes("first chunk content"));
    assert.ok(opt[0]!.chunk.content.includes("second chunk content"));
    // Order should be first then second
    const firstIdx = opt[0]!.chunk.content.indexOf("first chunk content");
    const secondIdx = opt[0]!.chunk.content.indexOf("second chunk content");
    assert.ok(firstIdx < secondIdx, "content order should be preserved");
  });
});
