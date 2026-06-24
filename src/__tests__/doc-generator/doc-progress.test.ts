import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadDocProgress,
  saveDocProgress,
  markFileDocumented,
  updateFileDocDetails,
} from "../../core/doc-progress.js";

describe("doc-progress", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = join(tmpdir(), `opencode-rag-doc-progress-test-${Date.now()}`);
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    try { unlinkSync(join(tmpDir, "doc-mode-progress.json")); } catch { /* ignore */ }
  });

  it("returns empty progress when no file exists", () => {
    const progress = loadDocProgress(tmpDir);
    assert.deepStrictEqual(progress.documented, []);
    assert.deepStrictEqual(progress.fileDetails, {});
    assert.equal(progress.lastUpdated, 0);
  });

  it("saves and loads progress", () => {
    saveDocProgress(tmpDir, {
      documented: ["src/test.ts"],
      fileDetails: {
        "src/test.ts": {
          symbolsDocumented: ["add"],
          symbolsUndocumented: ["subtract"],
          errors: [],
          lastAttempt: 123,
        },
      },
      lastUpdated: 456,
    });

    const loaded = loadDocProgress(tmpDir);
    assert.deepStrictEqual(loaded.documented, ["src/test.ts"]);
    assert.ok(loaded.fileDetails["src/test.ts"]);
    assert.deepStrictEqual(loaded.fileDetails["src/test.ts"]?.symbolsDocumented, ["add"]);
    assert.equal(loaded.lastUpdated, 456);
  });

  it("markFileDocumented adds a file to the documented list", () => {
    markFileDocumented(tmpDir, "src/hello.ts");
    const progress = loadDocProgress(tmpDir);
    assert.ok(progress.documented.includes("src/hello.ts"));
  });

  it("markFileDocumented is idempotent", () => {
    markFileDocumented(tmpDir, "src/idempotent.ts");
    const len1 = loadDocProgress(tmpDir).documented.length;
    markFileDocumented(tmpDir, "src/idempotent.ts");
    const len2 = loadDocProgress(tmpDir).documented.length;
    assert.equal(len2, len1);
  });

  it("updateFileDocDetails sets per-file details", () => {
    updateFileDocDetails(tmpDir, "src/detail.ts", {
      symbolsDocumented: ["foo", "bar"],
      symbolsUndocumented: ["baz"],
    });

    const progress = loadDocProgress(tmpDir);
    const details = progress.fileDetails["src/detail.ts"];
    assert.ok(details);
    assert.deepStrictEqual(details?.symbolsDocumented, ["foo", "bar"]);
    assert.deepStrictEqual(details?.symbolsUndocumented, ["baz"]);
    assert.ok(details?.lastAttempt > 0);
  });

  it("updateFileDocDetails merges with existing details", () => {
    updateFileDocDetails(tmpDir, "src/merge.ts", {
      symbolsDocumented: ["first"],
    });
    updateFileDocDetails(tmpDir, "src/merge.ts", {
      errors: ["some error"],
    });

    const progress = loadDocProgress(tmpDir);
    const details = progress.fileDetails["src/merge.ts"];
    assert.ok(details);
    assert.deepStrictEqual(details?.symbolsDocumented, ["first"]);
    assert.deepStrictEqual(details?.errors, ["some error"]);
  });
});
