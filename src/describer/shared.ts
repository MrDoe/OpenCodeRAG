/**
 * @fileoverview Shared utilities for building description provider user messages and implementing sleep delays.
 */
import type { Chunk } from "../core/interfaces.js";

/**
 * Build a formatted user message string from a code chunk for LLM description requests.
 *
 * Includes file path, language, line range, and the chunk content wrapped in a markdown code block.
 * Truncates content to maxContentChars if specified.
 *
 * @param chunk - The code chunk to describe
 * @param maxContentChars - Optional maximum number of characters to include from the chunk content
 * @returns Formatted message string ready to send to an LLM
 */
export function buildUserMessage(chunk: Chunk, maxContentChars?: number): string {
  const parts: string[] = [];

  if (chunk.metadata.filePath) {
    parts.push(`File: ${chunk.metadata.filePath}`);
  }
  if (chunk.metadata.language) {
    parts.push(`Language: ${chunk.metadata.language}`);
  }
  parts.push(`Lines: ${chunk.metadata.startLine}-${chunk.metadata.endLine}`);
  parts.push("");
  parts.push("```" + (chunk.metadata.language || ""));

  let content = chunk.content;
  if (maxContentChars && content.length > maxContentChars) {
    content = content.slice(0, maxContentChars) + "\n... [truncated]";
  }

  parts.push(content);
  parts.push("```");

  return parts.join("\n");
}

/** Promise-based delay for use with async/await. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a user message describing multiple chunks in a single LLM request.
 *
 * Each chunk is wrapped in `[CHUNK <n>] ... [END CHUNK <n>]` markers using
 * short ordinal labels (1-based position in the group) rather than chunk
 * UUIDs — small models reliably reproduce `n: <description>` lines but often
 * mangle long random ids. The model is asked to reply with exactly one line
 * per chunk in `<n>: <one-line description>` format (see
 * `parseBatchDescriptions`); labels map back to chunks by position.
 *
 * @param chunks - The chunks to describe in one request
 * @param maxContentChars - Optional per-chunk content truncation limit
 * @returns Formatted message string for the batched LLM request
 */
export function buildBatchUserMessage(chunks: Chunk[], maxContentChars?: number): string {
  const parts: string[] = [
    "Describe each code chunk below in ONE short sentence (max 20 words) each.",
    "Do not repeat code in your descriptions.",
    "Reply with EXACTLY one line per chunk, in this format:",
    "<number>: <one-line description>",
    "",
  ];

  chunks.forEach((chunk, index) => {
    const label = index + 1;
    parts.push(`[CHUNK ${label}]`);
    parts.push(buildUserMessage(chunk, maxContentChars));
    parts.push(`[END CHUNK ${label}]`);
    parts.push("");
  });

  return parts.join("\n").trim();
}

/**
 * Parse a batched description response into a `label → description` map.
 *
 * Tolerant parser: only lines matching `<label>: <text>` are kept, so
 * preamble, trailing prose, or markdown fences are ignored. Labels are the
 * short ordinals used in `buildBatchUserMessage` (e.g. `1: handles auth`);
 * they are mapped back to chunk IDs by position in the calling group.
 * Duplicate labels keep the first occurrence.
 *
 * @param content - Raw response text from the LLM
 * @returns Map of label to description (may be empty or partial)
 */
export function parseBatchDescriptions(content: string): Map<string, string> {
  const result = new Map<string, string>();
  const lineRe = /^([A-Za-z0-9_.-]+):\s*(.+)$/;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = lineRe.exec(line);
    if (match && match[1] && match[2] && match[2].trim().length > 0) {
      const id = match[1];
      if (!result.has(id)) {
        result.set(id, match[2].trim());
      }
    }
  }
  return result;
}
