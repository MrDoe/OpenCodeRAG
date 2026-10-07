/**
 * @fileoverview OpenCode V2 adapter for OpenCodeRAG.
 *
 * OpenCode V2 (server API) loads plugins as a default export with `id` and a
 * `setup(ctx)` (or Effect `effect`) function, while OpenCode V1 used a
 * `{ id, server }` default export whose `server` factory returned a hooks
 * object. This adapter keeps the V1 `ragPlugin` factory as the single source
 * of truth for RAG logic and re-registers its returned hooks on the V2
 * context:
 *
 * | V1 hook                      | V2 registration                          |
 * |------------------------------|------------------------------------------|
 * | `tool` map                   | `ctx.tool.transform(...)`                |
 * | `chat.message`               | `ctx.session.hook("prompt", ...)`        |
 * | `experimental.chat.system.transform` | `ctx.session.hook("context", ...)` |
 * | `tool.execute.after`         | `ctx.tool.hook("execute.after", ...)`    |
 * | `event`                      | `ctx.event.subscribe({ signal })`        |
 *
 * Additional V2-only registration (no V1 equivalent): the read-only RAG tools
 * are granted to the built-in `explore` agent via `ctx.agent.transform`
 * (config `openCode.exploreAgentTools`, default on).
 *
 * The V2 prompt hook exposes the user's text as a mutable `event.prompt.text`
 * instead of V1's parts-mutation contract; the adapter shims a V1-shaped
 * `output.parts` view around it and writes the mutated text back.
 *
 * Degradations (documented, non-fatal):
 * - V2 event payloads use `data` instead of V1 `properties`, so the session
 *   logger and assistant-text accumulation skip V2 events; hotkey 2-message
 *   queries and session-end extraction fall back gracefully.
 * - The read-tool override keeps its V1 execute contract (args + sessionID).
 */

import { findConfigFile, loadConfig } from "../core/config.js";
import { ragPlugin, RAG_TOOL_NAMES } from "../plugin.js";
import type { Hooks } from "@opencode-ai/plugin";

// ────────────────────────────────────────────────────────────────────────────
// Structural V2 context type (subset of `@opencode/plugin` Context used here).
// Kept local so the compiled bundle has no runtime dependency on the V2
// package; the host provides the real object at load time.
// ────────────────────────────────────────────────────────────────────────────

type V2Registration = { dispose(): Promise<void> };

type V2ToolEditor = { add(tool: V2Tool): void };
type V2ToolDomain = {
  transform(callback: (editor: V2ToolEditor) => void): Promise<V2Registration>;
  hook(
    name: "execute.after",
    callback: (event: V2ToolExecuteAfterEvent) => Promise<void> | void,
  ): Promise<V2Registration>;
};

type V2SessionDomain = {
  hook(
    name: "prompt",
    callback: (event: V2PromptHookEvent) => Promise<void> | void,
  ): Promise<V2Registration>;
  hook(
    name: "context",
    callback: (event: V2ContextHookEvent) => Promise<void> | void,
  ): Promise<V2Registration>;
};

type V2EventDomain = {
  subscribe(options: { signal: AbortSignal }): AsyncIterable<unknown>;
};

/** Permission rule shape inside an agent definition (OpenCode V2 schema). */
type V2PermissionRule = {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
};

/** Mutable agent definition subset used by the explore tool grant. */
type V2AgentInfo = { permissions?: V2PermissionRule[] };

type V2AgentEditor = {
  get(id: string): V2AgentInfo | undefined;
  update(id: string, update: (agent: V2AgentInfo) => void): void;
};

type V2AgentDomain = {
  transform(callback: (editor: V2AgentEditor) => void): Promise<V2Registration>;
  reload(): Promise<void>;
};

/** Structural subset of the OpenCode V2 plugin context. */
export type V2Context = {
  location: { directory: string };
  options: Record<string, unknown>;
  tool: V2ToolDomain;
  session: V2SessionDomain;
  event: V2EventDomain;
  agent?: V2AgentDomain;
};

/** A registered V2 tool definition (structural subset of Tool.Info). */
type V2Tool = {
  name: string;
  description: string;
  input: Record<string, unknown>;
  /**
   * Registered tool options. `codemode: false` is REQUIRED for the tool to be
   * offered directly to the agent: in OpenCode v2 (2.0.x) tools registered
   * without an explicit `codemode: false` are only reachable through the Code
   * Mode `execute` runtime's `tools.*` catalog (plugin and MCP tools alike —
   * see `Mcp.LocalConfigEncoded.codemode`), which surfaces as "No tool named
   * ... is currently available" for every direct call. The crosstalk plugin
   * uses the same `options: { codemode: false }` pattern for its top-level
   * tools.
   */
  options: { codemode: boolean };
  execute(
    input: unknown,
    context: { sessionID?: string },
  ): Promise<{ content?: string; output?: unknown; metadata?: Record<string, unknown> }>;
};

