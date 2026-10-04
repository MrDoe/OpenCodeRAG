/**
 * @fileoverview Factory for decision-model providers.
 *
 * Only Ollama's `/v1/systemone` (tev1) is implemented for now; the factory
 * keeps the provider name dispatch so future backends (e.g. TypeSafe/Jev
 * hosted APIs) can be added without touching call sites.
 */
import type { DecisionProvider } from "../core/interfaces.js";
import type { DecisionConfig } from "../core/config.js";
import { OllamaDecisionProvider } from "./systemone.js";

/**
 * Create a decision provider instance based on configuration.
 *
 * @param config - Decision configuration including provider, endpoint, and model.
 * @returns An initialized {@link DecisionProvider} instance.
 * @throws If `provider` is not `"ollama"` (not supported yet).
 */
export function createDecisionProvider(config: DecisionConfig): DecisionProvider {
  const provider = (config.provider || "ollama").toLowerCase();
  if (provider === "ollama") {
    return new OllamaDecisionProvider(config);
  }
  throw new Error(
    `Decision provider "${config.provider}" is not supported yet — only "ollama" ` +
    "(tev1 via /v1/systemone) is implemented."
  );
}
