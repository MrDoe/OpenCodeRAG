/**
 * @fileoverview OpenCode Zen provider helpers — provider detection, chat-completion
 * base URLs, and base-URL resolution for the OpenAI-compatible Zen endpoints.
 */

/** OpenCode Zen chat-completion base URLs by provider id. */
export const ZEN_PROVIDER_BASE_URLS: Record<string, string> = {
  opencode: "https://opencode.ai/zen/v1",
  "opencode-go": "https://opencode.ai/zen/go/v1",
};

/** Whether the provider id refers to an OpenCode Zen endpoint. */
export function isZenProvider(provider: string): boolean {
  return provider in ZEN_PROVIDER_BASE_URLS;
}

/**
 * Pick the Zen base URL for a Zen provider. Configured URLs that point at an
 * `opencode.ai` host are kept (alternate Zen endpoints); anything else — e.g.
 * the Ollama/llama.cpp base inherited from the indexing section — is replaced
 * by the provider default.
 */
export function resolveZenBaseUrl(configuredBaseUrl: string | undefined, provider: string): string {
  const configured = (configuredBaseUrl ?? "").trim();
  if (configured.includes("opencode.ai")) return configured;
  return ZEN_PROVIDER_BASE_URLS[provider] ?? configured;
}
