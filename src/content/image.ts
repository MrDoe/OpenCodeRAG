/**
 * @fileoverview Extracts text descriptions from image files using a vision provider, with BMP decoding and resizing support.
 */

import path from "node:path";
import sharp from "sharp";
import type { ExtractResult } from "./types.js";
import {
  getMimeType,
  SUPPORTED_IMAGE_EXTENSIONS,
  type ImageVisionProvider,
} from "../chunker/image.js";

export { SUPPORTED_IMAGE_EXTENSIONS };

/**
 * Check whether a file path points to a supported image file based on its extension.
 */
export function isImageFile(fp: string): boolean {
  const lower = fp.toLowerCase();
  for (const ext of SUPPORTED_IMAGE_EXTENSIONS) {
    if (lower.endsWith(ext.toLowerCase())) return true;
  }
  return false;
}

function isBmpFile(fp: string): boolean {
  return fp.toLowerCase().endsWith(".bmp");
}

const MAX_BMP_DIMENSION = 10_000;
const MAX_BMP_ALLOC = 500 * 1024 * 1024; // 500 MB

function decodeBmp(buffer: Buffer): { pixels: Buffer; width: number; height: number; channels: number } {
  const signature = buffer.toString("ascii", 0, 2);
  if (signature !== "BM") throw new Error("Not a BMP file");

  if (buffer.length < 54) throw new Error("Truncated BMP header");

  const dibSize = buffer.readUInt32LE(14);
  const width = buffer.readInt32LE(18);
  const rawHeight = buffer.readInt32LE(22);
  const bitsPerPixel = buffer.readUInt16LE(28);

  if (width <= 0 || Math.abs(rawHeight) <= 0)
    throw new Error("Invalid BMP dimensions");
  if (width > MAX_BMP_DIMENSION || Math.abs(rawHeight) > MAX_BMP_DIMENSION)
    throw new Error(`BMP dimensions (${width}x${rawHeight}) exceed ${MAX_BMP_DIMENSION}x${MAX_BMP_DIMENSION} limit`);

  if (bitsPerPixel !== 24 && bitsPerPixel !== 32)
    throw new Error(`Unsupported BMP bit depth: ${bitsPerPixel}. Only 24 and 32 bit are supported.`);
  if (dibSize < 40)
    throw new Error(`Unsupported BMP DIB header size: ${dibSize}`);

  const compression = buffer.readUInt32LE(30);
  if (compression !== 0 && compression !== 3)
    throw new Error(`Compressed BMP not supported (compression=${compression})`);

  const channels = bitsPerPixel === 32 ? 4 : 3;
  const rowSize = Math.floor((bitsPerPixel * width + 31) / 32) * 4;
  const topDown = rawHeight < 0;
  const absHeight = Math.abs(rawHeight);
  const allocSize = width * absHeight * channels;

  if (allocSize > MAX_BMP_ALLOC)
    throw new Error(`BMP allocation (${allocSize} bytes) exceeds ${MAX_BMP_ALLOC} byte limit`);

  const pixelOffset = buffer.readUInt32LE(10);
  if (pixelOffset >= buffer.length)
    throw new Error("BMP pixel offset exceeds buffer length");

  const pixels = Buffer.alloc(allocSize);
  const lastValidSrc = buffer.length - 1;

  for (let y = 0; y < absHeight; y++) {
    const srcY = topDown ? y : absHeight - 1 - y;
    const srcRow = pixelOffset + srcY * rowSize;
    const dstRow = y * width * channels;

    for (let x = 0; x < width; x++) {
      const srcPx = srcRow + x * (bitsPerPixel / 8);
      const dstPx = dstRow + x * channels;
      if (srcPx + 3 > lastValidSrc) {
        pixels.fill(0, dstPx, dstPx + channels);
        continue;
      }
      if (channels === 4) {
        pixels[dstPx] = buffer[srcPx + 2]!;
        pixels[dstPx + 1] = buffer[srcPx + 1]!;
        pixels[dstPx + 2] = buffer[srcPx]!;
        pixels[dstPx + 3] = buffer[srcPx + 3]!;
      } else {
        pixels[dstPx] = buffer[srcPx + 2]!;
        pixels[dstPx + 1] = buffer[srcPx + 1]!;
        pixels[dstPx + 2] = buffer[srcPx]!;
      }
    }
  }

  return { pixels, width, height: absHeight, channels };
}

/**
 * Resize an image buffer to fit within a maximum dimension while preserving aspect ratio.
 * Handles BMP files with a custom decoder before delegating to sharp.
 */
export async function resizeImage(
  buffer: Buffer,
  filePath: string,
  maxDimension: number,
): Promise<Buffer> {
  if (maxDimension <= 0) return buffer;

  try {
    if (isBmpFile(filePath)) {
      const { pixels, width, height, channels } = decodeBmp(buffer);
      const ch = channels as 3 | 4;
      if (width <= maxDimension && height <= maxDimension) {
        return sharp(pixels, { raw: { width, height, channels: ch } })
          .jpeg({ quality: 80 })
          .toBuffer();
      }
      return sharp(pixels, { raw: { width, height, channels: ch } })
        .resize({ width: maxDimension, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
    }

    const meta = await sharp(buffer).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (w <= maxDimension && h <= maxDimension) {
      return sharp(buffer).jpeg({ quality: 80 }).toBuffer();
    }
    return sharp(buffer)
      .resize({ width: maxDimension, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch (err) {
    throw new Error(
      `Image resize failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Extract a text description of an image by sending it to a vision provider.
 * Optionally resizes the image before transmission to stay within provider limits.
 */
export async function extract(
  filePath: string,
  buffer: Buffer,
  visionProvider: ImageVisionProvider,
  prompt: string,
  maxDimension?: number,
): Promise<ExtractResult> {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = getMimeType(ext);
    const sized = maxDimension ? await resizeImage(buffer, filePath, maxDimension) : buffer;
    const b64 = sized.toString("base64");
    const content = await visionProvider.describeImage(b64, mimeType, prompt);
    return { content, ok: true };
  } catch (err) {
    return { content: "", ok: false, error: (err as Error).message };
  }
}
