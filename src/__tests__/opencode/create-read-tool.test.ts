import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import type { EmbeddingProvider, VectorStore, SearchResult, Chunk } from "../../core/interfaces.js";
import { DEFAULT_CONFIG } from "../../core/config.js";
import { createRagReadTool } from "../../opencode/create-read-tool.js";

// ── Helpers ──────────────────────────────────────────────

function makeEmbedder(embeddings: number[][] = [[0.1, 0.2, 0.3]]): EmbeddingProvider {
  return {
    name: "test-embedder",
    embed: async (_texts: string[], _purpose?: "query" | "document") => embeddings,
  };
}

function makeStore(options: {
  count?: number;
  searchResults?: SearchResult[];
} = {}): VectorStore {
  const count = options.count ?? 5;
  const searchResults = options.searchResults ?? [];

  return {
    addChunks: async () => {},
    search: async () => searchResults,
    async searchWithFilter(embedding: number[], topK: number, _filter?: any): Promise<SearchResult[]> {
      return this.search(embedding, topK);
    },
    count: async () => count,
    clear: async () => {},
    deleteByFilePath: async () => {},
    close: async () => {},
    getFilePaths: async () => [],
  };
}

function makeChunk(
  id: string,
  filePath: string,
  startLine: number,
  endLine: number,
  language: string,
  content: string
): Chunk {
  return {
    id,
    content,
    metadata: { filePath, startLine, endLine, language },
  };
}

function makeResult(
  id: string,
  filePath: string,
  startLine: number,
  endLine: number,
  language: string,
  content: string,
  score: number
): SearchResult {
  return {
    score,
    chunk: makeChunk(id, filePath, startLine, endLine, language, content),
  };
}

// ── Tests ────────────────────────────────────────────────

