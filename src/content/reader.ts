/**
 * @fileoverview Walks the workspace directory tree and dispatches file reading and content extraction for indexing.
 */

import fs from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import type { RagConfig } from "../core/config.js";
import { computeFileHash, computeDescriptionConfigHash, normalizeFilePath, type FileManifest } from "../core/manifest.js";
import { createExcludeMatcher, createIncludeMatcher, type ExcludeMatcher, type IncludedMatcher } from "../core/exclude.js";
import { DescriptionCache } from "../core/desc-cache.js";
import {
  createImageVisionProvider,
  type ImageVisionProvider,
} from "../chunker/image.js";
import type { ExtractResult } from "./types.js";
import * as pdfExtractor from "./pdf.js";
import * as docxExtractor from "./docx.js";
import * as docExtractor from "./doc.js";
import * as excelExtractor from "./excel.js";
import * as imageExtractor from "./image.js";

/** Metadata and extracted content for a single workspace file discovered during scanning. */
export interface WorkspaceFile {
  filePath: string;
  normalizedPath: string;
  content: string;
  hash: string;
  isEmpty: boolean;
  isTooSmall: boolean;
  extractionStatus: "ok" | "skipped" | "failed";
  extractionError?: string;
  mtime?: number;
  size?: number;
}

interface Logger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

/**
 * Recursively walk a directory tree and collect paths matching the given extension set,
 * respecting exclusion lists and configurable limits for max directories and results.
 */
