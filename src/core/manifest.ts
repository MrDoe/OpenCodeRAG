/**
 * @fileoverview File hash manifest for tracking indexing state across sessions.
 * Provides load/save with atomic writes, schema versioning, and corruption detection.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { RagConfig } from "./config.js";

/** Metadata entry for a single indexed file. */
export interface ManifestEntry {
  /** SHA-256 hash of the file content. */
  hash: string;
  /** Number of chunks produced for this file. */
  chunkCount: number;
  /** Unix timestamp of when this file was last indexed. */
  indexedAt: number;
  /** Filesystem modification time at time of indexing. */
  mtime?: number;
  /** File size in bytes. */
  size?: number;
  /** Whether the description generation step failed for this file. */
  descriptionFailed?: boolean;
  /**
   * Hash of the description config (provider, model, baseUrl, prompts) that
   * was active when descriptions were generated for this file.  Skipped when
   * no description provider is configured.  Used to avoid re-describing
   * files whose source content and description config are both unchanged.
   */
  descHash?: string;
}

/** Current schema version for manifest files. */
export const SCHEMA_VERSION = 3;
/**
 * Oldest schema version still accepted as valid.
 * Bumping this intentionally marks older manifests corrupt and forces a
 * rebuild, so only raise it when a migration is not practical.
 */
export const MIN_SUPPORTED_SCHEMA_VERSION = 3;

/** Persistent manifest tracking indexing state across sessions. */
export interface FileManifest {
  /** Unix timestamp of the last full index pass. */
  lastIndexedAt?: number;
  /** Schema version for forward-compatibility checks. */
  schemaVersion?: number;
  /** Map of normalized file path to its manifest entry. */
  files: Record<string, ManifestEntry>;
  /** Git commit hash at last index, used for incremental re-indexing. */
  lastGitCommit?: string;
}

/** Health status of a loaded manifest file. */
export type ManifestStatus = "ok" | "missing" | "corrupt";

/** Result of loading a manifest from disk. */
export interface LoadedManifest {
  /** The parsed manifest data (empty if missing/corrupt). */
  manifest: FileManifest;
  /** Filesystem path the manifest was loaded from. */
  path: string;
  /** Load status indicating health. */
  status: ManifestStatus;
}

/** Create a new empty manifest with the current schema version. */
export function createEmptyManifest(): FileManifest {
  return { files: {}, schemaVersion: SCHEMA_VERSION };
}

/** Resolve the manifest file path within a vector store directory. */
export function manifestPathFor(dbPath: string): string {
  return path.join(dbPath, "manifest.json");
}

/** Normalize a file path to use forward slashes for cross-platform consistency. */
export function normalizeFilePath(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, "/");
}

/** Compute the SHA-256 hex hash of a string. */
export function computeFileHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Compute a hash of the description configuration (provider, model, baseUrl,
 * systemPrompt, image prompt, etc.) so that files are only re-described when
 * the config actually changes.
 *
 * Returns `undefined` when neither `description` nor `imageDescription` is
 * configured — callers treat this as "no descriptions needed".
 */
export function computeDescriptionConfigHash(config: RagConfig): string | undefined {
  const desc = config.description;
  const img = config.imageDescription;
  if (!desc && !img) return undefined;

  const parts: string[] = [];
  if (desc) {
    parts.push(
      `desc:${desc.provider}|${desc.model}|${desc.baseUrl}|${desc.systemPrompt}|batch:${desc.batchEnabled === true ? 1 : 0}`,
    );
  }
  if (img) {
    parts.push(
      `img:${img.provider}|${img.model}|${img.baseUrl}|${img.prompt}`,
    );
  }
  if (parts.length === 0) return undefined;

  return createHash("sha256").update(parts.join("||")).digest("hex").slice(0, 16);
}

/** Load a manifest from disk, handling missing or corrupt files gracefully. */
export async function loadManifest(dbPath: string): Promise<LoadedManifest> {
  const filePath = manifestPathFor(dbPath);

  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<FileManifest>;
    if (!parsed || typeof parsed !== "object" || !parsed.files || typeof parsed.files !== "object") {
      return { manifest: createEmptyManifest(), path: filePath, status: "corrupt" };
    }

    const version = parsed.schemaVersion ?? 0;
    return {
      manifest: {
        lastIndexedAt: typeof parsed.lastIndexedAt === "number" ? parsed.lastIndexedAt : undefined,
        schemaVersion: version,
        files: parsed.files as Record<string, ManifestEntry>,
      },
      path: filePath,
      status: version >= MIN_SUPPORTED_SCHEMA_VERSION ? "ok" : "corrupt",
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { manifest: createEmptyManifest(), path: filePath, status: "missing" };
    }
    return { manifest: createEmptyManifest(), path: filePath, status: "corrupt" };
  }
}

/** Persist a manifest to disk with atomic write (temp file + rename, with Windows fallback). */
export async function saveManifest(dbPath: string, manifest: FileManifest): Promise<void> {
  const filePath = manifestPathFor(dbPath);
  const tempPath = `${filePath}.tmp`;

  manifest.schemaVersion = SCHEMA_VERSION;

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tempPath, JSON.stringify(manifest, null, 2), "utf-8");
  try {
    await fs.rename(tempPath, filePath);
  } catch {
    // Windows: rename fails with EPERM if destination exists
    await fs.unlink(filePath).catch(() => {});
    await fs.rename(tempPath, filePath);
  }
}
