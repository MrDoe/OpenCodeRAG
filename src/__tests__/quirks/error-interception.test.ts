import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRagHooks } from "../../plugin.js";
import { DEFAULT_CONFIG, type MemoryConfig, type RagConfig } from "../../core/config.js";
import type { EmbeddingProvider } from "../../core/interfaces.js";
import { InMemoryVectorStore } from "../../vectorstore/memory.js";
import { KeywordIndex } from "../../retriever/keyword-index.js";

/**
 * The output OpenCode's shell tool produces for a failing command, captured
 * live on 2026-10-21. The host reports the call as `status=completed` — the
 * failure is only visible in the output.
 */
const SHELL_FAILURE_OUTPUT = "npm run build\n\nsh: build script failed\n\n\u001b[31mExited with code 1\u001b[0m";

function makeConfig(
  overrides: Partial<Omit<RagConfig, "memory">> & { memory?: Partial<MemoryConfig> } = {},
): RagConfig {
  return {
    ...DEFAULT_CONFIG,
    embedding: { ...DEFAULT_CONFIG.embedding, ...overrides.embedding },
    indexing: { ...DEFAULT_CONFIG.indexing, ...overrides.indexing },
    vectorStore: { ...DEFAULT_CONFIG.vectorStore, ...overrides.vectorStore },
    retrieval: { ...DEFAULT_CONFIG.retrieval, ...overrides.retrieval },
    openCode: { ...DEFAULT_CONFIG.openCode, ...overrides.openCode },
    chunkers: overrides.chunkers ?? DEFAULT_CONFIG.chunkers,
    memory: { ...DEFAULT_CONFIG.memory, ...overrides.memory } as NonNullable<RagConfig["memory"]>,
  };
}

const testWorktree = process.cwd();

/** A store whose recall always matches perfectly (constant embedding). */
function makeHarness(memory: Partial<MemoryConfig> = {}) {
  const store = new InMemoryVectorStore();
  const keywordIndex = new KeywordIndex();
  const embedder: EmbeddingProvider = {
    name: "test",
    embed: async (texts) => texts.map(() => [0.1, 0.2, 0.3, 0.4]),
  };
  const logFile = path.join(tmpdir(), `opencode-rag-intercept-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
  const hooks = createRagHooks({
    cfg: makeConfig({
      memory: {
        ...DEFAULT_CONFIG.memory,
        enabled: true,
        injectOnToolError: true,
        autoCreateOnToolError: true,
        toolErrorCreateMaxPerSession: 2,
        toolErrorCreateCooldownMs: 0,
        ...memory,
      },
    }),
    storePath: `memory://intercept-${Math.random().toString(36).slice(2)}`,
    logFilePath: logFile,
    store,
    embedder,
    keywordIndex,
    worktree: testWorktree,
  });
  return { hooks, store, logFile };
}

