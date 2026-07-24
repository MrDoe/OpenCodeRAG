import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Chunk, DescriptionProvider } from "../../core/interfaces.js";
import { generateDescriptions } from "../../indexer/description-stage.js";

function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    id: overrides.id ?? "chunk-1",
    content: "export function hello() { return 'world'; }",
    metadata: {
      filePath: "src/hello.ts",
      startLine: 1,
      endLine: 3,
      language: "typescript",
      ...overrides.metadata,
    },
    ...overrides,
  };
}

const noopLogger = { warn: () => {}, debug: () => {} };

describe("generateDescriptions", () => {
  it("skips LLM for chunks with pre-existing description", async () => {
    let llmCalledCount = 0;
    const provider: DescriptionProvider = {
      generateDescription: async () => {
        llmCalledCount++;
        return "LLM description";
      },
      generateBatchDescriptions: async () => {
        llmCalledCount++;
        return new Map();
      },
      generateText: async () => "",
    };

    const preDocChunk = makeChunk({
      id: "pre-doc",
      description: "Extracted docstring.",
    });
    const undocChunk = makeChunk({ id: "undoc" });

    const { descriptionMap } = await generateDescriptions(
      [preDocChunk, undocChunk],
      provider,
      noopLogger,
    );

    assert.equal(descriptionMap.get("pre-doc"), "Extracted docstring.");
    assert.equal(llmCalledCount, 1, "LLM should only be called for undocumented chunk");
  });

  it("skips LLM entirely when all chunks are pre-documented", async () => {
    let llmCalled = false;
    const provider: DescriptionProvider = {
      generateDescription: async () => {
        llmCalled = true;
        return "";
      },
      generateBatchDescriptions: async () => {
        llmCalled = true;
        return new Map();
      },
      generateText: async () => "",
    };

    const chunks = [
      makeChunk({ id: "c1", description: "Doc 1." }),
      makeChunk({ id: "c2", description: "Doc 2." }),
    ];

    const { descriptionMap } = await generateDescriptions(
      chunks,
      provider,
      noopLogger,
    );

    assert.equal(descriptionMap.size, 2);
    assert.equal(descriptionMap.get("c1"), "Doc 1.");
    assert.equal(descriptionMap.get("c2"), "Doc 2.");
    assert.equal(llmCalled, false, "LLM should not be called");
  });

  it("does not batch pre-documented chunks with LLM calls", async () => {
    let batchInputChunks: Chunk[] = [];
    const provider: DescriptionProvider = {
      generateDescription: async () => "individual desc",
      generateBatchDescriptions: async (chunks: Chunk[]) => {
        batchInputChunks = chunks;
        const map = new Map<string, string>();
        for (const c of chunks) map.set(c.id, `batch desc for ${c.id}`);
        return map;
      },
      generateText: async () => "",
    };

    const preDocChunk = makeChunk({
      id: "pre-doc",
      description: "Extracted docstring.",
    });
    const undoc1 = makeChunk({ id: "undoc1" });
    const undoc2 = makeChunk({ id: "undoc2" });

    await generateDescriptions(
      [preDocChunk, undoc1, undoc2],
      provider,
      noopLogger,
    );

    assert.equal(
      batchInputChunks.length, 2,
      "Only undocumented chunks should be batched",
    );
    assert.equal(batchInputChunks[0]!.id, "undoc1");
    assert.equal(batchInputChunks[1]!.id, "undoc2");
  });

  it("handles mixed pre-documented and image chunks", async () => {
    let llmCalled = false;
    const provider: DescriptionProvider = {
      generateDescription: async () => {
        llmCalled = true;
        return "LLM desc";
      },
      generateBatchDescriptions: async () => {
        llmCalled = true;
        return new Map();
      },
      generateText: async () => "",
    };

    const imageChunk = makeChunk({
      id: "img",
      content: "Image description text",
      metadata: { filePath: "img.png", startLine: 1, endLine: 1, language: "image", contentType: "image" },
    });
    const preDocChunk = makeChunk({
      id: "pre-doc",
      description: "Extracted docstring.",
    });

    const { descriptionMap } = await generateDescriptions(
      [preDocChunk, imageChunk],
      provider,
      noopLogger,
    );

    assert.equal(descriptionMap.get("pre-doc"), "Extracted docstring.");
    assert.equal(descriptionMap.get("img"), "Image description text");
    assert.equal(llmCalled, false, "LLM should not be called for pre-doc + image chunks");
  });

  it("returns empty descriptionMap for empty chunks", async () => {
    const provider: DescriptionProvider = {
      generateDescription: async () => "",
      generateBatchDescriptions: async () => new Map(),
      generateText: async () => "",
    };

    const { descriptionMap } = await generateDescriptions([], provider, noopLogger);
    assert.equal(descriptionMap.size, 0);
  });

  it("records failures only for chunks that attempted LLM", async () => {
    const provider: DescriptionProvider = {
      generateDescription: async () => { throw new Error("LLM error"); },
      generateBatchDescriptions: async () => { throw new Error("batch error"); },
      generateText: async () => { throw new Error("batch error"); },
    };

    const preDocChunk = makeChunk({
      id: "pre-doc",
      description: "Extracted docstring.",
    });
    const failingChunk = makeChunk({ id: "failing" });

    const { failures } = await generateDescriptions(
      [preDocChunk, failingChunk],
      provider,
      noopLogger,
    );

    assert.equal(failures.length, 1, "Only 1 failure expected");
    assert.equal(failures[0]!.chunkId, "failing");
  });
});
