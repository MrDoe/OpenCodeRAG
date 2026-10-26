import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ShellGuard,
  buildShellGuardState,
  formatShellGuardReason,
  isShellToolName,
  resolveShellGuardRuntimeConfig,
  verdictFromDecisionResult,
  type ShellGuardRuntimeConfig,
} from "../../safety/shell-guard.js";
import type { DecisionConfig, RagConfig } from "../../core/config.js";
import type { DecisionProvider, DecisionRequest, DecisionResult } from "../../core/interfaces.js";

function makeDecisionConfig(overrides: Partial<DecisionConfig> = {}): DecisionConfig {
  return {
    enabled: true,
    provider: "ollama",
    baseUrl: "http://127.0.0.1:1",
    model: "tev1:test",
    timeoutMs: 5000,
    retryMax: 0,
    retryBaseDelayMs: 1,
    ...overrides,
  };
}

function makeRuntimeConfig(
  guard: Partial<ShellGuardRuntimeConfig["guard"]> = {},
  decision: Partial<DecisionConfig> = {},
): ShellGuardRuntimeConfig {
  return {
    guard: {
      enabled: true,
      threshold: 0.5,
      timeoutMs: 1000,
      onError: "allow",
      cacheTtlMs: 600000,
      maxCacheEntries: 256,
      ...guard,
    },
    decision: makeDecisionConfig(decision),
    logging: { level: "none", logFilePath: "/tmp/opencode/shell-guard-test.log" },
  };
}

function answers(destructive: number, malicious: number, category = "none"): DecisionResult {
  return {
    answers: [
      { id: "destructive", type: "noul", noul: destructive },
      { id: "malicious", type: "noul", noul: malicious },
      { id: "category", type: "choice", choice: category, probabilities: { [category]: 1 } },
    ],
  };
}

function makeProvider(
  handler: (request: DecisionRequest, signal?: AbortSignal) => Promise<DecisionResult>,
): DecisionProvider & { calls: number } {
  const provider = {
    name: "fake",
    calls: 0,
    async decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> {
      provider.calls++;
      return handler(request, signal);
    },
  };
  return provider;
}

describe("buildShellGuardState", () => {
  it("returns the trimmed command when it fits", () => {
    assert.equal(buildShellGuardState("  rm -rf ./dist  "), "rm -rf ./dist");
  });

  it("keeps head and tail and marks the omission for oversized commands", () => {
    const command = `${"a".repeat(8000)}MIDDLE${"z".repeat(8000)}`;
    const state = buildShellGuardState(command, 200);
    assert.ok(state.length <= 200 + 40, `state too long: ${state.length}`);
    assert.ok(state.startsWith("aaa"), "head must be preserved");
    assert.ok(state.endsWith("zzz"), "tail must be preserved");
    assert.match(state, /truncated by shell guard/);
    assert.ok(!state.includes("MIDDLE"));
  });

  it("treats maxChars <= 0 as no limit", () => {
    const command = "x".repeat(500);
    assert.equal(buildShellGuardState(command, 0), command);
  });
});

describe("isShellToolName", () => {
  it("accepts shell and bash case-insensitively", () => {
    assert.equal(isShellToolName("shell"), true);
    assert.equal(isShellToolName("Bash"), true);
    assert.equal(isShellToolName("read"), false);
    assert.equal(isShellToolName(undefined), false);
  });
});

describe("verdictFromDecisionResult", () => {
  it("flags when either probability reaches the threshold", () => {
    const verdict = verdictFromDecisionResult(answers(0.51, 0.01, "delete_files"), {
      threshold: 0.5,
      provider: "ollama",
      model: "tev1:test",
      latencyMs: 12,
    });
    assert.equal(verdict.flagged, true);
    assert.equal(verdict.category, "delete_files");
    assert.match(verdict.reason, /destructive p=0\.51/);
    assert.match(verdict.reason, /category: delete_files/);
  });

  it("treats an exact-threshold probability as flagged", () => {
    const verdict = verdictFromDecisionResult(answers(0.5, 0), {
      threshold: 0.5,
      provider: "ollama",
      model: "tev1:test",
      latencyMs: 1,
    });
    assert.equal(verdict.flagged, true);
  });

  it("leaves clean commands unflagged", () => {
    const verdict = verdictFromDecisionResult(answers(0.2, 0.1), {
      threshold: 0.5,
      provider: "ollama",
      model: "tev1:test",
      latencyMs: 1,
    });
    assert.equal(verdict.flagged, false);
    assert.equal(verdict.category, "none");
  });

  it("clamps out-of-range and non-numeric answers", () => {
    const result: DecisionResult = {
      answers: [
        { id: "destructive", type: "noul", noul: 1.7 },
        { id: "malicious", type: "noul", noul: Number.NaN },
      ],
    };
    const verdict = verdictFromDecisionResult(result, {
      threshold: 0.5,
      provider: "ollama",
      model: "tev1:test",
      latencyMs: 1,
    });
    assert.equal(verdict.destructive, 1);
    assert.equal(verdict.malicious, 0);
  });
});

