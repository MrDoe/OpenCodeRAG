import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Static import-graph guard: the plugin's static module graph must never
 * reach `sharp`.
 *
 * `sharp` pulls a native binding + libvips; a broken or partial install of it
 * used to kill the whole OpenCode server at plugin load (issue #44 class),
 * because `src/opencode/tools.ts` imported `content/image.js` statically.
 * The img tool now imports it lazily, so a broken sharp can only fail the one
 * `describe_image` call. This test walks the BUILT dist graph from
 * `plugin-entry.js` and fails if any statically imported module reaches sharp.
 *
 * Skips when dist/ has not been built (unit tests can run before a build).
 */

const STATIC_FROM_RE = /\bfrom\s+["']([^"']+)["']/g;
const BARE_IMPORT_RE = /\bimport\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT_PREFIX = /import\s*\(/;

function staticSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const re of [STATIC_FROM_RE, BARE_IMPORT_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      // `import("...")` cannot match these patterns (they require `from` or a
      // bare side-effect import without parentheses), but guard anyway.
      const index = match.index;
      if (DYNAMIC_IMPORT_PREFIX.test(source.slice(Math.max(0, index - 10), index + 1))) continue;
      specifiers.push(match[1]!);
    }
  }
  return specifiers;
}

describe("plugin static import graph", () => {
  it("never reaches sharp through a static import", (t) => {
    const distEntry = resolve(process.cwd(), "dist", "plugin-entry.js");
    if (!existsSync(distEntry)) {
      t.skip("dist/ not built — run `npm run build` first");
      return;
    }

    const visited = new Set<string>();
    const queue = [distEntry];
    const sharpImporters: string[] = [];

    while (queue.length > 0) {
      const file = queue.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);

      const source = readFileSync(file, "utf8");
      for (const specifier of staticSpecifiers(source)) {
        if (specifier === "sharp") {
          sharpImporters.push(file);
          continue;
        }
        if (!specifier.startsWith(".")) continue; // bare package — not walked
        const target = resolve(dirname(file), specifier);
        if (existsSync(target)) queue.push(target);
      }
    }

    assert.deepEqual(
      sharpImporters,
      [],
      `sharp must not be in the plugin's static import graph. Importer(s): ${sharpImporters.join(", ")}`,
    );
  });
});