describe("error interception on the completed branch", () => {
  it("records a quirk for a failure the host reported as success", async () => {
    const { hooks, store } = makeHarness();
    const after = hooks["tool.execute.after"];
    assert.ok(after);

    await after(
      { tool: "shell", sessionID: "session-out", callID: "call-1", status: "completed" } as never,
      { title: "shell", output: SHELL_FAILURE_OUTPUT, metadata: {} } as never,
    );

    const quirks = (await store.getChunks(0, 50)).filter((c) => c.kind === "quirk");
    assert.equal(quirks.length, 1, "expected exactly one auto-created quirk");
    const quirk = quirks[0]!;
    assert.match(quirk.content, /shell/);
    assert.match(quirk.content, /Exited with code 1/);
    assert.ok(quirk.tags?.includes("tool-error"), "expected the tool-error tag");
    assert.ok(quirk.tags?.includes("tool:shell"), "expected the per-tool tag");
    assert.ok(quirk.tags?.includes("cause:exit-code"), "expected the cause tag");
  });

  it("does NOT inject into the failing turn — the quirk is for later", async () => {
    const { hooks } = makeHarness();
    const after = hooks["tool.execute.after"];
    const transform = hooks["experimental.chat.system.transform"];
    assert.ok(after);
    assert.ok(transform);

    await after(
      { tool: "shell", sessionID: "session-first", callID: "call-1", status: "completed" } as never,
      { title: "shell", output: SHELL_FAILURE_OUTPUT, metadata: {} } as never,
    );

    const output = { system: [] as string[] };
    await transform(
      { sessionID: "session-first", model: { providerID: "test", modelID: "test" }, tools: {} } as never,
      output as never,
    );

    assert.equal(
      output.system.find((s) => /Tool error/.test(s)),
      undefined,
      "a freshly recorded quirk must not be injected into the turn that produced the failure",
    );
  });

  it("injects the stored quirk into the next model request on a repeat", async () => {
    const { hooks } = makeHarness({ toolErrorCooldownMs: 0 });
    const after = hooks["tool.execute.after"];
    const transform = hooks["experimental.chat.system.transform"];
    assert.ok(after);
    assert.ok(transform);

    const call = (id: string) =>
      after(
        { tool: "shell", sessionID: "session-inject", callID: id, status: "completed" } as never,
        { title: "shell", output: SHELL_FAILURE_OUTPUT, metadata: {} } as never,
      );

    await call("call-1");
    await call("call-2");

    const output = { system: [] as string[] };
    await transform(
      { sessionID: "session-inject", model: { providerID: "test", modelID: "test" }, tools: {} } as never,
      output as never,
    );

    const block = output.system.find((s) => /Tool error/.test(s));
    assert.ok(block, "expected the tool-error quirk block in the system prompt");
    assert.match(block!, /Exited with code 1/);
  });

  it("recalls and injects the stored quirk on a repeat, without creating a second one", async () => {
    const { hooks, store } = makeHarness();
    const after = hooks["tool.execute.after"];
    assert.ok(after);

    const call = (id: string) =>
      after(
        { tool: "shell", sessionID: "session-repeat", callID: id, status: "completed" } as never,
        { title: "shell", output: SHELL_FAILURE_OUTPUT, metadata: {} } as never,
      );

    await call("call-1");
    await call("call-2");

    const quirks = (await store.getChunks(0, 50)).filter((c) => c.kind === "quirk");
    assert.equal(quirks.length, 1, "the duplicate must not create a second quirk");
  });

  it("leaves a successful tool call alone", async () => {
    const { hooks, store } = makeHarness();
    const after = hooks["tool.execute.after"];
    assert.ok(after);

    await after(
      { tool: "shell", sessionID: "session-ok", callID: "call-1", status: "completed" } as never,
      { title: "shell", output: "total 42\nREADME.md\n", metadata: {} } as never,
    );

    const quirks = (await store.getChunks(0, 50)).filter((c) => c.kind === "quirk");
    assert.equal(quirks.length, 0, "a successful call must not create a quirk");
  });

  it("detects a failure from the structured exit code alone", async () => {
    // The shell tool reports `{ status, truncated, exit }` in its result
    // metadata, and its text carries no marker in some shapes.
    const { hooks, store } = makeHarness();
    const after = hooks["tool.execute.after"];
    assert.ok(after);

    await after(
      { tool: "shell", sessionID: "session-exit", callID: "call-1", status: "completed" } as never,
      {
        title: "shell",
        output: "npm run build\nfail: script exited",
        metadata: { status: "completed", truncated: false, exit: 7 },
      } as never,
    );

    const quirks = (await store.getChunks(0, 50)).filter((c) => c.kind === "quirk");
    assert.equal(quirks.length, 1, "a non-zero exit code is a failure");
    assert.ok(quirks[0]!.tags?.includes("cause:exit-code"), "expected the exit-code cause");
  });

  it("does not treat a zero exit code as a failure", async () => {
    const { hooks, store } = makeHarness();
    const after = hooks["tool.execute.after"];
    assert.ok(after);

    await after(
      { tool: "shell", sessionID: "session-zero", callID: "call-1", status: "completed" } as never,
      { title: "shell", output: "all good", metadata: { status: "completed", exit: 0 } } as never,
    );

    const quirks = (await store.getChunks(0, 50)).filter((c) => c.kind === "quirk");
    assert.equal(quirks.length, 0);
  });

  it("respects memory.interceptAllErrors=false", async () => {
    const { hooks, store } = makeHarness({ interceptAllErrors: false });
    const after = hooks["tool.execute.after"];
    assert.ok(after);

    await after(
      { tool: "shell", sessionID: "session-off", callID: "call-1", status: "completed" } as never,
      { title: "shell", output: SHELL_FAILURE_OUTPUT, metadata: {} } as never,
    );

    const quirks = (await store.getChunks(0, 50)).filter((c) => c.kind === "quirk");
    assert.equal(quirks.length, 0, "interception is disabled");
  });

  it("respects memory.autoCreateOnInterceptedError=false — recall only", async () => {
    const { hooks, store } = makeHarness({ autoCreateOnInterceptedError: false });
    const after = hooks["tool.execute.after"];
    assert.ok(after);

    await after(
      { tool: "shell", sessionID: "session-nocreate", callID: "call-1", status: "completed" } as never,
      { title: "shell", output: SHELL_FAILURE_OUTPUT, metadata: {} } as never,
    );

    const quirks = (await store.getChunks(0, 50)).filter((c) => c.kind === "quirk");
    assert.equal(quirks.length, 0, "creation is disabled for intercepted errors");
  });

  it("still handles the host-reported error branch unchanged", async () => {
    const { hooks, store } = makeHarness();
    const after = hooks["tool.execute.after"];
    assert.ok(after);

    await after(
      { tool: "edit", sessionID: "session-host", callID: "call-1", status: "error" } as never,
      {
        title: "edit",
        output: "",
        metadata: {},
        error: "Invalid arguments for tool \"edit\":\n- oldString: Missing key",
      } as never,
    );

    const quirks = (await store.getChunks(0, 50)).filter((c) => c.kind === "quirk");
    assert.equal(quirks.length, 1, "the host branch must keep working");
    assert.ok(quirks[0]!.tags?.includes("cause:schema"), "expected the schema cause");
  });

  it("intercepts a session-level failure reported on the event stream", async () => {
    const { hooks, store } = makeHarness();
    const event = hooks["event"];
    assert.ok(event);

    // The V2 event is `session.execution.failed` (measured live 2026-10-21);
    // `session.error` is the legacy name V2 never emits.
    await event({
      event: {
        type: "session.execution.failed",
        // V2 carries the payload in `data`, V1 in `properties`.
        data: { sessionID: "session-err", error: { name: "ProviderError", message: "model is overloaded" } },
      },
    } as never);

    const quirks = (await store.getChunks(0, 50)).filter((c) => c.kind === "quirk");
    assert.equal(quirks.length, 1, "expected a quirk for the session failure");
    assert.match(quirks[0]!.content, /model is overloaded/);
    assert.ok(quirks[0]!.tags?.includes("tool:session"), "expected the session tool tag");
  });

  it("also accepts the legacy session.error event name", async () => {
    const { hooks, store } = makeHarness();
    const event = hooks["event"];
    assert.ok(event);

    await event({
      event: {
        type: "session.error",
        data: { sessionID: "session-legacy", error: { message: "provider refused the request" } },
      },
    } as never);

    const quirks = (await store.getChunks(0, 50)).filter((c) => c.kind === "quirk");
    assert.equal(quirks.length, 1);
    assert.match(quirks[0]!.content, /provider refused the request/);
  });

  it("ignores events that are not session errors", async () => {
    const { hooks, store } = makeHarness();
    const event = hooks["event"];
    assert.ok(event);

    await event({ event: { type: "message.updated", data: { sessionID: "session-other" } } } as never);

    const quirks = (await store.getChunks(0, 50)).filter((c) => c.kind === "quirk");
    assert.equal(quirks.length, 0);
  });

  it("logs the interception so the behaviour is observable", async () => {
    const { hooks, logFile } = makeHarness();
    const after = hooks["tool.execute.after"];
    assert.ok(after);

    await after(
      { tool: "shell", sessionID: "session-log", callID: "call-1", status: "completed" } as never,
      { title: "shell", output: SHELL_FAILURE_OUTPUT, metadata: {} } as never,
    );

    const log = readFileSync(logFile, "utf-8");
    assert.match(log, /status=completed but its output reports a failure/);
    assert.match(log, /source=output/);
  });
});
