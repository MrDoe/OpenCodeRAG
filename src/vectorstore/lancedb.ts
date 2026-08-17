/**
 * @fileoverview Persistent LanceDB-backed vector store with corruption recovery and atomic swap support.
 */
import * as lancedb from "@lancedb/lancedb";
import type { Connection, Table, Version } from "@lancedb/lancedb";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { VectorStore, Chunk, ChunkSummary, SearchResult, MetadataFilter } from "../core/interfaces.js";
import { normalizeFilePath, manifestPathFor } from "../core/manifest.js";
import { normalizeFileExtensions, matchesFileExtension } from "../core/filters.js";

const TABLE_NAME = "chunks";

const QUERY_COLUMNS = ["id", "content", "description", "filePath", "startLine", "endLine", "language", "kind", "quirkType", "tags"];

/**
 * Upper bound for the number of failed index-creation attempts per process.
 * Beyond this the repair gives up for the process lifetime instead of
 * retraining the IVF index on every optimize/search call (each attempt runs
 * a full KMeans training pass and logs "partition N is empty, skipping").
 */
const MAX_INDEX_REPAIR_ATTEMPTS = 3;

/**
 * Upper bound for stale index-version directories under `chunks.lance/_indices`.
 * Healthy stores have one per built index; a store whose index registration
 * keeps failing accumulates one directory per attempt and never converges.
 * Above this threshold the repair refuses to create yet another version and
 * instead tells the user to rebuild the store.
 */
const MAX_STALE_INDEX_VERSIONS = 40;

/** Minimal warning sink for store diagnostics (defaults to console.warn). */
export type StoreWarn = (message: string) => void;

/**
 * Count index-version directories in a LanceDB table directory. Each
 * `createIndex` writes a new `<uuid>/` directory under `_indices`; a healthy
 * store holds one per built index, while a store whose index commits fail
 * accumulates one per attempt (and eventually degrades / corrupts).
 *
 * @param tablePath - Filesystem path of the table directory (e.g. `.../chunks.lance`).
 * @returns The number of index-version directories, or 0 when unavailable.
 */
