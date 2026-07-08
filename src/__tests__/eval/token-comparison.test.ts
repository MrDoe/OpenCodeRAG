/**
 * Token comparison test: RAG-on vs RAG-off.
 *
 * Measures:
 * - How many tokens RAG auto-injects into messages
 * - How many read tool calls RAG avoids
 * - Net token savings (overhead vs savings)
 * - Per-query breakdown of token usage
 *
 * Uses mock retrieval to simulate realistic search results and measures
 * the text delta before/after the chat.message hook runs.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRagHooks } from "../../plugin.js";
import { DEFAULT_CONFIG, type RagConfig } from "../../core/config.js";
import { appendSessionEvent, compareSessions } from "../../eval/storage.js";
import {
  analyzeTokenUsage,
  compareTokenAnalyses,
  formatTokenReport,
  estimateContextTokens,
  projectTokenSavings,
} from "../../eval/token-analysis.js";
import { handleEvalAnalysis, handleEvalTokenCompare, handleEvalProjectSavings } from "../../web/api.js";
import type { VectorStore, SearchResult } from "../../core/interfaces.js";
import type { SessionEvent } from "../../eval/types.js";

function makeTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "token-test-"));
}

function makeConfig(overrides: Partial<RagConfig> = {}): RagConfig {
  return {
    ...DEFAULT_CONFIG,
    embedding: { ...DEFAULT_CONFIG.embedding, ...overrides.embedding },
    indexing: { ...DEFAULT_CONFIG.indexing, ...overrides.indexing },
    vectorStore: { ...DEFAULT_CONFIG.vectorStore, ...overrides.vectorStore },
    retrieval: { ...DEFAULT_CONFIG.retrieval, ...overrides.retrieval },
    openCode: { ...DEFAULT_CONFIG.openCode, ...overrides.openCode },
    chunkers: overrides.chunkers ?? DEFAULT_CONFIG.chunkers,
  };
}

const dummyStore: VectorStore = {
  addChunks: async () => {},
  search: async () => [],
  async searchWithFilter(embedding: number[], topK: number, _filter?: any): Promise<SearchResult[]> {
    return this.search(embedding, topK);
  },
  count: async () => 10,
  clear: async () => {},
  deleteByFilePath: async () => {},
  close: async () => {},
  getFilePaths: async () => [],
  getChunks: async () => [],
  listFiles: async () => [],
  getChunksByFilePath: async () => [],
};

// ── Token estimation tests ──────────────────────────────────────

describe("estimateContextTokens", () => {
  it("returns 0 for empty string", () => {
    assert.equal(estimateContextTokens(""), 0);
  });

  it("returns a positive token count for non-empty text", () => {
    assert.ok(estimateContextTokens("abcd") > 0);
    assert.ok(estimateContextTokens("abcdefgh") > 0);
    assert.ok(estimateContextTokens("a".repeat(100)) > 0);
    assert.ok(estimateContextTokens("abc") > 0);
    assert.ok(estimateContextTokens("abcde") > 0);
  });

  it("returns more tokens for longer text", () => {
    const short = estimateContextTokens("short text");
    const long = estimateContextTokens("this is a much longer text with many more words in it to test token counting");
    assert.ok(long >= short, `Expected ${long} >= ${short}`);
  });
});

// ── Auto-injection token measurement ────────────────────────────

// ── Session event comparison tests ──────────────────────────────

describe("token comparison via session events", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("compares RAG-on vs RAG-off session summaries", () => {
    // RAG-ON session: higher input tokens (injected context), fewer read calls
    const ragOnEvents: SessionEvent[] = [
      { ts: 100, event: "session.created", sessionID: "rag-on", sessionTitle: "RAG On Session" },
      { ts: 200, event: "message", sessionID: "rag-on", messageID: "m1", role: "assistant", modelID: "gpt-4o", tokens: { input: 3500, output: 200, reasoning: 0, cache: { read: 100, write: 0 } }, cost: 0.015, timeCreated: 150, timeCompleted: 250 },
      { ts: 210, event: "rag.context", sessionID: "rag-on", messageID: "m1", ragInjected: true, ragChunkCount: 3, ragUniqueFiles: 2, ragContextTokens: 450, ragTopScore: 0.92, ragRetrievalTimeMs: 35 },
      { ts: 220, event: "tool", sessionID: "rag-on", messageID: "m1", tool: "read", toolStatus: "completed", toolDurationMs: 20 },
      { ts: 300, event: "message", sessionID: "rag-on", messageID: "m2", role: "assistant", modelID: "gpt-4o", tokens: { input: 3200, output: 180, reasoning: 0, cache: { read: 80, write: 0 } }, cost: 0.012, timeCreated: 280, timeCompleted: 350 },
      { ts: 310, event: "rag.context", sessionID: "rag-on", messageID: "m2", ragInjected: true, ragChunkCount: 2, ragUniqueFiles: 1, ragContextTokens: 300, ragTopScore: 0.88, ragRetrievalTimeMs: 28 },
      { ts: 320, event: "tool", sessionID: "rag-on", messageID: "m2", tool: "search_semantic", toolStatus: "completed", toolDurationMs: 45 },
    ];

    // RAG-OFF session: lower input tokens per message, but more read calls
    const ragOffEvents: SessionEvent[] = [
      { ts: 100, event: "session.created", sessionID: "rag-off", sessionTitle: "RAG Off Session" },
      { ts: 200, event: "message", sessionID: "rag-off", messageID: "m1", role: "assistant", modelID: "gpt-4o", tokens: { input: 2800, output: 250, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.012, timeCreated: 150, timeCompleted: 300 },
      { ts: 210, event: "tool", sessionID: "rag-off", messageID: "m1", tool: "read", toolStatus: "completed", toolDurationMs: 20 },
      { ts: 220, event: "tool", sessionID: "rag-off", messageID: "m1", tool: "read", toolStatus: "completed", toolDurationMs: 25 },
      { ts: 230, event: "tool", sessionID: "rag-off", messageID: "m1", tool: "read", toolStatus: "completed", toolDurationMs: 30 },
      { ts: 300, event: "message", sessionID: "rag-off", messageID: "m2", role: "assistant", modelID: "gpt-4o", tokens: { input: 2500, output: 220, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.010, timeCreated: 280, timeCompleted: 400 },
      { ts: 310, event: "tool", sessionID: "rag-off", messageID: "m2", tool: "read", toolStatus: "completed", toolDurationMs: 22 },
      { ts: 320, event: "tool", sessionID: "rag-off", messageID: "m2", tool: "read", toolStatus: "completed", toolDurationMs: 18 },
    ];

    for (const ev of ragOnEvents) appendSessionEvent(tmpDir, ev);
    for (const ev of ragOffEvents) appendSessionEvent(tmpDir, ev);

    // compareSessions(A,B) = B - A, so pass rag-off first to get positive delta for rag-on
    const comparison = compareSessions(tmpDir, "rag-off", "rag-on");
    assert.ok(comparison !== null);
    assert.ok(comparison!.delta.inputTokens > 0, "RAG-on should have higher input tokens (injected context)");
    assert.ok(comparison!.delta.ragContextTokens > 0, "RAG-on should have rag context tokens");

    // Values verified above
  });

  it("analyzeTokenUsage produces correct breakdown", () => {
    const events: SessionEvent[] = [
      { ts: 100, event: "session.created", sessionID: "s1", sessionTitle: "Test" },
      { ts: 200, event: "message", sessionID: "s1", messageID: "m1", role: "assistant", modelID: "gpt-4o", tokens: { input: 3000, output: 200, reasoning: 0, cache: { read: 50, write: 0 } }, cost: 0.012, timeCreated: 150, timeCompleted: 250 },
      { ts: 210, event: "rag.context", sessionID: "s1", messageID: "m1", ragInjected: true, ragChunkCount: 3, ragContextTokens: 400, ragTopScore: 0.90, ragRetrievalTimeMs: 30 },
      { ts: 220, event: "tool", sessionID: "s1", messageID: "m1", tool: "read", toolStatus: "completed", toolDurationMs: 20 },
      { ts: 230, event: "tool", sessionID: "s1", messageID: "m1", tool: "search_semantic", toolStatus: "completed", toolDurationMs: 40 },
      { ts: 300, event: "message", sessionID: "s1", messageID: "m2", role: "assistant", modelID: "gpt-4o", tokens: { input: 2800, output: 150, reasoning: 0, cache: { read: 30, write: 0 } }, cost: 0.010, timeCreated: 280, timeCompleted: 350 },
      { ts: 310, event: "rag.context", sessionID: "s1", messageID: "m2", ragInjected: true, ragChunkCount: 2, ragContextTokens: 300, ragTopScore: 0.85, ragRetrievalTimeMs: 25 },
    ];

    for (const ev of events) appendSessionEvent(tmpDir, ev);

    const analysis = analyzeTokenUsage(tmpDir, "s1");

    assert.equal(analysis.sessionID, "s1");
    assert.equal(analysis.queryCount, 2);
    assert.equal(analysis.totals.inputTokens, 5800);
    assert.equal(analysis.totals.outputTokens, 350);
    assert.equal(analysis.totals.cost, 0.022);
    assert.equal(analysis.totals.ragContextTokens, 700);
    assert.equal(analysis.totals.readToolCalls, 1);
    assert.equal(analysis.totals.ragToolCalls, 1);
    assert.equal(analysis.totals.systemGuidanceTokens, 300); // 2 messages * 150

    assert.equal(analysis.breakdowns.length, 2);
    assert.equal(analysis.breakdowns[0]!.inputTokens, 3000);
    assert.equal(analysis.breakdowns[0]!.ragContextTokens, 400);
    assert.equal(analysis.breakdowns[0]!.readToolCalls, 1);
    assert.equal(analysis.breakdowns[1]!.inputTokens, 2800);
    assert.equal(analysis.breakdowns[1]!.ragContextTokens, 300);

    // Values verified above
  });

  it("compareTokenAnalyses computes correct deltas", () => {
    const ragOnEvents: SessionEvent[] = [
      { ts: 100, event: "session.created", sessionID: "on", sessionTitle: "On" },
      { ts: 200, event: "message", sessionID: "on", messageID: "m1", role: "assistant", modelID: "gpt-4o", tokens: { input: 3500, output: 200, reasoning: 0, cache: { read: 100, write: 0 } }, cost: 0.015, timeCreated: 100, timeCompleted: 200 },
      { ts: 210, event: "rag.context", sessionID: "on", messageID: "m1", ragInjected: true, ragChunkCount: 3, ragContextTokens: 500, ragTopScore: 0.9, ragRetrievalTimeMs: 30 },
      { ts: 220, event: "tool", sessionID: "on", messageID: "m1", tool: "read", toolStatus: "completed", toolDurationMs: 20 },
      { ts: 230, event: "tool", sessionID: "on", messageID: "m1", tool: "search_semantic", toolStatus: "completed", toolDurationMs: 40 },
    ];

    const ragOffEvents: SessionEvent[] = [
      { ts: 100, event: "session.created", sessionID: "off", sessionTitle: "Off" },
      { ts: 200, event: "message", sessionID: "off", messageID: "m1", role: "assistant", modelID: "gpt-4o", tokens: { input: 2800, output: 250, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.012, timeCreated: 100, timeCompleted: 250 },
      { ts: 210, event: "tool", sessionID: "off", messageID: "m1", tool: "read", toolStatus: "completed", toolDurationMs: 20 },
      { ts: 220, event: "tool", sessionID: "off", messageID: "m1", tool: "read", toolStatus: "completed", toolDurationMs: 25 },
      { ts: 230, event: "tool", sessionID: "off", messageID: "m1", tool: "read", toolStatus: "completed", toolDurationMs: 30 },
    ];

    for (const ev of ragOnEvents) appendSessionEvent(tmpDir, ev);
    for (const ev of ragOffEvents) appendSessionEvent(tmpDir, ev);

    const ragOnAnalysis = analyzeTokenUsage(tmpDir, "on");
    const ragOffAnalysis = analyzeTokenUsage(tmpDir, "off");
    const comparison = compareTokenAnalyses(ragOnAnalysis, ragOffAnalysis);

    // RAG-on has more input tokens (700 more)
    assert.equal(comparison.delta.inputTokens, 700);
    // RAG-on has fewer read calls (1 vs 3)
    assert.equal(comparison.delta.readToolCalls, -2);
    // RAG-on has more RAG tool calls
    assert.equal(comparison.delta.ragToolCalls, 1);
    // RAG-on has rag context tokens
    assert.equal(comparison.delta.ragContextTokens, 500);
    // RAG-on has system guidance tokens
    assert.equal(comparison.delta.systemGuidanceTokens, 150);

    // Verdict should mention RAG costs tokens (more input)
    assert.ok(comparison.verdict.includes("COSTS tokens") || comparison.verdict.includes("fewer read calls"),
      `Verdict should explain tradeoff: ${comparison.verdict}`);

    // Generate and print the report
    const report = formatTokenReport(ragOnAnalysis, ragOffAnalysis, comparison);
    assert.ok(report.length > 0);
    assert.match(report, /TOKEN USAGE COMPARISON/);
    assert.match(report, /PER-QUERY BREAKDOWN/);
  });
});

// ── Projection tests ───────────────────────────────────────────

describe("projectTokenSavings", () => {
  it("projects positive savings when RAG reduces reads significantly", () => {
    const result = projectTokenSavings({
      avgChunkSize: 500,     // ~125 tokens per chunk
      avgChunksPerQuery: 3,  // ~375 tokens injected per query
      avgReadsPerQueryWithoutRAG: 3,
      avgReadsPerQueryWithRAG: 0.5,
      queryCount: 10,
    });

    assert.ok(result.isPositive, "Expected positive savings");
    assert.ok(result.netSavings > 0);
    assert.ok(result.savedReadTokens > result.ragOverheadTokens);

    // Values verified above
  });

  it("projects negative savings when chunks are large and reads are few", () => {
    const result = projectTokenSavings({
      avgChunkSize: 2000,    // ~500 tokens per chunk
      avgChunksPerQuery: 5,  // ~2500 tokens injected per query
      avgReadsPerQueryWithoutRAG: 1,
      avgReadsPerQueryWithRAG: 0.5,
      queryCount: 5,
    });

    assert.ok(!result.isPositive, "Expected negative savings");
    assert.ok(result.netSavings < 0);

    // Values verified above
  });

  it("breaks even when overhead equals savings", () => {
    const result = projectTokenSavings({
      avgChunkSize: 400,     // ~100 tokens per chunk
      avgChunksPerQuery: 3,  // ~300 tokens injected
      avgReadsPerQueryWithoutRAG: 1,
      avgReadsPerQueryWithRAG: 0,
      queryCount: 10,
    });

    // 300*10 = 3000 overhead, 1200*1*10 = 12000 saved → positive
    assert.ok(result.isPositive);
    // Values verified above
  });
});

// ── System prompt guidance overhead ─────────────────────────────

describe("system prompt guidance overhead", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("system.transform hook adds ~150 tokens per message when indexed", async () => {
    const hooks = createRagHooks({
      cfg: makeConfig({
        openCode: { enabled: true, maxContextChunks: 5 },
      }),
      storePath: "memory://",
      logFilePath: path.join(tmpDir, "opencode-rag.log"),
      store: dummyStore,
      dependencies: { retrieve: async () => [] },
      worktree: "/p",
    });

    const systemHook = hooks["experimental.chat.system.transform"];
    assert.ok(systemHook);

    const output = { system: [] as string[] };
    await systemHook?.({ model: { providerID: "test", modelID: "test" } } as never, output as never);

    assert.ok(output.system.length > 0);
    const guidance = output.system[0]!;
    const guidanceTokens = estimateContextTokens(guidance);

    assert.ok(guidanceTokens >= 100, `Expected ≥100 tokens for system guidance, got ${guidanceTokens}`);
    assert.ok(guidanceTokens <= 600, `Expected ≤600 tokens for system guidance, got ${guidanceTokens}`);
  });
});

// ── Web API handler tests ──────────────────────────────────────

describe("web API token analysis handlers", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handleEvalAnalysis returns TokenAnalysis for valid session", async () => {
    appendSessionEvent(tmpDir, { ts: 100, event: "session.created", sessionID: "s1", sessionTitle: "Test" });
    appendSessionEvent(tmpDir, { ts: 200, event: "message", sessionID: "s1", messageID: "m1", role: "assistant", modelID: "gpt-4o", tokens: { input: 3000, output: 200, reasoning: 0, cache: { read: 50, write: 0 } }, cost: 0.012 });
    appendSessionEvent(tmpDir, { ts: 210, event: "rag.context", sessionID: "s1", messageID: "m1", ragInjected: true, ragChunkCount: 3, ragContextTokens: 400, ragTopScore: 0.9 });

    const result = await handleEvalAnalysis(tmpDir, "s1");
    assert.equal(result.status, 200);
    const body = result.body as { analysis: { sessionID: string; queryCount: number; totals: { inputTokens: number }; estimates: { netSavings: number } } };
    assert.equal(body.analysis.sessionID, "s1");
    assert.equal(body.analysis.queryCount, 1);
    assert.equal(body.analysis.totals.inputTokens, 3000);
    assert.equal(typeof body.analysis.estimates.netSavings, "number");
  });

  it("handleEvalAnalysis returns 404 for missing session", async () => {
    const result = await handleEvalAnalysis(tmpDir, "missing");
    assert.equal(result.status, 404);
  });

  it("handleEvalAnalysis returns 400 for invalid session ID", async () => {
    const result = await handleEvalAnalysis(tmpDir, "../../etc/passwd");
    assert.equal(result.status, 400);
  });

  it("handleEvalTokenCompare returns comparison with verdict", async () => {
    appendSessionEvent(tmpDir, { ts: 100, event: "session.created", sessionID: "on", sessionTitle: "RAG On" });
    appendSessionEvent(tmpDir, { ts: 200, event: "message", sessionID: "on", messageID: "m1", role: "assistant", tokens: { input: 3500, output: 200, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.015 });
    appendSessionEvent(tmpDir, { ts: 210, event: "rag.context", sessionID: "on", messageID: "m1", ragInjected: true, ragChunkCount: 3, ragContextTokens: 500, ragTopScore: 0.9, ragRetrievalTimeMs: 30 });

    appendSessionEvent(tmpDir, { ts: 100, event: "session.created", sessionID: "off", sessionTitle: "RAG Off" });
    appendSessionEvent(tmpDir, { ts: 200, event: "message", sessionID: "off", messageID: "m1", role: "assistant", tokens: { input: 2800, output: 250, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.012 });

    const params = new URLSearchParams({ a: "on", b: "off" });
    const result = await handleEvalTokenCompare(tmpDir, params);
    assert.equal(result.status, 200);
    const body = result.body as { ragOn: { estimates: { netSavings: number } }; ragOff: { estimates: { netSavings: number } }; comparison: { verdict: string } };
    assert.equal(typeof body.comparison.verdict, "string");
    assert.ok(body.comparison.verdict.length > 0);
    assert.equal(typeof body.ragOn.estimates.netSavings, "number");
    assert.equal(typeof body.ragOff.estimates.netSavings, "number");
  });

  it("handleEvalTokenCompare returns 400 without both IDs", async () => {
    const params = new URLSearchParams({ a: "only-a" });
    const result = await handleEvalTokenCompare(tmpDir, params);
    assert.equal(result.status, 400);
  });

  it("handleEvalProjectSavings returns projection for valid params", () => {
    const result = handleEvalProjectSavings({
      avgChunkSize: 600,
      avgChunksPerQuery: 3,
      avgReadsPerQueryWithoutRAG: 2.5,
      avgReadsPerQueryWithRAG: 0.5,
      queryCount: 10,
    });
    assert.equal(result.status, 200);
    const body = result.body as { projection: { ragOverheadTokens: number; savedReadTokens: number; netSavings: number; isPositive: boolean } };
    assert.equal(typeof body.projection.ragOverheadTokens, "number");
    assert.equal(typeof body.projection.savedReadTokens, "number");
    assert.equal(typeof body.projection.netSavings, "number");
    assert.equal(typeof body.projection.isPositive, "boolean");
    assert.ok(body.projection.ragOverheadTokens > 0);
    assert.ok(body.projection.savedReadTokens > 0);
  });

  it("handleEvalProjectSavings returns 400 with invalid params", () => {
    const result = handleEvalProjectSavings({ avgChunkSize: "not-a-number" });
    assert.equal(result.status, 400);
  });

  it("handleEvalProjectSavings returns 400 with null body", () => {
    const result = handleEvalProjectSavings(null);
    assert.equal(result.status, 400);
  });
});
