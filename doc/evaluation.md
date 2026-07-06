# Evaluation & Token Analysis

OpenCodeRAG tracks token usage, RAG injection overhead, and costs across OpenCode sessions. This enables you to measure whether semantic retrieval saves or costs tokens, and to optimize configuration (embedding model, `minScore` threshold, `maxChunks`).

## How Session Logging Works

The plugin captures OpenCode session events automatically — no configuration required.

### Event Types

| Event | Source | What It Captures |
|-------|--------|-----------------|
| `message` | `AssistantMessage` | `tokens` (input, output, reasoning, cache.read, cache.write), `cost`, `modelID`, `providerID`, response time |
| `tool` | `ToolPart` | Tool name, status (pending/running/completed/error), duration |
| `rag.context` | `chat.message` hook | `ragChunkCount`, `ragContextTokens`, `ragTopScore`, `ragRetrievalTimeMs` |
| `step` | `StepFinishPart` | `stepTokens`, `stepCost`, `stepReason` |
| `session.created` | `Session` | `sessionTitle` |
| `session.status` | `Session` | Status (idle/busy/retry) |

### Storage

Events are appended to JSONL files at `${storePath}/eval-sessions/${sessionID}.jsonl`. Each line is a JSON object conforming to the `SessionEvent` type.

### TokenUsage Interface

```typescript
interface TokenUsage {
  input: number;       // Input tokens (prompt + history)
  output: number;      // Output tokens (completion)
  reasoning: number;   // Reasoning/thinking tokens
  cache: {
    read: number;      // Tokens read from cache
    write: number;     // Tokens written to cache
  };
}
```

### Scope of Token Tracking

Session evaluation tracks tokens used during OpenCode agent sessions (prompt + completion + reasoning + cache). It does **not** include:

- Tokens used by the embedding provider during indexing
- Tokens used by the description model during indexing
- Tokens used by the vision provider to describe images during indexing

To monitor indexing-time costs, check your provider's dashboard or logs.

See [Plugin Integration](plugin.md) for how the logger hooks into OpenCode.

## CLI Commands

### `eval:sessions`

List all logged evaluation sessions.

```bash
opencode-rag eval:sessions
```

**Output:**
```
  ID                          Queries  Input Tok  RAG Ctx   Cost
  ────────────────────────────────────────────────────────────────
  abc123                      12       45230      8420      $0.0090
  def456                      8        31200      0         $0.0062
```

### `eval:analyze <sessionID>`

Detailed per-session token breakdown with RAG impact projection.

```bash
opencode-rag eval:analyze abc123
```

**Output sections:**
- Query count, total input/output/reasoning tokens, cache stats, cost
- RAG impact: context injected, system guidance overhead, read/RAG tool calls
- Projection: estimated tokens with vs without RAG, net savings
- Per-query breakdown: input tokens, RAG context, reads, RAG tools, top score

### `eval:compare <sessionA> <sessionB>`

Side-by-side comparison of two sessions (e.g. RAG-on vs RAG-off).

```bash
opencode-rag eval:compare abc123 def456
```

Produces a formatted table comparing all metrics with deltas and percentage changes.

## Web UI Evaluate Tab

The Web UI provides the same data in a browser interface with interactive token analysis:

- **Session list** with columns for messages, input tokens, cost, RAG calls, RAG tokens
- **Session detail** with KPI cards, tool call breakdown, event timeline, and **token analysis** (savings projection, per-query breakdown with RAG context/chunk/score)
- **Comparison view** — select 2 sessions for side-by-side comparison with **verdict banner** and enhanced delta table
- **What-If Projection** — interactive sliders to project token savings for different chunk sizes, reads, and query counts

All token analysis features use the `analyzeTokenUsage()` and `compareTokenAnalyses()` functions from `src/eval/token-analysis.ts`.

See [Web UI documentation](webui.md) for details.

## Token Analysis Explained

### How `analyzeTokenUsage()` Works

1. Reads all events from the session's JSONL file
2. Groups events by `messageID` (each assistant response is one message)
3. For each message, computes:
   - Input/output/reasoning tokens from the LLM response
   - RAG context tokens injected before the response
   - Read tool calls (file reads) and RAG tool calls (search_semantic, etc.)
   - Response time
4. Aggregates totals across the session

### RAG Savings Projection

The savings estimate uses these constants:

| Constant | Value | Source |
|----------|-------|--------|
| `AVG_READ_TOOL_TOKENS` | 1,200 | Typical file read response size |
| `AVG_SEARCH_TOOL_TOKENS` | 800 | Typical search_semantic response size |
| `SYSTEM_GUIDANCE_TOKENS` | 150 | System prompt tool list per message |

**Without RAG:** The agent makes ~2-3 extra `read` calls per query to find relevant code (~2,400-3,600 tokens per query).

**With RAG:** Context is injected upfront (fewer reads), but there's injection overhead + system guidance.

**Net savings** = (saved read tokens) - (injected context tokens + system guidance tokens)

### What the Estimates Mean

