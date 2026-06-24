import fs from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import type { RagConfig } from "../core/config.js";
import { computeFileHash, normalizeFilePath, type FileManifest } from "../core/manifest.js";
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

export async function walkFiles(
  dir: string,
  extensions: Set<string>,
  excludeDirs: Set<string>,
  excludeFiles?: Set<string>,
  logger?: Logger,
  dirCount?: { value: number },
): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  let dCount = dirCount ?? { value: 0 };

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (excludeDirs.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;
      dCount.value++;
      if (dCount.value % 100 === 0) {
        logger?.info(`  Traversed ${dCount.value} directories... (${fullPath})`);
      }
      results.push(...(await walkFiles(fullPath, extensions, excludeDirs, excludeFiles, logger, dCount)));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      const basename = entry.name.toLowerCase();
      if ((extensions.has(ext) || extensions.has(basename)) && !excludeFiles?.has(basename)) {
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
  const lower = filePath.toLowerCase();

  if (pdfExtractor.PDF_EXTENSIONS.has(lower)) {
    return pdfExtractor.extract(filePath, buffer);
  }
  if (docxExtractor.DOCX_EXTENSIONS.has(lower)) {
    return docxExtractor.extract(filePath, buffer);
  }
  if (docExtractor.DOC_EXTENSIONS.has(lower)) {
    return docExtractor.extract(filePath, buffer);
  }
  if (excelExtractor.EXCEL_EXTENSIONS.has(lower)) {
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

export async function scanWorkspaceFiles(
  cwd: string,
  config: RagConfig,
  logger?: Logger,
  manifest?: FileManifest,
  filterPaths?: string[],
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
    imageVisionProvider = createImageVisionProvider(imageCfg);
    imagePrompt = imageCfg.prompt;
    imageResizeMaxDimension = imageCfg.resizeMaxDimension;
  }

  let files: string[];
  if (filterPaths && filterPaths.length > 0) {
    const excludeDirs = new Set(config.indexing.excludeDirs);
    const excludeFiles = new Set(config.indexing.excludeFiles?.map((f) => f.toLowerCase()) ?? []);
    files = filterPaths
      .map((p) => path.resolve(cwd, p))
      .filter((fp) => {
        const ext = path.extname(fp).toLowerCase();
        const basename = path.basename(fp).toLowerCase();
        if (!extensions.has(ext) && !extensions.has(basename)) return false;
        if (excludeFiles.has(basename)) return false;
        const rel = path.relative(cwd, fp);
        if (rel.startsWith("..")) return false;
        const parts = rel.split(path.sep);
        if (parts.some((part) => excludeDirs.has(part))) return false;
        return true;
      });
  } else {
    logger?.info("  Walking directory tree...");
    const walkStarted = Date.now();
    files = await walkFiles(
      cwd,
      extensions,
      new Set(config.indexing.excludeDirs),
      new Set(config.indexing.excludeFiles?.map((f) => f.toLowerCase()) ?? []),
      logger,
    );
    logger?.info(`  Found ${files.length} matching files in ${((Date.now() - walkStarted) / 1000).toFixed(1)}s`);
  }

  const totalFiles = files.length;
  logger?.debug(`Found ${totalFiles} files to scan`);

  const minSize = config.indexing.minFileSizeBytes ?? 0;
  const scanConcurrency = Math.min(config.indexing.concurrency * 2, 16);
  const textLimit = pLimit(scanConcurrency);
  const imageLimit = pLimit(1);

  let completed = 0;

  async function processFile(filePath: string): Promise<WorkspaceFile> {
    const normalizedPath = normalizeFilePath(filePath);

    if (manifest?.files[normalizedPath]) {
      try {
        const stat = await fs.stat(filePath);
        const entry = manifest.files[normalizedPath]!;
        if (entry.mtime === stat.mtimeMs && entry.size === stat.size) {
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
      } catch {
        /* stat failed, fall through to full read */
      }
    }

    const isBinary =
      pdfExtractor.PDF_EXTENSIONS.has(filePath.toLowerCase()) ||
      docxExtractor.DOCX_EXTENSIONS.has(filePath.toLowerCase()) ||
      docExtractor.DOC_EXTENSIONS.has(filePath.toLowerCase()) ||
      excelExtractor.EXCEL_EXTENSIONS.has(filePath.toLowerCase()) ||
      (imageVisionProvider !== null && imageExtractor.isImageFile(filePath));

    const buffer = isBinary ? await fs.readFile(filePath) : Buffer.alloc(0);
    const result = await dispatchExtraction(filePath, buffer, imageVisionProvider, imagePrompt, imageResizeMaxDimension);

    if (!result.ok) {
      logger?.warn(`  ${filePath} (extraction failed: ${result.error})`);
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
    if (completed % 500 === 0) {
      logger?.info(`  Scanned ${completed}/${totalFiles} files...`);
    }
    logger?.debug(`  ${filePath}`);

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
  logger?.info(`  Scan complete: ${workspaceFiles.length} files processed`);
  return workspaceFiles;
}
