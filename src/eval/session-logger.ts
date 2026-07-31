/**
 * @fileoverview Creates a SessionLogger that captures OpenCode plugin events and RAG context as JSONL.
 */
import type { SessionEvent, TokenUsage } from "./types.js";
import { appendSessionEvent } from "./storage.js";

interface EventLike {
  type: string;
  properties: Record<string, unknown>;
}

interface MessageInfo {
  id: string;
  sessionID: string;
  role: string;
  modelID?: string;
  providerID?: string;
  tokens?: TokenUsage;
  cost?: number;
  finish?: string;
  time?: { created?: number; completed?: number };
  error?: { name?: string };
  title?: string;
}

interface PartInfo {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  tool?: string;
  state?: {
    status: string;
    input?: Record<string, unknown>;
    time?: { start?: number; end?: number };
  };
  tokens?: TokenUsage;
  cost?: number;
  reason?: string;
}

/** Logger interface for capturing OpenCode session events and RAG context injections to disk. */
export interface SessionLogger {
  onEvent(event: EventLike): void;
  onRagContext(sessionID: string, messageID: string | undefined, context: {
    chunkCount: number;
    uniqueFiles: number;
    contextTokens: number;
    topScore: number;
    retrievalTimeMs: number;
  }): void;
}

/**
 * Create a SessionLogger that writes events and RAG context metadata
 * as JSONL into the given store path.
 */
export function createSessionLogger(storePath: string): SessionLogger {
  return {
    onEvent(event: EventLike): void {
      try {
        const props = event.properties;
        if (!props) return;

        switch (event.type) {
          case "message.updated": {
            const info = props.info as MessageInfo | undefined;
            if (!info || info.role !== "assistant") return;

            // message.updated fires repeatedly DURING streaming — only record
            // completed messages (time.completed/finish/error set), otherwise
            // every token chunk triggers a synchronous disk write on the
            // event hot path and the log fills with redundant entries.
            const isFinal = !!info.time?.completed || !!info.finish || !!info.error;
            if (!isFinal) return;

            const ev: SessionEvent = {
              ts: Date.now(),
              event: "message",
              sessionID: info.sessionID,
              messageID: info.id,
              role: "assistant",
              modelID: info.modelID,
              providerID: info.providerID,
              tokens: info.tokens,
              cost: info.cost,
              finish: info.finish,
              timeCreated: info.time?.created,
              timeCompleted: info.time?.completed,
              errorName: info.error?.name,
            };
            appendSessionEvent(storePath, ev);
            break;
          }

          case "message.part.updated": {
            const part = props.part as PartInfo | undefined;
            if (!part) return;

            if (part.type === "step-finish") {
              const ev: SessionEvent = {
                ts: Date.now(),
                event: "step",
                sessionID: part.sessionID,
                messageID: part.messageID,
                stepTokens: part.tokens,
                stepCost: part.cost,
                stepReason: part.reason,
              };
              appendSessionEvent(storePath, ev);
            }

            if (part.type === "tool") {
              const state = part.state;
              const status = state?.status as SessionEvent["toolStatus"];
              const timeStart = state?.time?.start;
              const timeEnd = state?.time?.end;
              const duration = (timeStart != null && timeEnd != null) ? timeEnd - timeStart : undefined;

              const ev: SessionEvent = {
                ts: Date.now(),
                event: "tool",
                sessionID: part.sessionID,
                messageID: part.messageID,
                tool: part.tool,
                toolStatus: status,
                toolTimeStart: timeStart,
                toolTimeEnd: timeEnd,
                toolDurationMs: duration,
              };
              appendSessionEvent(storePath, ev);
            }
            break;
          }

          case "session.created": {
            const info = props.info as { id?: string; title?: string } | undefined;
            if (!info?.id) return;

            const ev: SessionEvent = {
              ts: Date.now(),
              event: "session.created",
              sessionID: info.id,
              sessionTitle: info.title,
            };
            appendSessionEvent(storePath, ev);
            break;
          }

          case "session.status": {
            const sessionID = props.sessionID as string | undefined;
            const status = props.status as { type?: string } | undefined;
            if (!sessionID) return;

            const ev: SessionEvent = {
              ts: Date.now(),
              event: "session.status",
              sessionID,
              sessionStatus: status?.type,
            };
            appendSessionEvent(storePath, ev);
            break;
          }
        }
      } catch {
        // Event logging must never break the plugin.
      }
    },

    onRagContext(sessionID, messageID, context): void {
      try {
        const ev: SessionEvent = {
          ts: Date.now(),
          event: "rag.context",
          sessionID,
          messageID,
          ragInjected: context.chunkCount > 0,
          ragChunkCount: context.chunkCount,
          ragUniqueFiles: context.uniqueFiles,
          ragContextTokens: context.contextTokens,
          ragTopScore: context.topScore,
          ragRetrievalTimeMs: context.retrievalTimeMs,
        };
        appendSessionEvent(storePath, ev);
      } catch {
        // Logging must never break the plugin.
      }
    },
  };
}
