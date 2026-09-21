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

import { ragPlugin } from "../plugin.js";
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

/** Structural subset of the OpenCode V2 plugin context. */
export type V2Context = {
  location: { directory: string };
  options: Record<string, unknown>;
  tool: V2ToolDomain;
  session: V2SessionDomain;
  event: V2EventDomain;
};

/** A registered V2 tool definition (structural subset of Tool.Info). */
type V2Tool = {
  name: string;
  description: string;
  input: Record<string, unknown>;
  execute(
    input: unknown,
    context: { sessionID?: string },
  ): Promise<{ content?: string; output?: unknown; metadata?: Record<string, unknown> }>;
};

/** V2 `execute.after` hook event (completed branch). */
type V2ToolExecuteAfterEvent = {
  tool: string;
  sessionID: string;
  id: unknown;
  status: "completed" | "error";
  result?: { output?: unknown; content?: string | readonly unknown[] };
};

/** V2 `prompt` hook event. */
type V2PromptHookEvent = {
  sessionID: string;
  prompt: { text: string };
};

/** V2 `context` hook event. */
type V2ContextHookEvent = {
  sessionID: string;
  system: Array<{ type: "text"; text: string }>;
};

// ────────────────────────────────────────────────────────────────────────────
// V1 tool (`@opencode-ai/plugin/tool`, zod-backed) → V2 Tool.Info converter
// ────────────────────────────────────────────────────────────────────────────

/**
 * Convert a single zod-shaped argument schema into a minimal JSON schema
 * object. Duck-types on zod v3/v4 class names (`constructor.name`) — avoids
 * depending on zod internals (`_def.typeName`) which changed between majors.
 */
function zodArgToJsonSchema(schema: unknown): Record<string, unknown> {
  const candidate = schema as {
    isOptional?: () => boolean;
    unwrap?: () => unknown;
    element?: unknown;
    shape?: Record<string, unknown>;
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
    default:
      // Unknown wrapper — expose as unconstrained value rather than failing.
      return {};
  }
}

/** Convert a V1 `args` record (zod raw shape) to a JSON schema object. */
function zodShapeToJsonSchema(shape: Record<string, unknown>): Record<string, unknown> {
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
 */
function v1ToolToV2(name: string, def: {
  description?: string;
  args?: Record<string, unknown>;
  execute?: (args: unknown, context?: { sessionID?: string }) => Promise<unknown>;
}): V2Tool {
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

  const registrations: V2Registration[] = [];

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
        editor.add(v1ToolToV2(name, def));
      }
    });
    registrations.push(registration);
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
        await systemTransformHook({ sessionID: event.sessionID } as never, output as never);
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
  const toolAfterHook = hooks["tool.execute.after"];
  if (toolAfterHook) {
    const registration = await ctx.tool.hook("execute.after", async (event) => {
      try {
        if (event.status !== "completed") return;
        const result = event.result as { output?: unknown; content?: string | unknown[] } | undefined;
        const outputText =
          typeof result?.content === "string"
            ? result.content
            : result?.output !== undefined
              ? JSON.stringify(result.output)
              : "";
        await toolAfterHook(
          { sessionID: event.sessionID, tool: event.tool, callID: event.id } as never,
          { output: outputText } as never,
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