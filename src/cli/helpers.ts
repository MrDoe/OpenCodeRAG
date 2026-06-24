/**
 * Package and file-system utility helpers used by CLI command modules.
 */
import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PackageMetadata } from "./types.js";

/**
 * Resolve the absolute path to the package root directory.
 *
 * Uses `import.meta.url` to locate the directory containing `package.json`
 * relative to the compiled output.
 *
 * @returns Absolute path to the package root (e.g. `/path/to/opencode-rag`).
 */
export function getPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

/**
 * Read and parse `package.json` from the package root.
 *
 * @returns The parsed `PackageMetadata` containing name, version, and dependency maps.
 */
export function getPackageMetadata(): PackageMetadata {
  const packageJsonPath = path.join(getPackageRoot(), "package.json");
  return JSON.parse(readFileSync(packageJsonPath, "utf-8")) as PackageMetadata;
}

/**
 * Filter an unknown value into a `Record<string, string>`.
 *
 * Returns an empty object if the value is not a plain object or contains
 * non-string entries.
 *
 * @param value - The unknown value to normalize.
 * @returns A record with only string-valued entries.
 */
export function getStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/**
 * Read a JSON file from disk and return it as a generic record.
 *
 * @param filePath - Absolute path to the JSON file.
 * @returns The parsed object, or `undefined` if the file does not exist.
 */
export function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
}

/**
 * Write a JavaScript object to disk as pretty-printed JSON.
 *
 * @param filePath - Absolute path to the target file.
 * @param value - The object to serialize (2-space indentation, trailing newline).
 */
export function writeJsonFile(filePath: string, value: Record<string, unknown>): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

/**
 * Convert a platform-specific path to POSIX (forward-slash) format.
 *
 * @param input - A file path using the platform separator.
 * @returns The same path with all backslashes replaced by forward slashes.
 */
export function toPosixPath(input: string): string {
  return input.split(path.sep).join("/");
}
