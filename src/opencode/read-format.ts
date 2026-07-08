/**
 * @fileoverview Formats RAG retrieval output, hybrid file-content output, file fallbacks, and related-file suggestions for the read tool.
 */

import type { SearchResult } from "../core/interfaces.js";

/**
 * Options for formatting read tool output.
 */
export interface FormatReadOutputOptions {
  /** The requested file path (display-friendly). */
  filePath: string;
  /** The retrieval query used. */
  retrievalQuery: string;
  /** Search results to format. */
  results: SearchResult[];
  /** Maximum results to include. */
  maxChunks: number;
  /** Maximum output character count. */
  maxChars: number;
}

/**
 * Format RAG retrieval results for the search_semantic tool output.
 *
 * Includes request metadata (file path, query, chunk count) and formats
 * each chunk with file path, line range, score, and code block.
 *
 * Returns a string ready to return as the tool output.
 */
export function formatReadOutput(options: FormatReadOutputOptions): string {
  const { filePath, retrievalQuery, results, maxChunks, maxChars } = options;

  const header = buildContextHeader(filePath, retrievalQuery, results.length, maxChunks);
  let output = header;

  const limited = results.slice(0, maxChunks);

  for (let i = 0; i < limited.length; i++) {
    const r = limited[i];
    if (!r) continue;
    const chunkPart = formatChunk(i + 1, r);

    // Check if adding this chunk would exceed the limit
    if ((output + "\n" + chunkPart).length > maxChars) {
      // If we already have some content, append truncation notice
      const truncationNotice =
        "\n\n---\nOutput truncated by OpenCodeRAG to stay within maxReadOutputChars.\nUse a more specific query or line range to retrieve narrower context.";
      if ((output + truncationNotice).length <= maxChars) {
        output += truncationNotice;
      }
      break;
    }

    if (i > 0) {
      output += "\n";
    }
    output += chunkPart;
  }

  return output;
}

/**
 * Options for formatting hybrid read output (full file + RAG context).
 */
export interface FormatHybridReadOutputOptions {
  /** Absolute file path. */
  filePath: string;
  /** Full file content (or already sliced). */
  fileContent: string;
  /** Optional start line (1-indexed). */
  startLine?: number;
  /** Optional end line (1-indexed). */
  endLine?: number;
  /** RAG search results to append as context. */
  ragChunks: SearchResult[];
  /** Related files to suggest. */
  relatedFiles: RelatedFileEntry[];
  /** Maximum output character count. */
  maxChars: number;
}

/**
 * Format hybrid read output: full file contents followed by optional RAG context.
 *
 * The output:
 *   - Always includes the full file contents in a code block.
 *   - Appends relevant RAG chunks as supplementary context when available.
 *   - Appends related file suggestions when available.
 *   - Enforces maxChars limit (truncates RAG section first).
 */
export function formatHybridReadOutput(options: FormatHybridReadOutputOptions): string {
  const { filePath, fileContent, startLine, endLine, ragChunks, relatedFiles, maxChars } = options;

  const lang = guessLanguage(filePath);

  // Build the full file code block
  const lines = fileContent.split("\n");
  const sliceStart = startLine !== undefined ? startLine - 1 : 0;
  const sliceEnd = endLine !== undefined ? endLine : lines.length;
  const sliced = lines.slice(sliceStart, sliceEnd);
  const fileBlock = "```" + lang + "\n" + sliced.join("\n") + "\n```";

  // Build the RAG context section
  let ragSection = "";
  if (ragChunks.length > 0) {
    const minScore = ragChunks[ragChunks.length - 1]!.score;
    const maxScore = ragChunks[0]!.score;
    const ragLines: string[] = [
      "\n---\n",
      `**Related code chunks** _(${ragChunks.length} chunk${ragChunks.length === 1 ? "" : "s"}, relevance ${minScore.toFixed(2)}\u2013${maxScore.toFixed(2)})_\n`,
    ];

    for (let i = 0; i < ragChunks.length; i++) {
      const r = ragChunks[i]!;
      ragLines.push(formatChunk(i + 1, r));
    }

    ragSection = ragLines.join("\n");
  }

  // Build related files section
  let relatedSection = "";
  if (relatedFiles.length > 0) {
    relatedSection = "\n\n" + formatRelatedFiles(relatedFiles);
  }

  // Assemble output with maxChars enforcement
  let output = fileBlock;

  // Try adding RAG section
  if (ragSection && (output + ragSection).length <= maxChars) {
    output += ragSection;
  } else if (ragSection) {
    // Truncate RAG chunks to fit
    const available = maxChars - output.length - 100; // leave room for truncation notice
    if (available > 200) {
      output += ragSection.slice(0, available) + "\n\n---\nRAG context truncated.";
    }
  }

  // Try adding related files section
  if (relatedSection && (output + relatedSection).length <= maxChars) {
    output += relatedSection;
  }

  // Final safety truncation
  if (output.length > maxChars) {
    output = output.slice(0, maxChars) + "\n\n---\nOutput truncated.";
  }

  return output;
}

