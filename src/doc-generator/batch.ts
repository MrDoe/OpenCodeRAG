import pLimit from "p-limit";
import type { DocOptions, DocFileInput, DocFileResult, DocSymbol } from "./types.js";
import { DocGenerator } from "./generator.js";
import { applyDocComments, type EditResult } from "./editor.js";
import { parseFileForSymbols } from "./parser.js";
import { scanWorkspaceForDocs, filterByFilePaths, type ScannedFile } from "./scanner.js";

export interface BatchProgress {
  total: number;
  completed: number;
  documented: number;
  failed: number;
  skipped: number;
  errors: string[];
  edits: EditResult[];
}

async function processFile(
  file: ScannedFile,
  options: DocOptions,
  onProgress?: (filePath: string, status: string) => void,
): Promise<EditResult> {
  onProgress?.(file.filePath, "parsing");

  const symbols = await parseFileForSymbols(
    file.filePath,
    file.content,
    file.language,
    options.skipExisting,
  );

  if (symbols.length === 0) {
    onProgress?.(file.filePath, "skipped");
    return {
      filePath: file.filePath,
      originalContent: file.content,
      modifiedContent: file.content,
      editsApplied: 0,
    };
  }

  onProgress?.(file.filePath, "generating");

  const generator = new DocGenerator(options);
  const input: DocFileInput = {
    filePath: file.filePath,
    content: file.content,
    language: file.language,
    symbols,
  };

  const result = await generator.generateForFile(input);

  if (result.documented === 0 || options.dryRun) {
    onProgress?.(file.filePath, options.dryRun ? "dry-run" : "failed");
    return {
      filePath: file.filePath,
      originalContent: file.content,
      modifiedContent: file.content,
      editsApplied: 0,
    };
  }

  const nonEmptyDocBlocks = result.symbols
    .slice(0, result.documented)
    .map(() => "/** TODO: generated */");

  onProgress?.(file.filePath, "applying");

  const editResult = applyDocComments(
    file.filePath,
    file.content,
    result.symbols,
    nonEmptyDocBlocks,
    options.storePath,
    options.dryRun,
  );

  onProgress?.(file.filePath, editResult.editsApplied > 0 ? "documented" : "skipped");
  return editResult;
}

export interface DocRunConfig {
  options: DocOptions;
  onProgress?: (progress: BatchProgress) => void;
}

export async function runDocMode(config: DocRunConfig): Promise<BatchProgress> {
  const { options, onProgress } = config;
  const worktree = options.worktree;

  const progress: BatchProgress = {
    total: 0,
    completed: 0,
    documented: 0,
    failed: 0,
    skipped: 0,
    errors: [],
    edits: [],
  };

  const allFiles = await scanWorkspaceForDocs(worktree, options);
  progress.total = allFiles.length;

  onProgress?.({ ...progress });

  if (allFiles.length === 0) {
    return progress;
  }

  const limit = pLimit(options.concurrency);
  const fileTasks = allFiles.map((file) =>
    limit(async () => {
      try {
        const editResult = await processFile(file, options, (_fp, status) => {
          if (status === "skipped") progress.skipped++;
          else if (status === "documented" || status === "dry-run") progress.documented++;
          else if (status === "failed") progress.failed++;
          progress.completed++;
          onProgress?.({ ...progress });
        });
        progress.edits.push(editResult);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        progress.errors.push(`${file.filePath}: ${message}`);
        progress.failed++;
        progress.completed++;
        onProgress?.({ ...progress });
      }
    }),
  );

  await Promise.all(fileTasks);

  return progress;
}

export async function runDocModeForFiles(
  filePaths: string[],
  config: DocRunConfig,
): Promise<BatchProgress> {
  const { options } = config;
  const worktree = options.worktree;

  const allFiles = await scanWorkspaceForDocs(worktree, options);
  const filteredFiles = filterByFilePaths(allFiles, filePaths);

  const progress: BatchProgress = {
    total: filteredFiles.length,
    completed: 0,
    documented: 0,
    failed: 0,
    skipped: 0,
    errors: [],
    edits: [],
  };

  if (filteredFiles.length === 0) return progress;

  const limit = pLimit(options.concurrency);
  await Promise.all(
    filteredFiles.map((file) =>
      limit(async () => {
        try {
          const editResult = await processFile(file, options);
          progress.edits.push(editResult);
          if (editResult.editsApplied > 0) progress.documented++;
          else progress.skipped++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          progress.errors.push(`${file.filePath}: ${message}`);
          progress.failed++;
        }
        progress.completed++;
      }),
    ),
  );

  return progress;
}
