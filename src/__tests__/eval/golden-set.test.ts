/**
 * @fileoverview Unit tests for the shared golden-set metrics and the eval:gate thresholds.
 * No embedder or store is needed — every ranking input is synthetic.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  evaluateGoldenResults,
  loadGoldenLabels,
  summarizeGoldenOutcomes,
  type GoldenLabel,
  type GoldenOutcome,
  type GoldenSummary,
} from "../../eval/golden-set.js";
import { evaluateGate, runGoldenGate } from "../../eval/golden-gate.js";
import type { SearchResult } from "../../core/interfaces.js";

const ROOT = resolve("/test/root");

function result(file: string, content = "code", score = 0.5): SearchResult {
  return {
    score,
    chunk: {
      id: `${file}:${content}`,
      content,
      metadata: { filePath: join(ROOT, file), startLine: 1, endLine: 2, language: "ts" },
    },
  };
}

function label(overrides?: Partial<GoldenLabel>): GoldenLabel {
  return { id: "l1", category: "nl", query: "q", files: ["src/a.ts"], ...overrides };
}

function summary(overrides?: Partial<GoldenSummary>): GoldenSummary {
  return {
    hit1: 0.2,
    hit3: 0.5,
    hit5: 0.5,
    hit10: 0.8,
    precision5: 0.12,
    recall10: 0.8,
    mrr: 0.35,
    ndcg10: 0.45,
    symbolRate: 0,
    latencyAvg: 100,
    latencyP50: 100,
    latencyP95: 200,
    ...overrides,
  };
}

describe("golden-set metrics", () => {
  it("scores rank, hit@k, and reciprocal rank against the expected files", () => {
    const metrics = evaluateGoldenResults(ROOT, label(), [result("src/b.ts"), result("src/a.ts")]);
    assert.equal(metrics.firstHitRank, 2);
    assert.equal(metrics.hitAt1, 0);
    assert.equal(metrics.hitAt3, 1);
    assert.equal(metrics.rr, 0.5);
  });

  it("deduplicates repeated files and computes nDCG over binary gains", () => {
    const metrics = evaluateGoldenResults(
      ROOT,
      label({ files: ["src/a.ts", "src/b.ts"] }),
      [result("src/a.ts", "first"), result("src/a.ts", "second"), result("src/b.ts")],
    );
    assert.equal(metrics.firstHitRank, 1);
    assert.equal(metrics.precision5, 2 / 5);
    assert.equal(metrics.recall10, 1);
    // DCG = 1/log2(2) + 1/log2(4) = 1.5; IDCG over two ideal ranks = 1/log2(2) + 1/log2(3).
    assert.ok(
      Math.abs(metrics.ndcg10 - 1.5 / (1 + 1 / Math.log2(3))) < 1e-12,
      `unexpected nDCG: ${metrics.ndcg10}`,
    );
  });

  it("reports the rank of the chunk containing the expected symbol", () => {
    const metrics = evaluateGoldenResults(
      ROOT,
      label({ symbol: "needle" }),
      [result("src/b.ts"), result("src/a.ts", "contains needle here")],
    );
    assert.equal(metrics.symbolHitRank, 2);
  });

  it("aggregates outcomes including the symbol rate", () => {
    const hit = evaluateGoldenResults(ROOT, label({ id: "hit" }), [result("src/a.ts")]);
    const miss = evaluateGoldenResults(ROOT, label({ id: "miss", symbol: "x" }), []);
    const outcomes: GoldenOutcome[] = [
      { label: label({ id: "hit" }), latencyMs: 10, ...hit },
      { label: label({ id: "miss", symbol: "x" }), latencyMs: 30, ...miss },
    ];
    const aggregate = summarizeGoldenOutcomes(outcomes);
    assert.equal(aggregate.hit1, 0.5);
    assert.equal(aggregate.mrr, 0.5);
    assert.equal(aggregate.symbolRate, 0, "missing symbol must lower the symbol rate");
    assert.equal(aggregate.latencyAvg, 20);
  });
});

describe("loadGoldenLabels", () => {
  it("loads a valid label file and rejects malformed labels", () => {
    const dir = mkdtempSync(join(tmpdir(), "golden-labels-"));
    try {
      const good = join(dir, "good.json");
      writeFileSync(good, JSON.stringify({ version: 1, labels: [{ id: "a", category: "nl", query: "q", files: ["x.ts"] }] }), "utf-8");
      assert.equal(loadGoldenLabels(good).length, 1);

      const bad = join(dir, "bad.json");
      writeFileSync(bad, JSON.stringify({ version: 1, labels: [{ id: "a", query: "q", files: [] }] }), "utf-8");
      assert.throws(() => loadGoldenLabels(bad), /Malformed label/);

      assert.throws(() => loadGoldenLabels(join(dir, "missing.json")), /not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("evaluateGate", () => {
  it("passes when every checked metric clears its floor", () => {
    const { pass, rows } = evaluateGate(summary(), { hit5: 0.35, mrr: 0.25, ndcg10: 0.32 });
    assert.equal(pass, true);
    assert.equal(rows.length, 3);
  });

  it("fails when a metric drops below its floor", () => {
    const { pass, rows } = evaluateGate(summary({ mrr: 0.1 }), { hit5: 0.35, mrr: 0.25, ndcg10: 0.32 });
    assert.equal(pass, false);
    assert.equal(rows.find((row) => row.metric === "MRR")?.pass, false);
  });

  it("skips metrics with no threshold", () => {
    const { pass, rows } = evaluateGate(summary({ ndcg10: 0 }), { hit5: 0.35 });
    assert.equal(pass, true);
    assert.deepEqual(rows.map((row) => row.metric), ["Hit@5"]);
  });
});

describe("runGoldenGate", () => {
  it("runs every label through the retrieve closure and aggregates", async () => {
    const lines: string[] = [];
    const { summary: aggregate, outcomes } = await runGoldenGate({
      labels: [label({ id: "l1" }), label({ id: "l2", files: ["src/missing.ts"] })],
      root: ROOT,
      retrieve: async (l) => (l.id === "l1" ? [result("src/a.ts")] : []),
      log: (line) => lines.push(line),
    });
    assert.equal(outcomes.length, 2);
    assert.equal(aggregate.hit1, 0.5);
    assert.equal(lines.length, 2);
  });
});