function buildContextHeader(
  filePath: string,
  retrievalQuery: string,
  totalResults: number,
  maxChunks: number
): string {
  const parts: string[] = [
    "OpenCodeRAG context",
    "",
    "Requested file:",
    `- ${filePath}`,
    "",
    "Retrieval query:",
    `- ${retrievalQuery.split("\n")[0]}` +
      (retrievalQuery.includes("\n") ? "..." : ""),
    "",
    `Returned chunks:`,
    `- ${Math.min(totalResults, maxChunks)} of max ${maxChunks}`,
    "",
  ];
  return parts.join("\n");
}

function formatChunk(index: number, result: SearchResult): string {
  const { chunk, score } = result;
  const metadata = chunk.metadata;
  const language = metadata.language || "";
  const lines: string[] = [];

  lines.push(`## Chunk ${index}`);
  lines.push(`File: ${metadata.filePath}`);
  lines.push(`Lines: ${metadata.startLine}-${metadata.endLine}`);
  lines.push(`Score: ${score.toFixed(4)}`);
  lines.push("");
  lines.push("```" + language);
  if (chunk.content.endsWith("\n")) {
    lines.push(chunk.content.slice(0, -1));
  } else {
    lines.push(chunk.content);
  }
  lines.push("```");

  return lines.join("\n");
}

/** A related file entry with path and score. */
export interface RelatedFileEntry {
  filePath: string;
  score: number;
}

/**
 * Options for formatting a direct file fallback.
 */
export interface FormatFileFallbackOptions {
  /** Absolute file path. */
  filePath: string;
  /** Raw file content (full file). */
  content: string;
  /** Optional start line (1-indexed). */
  startLine?: number;
  /** Optional end line (1-indexed). */
  endLine?: number;
  /** Reason why fallback was used. */
  reason: string;
  /** Maximum output character count. */
  maxChars?: number;
}

/**
 * Format raw file contents as a fallback when no RAG chunks are available.
 *
 * Applies optional line-range slicing and enforces maxChars limit.
 */
export function formatFileFallback(options: FormatFileFallbackOptions): string {
  const { filePath, content, startLine, endLine, maxChars } = options;

  const lines = content.split("\n");
  const sliceStart = startLine !== undefined ? startLine - 1 : 0;
  const sliceEnd = endLine !== undefined ? endLine : lines.length;
  const sliced = lines.slice(sliceStart, sliceEnd);

  const lang = guessLanguage(filePath);
  const codeBlock = "```" + lang + "\n" + sliced.join("\n") + "\n```";
  let output = codeBlock;

  if (maxChars && output.length > maxChars) {
    output = output.slice(0, maxChars) + "\n\n---\nOutput truncated.";
  }

  return output;
}

function guessLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    kt: "kotlin", swift: "swift", c: "c", cpp: "cpp", h: "c", hpp: "cpp",
    cs: "csharp", php: "php", sh: "bash", bash: "bash", zsh: "bash",
    md: "markdown", json: "json", yaml: "yaml", yml: "yaml", xml: "xml",
    html: "html", css: "css", scss: "scss", sql: "sql", toml: "toml",
  };
  return map[ext] ?? "";
}

/**
 * Format a list of related files as a lightweight suggestion section.
 *
 * Only includes file paths and scores — no code content — to keep tokens low.
 * Format: "Please consider reading other relevant files:\n1. ./path (Score: 0.92)\n..."
 */
export function formatRelatedFiles(entries: RelatedFileEntry[]): string {
  if (entries.length === 0) return "";

  const lines = entries.map(
    (entry, i) => `${i + 1}. ${entry.filePath} (Score: ${entry.score.toFixed(2)})`
  );

  return `Please consider reading other relevant files:\n${lines.join("\n")}`;
}