describe("ShellGuard.evaluate", () => {
  it("is a no-op when the guard is disabled", async () => {
    let calls = 0;
    const guard = new ShellGuard({
      getConfig: () => undefined,
      createProvider: () => makeProvider(async () => { calls++; return answers(1, 1); }),
    });
    const verdict = await guard.evaluate("rm -rf /");
    assert.equal(verdict.skipped, true);
    assert.equal(verdict.flagged, false);
    assert.equal(calls, 0);
  });

  it("flags a destructive command and explains the verdict", async () => {
    const provider = makeProvider(async () => answers(0.93, 0.02, "delete_files"));
    const guard = new ShellGuard({
      getConfig: () => makeRuntimeConfig(),
      createProvider: () => provider,
    });
    const verdict = await guard.evaluate("rm -rf /tmp/data");
    assert.equal(verdict.flagged, true);
    assert.equal(verdict.category, "delete_files");
    assert.match(verdict.reason, /ollama\/tev1:test/);
    assert.match(verdict.reason, /destructive p=0\.93/);
    assert.match(verdict.reason, /Confirm before running/);
    assert.equal(provider.calls, 1);
  });

  it("passes a clean command through", async () => {
    const guard = new ShellGuard({
      getConfig: () => makeRuntimeConfig(),
      createProvider: () => makeProvider(async () => answers(0.02, 0.01)),
    });
    const verdict = await guard.evaluate("ls -la");
    assert.equal(verdict.flagged, false);
    assert.equal(verdict.reason.includes("Confirm before running"), false);
  });

  it("sends the threshold and model config to the provider and caches verdicts", async () => {
    let now = 1000;
    const provider = makeProvider(async (request) => {
      assert.equal(request.questions.length, 3);
      assert.deepEqual(request.questions.map((q) => q.id), ["destructive", "malicious", "category"]);
      return answers(0.9, 0.1, "delete_files");
    });
    const guard = new ShellGuard({
      getConfig: () => makeRuntimeConfig({ cacheTtlMs: 5000 }),
      createProvider: () => provider,
      now: () => now,
    });

    const first = await guard.evaluate("rm -rf node_modules");
    assert.equal(first.cached, false);
    const second = await guard.evaluate("rm -rf node_modules");
    assert.equal(second.cached, true);
    assert.equal(provider.calls, 1);

    now += 5001;
    const third = await guard.evaluate("rm -rf node_modules");
    assert.equal(third.cached, false);
    assert.equal(provider.calls, 2);
  });

  it("fails open by default when the classifier throws", async () => {
    const guard = new ShellGuard({
      getConfig: () => makeRuntimeConfig({ onError: "allow" }),
      createProvider: () => makeProvider(async () => { throw new Error("connection refused"); }),
    });
    const verdict = await guard.evaluate("rm -rf /");
    assert.equal(verdict.flagged, false);
    assert.equal(verdict.error, "connection refused");
    assert.equal(verdict.reason, "");
  });

  it("escalates classifier failures when onError is ask", async () => {
    const guard = new ShellGuard({
      getConfig: () => makeRuntimeConfig({ onError: "ask" }),
      createProvider: () => makeProvider(async () => { throw new Error("boom"); }),
    });
    const verdict = await guard.evaluate("rm -rf /");
    assert.equal(verdict.flagged, true);
    assert.match(verdict.reason, /could not classify/);
    assert.match(verdict.reason, /shellGuard\.onError = "ask"/);
  });

  it("times out a hung classifier and applies onError", async () => {
    const guard = new ShellGuard({
      getConfig: () => makeRuntimeConfig({ timeoutMs: 50 }),
      createProvider: () => makeProvider(
        (_request, signal) => new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      ),
    });
    const started = Date.now();
    const verdict = await guard.evaluate("rm -rf /");
    assert.ok(Date.now() - started < 2000, "timeout must bound the wait");
    assert.equal(verdict.flagged, false);
    assert.match(verdict.error ?? "", /timeout after 50ms/);
  });

  it("rebuilds the provider when the model signature changes", async () => {
    let cfg = makeRuntimeConfig({}, { model: "tev1:0.8b" });
    let built = 0;
    const guard = new ShellGuard({
      getConfig: () => cfg,
      createProvider: () => {
        built++;
        return makeProvider(async () => answers(0, 0));
      },
    });
    await guard.evaluate("ls");
    await guard.evaluate("ls");
    assert.equal(built, 1);
    cfg = makeRuntimeConfig({}, { model: "Clef-Flash" });
    await guard.evaluate("ls");
    assert.equal(built, 2);
  });

  it("re-derives a cached verdict against the current threshold", async () => {
    let threshold = 0.5;
    const provider = makeProvider(async () => answers(0.61, 0.01));
    const guard = new ShellGuard({
      getConfig: () => makeRuntimeConfig({ cacheTtlMs: 5000, threshold }),
      createProvider: () => provider,
    });

    const first = await guard.evaluate("delete build output");
    assert.equal(first.flagged, true);

    threshold = 0.9;
    const second = await guard.evaluate("delete build output");
    assert.equal(second.cached, true);
    assert.equal(second.flagged, false);
    assert.equal(second.reason, "");
    assert.equal(provider.calls, 1);
  });

  it("re-derives a cached failure against the current onError policy", async () => {
    let onError: "allow" | "ask" = "allow";
    const guard = new ShellGuard({
      getConfig: () => makeRuntimeConfig({ cacheTtlMs: 5000, onError }),
      createProvider: () => makeProvider(async () => { throw new Error("offline"); }),
    });

    const first = await guard.evaluate("rebuild index");
    assert.equal(first.flagged, false);

    onError = "ask";
    const second = await guard.evaluate("rebuild index");
    assert.equal(second.cached, true);
    assert.equal(second.flagged, true);
    assert.match(second.reason, /could not classify/);
  });
});

