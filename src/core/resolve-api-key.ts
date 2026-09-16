/**
 * @fileoverview Auto-resolves API keys for embedding, description, and image description providers
 * from config, environment variables, or OpenCode provider configuration.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { RagConfig } from "./config.js";
import { getProviderDefault } from "./provider-defaults.js";

/** Resolve API keys for embedding, description, and image description providers. Checks config, env vars, and OpenCode provider config. */
export function resolveApiKey(
  cfg: RagConfig,
  worktree?: string
): void {
  resolveForSection(cfg.embedding.provider, cfg.embedding, worktree);
  if (cfg.description) {
    resolveForSection(cfg.description.provider, cfg.description, worktree);
  }
  if (cfg.imageDescription?.enabled && cfg.imageDescription.provider !== "ollama") {
    resolveForSection(cfg.imageDescription.provider, cfg.imageDescription, worktree);
  }
  const imageOnDemand = cfg.imageDescription?.onDemand;
  if (imageOnDemand) {
    const provider = imageOnDemand.provider ?? cfg.imageDescription?.provider ?? "ollama";
    resolveForSection(provider, imageOnDemand, worktree);
  }
}

function isPlaceholder(value: string): boolean {
  return value === "public" || value === "" || value === "PLACEHOLDER";
}

function resolveForSection(
  provider: string,
  section: { apiKey?: string },
  worktree?: string,
): void {
  // If a real (non-placeholder) key is already set, keep it
  if (section.apiKey && !isPlaceholder(section.apiKey)) return;

  const defaults = getProviderDefault(provider);
  const envVar = defaults?.apiKeyEnvVar;
  if (envVar) {
    const envKey = process.env[envVar];
    if (envKey) {
      section.apiKey = envKey;
      return;
    }
  }

  if (worktree) {
    const key = readOpenCodeProviderKey(worktree, provider);
    if (key) {
      section.apiKey = key;
      return;
    }
  }

  const authKey = readOpenCodeAuthKey(provider);
  if (authKey) {
    section.apiKey = authKey;
    return;
  }

  // If we had a placeholder but couldn't resolve a real key, keep the placeholder
  // so createEmbedder can throw a clear error about the missing key
}

/**
 * Read an API key from OpenCode's auth store (`$XDG_DATA_HOME/opencode/auth.json`
 * or `~/.local/share/opencode/auth.json`). This is where `/connect` stores keys
 * for providers such as OpenCode Zen (`opencode`, `opencode-go`).
 */
function readOpenCodeAuthKey(providerId: string): string | undefined {
  const homeDir = process.env.USERPROFILE || process.env.HOME;
  const dataHome = process.env.XDG_DATA_HOME?.trim() || (homeDir ? path.join(homeDir, ".local", "share") : undefined);
  if (!dataHome) return undefined;

  const authPath = path.join(dataHome, "opencode", "auth.json");
  try {
    if (!existsSync(authPath)) return undefined;
    const auth = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
    const entry = auth[providerId] as { type?: string; key?: string } | undefined;
    if (entry && entry.type === "api" && entry.key) return entry.key;
  } catch {
    // skip unreadable or unparseable auth stores
  }
  return undefined;
}

function stripJsoncComments(text: string): string {
  return text.replace(
    /("[^"\\]*(?:\\.[^"\\]*)*")|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g,
    (_, string) => string ?? "",
  );
}

function readOpenCodeProviderKey(worktree: string, providerId: string): string | undefined {
  const locations = [
    path.join(worktree, ".opencode", "opencode.json"),
    path.join(worktree, "opencode.json"),
  ];
  const homeDir = process.env.USERPROFILE || process.env.HOME;
  if (homeDir) {
    locations.push(path.join(homeDir, ".config", "opencode", "opencode.jsonc"));
  }

  for (const loc of locations) {
    try {
      if (!existsSync(loc)) continue;
      const raw = readFileSync(loc, "utf-8");
      // Only strip JSONC comments from .jsonc files; plain JSON may contain
      // "https://" URLs that look like line-comment markers after "//".
      const cleaned = loc.endsWith(".jsonc") ? stripJsoncComments(raw) : raw;
      const config = JSON.parse(cleaned) as Record<string, unknown>;
      const providerSection = config.provider as Record<string, unknown> | undefined;
      if (!providerSection) continue;
      const providerConfig = providerSection[providerId] as Record<string, unknown> | undefined;
      if (!providerConfig) continue;
      const options = providerConfig.options as Record<string, unknown> | undefined;
      const key = options?.apiKey as string | undefined;
      if (key) return key;
    } catch {
      // skip unreadable or unparseable files
    }
  }
  return undefined;
}