export function countIndexVersionDirs(tablePath: string): number {
  try {
    const entries = fsSync.readdirSync(path.join(tablePath, "_indices"), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

/**
 * L2-normalize a vector to unit length. Cosine models require unit vectors
 * for the dot product to equal cosine similarity.
 */
export function l2Normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

/**
 * Check whether an error is a LanceDB corruption error (table not found / broken).
 * @param err - The error to inspect.
 * @returns True if the error matches a known corruption pattern.
 */
export function isCorruptionError(err: unknown): boolean {
  if (err instanceof Error) {
    return (
      (err.message.includes("Not found") &&
        err.message.includes(".lance") &&
        err.message.includes("lance error")) ||
      // Database has an incompatible transaction (e.g. a Restore from a prior
      // version that conflicts with new Appends).  This is a recoverable
      // corruption — tryRepair() iterates prior versions to find a consistent one.
      (err.message.includes("Incompatible transaction") &&
        err.message.includes("version"))
    );
  }
  return false;
}

/**
 * Check whether an error is a LanceDB transient transaction conflict
 * (e.g. "Incompatible transaction: This Append transaction is incompatible
 * with concurrent transaction Restore at version ...").
 *
 * These are recoverable by retrying after the conflicting transaction finishes.
 * Cross-process writes are the primary source; in-process writes are serialized
 * by the write lock.
 *
 * @param err - The error to inspect.
 * @returns True if the error matches a transient transaction conflict.
 */
export function isTransientConflictError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.message.includes("Incompatible transaction");
  }
  return false;
}

/**
 * Atomically replace one LanceDB store directory with another.
 * Swaps the real directory with a temporary one that was built during a rebuild.
 * The old directory is moved to `${realPath}_old` and deleted asynchronously.
 *
 * @param tempPath - Path to the newly built store (source).
 * @param realPath - Path to the current store (destination, will be replaced).
 */
export async function swapStoreDirectories(tempPath: string, realPath: string): Promise<void> {
  const oldPath = `${realPath}_old`;
  // Move current real → old (so we can recover if the rename fails)
  try {
    await fs.rename(realPath, oldPath);
  } catch {
    // realPath may not exist yet (first-time build)
  }
  try {
    await fs.rename(tempPath, realPath);
  } catch (err) {
    // Rename failed — try to restore old back
    try { await fs.rename(oldPath, realPath); } catch {}
    throw err;
  }
  // Best-effort async cleanup of old directory
  fs.rm(oldPath, { recursive: true, force: true }).catch(() => {});
}

/** Internal row shape stored in the LanceDB table. */
interface ChunkRow {
  id: string;
  content: string;
  description: string;
  embedding: number[];
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  kind: string;
  quirkType: string;
  tags: string;
}

/**
 * A single file's chunk payload for a bulk store write.
 * `dedup: true` removes prior-revision rows for the same file path that are
 * not part of this write; `dedup: false` appends only (safe when writing into
 * a freshly-created store where no rows can collide).
 */
export interface BulkChunkWrite {
  chunks: Chunk[];
  dedup: boolean;
}

/**
 * A LanceDB-backed vector store with persistent on-disk storage, vector search,
 * and chunk metadata queries. Supports automatic corruption recovery by falling
 * back to prior table versions or dropping and rebuilding the table.
 */
export class LanceDbStore implements VectorStore {
  private dbPath: string;
  private readonly vectorDimension: number;
  private db: Connection | null = null;
  private table: Table | null = null;
  private tableInit: Promise<Table> | null = null;
  private writeLock = Promise.resolve<void>(void 0);
  /**
   * Memoized once-per-process index-metric repair. Stores built by versions
   * before the cosine search switch carry an IVF index trained with the
   * default L2 metric, which makes every cosine query log
   * "Requested metric Cosine is incompatible with index metric L2" and fall
   * back to brute-force. This repairs that stale index on first search.
   */
  private indexRepairPromise: Promise<void> | null = null;
  /** Consecutive failed repair attempts — bounded so a broken store cannot retrain forever. */
  private indexRepairFailures = 0;

  /**
   * Execute an async function under an exclusive write lock.
   *
   * All write operations (addChunks, deleteByFilePath, optimize, tryRepair) must
   * go through this helper to prevent concurrent LanceDB transactions from
   * conflicting (e.g. Append vs Restore, which produces the "Incompatible
   * transaction" error).
   *
   * The lock is a Promise chain: each caller chains onto `this.writeLock` and
   * sets it to a new promise that resolves only when its operation finishes
   * (or throws).  This guarantees FIFO serialization without any busy-waiting
   * or timers.
   *
   * @param fn - The async function to execute under the lock.
   * @returns The result of `fn`.
   */
  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.writeLock;
    let release: () => void = () => {};
    this.writeLock = new Promise<void>((resolve) => { release = resolve; });
    await prev;
    try {
      return await fn();
    } catch (err) {
      // Cross-process transient conflict (e.g. CLI vs plugin):
      // wait briefly and retry once, still under the same lock hold.
      if (isTransientConflictError(err)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return await fn();
      }
      throw err;
    } finally {
      release();
    }
  }

  /**
   * @param dbPath - Filesystem path to the LanceDB database directory.
   * @param vectorDimension - Dimension of the embedding vectors. Default: 384.
   */
  constructor(dbPath: string, vectorDimension: number = 384) {
    this.dbPath = dbPath;
    this.vectorDimension = vectorDimension;
  }

  private async getDb(): Promise<Connection> {
    if (!this.db) {
      this.db = await lancedb.connect(this.dbPath);
    }
    return this.db;
  }

  private async getTable(): Promise<Table> {
    if (this.table) return this.table;

    if (this.tableInit) return this.tableInit;

    this.tableInit = this.initTable();
    try {
      return await this.tableInit;
    } finally {
      this.tableInit = null;
    }
  }

  private async initTable(): Promise<Table> {
    const db = await this.getDb();
    const tableNames = await db.tableNames();

    if (tableNames.includes(TABLE_NAME)) {
      this.table = await db.openTable(TABLE_NAME);
      if (await this.tableHasDescriptionColumn()) {
        await this.migrateNewColumns();
        return this.table;
      }
      // Schema missing 'description' column -- try to add it gracefully first.
      try {
        await this.table.addColumns([{ name: "description", valueSql: "''" }]);
        console.warn("[lancedb] Added missing 'description' column to existing table.");
        await this.migrateNewColumns();
        return this.table;
      } catch {
        console.warn(
          "[lancedb] Could not auto-add missing 'description' column. " +
          "Run 'opencode-rag index --force' to rebuild the index with the correct schema."
        );
        // Fall through to drop + recreate below
      }
      try {
        const oldCount = await this.table.countRows();
        if (oldCount > 0) {
          console.warn(
            `[lancedb] Dropping table with ${oldCount} rows — schema missing 'description' column. ` +
            `Clearing manifest so index will rebuild.`
          );
          try {
            const manifestPath = manifestPathFor(this.dbPath);
            await fs.unlink(manifestPath).catch(() => {});
          } catch {
            // manifest not found or permission error — pipeline will detect the mismatch
          }
        }
      } catch {
      }
      await db.dropTable(TABLE_NAME).catch(() => {});
      this.table = null;
    }

    const seedRow: ChunkRow = {
      id: "__seed__",
      content: "",
      description: "",
      embedding: new Array(this.vectorDimension).fill(0),
      filePath: "",
      startLine: 0,
      endLine: 0,
      language: "",
      kind: "",
      quirkType: "",
      tags: "",
    };

    this.table = await db.createTable({
      name: TABLE_NAME,
      data: [seedRow] as unknown as Record<string, unknown>[],
      mode: "overwrite",
    });

    const deleted = await this.table.delete('id = "__seed__"');
    if (deleted === undefined) {
      // LanceDB may not return a count; try a direct query to verify
      const leftover = await this.table.query().filter('id = "__seed__"').limit(1).toArray();
      if (leftover.length > 0) {
        console.warn("[lancedb] WARNING: seed row still present — filtering in search");
      }
    }

    return this.table;
  }

  private async tableHasDescriptionColumn(): Promise<boolean> {
    try {
      const schema = await this.table!.schema();
      return schema.fields.some((f: { name: string }) => f.name === "description");
    } catch {
      return false;
    }
  }

  private async hasColumn(name: string): Promise<boolean> {
    try {
      const schema = await this.table!.schema();
      return schema.fields.some((f: { name: string }) => f.name === name);
    } catch {
      return false;
    }
  }

  /** Add kind/quirkType/tags columns if missing from an existing table. */
  private async migrateNewColumns(): Promise<void> {
    const missing: { name: string; valueSql: string }[] = [];
    for (const col of ["kind", "quirkType", "tags"]) {
      if (!(await this.hasColumn(col))) {
        missing.push({ name: col, valueSql: "''" });
      }
    }
    if (missing.length > 0) {
      try {
        await this.table!.addColumns(missing);
        console.warn(`[lancedb] Added missing columns: ${missing.map((c) => c.name).join(", ")}`);
      } catch {
        console.warn(
          "[lancedb] Could not auto-add missing columns. " +
          "Run 'opencode-rag index --force' to rebuild the index with the correct schema."
        );
        return;
      }
    }
    await this.ensureColumnsNullable(["kind", "quirkType", "tags"]);
  }

  /**
   * Ensure that kind/quirkType/tags columns are nullable so that queries
   * with WHERE clauses on these columns do not panic on old fragments
   * written before the columns existed.
   */
  private async ensureColumnsNullable(columns: string[]): Promise<void> {
    for (const col of columns) {
      if (!(await this.hasColumn(col))) continue;
      try {
        const schema = await this.table!.schema();
        const field = schema.fields.find(
          (f: { name: string; nullable?: boolean }) => f.name === col,
        );
        if (field && field.nullable === false) {
          await this.table!.alterColumns([{ path: col, nullable: true }]);
          console.warn(`[lancedb] Made column '${col}' nullable to avoid null-fragment panics.`);
        }
      } catch {
        console.warn(`[lancedb] Could not alter nullability of column '${col}'.`);
      }
    }
  }

  /**
   * Store chunks in the LanceDB table. New rows are inserted first, then
   * old rows for the same file that are not part of this write are removed
   * in a single delete per file. This ensures no data is lost if the process
   * aborts between insert and cleanup. Automatically attempts repair on
   * corruption errors.
   *
   * When `options.dedup` is `false` the cleanup step is skipped entirely —
   * a pure append. Use this when writing into a store that provably has no
   * prior rows for these files (e.g. a freshly-created rebuild store).
   *
   * @param chunks - The chunks to add.
   * @param options - Optional write options (`dedup`, default `true`).
   */
  async addChunks(chunks: Chunk[], options?: { dedup?: boolean }): Promise<void> {
    if (chunks.length === 0) return;
    const dedup = options?.dedup ?? true;
    await this.withWriteLock(async () => {
      try {
        await this.addChunksInternal(chunks, dedup);
      } catch (err) {
        if (isCorruptionError(err) && await this.tryRepair()) {
          await this.addChunksInternal(chunks, dedup);
          return;
        }
        throw err;
      }
    });
  }

  /**
   * Store chunks for many files in a single transaction: one `table.add`
   * across all items, then one `table.delete` per item that needs dedup.
   * This collapses what used to be a per-file add + per-startLine deletes
   * (K+2 LanceDB versions per file) into ~1 + M versions per batch.
   *
   * @param items - Per-file chunk payloads with their dedup flags.
   */
  async addChunksBulk(items: BulkChunkWrite[]): Promise<void> {
    const active = items.filter((item) => item.chunks.length > 0);
    if (active.length === 0) return;
    await this.withWriteLock(async () => {
      try {
        await this.addChunksBulkInternal(active);
      } catch (err) {
        if (isCorruptionError(err) && await this.tryRepair()) {
          await this.addChunksBulkInternal(active);
          return;
        }
        throw err;
      }
    });
  }

  /** Map a chunk to its internal row shape, or null if it has no embedding. */
  private chunkToRow(c: Chunk): ChunkRow | null {
    if (!c.embedding || c.embedding.length === 0) return null;
    return {
      id: c.id,
      content: c.content,
      description: c.description ?? "",
      embedding: l2Normalize(c.embedding),
      filePath: normalizeFilePath(c.metadata.filePath),
      startLine: c.metadata.startLine,
      endLine: c.metadata.endLine,
      language: c.metadata.language,
      kind: c.metadata.kind ?? "",
      quirkType: c.metadata.quirkType ?? "",
      tags: c.metadata.tags ? JSON.stringify(c.metadata.tags) : "",
    };
  }

  /** Group new rows by file path for dedup deletes. */
  private rowsByFilePath(rows: ChunkRow[]): Map<string, string[]> {
    const byFile = new Map<string, string[]>();
    for (const row of rows) {
      const ids = byFile.get(row.filePath);
      if (ids) {
        ids.push(row.id);
      } else {
        byFile.set(row.filePath, [row.id]);
      }
    }
    return byFile;
  }

  private async addChunksInternal(chunks: Chunk[], dedup = true): Promise<void> {
    const table = await this.getTable();
    const rows = chunks
      .map((c) => this.chunkToRow(c))
      .filter((r): r is ChunkRow => r !== null);

    if (rows.length === 0) return;

    // INSERT FIRST: data is safely stored before any delete
    await table.add(rows as unknown as Record<string, unknown>[]);

    if (!dedup) return;

    // THEN DEDUP: one delete per file removes prior-revision rows at the
    // same (filePath, startLine) positions AND stale startLines, while the
    // NOT IN clause preserves the newly inserted rows (so multiple new IDs
    // sharing a startLine never delete each other).  Insert-first ordering
    // keeps an abort between insert and delete from losing data.
    const byFile = this.rowsByFilePath(rows);
    for (const [filePath, ids] of byFile) {
      const escapedPath = filePath.replace(/'/g, "''");
      const idList = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(", ");
      await table.delete(
        `filePath = '${escapedPath}' AND id NOT IN (${idList})`,
      );
    }
  }

  private async addChunksBulkInternal(items: BulkChunkWrite[]): Promise<void> {
    const table = await this.getTable();
    const allRows: ChunkRow[] = [];
    const dedupByFile = new Map<string, string[]>();

    for (const item of items) {
      const rows = item.chunks
        .map((c) => this.chunkToRow(c))
        .filter((r): r is ChunkRow => r !== null);
      if (rows.length === 0) continue;
      allRows.push(...rows);
      if (item.dedup) {
        for (const [filePath, ids] of this.rowsByFilePath(rows)) {
          const existing = dedupByFile.get(filePath);
          if (existing) {
            existing.push(...ids);
          } else {
            dedupByFile.set(filePath, [...ids]);
          }
        }
      }
    }

    if (allRows.length === 0) return;

    // INSERT FIRST (single add for the whole batch), then per-file dedup
    await table.add(allRows as unknown as Record<string, unknown>[]);

    for (const [filePath, ids] of dedupByFile) {
      const escapedPath = filePath.replace(/'/g, "''");
      const idList = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(", ");
      await table.delete(
        `filePath = '${escapedPath}' AND id NOT IN (${idList})`,
      );
    }
  }

  /**
   * Perform ANN (approximate nearest neighbor) search using LanceDB's native vector index.
   * Returns results scored as cosine similarity (0-1). Falls back to repair on corruption.
   * @param embedding - The query embedding vector.
   * @param topK - Maximum number of results to return.
   * @returns An array of search results sorted by descending score.
   */
  async search(embedding: number[], topK: number): Promise<SearchResult[]> {
    return this.searchWithFilter(embedding, topK);
  }

  async searchWithFilter(embedding: number[], topK: number, filter?: MetadataFilter): Promise<SearchResult[]> {
    try {
      // Guard against dimension mismatch BEFORE the native call — LanceDB
      // throws a cryptic error that used to be swallowed into "no results".
      if (embedding.length !== this.vectorDimension) {
        console.warn(
          `[lancedb] searchWithFilter: query embedding dimension ${embedding.length} != store dimension ${this.vectorDimension} — returning empty`,
        );
        return [];
      }
      return await this.searchInternal(embedding, topK, filter);
    } catch (err) {
      if (isCorruptionError(err)) {
        const repaired = await this.withWriteLock(() => this.tryRepair());
        if (repaired) {
          return this.searchInternal(embedding, topK, filter);
        }
        console.warn(`[lancedb] searchWithFilter: repair failed: ${(err as Error).message}`);
        return [];
      }
      // Never silently mask non-corruption failures as "no results" —
      // that hides provider outages and store bugs from every caller.
      console.warn(`[lancedb] searchWithFilter failed (returning []): ${(err as Error).message}`);
      return [];
    }
  }

  private rowToSearchResult(row: Record<string, unknown>): SearchResult {
    let tags: string[] | undefined;
    try {
      const raw = row.tags as string;
      if (raw) tags = JSON.parse(raw) as string[];
    } catch {
      tags = undefined;
    }
    return {
      score: Math.min(1, Math.max(0, 1 - ((row._distance as number) ?? 0) / 2)),
      chunk: {
        id: row.id as string,
        content: row.content as string,
        description: (row.description as string) ?? "",
        metadata: {
          filePath: row.filePath as string,
          startLine: row.startLine as number,
          endLine: row.endLine as number,
          language: row.language as string,
          kind: (row.kind as string) || undefined,
          quirkType: (row.quirkType as string) || undefined,
          tags,
        },
      },
    };
  }

  /**
   * List all distinct file paths stored in the index, along with their language and chunk count.
   * @returns An array of file summaries sorted by file path.
   */
  async listFiles(): Promise<{ filePath: string; language: string; chunkCount: number }[]> {
    return this.withCorruptionRecovery(async () => {
      const table = await this.getTable();
      const count = await table.countRows();
      if (count === 0) return [];

      const rows = await table.query().select(["filePath", "language"]).limit(count).toArray();
      const fileMap = new Map<string, { language: string; chunkCount: number }>();
      for (const row of rows) {
        const filePath = row.filePath as string;
        const language = row.language as string;
        const existing = fileMap.get(filePath);
        if (existing) {
          existing.chunkCount++;
        } else {
          fileMap.set(filePath, { language, chunkCount: 1 });
        }
      }
      return Array.from(fileMap.entries())
        .map(([filePath, info]) => ({ filePath, ...info }))
        .sort((a, b) => a.filePath.localeCompare(b.filePath));
    });
  }

  /**
   * Retrieve all chunks for a specific file path, sorted by start line.
   * @param filePath - The file path to query.
   * @returns An array of chunks for that file.
   */
  async getChunksByFilePath(filePath: string): Promise<Chunk[]> {
    return this.withCorruptionRecovery(async () => {
      const table = await this.getTable();
      const normalizedPath = normalizeFilePath(filePath).replace(/'/g, "''");
      const rows = await table.query()
        .select(QUERY_COLUMNS)
        .where(`filePath = '${normalizedPath}'`)
        .toArray();

      return rows
        .map((row: Record<string, unknown>) => {
          let tags: string[] | undefined;
          try {
            const raw = row.tags as string;
            if (raw) tags = JSON.parse(raw) as string[];
          } catch {
            tags = undefined;
          }
          return {
            id: row.id as string,
            content: row.content as string,
            description: (row.description as string) ?? "",
            metadata: {
              filePath: row.filePath as string,
              startLine: row.startLine as number,
              endLine: row.endLine as number,
              language: row.language as string,
              kind: (row.kind as string) || undefined,
              quirkType: (row.quirkType as string) || undefined,
              tags,
            },
          };
        })
        .sort((a, b) => a.metadata.startLine - b.metadata.startLine);
    });
  }

  /**
   * Retrieve a paginated list of all chunks without embeddings.
   * @param offset - Number of rows to skip (for pagination).
   * @param limit - Maximum number of rows to return.
   * @returns An array of chunk summaries.
   */
  async getChunks(offset: number, limit: number): Promise<ChunkSummary[]> {
    return this.withCorruptionRecovery(async () => {
      const table = await this.getTable();
      const rows = await table.query()
        .select(QUERY_COLUMNS)
        .offset(offset)
        .limit(limit)
        .toArray();

      return rows.map((row: Record<string, unknown>) => ({
        id: row.id as string,
        filePath: row.filePath as string,
        language: row.language as string,
        startLine: row.startLine as number,
        endLine: row.endLine as number,
        content: row.content as string,
        description: (row.description as string) ?? "",
        kind: (row.kind as string) ?? "",
        quirkType: (row.quirkType as string) ?? "",
        tags: (row.tags as string) ?? "",
      }));
    });
  }

  /**
   * Retrieve a paginated list of chunks without embeddings, with optional
   * language and file-path filters pushed into the SQL WHERE clause.
   *
   * @param offset - Number of rows to skip (for pagination).
   * @param limit - Maximum number of rows to return.
   * @param lang - Optional exact language filter.
   * @param filePrefix - Optional filePath prefix filter.
   * @returns The page of chunks plus the total count of matching rows.
   */
  async getChunksFiltered(
    offset: number,
    limit: number,
    lang?: string,
    filePrefix?: string,
  ): Promise<{ chunks: ChunkSummary[]; total: number }> {
    const conditions: string[] = [];
    if (lang) conditions.push(`language = '${lang.replace(/'/g, "''")}'`);
    if (filePrefix) conditions.push(`filePath LIKE '${filePrefix.replace(/'/g, "''")}%'`);
    const where = conditions.length > 0 ? conditions.join(" AND ") : undefined;

    return this.withCorruptionRecovery(async () => {
      const table = await this.getTable();
      let query = table.query().select(QUERY_COLUMNS);
      let countQuery = table.query().select(["id"]);
      if (where) {
        query = query.where(where);
        countQuery = countQuery.where(where);
      }
      const [rows, countRows] = await Promise.all([
        query.offset(Math.max(0, offset)).limit(Math.max(1, Math.min(limit, 1000))).toArray(),
        countQuery.toArray(),
      ]);
      return {
        chunks: rows.map((row: Record<string, unknown>) => ({
          id: row.id as string,
          filePath: row.filePath as string,
          language: row.language as string,
          startLine: row.startLine as number,
          endLine: row.endLine as number,
          content: row.content as string,
          description: (row.description as string) ?? "",
          kind: (row.kind as string) ?? "",
          quirkType: (row.quirkType as string) ?? "",
          tags: (row.tags as string) ?? "",
        })),
        total: countRows.length,
      };
    });
  }

  /** Look up a single chunk by its ID. Returns undefined when not found. */
  async getChunkById(id: string): Promise<ChunkSummary | undefined> {
    return this.withCorruptionRecovery(async () => {
      const table = await this.getTable();
      const rows = await table.query()
        .select(QUERY_COLUMNS)
        .where(`id = '${id.replace(/'/g, "''")}'`)
        .limit(1)
        .toArray();
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) return undefined;
      return {
        id: row.id as string,
        filePath: row.filePath as string,
        language: row.language as string,
        startLine: row.startLine as number,
        endLine: row.endLine as number,
        content: row.content as string,
        description: (row.description as string) ?? "",
        kind: (row.kind as string) ?? "",
        quirkType: (row.quirkType as string) ?? "",
        tags: (row.tags as string) ?? "",
      };
    });
  }

  /** Fetch chunks by their IDs (for the compare view). Bounded to 100 ids. */
  async getChunksByIds(ids: string[]): Promise<ChunkSummary[]> {
    const bounded = ids.slice(0, 100);
    if (bounded.length === 0) return [];
    return this.withCorruptionRecovery(async () => {
      const table = await this.getTable();
      const idList = bounded.map((id) => `'${id.replace(/'/g, "''")}'`).join(", ");
      const rows = await table.query()
        .select(QUERY_COLUMNS)
        .where(`id IN (${idList})`)
        .toArray();
      return rows.map((row: Record<string, unknown>) => ({
        id: row.id as string,
        filePath: row.filePath as string,
        language: row.language as string,
        startLine: row.startLine as number,
        endLine: row.endLine as number,
        content: row.content as string,
        description: (row.description as string) ?? "",
        kind: (row.kind as string) ?? "",
        quirkType: (row.quirkType as string) ?? "",
        tags: (row.tags as string) ?? "",
      }));
    });
  }

  /**
   * Fetch chunks with their embedding vectors included (for embedding projection).
   * @param limit - Maximum number of rows to return.
   * @returns Array of { id, filePath, language, startLine, endLine, description, embedding }.
   */
  async getChunksWithEmbeddings(limit: number): Promise<{ id: string; filePath: string; language: string; startLine: number; endLine: number; description: string; embedding: number[] }[]> {
    return this.withCorruptionRecovery(async () => {
      const table = await this.getTable();
      const rows = await table.query()
        .select([...QUERY_COLUMNS, "embedding"])
        .limit(limit)
        .toArray();
      return rows
        .filter((r: Record<string, unknown>) => r.embedding && typeof r.embedding === "object")
        .map((row: Record<string, unknown>) => ({
          id: row.id as string,
          filePath: row.filePath as string,
          language: row.language as string,
          startLine: row.startLine as number,
          endLine: row.endLine as number,
          description: (row.description as string) ?? "",
          embedding: Array.from(row.embedding as Iterable<number>),
        }));
    });
  }

  /**
   * Perform ANN search internally, returning results scored as cosine similarity (0-1).
   * This method is called by `search()` and handles the actual query logic.
   * @param embedding - The query embedding vector.
   * @param topK - The number of top results to return.
   * @returns An array of search results with scores.
   */
  private async searchInternal(embedding: number[], topK: number, filter?: MetadataFilter): Promise<SearchResult[]> {
    const db = await this.getDb();
    const tableNames = await db.tableNames();
    if (!tableNames.includes(TABLE_NAME)) return [];

    const table = await this.getTable();
    const count = await table.countRows();
    if (count === 0) return [];

    // One-time per-process repair: drop any stale L2 index so the cosine query
    // below doesn't log "Requested metric Cosine is incompatible" and degrade
    // to brute-force. Await it so the repair completes before this search.
    await this.withWriteLock(() => this.ensureCosineIndex());

    const whereClause = buildWhereClause(filter);

    let results: Record<string, unknown>[];
    try {
      let query = table.vectorSearch(l2Normalize(embedding)).distanceType("cosine");
      if (whereClause) query = query.where(whereClause);
      results = await query.limit(topK).toArray() as Record<string, unknown>[];
    } catch (err) {
      if (err instanceof Error && err.message.includes("non-nullable") && filter) {
        const fallbackQuery = table.vectorSearch(l2Normalize(embedding)).distanceType("cosine");
        const rawResults = await fallbackQuery.limit(topK * 5).toArray() as Record<string, unknown>[];
        return rawResults
          .map((row: Record<string, unknown>) => this.rowToSearchResult(row))
          .filter((r: SearchResult) => r.chunk.id !== "__seed__")
          .filter((r: SearchResult) => matchesFilterLocal(r.chunk, filter))
          .slice(0, topK);
      }
      throw err;
    }

    return results
      .map((row: Record<string, unknown>) => this.rowToSearchResult(row))
      .filter((r: SearchResult) => r.chunk.id !== "__seed__");
  }

  /**
   * Return the total number of chunks stored in the table.
   * Guarded by a 30s timeout — returns 0 if the store is unresponsive
   * (e.g. corrupted version-manifest accumulation) so the pipeline can
   * proceed with a fresh index instead of hanging forever.
   * @returns The chunk count, or 0 if the table does not exist or times out.
   */
  async count(): Promise<number> {
    try {
      const db = await this.getDb();
      const tableNames = await db.tableNames();
      if (!tableNames.includes(TABLE_NAME)) return 0;

      const table = await this.getTable();
      const COUNT_TIMEOUT_MS = 30_000;
      // Attach a no-op catch to the race loser so a late rejection (after the
      // timeout resolved `null`) cannot become an unhandled rejection.
      const countPromise = table.countRows().catch(() => 0);
      const result = await Promise.race([
        countPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), COUNT_TIMEOUT_MS)),
      ]);
      if (result === null) {
        console.warn(`[lancedb] count() timed out after ${COUNT_TIMEOUT_MS / 1000}s — treating store as empty.`);
        return 0;
      }
      return result;
    } catch {
      return 0;
    }
  }

  /**
   * Ensure the ANN index on the `embedding` column uses the cosine metric,
   * matching the `distanceType` requested by searchInternal.
   *
   * Older stores built the IVF index with the ivfFlat default (L2), so every
   * cosine query hit "Requested metric Cosine is incompatible with index
   * metric L2" and silently fell back to brute-force O(N) scans. This lazily
   * replaces such an index with a cosine one — once per process.
   *
   * Callers must hold the write lock (searchInternal wraps the call in
   * withWriteLock; optimize runs under it already).
   */
  private ensureCosineIndex(warn?: StoreWarn): Promise<void> {
    if (!this.indexRepairPromise) {
      this.indexRepairPromise = this.repairIndexMetricOnce(warn);
    }
    return this.indexRepairPromise;
  }

  /**
   * Perform a single index-metric repair pass. Skips stores that have no
   * index and fewer than 1000 rows (brute-force is optimal there). Uses a
   * single `createIndex` with `replace: true` — a dropIndex + createIndex
   * sequence races in LanceDB ("Retryable commit conflict") and leaves the
   * stale index in place. On failure the memo is cleared so the next
   * search/optimize retries.
   */
  private async repairIndexMetricOnce(warn?: StoreWarn): Promise<void> {
    const report = (message: string): void => {
      (warn ?? console.warn)(message);
    };

    try {
      // Guard against a store that never converges: each failed createIndex
      // leaves a new index-version directory behind. If many stale versions
      // accumulated, building yet another index only entrenches the problem.
      // The store must be rebuilt instead (see doc/troubleshooting.md).
      const staleVersions = this.dbPath.startsWith("memory://")
        ? 0
        : countIndexVersionDirs(path.join(this.dbPath, TABLE_NAME + ".lance"));
      if (staleVersions > MAX_STALE_INDEX_VERSIONS) {
        report(
          `[lancedb] ${staleVersions} stale index versions detected in ${this.dbPath} — ` +
          `skipping index rebuild (the store is corrupted). Delete the rag_db directory and re-index.`,
        );
        // Resolve the memo so no further attempts run this process.
        return;
      }

      const table = await this.getTable();
      const count = await table.countRows().catch(() => 0);
      const indices = await table.listIndices();
      const vecIndex = indices.find((i) => i.columns.includes("embedding"));
      const idxName = vecIndex?.name ?? "embedding_idx";
      const stats = await table.indexStats(idxName);
      if (stats && stats.distanceType === "cosine") return; // already healthy
      if (!stats && count < 1000) return; // tiny store, no index — leave brute-force

      const numPartitions = Math.max(16, Math.min(256, Math.floor(count / 256)));
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await table.createIndex("embedding", {
            config: lancedb.Index.ivfFlat({ numPartitions, distanceType: "cosine" }),
            replace: true,
            name: idxName,
            // Wait for the commit so the repair is deterministic and cannot
            // race a background index-creation from another process.
            waitTimeoutSeconds: 120,
          } as never);
          this.indexRepairFailures = 0;
          return;
        } catch (err) {
          const retriable =
            err instanceof Error &&
            (err.message.includes("Retryable commit conflict") || err.message.includes("Please retry"));
          if (!retriable || attempt === 3) throw err;
          await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
        }
      }
    } catch (err) {
      this.indexRepairFailures++;
      const message =
        `[lancedb] index metric repair failed (queries continue in brute-force): ` +
        `${err instanceof Error ? err.message : String(err)}`;
      if (this.indexRepairFailures >= MAX_INDEX_REPAIR_ATTEMPTS) {
        // Stop retrying for this process — a store that fails repeatedly would
        // otherwise be retrained (with KMeans "partition empty" warning spam)
        // on every optimize() and search() call.
        report(
          `${message} — giving up after ${this.indexRepairFailures} attempts this session. ` +
          `Delete the rag_db directory and re-index.`,
        );
        return; // memo stays resolved: no further attempts this process
      }
      this.indexRepairPromise = null; // allow retry on a later search/optimize
      report(message);
    }
  }

  /**
   * Compact fragments and prune old version manifests to prevent the
   * version-manifest accumulation that causes countRows() to hang and the
   * store phase to slow down as the index grows. Should be called at the
   * end of a successful index pass, and periodically during long passes.
   *
   * @param options - `aggressive: true` prunes every version but the current
   *   one with `deleteUnverified`. Only safe for a private store that no other
   *   process reads (e.g. a temporary rebuild store). For the shared store,
   *   versions newer than 1 hour are retained so in-flight queries (Web UI,
   *   background auto-index) can finish before their data files are reclaimed.
   */
  async optimize(options?: { aggressive?: boolean; skipIndex?: boolean; logger?: StoreWarn }): Promise<void> {
    await this.withWriteLock(async () => {
      try {
        const table = await this.getTable();
        if (options?.aggressive) {
          await table.optimize({ cleanupOlderThan: new Date(), deleteUnverified: true });
        } else {
          const threshold = new Date(Date.now() - 60 * 60 * 1000);
          await table.optimize({ cleanupOlderThan: threshold, deleteUnverified: false });
        }

        // Build the ANN vector index — without it every vectorSearch() is a
        // brute-force O(N) flat scan (slow at 50k+ chunks). Skips early when
        // an index with the correct cosine metric already exists, and can be
        // skipped entirely for a private temporary store that is never
        // searched (the rebuild pipeline builds the index once at the end).
        if (!options?.skipIndex) {
          await this.ensureCosineIndex(options?.logger);
        }
      } catch (err) {
        // Optimize is best-effort — must not break indexing, but surface the
        // failure instead of swallowing it silently.
        const message = `[lancedb] optimize failed: ${err instanceof Error ? err.message : String(err)}`;
        (options?.logger ?? console.warn)(message);
      }
    });
  }

  /**
   * Return all unique file paths currently stored in the index.
   * @returns An array of normalized file paths.
   */
  async getFilePaths(): Promise<string[]> {
    try {
      const db = await this.getDb();
      const tableNames = await db.tableNames();
      if (!tableNames.includes(TABLE_NAME)) return [];

      return this.withCorruptionRecovery(async () => {
        const table = await this.getTable();
        const rows = await table.query().select(["filePath"]).toArray();
        const paths = new Set<string>();
        for (const row of rows) {
          const fp = row.filePath as string;
          if (fp) paths.add(fp);
        }
        return Array.from(paths);
      });
    } catch {
      return [];
    }
  }

  /**
   * Re-open the store, optionally pointing at a new database path.
   * Closes any existing connection and resets internal state so that the
   * next operation lazily reconnects to (the new) path.
   *
   * @param newPath - Optional new filesystem path for the LanceDB database.
   */
  async reopen(newPath?: string): Promise<void> {
    await this.close();
    if (newPath) this.dbPath = newPath;
  }

  /**
   * Close the database connection and release resources.
   *
   * The native LanceDB `close()` can hang indefinitely on Windows, so the
   * whole close is raced against a timeout — callers (CLI commands, plugin
   * reload, web server) must never block forever on shutdown.
   */
  async close(): Promise<void> {
    await Promise.race([
      (async () => {
        try {
          await this.table?.close();
        } catch {
          // best-effort — the connection may already be gone
        }
        this.table = null;
        try {
          await this.db?.close();
        } catch {
          // best-effort — the connection may already be gone
        }
        this.db = null;
      })(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, 5000).unref();
      }),
    ]);
  }

  /**
   * Back up the chunks.lance directory before a destructive operation.
   * Creates a timestamped copy at chunks.lance.backup-<ISO timestamp>.
   * Skips if chunks.lance doesn't exist or noBackup is set.
   * @returns The backup path, or null if nothing was backed up.
   */
  private async backupBeforeClear(noBackup?: boolean): Promise<string | null> {
    if (noBackup) return null;
    const lancePath = path.join(this.dbPath, "chunks.lance");
    try {
      await fs.access(lancePath);
    } catch {
      return null;
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${lancePath}.backup-${timestamp}`;
    await fs.cp(lancePath, backupPath, { recursive: true });
    return backupPath;
  }

  /**
   * Remove all chunks by dropping the underlying LanceDB table.
   * Falls back to deleting the database directory if dropTable fails.
   * @param options - Optional. Set `{ noBackup: true }` to skip backup (test use only).
   */
  async clear(options?: { noBackup?: boolean }): Promise<void> {
    const backup = await this.backupBeforeClear(options?.noBackup);
    if (backup) console.warn(`[lancedb] Backed up chunks.lance to ${backup}`);
    await this.table?.close();
    this.table = null;
    try {
      const db = await this.getDb();
      const tableNames = await db.tableNames();
      if (tableNames.includes(TABLE_NAME)) {
        await db.dropTable(TABLE_NAME);
      }
      await this.db?.close();
      this.db = null;
    } catch {
      await this.db?.close();
      this.db = null;
      try {
        await fs.rm(this.dbPath, { recursive: true, force: true });
      } catch {}
    }
  }

  /**
   * Completely remove the entire LanceDB database directory from disk.
   * All data is permanently lost.
   * @param options - Optional. Set `{ noBackup: true }` to skip backup (test use only).
   */
  async dropDatabase(options?: { noBackup?: boolean }): Promise<void> {
    if (!options?.noBackup) {
      // Back up the entire store directory since dropDatabase deletes it.
      try {
        await fs.access(this.dbPath);
      } catch {
        // nothing to back up
      }
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupPath = `${this.dbPath}.backup-${timestamp}`;
        await fs.cp(this.dbPath, backupPath, { recursive: true });
        console.warn(`[lancedb] Backed up database to ${backupPath}`);
      } catch {
        // backup failed, continue anyway
      }
    }
    this.table = null;
    this.db = null;
    try {
      await fs.rm(this.dbPath, { recursive: true, force: true });
    } catch {}
  }

  /**
   * Remove all chunks associated with a given file path.
   * Automatically attempts repair on corruption errors.
   * @param filePath - The file path whose chunks should be deleted.
   */
  async deleteByFilePath(filePath: string): Promise<void> {
    await this.withWriteLock(async () => {
      try {
        await this.deleteByFilePathInternal(filePath);
      } catch (err) {
        if (isCorruptionError(err) && await this.tryRepair()) {
          await this.deleteByFilePathInternal(filePath);
          return;
        }
        throw err;
      }
    });
  }

  private async deleteByFilePathInternal(filePath: string): Promise<void> {
    const db = await this.getDb();
    const tableNames = await db.tableNames();
    if (!tableNames.includes(TABLE_NAME)) return;

    const table = await this.getTable();
    const normalizedPath = normalizeFilePath(filePath).replace(/'/g, "''");
    await table.delete(`filePath = '${normalizedPath}'`);
  }

  /**
   * Verify that data in the store is actually readable.
   * Reads the `content` column (a large text field stored in data fragments,
   * not in the version manifest) for the first few rows.  If any of the
   * underlying `.lance` data files are missing from disk, LanceDB throws a
   * corruption error ("Not found: ... .lance") and we return false.
   *
   * This catches silent corruption where countRows() returns metadata from
   * the version manifest while the actual row data on disk is gone.
   */
  async checkIntegrity(): Promise<boolean> {
    try {
      const db = await this.getDb();
      const tableNames = await db.tableNames();
      if (!tableNames.includes(TABLE_NAME)) return true;
      const table = await this.getTable();
      const count = await table.countRows();
      if (count === 0) return true;
      // Read the `content` column (stored in data fragments, not in the
      // version manifest) for the first few rows.  If a fragment is
      // missing, LanceDB will fail with a "Not found" corruption error.
      const rows = await table.query().select(["id", "content"]).limit(10).toArray();
      return rows.length > 0;
    } catch (err) {
      if (isCorruptionError(err)) return false;
      return true;
    }
  }

  /**
   * Execute an async function with automatic corruption recovery.
   * If the function throws a LanceDB corruption error, tryRepair() is run
   * and the function is retried once.  If repair fails, the original error
   * is re-thrown so callers/higher layers can handle it (e.g. return
   * fallback data, clear the manifest, or trigger a rebuild).
   */
  private async withCorruptionRecovery<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isCorruptionError(err)) {
        // Repair must be under writeLock to prevent Restore from conflicting
        // with concurrent Append transactions (addChunks / deleteByFilePath).
        const repaired = await this.withWriteLock(() => this.tryRepair());
        if (repaired) {
          return fn();
        }
      }
      throw err;
    }
  }

  private async tryRepair(): Promise<boolean> {
    try {
      this.table = null;
      this.db = null;

      const db = await this.getDb();
      const tableNames = await db.tableNames();
      if (!tableNames.includes(TABLE_NAME)) return false;

      let table: Table;
      try {
        table = await db.openTable(TABLE_NAME);
      } catch {
        console.error(
          "[lancedb] Corrupt table detected. Run 'opencode-rag index --force' to rebuild."
        );
        return false;
      }

      let versions: Version[];
      try {
        versions = await table.listVersions();
      } catch {
        console.warn(
          "[lancedb] Could not list table versions for repair. " +
          "Run 'opencode-rag index --force' to rebuild if search results are incorrect."
        );
        return false;
      }

      if (versions.length <= 1) {
        return this.tryRebuildTable(db);
      }

      const sorted = [...versions].sort((a, b) => b.version - a.version);

      for (const ver of sorted.slice(1)) {
        try {
          await table.checkout(ver.version);
          await table.countRows();
          await table.restore();
          await table.checkoutLatest();
          this.table = table;
          return true;
        } catch {
          continue;
        }
      }

      // All version-restore attempts failed (likely corrupted version graph
      // with incompatible Restore transactions).  Drop and recreate the table.
      console.warn(
        "[lancedb] Version restore failed. Dropping and recreating table to recover from corrupt version graph."
      );
      return this.tryRebuildTable(db);
    } catch {
      return false;
    }
  }

  /**
   * Drop the existing chunks table and let getTable() create a fresh one.
   * All indexed data is lost — callers should detect the empty table and
   * trigger a re-index if needed.
   */
  private async tryRebuildTable(db: Connection): Promise<boolean> {
    try {
      await db.dropTable(TABLE_NAME).catch(() => {});
      this.table = null;
      // Re-create fresh via getTable → initTable
      await this.getTable();
      console.warn("[lancedb] Table recreated from scratch after corruption recovery.");
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Build a LanceDB SQL WHERE clause from a MetadataFilter.
 * Handles path glob patterns and language filters with proper escaping.
 */
function buildWhereClause(filter?: MetadataFilter): string | undefined {
  if (!filter) return undefined;
  const parts: string[] = [];
  if (filter.languages?.length) {
    const langs = filter.languages.map((l) => `'${l.replace(/'/g, "''")}'`).join(",");
    parts.push(`language IN (${langs})`);
  }
  if (filter.kinds?.length) {
    const kinds = filter.kinds.map((k) => `'${k.replace(/'/g, "''")}'`).join(",");
    parts.push(`kind IN (${kinds})`);
  }
  if (filter.pathPatterns?.length) {
    const likes = filter.pathPatterns.map((p) => {
      const escaped = p.replace(/'/g, "''");
      const like = escaped
        .replace(/\*\*/g, "%")
        .replace(/\*/g, "%")
        .replace(/\?/g, "_");
      return `filePath LIKE '${like}'`;
    });
    parts.push(`(${likes.join(" OR ")})`);
  }
  if (filter.fileExtensions?.length) {
    const likes = normalizeFileExtensions(filter.fileExtensions).map((ext) => `filePath LIKE '%${ext}'`);
    parts.push(`(${likes.join(" OR ")})`);
  }
  return parts.length ? parts.join(" AND ") : undefined;
}

/** Client-side metadata filter for use as a fallback when LanceDB WHERE panics. */
function matchesFilterLocal(chunk: Chunk, filter?: MetadataFilter): boolean {
  if (!filter) return true;
  if (filter.languages?.length && !filter.languages.includes(chunk.metadata.language)) return false;
  if (filter.kinds?.length && !filter.kinds.includes(chunk.metadata.kind ?? "")) return false;
  if (filter.pathPatterns?.length) {
    return filter.pathPatterns.some((p) => globMatchLocal(p, chunk.metadata.filePath));
  }
  if (!matchesFileExtension(chunk.metadata.filePath, normalizeFileExtensions(filter.fileExtensions))) return false;
  return true;
}

function globMatchLocal(pattern: string, filePath: string): boolean {
  const GLOBSTAR = "\x00GS\x00";
  let re = pattern.replace(/\*\*/g, GLOBSTAR);
  re = re.replace(/([.+^${}()|[\]\\])/g, "\\$1");
  re = re.replace(new RegExp(GLOBSTAR, "g"), ".*");
  re = re.replace(/\*/g, "[^/]*");
  re = re.replace(/\?/g, ".");
  return new RegExp("^" + re + "$").test(filePath);
}
