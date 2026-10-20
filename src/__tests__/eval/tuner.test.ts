import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyTuningToConfig,
  buildCandidateGrid,
  runTuner,
  selectBestTuning,
  tuningDelta,
  type TuningCandidate,
} from "../../eval/tuner.js";
import type { GoldenLabel } from "../../eval/golden-set.js";
import type { SearchResult } from "../../core/interfaces.js";
import { DEFAULT_CONFIG } from "../../core/config.js";

const ROOT = "/repo";

const LABELS: GoldenLabel[] = [
  { id: "l-1", category: "nl", query: "how does the retriever work", files: ["src/retriever.ts"] },
  { id: "l-2", category: "symbol", query: "ensureCosineIndex", files: ["src/lancedb.ts"] },
];

function result(filePath: string, id: string, score = 0.9): SearchResult {
  return {
    chunk: {
      id,
      content: "function body",
      metadata: { filePath: `${ROOT}/${filePath}`, startLine: 1, endLine: 10, language: "typescript" },
    },
    score,
  };
}

/** A retrieve closure that ranks the expected file first for `good` candidates only. */
function makeRetrieve(goodWeights: TuningCandidate): (label: GoldenLabel, candidate: TuningCandidate) => Promise<SearchResult[]> {
  return async (label, candidate) => {
    const isGood = candidate.keywordWeight === goodWeights.keywordWeight;
    if (isGood) {
      return [result(label.files[0]!, "good-1")];
    }
    return [result("src/other.ts", "bad-1")];
  };
}

describe("buildCandidateGrid", () => {
  it("always includes the base candidate and never duplicates it", () => {
    const base: TuningCandidate = { keywordWeight: 0.4, minScore: 0.35, topK: 20 };
    const grid = buildCandidateGrid(base, { keywordWeights: [0.4, 0.5] });

    assert.equal(grid[0]!.keywordWeight, 0.4);
    assert.equal(grid[0]!.minScore, 0.35);
    assert.equal(grid[0]!.topK, 20);
    const keys = grid.map((c) => `${c.keywordWeight}|${c.symbolKeywordWeight ?? "unset"}|${c.minScore}|${c.topK}`);
    assert.equal(new Set(keys).size, keys.length, "no duplicate candidates");
  });

  it("sweeps keyword and symbol weights independently", () => {
    const base: TuningCandidate = { keywordWeight: 0.4, minScore: 0, topK: 10 };
    const grid = buildCandidateGrid(base, {
      keywordWeights: [0, 0.5],
      symbolKeywordWeights: [0, 0.9],
    });

    // 2 × 2 combinations + the base candidate (its symbol weight is unset, so
    // it is a distinct point of the space).
    assert.equal(grid.length, 5);
    assert.ok(grid.some((c) => c.keywordWeight === 0 && c.symbolKeywordWeight === 0.9));
    assert.ok(grid.some((c) => c.keywordWeight === 0.5 && c.symbolKeywordWeight === 0));
  });

  it("respects the candidate cap", () => {
    const base: TuningCandidate = { keywordWeight: 0.4, minScore: 0, topK: 10 };
    const grid = buildCandidateGrid(base, {
      keywordWeights: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
      symbolKeywordWeights: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
      maxCandidates: 10,
    });
    assert.equal(grid.length, 10);
  });
});

