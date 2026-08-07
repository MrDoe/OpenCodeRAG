/**
 * @fileoverview MCP server setup exposing search_semantic, get_file_skeleton, find_usages, and describe_image tools.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { resolveRagContext } from "../core/bootstrap.js";
import { retrieve } from "../retriever/retriever.js";
import process from "node:process";
import {
  handleSearchSemantic,
  handleFileSkeleton,
  handleFindUsages,
  handleDescribeImage,
  type SearchSemanticParams,
  type FileSkeletonParams,
  type FindUsagesParams,
  type DescribeImageParams,
} from "./handlers.js";

/** Options for creating the MCP server. */
export interface McpServerOptions {
  /** Path to the RAG config file. */
  configPath?: string;
  /** Working directory for resolving paths. */
  cwd?: string;
  /** Custom transport (defaults to stdio). */
  transport?: Transport;
}

/** A running MCP server instance with a close method. */
export interface RagMcpInstance {
  /** The underlying MCP server. */
  server: McpServer;
  /** Gracefully close the server and release resources. */
  close: () => Promise<void>;
}

/** Create and start an MCP server exposing search_semantic, get_file_skeleton, find_usages, and describe_image tools. */
export async function createMcpServer(options?: McpServerOptions): Promise<RagMcpInstance> {
  const cwd = options?.cwd ?? process.cwd();
  const ctx = await resolveRagContext({
    cwd,
    configPath: options?.configPath,
  });

  const server = new McpServer({
    name: "opencode-rag-mcp",
    version: "1.0.0",
  });

  server.tool(
    "search_semantic",
    "Search the indexed codebase by meaning, not just keywords. Returns relevant code chunks with file paths, line numbers, and relevance scores.",
    {
      query: z.string().min(1, "A search query is required."),
      pathHints: z.array(z.string().min(1)).max(10).optional(),
      languageHints: z.array(z.string().min(1)).max(10).optional(),
      topK: z.number().int().min(1).max(25).optional(),
    },
    async (args: SearchSemanticParams) => {
      try {
        const result = await handleSearchSemantic(args, ctx.embedder, ctx.store, ctx.config, ctx.keywordIndex, retrieve);
        return {
          content: [{ type: "text" as const, text: result.formatted }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Search failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_file_skeleton",
    "Get a quick structural overview of a source file — functions, classes, interfaces, methods, and other top-level declarations with their line numbers.",
    {
      filePath: z.string().min(1, "A file path is required."),
    },
    async (args: FileSkeletonParams) => {
      try {
        const result = await handleFileSkeleton(args, cwd);
        return {
          content: [{ type: "text" as const, text: result.formatted }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Could not read file: ${message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "find_usages",
    "Find usages and references of a symbol (function, variable, class, etc.) across the indexed codebase.",
    {
      symbolName: z.string().min(1, "A symbol name is required."),
      pathHint: z.string().optional(),
      topK: z.number().int().min(1).max(50).optional(),
    },
    async (args: FindUsagesParams) => {
      try {
        const result = await handleFindUsages(args, ctx.embedder, ctx.store, ctx.config, ctx.keywordIndex, retrieve);
        return {
          content: [{ type: "text" as const, text: result.formatted }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Search failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "describe_image",
    "Describe an image file using a vision model. Reads the file from disk, sends it to the configured vision provider (Ollama, OpenAI, Anthropic, or Google Gemini), and returns a text description of the image contents. Optionally accepts a systemPrompt to steer the description toward specific features.",
    {
      filePath: z.string().min(1, "An image file path is required."),
      systemPrompt: z.string().optional(),
    },
    async (args: DescribeImageParams) => {
      try {
        const result = await handleDescribeImage(args, ctx.config, cwd);
        return {
          content: [{ type: "text" as const, text: result.formatted }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to describe image: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  const transport = options?.transport ?? new StdioServerTransport();
  await server.connect(transport);

  return {
    server,
    close: async () => {
      await server.close();
      await ctx.store.close();
      ctx.keywordIndex.close();
      // Release keep-alive sockets held by the embedder/description providers
      const { destroyAllPooledConnections } = await import("../embedder/http.js");
      destroyAllPooledConnections();
    },
  };
}
