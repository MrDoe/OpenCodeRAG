import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractSkeleton, SKELETON_CONFIGS } from "../../chunker/skeleton.js";

const CPP_SOURCE = [
  "int add(int a, int b) {",
  "  return a + b;",
  "}",
  "",
].join("\n");

describe("extractSkeleton", () => {
  it("uses the default recipe for known extensions", async () => {
    const items = await extractSkeleton(CPP_SOURCE, ".cpp");
    assert.ok(
      items.some((i) => i.type === "function_definition"),
      `expected a function_definition, got: ${JSON.stringify(items)}`,
    );
  });

  it("keeps per-extension recipes that differ (.tsx includes arrow functions)", async () => {
    const source = "const App = () => 1;\n";
    const tsxItems = await extractSkeleton(source, ".tsx");
    const tsItems = await extractSkeleton(source, ".ts");
    assert.ok(
      tsxItems.some((i) => i.type === "arrow_function"),
      `expected an arrow_function for .tsx, got: ${JSON.stringify(tsxItems)}`,
    );
    assert.equal(
      tsItems.some((i) => i.type === "arrow_function"),
      false,
      ".ts must keep its own recipe (no arrow_function)",
    );
    assert.equal(SKELETON_CONFIGS[".tsx"]!.nodeTypes.includes("arrow_function"), true);
    assert.equal(SKELETON_CONFIGS[".ts"]!.nodeTypes.includes("arrow_function"), false);
  });

  it("falls back to a line count for extensions without a recipe", async () => {
    const items = await extractSkeleton(CPP_SOURCE, ".cu");
    assert.equal(items.length, 1);
    assert.equal(items[0]!.type, "file");
    assert.match(items[0]!.name, /lines$/);
  });

  it("resolves an overridden extension to the target parser's recipe", async () => {
    const items = await extractSkeleton(CPP_SOURCE, ".cu", {
      languageByExtension: { ".cu": "cpp" },
    });
    assert.ok(
      items.some((i) => i.type === "function_definition"),
      `expected the cpp recipe for .cu, got: ${JSON.stringify(items)}`,
    );
  });

  it("resolves an overridden built-in mapping (.c → cpp) to the cpp recipe", async () => {
    const source = "namespace util {\nint add(int a, int b) { return a + b; }\n}\n";
    const asC = await extractSkeleton(source, ".c");
    const asCpp = await extractSkeleton(source, ".c", { languageByExtension: { ".c": "cpp" } });
    // `namespace` is C++-only: the C grammar cannot produce a definition for it,
    // while the cpp recipe reports the enclosing function.
    assert.notDeepEqual(asCpp, asC);
    assert.ok(asCpp.some((i) => i.type === "function_definition"));
  });

  it("does not use the extension's own recipe when the target parser has none", async () => {
    const source = "const App = () => 1;\n";
    const items = await extractSkeleton(source, ".tsx", { languageByExtension: { ".tsx": "text" } });
    assert.equal(items.length, 1);
    assert.equal(items[0]!.type, "file", "target parser without a recipe must fall back to line count");
  });

  it("warns and keeps the default recipe for an unknown target parser", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => { warnings.push(msg); };
    try {
      const items = await extractSkeleton("const App = () => 1;\n", ".tsx", {
        languageByExtension: { ".tsx": "unknown-parser" },
      });
      assert.ok(items.some((i) => i.type === "arrow_function"), "default recipe should be preserved");
      assert.ok(
        warnings.some((w) => w.includes("unknown-parser")),
        `expected unknown-parser warning, got: ${JSON.stringify(warnings)}`,
      );
    } finally {
      console.warn = origWarn;
    }
  });
});
