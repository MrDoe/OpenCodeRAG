import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatReadOutput, formatFileFallback, formatHybridReadOutput } from "../../opencode/read-format.js";
import type { SearchResult } from "../../core/interfaces.js";

function makeResult(
  id: string,
  filePath: string,
  startLine: number,
  endLine: number,
  language: string,
  content: string,
  score: number
): SearchResult {
  return {
    score,
    chunk: {
      id,
      content,
      metadata: { filePath, startLine, endLine, language },
    },
  };
}

describe("formatReadOutput", () => {
  const results = [
    makeResult(
      "chunk-1",
      "/project/src/indexer.ts",
      12,
      48,
      "typescript",
      "export async function indexWorkspace() {\n  // ...\n}",
      0.842
    ),
    makeResult(
      "chunk-2",
      "/project/src/indexer.ts",
      55,
      90,
      "typescript",
      "export function scanWorkspace() {\n  // ...\n}",
      0.731
    ),
  ];

  it("contains context header", () => {
    const output = formatReadOutput({
      filePath: "/project/src/indexer.ts",
      retrievalQuery: "indexing details",
      results,
      maxChunks: 5,
      maxChars: 20000,
    });
    assert.match(output, /OpenCodeRAG context/);
  });

  it("contains requested file path", () => {
    const output = formatReadOutput({
      filePath: "/project/src/indexer.ts",
      retrievalQuery: "indexing details",
      results,
      maxChunks: 5,
      maxChars: 20000,
    });
    assert.match(output, /\/project\/src\/indexer\.ts/);
  });

  it("contains retrieval query", () => {
    const output = formatReadOutput({
      filePath: "/project/src/indexer.ts",
      retrievalQuery: "indexing details",
      results,
      maxChunks: 5,
      maxChars: 20000,
    });
    assert.match(output, /indexing details/);
  });

  it("contains line numbers", () => {
    const output = formatReadOutput({
      filePath: "/project/src/indexer.ts",
      retrievalQuery: "test",
      results,
      maxChunks: 5,
      maxChars: 20000,
    });
    assert.match(output, /Lines: 12-48/);
    assert.match(output, /Lines: 55-90/);
  });

  it("contains scores", () => {
    const output = formatReadOutput({
      filePath: "/project/src/indexer.ts",
      retrievalQuery: "test",
      results,
      maxChunks: 5,
      maxChars: 20000,
    });
    assert.match(output, /Score: 0\.842/);
  });

  it("contains code fences", () => {
    const output = formatReadOutput({
      filePath: "/project/src/indexer.ts",
      retrievalQuery: "test",
      results,
      maxChunks: 5,
      maxChars: 20000,
    });
    assert.match(output, /```typescript/);
    assert.match(output, /```$/m);
  });

  it("uses language from metadata as fence language", () => {
    const pyResult = makeResult(
      "chunk-3",
      "/project/src/main.py",
      1,
      10,
      "python",
      "def main(): pass",
      0.5
    );
    const output = formatReadOutput({
      filePath: "/project/src/main.py",
      retrievalQuery: "test",
      results: [pyResult],
      maxChunks: 5,
      maxChars: 20000,
    });
    assert.match(output, /```python/);
  });

  it("respects maxChunks limit", () => {
    const manyResults = Array.from({ length: 10 }, (_, i) =>
      makeResult(
        `chunk-${i}`,
        "/project/src/file.ts",
        i * 10 + 1,
        i * 10 + 10,
        "typescript",
        `// content ${i}`,
        1.0 - i * 0.05
      )
    );
    const output = formatReadOutput({
      filePath: "/project/src/file.ts",
      retrievalQuery: "test",
      results: manyResults,
      maxChunks: 3,
      maxChars: 20000,
    });
    // Should mention "3 of max 3" (since only 3 included)
    assert.match(output, /3 of max 3/);
    assert.doesNotMatch(output, /content 3/);
    assert.doesNotMatch(output, /content 4/);
  });

  it("respects maxChars and appends truncation notice when needed", () => {
    const largeContent = "// " + "x".repeat(5000);
    const bigResults = [
      makeResult(
        "chunk-big",
        "/project/src/file.ts",
        1,
        100,
        "typescript",
        largeContent,
        0.9
      ),
      makeResult(
        "chunk-big2",
        "/project/src/file.ts",
        101,
        200,
        "typescript",
        largeContent,
        0.8
      ),
    ];
    const output = formatReadOutput({
      filePath: "/project/src/file.ts",
      retrievalQuery: "test",
      results: bigResults,
      maxChunks: 5,
      maxChars: 1200,
    });
    assert.match(output, /Output truncated by OpenCodeRAG/);
  });

  it("formats chunk count in header", () => {
    const output = formatReadOutput({
      filePath: "/project/src/file.ts",
      retrievalQuery: "test query",
      results,
      maxChunks: 5,
      maxChars: 20000,
    });
    assert.match(output, /Returned chunks/);
    assert.match(output, /2 of max 5/);
  });
});

describe("guessLanguage via chunking.parsers", () => {
  it("labels a remapped extension with the overridden parser", () => {
    const output = formatFileFallback({
      filePath: "/project/kernel.cu",
      content: "int add(int a, int b) { return a + b; }\n",
      reason: "test",
      languageByExtension: { ".cu": "cpp" },
    });
    assert.match(output, /^```cpp/m);
  });

  it("labels an overridden built-in mapping (.c → cpp)", () => {
    const output = formatFileFallback({
      filePath: "/project/main.c",
      content: "int main(void) { return 0; }\n",
      reason: "test",
      languageByExtension: { ".c": "cpp" },
    });
    assert.match(output, /^```cpp/m);
  });

  it("keeps the default label when no override applies", () => {
    const output = formatFileFallback({
      filePath: "/project/main.c",
      content: "int main(void) { return 0; }\n",
      reason: "test",
      languageByExtension: { ".cu": "cpp" },
    });
    assert.match(output, /^```c$/m);
  });

  it("applies overrides in hybrid read output too", () => {
    const output = formatHybridReadOutput({
      filePath: "/project/kernel.cu",
      fileContent: "int add(int a, int b) { return a + b; }\n",
      ragChunks: [],
      relatedFiles: [],
      maxChars: 20000,
      languageByExtension: { ".cu": "cpp" },
    });
    assert.match(output, /^```cpp/m);
  });
});
