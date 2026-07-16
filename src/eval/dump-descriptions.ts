/**
 * @fileoverview Dump all chunk descriptions from a LanceDB index to a JSON file.
 * Used to copy descriptions from one branch to another for fair comparison.
 *
 * Usage: node --import tsx src/eval/dump-descriptions.ts --output .opencode/rag_db/chunk-descriptions.json
 */

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const WORKTREE = process.cwd();
const STORE_PATH = path.join(WORKTREE, ".opencode", "rag_db");

async function main() {
  const args = process.argv.slice(2);
  let outputPath = path.join(WORKTREE, ".opencode", "rag_db", "chunk-descriptions.json");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && args[i + 1]) {
      outputPath = path.resolve(WORKTREE, args[i + 1]!);
      break;
    }
  }

  console.log(`  Dumping descriptions from: ${STORE_PATH}`);
  console.log(`  Output: ${outputPath}`);

  const lancedb = await import("@lancedb/lancedb");
  const db = await lancedb.connect(STORE_PATH);
  const tableNames = await db.tableNames();

  if (!tableNames.includes("chunks")) {
    console.error("  No chunks table found in the store.");
    await db.close();
    process.exit(1);
  }

  const table = await db.openTable("chunks");
  const count = await table.countRows();
  console.log(`  Total rows: ${count}`);

  const rows = await table.query().select(["id", "description", "filePath", "startLine", "endLine"]).limit(count).toArray() as Record<string, unknown>[];

  const descriptions: Record<string, string> = {};
  let hasDesc = 0;
  for (const row of rows) {
    const filePath = (row.filePath as string).replace(/\\/g, "/");
    const startLine = row.startLine as number;
    const endLine = row.endLine as number;
    const desc = row.description as string ?? "";
    const key = `${filePath}:${startLine}:${endLine}`;
    descriptions[key] = desc;
    if (desc) hasDesc++;
  }

  const dir = path.dirname(outputPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, JSON.stringify(descriptions, null, 2), "utf-8");

  console.log(`  Dumped ${Object.keys(descriptions).length} chunks`);
  console.log(`  ${hasDesc} have non-empty descriptions`);
  console.log(`  Written to: ${outputPath}`);

  await db.close();
}

main().catch((err) => {
  console.error("Dump failed:", err);
  process.exit(1);
});
