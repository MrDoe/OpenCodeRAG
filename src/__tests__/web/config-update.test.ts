import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleConfigUpdate } from "../../web/api.js";
import { DEFAULT_CONFIG, type RagConfig } from "../../core/config.js";

describe("PUT /api/config — chunking section", () => {
  let dir: string;
  let configPath: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "rag-web-config-"));
    configPath = join(dir, "opencode-rag.json");
    writeFileSync(configPath, JSON.stringify({ indexing: { includeDirs: [] } }), "utf-8");
  });

  after(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function call(body: unknown): { status: number; body: Record<string, unknown> } {
    const configRef: { current?: RagConfig } = { current: { ...DEFAULT_CONFIG } };
    const res = handleConfigUpdate(configPath, configRef, body);
    return { status: res.status, body: res.body as Record<string, unknown> };
  }

  it("accepts a chunking.parsers map and writes it to the config file", () => {
    const res = call({ chunking: { parsers: { ".c": "cpp", ".cu": "cpp" } } });
    assert.equal(res.status, 200, `expected 200, got: ${JSON.stringify(res.body)}`);

    const written = JSON.parse(readFileSync(configPath, "utf-8")) as {
      chunking?: { parsers?: Record<string, string> };
    };
    assert.deepStrictEqual(written.chunking?.parsers, { ".c": "cpp", ".cu": "cpp" });
  });

  it("accepts a chunking.nodeTypes map", () => {
    const res = call({ chunking: { nodeTypes: { cpp: ["function_definition"] } } });
    assert.equal(res.status, 200, `expected 200, got: ${JSON.stringify(res.body)}`);

    const written = JSON.parse(readFileSync(configPath, "utf-8")) as {
      chunking?: { nodeTypes?: Record<string, string[]> };
    };
    assert.deepStrictEqual(written.chunking?.nodeTypes, { cpp: ["function_definition"] });
  });

  it("rejects a parsers value that is not a string map", () => {
    const res = call({ chunking: { parsers: { ".c": 42 } } });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /chunking\.parsers/);
  });

  it("rejects a parsers value that is an array", () => {
    const res = call({ chunking: { parsers: ["cpp"] } });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /chunking\.parsers/);
  });

  it("rejects a nodeTypes value that is not an array of strings", () => {
    const res = call({ chunking: { nodeTypes: { cpp: "function_definition" } } });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /chunking\.nodeTypes/);
  });

  it("rejects unknown chunking keys", () => {
    const res = call({ chunking: { nonsense: {} } });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /Unsupported chunking key/);
  });

  it("still rejects unknown top-level sections", () => {
    const res = call({ embedding: { model: "x" } });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /Unsupported config section/);
  });
});
