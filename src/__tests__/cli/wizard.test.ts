import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildConfigPatch,
  findShadowingProviderKeys,
  mergeConfigObjects,
  readJsonObjectSafe,
  removeConfigPaths,
  writeConfigPatch,
} from "../../cli/wizard/apply.js";
import { answersFromFlags, hasExplicitSetupFlags, runSetupWizard } from "../../cli/wizard/flow.js";
import type { Prompter, SelectPromptOptions } from "../../cli/prompt.js";
import { fetchModelCatalog, inferCapabilities } from "../../cli/wizard/model-catalog.js";
import { createPrompter } from "../../cli/prompt.js";
import type { WizardAnswers } from "../../cli/wizard/types.js";

const ANSWERS: WizardAnswers = {
  embedding: {
    provider: "openai",
    baseUrl: "http://127.0.0.1:11437/v1",
    apiKey: "sk-test",
    model: "Qwen3-Embedding:8B",
    vectorDimension: 4096,
  },
  description: {
    provider: "openai",
    baseUrl: "http://127.0.0.1:11437/v1",
    model: "qwen2.5:3b",
  },
  descriptionEnabled: true,
  imageDescriptionEnabled: false,
  decision: { enabled: false },
  reranking: { enabled: false },
  shellGuard: { enabled: true },
  memory: { passiveCapture: false, promptEnforcement: false, sessionEndExtraction: false },
  vectorStore: { provider: "lancedb" },
  indexing: { embedDescriptions: false },
  openCode: { autoIndex: true },
};

describe("wizard config patch", () => {
  it("routes provider settings to the global layer and toggles to the workspace", () => {
    const { global, workspace } = buildConfigPatch(ANSWERS);
    const globalEmbedding = global.embedding as Record<string, unknown>;
    assert.equal(globalEmbedding.provider, "openai");
    assert.equal(globalEmbedding.apiKey, "sk-test");
    assert.equal(globalEmbedding.vectorDimension, 4096);
    assert.equal((global.description as Record<string, unknown>).model, "qwen2.5:3b");

    const ws = workspace as Record<string, Record<string, unknown>>;
    assert.equal(ws.description?.enabled, true);
    assert.equal(ws.imageDescription?.enabled, false);
    assert.equal(ws.decision?.enabled, false);
    assert.equal(ws.reranking?.enabled, false);
    assert.equal(ws.shellGuard?.enabled, true);
    assert.equal(ws.indexing?.embedDescriptions, false);
    assert.equal((ws.openCode?.autoIndex as Record<string, unknown>).enabled, true);
    assert.equal("embedding" in ws, false, "workspace must not shadow provider settings");
  });

  it("deep-merges patches without dropping unrelated sections", () => {
    const merged = mergeConfigObjects(
      { retrieval: { topK: 20, hybridSearch: { enabled: true } }, shellGuard: { enabled: false } },
      { retrieval: { topK: 30 }, shellGuard: { threshold: 0.6 } },
    );
    assert.deepEqual(merged.retrieval, { topK: 30, hybridSearch: { enabled: true } });
    assert.deepEqual(merged.shellGuard, { enabled: false, threshold: 0.6 });
  });

  it("finds and removes provider keys that shadow the global layer", () => {
    const workspace = {
      embedding: { provider: "ollama", model: "old", vectorDimension: 384 },
      description: { enabled: true, model: "old-desc" },
      indexing: { embedBatchSize: 40 },
    };
    const paths = findShadowingProviderKeys(workspace);
    assert.deepEqual(paths.sort(), [["description", "model"], ["embedding", "model"], ["embedding", "provider"], ["embedding", "vectorDimension"]]);
    removeConfigPaths(workspace, paths);
    assert.deepEqual(workspace.embedding, {});
    assert.deepEqual(workspace.description, { enabled: true });
    assert.deepEqual(workspace.indexing, { embedBatchSize: 40 });
  });

  it("writes a patch into a new file and merges into an existing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-rag-patch-"));
    const file = join(dir, "opencode-rag.json");
    try {
      assert.equal(writeConfigPatch(file, { embedding: { model: "a" } }), true);
      assert.deepEqual(readJsonObjectSafe(file), { embedding: { model: "a" } });
      assert.equal(writeConfigPatch(file, { embedding: { model: "b" } }), true);
      assert.deepEqual(readJsonObjectSafe(file), { embedding: { model: "b" } });
      assert.ok(readFileSync(`${file}.bak`, "utf-8").length > 0, "a backup is written before merging");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("answersFromFlags", () => {
  it("detects whether any setup flag was supplied", () => {
    assert.equal(hasExplicitSetupFlags({}), false);
    assert.equal(hasExplicitSetupFlags({ embeddingModel: "x" }), true);
    assert.equal(hasExplicitSetupFlags({ vision: false }), true);
  });

  it("builds answers from flags and falls back to the existing config", () => {
    const answers = answersFromFlags(
      { provider: "openai", baseUrl: "http://localhost:11437/v1", embeddingModel: "custom-embed", description: false },
      { embedding: { provider: "ollama", model: "old", vectorDimension: 1024 } },
    );
    assert.equal(answers.embedding.provider, "openai");
    assert.equal(answers.embedding.baseUrl, "http://localhost:11437/v1");
    assert.equal(answers.embedding.model, "custom-embed");
    assert.equal(answers.embedding.vectorDimension, 1024, "dimension survives a flag-driven reconfigure");
    assert.equal(answers.description, undefined);
    assert.equal(answers.descriptionEnabled, false);
    assert.equal(answers.decision, undefined, "no decision flag must leave the section untouched");
  });
});

describe("model catalog", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("infers capabilities from model names", () => {
    assert.deepEqual(inferCapabilities("nomic-embed-text"), ["embedding"]);
    assert.deepEqual(inferCapabilities("qwen2.5:3b"), ["chat"]);
    assert.ok(inferCapabilities("llava:13b").includes("vision"));
    assert.deepEqual(inferCapabilities("whisper:large"), []);
  });

  it("lists OpenAI-compatible models and infers capabilities", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "text-embedding-3-small" }, { id: "gpt-4o" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const catalog = await fetchModelCatalog({ provider: "openai", baseUrl: "https://example.test/v1" });
    assert.equal(catalog.reachable, true);
    assert.deepEqual(catalog.models.map((model) => model.id), ["gpt-4o", "text-embedding-3-small"]);
    assert.deepEqual(catalog.models.find((model) => model.id === "gpt-4o")?.capabilities, ["chat", "vision"]);
  });

  it("reports an unreachable Ollama host instead of throwing", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const catalog = await fetchModelCatalog({ provider: "ollama", baseUrl: "http://127.0.0.1:1/api" });
    assert.equal(catalog.reachable, false);
    assert.ok(catalog.error);
    assert.equal(catalog.baseUrl, "http://127.0.0.1:1/api");
  });
});

