import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface DocFileEntry {
  symbolsDocumented: string[];
  symbolsUndocumented: string[];
  errors: string[];
  lastAttempt: number;
}

export interface DocProgress {
  documented: string[];
  fileDetails: Record<string, DocFileEntry>;
  lastUpdated: number;
}

const PROGRESS_FILE = "doc-mode-progress.json";

function progressPath(storePath: string): string {
  return join(storePath, PROGRESS_FILE);
}

export function loadDocProgress(storePath: string): DocProgress {
  const filePath = progressPath(storePath);
  try {
    if (!existsSync(filePath)) return { documented: [], fileDetails: {}, lastUpdated: 0 };
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as DocProgress;
  } catch {
    return { documented: [], fileDetails: {}, lastUpdated: 0 };
  }
}

export function saveDocProgress(storePath: string, progress: DocProgress): void {
  const filePath = progressPath(storePath);
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(progress, null, 2), "utf-8");
  } catch {
    // silently ignore write errors
  }
}

export function markFileDocumented(storePath: string, filePath: string): void {
  const progress = loadDocProgress(storePath);
  if (!progress.documented.includes(filePath)) {
    progress.documented.push(filePath);
    progress.lastUpdated = Date.now();
    saveDocProgress(storePath, progress);
  }
}

export function updateFileDocDetails(
  storePath: string,
  filePath: string,
  details: Partial<DocFileEntry>,
): void {
  const progress = loadDocProgress(storePath);
  if (!progress.fileDetails[filePath]) {
    progress.fileDetails[filePath] = {
      symbolsDocumented: [],
      symbolsUndocumented: [],
      errors: [],
      lastAttempt: 0,
    };
  }
  const entry = progress.fileDetails[filePath];
  if (entry) {
    if (details.symbolsDocumented) entry.symbolsDocumented = details.symbolsDocumented;
    if (details.symbolsUndocumented) entry.symbolsUndocumented = details.symbolsUndocumented;
    if (details.errors) entry.errors = details.errors;
    entry.lastAttempt = Date.now();
  }
  progress.lastUpdated = Date.now();
  saveDocProgress(storePath, progress);
}
