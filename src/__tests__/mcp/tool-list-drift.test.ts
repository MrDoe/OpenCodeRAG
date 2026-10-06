/**
 * @fileoverview Drift test: the tools the real MCP server serves must match the tool
 * lists published in README.md, the injected system guidance, the generated skill files,
 * and the plugin's tool registrations.
 *
 * Motivated by the XERJ postmortem: a hand-written published tool list drifted from the
 * binary (6 advertised vs 10 served) because nothing compared them. This test boots the
 * real server over an in-memory transport with an injected context and pins every
 * documented list to it — adding, renaming, or dropping a tool fails here until the docs
 * are updated with it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { EmbeddingProvider, VectorStore } from "../../core/interfaces.js";
import { DEFAULT_CONFIG, type RagConfig } from "../../core/config.js";
import type { RagContext } from "../../core/bootstrap.js";
import { KeywordIndex } from "../../retriever/keyword-index.js";
import { createMcpServer } from "../../mcp/server.js";
import { buildSystemGuidanceLines } from "../../opencode/system-guidance.js";
import { generateDecisionSkillFile, generateSkillFile } from "../../cli/commands/init-helpers.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Tools served by the MCP server — the pinned contract every doc list must match. */
const EXPECTED_MCP_TOOLS = [
  "describe_image",
  "find_usages",
  "get_file_skeleton",
  "make_decision",
  "search_semantic",
];

/** Tools the OpenCode plugin registers on top of the MCP set (plugin-only today). */
const EXPECTED_PLUGIN_ONLY_TOOLS = ["add_quirk", "delete_quirk", "recall_quirks", "update_quirk"];

function emptyStore(): VectorStore {
  return {
    addChunks: async () => {},
    search: async () => [],
    async searchWithFilter(embedding: number[], topK: number) {
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

function testContext(storePath: string): RagContext {
  const config = structuredClone(DEFAULT_CONFIG) as RagConfig;
  config.decision = {
    enabled: true,
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434/api",
    model: "tev1:0.8b",
    timeoutMs: 1000,
  };
  const embedder: EmbeddingProvider = { name: "drift-test", embed: async () => [] };
  return {
    config,
    embedder,
    store: emptyStore(),
    storePath,
    keywordIndex: new KeywordIndex(storePath),
    dimension: 384,
    logFilePath: join(storePath, "drift-test.log"),
  };
}

function readRepoFile(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf-8");
}

/** Collect the tool names from the first table column after a heading (until the next heading). */
function toolNamesInSection(markdown: string, heading: string): string[] {
  const after = markdown.split(heading)[1];
  if (!after) return [];
  const section = after.split(/\r?\n#{2,3} /)[0] ?? "";
  return [...section.matchAll(/^\|\s*`([a-z_]+)`/gm)].map((m) => m[1]!).sort();
}

describe("tool list drift", () => {
  it("serves exactly the documented MCP tools", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rag-tool-drift-"));
    const storePath = join(tmpDir, "db");
    mkdirSync(storePath, { recursive: true });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const instance = await createMcpServer({ context: testContext(storePath), transport: serverTransport });
    const client = new Client({ name: "tool-drift-test", version: "0.0.0" });
    try {
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      const live = tools.map((tool) => tool.name).sort();
      assert.deepEqual(live, [...EXPECTED_MCP_TOOLS].sort(), "live MCP tools must equal EXPECTED_MCP_TOOLS");
    } finally {
      await client.close().catch(() => {});
      await instance.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("documents every plugin-registered tool in README, guidance, and skill files", () => {
    const pluginTools = [...EXPECTED_MCP_TOOLS, ...EXPECTED_PLUGIN_ONLY_TOOLS].sort();
    const readme = readRepoFile("ReadMe.md");

    // The README MCP table must match the live MCP set exactly — no stale names.
    assert.deepEqual(
      toolNamesInSection(readme, "### MCP Tools"),
      [...EXPECTED_MCP_TOOLS].sort(),
      "README '### MCP Tools' table must list exactly the served MCP tools",
    );

    // The README must document every plugin tool as a table row (plugin tools live in
    // different sections — core tools in "Available Tools", quirk tools in "Quirk Memory").
    const documentedInTable = (name: string): boolean =>
      new RegExp("^\\|\\s*`" + name + "\\b", "m").test(readme);
    for (const name of pluginTools) {
      assert.ok(documentedInTable(name), `README must document ${name} in a tool table`);
    }

    // The injected guidance must mention the plugin tool set exactly — mentions are
    // `` `tool_name(` `` call shapes, so a stale name cannot hide in prose.
    const guidance = buildSystemGuidanceLines({
      promptEnforcement: true,
      decisionEnabled: true,
      routeBeforeAsking: false,
    }).join("\n");
    const mentioned = [...new Set([...guidance.matchAll(/`([a-z_]+)\(/g)].map((m) => m[1]!))].sort();
    assert.deepEqual(mentioned, pluginTools, "system guidance tool mentions must equal the plugin tool set");

    // Skill files must document the tools they cover.
    const skill = generateSkillFile();
    for (const name of [...EXPECTED_MCP_TOOLS.filter((n) => n !== "make_decision"), ...EXPECTED_PLUGIN_ONLY_TOOLS]) {
      assert.ok(skill.includes(`\`${name}\``), `skills/opencode-rag/SKILL.md must mention ${name}`);
    }
    assert.ok(
      generateDecisionSkillFile().includes("`make_decision`"),
      "skills/make-decision/SKILL.md must mention make_decision",
    );
  });

  it("registers every documented tool in the plugin source", () => {
    const source = readRepoFile("src/plugin.ts");
    for (const name of [...EXPECTED_MCP_TOOLS, ...EXPECTED_PLUGIN_ONLY_TOOLS]) {
      if (name === "search_semantic") {
        assert.ok(
          source.includes("[CONTEXT_TOOL_NAME]:"),
          "plugin.ts must register search_semantic under CONTEXT_TOOL_NAME",
        );
        continue;
      }
      assert.ok(source.includes(`tools["${name}"]`), `plugin.ts must register ${name}`);
    }
  });
});
