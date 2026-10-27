/**
 * @fileoverview ClickHouse-backed `VectorStore` — an opt-in, central alternative
 * to the default LanceDB store.
 *
 * Storage model (one table pair per project namespace, database `OpenCodeRAG`):
 *
 * - `chunks_<ns>`: `ReplacingMergeTree(ver, is_deleted)` ordered by
 *   `(epoch, file_path, chunk_id)`. Vector search is an exact
 *   `cosineDistance(...) ORDER BY ... LIMIT k` scan — ClickHouse only gained
 *   approximate `vector_similarity` indexes in 25.8, and the server this was
 *   built for runs 25.1 (see `ann` in the config).
 * - `state_<ns>`: a one-row-per-name KV table used for the durable workspace
 *   state (manifest, keyword index, quirks, overrides, `_meta`, `_lease`) and
 *   by {@link StateSync}. The local `vectorStore.path` is only a disposable
 *   cache when this backend is active.
 *
 * Correctness notes:
 * - Writes are insert-first: new rows and tombstones for superseded chunk ids
 *   go in one `insert`, so an aborted pass never loses data.
 * - A full rebuild writes into `epoch = active + 1` and becomes visible when
 *   `_meta.active_epoch` flips — no directory swap, no downtime.
 * - `FINAL` is required on reads because `ReplacingMergeTree` deduplicates
 *   only during background merges.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import type { ClickHouseClient, ClickHouseSettings } from "@clickhouse/client";
import type {
  BulkChunkWrite,
  Chunk,
  ChunkBrowseStore,
  ChunkSummary,
  FileSummary,
  MetadataFilter,
  SearchResult,
  VectorStore,
} from "../core/interfaces.js";
import type { RagConfig } from "../core/config.js";
import { normalizeFilePath } from "../core/manifest.js";
import { normalizeFileExtensions } from "../core/filters.js";

/** Synthetic filePath prefix for quirk chunks — mirrors lancedb.ts and quirk-store.ts. */
const QUIRK_FILE_PREFIX = "quirk:";

const META_NAME = "_meta";
const LEASE_NAME = "_lease";

/** Current `_meta` row. */
interface StoreMeta {
  activeEpoch: number;
  pendingEpoch: number;
  dimension: number;
  embeddingModel: string;
}

/** One DB row in `chunks_<ns>`. `ver` is filled by the column DEFAULT. */
interface ChunkRow {
  chunk_id: string;
  file_path: string;
  start_line: number;
  end_line: number;
  language: string;
  kind: string;
  role: string;
  quirk_type: string;
  tags: string;
  content: string;
  description: string;
  embedding: number[];
  epoch: number;
  is_deleted: number;
}

/** Fully resolved ClickHouse connection/storage options. */
export interface ResolvedClickHouseOptions {
  url: string;
  database: string;
  username: string;
  password: string;
  namespace: string;
  chunksTable: string;
  stateTable: string;
  requestTimeoutMs: number;
  maxOpenConnections: number;
  compression: boolean;
  ann: "off" | "hnsw";
  annFetchMultiplier: number;
  annWithRescoring: boolean;
  leaseEnabled: boolean;
  leaseTtlMs: number;
  diskFreeFloorBytes: number;
  syncDescCache: boolean;
  /** Embedding model name recorded in `_meta` (diagnostics/rebuild audit). */
  embeddingModel: string;
}

/** Sanitize a namespace so it is safe as a table suffix. */
export function sanitizeNamespace(raw: string): string {
  const cleaned = raw
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return cleaned.length > 0 ? cleaned : "default";
}

/** Derive a stable namespace from a workspace path (name + path hash). */
export function deriveNamespace(workspaceDir: string): string {
  const absolute = path.resolve(workspaceDir);
  const base = path.basename(absolute) || "workspace";
  const hash = createHash("sha1").update(absolute).digest("hex").slice(0, 8);
  return sanitizeNamespace(`${base}_${hash}`);
}

/** Resolve a full ClickHouse config block (with defaults) for a workspace. */
export function resolveClickHouseOptions(
  config: RagConfig,
  workspaceDir: string,
): ResolvedClickHouseOptions {
  const ch = config.vectorStore.clickhouse;
  if (!ch) {
    throw new Error(
      'vectorStore.provider is "clickhouse" but vectorStore.clickhouse is missing — add the connection block to opencode-rag.json',
    );
  }
  const envPassword = ch.passwordEnv ? process.env[ch.passwordEnv] : undefined;
  const namespace = sanitizeNamespace(ch.namespace?.trim() || deriveNamespace(workspaceDir));
  return {
    url: ch.url,
    database: ch.database,
    username: ch.username,
    password: envPassword ?? ch.password ?? "",
    namespace,
    chunksTable: `chunks_${namespace}`,
    stateTable: `state_${namespace}`,
    requestTimeoutMs: ch.requestTimeoutMs ?? 30_000,
    maxOpenConnections: ch.maxOpenConnections ?? 10,
    compression: ch.compression ?? true,
    ann: ch.ann ?? "off",
    annFetchMultiplier: Math.min(1000, Math.max(1, ch.annFetchMultiplier ?? 4)),
    annWithRescoring: ch.annWithRescoring ?? true,
    leaseEnabled: ch.lease?.enabled ?? true,
    leaseTtlMs: Math.max(10, ch.lease?.ttlSeconds ?? 90) * 1000,
    diskFreeFloorBytes: ch.diskFreeFloorBytes ?? 5 * 1024 * 1024 * 1024,
    syncDescCache: ch.state?.syncDescCache ?? false,
    embeddingModel: config.embedding.model,
  };
}

