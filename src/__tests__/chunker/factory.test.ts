import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getChunker, chunkFile } from "../../chunker/factory.js";

describe("getChunker", () => {
  const cases: [string, string][] = [
    ["src/app.ts", "typescript"],
    ["src/Component.tsx", "typescript"],
    ["readme.md", "markdown"],
    ["main.py", "python"],
    ["Main.java", "java"],
    ["main.go", "go"],
    ["script.sh", "bash"],
    ["index.php", "php"],
    ["script.ps1", "powershell"],
    ["module.psm1", "powershell"],
    ["config.ini", "ini"],
    ["config.cfg", "ini"],
    ["config.yaml", "yaml"],
    ["config.yml", "yaml"],
    ["config.toml", "toml"],
    ["query.sql", "sql"],
    ["Dockerfile", "dockerfile"],
    ["Containerfile", "dockerfile"],
    ["main.c", "c"],
    ["header.h", "c"],
    ["main.cpp", "cpp"],
    ["main.cc", "cpp"],
    ["Program.cs", "csharp"],
    ["app.js", "javascript"],
    ["Component.jsx", "javascript"],
    ["module.mjs", "javascript"],
    ["Component.razor", "razor"],
    ["view.cshtml", "razor"],
    ["package.json", "json"],
    ["index.html", "html"],
    ["page.htm", "html"],
    ["styles.css", "css"],
    ["MyProject.csproj", "xml"],
    ["config.xml", "xml"],
    ["icon.svg", "xml"],
    ["MySolution.sln", "sln"],
    ["main.rs", "rust"],
    ["app.rb", "ruby"],
    ["main.kt", "kotlin"],
    ["script.kts", "kotlin"],
    ["main.swift", "swift"],
    ["script.ssl", "ssl"],
  ];

  it("returns the correct chunker for each file extension", () => {
    for (const [filePath, expectedLanguage] of cases) {
      const chunker = getChunker(filePath);
      assert.equal(
        chunker.language,
        expectedLanguage,
        `Expected "${filePath}" to map to "${expectedLanguage}", got "${chunker.language}"`,
      );
    }
  });

  it("returns fallback chunker for unknown extensions", () => {
    const chunker = getChunker("script.xyz");
    assert.equal(chunker.language, "text");
  });

  it("returns fallback chunker for files without extension", () => {
    const chunker = getChunker("Makefile");
    assert.equal(chunker.language, "text");
  });

  it("handles uppercase extensions", () => {
    const chunker = getChunker("Component.TSX");
    assert.equal(chunker.language, "typescript");
  });

  it("handles paths with dots in directory names", () => {
    const chunker = getChunker("dir.with.dots/app.ts");
    assert.equal(chunker.language, "typescript");
  });
});

describe("chunkFile fallback", () => {
  it("falls back to line-based chunking when primary chunker returns 0 chunks", async () => {
    const code = "let x = 1;";
    const chunks = await chunkFile("test.ts", code);
    assert.ok(chunks.length > 0, "expected fallback to produce at least one chunk");
  });

  it("does not double-fallback when fallback itself returns 0 chunks", async () => {
    const chunks = await chunkFile("empty.ts", "");
    assert.deepStrictEqual(chunks, []);
  });
});

