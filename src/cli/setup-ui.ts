/**
 * @fileoverview Optional hand-off from `opencode-rag setup` to the web UI's
 * Configuration view.
 *
 * Once the workspace is configured, an interactive setup opens the browser on
 * the Configuration page and keeps the UI server alive until the user presses
 * Ctrl+C. Scripted runs (`-y`), non-TTY runs and `--no-ui` never launch it.
 */

import { c, cleanupContext } from "./format.js";
import { openInBrowser } from "./browser.js";
import { isInteractiveTerminal } from "./prompt.js";
import { findConfigFile, projectConfigPath } from "../core/config.js";
import { resolveRagContext } from "../core/bootstrap.js";
import type { WebUiServer } from "../web/server.js";

/** Setup options that decide whether the Configuration UI opens. */
export interface SetupUiLaunchOptions {
  /** Set to `false` by `--no-ui`. */
  ui?: boolean;
  /** Set by `-y`/`--yes`: scripted runs never open a browser. */
  yes?: boolean;
}

/**
 * Decide whether a finished setup should open the Configuration UI.
 *
 * Deliberately conservative: the setup process stays alive while the UI is
 * open, so it must never trigger in a scripted (`-y`), non-interactive or
 * `--no-ui` run — those would hang a CI job or an install pipeline.
 *
 * @param options - Parsed setup options.
 * @param interactive - Whether stdin/stdout are a TTY (injectable for tests).
 * @returns `true` when the UI should be launched.
 */
export function shouldLaunchSetupUi(
  options: SetupUiLaunchOptions,
  interactive: boolean = isInteractiveTerminal(),
): boolean {
  if (options.ui === false) return false;
  if (options.yes === true) return false;
  return interactive;
}

/**
 * Open the web UI on the Configuration view and keep it running until the
 * user stops it.
 *
 * Best-effort by design: setup has already completed, so a failure to start
 * the server or open a browser only prints a hint and returns. The browser
 * link carries the per-run auth token and the `#config` hash route.
 *
 * @param cwd - Workspace root (defaults to the current directory).
 */
export async function launchSetupConfigUi(cwd: string = process.cwd()): Promise<void> {
  let ctx: Awaited<ReturnType<typeof resolveRagContext>>;
  try {
    // Read-only context: never probe the provider or reconcile quirks during
    // setup — the Configuration page only needs the resolved config and paths.
    ctx = await resolveRagContext({ cwd, skipProbe: true, skipKeywordIndex: true });
  } catch (err) {
    console.log(`  ${c.warn("Configuration UI skipped:")} ${(err as Error).message}`);
    return;
  }

  if (ctx.config.ui?.openBrowser === false) {
    console.log(
      `  ${c.dim("Configuration UI: browser launch disabled (ui.openBrowser = false).")} ` +
        `Run ${c.file("opencode-rag ui")} to open the dashboard.`,
    );
    await cleanupContext(ctx);
    return;
  }

  const configPath = findConfigFile(cwd) ?? projectConfigPath(cwd);
  const port = ctx.config.ui?.port ?? 3210;

  let server: WebUiServer;
  try {
    const { startWebUi } = await import("../web/server.js");
    try {
      server = await startWebUi(ctx.storePath, port, cwd, ctx.dimension, ctx.config, configPath);
    } catch (err) {
      if (!isAddressInUse(err) || port === 0) throw err;
      console.log(`  ${c.dim(`Port ${port} is in use — using a free port for the Configuration UI.`)}`);
      server = await startWebUi(ctx.storePath, 0, cwd, ctx.dimension, ctx.config, configPath);
    }
  } catch (err) {
    console.log(`  ${c.warn("Configuration UI could not start:")} ${(err as Error).message}`);
    console.log(`  ${c.dim("Run `opencode-rag ui` later to open the dashboard.")}`);
    await cleanupContext(ctx);
    return;
  }

  const url = `http://127.0.0.1:${server.port}/?token=${server.token}#config`;
  console.log(`\n${c.heading("Configuration UI")}`);
  console.log(`  ${c.label("URL:")}   ${c.value(url)}`);
  console.log(`  ${c.dim("The token in the URL authenticates this session — keep it private.")}`);
  console.log(`  ${c.dim("Edit the global and project settings in the browser, then press Ctrl+C to stop.")}\n`);

  if (!(await openInBrowser(url))) {
    console.log(`  ${c.warn("Could not open the browser automatically.")} Open the URL above manually,`);
    console.log(`  ${c.dim("or run `opencode-rag ui` later to open the dashboard.")}`);
    // Nobody is looking at a page we could not open — stop instead of hanging.
    await closeUi(server, ctx);
    return;
  }

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      // Second Ctrl+C: do not wait for the graceful close.
      process.exit(1);
    }
    shuttingDown = true;
    await closeUi(server, ctx);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Tear down the UI server and the bootstrap context it borrowed.
 *
 * @param server - Running web UI handle.
 * @param ctx - Bootstrap context created for the launch.
 */
async function closeUi(
  server: WebUiServer,
  ctx: Awaited<ReturnType<typeof resolveRagContext>>,
): Promise<void> {
  try {
    await server.close();
  } catch {
    // best-effort — setup is finishing anyway
  }
  try {
    await cleanupContext(ctx);
  } catch {
    // best-effort cleanup
  }
}

/** Whether a `listen()` error is a port conflict. */
function isAddressInUse(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") return true;
  return /EADDRINUSE/.test((err as Error).message ?? "");
}
