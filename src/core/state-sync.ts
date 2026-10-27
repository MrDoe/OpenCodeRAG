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
  manifest: { file: "manifest.json", required: true },
  "keyword-index": { file: "keyword-index.json", required: false },
  quirks: { file: "quirks.jsonl", required: false, merge: true },
  "runtime-overrides": { file: "runtime-overrides.json", required: false },
  "doc-progress": { file: "doc-progress.json", required: false },
  ".desc-cache": { file: ".desc-cache.json", required: false, cache: true },
} as const;

type StateName = keyof typeof STATE_FILES;

const VERSIONS_FILE = ".state-sync.json";

/** Remote (ClickHouse) half of the state store. */
interface RemoteStateStore {
  readState(name: string): Promise<{ data: string; ver: string } | undefined>;
  writeState(name: string, data: string, sha256?: string): Promise<void>;
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
  /** Optional logger override (tests). */
  warn?: (message: string) => void;
}

/** SHA-256 hex of a string or buffer. */
function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
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
export class StateSync {
  private readonly storePath: string;
  private readonly enabled: boolean;
  private readonly syncDescCache: boolean;
  private readonly warn: (message: string) => void;
  private readonly remote: RemoteStateStore | undefined;

  constructor(options: StateSyncOptions) {
    this.storePath = options.storePath;
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.enabled = (options.config.vectorStore.provider ?? "lancedb") === "clickhouse";
    this.syncDescCache = options.config.vectorStore.clickhouse?.state?.syncDescCache ?? false;
    const candidate = options.store as unknown as Partial<RemoteStateStore>;
    this.remote =
      typeof candidate.readState === "function" && typeof candidate.writeState === "function"
        ? (candidate as RemoteStateStore)
        : undefined;
  }

  /** True when this instance actually talks to a central state table. */
  get active(): boolean {
    return this.enabled && this.remote !== undefined;
  }

  private entries(): [StateName, (typeof STATE_FILES)[StateName]][] {
    return (Object.entries(STATE_FILES) as [StateName, (typeof STATE_FILES)[StateName]][])
      .filter(([, spec]) => !("cache" in spec && spec.cache) || this.syncDescCache);
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
        const merged = mergeQuirkJsonl(local!, remote.data);
        await writeFileAtomic(this.localPath(name), merged);
        // Do NOT record the merged hash here: `flush` must upload it first.
        // Recording it would make flush believe the merged payload was already
        // sent, leaving the remote row stale (and the next hydrate would then
        // "restore" the stale remote over the newer local file).
        mergedNames.push(name);
        continue;
      }

      // Both sides changed and this file cannot be merged: keep the local
      // copy (it reflects this machine's latest work). The next index pass
      // will upload it; a read command must not write to the central store.
      this.warn(
        `[state-sync] "${name}" changed locally and remotely — keeping the local copy (uploaded on the next index pass).`,
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
    const targets = names ?? this.entries().map(([name]) => name);

    for (const name of targets) {
      const spec = STATE_FILES[name];
      const local = await readFileOrUndefined(this.localPath(name));
      if (local === undefined) continue;

      let payload = local;
      if ("merge" in spec && spec.merge) {
        try {
          const remote = await this.remote!.readState(name);
          if (remote?.data) payload = mergeQuirkJsonl(local, remote.data);
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