describe("chunkFile oversize splitting", () => {
  it("splits oversized JSON pair into sub-chunks <= 100 lines", async () => {
    const entries: string[] = [];
    for (let i = 0; i < 50; i++) {
      entries.push(
        `    "dep-${String(i).padStart(3, "0")}": {\n` +
        `      "version": "${i}.0.0",\n` +
        `      "resolved": "https://registry.example.com/dep-${i}/-/${i}.0.0.tgz",\n` +
        `      "integrity": "sha512-${"a".repeat(40)}"\n` +
        `    }`
      );
    }
    const content = `{\n  "packages": {\n${entries.join(",\n")}\n  }\n}`;

    const chunks = await chunkFile("large.json", content);

    assert.ok(chunks.length > 1, "expected multiple chunks from oversized file");
    for (const chunk of chunks) {
      assert.equal(
        chunk.metadata.language,
        "json",
        `chunk language should be json, got ${chunk.metadata.language}`
      );
      const lineCount = chunk.content.split("\n").length;
      assert.ok(
        lineCount <= 100,
        `chunk has ${lineCount} lines, expected <= 100`
      );
    }
  });

  it("splits oversized chunk on char limit even when lines are few", async () => {
    const longLine = "x".repeat(200);
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) {
      lines.push(longLine);
    }

    const chunks = await chunkFile("wide.txt", lines.join("\n"));

    assert.ok(chunks.length > 1, "expected character-limit to split into multiple chunks");
    for (const chunk of chunks) {
      assert.equal(chunk.metadata.language, "text");
      assert.ok(
        chunk.content.length <= 8000,
        `chunk has ${chunk.content.length} chars, expected <= 8000`
      );
    }
  });

  it("preserves all original content across sub-chunks", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 150; i++) {
      lines.push(`line-${String(i).padStart(4, "0")}`);
    }
    const content = lines.join("\n");

    const chunks = await chunkFile("lines.txt", content);
    const combined = chunks.map((c) => c.content).join("\n");

    assert.equal(combined, content, "combined sub-chunk content must equal original");
  });

  it("preserves line number metadata after splitting", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 150; i++) {
      lines.push(`line-${String(i).padStart(4, "0")}`);
    }
    const content = lines.join("\n");

    const chunks = await chunkFile("lines.txt", content);
    assert.ok(chunks.length > 1);

    let expectedLine = 1;
    for (const chunk of chunks) {
      assert.equal(chunk.metadata.startLine, expectedLine);
      expectedLine += chunk.content.split("\n").length;
    }
  });
});

describe("chunkFile with nodeTypes overrides", () => {
  it("applies nodeTypes override to chunk a file differently", async () => {
    const code = "class Foo {\n  bar() { return 1; }\n  baz() { return 2; }\n}";
    const chunksDefault = await chunkFile("test.ts", code);
    const chunksOverride = await chunkFile("test.ts", code, {
      typescript: ["function_declaration", "method_definition", "class_declaration", "arrow_function"],
    });
    assert.ok(chunksDefault.length > 0, "default should produce chunks");
    assert.ok(chunksOverride.length > 0, "override should produce chunks");
    assert.ok(chunksOverride.some((c) => c.content.includes("class Foo")), "override should include class-level chunk");
  });

  it("ignores override for non-tree-sitter languages", async () => {
    const code = "just some text";
    const chunks = await chunkFile("test.txt", code, { text: ["paragraph"] });
    assert.ok(chunks.length > 0, "should fall back to line-based chunking");
  });
});

describe("chunkFile single-line (minified) hard wrap", () => {
  it("hard-wraps one oversized line instead of emitting a whole-file chunk", async () => {
    const singleLine = "a".repeat(20000);
    const chunks = await chunkFile("minified.js", singleLine);

    assert.ok(chunks.length > 1, "expected a single oversized line to be split into multiple chunks");
    for (const chunk of chunks) {
      assert.ok(
        chunk.content.length <= 8000,
        `chunk has ${chunk.content.length} chars, expected <= 8000`
      );
      assert.equal(chunk.metadata.startLine, 1);
      assert.equal(chunk.metadata.endLine, 1);
    }
    assert.equal(
      chunks.map((c) => c.content).join(""),
      singleLine,
      "hard-wrapped slices must preserve the original line"
    );
  });

  it("keeps surrounding lines and line metadata intact around a wrapped line", async () => {
    const content = ["head", "z".repeat(9000), "tail"].join("\n");
    const chunks = await chunkFile("mixed.min.js", content);

    assert.ok(chunks.some((c) => c.content === "head"), "head line must survive");
    assert.ok(chunks.some((c) => c.content === "tail"), "tail line must survive");

    const wrapped = chunks.filter((c) => c.content.startsWith("z"));
    assert.ok(wrapped.length >= 2, "long line must be split into multiple slices");
    for (const chunk of wrapped) {
      assert.ok(chunk.content.length <= 8000);
      assert.equal(chunk.metadata.startLine, 2);
      assert.equal(chunk.metadata.endLine, 2);
    }
  });
});
