import fs from "node:fs/promises";
import path from "node:path";
import type { DocOptions } from "./types.js";
import { loadDocProgress } from "../core/doc-progress.js";

export interface ScannedFile {
  filePath: string;
  content: string;
  language: string;
}

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".java": "java",
  ".go": "go",
  ".rs": "rust",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".php": "php",
};

async function walkCodeFiles(
  dir: string,
  extensions: Set<string>,
  excludeDirs: Set<string>,
): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (excludeDirs.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;
      results.push(...(await walkCodeFiles(fullPath, extensions, excludeDirs)));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (extensions.has(ext)) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_LANG[ext] ?? "unknown";
}

export async function scanWorkspaceForDocs(
  worktree: string,
  options: DocOptions,
): Promise<ScannedFile[]> {
  const extensions = new Set(options.includeExtensions);
  const excludeDirs = new Set(options.excludeDirs);
  const filePaths = await walkCodeFiles(worktree, extensions, excludeDirs);

  const progress = loadDocProgress(options.storePath);
  const alreadyDocumented = new Set(progress.documented);

  const results: ScannedFile[] = [];

  for (const filePath of filePaths) {
    if (alreadyDocumented.has(filePath)) continue;

    try {
      const content = await fs.readFile(filePath, "utf-8");
      if (content.trim().length === 0) continue;

      const language = detectLanguage(filePath);
      if (language === "unknown") continue;

      results.push({ filePath, content, language });
    } catch {
      continue;
    }
  }

  return results;
}

export function filterByFilePaths(
  files: ScannedFile[],
  targetPaths: string[],
): ScannedFile[] {
  const targets = new Set(targetPaths.map((p) => path.resolve(p)));
  return files.filter((f) => targets.has(f.filePath));
}