export async function walkFiles(
  dir: string,
  extensions: Set<string>,
  excludeDirs: ExcludeMatcher,
  excludeFiles?: ExcludeMatcher,
  includeDirs?: IncludedMatcher,
  rootDir = dir,
  logger?: Logger,
  dirCount?: { value: number },
  maxDirs = 10_000,
  maxResults = 100_000,
): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const rel = path.relative(rootDir, fullPath);
      if ((includeDirs && !includeDirs.included(rel)) || excludeDirs.excluded(rel)) continue;
      if (dirCount) {
        dirCount.value++;
        if (dirCount.value % 100 === 0) {
          logger?.info(`Traversed ${dirCount.value} directories... (${fullPath})`);
        }
        if (dirCount.value > maxDirs) {
          logger?.warn(`Exceeded ${maxDirs} directories — truncating walk at ${fullPath}`);
          return results;
        }
      }
      if (results.length >= maxResults) {
        logger?.warn(`Exceeded ${maxResults} matching files — truncating walk at ${fullPath}`);
        return results;
      }
      results.push(...(await walkFiles(fullPath, extensions, excludeDirs, excludeFiles, includeDirs, rootDir, logger, dirCount, maxDirs, maxResults)));
    } else if (entry.isFile()) {
      if (results.length >= maxResults) {
        logger?.warn(`Exceeded ${maxResults} matching files — truncating walk`);
        return results;
      }
      const ext = path.extname(entry.name).toLowerCase();
      const basename = entry.name.toLowerCase();
      if ((extensions.has(ext) || extensions.has(basename)) && !excludeFiles?.excluded(path.relative(rootDir, fullPath))) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

async function dispatchExtraction(
  filePath: string,
  buffer: Buffer,
  imageVisionProvider: ImageVisionProvider | null,
  imagePrompt: string | undefined,
  resizeMaxDimension?: number,
): Promise<ExtractResult> {
  const ext = path.extname(filePath).toLowerCase();

  if (pdfExtractor.PDF_EXTENSIONS.has(ext)) {
    return pdfExtractor.extract(filePath, buffer);
  }
  if (docxExtractor.DOCX_EXTENSIONS.has(ext)) {
    return docxExtractor.extract(filePath, buffer);
  }
  if (docExtractor.DOC_EXTENSIONS.has(ext)) {
    return docExtractor.extract(filePath, buffer);
  }
  if (excelExtractor.EXCEL_EXTENSIONS.has(ext)) {
    return excelExtractor.extract(filePath, buffer);
  }
  if (imageVisionProvider && imageExtractor.isImageFile(filePath)) {
    return imageExtractor.extract(filePath, buffer, imageVisionProvider, imagePrompt ?? "", resizeMaxDimension);
  }

  try {
    const content = await fs.readFile(filePath, "utf-8");
    return { content, ok: true };
  } catch (err) {
    return { content: "", ok: false, error: (err as Error).message };
  }
}

/**
 * Scan the workspace directory for indexable files, reading content or dispatching
 * binary extraction (PDF, DOCX, DOC, Excel, images). Respects the file manifest
 * for incremental re-indexing by skipping unchanged files.
 *
 * @param descCache - Optional persistent description cache. When set, image
 *   descriptions are cached and reused across sessions (survives aborted runs).
 */
export async function scanWorkspaceFiles(
  cwd: string,
  config: RagConfig,
  logger?: Logger,
  manifest?: FileManifest,
  filterPaths?: string[],
  injectedVisionProvider?: ImageVisionProvider,
  descCache?: DescriptionCache,
): Promise<WorkspaceFile[]> {
  const extensions = new Set(config.indexing.includeExtensions);

  let imageVisionProvider: ImageVisionProvider | null = null;
  let imagePrompt: string | undefined;
  let imageResizeMaxDimension: number | undefined;
  const imageCfg = config.imageDescription;
  if (imageCfg?.enabled) {
    for (const ext of imageExtractor.SUPPORTED_IMAGE_EXTENSIONS) {
      extensions.add(ext.toLowerCase());
    }
    imageVisionProvider = injectedVisionProvider ?? createImageVisionProvider(imageCfg);
    imagePrompt = imageCfg.prompt;
    imageResizeMaxDimension = imageCfg.resizeMaxDimension;
  }

  const excludeDirMatcher = createExcludeMatcher(config.indexing.excludeDirs);
  const excludeFileMatcher = createExcludeMatcher(config.indexing.excludeFiles ?? []);
  const includeDirMatcher = createIncludeMatcher(config.indexing.includeDirs ?? []);

  let files: string[];
  if (filterPaths && filterPaths.length > 0) {
    files = filterPaths
      .map((p) => path.resolve(cwd, p))
      .filter((fp) => {
        const ext = path.extname(fp).toLowerCase();
        const basename = path.basename(fp).toLowerCase();
        if (!extensions.has(ext) && !extensions.has(basename)) return false;
        const rel = path.relative(cwd, fp);
        if (rel.startsWith("..")) return false;
        return includeDirMatcher.included(rel) && !excludeDirMatcher.excluded(rel) && !excludeFileMatcher.excluded(rel);
      });
  } else {
    logger?.info("Walking directory tree...");
    const walkStart = Date.now();
    const dirCount = { value: 0 };
    files = await walkFiles(
      cwd,
      extensions,
      excludeDirMatcher,
      excludeFileMatcher,
      includeDirMatcher,
      cwd,
      logger,
      dirCount,
    );
    const walkSec = ((Date.now() - walkStart) / 1000).toFixed(1);
    logger?.info(`Found ${files.length} matching files in ${walkSec}s (${dirCount.value} dirs traversed)`);
  }

  const totalFiles = files.length;
  const scanStart = Date.now();

  const minSize = config.indexing.minFileSizeBytes ?? 0;
  const scanConcurrency = Math.min(config.indexing.concurrency * 2, 16);
  const textLimit = pLimit(scanConcurrency);
  const imageLimit = pLimit(1);

  // Compute a hash of the image description config — used to build cache keys.
  const imageDescConfigHash = config.imageDescription?.enabled
    ? computeDescriptionConfigHash(config) ?? ""
    : "";

  let completed = 0;

  async function processFile(filePath: string): Promise<WorkspaceFile> {
    const normalizedPath = normalizeFilePath(filePath);

    if (manifest?.files[normalizedPath]) {
      try {
        const stat = await fs.stat(filePath);
        const entry = manifest.files[normalizedPath]!;
        if (entry.mtime === stat.mtimeMs && entry.size === stat.size) {
          // Fast path — BUT only when the description config is unchanged:
          // when descHash differs, the worker needs the full content to
          // re-chunk and re-describe the file. Returning empty content here
          // would make chunkFile() yield zero chunks and the pipeline would
          // DELETE the file from the index instead of re-describing it.
          // Mirrors pipeline.ts: `descriptionProvider ? computeDescriptionConfigHash(config) : undefined`.
          const currentDescHash = config.description?.enabled
            ? (computeDescriptionConfigHash(config) ?? "")
            : "";
          if (!currentDescHash || entry.descHash === currentDescHash) {
            completed++;
            return {
              filePath,
              normalizedPath,
              content: "",
              hash: entry.hash,
              isEmpty: false,
              isTooSmall: false,
              extractionStatus: "ok" as const,
              mtime: stat.mtimeMs,
              size: stat.size,
            } satisfies WorkspaceFile;
          }
        }
      } catch {
        /* stat failed, fall through to full read */
      }
    }

    const isImage = imageVisionProvider !== null && imageExtractor.isImageFile(filePath);

    const ext = path.extname(filePath).toLowerCase();
    const isBinary =
      pdfExtractor.PDF_EXTENSIONS.has(ext) ||
      docxExtractor.DOCX_EXTENSIONS.has(ext) ||
      docExtractor.DOC_EXTENSIONS.has(ext) ||
      excelExtractor.EXCEL_EXTENSIONS.has(ext) ||
      isImage;

    // Reject oversized binaries BEFORE buffering them — a 2 GB PDF was
    // previously read fully into memory only to be rejected by the
    // 100 MB check inside the PDF extractor.
    if (isBinary && pdfExtractor.PDF_EXTENSIONS.has(ext)) {
      try {
        const stat = await fs.stat(filePath);
        if (stat.size > 100 * 1024 * 1024) {
          logger?.warn(`  ${filePath} (PDF exceeds 100 MB — skipping)`);
          completed++;
          return {
            filePath,
            normalizedPath,
            content: "",
            hash: computeFileHash(""),
            isEmpty: true,
            isTooSmall: false,
            extractionStatus: "ok" as const,
            mtime: stat.mtimeMs,
            size: stat.size,
          } satisfies WorkspaceFile;
        }
      } catch {
        /* stat failed, fall through to read */
      }
    }

    logger?.debug(`Reading: ${filePath}`);

    const buffer = isBinary ? await fs.readFile(filePath) : Buffer.alloc(0);

    // For images, check the persistent description cache before calling the vision provider
    if (isImage && descCache && imageDescConfigHash) {
      const imageBytesHash = computeFileHash(buffer.toString("base64"));
      const cacheKey = DescriptionCache.imageKey(imageBytesHash, imageDescConfigHash);
      const cachedDesc = descCache.get(cacheKey);
      if (cachedDesc) {
        logger?.info(`  Using cached image description: ${filePath}`);
        const content = cachedDesc;
        let fileMtime: number | undefined;
        let fileSize: number | undefined;
        try {
          const stat = await fs.stat(filePath);
          fileMtime = stat.mtimeMs;
          fileSize = stat.size;
        } catch { /* best-effort stat */ }
        completed++;
        return {
          filePath,
          normalizedPath,
          content,
          hash: computeFileHash(content),
          isEmpty: false,
          isTooSmall: false,
          extractionStatus: "ok" as const,
          mtime: fileMtime,
          size: fileSize,
        } satisfies WorkspaceFile;
      }
    }

    if (isImage) {
      logger?.info(`  Describing image: ${filePath}`);
    }

    const result = await dispatchExtraction(filePath, buffer, imageVisionProvider, imagePrompt, imageResizeMaxDimension);

    // Cache the image description for future runs. Saves are throttled —
    // a full cache rewrite per image was O(n²) I/O for image-heavy workspaces.
    // The pipeline saves the cache again at the end of a pass.
    if (isImage && result.ok && descCache && imageDescConfigHash) {
      const imageBytesHash = computeFileHash(buffer.toString("base64"));
      const cacheKey = DescriptionCache.imageKey(imageBytesHash, imageDescConfigHash);
      descCache.set(cacheKey, result.content);
      if (completed % 25 === 0) {
        await descCache.save();
      }
    }

    if (!result.ok) {
      logger?.warn(`  ${filePath} (extraction failed: ${result.error})`);

      // A transient extraction failure (file lock, antivirus, timeout) must
      // NOT delete a previously-good index entry. Report the file as
      // unchanged with the OLD hash so the worker keeps the old chunks;
      // the entry stays and the file is re-attempted on a later pass.
      const previous = manifest?.files[normalizedPath];
      if (previous) {
        completed++;
        return {
          filePath,
          normalizedPath,
          content: "",
          hash: previous.hash,
          isEmpty: false,
          isTooSmall: false,
          extractionStatus: "failed" as const,
          extractionError: result.error,
          mtime: previous.mtime,
          size: previous.size,
        } satisfies WorkspaceFile;
      }
    }

    const content = result.content;
    const byteLength = Buffer.byteLength(content, "utf-8");

    let fileMtime: number | undefined;
    let fileSize: number | undefined;
    if (result.ok) {
      try {
        const stat = await fs.stat(filePath);
        fileMtime = stat.mtimeMs;
        fileSize = stat.size;
      } catch {
        /* best-effort stat */
      }
    }

    completed++;
    if (completed % 500 === 0 || completed === totalFiles) {
      logger?.info(`Scanned ${completed}/${totalFiles} files...`);
    }

    return {
      filePath,
      normalizedPath,
      content,
      hash: computeFileHash(content),
      isEmpty: content.trim().length === 0,
      isTooSmall: content.trim().length === 0 ? false : byteLength < minSize,
      extractionStatus: result.ok ? "ok" : "failed",
      extractionError: result.ok ? undefined : result.error,
      mtime: fileMtime,
      size: fileSize,
    } satisfies WorkspaceFile;
  }

  const tasks = files.map((filePath) => {
    const isImage = imageVisionProvider !== null && imageExtractor.isImageFile(filePath);
    return isImage ? imageLimit(() => processFile(filePath)) : textLimit(() => processFile(filePath));
  });

  const workspaceFiles = await Promise.all(tasks);
  const scanSec = ((Date.now() - scanStart) / 1000).toFixed(1);
  logger?.info(`Scan complete: ${workspaceFiles.length} files processed in ${scanSec}s`);
  return workspaceFiles;
}
