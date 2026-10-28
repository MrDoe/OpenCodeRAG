import { after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
import type { Prompter, SelectPromptOptions, TextPromptOptions } from "../../cli/prompt.js";
import { fetchModelCatalog, inferCapabilities } from "../../cli/wizard/model-catalog.js";
import { createPrompter } from "../../cli/prompt.js";
import {
  OLLAMA_CPU_PRESET,
  OLLAMA_GPU_PRESET,
  describePreset,
  presetForBackend,
  presetModelStatus,
} from "../../cli/wizard/presets.js";
import type { WizardAnswers } from "../../cli/wizard/types.js";
import { destroyAllPooledConnections } from "../../embedder/http.js";
import { buildRepairPatch, offerHealthRepairs, resolveRepairLayer } from "../../cli/wizard/repair.js";

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
    assert.equal(answers.embedding.vectorDimension, undefined, "a changed model drops the old dimension");
    assert.equal(answers.description, undefined);
    assert.equal(answers.descriptionEnabled, false);
    assert.equal(answers.decision, undefined, "no decision flag must leave the section untouched");
  });

  it("keeps the configured dimension when the embedding target is unchanged", () => {
    const answers = answersFromFlags(
      { description: false },
      {
        embedding: {
          provider: "ollama",
          baseUrl: "http://127.0.0.1:11434/api",
          model: "qwen3-embedding:0.6b",
          vectorDimension: 1024,
        },
      },
    );
    assert.equal(answers.embedding.vectorDimension, 1024, "an unrelated flag keeps the dimension");
  });

  it("clears a stale dimension from the config when the model changes", () => {
    const answers = answersFromFlags(
      { embeddingModel: "qwen3-embedding:4b" },
      {
        embedding: {
          provider: "ollama",
          baseUrl: "http://127.0.0.1:11434/api",
          model: "qwen3-embedding:0.6b",
          vectorDimension: 1024,
        },
      },
    );
    const { global } = buildConfigPatch(answers);
    assert.equal((global.embedding as Record<string, unknown>).vectorDimension, null, "null asks the merge to delete the key");
    const merged = mergeConfigObjects(
      { embedding: { provider: "ollama", model: "qwen3-embedding:0.6b", vectorDimension: 1024 } },
      global,
    );
    assert.equal("vectorDimension" in (merged.embedding as Record<string, unknown>), false);
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
  private passwords: (string | undefined)[];

  constructor(script: {
    texts: (string | undefined)[];
    confirms: (boolean | undefined)[];
    selects: (string | undefined)[];
    passwords?: (string | undefined)[];
  }) {
    this.texts = [...script.texts];
    this.confirms = [...script.confirms];
    this.selects = [...script.selects];
    this.passwords = [...(script.passwords ?? [])];
  }

  async text(options: TextPromptOptions): Promise<string | undefined> {
    const next = this.texts.shift();
    return next === "__default__" ? options.defaultValue : next;
  }

  async password(): Promise<string | undefined> {
    return this.passwords.shift();
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

/**
 * Minimal Ollama stand-in for the flow tests.
 *
 * `postJson` bypasses the proxy (and therefore any `globalThis.fetch` stub)
 * for loopback hosts via a pooled socket, so a stubbed fetch alone would let
 * these tests talk to a real Ollama on 127.0.0.1:11434. A real local server
 * keeps them deterministic and hermetic.
 */
async function startFakeOllama(
  options: { models?: string[]; gpu?: boolean; dimension?: number; embedStatus?: number } = {},
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const models = options.models ?? ["qwen3-embedding:0.6b", "qwen2.5:3b", "minicpm-v4.6:latest"];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      const send = (status: number, body: unknown): void => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      const url = request.url ?? "/";
      const body =
        chunks.length > 0
          ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>)
          : {};
      if (url === "/api/tags") {
        send(200, { models: models.map((name) => ({ name })) });
        return;
      }
      if (url === "/api/show") {
        const id = typeof body.model === "string" ? body.model : "";
        send(200, { capabilities: id.includes("embed") ? ["embedding"] : ["completion", "tools"] });
        return;
      }
      if (url === "/api/ps") {
        send(200, { models: [{ name: models[0], size_vram: options.gpu === false ? 0 : 1024 * 1024 }] });
        return;
      }
      if (url === "/api/embed") {
        if (options.embedStatus !== undefined && options.embedStatus !== 200) {
          send(options.embedStatus, { error: "embed unavailable" });
          return;
        }
        send(200, { embeddings: [new Array(options.dimension ?? 1024).fill(0.1)] });
        return;
      }
      send(404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/api`,
    async close(): Promise<void> {
      destroyAllPooledConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

after(() => {
  // The raw HTTP pool keeps sockets (and the process) alive for 30 s otherwise.
  destroyAllPooledConnections();
});

describe("wizard flow", () => {
  it("walks an Ollama setup with manual model entry and no optional features", async () => {
    // Unreachable Ollama -> the recommended path is skipped, full wizard runs.
    const prompter = new ScriptedPrompter({
      selects: ["__default__"],
      texts: ["http://127.0.0.1:1/api", "my-embed"],
      confirms: [false, false, false, false, true],
    });
    const answers = await runSetupWizard({
      prompter,
      existing: { embedding: { baseUrl: "http://127.0.0.1:1/api" } },
      proxy: undefined,
    });
    assert.ok(answers, "wizard should produce answers");
    assert.equal(answers.embedding.provider, "ollama");
    assert.equal(answers.embedding.model, "my-embed");
    assert.equal(answers.descriptionEnabled, false);
    assert.equal(answers.imageDescriptionEnabled, false);
    assert.equal(answers.decision?.enabled, false);
    assert.equal(answers.embedding.apiKey, undefined);
  });

  it("offers a one-question recommended setup when Ollama is reachable", async () => {
    const ollama = await startFakeOllama({ gpu: true });
    try {
      const prompter = new ScriptedPrompter({ selects: [], texts: [], confirms: [true] });
      const answers = await runSetupWizard({
        prompter,
        existing: { embedding: { baseUrl: ollama.baseUrl } },
        proxy: undefined,
      });
      assert.ok(answers, "recommended setup should produce answers");
      assert.equal(answers.recommended, true);
      assert.equal(answers.embedding.provider, "ollama");
      assert.equal(answers.embedding.model, OLLAMA_GPU_PRESET.embedding, "the GPU backend selects the GPU preset");
      assert.equal(answers.embedding.vectorDimension, 1024, "the probe result is recorded");
      assert.equal(answers.descriptionEnabled, true);
      assert.equal(answers.imageDescriptionEnabled, true);
      assert.equal(answers.decision?.enabled, false, "the preset does not enable the decision model");
    } finally {
      await ollama.close();
    }
  });

  it("keeps a known dimension when the preset target already matches but the probe fails", async () => {
    const ollama = await startFakeOllama({ gpu: true, embedStatus: 500 });
    try {
      const prompter = new ScriptedPrompter({ selects: [], texts: [], confirms: [true] });
      const answers = await runSetupWizard({
        prompter,
        existing: {
          embedding: {
            provider: "ollama",
            baseUrl: ollama.baseUrl,
            model: OLLAMA_GPU_PRESET.embedding,
            vectorDimension: 2048,
          },
        },
        proxy: undefined,
      });
      assert.ok(answers);
      assert.equal(answers.embedding.vectorDimension, 2048);
    } finally {
      await ollama.close();
    }
  });

  it("returns undefined when the user cancels the first question", async () => {
    const prompter = new ScriptedPrompter({ selects: [undefined], texts: [], confirms: [] });
    const answers = await runSetupWizard({
      prompter,
      existing: { embedding: { baseUrl: "http://127.0.0.1:1/api" } },
      proxy: undefined,
    });
    assert.equal(answers, undefined);
  });
});

describe("presets", () => {
  it("selects the GPU preset only for a detected GPU backend", () => {
    assert.equal(presetForBackend("gpu").id, "ollama-gpu");
    assert.equal(presetForBackend("cpu").id, "ollama-cpu");
    assert.equal(presetForBackend("unreachable").id, "ollama-cpu");
    assert.equal(presetForBackend("unknown").id, "ollama-cpu");
  });

  it("marks pulled and missing models", () => {
    const catalog = {
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434/api",
      reachable: true,
      models: [{ id: OLLAMA_CPU_PRESET.embedding, capabilities: ["embedding" as const] }],
    };
    const status = presetModelStatus(OLLAMA_CPU_PRESET, catalog);
    assert.equal(status[0]?.installed, true);
    assert.equal(status[1]?.installed, false);
    const described = describePreset(OLLAMA_CPU_PRESET, catalog);
    assert.ok(described[0]?.includes("installed"));
    assert.ok(described[1]?.includes("will be pulled"));
  });

  it("treats an implicit :latest tag as installed", () => {
    const catalog = {
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434/api",
      reachable: true,
      models: [{ id: "minicpm-v4.6:latest", capabilities: ["vision" as const] }],
    };
    const vision = presetModelStatus(OLLAMA_CPU_PRESET, catalog).find(
      (model) => model.id === OLLAMA_CPU_PRESET.visionModel,
    );
    assert.equal(vision?.installed, true);
  });
});

/** Fake OpenAI-compatible host: `/v1/models` + `/v1/embeddings`. */
async function startFakeOpenAi(options: { models?: string[] } = {}): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const models = options.models ?? ["repaired-model"];
  const server = createServer((request, response) => {
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const url = request.url ?? "";
    if (url.endsWith("/models")) {
      send(200, { data: models.map((id) => ({ id })) });
      return;
    }
    if (url.includes("/embeddings")) {
      send(200, { data: [{ embedding: new Array(8).fill(0.1) }] });
      return;
    }
    send(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Silence the wizard's console output; the test runner parses stdout for its protocol. */
async function withQuietConsole<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("health repair patches", () => {
  it("nests an on-demand repair and clears a stale key", () => {
    assert.deepEqual(
      buildRepairPatch("imageDescription", "onDemand", { provider: "opencode-go", model: "mimo-v2.5" }),
      {
        imageDescription: {
          onDemand: { provider: "opencode-go", model: "mimo-v2.5", apiKey: null },
        },
      },
    );
  });

  it("clears the dimension when the embedding model is replaced", () => {
    assert.deepEqual(buildRepairPatch("embedding", undefined, { provider: "openai", model: "new" }), {
      embedding: { provider: "openai", model: "new", apiKey: null, vectorDimension: null },
    });
  });

  it("repairs a section in the layer that owns it", () => {
    const dir = mkdtempSync(join(tmpdir(), "rag-repair-layer-"));
    try {
      const workspace = join(dir, "workspace.json");
      const global = join(dir, "global.json");
      writeFileSync(workspace, JSON.stringify({ imageDescription: { onDemand: { provider: "opencode-go" } } }));
      writeFileSync(global, JSON.stringify({ embedding: {} }));
      assert.equal(resolveRepairLayer(workspace, global, "imageDescription", "onDemand"), workspace);
      assert.equal(resolveRepairLayer(workspace, global, "embedding"), global);
      assert.equal(resolveRepairLayer(workspace, global, "description"), workspace);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("asks for URL, key and model and writes the repaired section", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rag-repair-flow-"));
    const home = join(dir, "home");
    const project = join(dir, "project");
    const configPath = join(project, ".opencode", "opencode-rag.json");
    const globalPath = join(home, ".config", "opencode", "opencode-rag.json");
    mkdirSync(join(project, ".opencode"), { recursive: true });
    const server = await startFakeOpenAi({ models: ["repaired-model"] });
    const savedHome = process.env.HOME;
    const savedXdg = process.env.XDG_CONFIG_HOME;
    try {
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            embedding: { provider: "openai", baseUrl: server.baseUrl, model: "embed", apiKey: "k" },
            description: {
              enabled: true,
              provider: "openai",
              baseUrl: server.baseUrl,
              model: "old-model",
              apiKey: "old-key",
            },
          },
          null,
          2,
        ),
      );
      process.env.HOME = home;
      process.env.XDG_CONFIG_HOME = join(home, ".config");

      const prompter = new ScriptedPrompter({
        selects: ["__default__", "repaired-model"],
        texts: ["__default__"],
        confirms: [true],
        passwords: ["new-key"],
      });
      const repaired = await withQuietConsole(() => offerHealthRepairs({
        cwd: project,
        workspaceConfigPath: configPath,
        globalConfigPath: globalPath,
        prompter,
        results: [
          {
            provider: "openai",
            model: "old-model",
            type: "description",
            status: "error",
            error: "Invalid API key (HTTP 401)",
          },
        ],
      }));

      assert.equal(repaired, 1);
      const saved = JSON.parse(readFileSync(configPath, "utf-8")) as {
        description: { provider: string; baseUrl: string; model: string; apiKey: string };
      };
      assert.equal(saved.description.provider, "openai");
      assert.equal(saved.description.baseUrl, server.baseUrl);
      assert.equal(saved.description.model, "repaired-model");
      assert.equal(saved.description.apiKey, "new-key");
    } finally {
      process.env.HOME = savedHome;
      process.env.XDG_CONFIG_HOME = savedXdg;
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("offers to remove the on-demand override instead", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rag-repair-ondemand-"));
    const home = join(dir, "home");
    const project = join(dir, "project");
    const configPath = join(project, ".opencode", "opencode-rag.json");
    mkdirSync(join(project, ".opencode"), { recursive: true });
    const savedHome = process.env.HOME;
    const savedXdg = process.env.XDG_CONFIG_HOME;
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          embedding: { provider: "openai", baseUrl: "http://127.0.0.1:1/v1", model: "embed", apiKey: "k" },
          imageDescription: {
            enabled: true,
            provider: "openai",
            baseUrl: "http://127.0.0.1:1/v1",
            model: "vision",
            onDemand: { provider: "opencode-go", model: "mimo-v2.5-free" },
          },
        }),
      );
      process.env.HOME = home;
      process.env.XDG_CONFIG_HOME = join(home, ".config");

      const prompter = new ScriptedPrompter({
        selects: [],
        texts: [],
        confirms: [true, true],
      });
      const repaired = await withQuietConsole(() => offerHealthRepairs({
        cwd: project,
        workspaceConfigPath: configPath,
        globalConfigPath: join(home, ".config", "opencode", "opencode-rag.json"),
        prompter,
        results: [
          {
            provider: "opencode-go",
            model: "mimo-v2.5-free",
            type: "image_description_on_demand",
            status: "error",
            error: "api_key_expired",
          },
        ],
      }));

      assert.equal(repaired, 1);
      const saved = JSON.parse(readFileSync(configPath, "utf-8")) as {
        imageDescription: Record<string, unknown>;
      };
      assert.equal("onDemand" in saved.imageDescription, false);
      assert.equal(saved.imageDescription.model, "vision");
    } finally {
      process.env.HOME = savedHome;
      process.env.XDG_CONFIG_HOME = savedXdg;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