describe("non-interactive prompter", () => {
  it("returns defaults and never reads stdin", async () => {
    const prompter = createPrompter(false);
    assert.equal(prompter.interactive, false);
    assert.equal(await prompter.text({ message: "x", defaultValue: "d" }), "d");
    assert.equal(await prompter.confirm({ message: "x", defaultValue: false }), false);
    assert.equal(await prompter.select({ message: "x", options: [{ label: "a", value: "a" }] }), "a");
    assert.equal(await prompter.password("x"), undefined);
  });
});

/** Deterministic prompter that replays a scripted answer per question type. */
class ScriptedPrompter implements Prompter {
  readonly interactive = true;
  private texts: (string | undefined)[];
  private confirms: (boolean | undefined)[];
  private selects: (string | undefined)[];

  constructor(script: {
    texts: (string | undefined)[];
    confirms: (boolean | undefined)[];
    selects: (string | undefined)[];
  }) {
    this.texts = [...script.texts];
    this.confirms = [...script.confirms];
    this.selects = [...script.selects];
  }

  async text(): Promise<string | undefined> {
    return this.texts.shift();
  }

  async password(): Promise<string | undefined> {
    return undefined;
  }

  async confirm(): Promise<boolean | undefined> {
    return this.confirms.shift();
  }

  async select<T>(options: SelectPromptOptions<T>): Promise<T | undefined> {
    const next = this.selects.shift();
    if (next === "__default__") return options.options[options.defaultIndex ?? 0]?.value;
    return next as T | undefined;
  }

  close(): void {}
}

describe("wizard flow", () => {
  it("walks an Ollama setup with manual model entry and no optional features", async () => {
    const prompter = new ScriptedPrompter({
      selects: ["__default__"],
      texts: ["http://127.0.0.1:1/api", "my-embed"],
      confirms: [false, false, false, false, true],
    });
    const answers = await runSetupWizard({ prompter, existing: {}, proxy: undefined });
    assert.ok(answers, "wizard should produce answers");
    assert.equal(answers.embedding.provider, "ollama");
    assert.equal(answers.embedding.model, "my-embed");
    assert.equal(answers.descriptionEnabled, false);
    assert.equal(answers.imageDescriptionEnabled, false);
    assert.equal(answers.decision?.enabled, false);
    assert.equal(answers.embedding.apiKey, undefined);
  });

  it("returns undefined when the user cancels the first question", async () => {
    const prompter = new ScriptedPrompter({ selects: [undefined], texts: [], confirms: [] });
    const answers = await runSetupWizard({ prompter, existing: {}, proxy: undefined });
    assert.equal(answers, undefined);
  });
});
