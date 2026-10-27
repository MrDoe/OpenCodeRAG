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

  it("descends into matched declarations for a member-level outline", async () => {
    // The chunker intentionally stops at the first matched declaration so one
    // declaration stays one chunk; the skeleton must descend so members are
    // reported. Regression: C# files used to collapse to a single class line.
    const source = [
      "public class Example",
      "{",
      "  public Example() {}",
      "  public void Run() {}",
      "  public string Name { get; set; }",
      "  private int _count;",
      "}",
    ].join("\n");
    const items = await extractSkeleton(source, ".cs");
    assert.ok(
      items.some((i) => i.type === "class_declaration"),
      `expected the class, got: ${JSON.stringify(items)}`,
    );
    assert.ok(
      items.some((i) => i.type === "constructor_declaration"),
      `expected the constructor, got: ${JSON.stringify(items)}`,
    );
    assert.ok(
      items.some((i) => i.type === "method_declaration"),
      `expected the method, got: ${JSON.stringify(items)}`,
    );
    assert.ok(
      items.some((i) => i.type === "property_declaration"),
      `expected the property, got: ${JSON.stringify(items)}`,
    );
    assert.equal(
      items.some((i) => i.type === "field_declaration"),
      false,
      "fields are intentionally excluded from the outline",
    );
  });

  it("includes C# contract members but excludes data members", () => {
    const types = SKELETON_CONFIGS[".cs"]!.nodeTypes;
    for (const type of [
      "property_declaration",
      "record_declaration",
      "delegate_declaration",
      "event_field_declaration",
      "event_declaration",
      "indexer_declaration",
      "operator_declaration",
      "conversion_operator_declaration",
      "destructor_declaration",
      "constructor_declaration",
    ]) {
      assert.ok(types.includes(type), `expected ${type} in the .cs recipe`);
    }
    for (const type of [
      "field_declaration",
      "enum_member_declaration",
      "using_directive",
      "namespace_declaration",
      "accessor_declaration",
      "local_function_statement",
    ]) {
      assert.equal(types.includes(type), false, `did not expect ${type} in the .cs recipe`);
    }
  });

  it("filters callables nested inside another callable", async () => {
    const source = [
      "export function App() {",
      "  return <div onClick={() => alert(1)}>{[1].map((x) => <b>{x}</b>)}</div>;",
      "}",
    ].join("\n");
    const items = await extractSkeleton(source, ".jsx");
    assert.ok(items.some((i) => i.type === "function_declaration"));
    assert.equal(
      items.some((i) => i.type === "arrow_function"),
      false,
      `callbacks are not outline members, got: ${JSON.stringify(items)}`,
    );
  });

  it("keeps members of a type nested inside a callable", async () => {
    const source = [
      "function make() {",
      "  class Local {",
      "    run() {}",
      "  }",
      "  return Local;",
      "}",
    ].join("\n");
    const items = await extractSkeleton(source, ".js");
    assert.ok(items.some((i) => i.type === "class_declaration"));
    assert.ok(items.some((i) => i.type === "method_definition"));
  });

  it("keeps a top-level arrow function and type members", async () => {
    const arrow = await extractSkeleton("export const App = () => 1;\n", ".jsx");
    assert.ok(arrow.some((i) => i.type === "arrow_function"));
    const cls = await extractSkeleton("class Example {\n  run() {}\n}\n", ".js");
    assert.ok(cls.some((i) => i.type === "method_definition"));
  });

  it("reports Python decorated definitions through the inner definition", async () => {
    const items = await extractSkeleton("@decorator\ndef foo():\n    pass\n", ".py");
    assert.equal(items.some((i) => i.type === "decorated_definition"), false);
    assert.equal(items.filter((i) => i.type === "function_definition").length, 1);
  });

  it("reports Go type specs and aliases without the declaration wrapper", async () => {
    const items = await extractSkeleton("type Foo struct{}\ntype Bar = int\n", ".go");
    assert.equal(items.some((i) => i.type === "type_declaration"), false);
    assert.equal(items.filter((i) => i.type === "type_spec").length, 1);
    assert.equal(items.filter((i) => i.type === "type_alias").length, 1);
  });

  it("descends into class members for non-C# languages", async () => {
    const source = "class Example {\n  run() {}\n}\n";
    const items = await extractSkeleton(source, ".ts");
    assert.ok(items.some((i) => i.type === "class_declaration"));
    assert.ok(items.some((i) => i.type === "method_definition"));
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

  it("keeps the extension's own recipe when the override names its existing parser", async () => {
    // ".tsx" already uses the TypeScript parser, so overriding it with
    // "typescript" changes nothing — and must not drop the .tsx-specific
    // arrow_function node type in favour of the first typescript recipe.
    const source = "const App = () => 1;\n";
    const items = await extractSkeleton(source, ".tsx", {
      languageByExtension: { ".tsx": "typescript" },
    });
    assert.ok(
      items.some((i) => i.type === "arrow_function"),
      `expected the .tsx recipe to be preserved, got: ${JSON.stringify(items)}`,
    );
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
