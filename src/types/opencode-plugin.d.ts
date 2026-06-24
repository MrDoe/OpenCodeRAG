declare module "@opencode-ai/plugin" {
  import type { Event, createOpencodeClient, Project, Model, Provider, Permission, UserMessage, Message, Part, Config as SDKConfig } from "@opencode-ai/sdk";
  import type { Provider as ProviderV2, Model as ModelV2, Auth } from "@opencode-ai/sdk/v2";

  export * from "@opencode-ai/plugin/tool";
  export type { ToolDefinition } from "@opencode-ai/plugin/tool";

  /** Input provided to every plugin factory function, containing client, project, and workspace context. */
  export type PluginInput = {
    client: ReturnType<typeof createOpencodeClient>;
    project: Project;
    directory: string;
    worktree: string;
    serverUrl: URL;
    $: unknown;
  };

  /** Optional configuration map passed to the plugin factory. */
  export type PluginOptions = Record<string, unknown>;

  /** Lifecycle hooks that a plugin can implement to intercept OpenCode events, messages, tool execution, and configuration. */
  export interface Hooks {
    event?: (input: { event: Event }) => Promise<void>;
    config?: (input: SDKConfig) => Promise<void>;
    tool?: Record<string, unknown>;
    "chat.message"?: (
      input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string }; messageID?: string; variant?: string },
      output: { message: UserMessage; parts: Part[] }
    ) => Promise<void>;
    "chat.params"?: (
      input: { sessionID: string; agent: string; model: Model; provider: { source: string; info: Provider; options: Record<string, unknown> }; message: UserMessage },
      output: { temperature: number; topP: number; topK: number; maxOutputTokens: number | undefined; options: Record<string, unknown> }
    ) => Promise<void>;
    "command.execute.before"?: (input: {
      command: string;
      sessionID: string;
      arguments: string;
    }, output: {
      parts: Part[];
    }) => Promise<void>;
    "tool.execute.before"?: (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> }
    ) => Promise<void>;
    "tool.execute.after"?: (
      input: { tool: string; sessionID: string; callID: string },
      output: { title: string; output: string; metadata: unknown }
    ) => Promise<void>;
    "experimental.chat.messages.transform"?: (
      input: Record<string, never>,
      output: { messages: { info: Message; parts: Part[] }[] }
    ) => Promise<void>;
    "experimental.chat.system.transform"?: (
      input: { sessionID?: string; model: Model },
      output: { system: string[] }
    ) => Promise<void>;
  }

  /** Plugin factory signature — receives input and optional options, returns lifecycle hooks. */
  export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>;
}