The projection is a **rough model** of agent behavior, not an exact measurement. Actual savings depend on:
- Query complexity and specificity
- Codebase size and structure
- Agent model (some models read fewer files, some read more)
- RAG quality (high-score hits reduce need for follow-up reads)

## Token Counting Accuracy

### The Problem

A naive `ceil(text.length / 4)` heuristic (4 characters ≈ 1 token) is inaccurate for code:
- Code tokenizes differently than prose (identifiers, operators, keywords)
- Different models have different tokenizers
- The same text can be 20-40% more or fewer tokens than the heuristic predicts

### Current Approach

OpenCodeRAG uses **tiktoken** (cl100k_base encoding) for token counting:

```typescript
// src/eval/token-counter.ts
import { getEncoding } from "js-tiktoken";
const encoder = getEncoding("cl100k_base");
const tokenCount = encoder.encode(text).length;
```

**cl100k_base** is the BPE encoding used by GPT-4, GPT-4o, and Claude. It's the closest universal approximation for most LLMs.

### Per-Chunk Counting

At injection time, RAG context tokens are counted **per chunk** rather than on the assembled string:

```
tokens = 0
for each chunk:
  tokens += countTokens(chunk.content)
  tokens += countTokens(chunk.description)
  tokens += 12  // formatting overhead (file path, line range, score, backticks)
tokens += 30    // header overhead
```

This provides granular attribution: you know which chunks cost how many tokens.

### Method Detection

The `tokenizerMethod()` function reports whether tiktoken is active or the fallback heuristic is in use:

```typescript
import { tokenizerMethod } from "./eval/token-counter.js";
console.log(tokenizerMethod()); // "tiktoken" or "heuristic"
```

The benchmark report includes this information.

### Known Limitations

| Limitation | Impact | Mitigation |
|-----------|--------|-----------|
| tiktoken is OpenAI's tokenizer | Ollama/Cohere models may tokenize differently | ~10-20% variance typical; direction depends on model |
| CJS module in ESM project | Requires dynamic import | Lazy-loaded, cached after first use |
| System guidance counted separately | Not included in `ragContextTokens` | Tracked in `systemGuidanceTokens` during analysis |

### Future Improvements

| Approach | Description | Benefit |
|----------|-------------|---------|
| Provider-specific tokenizers | Use Ollama's token count API or Cohere's tokenizer | Exact counts per model |
| Input token delta tracking | Track `tokens.input` growth between consecutive messages | Isolate RAG contribution exactly from LLM's own count |
| Tool result token logging | Log tokens for each tool call result separately | Understand tool overhead precisely |

## Running the Benchmark

```bash
node --import tsx src/eval/run-token-test.ts
```

### What It Measures

1. **Retrieval quality** — For 10 benchmark queries, runs the real retrieval pipeline and records top relevance scores
2. **Threshold analysis** — Tests minScore thresholds (0.85, 0.75, 0.65, 0.50) to find which ones trigger injection
3. **Token overhead** — Counts exact token cost of injected context at each threshold
4. **Savings projection** — Estimates net savings at each threshold level

### Output

- **Console** — Real-time progress and summary table
- **`doc/eval-token-report.md`** — Full formatted report with:
  - Configuration summary
  - Threshold analysis table
  - Per-query results with relevance scores
  - Token breakdown (with/without RAG)
  - Verdict and cost impact

### Benchmark Queries

1. "How does the retrieval pipeline work end-to-end?"
2. "How does the plugin auto-inject context into messages?"
3. "How does the keyword index combine with vector search?"
4. "Where is the embedder factory defined?"
5. "Where is the LanceDB store implementation?"
6. "Find all usages of the retrieve function"
7. "Find all usages of SearchResult type"
8. "How does the chunker factory register new languages?"
9. "What is the default minScore configuration?"
10. "How does the session logger capture token usage?"

## Interpreting the Report

### Threshold Analysis

| minScore | Meaning |
|----------|---------|
| 0.85 | Conservative — only very high-confidence matches injected |
| 0.75 | Moderate — most relevant code gets injected |
| 0.65 | Aggressive — broader injection, more coverage |
| 0.50 | Maximum — all retrieval results injected |

Scores are on a [0, 1] scale where 1.0 = perfect (rank 0 in both vector and keyword signals) and 0.6 = vector-only at rank 0. Larger models (e.g., `bge-m3` at 1024d) produce tighter score clusters and work well at 0.85. Smaller models (e.g., `qwen3-embedding:0.6b` at 4096d) may need 0.65.

### Verdict

- **"RAG SAVES tokens"** — The injected context costs less than the file reads it prevents
- **"RAG COSTS tokens"** — The injection overhead exceeds the savings from fewer reads

Even when RAG costs tokens, it provides **qualitative benefits**:
- Better grounding (fewer hallucinations)
- More targeted answers
- Edit safety (find_usages before editing)

### Cost Impact

At typical API rates ($2-15/1M input tokens), even a few thousand tokens of overhead per session is negligible. Focus on the **accuracy and quality** benefits of RAG, not just token savings.

See [Configuration documentation](configuration.md) for all options.
