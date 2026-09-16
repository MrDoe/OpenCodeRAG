import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApiKey } from "../../core/resolve-api-key.js";

function makeConfig(onDemand?: Record<string, unknown>) {
  return {
    embedding: { provider: "openai", apiKey: "" },
    description: undefined,
    imageDescription: {
      enabled: true,
      provider: "ollama",
      model: "minicpm-v-4.6",
      baseUrl: "http://127.0.0.1:11434/api",
      timeoutMs: 60000,
      prompt: "Describe this image",
      ...(onDemand ? { onDemand } : {}),
    },
  } as unknown as Parameters<typeof resolveApiKey>[0];
}

describe("resolveApiKey (OpenCode auth store)", () => {
  let dataHome: string;
  let savedXdg: string | undefined;

  beforeEach(() => {
    dataHome = mkdtempSync(join(tmpdir(), "opencode-rag-auth-"));
    savedXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataHome;
  });

  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = savedXdg;
    rmSync(dataHome, { recursive: true, force: true });
  });

  function writeAuth(entries: Record<string, unknown>): void {
    mkdirSync(join(dataHome, "opencode"), { recursive: true });
    writeFileSync(join(dataHome, "opencode", "auth.json"), JSON.stringify(entries), "utf-8");
  }

  it("resolves an on-demand Zen key from auth.json", () => {
    writeAuth({ "opencode-go": { type: "api", key: "go-key-123" } });
    const cfg = makeConfig({ provider: "opencode-go", model: "mimo-v2.5" });
    resolveApiKey(cfg);
    assert.equal((cfg.imageDescription as any).onDemand.apiKey, "go-key-123");
    assert.equal((cfg.imageDescription as any).apiKey ?? undefined, undefined);
  });

  it("resolves a base-section Zen key from auth.json", () => {
    writeAuth({ "opencode-go": { type: "api", key: "go-key-123" } });
    const cfg = makeConfig();
    (cfg.imageDescription as any).provider = "opencode-go";
    resolveApiKey(cfg);
    assert.equal((cfg.imageDescription as any).apiKey, "go-key-123");
  });

  it("keeps an explicitly configured key", () => {
    writeAuth({ "opencode-go": { type: "api", key: "from-auth" } });
    const cfg = makeConfig({ provider: "opencode-go", model: "mimo-v2.5", apiKey: "explicit" });
    resolveApiKey(cfg);
    assert.equal((cfg.imageDescription as any).onDemand.apiKey, "explicit");
  });

  it("ignores non-api auth entries", () => {
    writeAuth({ "opencode-go": { type: "oauth", access: "token" } });
    const cfg = makeConfig({ provider: "opencode-go", model: "mimo-v2.5" });
    resolveApiKey(cfg);
    assert.equal((cfg.imageDescription as any).onDemand.apiKey, undefined);
  });

  it("prefers the provider env var over auth.json", () => {
    writeAuth({ openai: { type: "api", key: "from-auth" } });
    const savedEnv = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "from-env";
    try {
      const cfg = makeConfig({ provider: "openai", model: "gpt-4o-mini" });
      resolveApiKey(cfg);
      assert.equal((cfg.imageDescription as any).onDemand.apiKey, "from-env");
    } finally {
      if (savedEnv === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedEnv;
    }
  });

  it("prefers a worktree OpenCode config key over auth.json", () => {
    writeAuth({ "opencode-go": { type: "api", key: "from-auth" } });
    const worktree = mkdtempSync(join(tmpdir(), "opencode-rag-worktree-"));
    try {
      writeFileSync(
        join(worktree, "opencode.json"),
        JSON.stringify({ provider: { "opencode-go": { options: { apiKey: "from-config" } } } }),
        "utf-8"
      );
      const cfg = makeConfig({ provider: "opencode-go", model: "mimo-v2.5" });
      resolveApiKey(cfg, worktree);
      assert.equal((cfg.imageDescription as any).onDemand.apiKey, "from-config");
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("resolves an unknown provider id with no defaults from auth.json", () => {
    writeAuth({ "some-new-provider": { type: "api", key: "new-key" } });
    const cfg = makeConfig({ provider: "some-new-provider", model: "m" });
    resolveApiKey(cfg);
    assert.equal((cfg.imageDescription as any).onDemand.apiKey, "new-key");
  });
});
