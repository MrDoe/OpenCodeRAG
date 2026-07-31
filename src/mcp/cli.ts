/**
 * @fileoverview Standalone MCP server CLI entry point with SIGINT/SIGTERM graceful shutdown handling.
 */
import process from "node:process";
import { createMcpServer } from "./server.js";

let closed = false;

/** Run the MCP server as a standalone process, handling SIGINT/SIGTERM for graceful shutdown. */
export async function runMcpServer(options?: {
  /** Path to the RAG config file. */
  configPath?: string;
  /** Working directory for resolving paths. */
  cwd?: string;
}): Promise<void> {
  const instance = await createMcpServer(options);

  async function shutdown(): Promise<void> {
    if (closed) return;
    closed = true;
    await instance.close();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // If the parent MCP client disconnects, stdin closes — exit instead of
  // becoming a zombie that holds the store open forever.
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);

  await new Promise<void>(() => {});
}
