import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { LanceDbStore } from "../../vectorstore/lancedb.js";
import { KeywordIndex } from "../../retriever/keyword-index.js";
import { addQuirk } from "../../quirks/quirk-store.js";
import { createRecallQuirksTool } from "../../opencode/tools.js";
import { DEFAULT_CONFIG, type RagConfig } from "../../core/config.js";
import type { EmbeddingProvider } from "../../core/interfaces.js";
import type { QuirkStoreDeps } from "../../quirks/quirk-store.js";

const DIM = 8;

function makeEmbedder(): EmbeddingProvider {
  return {
    name: "mock",
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(() => new Array(DIM).fill(0).map(() => Math.random() * 2 - 1));
    },
  };
}

type ToolResult = { title?: string; output: string; metadata?: Record<string, unknown> };

describe("createRecallQuirksTool", () => {
  let store: LanceDbStore;
  let ki: KeywordIndex;
  let deps: QuirkStoreDeps;

  before(async () => {
    store = new LanceDbStore("memory://", DIM);
    ki = new KeywordIndex();
    // Random mock vectors must not be filtered by the similarity/confidence gates.
    const cfg = {
      ...DEFAULT_CONFIG,
      memory: { ...DEFAULT_CONFIG.memory, enabled: true, recallMinScore: 0, minConfidence: 0 },
    } as RagConfig;
    deps = { embedder: makeEmbedder(), store, keywordIndex: ki, cfg, storePath: "memory://" };
  });

  after(async () => {
    await store.clear({ noBackup: true });
    ki.close();
  });

  it("shows each result's full quirk id for update_quirk/delete_quirk", async () => {
    const q = await addQuirk(deps, {
      content: "displayed quirk ids need a regression test",
      quirkType: "gotcha",
      tags: ["quirks"],
    });

    const tool = createRecallQuirksTool({
      store: deps.store,
      embedder: deps.embedder,
      cfg: deps.cfg,
      keywordIndex: deps.keywordIndex,
      storePath: deps.storePath,
    });
    const exec = (tool as { execute: Function }).execute;
    const r = (await exec({ query: "displayed quirk ids regression", topK: 10 })) as ToolResult;

    // The ID must be the full prefixed form that update_quirk/delete_quirk compare literally.
    assert.ok(r.output.includes(`id: \`${q.id}\``), "output should show the full quirk id");
    const ids = r.metadata?.quirkIds;
    assert.ok(Array.isArray(ids) && ids.includes(q.id), "metadata.quirkIds should contain the quirk id");
  });
});