describe("resolveShellGuardRuntimeConfig", () => {
  const base = {
    decision: makeDecisionConfig(),
    logging: { level: "info", logFilePath: "/tmp/opencode/log" },
  } as unknown as RagConfig;

  it("returns undefined when disabled", () => {
    const cfg = { ...base, shellGuard: { enabled: false, threshold: 0.5, timeoutMs: 1000, cacheTtlMs: 0 } } as RagConfig;
    assert.equal(resolveShellGuardRuntimeConfig(cfg), undefined);
  });

  it("reuses decision.* and applies shellGuard overrides", () => {
    const cfg = {
      ...base,
      shellGuard: {
        enabled: true,
        threshold: 0.6,
        timeoutMs: 2000,
        cacheTtlMs: 0,
        model: "Clef-Flash",
        baseUrl: "http://localhost:11437",
      },
    } as RagConfig;
    const resolved = resolveShellGuardRuntimeConfig(cfg);
    assert.ok(resolved);
    assert.equal(resolved.guard.threshold, 0.6);
    assert.equal(resolved.decision.model, "Clef-Flash");
    assert.equal(resolved.decision.baseUrl, "http://localhost:11437");
    assert.equal(resolved.decision.provider, "ollama");
    assert.equal(resolved.decision.enabled, true);
  });

  it("resolves the log path against the workspace directory when given", () => {
    const cfg = {
      ...base,
      logging: { level: "info", logFilePath: "./.opencode/opencode-rag.log" },
      shellGuard: { enabled: true, threshold: 0.5, timeoutMs: 1000, cacheTtlMs: 0 },
    } as RagConfig;
    assert.equal(
      resolveShellGuardRuntimeConfig(cfg)?.logging.logFilePath,
      "./.opencode/opencode-rag.log",
    );
    assert.equal(
      resolveShellGuardRuntimeConfig(cfg, "/work/space")?.logging.logFilePath,
      "/work/space/.opencode/opencode-rag.log",
    );
  });
});

describe("formatShellGuardReason", () => {
  it("describes classifier errors instead of probabilities", () => {
    const reason = formatShellGuardReason({
      flagged: true,
      destructive: 0,
      malicious: 0,
      category: "none",
      reason: "",
      provider: "ollama",
      model: "tev1:test",
      latencyMs: 1,
      cached: false,
      error: "timeout after 50ms",
    });
    assert.match(reason, /could not classify/);
    assert.match(reason, /timeout after 50ms/);
  });
});
