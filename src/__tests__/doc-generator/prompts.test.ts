import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildGoogleSystemPrompt, buildUserMessageForSymbols } from "../../doc-generator/prompts/google.js";
import type { DocSymbol } from "../../doc-generator/types.js";

describe("buildGoogleSystemPrompt", () => {
  it("returns a system prompt for TypeScript", () => {
    const symbols: DocSymbol[] = [];
    const prompt = buildGoogleSystemPrompt("typescript", symbols);

    assert.ok(prompt.includes("Google JSDoc style guide"));
    assert.ok(prompt.includes("@param"));
    assert.ok(prompt.includes("@returns"));
    assert.ok(prompt.includes("Omit `{type}`"));
    assert.ok(prompt.includes("/**"));
  });

  it("includes language-specific rules for JavaScript", () => {
    const symbols: DocSymbol[] = [];
    const prompt = buildGoogleSystemPrompt("javascript", symbols);

    assert.ok(prompt.includes("include `{type}`"));
  });

  it("includes language-specific rules for Python", () => {
    const symbols: DocSymbol[] = [];
    const prompt = buildGoogleSystemPrompt("python", symbols);

    assert.ok(prompt.includes("@raises"));
  });

  it("includes language-specific rules for Go", () => {
    const symbols: DocSymbol[] = [];
    const prompt = buildGoogleSystemPrompt("go", symbols);

    assert.ok(prompt.includes("// Comment"));
  });

  it("includes language-specific rules for Rust", () => {
    const symbols: DocSymbol[] = [];
    const prompt = buildGoogleSystemPrompt("rust", symbols);

    assert.ok(prompt.includes("///"));
  });

  it("includes language-specific rules for PHP", () => {
    const symbols: DocSymbol[] = [];
    const prompt = buildGoogleSystemPrompt("php", symbols);

    assert.ok(prompt.includes("`$` prefix"));
  });

  it("includes output format instructions", () => {
    const symbols: DocSymbol[] = [];
    const prompt = buildGoogleSystemPrompt("typescript", symbols);

    assert.ok(prompt.includes("`/** ... */`"));
    assert.ok(prompt.includes("Do NOT output the symbol code"));
  });
});

describe("buildUserMessageForSymbols", () => {
  it("includes file path and language in the message", () => {
    const symbols: DocSymbol[] = [
      {
        name: "hello",
        kind: "function",
        startLine: 1,
        endLine: 3,
        hasExistingDoc: false,
        signature: "function hello(): void { return; }",
      },
    ];

    const message = buildUserMessageForSymbols(
      "src/index.ts",
      "typescript",
      symbols,
      "function hello(): void { return; }\n",
    );

    assert.ok(message.includes("src/index.ts"));
    assert.ok(message.includes("typescript"));
    assert.ok(message.includes("hello"));
    assert.ok(message.includes("function"));
  });

  it("lists multiple symbols", () => {
    const symbols: DocSymbol[] = [
      {
        name: "Foo",
        kind: "class",
        startLine: 1,
        endLine: 10,
        hasExistingDoc: false,
        signature: "class Foo { }",
      },
      {
        name: "bar",
        kind: "method",
        startLine: 3,
        endLine: 8,
        hasExistingDoc: false,
        signature: "bar(): void { }",
      },
    ];

    const message = buildUserMessageForSymbols("test.ts", "typescript", symbols, "");

    assert.ok(message.includes("Symbol 1"));
    assert.ok(message.includes("Symbol 2"));
    assert.ok(message.includes("Foo"));
    assert.ok(message.includes("bar"));
  });

  it("includes full file content for context", () => {
    const symbols: DocSymbol[] = [
      {
        name: "x",
        kind: "function",
        startLine: 1,
        endLine: 1,
        hasExistingDoc: false,
        signature: "function x() {}",
      },
    ];

    const content = "function x() {}\nfunction y() {}\n";
    const message = buildUserMessageForSymbols("test.ts", "typescript", symbols, content);

    assert.ok(message.includes("function y() {}"));
  });

  it("handles empty symbols array", () => {
    const message = buildUserMessageForSymbols("empty.ts", "typescript", [], "");

    assert.ok(message.includes("empty.ts"));
    assert.ok(message.includes("typescript"));
  });
});
