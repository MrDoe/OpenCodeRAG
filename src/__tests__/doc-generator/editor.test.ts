import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocSymbol } from "../../doc-generator/types.js";
import { applyDocComments } from "../../doc-generator/editor.js";

describe("applyDocComments", () => {
  let tmpDir: string;
  let testFile: string;

  before(() => {
    tmpDir = join(tmpdir(), `opencode-rag-doc-test-${Date.now()}`);
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    testFile = join(tmpDir, "test.ts");
  });

  after(() => {
    try { unlinkSync(testFile); } catch { /* ignore */ }
    try { unlinkSync(join(tmpDir, "doc-mode-progress.json")); } catch { /* ignore */ }
  });

  it("inserts doc comment before a function declaration", () => {
    const content = [
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
    ].join("\n");

    writeFileSync(testFile, content, "utf-8");

    const symbols: DocSymbol[] = [
      {
        name: "add",
        kind: "function",
        startLine: 1,
        endLine: 3,
        hasExistingDoc: false,
        signature: "export function add(a: number, b: number): number { ... }",
      },
    ];

    const docBlocks = [
      "/**\n * Adds two numbers together.\n *\n * @param a - The first number.\n * @param b - The second number.\n * @returns The sum of a and b.\n */",
    ];

    const result = applyDocComments(testFile, content, symbols, docBlocks, tmpDir, true);

    assert.equal(result.editsApplied, 1);
    assert.ok(result.modifiedContent.includes("Adds two numbers together."));
    assert.ok(result.modifiedContent.includes("@param a - The first number."));
    assert.ok(result.modifiedContent.includes("@returns The sum of a and b."));
    assert.ok(result.modifiedContent.includes("export function add"));
  });

  it("skips symbols that already have doc comments", () => {
    const content = [
      "/** Existing doc. */",
      "export function existing(): void {",
      "  return;",
      "}",
    ].join("\n");

    const symbols: DocSymbol[] = [
      {
        name: "existing",
        kind: "function",
        startLine: 2,
        endLine: 4,
        hasExistingDoc: true,
        signature: "export function existing(): void { ... }",
      },
    ];

    const result = applyDocComments(testFile, content, symbols, [], tmpDir, true);
    assert.equal(result.editsApplied, 0);
  });

  it("applies multiple doc comments for multiple symbols", () => {
    const content = [
      "export class Calculator {",
      "  add(a: number, b: number): number {",
      "    return a + b;",
      "  }",
      "  subtract(a: number, b: number): number {",
      "    return a - b;",
      "  }",
      "}",
    ].join("\n");

    const symbols: DocSymbol[] = [
      {
        name: "Calculator",
        kind: "class",
        startLine: 1,
        endLine: 8,
        hasExistingDoc: false,
        signature: "export class Calculator { ... }",
      },
      {
        name: "add",
        kind: "method",
        startLine: 2,
        endLine: 4,
        hasExistingDoc: false,
        signature: "add(a: number, b: number): number { ... }",
      },
      {
        name: "subtract",
        kind: "method",
        startLine: 5,
        endLine: 7,
        hasExistingDoc: false,
        signature: "subtract(a: number, b: number): number { ... }",
      },
    ];

    const docBlocks = [
      "/** A calculator class. */",
      "/** Adds two numbers. */",
      "/** Subtracts two numbers. */",
    ];

    const result = applyDocComments(testFile, content, symbols, docBlocks, tmpDir, true);

    assert.equal(result.editsApplied, 3);
    assert.ok(result.modifiedContent.includes("A calculator class."));
    assert.ok(result.modifiedContent.includes("Adds two numbers."));
    assert.ok(result.modifiedContent.includes("Subtracts two numbers."));
  });

  it("writes changes to disk when not in dry-run mode", () => {
    const content = "export function test(): void { return; }\n";
    writeFileSync(testFile, content, "utf-8");

    const symbols: DocSymbol[] = [
      {
        name: "test",
        kind: "function",
        startLine: 1,
        endLine: 1,
        hasExistingDoc: false,
        signature: "export function test(): void { return; }",
      },
    ];

    const docBlocks = ["/** Test function. */"];
    applyDocComments(testFile, content, symbols, docBlocks, tmpDir, false);

    const written = readFileSync(testFile, "utf-8");
    assert.ok(written.includes("Test function."));
  });

  it("handles empty doc blocks gracefully", () => {
    const content = "export function foo(): void {}\n";
    const symbols: DocSymbol[] = [
      {
        name: "foo",
        kind: "function",
        startLine: 1,
        endLine: 1,
        hasExistingDoc: false,
        signature: "export function foo(): void {}",
      },
    ];

    const result = applyDocComments(testFile, content, symbols, [], tmpDir, true);
    assert.equal(result.editsApplied, 0);
  });
});
