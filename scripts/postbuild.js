import { mkdirSync, copyFileSync, existsSync, readdirSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const distDir = join(fileURLToPath(import.meta.url), "..", "..", "dist");
const srcDir = join(fileURLToPath(import.meta.url), "..", "..", "src");

// Guard: CLI entry must have a shebang or npm link will fail on POSIX
const cliEntry = join(distDir, "cli", "index.js");
if (existsSync(cliEntry)) {
  const firstLine = readFileSync(cliEntry, "utf-8").split("\n")[0];
  if (firstLine !== "#!/usr/bin/env node") {
    process.stderr.write(`\nERROR: ${cliEntry} is missing "#!/usr/bin/env node" shebang. `);
    process.stderr.write("Add it to src/cli/index.ts and rebuild.\n\n");
    process.exit(1);
  }
}

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
