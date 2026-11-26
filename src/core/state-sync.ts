import { isInScanScope, createIncludeMatcher } from "./exclude.js";
/**
 * @fileoverview Durable workspace-state synchronisation.
 *
 * ClickHouse is the source of truth when `vectorStore.provider` is
 * `"clickhouse"`: the manifest, keyword index, quirks, runtime overrides and
 * documentation progress live in the project's `state_<namespace>` table, and
 * the local `vectorStore.path` directory is a disposable cache. That is what
 * makes a fresh clone on another machine able to search and incrementally
 * index without re-embedding anything.
 *
 * For LanceDB (and memory) this class is a no-op — the local directory remains
 * the source of truth, exactly as before.
 *
 * Conflict rules (no cross-machine clock assumptions):
 * - If local content already equals remote content: nothing to do.
 * - If local content is unchanged since the last sync (hash matches the
 *   record): remote wins.
 * - If local content changed: quirks are merged by id (later `lastObserved`
 *   wins), everything else keeps the local copy and uploads it.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { RagConfig } from "./config.js";
import type { VectorStore } from "./interfaces.js";

/** State names and their local cache files. */
const STATE_FILES = {
  manifest: { file: "manifest.json", required: true, merge: true },
  "keyword-index": { file: "keyword-index.json", required: false },
  quirks: { file: "quirks.jsonl", required: false, merge: true },
  "runtime-overrides": { file: "runtime-overrides.json", required: false },
  "doc-progress": { file: "doc-progress.json", required: false },
  ".desc-cache": { file: ".desc-cache.json", required: false, cache: true, merge: true },
} as const;

type StateName = keyof typeof STATE_FILES;

const VERSIONS_FILE = ".state-sync.json";

/** Large files must never be loaded as one JavaScript string. */
const STATE_FILE_STREAM_THRESHOLD_BYTES = 32 * 1024 * 1024;

/** Remote (ClickHouse) half of the state store. */
interface RemoteStateStore {
  readState(name: string): Promise<{ data: string; ver: string } | undefined>;
  readStateToFile?(name: string, filePath: string): Promise<{ ver: string; sha256?: string; bytes?: number } | undefined>;
  writeState(name: string, data: string, sha256?: string): Promise<void>;
  writeStateFile?(name: string, filePath: string, sha256?: string): Promise<void>;
}

interface SyncRecord {
  sha256: string;
}

interface SyncVersions {
  [name: string]: SyncRecord | undefined;
}

export interface StateSyncOptions {
  store: VectorStore;
  /** Local cache directory (`vectorStore.path`). */
  storePath: string;
  config: RagConfig;
  cwd?: string;
  /** Override the config gate for explicit keyword-index restore operations. */
  syncKeywordIndex?: boolean;
  /** Optional logger override (tests). */
  warn?: (message: string) => void;
}

/** SHA-256 hex of a string or buffer. */
function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** File hash calculated incrementally, avoiding V8's max string length. */
async function sha256File(filePath: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .once("error", reject)
      .once("end", resolve);
  });
  return hash.digest("hex");
}

/** Atomic file write (temp + rename), tolerating Windows rename semantics. */
async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, data, "utf-8");
  try {
    await fs.rename(tempPath, filePath);
  } catch {
    await fs.unlink(filePath).catch(() => {});
    await fs.rename(tempPath, filePath);
  }
}