/** V2 `execute.after` hook event — fires for BOTH the completed and the error branch. */
type V2ToolExecuteAfterEvent = {
  tool: string;
  sessionID: string;
  id: unknown;
  status: "completed" | "error";
  result?: { output?: unknown; content?: string | readonly unknown[]; error?: unknown; message?: unknown };
  /** Error payload fields observed on the error branch (defensively optional). */
  error?: unknown;
  message?: unknown;
};

/**
 * Extract a human-readable error string from a V2 `execute.after` error event.
 * The exact error payload differs across OpenCode versions; probe the known
 * shapes and fall back to a JSON dump or a generic message.
 */
function extractToolErrorText(event: V2ToolExecuteAfterEvent): string {
  const result = event.result;
  const candidates: unknown[] = [
    event.error,
    event.message,
    result?.error,
    result?.message,
    typeof result?.content === "string" ? result.content : undefined,
    result?.output,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
    if (candidate !== null && typeof candidate === "object") {
      const message = (candidate as { message?: unknown }).message;
      if (typeof message === "string" && message.trim().length > 0) return message;
    }
  }
  if (result !== undefined) {
    try {
      return JSON.stringify(result);
    } catch {
      // circular payload — fall through to the generic message
    }
  }
  return "unknown tool error";
}

/** V2 `prompt` hook event. */
type V2PromptHookEvent = {
  sessionID: string;
  prompt: { text: string };
};

/**
 * V2 `context` hook event. `agent` and `tools` mirror the host's
 * `SessionContext` (session agent ID and the tool catalog actually exposed to
 * it); both stay optional so hosts that don't send them keep the legacy
 * unconditional guidance injection.
 */
type V2ContextHookEvent = {
  sessionID: string;
  agent?: string;
  tools?: Record<string, { description?: string; input?: unknown }>;
  system: Array<{ type: "text"; text: string }>;
};

// ────────────────────────────────────────────────────────────────────────────
// V1 tool (`@opencode-ai/plugin/tool`, zod-backed) → V2 Tool.Info converter
// ────────────────────────────────────────────────────────────────────────────

/** Convert a single zod-shaped argument schema into a minimal JSON schema
 * object. Duck-types on zod v3/v4 class names (`constructor.name`) — avoids
 * depending on zod internals (`_def.typeName`) which changed between majors.
 * Exported for tests. */
export function zodArgToJsonSchema(schema: unknown): Record<string, unknown> {
  const candidate = schema as {
    isOptional?: () => boolean;
    unwrap?: () => unknown;
    element?: unknown;
    shape?: Record<string, unknown>;
    options?: unknown[];
    valueType?: unknown;
    constructor?: { name?: string };
  };

  // Unwrap optional wrappers (zod v3.23+/v4 expose isOptional()).
  if (typeof candidate?.isOptional === "function" && candidate.isOptional()) {
    const inner = typeof candidate.unwrap === "function" ? candidate.unwrap() : undefined;
    return zodArgToJsonSchema(inner ?? schema);
  }

  switch (candidate?.constructor?.name) {
    case "ZodString":
      return { type: "string" };
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodArray": {
      const element = candidate.element;
      return { type: "array", items: element ? zodArgToJsonSchema(element) : {} };
    }
    case "ZodObject":
      return zodShapeToJsonSchema(candidate.shape ?? {});
    case "ZodEnum": {
      const options = Array.isArray(candidate.options)
        ? candidate.options.filter((option): option is string => typeof option === "string")
        : [];
      return options.length > 0 ? { type: "string", enum: options } : { type: "string" };
    }
    case "ZodRecord": {
      // zod v4 exposes `.valueType`; fall back to an unconstrained value.
      const valueType = candidate.valueType;
      return { type: "object", additionalProperties: valueType ? zodArgToJsonSchema(valueType) : {} };
    }
    case "ZodUnion": {
      const options = Array.isArray(candidate.options) ? candidate.options : [];
      return options.length > 0 ? { anyOf: options.map((option) => zodArgToJsonSchema(option)) } : {};
    }
    default:
      // Unknown wrapper — expose as unconstrained value rather than failing.
      return {};
  }
}

