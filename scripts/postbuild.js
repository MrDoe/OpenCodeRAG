import { mkdirSync, copyFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const distDir = join(fileURLToPath(import.meta.url), "..", "..", "dist");
const srcDir = join(fileURLToPath(import.meta.url), "..", "..", "src");

mkdirSync(join(distDir, "types"), { recursive: true });
copyFileSync(
  join(srcDir, "types", "opencode-plugin.d.ts"),
  join(distDir, "types", "opencode-plugin.d.ts"),
);

// Remove source maps from dist/ to reduce package size
function removeSourceMaps(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      removeSourceMaps(fullPath);
    } else if (entry.name.endsWith(".js.map")) {
      unlinkSync(fullPath);
    }
  }
}
removeSourceMaps(distDir);