async function readFileOrUndefined(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Merge two JSONL quirk logs by id, keeping the record with the later
 * `lastObserved` (falling back to the later `updatedAt`, then the local copy).
 *
 * A record carrying `deletedAt` is a deletion tombstone: it is final. A live
 * record never overrides a tombstone (quirk ids are never reused, so any live
 * copy of a deleted id is stale), which is what makes the union propagate a
 * deletion instead of resurrecting it.
 *
 * Output is sorted by id so identical inputs hash identically.
 */
export function mergeQuirkJsonl(local: string, remote: string): string {
  const byId = new Map<string, Record<string, unknown>>();
  const isDeleted = (record: Record<string, unknown>): boolean =>
    typeof record.deletedAt === "string" && record.deletedAt.length > 0;
  const timestamp = (record: Record<string, unknown>): number => {
    for (const key of ["lastObserved", "updatedAt", "timestamp", "createdAt"]) {
      const value = record[key];
      if (typeof value === "string") {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      if (typeof value === "number") return value;
    }
    return 0;
  };
  const ingest = (raw: string): void => {
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id : undefined;
        if (!id) continue;
        const existing = byId.get(id);
        if (!existing) {
          byId.set(id, record);
          continue;
        }
        // A tombstone is final: quirk ids are never reused, so any live copy of
        // a deleted id is stale and must not resurrect it, whatever its clock.
        if (isDeleted(record) && !isDeleted(existing)) {
          byId.set(id, record);
          continue;
        }
        if (isDeleted(existing) && !isDeleted(record)) continue;
        // Otherwise the later timestamp wins; `>=` keeps the original tie-break
        // (local is ingested second, so the local copy wins an equal timestamp).
        if (timestamp(record) >= timestamp(existing)) {
          byId.set(id, record);
        }
      } catch {
        // Ignore a malformed line: the other side's copy of that id wins.
      }
    }
  };
  ingest(remote);
  ingest(local);
  return Array.from(byId.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, record]) => JSON.stringify(record))
    .join("\n") + (byId.size > 0 ? "\n" : "");
}

/**
 * Synchronise the durable workspace state with a central store.
 *
 * Inactive (a no-op) for every provider except `"clickhouse"`.
 */

export function mergeManifestJson(
  localRaw: string,
  remoteRaw: string,
  cwd?: string,
  includeDirs?: string[],
): string {
  let local: any;
  let remote: any;
  try { local = JSON.parse(localRaw); } catch { return remoteRaw; }
  try { remote = JSON.parse(remoteRaw); } catch { return localRaw; }
  if (!local || typeof local !== "object") return remoteRaw;
  if (!remote || typeof remote !== "object") return localRaw;

  const remoteFiles = remote.files && typeof remote.files === "object" ? remote.files : {};
  const localFiles = local.files && typeof local.files === "object" ? local.files : {};
  const mergedFiles: Record<string, any> = {};
  const matcher = includeDirs && includeDirs.length > 0 ? createIncludeMatcher(includeDirs) : undefined;

  // Inside the scan scope the local copy is authoritative (deletions must
  // propagate); entries outside it were not looked at and are preserved.
  for (const [p, entry] of Object.entries(remoteFiles)) {
    if (!cwd || !isInScanScope(p, cwd, matcher)) mergedFiles[p] = entry;
  }
  Object.assign(mergedFiles, localFiles);

  const merged = {
    schemaVersion: Math.max(local.schemaVersion ?? 3, remote.schemaVersion ?? 3),
    lastIndexedAt: Math.max(local.lastIndexedAt ?? 0, remote.lastIndexedAt ?? 0) || Date.now(),
    files: mergedFiles,
    lastGitCommit: local.lastGitCommit || remote.lastGitCommit,
  };
  return JSON.stringify(merged, null, 2);
}

export function mergeDescCacheJson(localRaw: string, remoteRaw: string): string {
  let local: any;
  let remote: any;
  try { local = JSON.parse(localRaw); } catch { return remoteRaw; }
  try { remote = JSON.parse(remoteRaw); } catch { return localRaw; }
  if (!local || typeof local !== "object") return remoteRaw;
  if (!remote || typeof remote !== "object") return localRaw;

  const remoteEntries = remote.entries && typeof remote.entries === "object" ? remote.entries : {};
  const localEntries = local.entries && typeof local.entries === "object" ? local.entries : {};
  const mergedEntries = { ...remoteEntries };

  for (const [k, v] of Object.entries(localEntries)) {
    const existing = mergedEntries[k];
    if (!existing || ((v as any)?.createdAt ?? 0) >= ((existing as any)?.createdAt ?? 0)) {
      mergedEntries[k] = v;
    }
  }

  return JSON.stringify({
    version: Math.max(local.version ?? 1, remote.version ?? 1),
    entries: mergedEntries,
  }, null, 2);
}

