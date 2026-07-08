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
  if (!defaults || !defaults.apiKeyEnvVar) return;

  const envKey = process.env[defaults.apiKeyEnvVar];
  if (envKey) {
    section.apiKey = envKey;
    return;
  }

  if (worktree) {
    const key = readOpenCodeProviderKey(worktree, provider);
    if (key) {
      section.apiKey = key;
      return;
    }
  }

  // If we had a placeholder but couldn't resolve a real key, keep the placeholder
  // so createEmbedder can throw a clear error about the missing key
}

function stripJsoncComments(text: string): string {
  return text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
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
