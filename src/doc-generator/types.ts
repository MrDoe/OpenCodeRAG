export type DocSymbolKind =
  | "class"
  | "struct"
  | "interface"
  | "enum"
  | "function"
  | "method"
  | "constructor"
  | "property"
  | "field"
  | "type"
  | "trait"
  | "module"
  | "exported-variable";

export interface DocSymbol {
  name: string;
  kind: DocSymbolKind;
  startLine: number;
  endLine: number;
  hasExistingDoc: boolean;
  signature: string;
}

export interface DocFileResult {
  filePath: string;
  symbols: DocSymbol[];
  documented: number;
  skipped: number;
  errors: string[];
  docBlocks: string[];
  status: "ok" | "skipped" | "failed";
}

export interface DocFileInput {
  filePath: string;
  content: string;
  language: string;
  symbols: DocSymbol[];
}

export interface DocProgressSnapshot {
  documented: string[];
  fileDetails: Record<string, {
    symbolsDocumented: string[];
    symbolsUndocumented: string[];
    errors: string[];
    lastAttempt: number;
  }>;
  lastUpdated: number;
}

export interface DocOptions {
  style: "google" | "jsdoc";
  batchSize: number;
  concurrency: number;
  skipExisting: boolean;
  includeExtensions: string[];
  excludeDirs: string[];
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  systemPrompt: string;
  dryRun: boolean;
  storePath: string;
  worktree: string;
}