/** Convert a V1 `args` record (zod raw shape) to a JSON schema object. Exported for tests. */
export function zodShapeToJsonSchema(shape: Record<string, unknown>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, schema] of Object.entries(shape)) {
    properties[key] = zodArgToJsonSchema(schema);
    const candidate = schema as { isOptional?: () => boolean };
    if (typeof candidate?.isOptional !== "function" || !candidate.isOptional()) {
      required.push(key);
    }
  }
  return { type: "object", properties, required: required.length > 0 ? required : undefined };
}

/**
 * Convert a V1 tool definition (from `@opencode-ai/plugin/tool`) into a V2
 * tool definition. V1 executors return `{ title, output, metadata }`; V2
 * results carry `content`/`output`/`metadata`.
 *
 * @param codemode - When false (default) the tool is exposed directly to the
 *   agent; when true it is only reachable through the Code Mode `execute`
 *   runtime. Without an explicit `codemode: false` OpenCode v2 (2.0.x) folds
 *   plugin tools into the Code Mode catalog, so every RAG tool would be
 *   unusable outside `execute`.
 */
function v1ToolToV2(name: string, def: {
  description?: string;
  args?: Record<string, unknown>;
  execute?: (args: unknown, context?: { sessionID?: string }) => Promise<unknown>;
}, codemode: boolean): V2Tool {
  const v1Result = (result: unknown): { content?: string; output?: unknown; metadata?: Record<string, unknown> } => {
    const r = result as { title?: string; output?: string; metadata?: Record<string, unknown> } | undefined;
    const metadata = { ...(r?.metadata ?? {}) };
    if (typeof r?.title === "string" && r.title.length > 0) metadata.title = r.title;
    return {
      content: typeof r?.output === "string" ? r.output : "",
      metadata,
    };
  };
  return {
    name,
    description: def.description ?? "",
    input: zodShapeToJsonSchema(def.args ?? {}),
    options: { codemode },
    async execute(input, context) {
      const fn = def.execute;
      if (typeof fn !== "function") {
        return { content: "Tool executor unavailable", metadata: { tool: name } };
      }
      return v1Result(await fn(input, context));
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Registration entry point
// ────────────────────────────────────────────────────────────────────────────

/**
 * Grant the read-only RAG tools to the built-in `explore` agent. Appends an
 * `allow` rule per tool action AFTER the shipped deny-all policy (OpenCode
 * resolves permissions with "last matching rule wins"); an existing explicit
 * rule for a tool action — user-configured allow, ask, or deny — is respected
 * and left untouched. No-op when the agent is absent. Exported for tests.
 */
export function grantExploreToolPermissions(editor: V2AgentEditor): void {
  if (!editor.get("explore")) return;
  editor.update("explore", (agent) => {
    const rules = (agent.permissions ??= []);
    for (const name of RAG_TOOL_NAMES) {
      if (rules.some((rule) => rule.action === name)) continue;
      rules.push({ action: name, resource: "*", effect: "allow" });
    }
  });
}

/**
 * Run the V1 `ragPlugin` factory for the V2 context's location and register
 * all returned hooks as V2 transforms/hooks. Returns a cleanup function that
 * disposes every registration and aborts the event subscription.
 */
export async function registerRagPluginV2(ctx: V2Context): Promise<() => Promise<void>> {
  // The V1 factory only consumes `input.directory`; project/client/$ are unused.
  const hooks = (await ragPlugin(
    { directory: ctx.location.directory } as never,
    ctx.options as never,
  )) as Hooks;

  // Tool exposure: default to DIRECT tools (`codemode: false`), matching the
  // crosstalk plugin. OpenCode v2 (2.0.x) folds plugin tools without an
  // explicit `codemode: false` into the Code Mode catalog, making them
  // unreachable outside `execute`. Set the plugin option `codemode: true`
  // (via `plugins: [{ "package": "opencode-rag-plugin", "options": { "codemode": true } }]`)
  // to force the previous code-mode-only behavior.
  const codemode = typeof ctx.options?.codemode === "boolean" ? ctx.options.codemode : false;

  const registrations: V2Registration[] = [];

  // Explore keeps its RAG tool grant across reloads; opt out via
  // `openCode.exploreAgentTools: false` in opencode-rag.json.
  let exploreToolsEnabled = true;
  try {
    const cfgPath = findConfigFile(ctx.location.directory);
    if (cfgPath) {
      exploreToolsEnabled = loadConfig(cfgPath, false).openCode.exploreAgentTools !== false;
    }
  } catch {
    // Malformed config — the V1 factory reports it; fall back to the default
  }

  // ── Tools ────────────────────────────────────────────────────────────────
  const toolDefs = (hooks.tool ?? {}) as Record<string, {
    description?: string;
    args?: Record<string, unknown>;
    execute?: (args: unknown, context?: { sessionID?: string }) => Promise<unknown>;
  }>;
  const toolEntries = Object.entries(toolDefs);
  if (toolEntries.length > 0) {
    const registration = await ctx.tool.transform((editor) => {
      for (const [name, def] of toolEntries) {
        editor.add(v1ToolToV2(name, def, codemode));
      }
    });
    registrations.push(registration);
  }

  // Explore agent tool grant: hand the read-only RAG tools to the built-in
  // search agent. The grant appends allow rules after the shipped deny-all
  // policy (last matching rule wins) and respects explicit user rules.
  if (ctx.agent && exploreToolsEnabled) {
    try {
      const registration = await ctx.agent.transform((editor) => {
        grantExploreToolPermissions(editor);
      });
      registrations.push(registration);
    } catch {
      // Non-critical — the guidance gate falls back on the tool catalog
    }
  }

  // ── prompt hook (V1 `chat.message`) ─────────────────────────────────────
  // Shims a V1-shaped output (parts array) around the mutable prompt text,
  // runs the V1 handler, and writes the (possibly replaced) text back.
  const chatMessageHook = hooks["chat.message"];
  if (chatMessageHook) {
    const registration = await ctx.session.hook("prompt", async (event) => {
      const text = event.prompt.text;
      if (!text || text.length === 0) return;
      const parts: Array<{ type: string; text: string }> = [{ type: "text", text }];
      const output = { message: { parts }, parts };
      try {
        await chatMessageHook({ sessionID: event.sessionID } as never, output as never);
      } catch {
        // Non-critical — must never throw
      }
      const first = (output as { parts?: Array<{ text?: string }> }).parts?.[0];
      if (typeof first?.text === "string") event.prompt.text = first.text;
    });
    registrations.push(registration);
  }

  // ── context hook (V1 `experimental.chat.system.transform`) ──────────────
  // V1 unshifted guidance lines onto `output.system`; replicate the final
  // ordering by unshifting in reverse iteration order.
  const systemTransformHook = hooks["experimental.chat.system.transform"];
  if (systemTransformHook) {
    const registration = await ctx.session.hook("context", async (event) => {
      const output: { system: string[] } = { system: [] };
      try {
        await systemTransformHook(
          { sessionID: event.sessionID, agent: event.agent, tools: event.tools } as never,
          output as never,
        );
      } catch {
        // Non-critical — must never throw
      }
      const lines = output.system ?? [];
      for (let i = lines.length - 1; i >= 0; i--) {
        event.system.unshift({ type: "text", text: lines[i]! });
      }
    });
    registrations.push(registration);
  }

  // ── tool.execute.after ───────────────────────────────────────────────────
  // Forwards BOTH branches: completed calls keep the existing contract, error
  // calls additionally carry `input.status = "error"` and `output.error`, so
  // the V1-side handler (tool-error quirk injection, auto-capture) can see
  // failed tool calls. Previously the error branch was silently dropped.
  const toolAfterHook = hooks["tool.execute.after"];
  if (toolAfterHook) {
    const registration = await ctx.tool.hook("execute.after", async (event) => {
      try {
        const isError = event.status === "error";
        const result = event.result as { output?: unknown; content?: string | unknown[] } | undefined;
        const outputText = isError
          ? extractToolErrorText(event)
          : typeof result?.content === "string"
            ? result.content
            : result?.output !== undefined
              ? JSON.stringify(result.output)
              : "";
        await toolAfterHook(
          {
            sessionID: event.sessionID,
            tool: event.tool,
            callID: event.id,
            status: isError ? "error" : "completed",
          } as never,
          { output: outputText, error: isError ? outputText : undefined } as never,
        );
      } catch {
        // Non-critical — must never throw
      }
    });
    registrations.push(registration);
  }

  // ── event subscription (V1 `event`) ─────────────────────────────────────
  // V2 event payloads differ from V1 (data vs properties) — the V1 handler
  // reads `event.type`/`properties` defensively and skips foreign shapes.
  const eventHook = hooks.event;
  if (eventHook) {
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            await eventHook({ event } as never);
          } catch {
            // Non-critical — must never throw
          }
        }
      } catch {
        // Aborted or stream ended
      }
    })();
    registrations.push({ dispose: async () => controller.abort() });
  }

  return async () => {
    for (const registration of registrations.reverse()) {
      try {
        await registration.dispose();
      } catch {
        // Best-effort unload
      }
    }
  };
}