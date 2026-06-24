import type { DocSymbol, DocFileInput, DocFileResult, DocOptions } from "./types.js";
import { buildGoogleSystemPrompt, buildUserMessageForSymbols } from "./prompts/google.js";
import { postJson } from "../embedder/http.js";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatResponse {
  message?: { content?: string };
  choices?: Array<{ message?: { content?: string } }>;
}

const RETRYABLE_STATUSES = new Set([404, 408, 429, 500, 502, 503, 504]);

function buildApiUrl(baseUrl: string, provider: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (provider === "ollama") {
    return `${normalized}/chat`;
  }
  return `${normalized}${normalized.endsWith("/v1") ? "" : "/v1"}/chat/completions`;
}

function buildRequestBody(
  provider: string,
  model: string,
  messages: ChatMessage[],
): Record<string, unknown> {
  if (provider === "ollama") {
    return { model, messages, stream: false, options: { num_ctx: 8192 } };
  }
  return { model, messages };
}

function extractResponseText(json: ChatResponse, provider: string): string {
  if (provider === "ollama") {
    const content = json.message?.content;
    if (content && content.trim().length > 0) {
      return content.trim();
    }
  }
  const content = json.choices?.[0]?.message?.content;
  if (content && content.trim().length > 0) {
    return content.trim();
  }
  throw new Error(`LLM returned empty response: ${JSON.stringify(json)}`);
}

export class DocGenerator {
  private readonly options: DocOptions;

  constructor(options: DocOptions) {
    this.options = options;
  }

  async generateForFile(input: DocFileInput): Promise<DocFileResult> {
    const symbols = input.symbols;
    if (symbols.length === 0) {
      return {
        filePath: input.filePath,
        symbols: [],
        documented: 0,
        skipped: 0,
        errors: [],
        docBlocks: [],
        status: "skipped",
      };
    }

    const results: DocFileResult = {
      filePath: input.filePath,
      symbols,
      documented: 0,
      skipped: 0,
      errors: [],
      docBlocks: [],
      status: "ok",
    };

    const batchSize = this.options.batchSize;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);

      try {
        const docComments = await this.generateBatch(input, batch);
        results.documented += docComments.length;
        results.docBlocks.push(...docComments);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.errors.push(`Batch ${i / batchSize + 1}: ${message}`);
        results.status = "failed";
      }
    }

    return results;
  }

  private async generateBatch(
    input: DocFileInput,
    symbols: DocSymbol[],
  ): Promise<string[]> {
    const systemPrompt = this.options.style === "google"
      ? buildGoogleSystemPrompt(input.language, symbols)
      : this.options.systemPrompt;

    const userMessage = buildUserMessageForSymbols(
      input.filePath,
      input.language,
      symbols,
      input.content,
    );

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    const responseContent = await this.chatRequest(messages);

    return this.parseDocComments(responseContent, symbols);
  }

  private parseDocComments(response: string, _symbols: DocSymbol[]): string[] {
    const blocks: string[] = [];
    const commentRegex = /\/\*\*[\s\S]*?\*\//g;
    const matches = response.match(commentRegex);

    if (matches) {
      for (const match of matches) {
        blocks.push(match);
      }
    }

    if (blocks.length === 0 && response.trim().length > 0) {
      blocks.push(response.trim());
    }

    return blocks;
  }

  private async chatRequest(
    messages: ChatMessage[],
  ): Promise<string> {
    const baseUrl = this.options.baseUrl;
    const provider = this.options.provider;
    const url = buildApiUrl(baseUrl, provider);

    const body = buildRequestBody(provider, this.options.model, messages);
    const headers: Record<string, string> = {};
    if (this.options.apiKey) {
      headers.Authorization = `Bearer ${this.options.apiKey}`;
    }

    const retryMax = 3;
    const retryBaseDelayMs = 1000;

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= retryMax; attempt++) {
      try {
        const response = await postJson(url, body, headers, 120000);

        if (response.ok) {
          const json = (await response.json()) as ChatResponse;
          return extractResponseText(json, provider);
        }

        const text = await response.text();
        const errorMsg = `Doc LLM request failed (${response.status}): ${text}`;

        if (!RETRYABLE_STATUSES.has(response.status) || attempt === retryMax) {
          throw new Error(errorMsg);
        }

        lastError = new Error(errorMsg);
        await new Promise((r) => setTimeout(r, retryBaseDelayMs * Math.pow(2, attempt)));
      } catch (err) {
        if (attempt === retryMax) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
        await new Promise((r) => setTimeout(r, retryBaseDelayMs * Math.pow(2, attempt)));
      }
    }

    throw lastError ?? new Error("Doc LLM request failed: unknown error");
  }
}
