/**
 * @fileoverview Registry of known LLM/embedding provider defaults — base URLs, env var names,
 * capability flags, and utility functions for provider lookup.
 */

/** Default configuration parameters for a supported LLM/embedding provider. */
export interface ProviderDefaults {
  /** Default base URL for API requests. */
  defaultBaseUrl: string;
  /** Environment variable name to read the API key from. */
  apiKeyEnvVar: string;
  /** Whether this provider supports embedding endpoints. */
  supportsEmbedding: boolean;
  /** Whether this provider supports chat/completion endpoints. */
  supportsChat: boolean;
}

/** Registry of known provider default configurations (base URLs, env vars, capability flags). */
export const PROVIDER_DEFAULTS: Record<string, ProviderDefaults> = {
  ollama: {
    defaultBaseUrl: "http://127.0.0.1:11434",
    apiKeyEnvVar: "",
    supportsEmbedding: true,
    supportsChat: true,
  },
  openai: {
    defaultBaseUrl: "https://api.openai.com/v1",
    apiKeyEnvVar: "OPENAI_API_KEY",
    supportsEmbedding: true,
    supportsChat: true,
  },
  nvidia: {
    defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
    apiKeyEnvVar: "NVIDIA_API_KEY",
    supportsEmbedding: true,
    supportsChat: true,
  },
  azure: {
    defaultBaseUrl: "",
    apiKeyEnvVar: "AZURE_OPENAI_KEY",
    supportsEmbedding: true,
    supportsChat: true,
  },
  mistral: {
    defaultBaseUrl: "https://api.mistral.ai/v1",
    apiKeyEnvVar: "MISTRAL_API_KEY",
    supportsEmbedding: true,
    supportsChat: true,
  },
  together: {
    defaultBaseUrl: "https://api.together.xyz/v1",
    apiKeyEnvVar: "TOGETHER_API_KEY",
    supportsEmbedding: true,
    supportsChat: true,
  },
  groq: {
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnvVar: "GROQ_API_KEY",
    supportsEmbedding: false,
    supportsChat: true,
  },
  deepseek: {
    defaultBaseUrl: "https://api.deepseek.com",
    apiKeyEnvVar: "DEEPSEEK_API_KEY",
    supportsEmbedding: false,
    supportsChat: true,
  },
  fireworks: {
    defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
    apiKeyEnvVar: "FIREWORKS_API_KEY",
    supportsEmbedding: true,
    supportsChat: true,
  },
  anthropic: {
    defaultBaseUrl: "https://api.anthropic.com/v1",
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
    supportsEmbedding: false,
    supportsChat: true,
  },
  google: {
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1",
    apiKeyEnvVar: "GOOGLE_API_KEY",
    supportsEmbedding: false,
    supportsChat: true,
  },
  cohere: {
    defaultBaseUrl: "https://api.cohere.ai/v1",
    apiKeyEnvVar: "COHERE_API_KEY",
    supportsEmbedding: true,
    supportsChat: false,
  },
};

/** Look up default configuration for a named provider. Returns undefined for unknown providers. */
export function getProviderDefault(provider: string): ProviderDefaults | undefined {
  return PROVIDER_DEFAULTS[provider];
}

/** OpenAI-compatible providers (embedding + chat via /v1-style APIs). */
const OPENAI_COMPATIBLE_PROVIDERS = new Set([
  "openai",
  "nvidia",
  "azure",
  "mistral",
  "together",
  "groq",
  "deepseek",
  "fireworks",
]);

/** Check whether a given provider uses an OpenAI-compatible API format. */
export function isOpenAiCompatible(provider: string): boolean {
  // Only KNOWN OpenAI-compatible providers qualify — an unknown/typo'd
  // provider name must fail fast instead of silently attempting
  // OpenAI-style calls against a nonsense base URL.
  return OPENAI_COMPATIBLE_PROVIDERS.has(provider);
}

/** Whether the given provider can produce embeddings. */
export function supportsEmbedding(provider: string): boolean {
  return PROVIDER_DEFAULTS[provider]?.supportsEmbedding ?? false;
}