/** Quote a ClickHouse identifier. */
function quoteIdent(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

/** Vectors are stored L2-normalized, matching the LanceDB store. */
function l2Normalize(vector: number[]): number[] {
  let norm = 0;
  for (const value of vector) norm += value * value;
  const length = Math.sqrt(norm);
  if (length === 0) return vector;
  return vector.map((value) => value / length);
}

/** Mirror LanceDB's glob→LIKE translation (no anchoring, same wildcards). */
function globToLike(pattern: string): string {
  return pattern.replace(/\*\*/g, "%").replace(/\*/g, "%").replace(/\?/g, "_");
}

/**
 * ClickHouse-backed vector store. Instantiate through `createVectorStore()`;
 * the constructor only records options and opens the client lazily.
 */
export class ClickHouseStore implements ChunkBrowseStore {
  private readonly opts: ResolvedClickHouseOptions;
  private readonly dimensions: number;
  /** Set on a rebuild target: all writes/reads are bound to this epoch. */
  private readonly boundEpoch?: number;
  private client: ClickHouseClient | null = null;
  private schemaReady: Promise<void> | null = null;
  private activeEpoch: number | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  private static modulePromise: Promise<typeof import("@clickhouse/client")> | null = null;

  constructor(options: ResolvedClickHouseOptions, vectorDimension = 384, boundEpoch?: number) {
    this.opts = options;
    this.dimensions = vectorDimension;
    this.boundEpoch = boundEpoch;
  }

  // ── Connection & schema ────────────────────────────────────────────────

  private async loadClientModule(): Promise<typeof import("@clickhouse/client")> {
    if (!ClickHouseStore.modulePromise) {
      ClickHouseStore.modulePromise = import("@clickhouse/client").catch((err: unknown) => {
        ClickHouseStore.modulePromise = null;
        throw new Error(
          'The "clickhouse" vector store provider requires the "@clickhouse/client" package. ' +
          "Install it with: npm install @clickhouse/client --legacy-peer-deps " +
          `(original error: ${(err as Error).message})`,
        );
      });
    }
    return ClickHouseStore.modulePromise;
  }

  private async getClient(): Promise<ClickHouseClient> {
    if (this.client) return this.client;
    const { createClient } = await this.loadClientModule();
    this.client = createClient({
      url: this.opts.url,
      username: this.opts.username,
      password: this.opts.password,
      // Always talk to `default`; every statement fully qualifies the target
      // database so the client survives `CREATE DATABASE` without reconnecting.
      database: "default",
      request_timeout: this.opts.requestTimeoutMs,
      max_open_connections: this.opts.maxOpenConnections,
      compression: this.opts.compression ? { request: true, response: true } : undefined,
    });
    return this.client;
  }

  private async command(query: string, params?: Record<string, unknown>): Promise<void> {
    const client = await this.getClient();
    await client.command({
      query,
      query_params: params,
      clickhouse_settings: { wait_end_of_query: 1 },
    });
  }

  private async select<T>(
    query: string,
    params?: Record<string, unknown>,
    settings?: Record<string, number | string>,
  ): Promise<T[]> {
    const client = await this.getClient();
    const resultSet = await client.query({
      query,
      query_params: params,
      format: "JSONEachRow",
      clickhouse_settings: settings as ClickHouseSettings | undefined,
    });
    return resultSet.json<T>();
  }

  private table(name: string): string {
    return `${quoteIdent(this.opts.database)}.${quoteIdent(name)}`;
  }

  private insertTable(name: string): string {
    // The client interpolates this into `INSERT INTO <table> FORMAT ...`, so
    // it must be a plain (unquoted) identifier path. Both parts are validated
    // by sanitizeNamespace / the constant database name.
    return `${this.opts.database}.${name}`;
  }

  private async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.initSchema().catch((err: unknown) => {
        this.schemaReady = null;
        throw err;
      });
    }
    await this.schemaReady;
    // Cheap (2 s TTL) refresh of the active epoch so a long-lived handle sees
    // another machine's promote/clear instead of reading a pruned epoch.
    await this.maybeRefreshEpoch();
  }

  private async initSchema(): Promise<void> {
    await this.command(`CREATE DATABASE IF NOT EXISTS ${quoteIdent(this.opts.database)}`);
    const indexClause = this.opts.ann === "hnsw"
      ? `, INDEX vec_idx embedding TYPE vector_similarity('hnsw', 'cosineDistance', ${this.dimensions})`
      : "";
    await this.command(
      `CREATE TABLE IF NOT EXISTS ${this.table(this.opts.chunksTable)} (` +
      "chunk_id String, file_path String, start_line Int32, end_line Int32, " +
      "language LowCardinality(String), kind LowCardinality(String), role LowCardinality(String), " +
      "quirk_type LowCardinality(String), tags String, content String, description String, " +
      "embedding Array(Float32) CODEC(NONE), epoch UInt64, " +
      "ver DateTime64(6, 'UTC') DEFAULT now64(6), is_deleted UInt8 DEFAULT 0" +
      indexClause +
      ") ENGINE = ReplacingMergeTree(ver, is_deleted) " +
      "ORDER BY (epoch, file_path, chunk_id)",
    );
    await this.command(
      `CREATE TABLE IF NOT EXISTS ${this.table(this.opts.stateTable)} (` +
      "name String, ver DateTime64(6, 'UTC') DEFAULT now64(6), " +
      "sha256 String DEFAULT '', bytes UInt64 DEFAULT 0, data String CODEC(ZSTD(3))" +
      ") ENGINE = ReplacingMergeTree(ver) ORDER BY name",
    );

    // A store created before ANN was enabled has the table but not the index.
    if (this.opts.ann === "hnsw") {
      await this.ensureVectorIndex();
    }

    const meta = await this.readMeta();
    if (!meta) {
      await this.writeMeta({
        activeEpoch: 1,
        pendingEpoch: 0,
        dimension: this.dimensions,
        embeddingModel: this.opts.embeddingModel,
      });
      this.activeEpoch = 1;
      return;
    }

    this.activeEpoch = meta.activeEpoch;
    if (meta.dimension !== this.dimensions) {
      if (this.opts.ann === "hnsw") {
        // The ANN index is bound to the dimension in its DDL and rejects rows
        // of any other length, so a model change needs a fresh table (the
        // in-place epoch rebuild cannot change the index dimension).
        throw new Error(
          `ClickHouse store ${this.opts.namespace} was built with vector dimension ${meta.dimension}, ` +
          `but the ANN index is bound to ${this.dimensions}. Drop ` +
          `\`${this.opts.database}\`.\`${this.opts.chunksTable}\` and ` +
          `\`${this.opts.database}\`.\`${this.opts.stateTable}\`, then re-index; ` +
          `or set vectorStore.clickhouse.ann = "off" to rebuild in place.`,
        );
      }
      // The store was built by a different embedding model. Writes are
      // refused; the pipeline detects this through getVectorDimension() and
      // rebuilds into a fresh epoch.
      console.warn(
        `[clickhouse] Store ${this.opts.namespace} was built with vector dimension ${meta.dimension} ` +
        `but the current embedder produces ${this.dimensions}. ` +
        "Run 'opencode-rag index' to rebuild the index with the current model.",
      );
    }
  }

  /** Add + materialize the HNSW index on a table created before ANN was enabled. */
  private async ensureVectorIndex(): Promise<void> {
    const findIndex = () => this.select<{ name: string }>(
      "SELECT name FROM system.data_skipping_indices " +
      "WHERE database = {db:String} AND table = {table:String} AND name = {name:String} LIMIT 1",
      { db: this.opts.database, table: this.opts.chunksTable, name: "vec_idx" },
    );
    if ((await findIndex()).length > 0) return;
    try {
      await this.command(
        `ALTER TABLE ${this.table(this.opts.chunksTable)} ADD INDEX vec_idx embedding ` +
        `TYPE vector_similarity('hnsw', 'cosineDistance', ${this.dimensions})`,
      );
      await this.command(
        `ALTER TABLE ${this.table(this.opts.chunksTable)} MATERIALIZE INDEX vec_idx ` +
        "SETTINGS mutations_sync = 2",
      );
    } catch (err) {
      // A racing client may have created it between the check and the ALTER.
      if ((await findIndex().catch(() => [])).length > 0) return;
      throw new Error(
        `Could not create the ANN index with dimension ${this.dimensions} on ` +
        `${this.opts.chunksTable}: ${(err as Error).message}. If the store was built with another ` +
        'embedding model, drop the project tables and re-index, or set vectorStore.clickhouse.ann = "off".',
      );
    }
  }

  private currentEpoch(): number {
    return this.boundEpoch ?? this.activeEpoch ?? 1;
  }

  /**
   * Refresh the cached active epoch from `_meta` (at most every 2 s).
   *
   * Another machine may promote a rebuild or clear the namespace at any time;
   * a handle that kept a stale epoch would read (or write) a superseded epoch
   * forever — and after `optimize()` prunes it, silently see an empty store.
   */
  private epochCheckedAt = 0;
  private async maybeRefreshEpoch(): Promise<void> {
    if (this.boundEpoch !== undefined) return;
    const now = Date.now();
    if (now - this.epochCheckedAt < 2000) return;
    this.epochCheckedAt = now;
    try {
      const meta = await this.readMeta();
      if (meta) this.activeEpoch = meta.activeEpoch;
    } catch {
      // Keep the cached epoch; a transient meta read must not break reads.
    }
  }

  private async readMeta(): Promise<StoreMeta | undefined> {
    const rows = await this.select<{ data: string }>(
      `SELECT data FROM ${this.table(this.opts.stateTable)} FINAL WHERE name = {name:String} LIMIT 1`,
      { name: META_NAME },
    );
    const raw = rows[0]?.data;
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<StoreMeta>;
      return {
        activeEpoch: Number(parsed.activeEpoch ?? 1),
        pendingEpoch: Number(parsed.pendingEpoch ?? 0),
        dimension: Number(parsed.dimension ?? this.dimensions),
        embeddingModel: String(parsed.embeddingModel ?? ""),
      };
    } catch {
      return undefined;
    }
  }

  private async writeMeta(meta: StoreMeta): Promise<void> {
    const client = await this.getClient();
    const data = JSON.stringify(meta);
    await client.insert({
      table: this.insertTable(this.opts.stateTable),
      values: [{ name: META_NAME, data, sha256: "", bytes: Buffer.byteLength(data) }],
      format: "JSONEachRow",
    });
    this.activeEpoch = meta.activeEpoch;
  }

  /** Generic state-bundle read used by `StateSync`. */
  async readState(name: string): Promise<{ data: string; ver: string } | undefined> {
    await this.ensureSchema();
    const rows = await this.select<{ data: string; ver: string }>(
      `SELECT data, toString(ver) AS ver FROM ${this.table(this.opts.stateTable)} FINAL WHERE name = {name:String} LIMIT 1`,
      { name },
    );
    return rows[0];
  }

  /** Generic state-bundle write used by `StateSync`. */
  async writeState(name: string, data: string, sha256 = ""): Promise<void> {
    await this.ensureSchema();
    const client = await this.getClient();
    await client.insert({
      table: this.insertTable(this.opts.stateTable),
      values: [{ name, data, sha256, bytes: Buffer.byteLength(data) }],
      format: "JSONEachRow",
    });
  }

  /** Names currently present in the state bundle (newest row per name). */
  async listStateNames(): Promise<string[]> {
    await this.ensureSchema();
    const rows = await this.select<{ name: string }>(
      `SELECT name FROM ${this.table(this.opts.stateTable)} FINAL ORDER BY name`,
    );
    return rows.map((row) => row.name);
  }

  // ── Writes ─────────────────────────────────────────────────────────────

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  async addChunks(chunks: Chunk[], options?: { dedup?: boolean }): Promise<void> {
    if (chunks.length === 0) return;
    await this.withWriteLock(() => this.addChunksInternal(chunks, options?.dedup ?? true));
  }

  async addChunksBulk(items: BulkChunkWrite[]): Promise<void> {
    const active = items.filter((item) => item.chunks.length > 0);
    if (active.length === 0) return;
    await this.withWriteLock(async () => {
      for (const item of active) {
        await this.addChunksInternal(item.chunks, item.dedup);
      }
    });
  }

  private async addChunksInternal(chunks: Chunk[], dedup: boolean): Promise<void> {
    await this.ensureSchema();
    if (this.boundEpoch === undefined) {
      // Refuse writes whose vector length disagrees with the active epoch's
      // schema. A rebuild target is exempt: it is building the new dimension
      // and only promotes (updating `_meta.dimension`) at the end.
      const meta = await this.readMeta();
      if (meta && meta.dimension !== this.dimensions) {
        throw new Error(
          `ClickHouse store ${this.opts.namespace} was built with vector dimension ${meta.dimension} ` +
          `but this handle produces ${this.dimensions} — run 'opencode-rag index' to rebuild it.`,
        );
      }
    }
    const epoch = this.currentEpoch();
    const rows = chunks
      .map((chunk) => this.chunkToRow(chunk, epoch))
      .filter((row): row is ChunkRow => row !== null);
    if (rows.length === 0) return;

    const tombstones: ChunkRow[] = [];
    if (dedup) {
      const paths = Array.from(new Set(rows.map((row) => row.file_path)));
      const oldRows = await this.select<{ file_path: string; chunk_id: string; embedding: number[] }>(
        `SELECT file_path, chunk_id, embedding FROM ${this.table(this.opts.chunksTable)} FINAL ` +
        "WHERE epoch = {epoch:UInt64} AND file_path IN ({paths:Array(String)})",
        { epoch, paths },
      );
      const newIdsByPath = new Map<string, Set<string>>();
      for (const row of rows) {
        const set = newIdsByPath.get(row.file_path) ?? new Set<string>();
        set.add(row.chunk_id);
        newIdsByPath.set(row.file_path, set);
      }
      for (const old of oldRows) {
        if (newIdsByPath.get(old.file_path)?.has(old.chunk_id)) continue;
        tombstones.push(this.tombstoneRow(old.file_path, old.chunk_id, epoch, old.embedding ?? []));
      }
    }

    const client = await this.getClient();
    await client.insert({
      table: this.insertTable(this.opts.chunksTable),
      values: [...rows, ...tombstones],
      format: "JSONEachRow",
    });
  }

  private chunkToRow(chunk: Chunk, epoch: number): ChunkRow | null {
    if (!chunk.embedding || chunk.embedding.length === 0) return null;
    const filePath = chunk.metadata.filePath.startsWith(QUIRK_FILE_PREFIX)
      // Synthetic quirk ids stay RAW — normalizing them keys rows by the cwd
      // of whichever process wrote them (same trap as LanceDB).
      ? chunk.metadata.filePath
      : normalizeFilePath(chunk.metadata.filePath);
    return {
      chunk_id: chunk.id,
      file_path: filePath,
      start_line: chunk.metadata.startLine,
      end_line: chunk.metadata.endLine,
      language: chunk.metadata.language ?? "",
      kind: chunk.metadata.kind ?? "",
      role: chunk.metadata.role ?? "",
      quirk_type: chunk.metadata.quirkType ?? "",
      tags: chunk.metadata.tags ? JSON.stringify(chunk.metadata.tags) : "",
      content: chunk.content,
      description: chunk.description ?? "",
      embedding: l2Normalize(chunk.embedding),
      epoch,
      is_deleted: 0,
    };
  }

  private tombstoneRow(
    filePath: string,
    chunkId: string,
    epoch: number,
    embedding: number[],
  ): ChunkRow {
    // The ANN index rejects rows whose vector length differs from its DDL
    // dimension and rejects empty arrays. A tombstone reuses the superseded
    // row's vector (FINAL removes it from results); the fallback unit vector
    // only covers legacy/corrupt rows without one.
    let vector: number[] = [];
    if (this.opts.ann === "hnsw") {
      if (embedding.length === this.dimensions) {
        vector = embedding;
      } else {
        vector = new Array<number>(this.dimensions).fill(0);
        vector[0] = 1;
      }
    }
    return {
      chunk_id: chunkId,
      file_path: filePath,
      start_line: 0,
      end_line: 0,
      language: "",
      kind: "",
      role: "",
      quirk_type: "",
      tags: "",
      content: "",
      description: "",
      embedding: vector,
      epoch,
      is_deleted: 1,
    };
  }

  /** Remove all chunks for a file (tombstones; no table mutation). */
  async deleteByFilePath(filePath: string): Promise<void> {
    await this.withWriteLock(async () => {
      await this.ensureSchema();
      const epoch = this.currentEpoch();
      const normalized = filePath.startsWith(QUIRK_FILE_PREFIX)
        ? filePath
        : normalizeFilePath(filePath);
      const oldRows = await this.select<{ chunk_id: string; embedding: number[] }>(
        `SELECT chunk_id, embedding FROM ${this.table(this.opts.chunksTable)} FINAL ` +
        "WHERE epoch = {epoch:UInt64} AND file_path = {path:String}",
        { epoch, path: normalized },
      );
      if (oldRows.length === 0) return;
      const client = await this.getClient();
      await client.insert({
        table: this.insertTable(this.opts.chunksTable),
        values: oldRows.map((row) => this.tombstoneRow(normalized, row.chunk_id, epoch, row.embedding ?? [])),
        format: "JSONEachRow",
      });
    });
  }

  /** Make every stored chunk invisible (bumps the active epoch). */
  async clear(): Promise<void> {
    await this.withWriteLock(async () => {
      await this.ensureSchema();
      const meta = (await this.readMeta()) ?? {
        activeEpoch: 1,
        pendingEpoch: 0,
        dimension: this.dimensions,
        embeddingModel: "",
      };
      await this.writeMeta({
        ...meta,
        activeEpoch: Math.max(meta.activeEpoch, meta.pendingEpoch) + 1,
        pendingEpoch: 0,
      });
    });
  }

  // ── Rebuild (epoch promotion) ──────────────────────────────────────────

  /** Start a full rebuild into a private epoch and return the target handle. */
  async beginRebuild(): Promise<VectorStore> {
    await this.ensureSchema();
    const free = await this.select<{ free_space: string }>(
      "SELECT min(free_space) AS free_space FROM system.disks",
    );
    const freeBytes = Number(free?.[0]?.free_space ?? Number.MAX_SAFE_INTEGER);
    if (Number.isFinite(freeBytes) && freeBytes < this.opts.diskFreeFloorBytes) {
      throw new Error(
        `ClickHouse server has only ${(freeBytes / 1024 ** 3).toFixed(1)} GiB free — ` +
        `refusing a full rebuild (floor: ${(this.opts.diskFreeFloorBytes / 1024 ** 3).toFixed(1)} GiB). ` +
        "Prune superseded epochs first: run an index pass (which optimizes the store) or " +
        "OPTIMIZE TABLE … FINAL CLEANUP on the server.",
      );
    }
    const meta = (await this.readMeta()) ?? {
      activeEpoch: 1,
      pendingEpoch: 0,
      dimension: this.dimensions,
      embeddingModel: "",
    };
    const pending = Math.max(meta.activeEpoch, meta.pendingEpoch) + 1;
    await this.writeMeta({ ...meta, pendingEpoch: pending });
    return new ClickHouseStore(this.opts, this.dimensions, pending);
  }

  /** Make the rebuild target visible in one atomic `_meta` write. */
  async promoteRebuild(): Promise<void> {
    await this.ensureSchema();
    const meta = await this.readMeta();
    if (!meta || meta.pendingEpoch <= 0) return;
    await this.writeMeta({
      ...meta,
      activeEpoch: meta.pendingEpoch,
      pendingEpoch: 0,
      // The rebuild may have been triggered by an embedding-model change, so
      // the promoted epoch defines the store's dimension from now on.
      dimension: this.dimensions,
      embeddingModel: this.opts.embeddingModel,
    });
  }

  /** Abandon the rebuild target; its rows become unreachable orphans. */
  async discardRebuild(): Promise<void> {
    await this.ensureSchema();
    const meta = await this.readMeta();
    if (!meta || meta.pendingEpoch <= 0) return;
    await this.writeMeta({ ...meta, pendingEpoch: 0 });
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  async search(embedding: number[], topK: number): Promise<SearchResult[]> {
    return this.searchWithFilter(embedding, topK);
  }

  async searchWithFilter(
    embedding: number[],
    topK: number,
    filter?: MetadataFilter,
  ): Promise<SearchResult[]> {
    try {
      await this.ensureSchema();
      const storeDimension = await this.getVectorDimension();
      if (storeDimension !== undefined && embedding.length !== storeDimension) {
        console.warn(
          `[clickhouse] searchWithFilter: query embedding dimension ${embedding.length} != ` +
          `store dimension ${storeDimension} — returning empty. Rebuild with 'opencode-rag index --force'.`,
        );
        return [];
      }
      const epoch = this.currentEpoch();
      const requestedK = Math.max(1, Math.floor(topK));
      const maxAnnLimit = 1000; // max_limit_for_vector_search_queries default (26.x)
      if (this.opts.ann === "hnsw" && requestedK > maxAnnLimit) {
        console.warn(
          `[clickhouse] topK ${requestedK} exceeds the ANN query limit ${maxAnnLimit} — using ${maxAnnLimit}.`,
        );
      }
      const limit = this.opts.ann === "hnsw" ? Math.min(requestedK, maxAnnLimit) : requestedK;
      const params: Record<string, unknown> = { epoch, k: limit };
      const where = [`epoch = {epoch:UInt64}`];
      if (filter?.languages?.length) {
        where.push("language IN ({languages:Array(String)})");
        params.languages = filter.languages;
      }
      if (filter?.kinds?.length) {
        where.push("kind IN ({kinds:Array(String)})");
        params.kinds = filter.kinds;
      }
      if (filter?.pathPatterns?.length) {
        const likes = filter.pathPatterns.map((pattern, index) => {
          params[`path${index}`] = globToLike(pattern);
          return `file_path LIKE {path${index}:String}`;
        });
        where.push(`(${likes.join(" OR ")})`);
      }
      if (filter?.fileExtensions?.length) {
        const exts = normalizeFileExtensions(filter.fileExtensions);
        const likes = exts.map((ext, index) => {
          params[`ext${index}`] = `%${ext}`;
          return `file_path LIKE {ext${index}:String}`;
        });
        where.push(`(${likes.join(" OR ")})`);
      }

      const hasFilter = where.length > 1;
      // Filtered ANN searches post-filter the candidate list; over-fetch so a
      // selective path/language filter cannot starve the result set.
      const settings = this.opts.ann === "hnsw"
        ? {
            vector_search_with_rescoring: this.opts.annWithRescoring ? 1 : 0,
            vector_search_index_fetch_multiplier: hasFilter ? this.opts.annFetchMultiplier : 1,
          }
        : undefined;
      const rows = await this.select<ChunkRow & { dist: number }>(
        `SELECT chunk_id, file_path, start_line, end_line, language, kind, role, quirk_type, ` +
        "tags, content, description, epoch, is_deleted, " +
        "cosineDistance(embedding, {q:Array(Float32)}) AS dist " +
        `FROM ${this.table(this.opts.chunksTable)} FINAL ` +
        `WHERE ${where.join(" AND ")} ORDER BY dist ASC LIMIT {k:UInt32}`,
        { ...params, q: embedding },
        settings,
      );
      return rows.map((row) => this.rowToSearchResult(row));
    } catch (err) {
      // Mirror LanceDB: a failed search logs and returns no results rather
      // than crashing the plugin's retrieval path.
      console.warn(`[clickhouse] searchWithFilter failed (returning []): ${(err as Error).message}`);
      return [];
    }
  }

  private rowToSearchResult(row: ChunkRow & { dist?: number }): SearchResult {
    let tags: string[] | undefined;
    try {
      tags = row.tags ? (JSON.parse(row.tags) as string[]) : undefined;
    } catch {
      tags = undefined;
    }
    const rawDistance = typeof row.dist === "number" && Number.isFinite(row.dist) ? row.dist : 2;
    return {
      // ClickHouse cosineDistance is 1 - cosine similarity (range 0..2), the
      // same domain as LanceDB's cosine distance; normalize identically so
      // fusion/minScore stay comparable across backends.
      score: Math.min(1, Math.max(0, 1 - rawDistance / 2)),
      chunk: {
        id: row.chunk_id,
        content: row.content,
        description: row.description ?? "",
        metadata: {
          filePath: row.file_path,
          startLine: row.start_line,
          endLine: row.end_line,
          language: row.language,
          kind: row.kind || undefined,
          role: row.role === "source" || row.role === "test" || row.role === "doc"
            ? (row.role as Chunk["metadata"]["role"])
            : undefined,
          quirkType: row.quirk_type || undefined,
          tags,
        },
      },
    };
  }

  async count(): Promise<number> {
    await this.ensureSchema();
    const rows = await this.select<{ c: string }>(
      `SELECT count() AS c FROM ${this.table(this.opts.chunksTable)} FINAL WHERE epoch = {epoch:UInt64}`,
      { epoch: this.currentEpoch() },
    );
    return Number(rows[0]?.c ?? 0);
  }

  async getFilePaths(): Promise<string[]> {
    await this.ensureSchema();
    const rows = await this.select<{ file_path: string }>(
      `SELECT DISTINCT file_path FROM ${this.table(this.opts.chunksTable)} FINAL ` +
      "WHERE epoch = {epoch:UInt64} ORDER BY file_path",
      { epoch: this.currentEpoch() },
    );
    return rows.map((row) => row.file_path);
  }

  async listFiles(): Promise<FileSummary[]> {
    await this.ensureSchema();
    const rows = await this.select<{ file_path: string; language: string; chunk_count: string }>(
      `SELECT file_path, any(language) AS language, count() AS chunk_count ` +
      `FROM ${this.table(this.opts.chunksTable)} FINAL ` +
      "WHERE epoch = {epoch:UInt64} GROUP BY file_path ORDER BY file_path",
      { epoch: this.currentEpoch() },
    );
    return rows.map((row) => ({
      filePath: row.file_path,
      language: row.language,
      chunkCount: Number(row.chunk_count),
    }));
  }

  async getChunks(offset: number, limit: number): Promise<ChunkSummary[]> {
    await this.ensureSchema();
    const rows = await this.select<ChunkRow>(
      `SELECT ${this.summaryColumns()} FROM ${this.table(this.opts.chunksTable)} FINAL ` +
      "WHERE epoch = {epoch:UInt64} ORDER BY file_path, start_line " +
      "LIMIT {limit:UInt32} OFFSET {offset:UInt32}",
      {
        epoch: this.currentEpoch(),
        limit: Math.max(1, Math.floor(limit)),
        offset: Math.max(0, Math.floor(offset)),
      },
    );
    return rows.map((row) => this.rowToSummary(row));
  }

  async getChunksFiltered(
    offset: number,
    limit: number,
    lang?: string,
    filePrefix?: string,
  ): Promise<{ chunks: ChunkSummary[]; total: number }> {
    await this.ensureSchema();
    const params: Record<string, unknown> = { epoch: this.currentEpoch() };
    const where = ["epoch = {epoch:UInt64}"];
    if (lang) {
      where.push("language = {lang:String}");
      params.lang = lang;
    }
    if (filePrefix) {
      where.push("file_path LIKE {prefix:String}");
      params.prefix = `${filePrefix}%`;
    }
    const whereSql = where.join(" AND ");
    const [rows, totals] = await Promise.all([
      this.select<ChunkRow>(
        `SELECT ${this.summaryColumns()} FROM ${this.table(this.opts.chunksTable)} FINAL ` +
        `WHERE ${whereSql} ORDER BY file_path, start_line ` +
        "LIMIT {limit:UInt32} OFFSET {offset:UInt32}",
        {
          ...params,
          limit: Math.max(1, Math.min(Math.floor(limit), 1000)),
          offset: Math.max(0, Math.floor(offset)),
        },
      ),
      this.select<{ c: string }>(
        `SELECT count() AS c FROM ${this.table(this.opts.chunksTable)} FINAL WHERE ${whereSql}`,
        params,
      ),
    ]);
    return {
      chunks: rows.map((row) => this.rowToSummary(row)),
      total: Number(totals[0]?.c ?? 0),
    };
  }

  async getChunkById(id: string): Promise<ChunkSummary | undefined> {
    await this.ensureSchema();
    const rows = await this.select<ChunkRow>(
      `SELECT ${this.summaryColumns()} FROM ${this.table(this.opts.chunksTable)} FINAL ` +
      "WHERE epoch = {epoch:UInt64} AND chunk_id = {id:String} LIMIT 1",
      { epoch: this.currentEpoch(), id },
    );
    return rows[0] ? this.rowToSummary(rows[0]) : undefined;
  }

  async getChunksByIds(ids: string[]): Promise<ChunkSummary[]> {
    const bounded = ids.slice(0, 100);
    if (bounded.length === 0) return [];
    await this.ensureSchema();
    const rows = await this.select<ChunkRow>(
      `SELECT ${this.summaryColumns()} FROM ${this.table(this.opts.chunksTable)} FINAL ` +
      "WHERE epoch = {epoch:UInt64} AND chunk_id IN ({ids:Array(String)})",
      { epoch: this.currentEpoch(), ids: bounded },
    );
    return rows.map((row) => this.rowToSummary(row));
  }

  async getChunksWithEmbeddings(limit: number): Promise<{
    id: string;
    filePath: string;
    language: string;
    startLine: number;
    endLine: number;
    description: string;
    embedding: number[];
  }[]> {
    await this.ensureSchema();
    const rows = await this.select<ChunkRow>(
      "SELECT chunk_id, file_path, language, start_line, end_line, description, embedding " +
      `FROM ${this.table(this.opts.chunksTable)} FINAL ` +
      "WHERE epoch = {epoch:UInt64} ORDER BY file_path, start_line LIMIT {limit:UInt32}",
      { epoch: this.currentEpoch(), limit: Math.max(1, Math.floor(limit)) },
    );
    return rows.map((row) => ({
      id: row.chunk_id,
      filePath: row.file_path,
      language: row.language,
      startLine: row.start_line,
      endLine: row.end_line,
      description: row.description ?? "",
      embedding: Array.from(row.embedding ?? []),
    }));
  }

  async getChunksByFilePath(filePath: string): Promise<Chunk[]> {
    await this.ensureSchema();
    const normalized = filePath.startsWith(QUIRK_FILE_PREFIX)
      ? filePath
      : normalizeFilePath(filePath);
    const rows = await this.select<ChunkRow>(
      `SELECT ${this.summaryColumns()}, embedding FROM ${this.table(this.opts.chunksTable)} FINAL ` +
      "WHERE epoch = {epoch:UInt64} AND file_path = {path:String} ORDER BY start_line",
      { epoch: this.currentEpoch(), path: normalized },
    );
    return rows.map((row) => ({
      id: row.chunk_id,
      content: row.content,
      description: row.description ?? "",
      embedding: Array.from(row.embedding ?? []),
      metadata: {
        filePath: row.file_path,
        startLine: row.start_line,
        endLine: row.end_line,
        language: row.language,
        kind: row.kind || undefined,
        role: row.role === "source" || row.role === "test" || row.role === "doc"
          ? (row.role as Chunk["metadata"]["role"])
          : undefined,
        quirkType: row.quirk_type || undefined,
        tags: this.parseTags(row.tags),
      },
    }));
  }

  private summaryColumns(): string {
    return "chunk_id, file_path, start_line, end_line, language, kind, role, quirk_type, tags, content, description";
  }

  private parseTags(raw: string): string[] | undefined {
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return undefined;
    }
  }

  private rowToSummary(row: ChunkRow): ChunkSummary {
    return {
      id: row.chunk_id,
      filePath: row.file_path,
      language: row.language,
      startLine: row.start_line,
      endLine: row.end_line,
      content: row.content,
      description: row.description ?? "",
      kind: row.kind ?? "",
      role: row.role ?? "",
      quirkType: row.quirk_type ?? "",
      tags: row.tags ?? "",
    };
  }

  async getVectorDimension(): Promise<number | undefined> {
    await this.ensureSchema();
    const meta = await this.readMeta();
    return meta?.dimension;
  }

  /**
   * Read the stored dimension without creating anything. Used by the
   * bootstrap dimension probe, which must stay read-only for `status`.
   */
  async peekDimension(): Promise<number | undefined> {
    const rows = await this.select<{ name: string }>(
      "SELECT name FROM system.tables WHERE database = {db:String} AND name = {table:String} LIMIT 1",
      { db: this.opts.database, table: this.opts.stateTable },
    );
    if (rows.length === 0) return undefined;
    const meta = await this.readMeta();
    return meta?.dimension;
  }

  async checkIntegrity(): Promise<boolean> {
    try {
      await this.select<{ ok: number }>("SELECT 1 AS ok");
      return true;
    } catch {
      return false;
    }
  }

  /** Whether the HNSW vector index is present on the chunks table (diagnostics). */
  async hasVectorIndex(): Promise<boolean> {
    try {
      await this.ensureSchema();
      const rows = await this.select<{ name: string }>(
        "SELECT name FROM system.data_skipping_indices " +
        "WHERE database = {db:String} AND table = {table:String} AND name = {name:String} LIMIT 1",
        { db: this.opts.database, table: this.opts.chunksTable, name: "vec_idx" },
      );
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  async optimize(options?: {
    aggressive?: boolean;
    skipIndex?: boolean;
    logger?: (message: string) => void;
  }): Promise<void> {
    try {
      await this.ensureSchema();
      const table = this.table(this.opts.chunksTable);
      await this.command(`OPTIMIZE TABLE ${table} FINAL`);
      // Old epochs are already invisible (all reads filter on the active
      // epoch); pruning them only reclaims disk. Never let a cleanup failure
      // break an index pass.
      const meta = await this.readMeta();
      if (meta && (options?.aggressive || meta.activeEpoch > 1)) {
        await this.command(
          // Only superseded epochs (`< active`). A pending rebuild epoch is
          // `> active` and must survive an optimize run.
          `ALTER TABLE ${table} DELETE WHERE epoch < {epoch:UInt64}`,
          { epoch: meta.activeEpoch },
        );
        options?.logger?.(`[clickhouse] Pruned chunks from superseded epochs (active ${meta.activeEpoch}).`);
      }
      await this.command(`OPTIMIZE TABLE ${this.table(this.opts.stateTable)} FINAL`);
    } catch (err) {
      options?.logger?.(`[clickhouse] optimize failed: ${(err as Error).message}`);
    }
  }

  // ── Lease (advisory single-writer coordination) ────────────────────────

  private async readLeaseRow(kind: string): Promise<{ owner: string; expiresAt: number } | undefined> {
    const row = await this.readState(`${LEASE_NAME}:${kind}`);
    if (!row?.data) return undefined;
    try {
      const parsed = JSON.parse(row.data) as { owner?: string; expiresAt?: number };
      if (!parsed.owner) return undefined;
      return { owner: parsed.owner, expiresAt: Number(parsed.expiresAt ?? 0) };
    } catch {
      return undefined;
    }
  }

  async acquireLease(owner: string, kind: string, ttlMs: number): Promise<boolean> {
    await this.ensureSchema();
    const current = await this.readLeaseRow(kind);
    const now = Date.now();
    if (current && current.owner !== owner && current.expiresAt > now) return false;
    await this.writeState(
      `${LEASE_NAME}:${kind}`,
      JSON.stringify({ owner, expiresAt: now + ttlMs }),
    );
    // Read-back confirmation: ClickHouse has no compare-and-swap, so two
    // racing writers can both insert. The loser sees the winner here.
    await new Promise((resolve) => setTimeout(resolve, 120));
    const confirmed = await this.readLeaseRow(kind);
    return confirmed?.owner === owner;
  }

  async renewLease(owner: string, kind: string, ttlMs: number): Promise<boolean> {
    await this.ensureSchema();
    const current = await this.readLeaseRow(kind);
    if (current && current.owner !== owner && current.expiresAt > Date.now()) return false;
    await this.writeState(
      `${LEASE_NAME}:${kind}`,
      JSON.stringify({ owner, expiresAt: Date.now() + ttlMs }),
    );
    return true;
  }

  async releaseLease(owner: string, kind: string): Promise<void> {
    try {
      await this.ensureSchema();
      const current = await this.readLeaseRow(kind);
      if (current?.owner !== owner) return;
      await this.writeState(
        `${LEASE_NAME}:${kind}`,
        JSON.stringify({ owner: "", expiresAt: 0 }),
      );
    } catch {
      // Best effort — an expired lease is reclaimed by the next writer.
    }
  }

  async getLease(kind: string): Promise<{ owner: string; expiresAt: number } | undefined> {
    try {
      await this.ensureSchema();
      const lease = await this.readLeaseRow(kind);
      if (!lease || lease.expiresAt <= Date.now()) return undefined;
      return lease;
    } catch {
      return undefined;
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.schemaReady = null;
    this.activeEpoch = null;
    if (client) {
      try {
        await client.close();
      } catch {
        // Closing a pooled HTTP client is best effort.
      }
    }
  }

  async reopen(): Promise<void> {
    await this.close();
  }

  /**
   * Drop this project's tables. Used by `opencode-rag clear --hard` tooling and
   * by tests; irreversible. Other namespaces are untouched.
   */
  async dropProjectTables(): Promise<void> {
    await this.ensureSchema();
    await this.command(`DROP TABLE IF EXISTS ${this.table(this.opts.chunksTable)}`);
    await this.command(`DROP TABLE IF EXISTS ${this.table(this.opts.stateTable)}`);
    this.schemaReady = null;
    this.activeEpoch = null;
  }
}