describe("runTuner", () => {
  it("measures every candidate and reports the metrics", async () => {
    const candidates: TuningCandidate[] = [
      { keywordWeight: 0, minScore: 0, topK: 10 },
      { keywordWeight: 0.4, minScore: 0, topK: 10 },
    ];

    const results = await runTuner({
      labels: LABELS,
      root: ROOT,
      candidates,
      retrieve: makeRetrieve({ keywordWeight: 0, minScore: 0, topK: 10 }),
    });

    assert.equal(results.length, 2);
    assert.equal(results[0]!.summary.hit1, 1, "the good candidate finds the expected file at rank 1");
    assert.equal(results[0]!.summary.ndcg10, 1);
    assert.equal(results[1]!.summary.hit1, 0, "the bad candidate misses it");
    assert.equal(results[0]!.outcomes.length, LABELS.length);
    assert.ok(results[0]!.durationMs >= 0);
  });

  it("passes the candidate through to the retrieve closure", async () => {
    const seen: number[] = [];
    await runTuner({
      labels: LABELS,
      root: ROOT,
      candidates: [
        { keywordWeight: 0.1, minScore: 0, topK: 10 },
        { keywordWeight: 0.9, minScore: 0, topK: 10 },
      ],
      retrieve: async (_label, candidate) => {
        seen.push(candidate.keywordWeight);
        return [result("src/retriever.ts", "x")];
      },
    });
    // Every candidate is queried once per label.
    assert.deepEqual(seen, [0.1, 0.1, 0.9, 0.9]);
  });
});

describe("selectBestTuning", () => {
  it("picks the candidate with the highest primary metric", async () => {
    const candidates: TuningCandidate[] = [
      { keywordWeight: 0, minScore: 0, topK: 10 },
      { keywordWeight: 0.4, minScore: 0, topK: 10 },
    ];
    const results = await runTuner({
      labels: LABELS,
      root: ROOT,
      candidates,
      retrieve: makeRetrieve({ keywordWeight: 0.4, minScore: 0, topK: 10 }),
    });

    const best = selectBestTuning(results, "ndcg10");
    assert.equal(best?.keywordWeight, 0.4);
  });

  it("returns undefined for an empty result set", () => {
    assert.equal(selectBestTuning([], "ndcg10"), undefined);
  });
});

describe("tuningDelta", () => {
  it("reports the difference between the winner and the current config", async () => {
    const candidates: TuningCandidate[] = [
      { keywordWeight: 0, minScore: 0, topK: 10 },
      { keywordWeight: 0.4, minScore: 0, topK: 10 },
    ];
    const results = await runTuner({
      labels: LABELS,
      root: ROOT,
      candidates,
      retrieve: makeRetrieve({ keywordWeight: 0.4, minScore: 0, topK: 10 }),
    });

    const best = selectBestTuning(results, "ndcg10")!;
    const current = results.find((r) => r.keywordWeight === 0)!;
    const delta = tuningDelta(best, current);

    assert.equal(delta.hit1, 1);
    assert.equal(delta.ndcg10, 1);
    assert.ok(Math.abs(delta.mrr! - 1) < 1e-9);
  });

  it("returns an empty object when there is no current config to compare", () => {
    assert.deepEqual(
      tuningDelta(
        {
          keywordWeight: 0,
          minScore: 0,
          topK: 10,
          summary: {
            hit1: 1, hit3: 1, hit5: 1, hit10: 1, precision5: 1, recall10: 1,
            mrr: 1, ndcg10: 1, symbolRate: 0, latencyAvg: 0, latencyP50: 0, latencyP95: 0,
          },
          outcomes: [],
          durationMs: 0,
        },
        undefined,
      ),
      {},
    );
  });
});

describe("applyTuningToConfig", () => {
  it("writes the winning weights into a copy of the config", () => {
    const tuned = applyTuningToConfig(DEFAULT_CONFIG, {
      keywordWeight: 0.1,
      symbolKeywordWeight: 0.2,
      minScore: 0.5,
      topK: 30,
    });

    assert.equal(tuned.retrieval.hybridSearch?.keywordWeight, 0.1);
    assert.equal(tuned.retrieval.hybridSearch?.symbolKeywordWeight, 0.2);
    assert.equal(tuned.retrieval.minScore, 0.5);
    assert.equal(tuned.retrieval.topK, 30);
  });

  it("does not mutate the original config", () => {
    const original = DEFAULT_CONFIG;
    const before = original.retrieval.hybridSearch?.keywordWeight;
    applyTuningToConfig(original, { keywordWeight: 0.9, minScore: 0.1, topK: 5 });
    assert.equal(original.retrieval.hybridSearch?.keywordWeight, before);
  });
});
