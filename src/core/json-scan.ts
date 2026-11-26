/**
 * @fileoverview Piecewise reader for large JSON object files.
 *
 * V8 caps a string at roughly 512 MB, so a file bigger than that cannot be
 * handed to `JSON.parse` in one go - and neither can a single large section of
 * it. This scanner walks the file in blocks and returns the root object one
 * member at a time, splitting containers into their individual elements, so
 * only one element ever has to fit in a string.
 */
import { open } from "node:fs/promises";

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

const DEFAULT_BLOCK_BYTES = 4 * 1024 * 1024;

/** Receivers for the parts of the root object. */
export interface JsonScanHandlers {
  /** A root member whose value is not a container, as `"key":value` source. */
  scalar(member: string): void;
  /**
   * One element of a root member that is an array or object: the element's
   * source for arrays, `"name":value` for objects.
   */
  element(key: string, source: string): void;
}

/**
 * Stream the JSON object stored in `filePath` to `handlers`.
 *
 * Structural characters are all ASCII, so multi-byte UTF-8 sequences can be
 * split across blocks without affecting the scan.
 *
 * @param filePath   - File holding one JSON object.
 * @param handlers   - Receivers for scalar members and container elements.
 * @param blockBytes - Read block size (tests use tiny blocks).
 * @throws If the file ends before the root object is closed.
 */
export async function scanJsonObjectFile(
  filePath: string,
  handlers: JsonScanHandlers,
  blockBytes: number = DEFAULT_BLOCK_BYTES,
): Promise<void> {
  const handle = await open(filePath, "r");
  try {
    const block = Buffer.alloc(blockBytes);
    let pieces: Buffer[] = [];
    let depth = 0;
    let inString = false;
    let escaped = false;
    let key = "";
    /** True between the end of a container value and the next root comma. */
    let containerDone = false;
    let closed = false;

    for (;;) {
      const { bytesRead } = await handle.read(block, 0, block.length, null);
      if (bytesRead === 0) break;
      /** Start of the not-yet-collected part of the current token. */
      let start = 0;

      /** Return everything collected up to `end` and begin the next token. */
      const take = (end: number): string => {
        pieces.push(block.subarray(start, end));
        const text = Buffer.concat(pieces).toString("utf8").trim();
        pieces = [];
        start = end + 1;
        return text;
      };

      for (let i = 0; i < bytesRead; i++) {
        const byte = block[i]!;
        if (inString) {
          if (escaped) escaped = false;
          else if (byte === BACKSLASH) escaped = true;
          else if (byte === QUOTE) inString = false;
          continue;
        }
        if (byte === QUOTE) {
          inString = true;
        } else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
          if (depth === 0) {
            take(i);
          } else if (depth === 1) {
            // `"name":` precedes the container.
            key = JSON.parse(take(i).replace(/:$/, "").trim()) as string;
          }
          depth++;
        } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
          depth--;
          if (depth === 1) {
            const last = take(i);
            if (last) handlers.element(key, last);
            containerDone = true;
          } else if (depth === 0) {
            const last = take(i);
            if (!containerDone && last) handlers.scalar(last);
            closed = true;
          }
        } else if (byte === COMMA) {
          if (depth === 2) {
            handlers.element(key, take(i));
          } else if (depth === 1) {
            const member = take(i);
            if (!containerDone && member) handlers.scalar(member);
            containerDone = false;
          }
        }
      }
      // The block buffer is reused: keep a copy of the unfinished token.
      if (start < bytesRead) pieces.push(Buffer.from(block.subarray(start, bytesRead)));
    }

    if (!closed || depth !== 0) throw new Error(`Truncated JSON object in ${filePath}`);
  } finally {
    await handle.close();
  }
}