export class StateSync {
  private readonly storePath: string;
  private readonly enabled: boolean;
  private readonly syncDescCache: boolean;
  private readonly syncKeywordIndex: boolean;
  private readonly warn: (message: string) => void;
  private readonly remote: RemoteStateStore | undefined;
  private readonly cwd?: string;
  private readonly config?: RagConfig;

  constructor(options: StateSyncOptions) {
    this.storePath = options.storePath;
    this.cwd = options.cwd;
    this.config = options.config;
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.enabled = (options.config.vectorStore.provider ?? "lancedb") === "clickhouse";
    this.syncDescCache = options.config.vectorStore.clickhouse?.state?.syncDescCache ?? false;
    this.syncKeywordIndex = options.syncKeywordIndex
      ?? (options.config.retrieval.hybridSearch?.enabled !== false);
    const candidate = options.store as unknown as Partial<RemoteStateStore>;
    this.remote =
      typeof candidate.readState === "function" && typeof candidate.writeState === "function"
        ? (candidate as RemoteStateStore)
        : undefined;
  }

  /** True when this instance actually talks to a central state table. */
  
  private mergeState(name: StateName, local: string, remoteData: string): string {
    if (name === "quirks") {
      return mergeQuirkJsonl(local, remoteData);
    }
    if (name === "manifest") {
      return mergeManifestJson(
        local,
        remoteData,
        this.cwd,
        this.config?.indexing?.includeDirs,
      );
    }
    if (name === ".desc-cache") {
      return mergeDescCacheJson(local, remoteData);
    }
    return local;
  }

  get active(): boolean {
    return this.enabled && this.remote !== undefined;
  }

  private entries(): [StateName, (typeof STATE_FILES)[StateName]][] {
    return (Object.entries(STATE_FILES) as [StateName, (typeof STATE_FILES)[StateName]][])
      .filter(([name, spec]) => {
        if (name === "keyword-index" && !this.syncKeywordIndex) return false;
        return !("cache" in spec && spec.cache) || this.syncDescCache;
      });
  }

  private versionsPath(): string {
    return path.join(this.storePath, VERSIONS_FILE);
  }

  private async loadVersions(): Promise<SyncVersions> {
    const raw = await readFileOrUndefined(this.versionsPath());
    if (!raw) return {};
    try {
      return JSON.parse(raw) as SyncVersions;
    } catch {
      return {};
    }
  }

  private async saveVersions(versions: SyncVersions): Promise<void> {
    await writeFileAtomic(this.versionsPath(), JSON.stringify(versions, null, 2));
  }

  private localPath(name: StateName): string {
    return path.join(this.storePath, STATE_FILES[name].file);
  }

