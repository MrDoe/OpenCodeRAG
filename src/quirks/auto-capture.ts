import type { DescriptionProvider } from "../core/interfaces.js";
import type { RagConfig } from "../core/config.js";
import { addQuirk, recallQuirks, lexicalSimilarity, type QuirkStoreDeps } from "./quirk-store.js";
import { isQuirkAllowed } from "./monitor.js";
import { MEMORY_CAPTURE_SYSTEM_PROMPT } from "./prompts.js";

export interface CaptureExchange {
  userReq: string;
  assistantText: string;
  toolResults: { tool: string; output: string }[];
}

const ERROR_SIGNAL_RE =
  /(error|failure|fail|failed|err(?:or)?\s*:|stack\s*trace|exit\s+code\s*[1-9]|npm\s+ERR|build\s+failed|test\s+fail|cannot\s+find\s+module|command\s+failed|unresolved|conflict|peer.dep|not\s+found|enoent|eaccess|econnrefused)/i;

function detectErrorSignal(text: string): boolean {
  return ERROR_SIGNAL_RE.test(text);
}

function buildExchangeText(exchanges: CaptureExchange[]): string {
  const lines: string[] = [];
  for (const ex of exchanges) {
    lines.push("=== User ===");
    lines.push(ex.userReq);
    if (ex.toolResults.length > 0) {
      for (const tr of ex.toolResults) {
        lines.push(`--- Tool: ${tr.tool} ---`);
        lines.push(tr.output.slice(0, 500));
      }
    }
    lines.push("=== Assistant ===");
    lines.push(ex.assistantText);
  }
  return lines.join("\n");
}

const VALID_QUIRK_TYPES = new Set(["gotcha", "preference", "decision", "environment-constraint"]);

function parseExtractionOutput(text: string): { quirkType: string; content: string }[] {
  const results: { quirkType: string; content: string }[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "NOTHING") continue;
    const pipeIdx = trimmed.indexOf("|");
    if (pipeIdx <= 0) continue;
    const quirkType = trimmed.slice(0, pipeIdx).trim();
    const content = trimmed.slice(pipeIdx + 1).trim();
    if (!quirkType || !content || content.length > 200) continue;
    // An LLM emitting a garbage type would otherwise pollute recall filters —
    // skip unknown types (or default them to "gotcha").
    if (!VALID_QUIRK_TYPES.has(quirkType)) continue;
    results.push({ quirkType, content });
  }
  return results;
}

async function extractQuirksFromText(
  provider: DescriptionProvider,
  exchangeText: string,
): Promise<{ quirkType: string; content: string }[]> {
  const raw = await provider.generateText(MEMORY_CAPTURE_SYSTEM_PROMPT, exchangeText);
  return parseExtractionOutput(raw);
}

async function dedupCandidates(
  deps: QuirkStoreDeps,
  exchangeHead: string,
  candidates: { quirkType: string; content: string }[],
  threshold: number,
): Promise<{ quirkType: string; content: string }[]> {
  const existing = await recallQuirks(deps, exchangeHead, { topK: 5 });
  if (existing.length === 0) return candidates;

  const existingContent = existing.map((r) => r.chunk.content);
  return candidates.filter((c) => {
    for (const ec of existingContent) {
      if (lexicalSimilarity(c.content, ec) >= threshold) {
        return false;
      }
    }
    return true;
  });
}

export async function autoCaptureQuirks(
  deps: QuirkStoreDeps,
  descriptionProvider: DescriptionProvider,
  exchanges: CaptureExchange[],
  cfg: RagConfig,
  opts?: {
    captureAll?: boolean;
  },
): Promise<void> {
  const memoryCfg = cfg.memory;
  if (!memoryCfg) return;

  const maxPerTurn = memoryCfg.autoCaptureMaxPerTurn ?? 2;
  const dedupThreshold = memoryCfg.autoCaptureDedupThreshold ?? 0.85;
  const captureAll = opts?.captureAll ?? false;

  if (!captureAll) {
    const combined = exchanges.map((e) => e.userReq + "\n" + e.assistantText + "\n" + e.toolResults.map((t) => t.output).join("\n")).join("\n");
    if (!detectErrorSignal(combined)) return;
  }

  const exchangeText = buildExchangeText(exchanges);
  if (!exchangeText.trim()) return;

  let candidates: { quirkType: string; content: string }[];
  try {
    candidates = await extractQuirksFromText(descriptionProvider, exchangeText);
  } catch {
    return;
  }

  if (candidates.length === 0) return;

  const exchangeHead = exchanges.map((e) => e.userReq).join(" ");
  let deduped: { quirkType: string; content: string }[];
  try {
    deduped = await dedupCandidates(deps, exchangeHead, candidates, dedupThreshold);
  } catch {
    deduped = candidates;
  }

  let added = 0;
  for (const c of deduped) {
    if (added >= maxPerTurn) break;
    const allowed = isQuirkAllowed(c.content);
    if (!allowed.ok) continue;
    try {
      await addQuirk(deps, {
        content: c.content,
        quirkType: c.quirkType,
        tags: ["auto-captured"],
        confidence: 0.7,
      });
      added++;
    } catch {
      // skip individual failures
    }
  }
}
