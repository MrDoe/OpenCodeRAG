import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

import type { EmbeddingProvider, KeywordIndex, VectorStore, SearchResult } from "../../core/interfaces.js";
import type { RagConfig } from "../../core/config.js";
import { DEFAULT_CONFIG } from "../../core/config.js";
import { handleSearchSemantic, handleFileSkeleton, handleFindUsages, handleDescribeImage } from "../../mcp/handlers.js";
import type { ImageVisionProvider } from "../../chunker/image.js";
import type { RetrieveOptions } from "../../retriever/retriever.js";

type ToolContent = { type: string; text: string };
type ToolResult = { content: ToolContent[]; isError?: boolean };

// ─── Mock helpers ───────────────────────────────────────────────────────────

const dummyProvider: EmbeddingProvider = {
  name: "test",
  embed: async () => [],
};

function makeConfig(overrides?: Partial<RagConfig>): RagConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    embedding: { ...DEFAULT_CONFIG.embedding, ...overrides?.embedding },
    retrieval: { ...DEFAULT_CONFIG.retrieval, ...overrides?.retrieval },
  } as RagConfig;
}

function makeResult(
  id: string,
  filePath: string,
  startLine: number,
  endLine: number,
  language: string,
  content: string,
  score: number,
  description?: string
): SearchResult {
  return {
    score,
    chunk: {
      id,
      content,
      description,
      metadata: { filePath, startLine, endLine, language },
    },
  };
}

function makeEmptyStore(): VectorStore {
  return {
    addChunks: async () => {},
    search: async () => [],
    async searchWithFilter(embedding: number[], topK: number, _filter?: any): Promise<SearchResult[]> {
      return this.search(embedding, topK);
    },
    count: async () => 0,
    clear: async () => {},
    deleteByFilePath: async () => {},
    close: async () => {},
    getFilePaths: async () => [],
    getChunks: async () => [],
    listFiles: async () => [],
    getChunksByFilePath: async () => [],
  };
}

function makeStore(count: number, searchResults: SearchResult[]): VectorStore {
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
    getChunks: async () => [],
    listFiles: async () => [],
    getChunksByFilePath: async () => [],
  };
}

function makeRetrieveFn(results: SearchResult[]) {
  return async (
    _query: string,
    _embedder: EmbeddingProvider,
    _store: VectorStore,
    _options?: RetrieveOptions
  ): Promise<SearchResult[]> => {
    return results;
  };
}

function makeRetrieveCapture(capture: { query: string; options: RetrieveOptions }) {
  return async (
    query: string,
    _embedder: EmbeddingProvider,
    _store: VectorStore,
    options?: RetrieveOptions
  ): Promise<SearchResult[]> => {
    capture.query = query;
    capture.options = options ?? {};
    return [];
  };
}

function makeKeywordIndex(results: SearchResult[]): KeywordIndex {
  return {
    addChunks: () => {},
    removeByFilePath: () => {},
    search: (_query: string, _topK: number) => results,
    clear: () => {},
    count: () => results.length,
    save: async () => {},
    close: () => {},
    getMatchedTerms: (_query: string, _chunkId: string) => [],
  };
}

// ─── Suite: handleSearchSemantic ───────────────────────────────────────────

