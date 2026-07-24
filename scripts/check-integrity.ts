import { LanceDbStore } from "../src/vectorstore/lancedb.js";
const store = new LanceDbStore("./.opencode/rag_db", 1024);
try {
  const start = Date.now();
  const c = await store.count();
  console.log(`count: ${c} (${Date.now() - start}ms)`);
  const ok = await store.checkIntegrity();
  console.log(`Integrity check: ${ok ? "PASS" : "FAIL"} (${Date.now() - start}ms)`);
  if (ok) {
    const files = await store.listFiles();
    console.log(`Files in store: ${files.length}`);
    const paths = await store.getFilePaths();
    console.log(`File paths returned: ${paths.length}`);
    const chunks = await store.getChunks(0, 3);
    console.log(`Sample chunks readable: ${chunks.length}`);
    if (chunks.length > 0) console.log(`First chunk content length: ${chunks[0].content.length}`);
  }
} catch (e) {
  console.error(`Error: ${e instanceof Error ? e.message : e}`);
}
await store.close();
process.exit(0);
