import fs from "node:fs";
import type { DocSymbol } from "./types.js";
import { markFileDocumented } from "../core/doc-progress.js";

export interface EditResult {
  filePath: string;
  originalContent: string;
  modifiedContent: string;
  editsApplied: number;
}

export function applyDocComments(
  filePath: string,
  content: string,
  symbols: DocSymbol[],
  docBlocks: string[],
  storePath: string,
  dryRun: boolean,
): EditResult {
  if (docBlocks.length === 0 || symbols.length === 0) {
    return {
      filePath,
      originalContent: content,
      modifiedContent: content,
      editsApplied: 0,
    };
  }

  const lines = content.split("\n");
  let editsApplied = 0;
  const sorted = symbols.slice(0, Math.min(docBlocks.length, symbols.length));

  for (let i = 0; i < sorted.length; i++) {
    const symbol = sorted[i];
    if (!symbol) continue;
    const docBlock = docBlocks[i];
    if (!docBlock) continue;

    const insertLine = symbol.startLine - 1;
    const indentation = getIndentation(lines, insertLine);

    const formattedBlock = formatDocBlock(docBlock, indentation);
    lines.splice(insertLine, 0, ...formattedBlock);
    editsApplied++;

    for (let j = i + 1; j < sorted.length; j++) {
      const next = sorted[j];
      if (next) {
        next.startLine += formattedBlock.length;
        next.endLine += formattedBlock.length;
      }
    }
  }

  const modifiedContent = lines.join("\n");

  if (!dryRun) {
    fs.writeFileSync(filePath, modifiedContent, "utf-8");
    markFileDocumented(storePath, filePath);
  }

  return {
    filePath,
    originalContent: content,
    modifiedContent,
    editsApplied,
  };
}

function getIndentation(lines: string[], lineIndex: number): string {
  if (lineIndex < 0 || lineIndex >= lines.length) return "";
  const line = lines[lineIndex];
  if (!line) return "";
  const match = line.match(/^(\s*)/);
  return match ? (match[1] ?? "") : "";
}

function formatDocBlock(rawBlock: string, indentation: string): string[] {
  const cleanBlock = rawBlock.startsWith("/**")
    ? rawBlock
    : `/**\n * ${rawBlock.replace(/\*\//g, "*\\/")}\n*/`;

  const lines = cleanBlock.split("\n");

  if (lines.length === 1 && lines[0] != null) {
    const singleLine = indentation + " " + lines[0].trimStart();
    return ["", singleLine];
  }

  const resultLines = lines.map((line) => {
    if (!line.trim()) return indentation + " *";
    return indentation + " " + line.trimStart();
  });

  const lastIdx = resultLines.length - 1;
  if (resultLines.length > 0) {
    resultLines[0] = indentation + "/**";
  }
  if (lastIdx > 0) {
    resultLines[lastIdx] = indentation + " */";
  }

  return ["", ...resultLines];
}

export function formatDocFileResult(result: EditResult): string {
  return [
    `File: ${result.filePath}`,
    `Edits: ${result.editsApplied}`,
  ].join("\n");
}
