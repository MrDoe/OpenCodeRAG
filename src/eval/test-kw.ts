import { KeywordIndex } from "../retriever/keyword-index.js";
import path from "node:path";

const storePath = path.join(process.cwd(), ".opencode", "rag_db");
const ki = await KeywordIndex.load(storePath);
console.log("Keyword index entries:", ki.count());

const queries = [
  "retrieve function",
  "KeywordIndex class",
  "embedder factory",
  "vector store LanceDB",
  "find usages SearchResult",
];

for (const q of queries) {
  const res = ki.search(q, 5);
  console.log(`\n"${q}": ${res.length} results`);
  for (const r of res) {
    const fp = r.chunk.metadata.filePath.substring(r.chunk.metadata.filePath.lastIndexOf("/src/") + 1);
    console.log(`  score=${r.score.toFixed(2)} ${fp}:${r.chunk.metadata.startLine}-${r.chunk.metadata.endLine}`);
  }
}

ki.close();
