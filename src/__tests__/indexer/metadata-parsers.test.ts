import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFileMetadataHeader } from "../../indexer/metadata.js";

const CWD = "/repo";

describe("buildFileMetadataHeader with chunking.parsers", () => {
  it("uses the built-in label when no override applies", () => {
    const header = buildFileMetadataHeader("/repo/src/main.c", CWD, "int main(){}");
    assert.ok(header.startsWith("[c]"), `expected a [c] label, got: ${header}`);
  });

  it("uses the overridden parser language as the file-type label", () => {
    // `.c` is parsed as C++ via chunking.parsers, so the embedded header must
    // say [cpp] — otherwise it contradicts the chunk's metadata.language.
    const header = buildFileMetadataHeader("/repo/src/main.c", CWD, "int main(){}", {
      ".c": "cpp",
    });
    assert.ok(header.startsWith("[cpp]"), `expected a [cpp] label, got: ${header}`);
    assert.equal(header.includes("[c]"), false, `stale [c] label in: ${header}`);
  });

  it("applies an override to a brand-new extension", () => {
    const header = buildFileMetadataHeader("/repo/src/kernel.cu", CWD, "int main(){}", {
      ".cu": "cpp",
    });
    assert.ok(header.startsWith("[cpp]"), `expected a [cpp] label, got: ${header}`);
  });

  it("normalizes override keys and values", () => {
    const header = buildFileMetadataHeader("/repo/src/main.c", CWD, "int main(){}", {
      C: "CPP",
    });
    assert.ok(header.startsWith("[cpp]"), `expected a [cpp] label, got: ${header}`);
  });

  it("ignores overrides for other extensions", () => {
    const header = buildFileMetadataHeader("/repo/src/main.c", CWD, "int main(){}", {
      ".cu": "cpp",
    });
    assert.ok(header.startsWith("[c]"), `expected a [c] label, got: ${header}`);
  });
});
