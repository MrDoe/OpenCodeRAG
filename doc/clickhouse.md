# ClickHouse vector store

OpenCodeRAG stores its index in LanceDB by default (`.opencode/rag_db`, local-first, no
server). A **central ClickHouse** backend is available as an opt-in alternative: one server,
one database, two tables per project, and clients that hold no durable state.

```jsonc
{
  "vectorStore": {
    "provider": "clickhouse",
    "path": "./.opencode/rag_ch",          // disposable local cache
    "clickhouse": {
      "url": "http://clickhouse.example:8123",
      "database": "OpenCodeRAG",
      "username": "default",
      "passwordEnv": "OPENCODERAG_CLICKHOUSE_PASSWORD",
      "namespace": "OpenCodeRAG",           // omit in a global config (per-workspace tables)
      "ann": "hnsw",                        // requires ClickHouse >= 25.8
      "annFetchMultiplier": 4,
      "annWithRescoring": true
    }
  }
}
```

The fastest way to create this block and the tables is the interactive command:

```powershell
opencode-rag clickhouse setup
```

It prompts for URL, port, database, user, password, scope (workspace/global), namespace,
embedding dimension and ANN mode, probes the server, creates the database/tables, and writes
the config (backing up an existing file). Flags mirror every prompt for automation, e.g.
`opencode-rag clickhouse setup --yes --url http://clickhouse.example:8123 --password … --ann hnsw`.
The URL prompt defaults to `http://localhost:8123`; it never pre-fills the currently configured
internal host. The password is read without echo (and is only written to the config with
`--store-password`).

Put the password in the environment (or the global user config at
`~/.config/opencode/opencode-rag.json`), never in the workspace file.

## Requirements

- ClickHouse **25.1+** for the store itself. The approximate `vector_similarity` (HNSW)
  index needs **25.8+** and is verified on 26.10; on older servers set `ann: "off"` and every
  search becomes an exact `cosineDistance` scan (correct, just linear).
- A user that may `CREATE TABLE` in the target database (the store creates
  `chunks_<namespace>` and `state_<namespace>` on first use), or a DBA-provisioned database.
- Network access from every client to the HTTP port (`8123` by default). Internal hostnames
  may need `NO_PROXY`; the Node client does not use proxy environment variables itself.

`opencode-rag setup --vector-store clickhouse --clickhouse-url http://host:8123
--clickhouse-database OpenCodeRAG --clickhouse-namespace my-project` writes the block below
into a new `opencode-rag.json`.

## How it stores data

| Table | Engine | Purpose |
|---|---|---|
| `chunks_<ns>` | `ReplacingMergeTree(ver, is_deleted)` | one row per chunk revision, ordered by `(epoch, file_path, chunk_id)` |
| `state_<ns>` | `ReplacingMergeTree(ver)` | manifest, keyword index, quirks, runtime overrides, doc progress, description cache, `_meta`, `_lease` |

- **Writes** are insert-first: new rows and tombstones for superseded chunk ids go in one
  insert. Reads use `FINAL`, which drops the tombstones.
- **Full rebuilds** write into `epoch = active + 1` and become visible when the `_meta`
  `active_epoch` flips. An aborted rebuild is discarded; the old data stays searchable.
- **Search** is parameterized (`{q:Array(Float32)}`) and scored exactly like LanceDB
  (`clamp(1 - distance/2, 0, 1)`), so hybrid fusion and `retrieval.minScore` keep their
  meaning.

## ANN (HNSW)

With `ann: "hnsw"` the chunks table carries
`INDEX vec_idx embedding TYPE vector_similarity('hnsw', 'cosineDistance', <dim>)`. Verified
behaviour on 26.10:

- `FINAL` + `is_deleted = 0` **still uses the index** (`EXPLAIN indexes = 1` shows the skip
  index); deleted rows are removed before results are returned.
- **Tombstones reuse the superseded row's vector.** The index rejects rows whose array length
  differs from its DDL dimension and rejects empty arrays, so `deleteByFilePath` and per-file
  dedup read the old embedding and write it into the tombstone. `ann: "off"` stores empty
  tombstone vectors (no index, no constraint).
- Filtered searches post-filter the index candidates. `annFetchMultiplier` (default 4)
  over-fetches for path/language/kind filters; `annWithRescoring` recomputes the final
  distance from the full-precision vectors (ClickHouse 26.x defaults this off).
