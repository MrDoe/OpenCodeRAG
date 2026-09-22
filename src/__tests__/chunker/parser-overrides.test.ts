import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chunkFile,
  getChunker,
  getExtensionsForLanguage,
  getRegisteredLanguages,
  validateParserOverrides,
} from "../../chunker/factory.js";
import {
  normalizeExtensionKey,
  normalizeParserOverrides,
} from "../../core/parser-overrides.js";

describe("normalizeExtensionKey", () => {
  it("lowercases and adds a leading dot", () => {
    assert.equal(normalizeExtensionKey("CXX"), ".cxx");
    assert.equal(normalizeExtensionKey(".Cu"), ".cu");
    assert.equal(normalizeExtensionKey("  cxx  "), ".cxx");
  });

  it("rejects unusable keys", () => {
    assert.equal(normalizeExtensionKey(""), "");
    assert.equal(normalizeExtensionKey("   "), "");
    assert.equal(normalizeExtensionKey("src/nested"), "");
    assert.equal(normalizeExtensionKey(42), "");
  });
});

describe("normalizeParserOverrides", () => {
  it("returns {} for missing or malformed maps", () => {
    assert.deepStrictEqual(normalizeParserOverrides(undefined), {});
    assert.deepStrictEqual(normalizeParserOverrides([] as never), {});
    assert.deepStrictEqual(normalizeParserOverrides(null as never), {});
  });

  it("normalizes keys and values, dropping invalid entries", () => {
    assert.deepStrictEqual(
      normalizeParserOverrides({ CXX: "CPP", ".cu": " cpp ", ".bad": "", "a/b": "cpp", ".num": 7 as never }),
      { ".cxx": "cpp", ".cu": "cpp" },
    );
  });
});

describe("chunking.parsers overrides", () => {
  it("maps a brand-new extension to an existing parser", () => {
    const chunker = getChunker("kernel.cu", { ".cu": "cpp" });
    assert.equal(chunker.language, "cpp");
  });

  it("overrides an existing built-in mapping (.c → cpp)", () => {
    assert.equal(getChunker("main.c").language, "c");
    assert.equal(getChunker("main.c", { ".c": "cpp" }).language, "cpp");
  });

  it("normalizes keys without a leading dot and mixed case", () => {
    assert.equal(getChunker("kernel.cu", { CU: "CPP" }).language, "cpp");
  });

  it("keeps default behavior for unlisted extensions", () => {
    assert.equal(getChunker("main.c", { ".cu": "cpp" }).language, "c");
    assert.equal(getChunker("app.ts", { ".cu": "cpp" }).language, "typescript");
  });

  it("falls back to the default mapping when the target parser is unknown", () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => { warnings.push(msg); };
    try {
      const chunker = getChunker("odd.zzz", { ".zzz": "no-such-parser" });
      assert.equal(chunker.language, "text", "unknown target must fall back to the default mapping");
      assert.ok(
        warnings.some((w) => w.includes("no-such-parser")),
        `expected unknown-parser warning, got: ${JSON.stringify(warnings)}`,
      );
    } finally {
      console.warn = origWarn;
    }
  });

  it("does not mutate the process-wide registry", () => {
    getChunker("x.cu", { ".cu": "cpp" });
    assert.equal(getChunker("x.cu").language, "text", "overrides must not leak without a config map");
  });

  it("chunks with the overridden parser", async () => {
    const source = "int add(int a, int b) {\n  return a + b;\n}\n";
    const chunks = await chunkFile("kernel.cu", source, undefined, {
      languageByExtension: { ".cu": "cpp" },
    });
    assert.ok(chunks.length > 0, "expected chunks from the C++ parser");
    for (const chunk of chunks) {
      assert.equal(chunk.metadata.language, "cpp");
    }
  });

  it("uses nodeTypes overrides of the target parser language", async () => {
    const source = "struct Point { int x; };\nint make() {\n  return 1;\n}\n";
    const chunks = await chunkFile("kernel.cu", source, { cpp: ["struct_specifier"] }, {
      languageByExtension: { ".cu": "cpp" },
    });
    assert.ok(chunks.length > 0);
    assert.ok(
      chunks.every((c) => c.content.trim().startsWith("struct Point")),
      `expected only struct chunks, got: ${chunks.map((c) => c.content.slice(0, 20)).join(" | ")}`,
    );
  });
});

describe("parser registry introspection", () => {
  it("lists registered parser languages", () => {
    const languages = getRegisteredLanguages();
    for (const expected of ["cpp", "c", "typescript", "text"]) {
      assert.ok(languages.includes(expected), `expected "${expected}" in ${languages.join(", ")}`);
    }
  });

  it("maps a language back to its extensions", () => {
    const extensions = getExtensionsForLanguage("cpp");
    assert.ok(extensions.includes(".cpp"), `expected .cpp in ${extensions.join(", ")}`);
    assert.deepEqual(getExtensionsForLanguage("no-such-parser"), []);
  });
});

describe("validateParserOverrides", () => {
  it("returns no warnings for a valid or absent map", () => {
    assert.deepStrictEqual(validateParserOverrides(undefined), []);
    assert.deepStrictEqual(validateParserOverrides({ ".c": "cpp" }), []);
  });

  it("warns about unknown parsers, bad keys, and empty values", () => {
    const warnings = validateParserOverrides({
      ".cu": "cuda",
      "src/x": "cpp",
      ".bad": "",
      ".ok": 42 as never,
    });
    assert.equal(warnings.length, 4, `expected 4 warnings, got: ${JSON.stringify(warnings)}`);
    assert.ok(warnings.some((w) => w.includes('".cu"') && w.includes("cuda")));
    assert.ok(warnings.some((w) => w.includes("not a valid file extension")));
    assert.ok(warnings.some((w) => w.includes('".bad"')));
    assert.ok(warnings.some((w) => w.includes('".ok"')));
  });

  it("rejects a non-object parsers value", () => {
    const warnings = validateParserOverrides([] as never);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]!.includes("must be an object"));
  });
});
