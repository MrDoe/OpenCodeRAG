/**
 * @fileoverview MCP command to start a Model Context Protocol server for semantic code retrieval via stdio transport.
 */
/**
 * `mcp` command — starts an MCP server for semantic code retrieval via stdio transport.
 */

import type { Command } from "commander";
import path from "node:path";
import { logCliError } from "../format.js";
import type { CliOptions } from "../types.js";

/**
 * Register the `mcp` command on the given Commander program.
 *
 * Launches a Model Context Protocol (MCP) server that exposes semantic
 * code search tools over stdio, allowing AI assistants to query the
 * indexed workspace.
 *
 * @param program - The Commander `Command` instance to register on.
 */
export function registerMcpCommand(program: Command): void {
  program
    .command("mcp")
    .description("Start MCP server for semantic code retrieval (stdio transport)")
    .option("-c, --config <path>", "path to config file")
    .action(async (options: CliOptions) => {
      try {
        const { runMcpServer } = await import("../../mcp/cli.js");
        await runMcpServer({
          configPath: options.config,
          cwd: process.cwd(),
        });
      } catch (err) {
        const message = (err as Error).message || String(err);
        const logFilePath = path.resolve(process.cwd(), ".opencode", "opencode-rag.log");
        logCliError(logFilePath, "mcp", `\nMCP server failed: ${message}`, err);
        process.exit(1);
      }
    });
}
