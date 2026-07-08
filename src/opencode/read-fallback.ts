/**
 * @fileoverview Provides fallback error messages and no-results behavior dispatch for the read tool.
 */

/**
 * Error message wrapper for retrieval failures.
 */
export function retrievalErrorMessage(shortError: string): string {
  return [
    "OpenCodeRAG retrieval failed.",
    "",
    "Error:",
    shortError,
  ].join("\n");
}

/** No results fallback messages are handled inline in create-read-tool.ts. */
