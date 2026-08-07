# Embedding

## Providers

OpenCodeRAG supports three embedding providers, dispatched via the `EmbeddingProvider` interface and `createEmbedder()` factory.

| Provider | Config Value | Transport | Batching |
|---|---|---|---|
| Ollama | `"ollama"` | HTTP POST /embed | Batched input (parallel via `embedConcurrency`) |
| OpenAI | `"openai"` | HTTP POST with auth header | Batched input (parallel via `embedConcurrency`) |
| Cohere | `"cohere"` | HTTP POST | Batched input (parallel via `embedConcurrency`) |

### Ollama (Default)

```json
{
  "embedding": {
    "provider": "ollama",
    "baseUrl": "http://localhost:11434/api",
    "model": "mxbai-embed-large",
    "timeoutMs": 30000
  }
}
```

- Fully local, no API key needed
- All processing stays on your machine
- Use `http://127.0.0.1:11434/api` for the raw socket bypass to work correctly inside OpenCode

### OpenAI

```json
{
  "embedding": {
    "provider": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-...",
    "model": "text-embedding-3-small"
  }
}
```

- API key can be auto-resolved from OpenCode provider config if omitted
- Supports `input_type: "query"` / `"document"` parameter
- Uses text prefixing alongside `input_type` for best results

### Cohere

```json
{
  "embedding": {
    "provider": "cohere",
    "baseUrl": "https://api.cohere.ai/v1",
    "apiKey": "...",
    "model": "embed-english-v3.0"
  }
}
```

## Model Recommendations

Based on CodeSearchNet benchmarks:

| Model | Type | Dims | MRR | R@1 | Cost |
|---|---|---|---|---|---|
| OpenAI text-embedding-3-small | general | 1536 | 95.0% | 91% | $0.02/1M tokens |
| Cohere v3 | general | 1024 | 92.8% | 87% | $0.10/1M tokens |
| MiniLM-L6 | general | 384 | 80.1% | 69% | Free |
| GraphCodeBERT | code-specific | 768 | 50.9% | 39% | Free |
| CodeBERT | code-specific | 768 | 11.7% | 6.5% | Free |

### Recommended Ollama Models (Ranked)

1. **`bge-m3`** (1024d) — multilingual, top-tier quality
2. **`mxbai-embed-large`** (1024d) — high quality for English
3. **`nomic-embed-code`** (768d) — code-specific, supports `search_query:` / `search_document:` prefixes
4. **`nomic-embed-text`** (768d) — good all-purpose, same prefix support
5. **`all-minilm:l6-v2`** (384d) — fast, lightweight, ~80% of best quality

> Avoid old/small BERT-based models. CodeBERT achieves only 12% MRR and GraphCodeBERT 51% MRR — far worse than any general-purpose alternative.

## Query vs. Document Differentiation

OpenCodeRAG uses two complementary approaches:

### Text Prefixing (All Providers)
Configure `documentPrefix` and `queryPrefix` in `opencode-rag.json`:

```json
{
  "embedding": {
    "documentPrefix": "search_document: ",
    "queryPrefix": "search_query: "
  }
}
```

Indexing prepends the document prefix to each chunk's text before embedding. Queries prepend the query prefix.

### `input_type` Parameter (OpenAI Only)
OpenAI's `text-embedding-3` models accept `input_type: "query"` or `"document"` in the API request body. OpenCodeRAG uses both approaches together when on OpenAI.

## Proxy Support

OpenCodeRAG supports corporate proxies at multiple levels:

### 1. Environment Variables
```bash
export HTTP_PROXY=http://proxy.example.com:8080
export HTTPS_PROXY=http://proxy.example.com:8080
```

Node.js `fetch()` routes external requests through the proxy. Localhost is always bypassed.

### 2. Config File Proxy
```json
{
  "embedding": {
    "proxy": {
      "url": "http://proxy.example.com:8080",
      "username": "user",
      "password": "pass",
      "noProxy": "localhost,127.0.0.1,.local,.internal"
    }
  }
}
```

- `username`/`password` are sent as `Proxy-Authorization: Basic` header
- `noProxy` is a comma-separated list of bypassed hosts

### 3. OpenCode Runtime Localhost Bypass
When running inside OpenCode, the runtime can patch the Node HTTP stack, causing localhost Ollama calls to be proxied unexpectedly. OpenCodeRAG's `directRequest()` in `http.ts` uses raw `net`/`tls` sockets for localhost traffic, bypassing the patched stack entirely.

### Precedence
If both env vars and config `proxy.url` are set, env vars take precedence.

## Dimension Probing

At startup, the plugin probes the embedding dimension by sending a single `"dimension-probe"` request. If the probe fails, it falls back to **384 dimensions**. This auto-detection ensures the LanceDB schema matches the model without manual configuration.

## Parallel Embedding

The `embedBatch` function sends multiple embedding batch requests concurrently, controlled by `indexing.embedConcurrency` (default: 3). This means if you have 1000 chunks and a batch size of 100, instead of 10 sequential HTTP requests, OpenCodeRAG will send up to 3 batches in parallel, reducing total embedding time.

```json
{
  "indexing": {
    "embedBatchSize": 100,
    "embedConcurrency": 3
  }
}
```

Increase `embedConcurrency` if your embedding provider can handle concurrent requests (e.g., local Ollama). For rate-limited providers, keep it low or at 1.

## Model Residency (`keepAlive`)

Ollama evicts idle models after 5 minutes by default. To keep models resident across phases and runs (avoiding unload/reload thrash between the description and embedding phases), set `keepAlive` in the embedding and/or description config:

```json
{
  "embedding": { "keepAlive": "-1" },
  "description": { "keepAlive": "-1" }
}
```

`"-1"` keeps the model in memory indefinitely; any Ollama duration string (e.g. `"30m"`, `"24h"`) also works. The value is sent as `keep_alive` on every `/api/embed` and `/api/chat` request. Note: pinning several models in memory competes for VRAM — see `OLLAMA_MAX_LOADED_MODELS` in the [configuration docs](configuration.md).

## Connection Reuse

OpenCodeRAG maintains an HTTP connection pool for the embedding provider. When multiple embedding requests are sent to the same host, TCP connections are reused instead of creating new ones for each request. This reduces connection overhead, especially for remote providers. Connections are kept alive for 30 seconds and the pool maintains up to 4 connections per host.

## Embedding Provider Extensibility

Adding a new provider means:

1. Create `src/embedder/<name>.ts` implementing `EmbeddingProvider`
2. Add a dispatch case in `createEmbedder()` in `factory.ts`
3. Update the `RagConfig.embedding.provider` union type in `config.ts`

## Relationship to Description and Vision Providers

Embedding only converts text to vectors. OpenCodeRAG supports two optional text-generation steps that produce the text to be embedded:

- **Description model** (`description.*`): generates natural-language summaries of code chunks. See [Configuration](configuration.md).
- **Vision model** (`imageDescription.*`): generates natural-language descriptions of images. See [Configuration](configuration.md).

These providers are independent of the embedding provider, and their outputs are embedded using the configured embedding model.
