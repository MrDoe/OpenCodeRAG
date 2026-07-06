/**
 * @fileoverview Update a LanceDB index's chunk descriptions from a JSON dump file.
 * Run AFTER normal indexing to replace descriptions with ones from another branch.
 *
 * Usage: node --import tsx src/eval/update-descriptions.ts --input doc/chunk-descriptions.json
 */

import { readFileSync } from "node:fs";
import path from "node:path";

async function main() {
  const args = process.argv.slice(2);
  const storePath = path.join(process.cwd(), ".opencode", "rag_db");
  let inputPath = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" && args[i + 1]) {
      inputPath = path.resolve(args[i + 1]!);
      break;
    }
  }

  if (!inputPath) {
    console.error("Usage: node --import tsx src/eval/update-descriptions.ts --input <descriptions.json>");
    process.exit(1);
  }

  console.log(`  Loading descriptions from: ${inputPath}`);
  const sourceDescs: Record<string, string> = JSON.parse(readFileSync(inputPath, "utf-8"));
  console.log(`  Loaded ${Object.keys(sourceDescs).length} descriptions`);

  console.log(`  Connecting to store: ${storePath}`);
  const lancedb = await import("@lancedb/lancedb");
  const db = await lancedb.connect(storePath);
  const tableNames = await db.tableNames();

  if (!tableNames.includes("chunks")) {
    console.error("  No chunks table found.");
    await db.close();
    process.exit(1);
  }

  const table = await db.openTable("chunks");
  const count = await table.countRows();
  console.log(`  Total rows: ${count}`);

  // Read all rows
  const rows = await table.query().select(["id", "description"]).limit(count).toArray() as Record<string, unknown>[];

  let updated = 0;
  let notFound = 0;
  let batch: { id: string; description: string }[] = [];

  for (const row of rows) {
    const id = row.id as string;
    const sourceDesc = sourceDescs[id];
    if (sourceDesc === undefined) {
      notFound++;
      continue;
    }
    batch.push({ id, description: sourceDesc });
    updated++;

    // Update in batches of 100
    if (batch.length >= 100) {
      console.log(`    Updating batch of ${batch.length}...`);
      for (const b of batch) {
      await table.update({
        where: `id = '${b.id.replace(/'/g, "''")}'`,
        values: { description: b.description },
      });
      }
      batch = [];
    }
  }

  // Final batch
  if (batch.length > 0) {
    console.log(`    Updating final batch of ${batch.length}...`);
    for (const b of batch) {
      await table.update({
        where: `id = '${b.id.replace(/'/g, "''")}'`,
        values: { description: b.description },
      });
    }
  }

  console.log(`\n  Done:`);
  console.log(`    Updated: ${updated}`);
  console.log(`    Not found in dump: ${notFound}`);
  console.log(`    Source dump had ${Object.keys(sourceDescs).length} entries`);

  await db.close();
}

main().catch((err) => {
  console.error("Update failed:", err);
  process.exit(1);
});
