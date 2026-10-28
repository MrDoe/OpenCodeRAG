/**
 * @fileoverview Answer and config-patch types shared by the `setup` wizard.
 */

/** A provider endpoint selected for one capability group. */
export interface HostChoice {
  /** Provider id: `ollama`, `openai`, `cohere`, `anthropic`, `google`. */
  provider: string;
  /** Base URL written into the config (Ollama keeps the `/api` suffix). */
  baseUrl: string;
  /** API key typed by the user. Omitted when it is resolved from the environment. */
  apiKey?: string;
}

/** Embedding host plus the selected model. */
export interface EmbeddingChoice extends HostChoice {
  /** Embedding model id. */
  model: string;
  /** Probed vector dimension, so the store schema stays stable. */
  vectorDimension?: number;
}

/** Chat/vision host plus the selected model. */
export interface ChatChoice extends HostChoice {
  /** Chat or vision model id. */
  model: string;
}

/** Decision-model settings (Ollama only). */
export interface DecisionChoice {
  /** Whether `make_decision` / shell guard are available. */
  enabled: boolean;
  /** Ollama root or `/api` URL. */
  baseUrl?: string;
  /** Decision model id (`tev1:0.8b`, `tev1:4b`). */
  model?: string;
  /** Route choices through `make_decision` before asking the user. */
  routeBeforeAsking?: boolean;
}

/** Optional reranker settings. */
export interface RerankChoice {
  /** Whether reranking is enabled. */
  enabled: boolean;
  /** Rerank endpoint base URL (llama-server `/v1`). */
  baseUrl?: string;
  /** Rerank model id. */
  model?: string;
}

/** Central vector-store backend selected in the wizard. */
export interface VectorStoreChoice {
  /** Backend id. */
  provider: "lancedb" | "clickhouse";
  /** ClickHouse connection settings (only when `provider` is `clickhouse`). */
  clickhouse?: {
    url?: string;
    database?: string;
    username?: string;
    passwordEnv?: string;
    namespace?: string;
  };
}

/** Everything the wizard collected. */
export interface WizardAnswers {
  /** Required: where embeddings come from. */
  embedding: EmbeddingChoice;
  /** Optional: LLM chunk descriptions. */
  description?: ChatChoice;
  /** Explicit on/off for chunk descriptions (the wizard always answers this). */
  descriptionEnabled?: boolean;
  /** Optional: vision-based image descriptions. */
  imageDescription?: ChatChoice;
  /** Explicit on/off for image descriptions. */
  imageDescriptionEnabled?: boolean;
  /** Optional: decision model (Ollama `/v1/systemone`). */
  decision?: DecisionChoice;
  /** Optional: reranker. */
  reranking?: RerankChoice;
  /** Optional: shell-command guard toggle. */
  shellGuard?: { enabled: boolean };
  /** Optional: automatic quirk capture (memory) toggles. */
  memory?: {
    passiveCapture?: boolean;
    promptEnforcement?: boolean;
    sessionEndExtraction?: boolean;
  };
  /** Optional: vector-store backend. */
  vectorStore?: VectorStoreChoice;
  /** Optional: indexing tweaks. */
  indexing?: { embedDescriptions?: boolean };
  /** Optional: background indexing. */
  openCode?: { autoIndex?: boolean };
  /**
   * Set when the wizard applied a recommended preset. `setup` then pulls
   * missing models without a second confirmation.
   */
  recommended?: boolean;
}