  /**
   * Pull durable state into the local cache. Call before anything reads the
   * manifest/keyword index/quirks (bootstrap does this).
   */
  async hydrate(): Promise<void> {
    if (!this.active) return;
    const versions = await this.loadVersions();
    const mergedNames: StateName[] = [];

    for (const [name, spec] of this.entries()) {
      const localPath = this.localPath(name);
      const localStat = await fs.stat(localPath).catch(() => undefined);
      if (this.remote?.readStateToFile && localStat?.size && localStat.size > STATE_FILE_STREAM_THRESHOLD_BYTES) {
        try {
          const remoteMeta = await this.remote.readStateToFile(name, `${localPath}.remote`);
          if (!remoteMeta) continue;
          const localHash = await sha256File(localPath);
          const remoteHash = remoteMeta.sha256 ?? await sha256File(`${localPath}.remote`);
          if (localHash === remoteHash) {
            await fs.unlink(`${localPath}.remote`).catch(() => {});
            versions[name] = { sha256: remoteHash };
            continue;
          }
          const record = versions[name];
          if (record?.sha256 === localHash) {
            await fs.rename(`${localPath}.remote`, localPath);
            versions[name] = { sha256: remoteHash };
            continue;
          }
          await fs.unlink(`${localPath}.remote`).catch(() => {});
          versions[name] = undefined;
          this.warn(`[state-sync] "${name}" changed locally and remotely — keeping the local copy (upload queued).`);
          continue;
        } catch (err) {
          await fs.unlink(`${localPath}.remote`).catch(() => {});
          this.warn(`[state-sync] Could not stream "${name}" from ClickHouse: ${(err as Error).message}`);
          continue;
        }
      }

      let remote: { data: string; ver: string } | undefined;
      try {
        remote = await this.remote!.readState(name);
      } catch (err) {
        this.warn(`[state-sync] Could not read "${name}" from ClickHouse: ${(err as Error).message}`);
        continue;
      }
      if (!remote?.data) continue;

      const local = await readFileOrUndefined(this.localPath(name));
      const remoteHash = sha256(remote.data);
      if (local !== undefined && sha256(local) === remoteHash) {
        versions[name] = { sha256: remoteHash };
        continue;
      }

      const record = versions[name];
      const localClean = local === undefined || record?.sha256 === sha256(local);
      if (localClean) {
        await writeFileAtomic(this.localPath(name), remote.data);
        versions[name] = { sha256: remoteHash };
        continue;
      }

      if ("merge" in spec && spec.merge) {
        // Dispatch by state name: `manifest` is a JSON object and must go
        // through mergeManifestJson, not through the JSONL quirk merge (which
        // yields an empty string for non-JSONL input and wipes the manifest).
        const merged = this.mergeState(name, local!, remote.data);
        await writeFileAtomic(this.localPath(name), merged);
        // Do NOT record the merged hash here: `flush` must upload it first.
        // Recording it would make flush believe the merged payload was already
        // sent, leaving the remote row stale (and the next hydrate would then
        // "restore" the stale remote over the newer local file).
        mergedNames.push(name);
        continue;
      }

      // Both sides changed and this file cannot be merged: keep the local
      // copy (it reflects this machine's latest work). Invalidate the version
      // record so flush() cannot mistake the last successful upload for the
      // current local bytes.
      versions[name] = undefined;
      this.warn(
        `[state-sync] "${name}" changed locally and remotely — keeping the local copy (upload queued).`,
      );
    }

    await this.saveVersions(versions);
    if (mergedNames.length > 0) {
      await this.flush(mergedNames, versions);
    }
  }

  /**
   * Upload changed state files. No-op names are ignored.
   *
   * @param names - State names to flush; defaults to every syncable file.
   * @param existingVersions - Reuse a versions map already loaded by `hydrate`.
   */
  async flush(names?: StateName[], existingVersions?: SyncVersions): Promise<void> {
    if (!this.active) return;
    const versions = existingVersions ?? (await this.loadVersions());
    const targets = (names ?? this.entries().map(([name]) => name))
      .filter((name) => name !== "keyword-index" || this.syncKeywordIndex);

    for (const name of targets) {
      const spec = STATE_FILES[name];
      const localPath = this.localPath(name);
      const stat = await fs.stat(localPath).catch(() => undefined);
      if (!stat?.isFile()) continue;

      // Very large state (especially keyword-index.json) cannot be represented
      // as one JS string. Keep it on disk, hash it incrementally, and let the
      // remote store stream it directly into ClickHouse.
      if (stat.size > STATE_FILE_STREAM_THRESHOLD_BYTES && this.remote!.writeStateFile) {
        const hash = await sha256File(localPath);
        if (versions[name]?.sha256 === hash) continue;
        try {
          await this.remote!.writeStateFile(name, localPath, hash);
          versions[name] = { sha256: hash };
        } catch (err) {
          this.warn(`[state-sync] Could not upload "${name}": ${(err as Error).message}`);
        }
        continue;
      }

      const local = await readFileOrUndefined(localPath);
      if (local === undefined) continue;

      let payload = local;
      if ("merge" in spec && spec.merge) {
        try {
          const remote = await this.remote!.readState(name);
          if (remote?.data) payload = this.mergeState(name, local, remote.data);
        } catch {
          // Upload the local copy; the next hydrate merges instead.
        }
      }

      const hash = sha256(payload);
      if (versions[name]?.sha256 === hash) continue;

      try {
        await this.remote!.writeState(name, payload, hash);
        if (payload !== local) await writeFileAtomic(this.localPath(name), payload);
        versions[name] = { sha256: hash };
      } catch (err) {
        this.warn(`[state-sync] Could not upload "${name}": ${(err as Error).message}`);
      }
    }

    await this.saveVersions(versions);
  }
}