describe("createRagReadTool", () => {
  let tmpDir: string;
  let tmpWorktree: string;
  let mainFile: string;
  let otherFile: string;
  let other2File: string;
  let other3File: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rag-read-"));
    tmpWorktree = tmpDir.replace(/\\/g, "/");

    mainFile = tmpWorktree + "/src/main.ts";
    otherFile = tmpWorktree + "/other.ts";
    other2File = tmpWorktree + "/src/other2.ts";
    other3File = tmpWorktree + "/src/other3.ts";

    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(mainFile, [
      "import { foo } from './foo';",
      "",
      "export function bar() {",
      "  return foo();",
      "}",
      "",
      "export function baz() {",
      "  return 42;",
      "}",
    ].join("\n"), "utf-8");
    await fs.writeFile(otherFile, "export const x = 1;", "utf-8");
    await fs.writeFile(other2File, "export const y = 2;", "utf-8");
    await fs.writeFile(other3File, "export const z = 3;", "utf-8");
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns a tool object with execute method", () => {
    const tool = createRagReadTool({
      worktree: tmpWorktree,
      config: DEFAULT_CONFIG,
      embedder: makeEmbedder(),
      store: makeStore(),
    });

    assert.ok(tool);
    assert.ok(typeof tool === "object");
    assert.ok("execute" in tool);
  });

  it("returns full file contents when store is empty", async () => {
    const tool = createRagReadTool({
      worktree: tmpWorktree,
      config: DEFAULT_CONFIG,
      embedder: makeEmbedder(),
      store: makeStore({ count: 0 }),
    });

    const result = await (tool as { execute: Function }).execute(
      { filePath: "src/main.ts" },
      {}
    ) as { output: string; metadata: Record<string, unknown> };

    assert.match(result.output, /export function bar/);
    assert.match(result.output, /export function baz/);
    assert.equal(result.metadata.indexed, false);
    assert.equal(result.metadata.chunks, 0);
  });

  it("returns full file contents when file has no indexed chunks", async () => {
    const tool = createRagReadTool({
      worktree: tmpWorktree,
      config: DEFAULT_CONFIG,
      embedder: makeEmbedder(),
      store: makeStore({
        count: 5,
        searchResults: [
          makeResult("c1", otherFile, 1, 1, "typescript", "export const x = 1;", 0.9),
        ],
      }),
    });

    const result = await (tool as { execute: Function }).execute(
      { filePath: "src/main.ts" },
      {}
    ) as { output: string; metadata: Record<string, unknown> };

    assert.match(result.output, /export function bar/);
    assert.match(result.output, /export function baz/);
    assert.equal(result.metadata.indexed, false);
  });

  it("returns full file with RAG chunks when available", async () => {
    const tool = createRagReadTool({
      worktree: tmpWorktree,
      config: DEFAULT_CONFIG,
      embedder: makeEmbedder(),
      store: makeStore({
        count: 10,
        searchResults: [
          makeResult("c1", mainFile, 5, 20, "typescript", "function a() {}", 0.95),
          makeResult("c2", mainFile, 30, 50, "typescript", "function b() {}", 0.85),
          makeResult("c3", otherFile, 1, 10, "typescript", "other", 0.9),
        ],
      }),
    });

    const result = await (tool as { execute: Function }).execute(
      { filePath: "src/main.ts" },
      {}
    ) as { output: string; metadata: Record<string, unknown> };

    // Full file contents present
    assert.match(result.output, /export function bar/);
    assert.match(result.output, /export function baz/);

    // RAG chunks from the same file present
    assert.match(result.output, /function a\(\)/);
    assert.match(result.output, /function b\(\)/);
    assert.match(result.output, /Related code chunks/);

    // RAG chunks from other files NOT present in the code chunks section
    assert.doesNotMatch(result.output, /other code/);

    assert.equal(result.metadata.indexed, true);
    assert.equal(result.metadata.chunks, 2);
  });

  it("respects maxContextChunks limit", async () => {
    const manyResults = Array.from({ length: 10 }, (_, i) =>
      makeResult(
        `c${i}`,
        mainFile,
        i * 10 + 1,
        i * 10 + 10,
        "typescript",
        `// chunk ${i}`,
        1.0 - i * 0.05
      )
    );

    const config = { ...DEFAULT_CONFIG, openCode: { ...DEFAULT_CONFIG.openCode, maxContextChunks: 2 } };

    const tool = createRagReadTool({
      worktree: tmpWorktree,
      config,
      embedder: makeEmbedder(),
      store: makeStore({ count: 50, searchResults: manyResults }),
    });

    const result = await (tool as { execute: Function }).execute(
      { filePath: "src/main.ts" },
      {}
    ) as { output: string; metadata: Record<string, unknown> };

    // Full file present
    assert.match(result.output, /export function bar/);

    // Only 2 RAG chunks shown
    assert.match(result.output, /2 chunk/);
    assert.doesNotMatch(result.output, /\/\/ chunk 2/);
  });

  it("applies line-range overlap filtering", async () => {
    const results = [
      makeResult("c1", mainFile, 1, 20, "typescript", "first block", 0.9),
      makeResult("c2", mainFile, 25, 40, "typescript", "second block", 0.85),
      makeResult("c3", mainFile, 50, 70, "typescript", "third block", 0.8),
    ];

    const tool = createRagReadTool({
      worktree: tmpWorktree,
      config: DEFAULT_CONFIG,
      embedder: makeEmbedder(),
      store: makeStore({ count: 10, searchResults: results }),
    });

    // Request lines 3-5 which should overlap c1 (1-20) and c2 (25-40)
    const result = await (tool as { execute: Function }).execute(
      { filePath: "src/main.ts", startLine: 3, endLine: 5 },
      {}
    ) as { output: string };

    // Full file slice present
    assert.match(result.output, /export function bar/);

    // RAG chunks overlapping with requested range
    assert.match(result.output, /first block/);
    assert.doesNotMatch(result.output, /third block/);
  });

  it("handles retrieval errors gracefully (still returns file)", async () => {
    const failingStore: VectorStore = {
      addChunks: async () => {},
      search: async () => { throw new Error("DB connection failed"); },
      async searchWithFilter(embedding: number[], topK: number, _filter?: any): Promise<SearchResult[]> {
        return this.search(embedding, topK);
      },
      count: async () => { throw new Error("DB connection failed"); },
      clear: async () => {},
      deleteByFilePath: async () => {},
      close: async () => {},
      getFilePaths: async () => [],
    };

    const tool = createRagReadTool({
      worktree: tmpWorktree,
      config: DEFAULT_CONFIG,
      embedder: makeEmbedder(),
      store: failingStore,
    });

    const result = await (tool as { execute: Function }).execute(
      { filePath: "src/main.ts" },
      {}
    ) as { output: string; metadata: Record<string, unknown> };

    // File is still returned even when retrieval fails
    assert.match(result.output, /export function bar/);
    assert.match(result.output, /export function baz/);
    assert.equal(result.metadata.indexed, false);
  });

  it("returns error for file path outside workspace", async () => {
    const tool = createRagReadTool({
      worktree: tmpWorktree,
      config: DEFAULT_CONFIG,
      embedder: makeEmbedder(),
      store: makeStore(),
    });

    const result = await (tool as { execute: Function }).execute(
      { filePath: "/outside/file.ts" },
      {}
    ) as { output: string };

    assert.match(result.output, /OpenCodeRAG retrieval failed/);
    assert.match(result.output, /outside the workspace/);
  });

  it("returns error for non-existent file", async () => {
    const tool = createRagReadTool({
      worktree: tmpWorktree,
      config: DEFAULT_CONFIG,
      embedder: makeEmbedder(),
      store: makeStore(),
    });

    const result = await (tool as { execute: Function }).execute(
      { filePath: "does-not-exist.ts" },
      {}
    ) as { output: string };

    assert.match(result.output, /OpenCodeRAG retrieval failed/);
  });

  // ── Related files tests ──────────────────────────────────

  it("includes related files from other matching results", async () => {
    const tool = createRagReadTool({
      worktree: tmpWorktree,
      config: DEFAULT_CONFIG,
      embedder: makeEmbedder(),
      store: makeStore({
        count: 10,
        searchResults: [
          makeResult("c1", mainFile, 1, 10, "typescript", "main code", 0.95),
          makeResult("c2", mainFile, 20, 30, "typescript", "more main", 0.85),
          makeResult("c3", otherFile, 1, 10, "typescript", "other code", 0.80),
          makeResult("c4", other2File, 1, 10, "typescript", "other2 code", 0.75),
        ],
      }),
    });

    const result = await (tool as { execute: Function }).execute(
      { filePath: "src/main.ts" },
      {}
    ) as { output: string };

    // Full file contents
    assert.match(result.output, /export function bar/);

    // RAG chunks from requested file
    assert.match(result.output, /main code/);
    assert.match(result.output, /more main/);

    // Related files section with otherFile and other2File (not mainFile)
    assert.match(result.output, /Please consider reading other relevant files/);
    assert.match(result.output, /other\.ts \(Score: 0\.\d+\)/);
    assert.match(result.output, /other2\.ts \(Score: 0\.\d+\)/);

    // Should NOT include the requested file in related files
    assert.doesNotMatch(result.output, /src\/main\.ts \(Score:/);
  });

  it("limits related files with readRelatedFilesMax", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      openCode: { ...DEFAULT_CONFIG.openCode, readRelatedFilesMax: 1 },
    };

    const tool = createRagReadTool({
      worktree: tmpWorktree,
      config,
      embedder: makeEmbedder(),
      store: makeStore({
        count: 10,
        searchResults: [
          makeResult("c0", mainFile, 1, 5, "typescript", "main", 0.95),
          makeResult("c1", otherFile, 1, 10, "typescript", "other", 0.85),
          makeResult("c2", other2File, 1, 10, "typescript", "other2", 0.80),
          makeResult("c3", other3File, 1, 10, "typescript", "other3", 0.75),
        ],
      }),
    });

    const result = await (tool as { execute: Function }).execute(
      { filePath: "src/main.ts" },
      {}
    ) as { output: string };

    // Should have at most 1 related file
    assert.match(result.output, /Please consider reading other relevant files/);
    assert.match(result.output, /other\.ts \(Score: 0\.\d+\)/);
    assert.doesNotMatch(result.output, /other2\.ts/);
    assert.doesNotMatch(result.output, /other3\.ts/);
  });

  it("suppresses related files when readRelatedFilesMax is 0", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      openCode: { ...DEFAULT_CONFIG.openCode, readRelatedFilesMax: 0 },
    };

    const tool = createRagReadTool({
      worktree: tmpWorktree,
      config,
      embedder: makeEmbedder(),
      store: makeStore({
        count: 10,
        searchResults: [
          makeResult("c0", mainFile, 1, 5, "typescript", "main", 0.95),
          makeResult("c1", otherFile, 1, 10, "typescript", "other", 0.85),
        ],
      }),
    });

    const result = await (tool as { execute: Function }).execute(
      { filePath: "src/main.ts" },
      {}
    ) as { output: string };

    assert.doesNotMatch(result.output, /Please consider reading other relevant files/);
  });

  it("suppresses related files when all results are from the same file", async () => {
    const tool = createRagReadTool({
      worktree: tmpWorktree,
      config: DEFAULT_CONFIG,
      embedder: makeEmbedder(),
      store: makeStore({
        count: 5,
        searchResults: [
          makeResult("c0", mainFile, 1, 10, "typescript", "main", 0.95),
          makeResult("c1", mainFile, 20, 30, "typescript", "more", 0.85),
        ],
      }),
    });

    const result = await (tool as { execute: Function }).execute(
      { filePath: "src/main.ts" },
      {}
    ) as { output: string };

    assert.doesNotMatch(result.output, /Please consider reading other relevant files/);
  });

  it("deduplicates related files by keeping best score", async () => {
    const tool = createRagReadTool({
      worktree: tmpWorktree,
      config: DEFAULT_CONFIG,
      embedder: makeEmbedder(),
      store: makeStore({
        count: 10,
        searchResults: [
          makeResult("c0", mainFile, 1, 5, "typescript", "main", 0.95),
          makeResult("c1", otherFile, 1, 10, "typescript", "first", 0.85),
          makeResult("c2", otherFile, 20, 30, "typescript", "second", 0.72),
          makeResult("c3", otherFile, 30, 40, "typescript", "third", 0.68),
        ],
      }),
    });

    const result = await (tool as { execute: Function }).execute(
      { filePath: "src/main.ts" },
      {}
    ) as { output: string };

    // Only one entry for other.ts, with best score 0.01
    assert.match(result.output, /Please consider reading other relevant files/);
    assert.match(result.output, /other\.ts \(Score: 0\.\d+\)/);
    // Should NOT show lower scores for same file
    const matches = result.output.match(/other\.ts \(Score:/g);
    assert.equal(matches?.length, 1, "expected exactly one related entry per file");
  });

  // ── Session cache tests ──────────────────────────────────

  it("uses cached results when message text matches", async () => {
    const store: VectorStore = {
      addChunks: async () => {},
      search: async () => [],
      async searchWithFilter(embedding: number[], topK: number, _filter?: any): Promise<SearchResult[]> {
        return this.search(embedding, topK);
      },
      count: async () => 5,
      clear: async () => {},
      deleteByFilePath: async () => {},
      close: async () => {},
      getFilePaths: async () => [],
    };

    const embedder = makeEmbedder();
    const sessionLastMessage = new Map<string, string>();
    const sessionRetrievalCache = new Map<
      string,
      { messageText: string; rawResults: SearchResult[] }
    >();

    // Pre-populate: simulate chat.message having stored the user message
    sessionLastMessage.set("session-1", "tell me about authentication");

    // And a cached retrieval result
    sessionRetrievalCache.set("session-1", {
      messageText: "tell me about authentication",
      rawResults: [
        makeResult("c1", mainFile, 1, 10, "typescript", "cached result", 0.95),
      ],
    });

    const tool = createRagReadTool({
      worktree: tmpWorktree,
      config: DEFAULT_CONFIG,
      embedder,
      store,
      sessionLastMessage,
      sessionRetrievalCache,
    });

    // Passing sessionID via context triggers cache lookup
    const result = await (tool as { execute: Function }).execute(
      { filePath: "src/main.ts" },
      { sessionID: "session-1" }
    ) as { output: string };

    // Full file present
    assert.match(result.output, /export function bar/);

    // Cached RAG result present
    assert.match(result.output, /cached result/);
  });

  it("does not use cache when message text has changed", async () => {
    const searchStore: VectorStore = {
      addChunks: async () => {},
      search: async () => [makeResult("c1", mainFile, 1, 10, "typescript", "fresh result", 0.95)],
      async searchWithFilter(embedding: number[], topK: number, _filter?: any): Promise<SearchResult[]> {
        return this.search(embedding, topK);
      },
      count: async () => 5,
      clear: async () => {},
      deleteByFilePath: async () => {},
      close: async () => {},
      getFilePaths: async () => [],
    };

    const sessionLastMessage = new Map<string, string>();
    const sessionRetrievalCache = new Map<
      string,
      { messageText: string; rawResults: SearchResult[] }
    >();

    // New message text (different from cached)
    sessionLastMessage.set("session-1", "tell me about database");

    // Cached old message
    sessionRetrievalCache.set("session-1", {
      messageText: "tell me about authentication",
      rawResults: [
        makeResult("c1", mainFile, 1, 10, "typescript", "stale result", 0.95),
      ],
    });

    const tool = createRagReadTool({
      worktree: tmpWorktree,
      config: DEFAULT_CONFIG,
      embedder: makeEmbedder(),
      store: searchStore,
      sessionLastMessage,
      sessionRetrievalCache,
    });

    const result = await (tool as { execute: Function }).execute(
      { filePath: "src/main.ts" },
      { sessionID: "session-1" }
    ) as { output: string };

    // Full file present
    assert.match(result.output, /export function bar/);

    // Should get fresh results (not stale), because the message changed
    assert.match(result.output, /fresh result/);
    assert.doesNotMatch(result.output, /stale result/);
  });

  // ── startLine/endLine tests ──────────────────────────────

  it("respects startLine/endLine for file slicing", async () => {
    const tool = createRagReadTool({
      worktree: tmpWorktree,
      config: DEFAULT_CONFIG,
      embedder: makeEmbedder(),
      store: makeStore({ count: 0 }),
    });

    const result = await (tool as { execute: Function }).execute(
      { filePath: "src/main.ts", startLine: 3, endLine: 5 },
      {}
    ) as { output: string };

    assert.match(result.output, /export function bar/);
    assert.match(result.output, /return foo/);
    assert.doesNotMatch(result.output, /import \{ foo \}/);
    assert.doesNotMatch(result.output, /export function baz/);
  });
});