describe("handleSearchSemantic", () => {
  const cfg = makeConfig();

  it("returns empty-index message when count is 0", async () => {
    const result = await handleSearchSemantic(
      { query: "anything" },
      dummyProvider,
      makeEmptyStore(),
      cfg,
      undefined,
      makeRetrieveFn([])
    );

    assert.equal(result.chunks.length, 0);
    assert.match(result.formatted, /The code index is empty/);
  });

  it("returns no-matches message when retrieve returns []", async () => {
    const result = await handleSearchSemantic(
      { query: "missing term" },
      dummyProvider,
      makeStore(5, []),
      cfg,
      undefined,
      makeRetrieveFn([])
    );

    assert.equal(result.chunks.length, 0);
    assert.match(result.formatted, /No indexed code matched query/);
    assert.match(result.formatted, /missing term/);
  });

  it("formats results with file paths, line ranges, scores, and code fences", async () => {
    const results = [
      makeResult("c1", "src/auth.ts", 10, 25, "typescript", "function login() {}", 0.91, "auth function"),
      makeResult("c2", "src/db.ts", 1, 15, "typescript", "function connect() {}", 0.82),
    ];

    const result = await handleSearchSemantic(
      { query: "auth" },
      dummyProvider,
      makeStore(10, results),
      cfg,
      undefined,
      makeRetrieveFn(results)
    );

    assert.equal(result.chunks.length, 2);
    assert.match(result.formatted, /src\/auth\.ts:10-25/);
    assert.match(result.formatted, /src\/db\.ts:1-15/);
    assert.match(result.formatted, /0\.91/);
    assert.match(result.formatted, /0\.82/);
    assert.match(result.formatted, /```typescript/);
    assert.match(result.formatted, /login/);
    assert.match(result.formatted, /connect/);
    assert.match(result.formatted, /> auth function/);
  });

  it("appends path and language hints into the query", async () => {
    const capture = { query: "", options: {} as RetrieveOptions };
    await handleSearchSemantic(
      { query: "find auth", pathHints: ["src/auth.ts"], languageHints: ["typescript"] },
      dummyProvider,
      makeStore(5, []),
      cfg,
      undefined,
      makeRetrieveCapture(capture)
    );

    assert.match(capture.query, /find auth/);
    assert.match(capture.query, /Path hints: src\/auth\.ts/);
    assert.match(capture.query, /Language hints: typescript/);
  });

  it("passes topK to retrieve options", async () => {
    const capture = { query: "", options: {} as RetrieveOptions };
    await handleSearchSemantic(
      { query: "test", topK: 7 },
      dummyProvider,
      makeStore(5, []),
      cfg,
      undefined,
      makeRetrieveCapture(capture)
    );

    assert.equal(capture.options.topK, 7);
  });
});

// ─── Suite: handleFileSkeleton ─────────────────────────────────────────────

describe("handleFileSkeleton", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "opencode-rag-skeleton-"));
    writeFileSync(path.join(tmpDir, "test.json"), JSON.stringify({ foo: 1, bar: 2, baz: 3 }, null, 2));
    writeFileSync(path.join(tmpDir, "empty.ts"), "");
    writeFileSync(path.join(tmpDir, "readme.txt"), "Hello world\nThis is a text file.\n");
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns skeleton for a .ts file with expected symbols", async () => {
    const result = await handleFileSkeleton(
      { filePath: "src/plugin.ts" },
      process.cwd()
    );

    assert.ok(result.elements.length > 0);
    assert.match(result.formatted, /createRagHooks/);
    assert.match(result.formatted, /extractUserMessageText/);
    assert.ok(result.summary.length > 0);
  });

  it("returns skeleton for a .json file via regex fallback", async () => {
    const result = await handleFileSkeleton(
      { filePath: "test.json" },
      tmpDir
    );

    assert.ok(result.elements.length > 0);
    assert.match(result.formatted, /structural elements/);
  });

  it("returns fallback for unknown extension showing line count", async () => {
    const result = await handleFileSkeleton(
      { filePath: "readme.txt" },
      tmpDir
    );

    assert.ok(result.elements.length > 0);
    assert.match(result.formatted, /lines/);
    assert.equal(result.elements[0]?.type, "file");
  });

  it("returns no-elements message for an empty file", async () => {
    const result = await handleFileSkeleton(
      { filePath: "empty.ts" },
      tmpDir
    );

    assert.ok(result.elements.length === 0 || result.formatted.includes("no structural elements"));
  });

  it("throws when file does not exist", async () => {
    await assert.rejects(
      () => handleFileSkeleton({ filePath: "nonexistent.ts" }, tmpDir),
      /ENOENT|no such file|not found/i
    );
  });
});

// ─── Suite: handleFindUsages ───────────────────────────────────────────────

describe("handleFindUsages", () => {
  const cfg = makeConfig();

  it("returns no matches when all sources are empty", async () => {
    const result = await handleFindUsages(
      { symbolName: "missingSymbol" },
      dummyProvider,
      makeEmptyStore(),
      cfg,
      makeKeywordIndex([]),
      makeRetrieveFn([])
    );

    assert.equal(result.totalMatches, 0);
    assert.equal(result.fileCount, 0);
    assert.match(result.formatted, /No usages found/);
  });

  it("produces matches from keyword index results", async () => {
    const kwResults = [
      makeResult("k1", "src/auth.ts", 10, 20, "typescript", "const result = apiKey + secret;", 0.5),
    ];

    const result = await handleFindUsages(
      { symbolName: "apiKey" },
      dummyProvider,
      makeEmptyStore(),
      cfg,
      makeKeywordIndex(kwResults),
      makeRetrieveFn([])
    );

    assert.ok(result.totalMatches > 0);
    assert.ok(result.fileCount > 0);
    assert.match(result.formatted, /apiKey/);
    assert.match(result.formatted, /src\/auth\.ts/);
  });

  it("produces matches from vector search results", async () => {
    const vsResults = [
      makeResult("v1", "src/db.ts", 5, 15, "typescript", "const db = await connect();", 0.85),
    ];

    const result = await handleFindUsages(
      { symbolName: "connect" },
      dummyProvider,
      makeStore(5, vsResults),
      cfg,
      makeKeywordIndex([]),
      makeRetrieveFn(vsResults)
    );

    assert.ok(result.totalMatches > 0);
    assert.match(result.formatted, /connect/);
    assert.match(result.formatted, /src\/db\.ts/);
  });

  it("merges and deduplicates keyword and vector results", async () => {
    const sharedResult = makeResult("s1", "src/shared.ts", 1, 10, "typescript", "const result = val + 1;", 0.5);
    const extraResult = makeResult("e1", "src/extra.ts", 1, 10, "typescript", "const result = val + 1;", 0.5);

    const result = await handleFindUsages(
      { symbolName: "val" },
      dummyProvider,
      makeStore(5, [sharedResult, extraResult]),
      cfg,
      makeKeywordIndex([sharedResult]),
      makeRetrieveFn([sharedResult, extraResult])
    );

    assert.equal(result.fileCount, 2);
    assert.match(result.formatted, /src\/shared\.ts/);
    assert.match(result.formatted, /src\/extra\.ts/);
  });

  it("groups matches by file in the formatted output", async () => {
    const results = [
      makeResult("a1", "src/a.ts", 1, 10, "typescript", "function run() { return config.x; }", 0.9),
      makeResult("a2", "src/b.ts", 1, 10, "typescript", "const result = x + 1;", 0.9),
    ];

    const result = await handleFindUsages(
      { symbolName: "x" },
      dummyProvider,
      makeStore(5, results),
      cfg,
      makeKeywordIndex([]),
      makeRetrieveFn(results)
    );

    assert.equal(result.fileCount, 2);
    assert.match(result.formatted, /### src\/a\.ts/);
    assert.match(result.formatted, /### src\/b\.ts/);
  });
});

// ─── Suite: Server integration ─────────────────────────────────────────────

describe("MCP server integration", () => {
  function createTestServer(): McpServer {
    const server = new McpServer({
      name: "test-server",
      version: "1.0.0",
    });

    server.tool(
      "search_semantic",
      "Search the codebase",
      {
        query: z.string(),
        topK: z.number().optional(),
      },
      async (args: { query: string; topK?: number }) => {
        return {
          content: [{ type: "text" as const, text: `Searching for: ${args.query}` }],
        };
      }
    );

    server.tool(
      "get_file_skeleton",
      "Get file overview",
      {
        filePath: z.string(),
      },
      async (args: { filePath: string }) => {
        try {
          const result = await handleFileSkeleton(args as { filePath: string }, process.cwd());
          return {
            content: [{ type: "text" as const, text: result.formatted }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
    );

    server.tool(
      "find_usages",
      "Find symbol usages",
      {
        symbolName: z.string(),
      },
      async (args: { symbolName: string }) => {
        return {
          content: [{ type: "text" as const, text: `Usages of: ${args.symbolName}` }],
        };
      }
    );

    return server;
  }

  it("listTools returns all three expected tools", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createTestServer();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.listTools();
      const names = result.tools.map((t: { name: string }) => t.name).sort();
      assert.deepStrictEqual(names, ["find_usages", "get_file_skeleton", "search_semantic"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("callTool search_semantic returns text content", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createTestServer();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const raw = await client.callTool({
        name: "search_semantic",
        arguments: { query: "authentication", topK: 5 },
      });
      const result = raw as ToolResult;
      assert.ok(result.content);
      assert.equal(result.content[0]?.type, "text");
      assert.match(result.content[0]?.text ?? "", /Searching for: authentication/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("callTool get_file_skeleton returns file structure", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createTestServer();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const raw = await client.callTool({
        name: "get_file_skeleton",
        arguments: { filePath: "src/plugin.ts" },
      });
      const result = raw as ToolResult;
      assert.ok(result.content);
      assert.equal(result.content[0]?.type, "text");
      assert.match(result.content[0]?.text ?? "", /createRagHooks/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("callTool find_usages returns usage info", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createTestServer();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const raw = await client.callTool({
        name: "find_usages",
        arguments: { symbolName: "authenticate" },
      });
      const result = raw as ToolResult;
      assert.ok(result.content);
      assert.equal(result.content[0]?.type, "text");
      assert.match(result.content[0]?.text ?? "", /Usages of: authenticate/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns isError when tool handler returns an error", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createTestServer();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const raw = await client.callTool({
        name: "get_file_skeleton",
        arguments: { filePath: "/nonexistent/path/file.ts" },
      });
      const result = raw as ToolResult;
      assert.equal(result.isError, true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// ─── Fake vision provider for describe_image tests ──────────────────────────

const TEST_DESCRIPTION = "A test image with sample content";

function makeFakeVisionProvider(description = TEST_DESCRIPTION): ImageVisionProvider {
  return {
    describeImage: async () => description,
  };
}

function makeConfigWithImageDesc(overrides?: Partial<RagConfig>): RagConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    embedding: { ...DEFAULT_CONFIG.embedding, ...overrides?.embedding },
    retrieval: { ...DEFAULT_CONFIG.retrieval, ...overrides?.retrieval },
    imageDescription: {
      enabled: true,
      provider: "ollama",
      model: "test-model",
      baseUrl: "http://localhost:11434/api",
      timeoutMs: 30000,
      prompt: "Describe this image",
      ...(overrides?.imageDescription ?? {}),
    },
  } as RagConfig;
}

// ─── Suite: handleDescribeImage ─────────────────────────────────────────────

describe("handleDescribeImage", () => {
  let tmpDir: string;
  let pngPath: string;

  // Valid 2x2 red PNG (sharp needs >1px for JPEG conversion)
  const MINI_PNG_HEX = "89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a730000000970485973000003e8000003e801b57b526b0000001349444154089963f8cfc0f09f018cff333000001fee03fda92fc0e20000000049454e44ae426082";

  before(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "opencode-rag-describe-"));
    pngPath = path.join(tmpDir, "test.png");
    writeFileSync(pngPath, Buffer.from(MINI_PNG_HEX, "hex"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws on missing file", async () => {
    const cfg = makeConfigWithImageDesc();
    await assert.rejects(
      () => handleDescribeImage({ filePath: "nonexistent.png" }, cfg, tmpDir),
      /File not found|ENOENT|no such file/i
    );
  });

  it("throws on unsupported extension", async () => {
    const txtPath = path.join(tmpDir, "test.txt");
    writeFileSync(txtPath, "hello", "utf-8");
    const cfg = makeConfigWithImageDesc();

    await assert.rejects(
      () => handleDescribeImage({ filePath: "test.txt" }, cfg, tmpDir),
      /Unsupported file extension/i
    );
  });

  it("throws when imageDescription is disabled", async () => {
    const cfg = makeConfigWithImageDesc({ imageDescription: { enabled: false } as any });

    await assert.rejects(
      () => handleDescribeImage({ filePath: "test.png" }, cfg, tmpDir),
      /not enabled/i
    );
  });

  it("returns description when an image is provided with visionProvider", async () => {
    const cfg = makeConfigWithImageDesc();
    const fakeVision = makeFakeVisionProvider();

    const result = await handleDescribeImage({ filePath: "test.png" }, cfg, tmpDir, fakeVision);

    assert.equal(result.description, TEST_DESCRIPTION);
    assert.match(result.formatted, /Image description/);
    assert.match(result.formatted, /test\.png/);
    assert.match(result.formatted, /test-model/);
    assert.match(result.formatted, /test image with sample content/i);
  });

  it("returns description with custom prompt in formatted output", async () => {
    const cfg = makeConfigWithImageDesc();
    const customDesc = "A red 1x1 pixel image";
    const fakeVision = makeFakeVisionProvider(customDesc);

    const result = await handleDescribeImage({ filePath: "test.png" }, cfg, tmpDir, fakeVision);

    assert.equal(result.description, customDesc);
    assert.match(result.formatted, /red 1x1 pixel/);
  });

  it("resolves relative filePath from worktree", async () => {
    const cfg = makeConfigWithImageDesc();
    const fakeVision = makeFakeVisionProvider();

    const result = await handleDescribeImage({ filePath: "test.png" }, cfg, tmpDir, fakeVision);

    assert.equal(result.description, TEST_DESCRIPTION);
  });

  it("resolves absolute filePath", async () => {
    const cfg = makeConfigWithImageDesc();
    const fakeVision = makeFakeVisionProvider();

    const result = await handleDescribeImage({ filePath: pngPath }, cfg, tmpDir, fakeVision);

    assert.equal(result.description, TEST_DESCRIPTION);
  });
});

// ─── Suite: MCP server integration for describe_image ───────────────────────

describe("MCP server describe_image integration", () => {
  let tmpDir: string;

  const MINI_PNG_HEX = "89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a730000000970485973000003e8000003e801b57b526b0000001349444154089963f8cfc0f09f018cff333000001fee03fda92fc0e20000000049454e44ae426082";

  before(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "opencode-rag-mcp-"));
    writeFileSync(path.join(tmpDir, "TestFile.png"), Buffer.from(MINI_PNG_HEX, "hex"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTestServer(fixtureDir: string): McpServer {
    const server = new McpServer({
      name: "test-server",
      version: "1.0.0",
    });

    server.tool(
      "describe_image",
      "Describe an image file",
      {
        filePath: z.string(),
      },
      async (args: { filePath: string }) => {
        try {
          const cfg = makeConfigWithImageDesc();
          const fakeVision = makeFakeVisionProvider();
          const result = await handleDescribeImage(args as { filePath: string }, cfg, fixtureDir, fakeVision);
          return {
            content: [{ type: "text" as const, text: result.formatted }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
    );

    return server;
  }

  it("listTools includes describe_image", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createTestServer(tmpDir);
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.listTools();
      const names = result.tools.map((t: { name: string }) => t.name);
      assert.ok(names.includes("describe_image"));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("callTool describe_image returns text content with image description", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createTestServer(tmpDir);
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const raw = await client.callTool({
        name: "describe_image",
        arguments: { filePath: "TestFile.png" },
      });
      const result = raw as ToolResult;
      assert.ok(result.content);
      assert.equal(result.content[0]?.type, "text");
      assert.match(result.content[0]?.text ?? "", /Image description/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("callTool describe_image returns isError when file is not an image", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createTestServer(tmpDir);
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const raw = await client.callTool({
        name: "describe_image",
        arguments: { filePath: "nonexistent.png" },
      });
      const result = raw as ToolResult;
      assert.equal(result.isError, true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
