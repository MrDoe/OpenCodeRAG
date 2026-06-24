import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractLeadingComment } from "../../doc-generator/parser.js";

describe("extractLeadingComment", () => {
  it("detects multi-line /** ... */ before a class declaration", () => {
    const content = [
      "/**",
      " * Terminal-based progress reporter.",
      " * Renders a live-updating table.",
      " */",
      "export class ProgressTable {}",
    ].join("\n");

    const classIndex = content.indexOf("export class");
    assert.notEqual(classIndex, -1);

    const result = extractLeadingComment(content, classIndex);
    assert.notEqual(result, null);
    assert.ok(result!.includes("Terminal-based progress reporter."));
    assert.ok(result!.includes("* Renders a live-updating table."));
  });

  it("detects multi-line /** ... */ via export class wrapper (regression test)", () => {
    // This mimics the user's exact scenario: an early comment block exists
    // at the source level but tree-sitter's previousSibling would miss it
    // because class_declaration is nested inside export_statement.
    const content = [
      "/**",
      " * Existing documentation for this class.",
      " * It describes what the class does and why.",
      " */",
      "export class MyClass {",
      "  doStuff(): void {}",
      "}",
    ].join("\n");

    const classIndex = content.indexOf("export class");
    const result = extractLeadingComment(content, classIndex);
    assert.notEqual(result, null);
    assert.ok(result!.includes("Existing documentation for this class."));
  });

  it("detects single-line /** foo */ before a function", () => {
    const content = [
      "/** Adds two numbers. */",
      "function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
    ].join("\n");

    const fnIndex = content.indexOf("function add");
    const result = extractLeadingComment(content, fnIndex);
    assert.notEqual(result, null);
    assert.ok(result!.includes("Adds two numbers."));
  });

  it("detects // line comment before a function", () => {
    const content = [
      "// Helper function to compute the sum.",
      "function sum(arr: number[]): number {",
      "  return arr.reduce((a, b) => a + b, 0);",
      "}",
    ].join("\n");

    const fnIndex = content.indexOf("function sum");
    const result = extractLeadingComment(content, fnIndex);
    assert.notEqual(result, null);
    assert.ok(result!.includes("Helper function to compute the sum."));
  });

  it("detects multiple consecutive // comments", () => {
    const content = [
      "// Copyright 2024",
      "// License: MIT",
      "function helper(): void {}",
    ].join("\n");

    const fnIndex = content.indexOf("function helper");
    const result = extractLeadingComment(content, fnIndex);
    assert.notEqual(result, null);
    assert.ok(result!.includes("Copyright 2024"));
    assert.ok(result!.includes("License: MIT"));
  });

  it("returns null when no comment precedes the symbol", () => {
    const content = [
      "const x = 1;",
      "function foo(): void {}",
    ].join("\n");

    const fnIndex = content.indexOf("function foo");
    const result = extractLeadingComment(content, fnIndex);
    assert.equal(result, null);
  });

  it("detects # comment (Python style) before a function", () => {
    const content = [
      "# This function computes the result.",
      "def compute(x: int) -> int:",
      "    return x * 2",
    ].join("\n");

    const fnIndex = content.indexOf("def compute");
    const result = extractLeadingComment(content, fnIndex);
    assert.notEqual(result, null);
    assert.ok(result!.includes("This function computes the result."));
  });

  it("detects comment even with blank lines between comment and symbol", () => {
    const content = [
      "/** Doc string */",
      "",
      "export function test(): void {}",
    ].join("\n");

    const fnIndex = content.indexOf("export function");
    const result = extractLeadingComment(content, fnIndex);
    assert.notEqual(result, null);
    assert.ok(result!.includes("Doc string"));
  });

  it("returns null when non-comment code separates comment from symbol", () => {
    const content = [
      "/** This is for something else */",
      "const MIDDLE = 42;",
      "function target(): void {}",
    ].join("\n");

    const fnIndex = content.indexOf("function target");
    const result = extractLeadingComment(content, fnIndex);
    assert.equal(result, null);
  });

  it("detects doc comment on the very first line of file", () => {
    const content = [
      "/** First line doc */",
      "function foo(): void {}",
    ].join("\n");

    const fnIndex = content.indexOf("function foo");
    const result = extractLeadingComment(content, fnIndex);
    assert.notEqual(result, null);
  });

  it("detects /// doc comment (Rust style) before a function", () => {
    const content = [
      "/// Does a thing.",
      "/// Returns the result.",
      "fn do_thing() -> i32 {",
      "    42",
      "}",
    ].join("\n");

    const fnIndex = content.indexOf("fn do_thing");
    const result = extractLeadingComment(content, fnIndex);
    assert.notEqual(result, null);
    assert.ok(result!.includes("Does a thing."));
    assert.ok(result!.includes("Returns the result."));
  });
});
