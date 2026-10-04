/**
 * @fileoverview Ollama decision-model provider (tev1) using the
 * `/v1/systemone` endpoint.
 *
 * Decision models are NOT chat models: `state` is scored against 1-64 named
 * `questions` and the response carries probabilities per question. The
 * endpoint is root-level (`/v1/systemone`), so the `/api` suffix used by the
 * embedding/description sections is stripped before building the URL.
 *
 * Requires Ollama >= 0.35 and a pulled tev1 model (`ollama pull tev1` or
 * `ollama pull tev1:0.8b`).
 */
import type {
  DecisionAnswer,
  DecisionProvider,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
} from "../core/interfaces.js";
import type { DecisionConfig, ProxyConfig } from "../core/config.js";
import { normalizeKeepAlive } from "../core/ollama.js";
import { postJson, type HttpResponseLike } from "../embedder/http.js";

/** HTTP status codes that are safe to retry on. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** Request body size cap imposed by Ollama's decision endpoint (64 KiB). */
export const SYSTEMONE_MAX_REQUEST_BYTES = 64 * 1024;

/** Maximum number of questions per request (tev1 limit). */
export const SYSTEMONE_MAX_QUESTIONS = 64;

/** Minimum options/levels for `choice`/`score` questions. */
export const SYSTEMONE_MIN_OPTIONS = 2;

/** tev1 was trained on up to 24 options; 26 is the API maximum. */
export const SYSTEMONE_MAX_OPTIONS = 24;

/**
 * Resolve the decision endpoint from a configured base URL.
 *
 * Accepts both root URLs (`http://127.0.0.1:11434`) and the `/api`-suffixed
 * convention used by the embedding/description sections (`…:11434/api`) —
 * `/api` is dropped because decision models are served at `/v1/systemone`.
 *
 * @param baseUrl - Configured Ollama base URL.
 * @returns The absolute `/v1/systemone` URL.
 */
export function resolveSystemOneUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const root = trimmed.endsWith("/api") ? trimmed.slice(0, -"/api".length) : trimmed;
  return `${root}/v1/systemone`;
}

/** Coerce a number-or-numeric-string to a finite number, else undefined. */
function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Parse one raw answer object into a typed {@link DecisionAnswer}. */
function parseAnswer(id: string, question: DecisionQuestion, raw: unknown): DecisionAnswer {
  const record = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const answer: DecisionAnswer = { id, type: question.type };

  if (typeof record.choice === "string" && record.choice.length > 0) {
    answer.choice = record.choice;
  }

  const noul = record.noul;
  if (noul !== null && typeof noul === "object") {
    // Defensive: some embeddings of the API wrap the probability.
    const wrapped = noul as Record<string, unknown>;
    const p = toNumber(wrapped.probability) ?? toNumber(wrapped.noul);
    if (p !== undefined) answer.noul = p;
  } else {
    const p = toNumber(noul);
    if (p !== undefined) answer.noul = p;
  }

  const score = toNumber(record.score);
  if (score !== undefined) answer.score = score;

  if (Array.isArray(record.legend)) {
    const legend = record.legend.filter((entry): entry is string => typeof entry === "string");
    if (legend.length > 0) answer.legend = legend;
  }

  const probabilities = record.probabilities;
  if (Array.isArray(probabilities)) {
    const values = probabilities
      .map(toNumber)
      .filter((value): value is number => value !== undefined);
    if (values.length > 0) answer.probabilities = values;
  } else if (probabilities !== null && typeof probabilities === "object") {
    const map: Record<string, number> = {};
    for (const [key, value] of Object.entries(probabilities as Record<string, unknown>)) {
      const n = toNumber(value);
      if (n !== undefined) map[key] = n;
    }
    if (Object.keys(map).length > 0) answer.probabilities = map;
  }

  const confidence = toNumber(record.confidence);
  if (confidence !== undefined) answer.confidence = confidence;

  return answer;
}

/**
 * Build the `questions` entry for the request body. `criteria` is passed
 * through as-is; validation happens before the provider is called.
 */
function buildQuestionPayload(question: DecisionQuestion): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: question.type,
    instructions: question.instructions,
  };
  if (question.criteria !== undefined) {
    payload.criteria = question.criteria;
  }
  return payload;
}

/** Truncate provider error bodies so logs stay readable. */
function truncate(text: string, max = 300): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Decision provider for Ollama's `/v1/systemone` endpoint (tev1).
 *
 * Retries retryable HTTP statuses and network errors with exponential
 * backoff. The first call may load the model, so configure a generous
 * `timeoutMs` (default 120s) and optionally `keepAlive` to keep it resident.
 */
