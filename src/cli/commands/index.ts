/**
 * Barrel re-export for all CLI command registration functions.
 */

export { registerIndexCommand } from "./index-command.js";
export { registerQueryCommand } from "./query.js";
export { registerClearCommand } from "./clear.js";
export { registerStatusCommand } from "./status.js";
export { registerListCommand } from "./list.js";
export { registerShowCommand } from "./show.js";
export { registerDumpCommand } from "./dump.js";
export { registerInitCommand } from "./init.js";
export { registerUiCommand } from "./ui.js";
export { registerMcpCommand } from "./mcp.js";
export { registerSetupCommand } from "./setup.js";
export { registerUpdateCommand } from "./update.js";
export { registerEvalSessionsCommand, registerEvalAnalyzeCommand, registerEvalCompareCommand } from "./eval.js";
export { registerDescribeImageCommand } from "./describe-image.js";
