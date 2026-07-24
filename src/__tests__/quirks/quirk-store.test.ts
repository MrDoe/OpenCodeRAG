import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { LanceDbStore } from "../../vectorstore/lancedb.js";
import { KeywordIndex } from "../../retriever/keyword-index.js";
import { addQuirk, recallQuirks, removeQuirk, listQuirks, lintQuirks } from "../../quirks/quirk-store.js";
import { isQuirkAllowed } from "../../quirks/monitor.js";
import type { EmbeddingProvider } from "../../core/interfaces.js";
import type { RagConfig } from "../../core/config.js";
import type { QuirkStoreDeps } from "../../quirks/quirk-store.js";

const DIM = 8;

function makeEmbedder(): EmbeddingProvider {
  return {
    name: "mock",
    async embed(texts: string[], _purpose?: "query" | "document"): Promise<number[][]> {
      return texts.map(() => new Array(DIM).fill(0).map(() => Math.random() * 2 - 1));
    },
  };
}

const MINIMAL_CFG = {
  embedding: { provider: "mock", baseUrl: "", model: "mock", documentPrefix: "", queryPrefix: "" },
  indexing: { includeExtensions: [], excludeDirs: [], chunkOverlap: 0, concurrency: 1, embedBatchSize: 1 },
  retrieval: { topK: 10, minScore: 0, hybridSearch: { enabled: false, keywordWeight: 0 }, contextOptimization: { enabled: false, maxPerFile: 0, mergeAdjacent: false, adjacentGapThreshold: 0, similarityThreshold: 0 } },
  openCode: { enabled: false, maxContextChunks: 5 },
  tui: { fileListKeybinding: "", chunksKeybinding: "" },
  logging: { level: "none" as const, logFilePath: "" },
  memory: { enabled: true, autoInject: false, minConfidence: 0.3, recallMinScore: 0, autoInjectMinScore: 0.6, autoInjectTopK: 2, autoInjectLatencyBudgetMs: 2000, decay: { enabled: false, halfLifeDays: 30 } },
} as unknown as RagConfig;

describe("quirk-store", () => {
  let store: LanceDbStore;
  let ki: KeywordIndex;
  let embedder: EmbeddingProvider;
  let deps: QuirkStoreDeps;

  before(async () => {
    store = new LanceDbStore("memory://", DIM);
    ki = new KeywordIndex();
    embedder = makeEmbedder();
    deps = { embedder, store, keywordIndex: ki, cfg: MINIMAL_CFG, storePath: "memory://" };
  });

  after(async () => {
    await store.clear({ noBackup: true });
    ki.close();
  });

  it("adds a quirk and recalls it", async () => {
    const q = await addQuirk(deps, {
      content: "use --legacy-peer-deps with npm install due to LanceDB conflicts",
      quirkType: "gotcha",
      tags: ["npm", "lancedb"],
    });

    assert.ok(q.id);
    assert.equal(q.quirkType, "gotcha");
    assert.deepEqual(q.tags, ["npm", "lancedb"]);
    assert.equal(q.confidence, 1);

    const results = await recallQuirks(deps, "npm install legacy deps");
    assert.ok(results.length > 0, "should recall the quirk");
    assert.equal(results[0]!.chunk.metadata.kind, "quirk");
    assert.equal(results[0]!.chunk.metadata.quirkType, "gotcha");
  });

  it("filters out code chunks (non-quirk)", async () => {
    // Add a normal code chunk
    await store.addChunks([{
      id: "code-1",
      content: "function foo() { return 42; }",
      embedding: new Array(DIM).fill(0.1),
      metadata: { filePath: "src/a.ts", startLine: 1, endLine: 5, language: "typescript" },
    }]);

    // Recall with a quirk filter should return only quirks, not code chunks
    const results = await recallQuirks(deps, "npm install legacy deps");
    for (const r of results) {
      assert.equal(r.chunk.metadata.kind, "quirk", "all results should be quirks");
      assert.notEqual(r.chunk.metadata.language, "typescript", "should not return code chunks");
    }
  });

  it("removes a quirk", async () => {
    const quirkId = (await addQuirk(deps, { content: "temporary quirk" })).id;

    await removeQuirk(deps, quirkId);

    const all = await listQuirks(deps);
    const found = all.some((q) => q.id === quirkId);
    assert.equal(found, false, "should not find removed quirk by id");
  });

  it("lists quirks", async () => {
    await addQuirk(deps, { content: "list test quirk alpha" });
    await addQuirk(deps, { content: "list test quirk beta" });

    const quirks = await listQuirks(deps);
    const matching = quirks.filter((q) => q.content.startsWith("list test quirk"));
    assert.ok(matching.length >= 2, "should list added quirks");
  });

  it("lint detects low confidence", async () => {
    await addQuirk(deps, { content: "low confidence quirk", confidence: 0.1 });

    const issues = await lintQuirks(deps);
    const lowConf = issues.filter((i) => i.includes("Low confidence"));
    assert.ok(lowConf.length > 0, "should flag low confidence quirks");
  });

  it("monitor rejects blocked patterns", () => {
    const result = isQuirkAllowed("we should skip the tests entirely");
    assert.equal(result.ok, false, "should reject skip tests pattern");
    assert.ok(result.reason);

    const ok = isQuirkAllowed("use --legacy-peer-deps for npm");
    assert.equal(ok.ok, true, "should allow normal content");
  });

  it("memory:// store works without fs persistence", async () => {
    const memDeps = { ...deps, storePath: "memory://" };
    const q = await addQuirk(memDeps, { content: "memory test" });
    assert.ok(q.id, "quirk should have an id");
    const results = await recallQuirks(memDeps, "memory test");
    assert.ok(results.length > 0);
  });
});
