/**
 * @fileoverview UI command to start a local web dashboard for browsing the vector database and running searches.
 */
/**
 * `ui` command — starts a local web UI for browsing the vector database.
 */

import type { Command } from "commander";
import path from "node:path";
import { c, resolveCliContext, cleanupContext, logCliError, logCliInfo } from "../format.js";
import { openInBrowser } from "../browser.js";
import { isWildcardHost, resolveUiBindHost, uiBaseUrls } from "../../web/bind.js";
import type { CliOptions } from "../types.js";

/**
 * Register the `ui` command on the given Commander program.
 *
 * Starts an HTTP server on localhost that serves a single-page dashboard
 * for browsing indexed chunks, files, and running searches. Optionally
 * opens the system browser automatically.
 *
 * @param program - The Commander `Command` instance to register on.
 */
export function registerUiCommand(program: Command): void {
  program
    .command("ui")
    .description("Start the web UI for browsing the vector database")
    .option("-c, --config <path>", "path to config file")
    .option("-p, --port <number>", "port to listen on (default: from config or 3210)")
    .option("-a, --address <host>", "address to bind (default: from config or 127.0.0.1; use 0.0.0.0 in containers)")
    .option("--no-open", "do not open browser automatically")
    .action(async (options: CliOptions & { port?: string; address?: string; open?: boolean }) => {
      try {
        const cwd = process.cwd();
        let logFilePath = path.resolve(cwd, ".opencode", "opencode-rag.log");
        const ctx = await resolveCliContext(options, logFilePath);
        const { config, storePath } = ctx;
        logFilePath = ctx.logFilePath;

        const port = parseInt(options.port ?? String(config.ui?.port ?? 3210), 10);
        const host = resolveUiBindHost(options.address, config.ui?.host);
        const openBrowser = options.open !== false && (config.ui?.openBrowser ?? true);

        const { startWebUi } = await import("../../web/server.js");
        const { findConfigFile, projectConfigPath } = await import("../../core/config.js");
        const configPath = options.config
          ? path.resolve(cwd, options.config)
          : findConfigFile(cwd) ?? projectConfigPath(cwd);
        const server = await startWebUi(
          storePath,
          port,
          cwd,
          config.embedding.vectorDimension ?? 384,
          config,
          configPath,
          host,
        );

        // Print every reachable URL (loopback first). A wildcard bind also
        // lists the machine's LAN addresses so the printed URL works from the
        // host when the CLI runs inside a container.
        const urls = uiBaseUrls(server.host, server.port).map((base) => `${base}/?token=${server.token}`);
        const url = urls[0]!;
        logCliInfo(logFilePath, "ui", `\n${c.heading("OpenCodeRAG Web UI")}`);
        logCliInfo(logFilePath, "ui", `  ${c.label("URL:")} ${c.value(url)}`);
        for (const extra of urls.slice(1)) {
          logCliInfo(logFilePath, "ui", `  ${c.label("Also:")} ${c.value(extra)}`);
        }
        if (isWildcardHost(server.host)) {
          logCliInfo(logFilePath, "ui", `  ${c.warn("Bound to all interfaces:")} ${c.dim("the dashboard is reachable beyond this machine — the token in the URL is the only protection. Do not expose it to the internet.")}`);
        }
        logCliInfo(logFilePath, "ui", `  ${c.dim("The token in the URL authenticates this session — keep it private.")}`);
        logCliInfo(logFilePath, "ui", `  ${c.dim("Press Ctrl+C to stop")}\n`);

        if (openBrowser) {
          const opened = await openInBrowser(url);
          if (!opened) {
            console.error(c.dim(`Could not open browser automatically. Open ${url} manually.`));
          }
        }

        let shuttingDown = false;
        const shutdown = async (): Promise<void> => {
          if (shuttingDown) return;
          shuttingDown = true;
          try {
            await server.close();
          } catch {
            // best-effort — the process is exiting anyway
          }
          try {
            await cleanupContext(ctx);
          } catch {
            // best-effort cleanup
          }
          process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      } catch (err) {
        const message = (err as Error).message || String(err);
        const logFilePath = path.resolve(process.cwd(), ".opencode", "opencode-rag.log");
        logCliError(logFilePath, "ui", `\nUI failed: ${message}`, err);
        process.exit(1);
      }
    });
}
