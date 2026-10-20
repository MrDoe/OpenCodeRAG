import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyTuningToConfig,
  buildCandidateGrid,
  comparePaired,
  signTestP,
  measureSignalQuality,
  runTuner,
  selectBestTuning,
  tuningDelta,
  type TuningCandidate,
  type TuningResult,
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

/** Build a TuningResult with a controllable per-label nDCG vector. */
function makeResult(ndcgs: number[], keywordWeight = 0): TuningResult {
  return {
    keywordWeight,
    symbolKeywordWeight: undefined,
    minScore: 0,
    topK: 10,
    summary: {
      hit1: 0, hit3: 0, hit5: 0, hit10: 0, precision5: 0, recall10: 0,
      mrr: 0, ndcg10: ndcgs.reduce((s, v) => s + v, 0) / ndcgs.length,
      symbolRate: 0, latencyAvg: 0, latencyP50: 0, latencyP95: 0,
    },
    outcomes: ndcgs.map((n, i) => ({
      label: { id: `l-${i}`, category: "nl", query: "q", files: ["src/a.ts"] },
      latencyMs: 1,
      firstHitRank: 1,
      hitAt1: 1, hitAt3: 1, hitAt5: 1, hitAt10: 1,
      precision5: 1, recall10: 1, rr: 1, ndcg10: n, symbolHitRank: null,
      topFiles: [], rerankRan: false,
    })),
    durationMs: 1,
  };
}

/** Deterministic RNG (LCG) so the bootstrap test is reproducible. */
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

describe("comparePaired", () => {
  it("returns undefined without a comparison target", () => {
    assert.equal(comparePaired(makeResult([1, 1]), undefined), undefined);
  });

  it("reports a clear improvement as significant", () => {
    const better = makeResult([1, 1, 1, 1, 1, 1, 1, 1], 0);
    const worse = makeResult([0, 0, 0, 0, 0, 0, 0, 0], 0.4);
    const cmp = comparePaired(better, worse, "ndcg10", 2000, seededRng(7));

    assert.ok(cmp);
    assert.equal(cmp.meanDelta, 1);
    assert.ok(cmp.ciLow > 0, "the CI must exclude 0 for a clear win");
    assert.equal(cmp.withinNoise, false);
    assert.equal(cmp.improved, 8);
    assert.equal(cmp.regressed, 0);
  });

  it("flags a mixed result as within noise", () => {
    // Half the labels improve, half regress — the point estimate is positive
    // but the CI must include 0.
    const better = makeResult([1, 0, 1, 0, 1, 0, 1, 0], 0);
    const worse = makeResult([0, 1, 0, 1, 0, 1, 0, 1], 0.4);
    const cmp = comparePaired(better, worse, "ndcg10", 2000, seededRng(11));

    assert.ok(cmp);
    assert.equal(cmp.meanDelta, 0);
    assert.equal(cmp.improved, 4);
    assert.equal(cmp.regressed, 4);
    assert.equal(cmp.withinNoise, true);
  });

  it("counts an exact tie as within noise", () => {
    const a = makeResult([1, 0, 1, 0]);
    const b = makeResult([1, 0, 1, 0]);
    const cmp = comparePaired(a, b, "ndcg10", 100, seededRng(3));

    assert.ok(cmp);
    assert.equal(cmp.meanDelta, 0);
    assert.equal(cmp.unchanged, 4);
    assert.equal(cmp.withinNoise, true);
  });
});

describe("measureSignalQuality", () => {
  it("measures each signal on its own", async () => {
    const signals = await measureSignalQuality({
      labels: LABELS,
      root: ROOT,
      retrieveKeyword: async (label) => [result(label.files[0]!, "kw")],
      retrieveVector: async (label) => [result(label.files[0]!, "vec")],
      retrieveFused: async () => [result("src/other.ts", "fused")],
    });

    assert.equal(signals.keyword.hit1, 1);
    assert.equal(signals.vector.hit1, 1);
    assert.equal(signals.fused.hit1, 0);
    assert.equal(signals.fused.misses, LABELS.length);
  });
});

describe("signTestP", () => {
  it("returns 1 when no label flipped", () => {
    assert.equal(signTestP(0, 0), 1);
  });

  it("is 1 for a perfectly even split", () => {
    assert.equal(signTestP(1, 1), 1);
  });

  it("is small for a lopsided split", () => {
    assert.ok(signTestP(19, 0) < 0.01, "19-0 must be significant");
  });

  it("matches the known 15-vs-8 reading (p ~ 0.21 two-sided)", () => {
    const p = signTestP(15, 8);
    assert.ok(p > 0.19 && p < 0.22, `expected ~0.21, got ${p}`);
  });
});