export class OllamaDecisionProvider implements DecisionProvider {
  readonly name = "ollama";

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly keepAlive?: string;
  private readonly proxy?: ProxyConfig;
  private readonly retryMax: number;
  private readonly retryBaseDelayMs: number;

  /**
   * @param config - Decision-model configuration (endpoint, model, timeout, proxy, retries).
   */
  constructor(config: DecisionConfig) {
    this.baseUrl = config.baseUrl;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs > 0 ? config.timeoutMs : 120000;
    this.keepAlive = config.keepAlive;
    this.proxy = config.proxy;
    this.retryMax = config.retryMax ?? 2;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 500;
  }

  /**
   * Run a decision request. One answer is returned per question, in request
   * order; answers missing from the response degrade to bare `{id, type}`.
   *
   * @param request - The state text and questions.
   * @param abort - Optional abort signal.
   * @throws If the endpoint is unreachable, rejects the request (e.g. Ollama
   *   < 0.35 or model not pulled), the body exceeds 64 KiB, or the response
   *   carries no answers.
   */
  async decide(request: DecisionRequest, abort?: AbortSignal): Promise<DecisionResult> {
    const questions: Record<string, unknown> = {};
    for (const question of request.questions) {
      questions[question.id] = buildQuestionPayload(question);
    }

    const body: Record<string, unknown> = {
      model: this.model,
      state: request.state,
      questions,
    };
    const keepAlive = normalizeKeepAlive(this.keepAlive);
    if (keepAlive !== undefined) body.keep_alive = keepAlive;

    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized, "utf-8") > SYSTEMONE_MAX_REQUEST_BYTES) {
      throw new Error(
        `Decision request exceeds Ollama's 64 KiB body limit (${Buffer.byteLength(serialized, "utf-8")} bytes). ` +
        `Shorten \`state\` or ask fewer questions.`
      );
    }

    const url = resolveSystemOneUrl(this.baseUrl);
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.retryMax; attempt++) {
      let response: HttpResponseLike;
      try {
        response = await postJson(url, body, {}, this.timeoutMs, this.proxy, abort);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.retryMax) {
          await this.sleep(attempt);
          continue;
        }
        throw lastError;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const error = new Error(this.describeHttpError(response.status, text));
        if (RETRYABLE_STATUSES.has(response.status) && attempt < this.retryMax) {
          lastError = error;
          await this.sleep(attempt);
          continue;
        }
        throw error;
      }

      const json = (await response.json()) as Record<string, unknown>;
      const rawAnswers = json?.answers;
      if (rawAnswers === null || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) {
        throw new Error(
          `Decision model returned no answers for model "${this.model}": ${truncate(JSON.stringify(json))}`
        );
      }

      const answerMap = rawAnswers as Record<string, unknown>;
      const answers: DecisionAnswer[] = [];
      for (const question of request.questions) {
        answers.push(parseAnswer(question.id, question, answerMap[question.id]));
      }
      return { answers, raw: json };
    }

    throw lastError ?? new Error("Decision request failed");
  }

  /**
   * Map an HTTP failure to an actionable message.
   *
   * 404 is overloaded: Ollama < 0.35 returns the Go default "404 page not
   * found" (route missing), while a server that has the decision route but
   * not the model returns `model "X" not found, try pulling it first`. Split
   * the two so the fix is obvious.
   */
  private describeHttpError(status: number, text: string): string {
    const detail = truncate(text);
    if (status === 404) {
      const lower = text.toLowerCase();
      const modelLower = this.model.toLowerCase();
      if (lower.includes("try pulling") || (lower.includes("not found") && lower.includes(modelLower))) {
        return `Decision model "${this.model}" is not pulled (404) — run \`ollama pull ${this.model}\`. ${detail}`;
      }
      if (lower.includes("page not found") || detail.length === 0) {
        return `Decision endpoint not found (404) — tev1 requires Ollama >= 0.35 (\`POST /v1/systemone\`). ${detail}`;
      }
      return (
        `Decision request not found (404) — tev1 requires Ollama >= 0.35 and the model must be pulled ` +
        `(\`ollama pull ${this.model}\`). ${detail}`
      );
    }
    return `Ollama decision request failed (${status}): ${detail}`;
  }

  /** Exponential backoff between retries. */
  private sleep(attempt: number): Promise<void> {
    const delay = this.retryBaseDelayMs * Math.pow(2, attempt);
    return new Promise((resolve) => setTimeout(resolve, delay));
  }
}