- ANN queries are capped at `max_limit_for_vector_search_queries` (1000 in 26.10); larger
  `topK` values are clamped with a warning.
- **The index is dimension-bound.** Changing the embedding model changes the vector length,
  which the index rejects. With `ann: "hnsw"` the store throws an actionable error instead of
  corrupting the table; drop `chunks_<ns>` and `state_<ns>` and re-index (or set
  `ann: "off"` and rebuild in place). Enabling ANN later on an existing table is supported:
  the store adds and materializes the index on first use.

## Stateless clients

The local `vectorStore.path` directory is a **disposable cache** when ClickHouse is active.
On startup the client hydrates `manifest.json`, `keyword-index.json`, `quirks.jsonl`,
`runtime-overrides.json`, `doc-progress.json` and — when
`vectorStore.clickhouse.state.syncDescCache` is enabled — `.desc-cache.json` from
`state_<ns>`; at the end of an index pass (and after quirk writes) it flushes changed files
back. A fresh clone on another machine can therefore search immediately and run
`opencode-rag index` without re-embedding anything.

Chunk and image **descriptions** are stored on the chunk rows themselves; `.desc-cache.json`
is the LLM cache that lets a later index pass reuse them instead of paying for the model
again. Syncing it is opt-in because it can be large (ClickSphere's cache is ~12 MB).

Delete the cache directory at any time — nothing durable is lost.

## Migrating an existing LanceDB store

Switching `vectorStore.provider` does not move existing data. Point `vectorStore.path` at a
**new** cache directory (`rag_ch`); reusing `rag_db` makes the old `manifest.json` claim files
are indexed while the ClickHouse table is empty, so the first pass would skip them.

- **Same embedding model/dimension** (e.g. both 4096): copy the old chunk rows directly —
  content, metadata, per-chunk descriptions, image descriptions and embeddings — plus
  `manifest.json`, `keyword-index.json` and `.desc-cache.json`. No re-embedding, no LLM calls.
  Descriptions are columns on `chunks_<ns>`; there is no separate description table.
- **Different dimension** (e.g. old Ollama 1024 → OpenAI 4096): embeddings cannot be reused.
  Seed `.desc-cache.json` with the old descriptions keyed by
  `DescriptionCache.codeKey(content, computeDescriptionConfigHash(cfg), "<file>:<start>-<end>")`,
  then run an index pass: it re-embeds at the new dimension and reuses the descriptions.
- **Quirks**: merge `rag_db/quirks.jsonl` into `rag_ch/quirks.jsonl` by id (latest
  `lastObserved` wins) and let the bootstrap reconcile embed the missing ones.
- Keep the old `rag_db` as a backup until the ClickHouse store is verified.

## Multi-machine behaviour

Only one machine should run an index pass or watcher per namespace. The store claims an
advisory `_lease` row (TTL 90 s, heartbeat 30 s) in `state_<ns>`; a second machine's watcher
goes dormant and retries. The lease is advisory (ClickHouse has no compare-and-swap), and
data safety comes from the insert-first write order.

## Disk and maintenance

Chunk rows are dominated by the vector (`4 × dimensions` bytes, ~16 KB at 4096 dims). Old
epochs are invisible but still occupy disk until pruned; `optimize()` runs
`OPTIMIZE TABLE … FINAL` and deletes superseded epochs. A full rebuild is refused below
`clickhouse.diskFreeFloorBytes` (default 5 GiB).

```sql
-- inspect space
SELECT table, formatReadableSize(sum(bytes_on_disk))
FROM system.parts WHERE database = 'OpenCodeRAG' AND active
GROUP BY table ORDER BY sum(bytes_on_disk) DESC;
```

## Limitations

- **ANN needs ClickHouse >= 25.8** and is dimension-bound; on older servers or after a model
  change set `ann: "off"` (exact scans) or recreate the project tables.
- **`FINAL` on every read** costs CPU; the HNSW index still prunes candidates, but benchmark
  before going far beyond ~100k chunks.
- The first client needs DDL rights; a read-only user works only after the tables exist.
- The keyword index is hydrated at startup / pass end, not live-synced every second; a
  read-only client may need a restart to pick up another machine's newest BM25 entries.
- Runtime overrides written by a TUI session on another machine are applied on the **next**
  start (the plugin reads overrides before it hydrates the bundle).
- `opencode-rag status` reports the backend, namespace and current index lease holder.
