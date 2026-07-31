/**
 * @fileoverview JSONL-based session event storage, retrieval, summarization, and comparison for evaluation.
 */
import { appendFileSync, readFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import type { SessionEvent, SessionSummary, ComparisonResult } from "./types.js";
import { isRagTool } from "./types.js";

const EVAL_DIR = "eval-sessions";
const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

function getEvalDir(storePath: string): string {
  return path.join(storePath, EVAL_DIR);
}

function getSessionPath(storePath: string, sessionID: string): string {
  return path.join(getEvalDir(storePath), `${sessionID}.jsonl`);
}

/** Validate that a session ID contains only safe characters (alphanumeric, underscore, hyphen). */
export function validateSessionID(sessionID: string): boolean {
  return SAFE_ID_REGEX.test(sessionID);
}

/** Append a single event to a session's JSONL log file. Creates the directory and file if needed. */
export function appendSessionEvent(storePath: string, event: SessionEvent): void {
  try {
    // Guard against path traversal / malformed IDs — never write outside the
    // eval directory.
    if (!validateSessionID(event.sessionID)) return;
    const dir = getEvalDir(storePath);
    mkdirSync(dir, { recursive: true });
    const filePath = getSessionPath(storePath, event.sessionID);
    appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // Logging must never break the plugin.
  }
}

/** Read all events for a session from its JSONL log file. Returns an empty array if the file does not exist or cannot be read. */
export function readSessionEvents(storePath: string, sessionID: string): SessionEvent[] {
  try {
    if (!validateSessionID(sessionID)) return [];
    const filePath = getSessionPath(storePath, sessionID);
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    return lines.map((line) => JSON.parse(line) as SessionEvent);
  } catch {
    return [];
  }
}

/** List all available session IDs by scanning the sessions directory for JSONL files. */
export function listSessionIDs(storePath: string): string[] {
  try {
    const dir = getEvalDir(storePath);
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir);
    return files
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -6)); // remove .jsonl
  } catch {
    return [];
  }
}

/** Delete a session's JSONL log file from disk. Silently succeeds if the file does not exist. */
export function deleteSession(storePath: string, sessionID: string): void {
  try {
    if (!validateSessionID(sessionID)) return;
    const filePath = getSessionPath(storePath, sessionID);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // Ignore errors
  }
}

/** Aggregate session events into a summary with total token counts, costs, tool call tallies, and model list. */
export function computeSummary(events: SessionEvent[]): SessionSummary {
  const summary: SessionSummary = {
    sessionID: events[0]?.sessionID ?? "",
    startedAt: events[0]?.ts ?? 0,
    lastEventAt: 0,
    messageCount: 0,
    totalTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    totalCost: 0,
    totalSteps: 0,
    ragContextCount: 0,
    ragToolCalls: 0,
    ragContextTokens: 0,
    toolCallCounts: {},
    models: [],
  };

  const modelSet = new Set<string>();
  const responseTimes: number[] = [];

  for (const ev of events) {
    if (ev.ts > summary.lastEventAt) {
      summary.lastEventAt = ev.ts;
    }

    switch (ev.event) {
      case "message":
        if (ev.role === "assistant") {
          summary.messageCount++;
          if (ev.tokens) {
            summary.totalTokens.input += ev.tokens.input;
            summary.totalTokens.output += ev.tokens.output;
            summary.totalTokens.reasoning += ev.tokens.reasoning;
            summary.totalTokens.cacheRead += ev.tokens.cache.read;
            summary.totalTokens.cacheWrite += ev.tokens.cache.write;
          }
          if (ev.cost != null) {
            summary.totalCost += ev.cost;
          }
          if (ev.modelID) {
            modelSet.add(ev.modelID);
          }
          if (ev.timeCreated && ev.timeCompleted && ev.timeCompleted > ev.timeCreated) {
            responseTimes.push(ev.timeCompleted - ev.timeCreated);
          }
        }
        break;

      case "step":
        summary.totalSteps++;
        break;

      case "tool":
        if (ev.tool) {
          summary.toolCallCounts[ev.tool] = (summary.toolCallCounts[ev.tool] ?? 0) + 1;
          if (isRagTool(ev.tool)) {
            summary.ragToolCalls++;
          }
        }
        break;

      case "rag.context":
        if (ev.ragInjected) {
          summary.ragContextCount++;
        }
        if (ev.ragContextTokens) {
          summary.ragContextTokens += ev.ragContextTokens;
        }
        break;

      case "session.created":
        if (ev.sessionTitle) {
          summary.title = ev.sessionTitle;
        }
        break;
    }
  }

  summary.models = [...modelSet];

  if (responseTimes.length > 0) {
    summary.avgResponseTimeMs = Math.round(
      responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
    );
  }

  return summary;
}

/** List all stored sessions with their summaries, sorted by most recent activity first. */
export function listSessions(storePath: string): SessionSummary[] {
  const ids = listSessionIDs(storePath);
  const summaries: SessionSummary[] = [];

  for (const id of ids) {
    const events = readSessionEvents(storePath, id);
    if (events.length > 0) {
      summaries.push(computeSummary(events));
    }
  }

  summaries.sort((a, b) => b.lastEventAt - a.lastEventAt);
  return summaries;
}

/** Retrieve a session's full event log and computed summary. Returns null if the session does not exist. */
export function getSession(storePath: string, sessionID: string): { events: SessionEvent[]; summary: SessionSummary } | null {
  const events = readSessionEvents(storePath, sessionID);
  if (events.length === 0) return null;
  return { events, summary: computeSummary(events) };
}

/** Compare two sessions by computing the delta between their summaries. Returns null if either session does not exist. */
export function compareSessions(storePath: string, idA: string, idB: string): ComparisonResult | null {
  const sessionA = getSession(storePath, idA);
  const sessionB = getSession(storePath, idB);
  if (!sessionA || !sessionB) return null;

  const a = sessionA.summary;
  const b = sessionB.summary;

  return {
    sessionA: a,
    sessionB: b,
    delta: {
      totalTokens: (b.totalTokens.input + b.totalTokens.output + b.totalTokens.reasoning)
        - (a.totalTokens.input + a.totalTokens.output + a.totalTokens.reasoning),
      inputTokens: b.totalTokens.input - a.totalTokens.input,
      outputTokens: b.totalTokens.output - a.totalTokens.output,
      reasoningTokens: b.totalTokens.reasoning - a.totalTokens.reasoning,
      cacheRead: b.totalTokens.cacheRead - a.totalTokens.cacheRead,
      cacheWrite: b.totalTokens.cacheWrite - a.totalTokens.cacheWrite,
      cost: b.totalCost - a.totalCost,
      messageCount: b.messageCount - a.messageCount,
      totalSteps: b.totalSteps - a.totalSteps,
      ragContextCount: b.ragContextCount - a.ragContextCount,
      ragToolCalls: b.ragToolCalls - a.ragToolCalls,
      ragContextTokens: b.ragContextTokens - a.ragContextTokens,
      avgResponseTimeMs: (b.avgResponseTimeMs ?? 0) - (a.avgResponseTimeMs ?? 0),
    },
  };
}
