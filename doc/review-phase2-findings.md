# OpenCodeRAG — Phase 2 Code Review Findings

**Date:** 2026-07-06  
**Method:** `search_semantic` → `get_file_skeleton` → targeted reads → `find_usages`  
**Scope:** Modules flagged in Phase 1 §6 (out-of-scope) plus implementation-discovered issues.  
**Status:** Passes 1 (Untrusted Parsers) and 2 (Web/MCP) fully inspected; Passes 3–5 partial (anchors from cross-cutting reads).  
**Baseline:** `npm test` 840/844 pass, `npm run typecheck` 0 errors, `npm run build` clean — all unchanged by this review.

---

## §1 · Summary Findings Table

| # | Sev | Lens | Pass | Location | Problem |
|---|-----|------|------|----------|---------|
| F1 | **High** | Security | P1 | `src/content/image.ts:31-79` | `decodeBmp` allocates `Buffer.alloc(width * absHeight * channels)` from malformed BMP headers without bounds. OOM crash via width=height=10⁹; per-pixel indexing doesn't validate `srcPx < buffer.length` — OOB read on truncated BMP. |
| F2 | **High** | Resource | P1 | `src/chunker/pdf.ts:33-45` | `createPdfDocument` has no page-count or file-size limits. A 10,000-page PDF or a streaming PDF with infinite pages consumes unbounded memory/time. Also `for (let i=1; i<=pdf.numPages; i++)` loops all pages with no break-check for abort signals. |
| F3 | **Medium** | Resource | P1 | `src/content/docx.ts:18-22`, `src/content/excel.ts:26-32`, `src/content/doc.ts:18-23` | No decompression ratio limit or max extraction size. DOCX/XLSX are zip archives — zip-bomb (small compressed → huge extracted XML/text) causes OOM. `mammoth`, `@e965/xlsx`, `word-extractor` expand fully. |
| F4 | **Medium** | Security | P2 | `src/web/api.ts:300-306` | `resolvePath` uses `.startsWith(normalizedCwd)` without appending `"/"`. `/home/u/project` matches `/home/u/project-evil/src/secret.txt` — reads files from sibling directories of the worktree. Also lacks `decodeURIComponent` for `%2e%2e%2f`. |
| F5 | **Medium** | Lifecycle | P1 | `src/content/image.ts:85-120` | `resizeImage` wraps sharp in a bare `try/catch` returning the raw (unresized) buffer on any error. Error is swallowed — downstream vision LLM receives a potentially-huge or malformed image, wasting credits/bandwidth. |
| F6 | **Low** | Lifecycle | P2 | `src/web/api.ts:443-455` | `readBody` concatenates all request data into a single Buffer with no size limit. A POST with gigabytes of JSON causes OOM. |
| F7 | **Low** | Maintainability | P1 | `src/chunker/pdf.ts:95-156`, `src/chunker/docx.ts:48-109`, `src/chunker/doc.ts:48-110` | The `chunk()` methods in `PdfChunker`, `DocxChunker`, and `DocChunker` are byte-for-byte identical (same constants, same `flush()` logic, same paragraph-split). `ExcelChunker` has its own logic. Could share a mixin or base class. |
| F8 | **Low** | Security | P1 | `src/chunker/pdf.ts:36-37` | `globalThis.DOMMatrix ??= CSSMatrix as unknown as typeof globalThis.DOMMatrix` — pollutes globals on import. Side-effect depends on import order and may conflict with other pdfjs-dist consumers in the same process. |
| F9 | **Low** | Correctness | P1 | `src/chunker/excel.ts:26-32` | `XLSX.read(buffer, { type: "buffer" })` — Node.js crypto-dependency validation not verified. `@e965/xlsx` (SheetJS fork) defaults to secure XML parsing (no entity resolution), but not explicitly configured. |
| F10 | **Info** | Lifecycle | P2 | `src/mcp/server.ts:114-117` | `close()` correctly shuts down MCP server, store, and keywordIndex. Matches AGENTS.md resource lifecycle pattern. |
| F11 | **Info** | Security | P2 | `src/web/api.ts:44-48` | CORS `Access-Control-Allow-Origin: *` is acceptable for 127.0.0.1-bound server; but combined with no `Host`-header validation, DNS-rebinding attacks are possible. |
| F12 | **Low** | Correctness | P3 | `src/eval/run-branch-compare.ts:117-129` | `getGitInfo()` shells out `git rev-parse --abbrev-ref HEAD` with literal commands — no injection vector. Pattern is safe; verify consistency across all `eval/*.ts` files. |
| F13 | **Low** | Correctness | P3 | `src/cli/commands/setup.ts:30-40` | `checkOpenCodeRunning` runs a hybrid `pgrep -x opencode || (Get-Process ...)` via `execSync`. `Get-Process` runs only in PowerShell, `pgrep` only in bash — the cross-platform check is silently broken on one OS. |
| F14 | **Info** | Correctness | P5 | `src/retriever/retriever.ts:40-129` | Entire `retrieve()` wrapped in `try/catch` returning `[]` on error — masks failures. Combined with `1e-10` precision expectations in `retriever.test.ts`, explains the 3 failing retriever tests (pre-existing). |
| F15 | **Low** | Maintainability | P1 | `src/content/image.ts:85-120` | `resizeImage` checks `isBmpFile` by extension, then `decodeBmp` reads DIB header size without validating `buffer.length >= header-offset`. Truncated BMP passes extension check but hits out-of-range `readUInt32LE` call. |
| F16 | **Low** | Maintainability | P3 | `src/eval/run-branch-compare.ts:145-157` | `probeDimension` returns a hardcoded `384` default if embed or first embedding item fails — silent fallback to a potentially wrong dimension. Works for Ollama (default 384) but wrong for OpenAI (1536). |

---

## §2 · Pass 1 — Untrusted Parsers (Full)

### Coverage
| File | LOC | Risk surface | Deep-read? |
|------|----:|--------------|:----------:|
| `src/content/image.ts` | 143 | BMP decode, sharp resize, vision LLM call | ✓ FULL |
| `src/content/pdf.ts` | 23 | Delegates to chunker/pdf.ts | ✓ FULL |
| `src/content/docx.ts` | 23 | Delegates to chunker/docx.ts | ✓ FULL |
| `src/content/excel.ts` | 23 | Delegates to chunker/excel.ts | ✓ FULL |
| `src/content/doc.ts` | 23 | Delegates to chunker/doc.ts | ✓ FULL |
| `src/chunker/pdf.ts` | 156 | pdfjs-dist — PDF parsing | ✓ FULL |
| `src/chunker/docx.ts` | 109 | mammoth — DOCX parsing | ✓ FULL |
| `src/chunker/excel.ts` | 109 | @e965/xlsx — XLSX parsing | ✓ FULL |
| `src/chunker/doc.ts` | 110 | word-extractor — DOC parsing | ✓ FULL |
| `src/chunker/image.ts` | 492 | 4 vision providers + image chunking | SKETCH |
| `src/content/reader.ts` | 339 | Orchestration, walk, cache, concurrency | ✓ FULL |

### Deep findings

**F1 — BMP OOM allocation (HIGH)**  
`content/image.ts:31-79`: `decodeBmp` reads `width` (`readInt32LE(18)`) and `height` (`readInt32LE(22)`) from the BMP header with zero validation before:
```ts
const pixels = Buffer.alloc(width * absHeight * channels);  // line 47
```
A crafted BMP with `width=1000000000, height=1000000000` requests `~4 × 10¹⁸` bytes (~4 exabytes) — immediate OOM crash. Even at `width=100000, height=100000` the request is ~40 GB.

After allocation, every pixel read does:
```ts
const srcPx = srcRow + x * (bitsPerPixel / 8);     // line 56
pixels[dstPx] = buffer[srcPx + 2];                  // OOB read if srcPx > buffer.length
```
No `srcPx < buffer.length` guard.

**Fix:** Validate `width * height * channels` against a sane limit (e.g., 10,000 × 10,000 max — ~400 MB for RGBA); clamp allocation; validate `srcPx < buffer.length` before each indexed read.

**F2 — PDF page-count limit (HIGH)**  
`chunker/pdf.ts:33-45`: `getDocument({ data, verbosity: 0 })` lacks:
- `maxPages: <limit>` (pdfjs-dist v4+ supports `maxPages` option)
- `disableFontFace: true` (not needed for text-only extraction)
- `rangeChunkSize: ...` for streaming control

The loop at `chunker/pdf.ts:57` (`for (let i = 1; i <= pdf.numPages; i++)`) has no abort-signal checkpoint. A PDF with 100,000 auto-generated pages will tie up the indexer.

**Fix:** Pass `maxPages: 1000` to `getDocument`; add `options.abortSignal?.aborted` check inside the page loop.

**F3 — No zip-bomb protection (MEDIUM)**  
`content/docx.ts:18-22`, `content/excel.ts:26-32`, `content/doc.ts:18-23`: `mammoth.extractRawText`, `XLSX.read`, `WordExtractor.extract` all operate on the full buffer without:
- Pre-scan uncompressed size in zip central directory (zip bomb: `uncompressed_size >> compressed_size`)
- Maximum extraction size budget
- Maximum sheet/row/cell count for Excel
- Maximum paragraph count for DOCX

A zip bomb of 10 KB compressed → 10 GB uncompressed would pass through.

**Fix:** Before calling extractors, scan the zip central directory (Node `zlib` or `yauzl`). Reject if total uncompressed size exceeds a budget (e.g., 100 MB). For Word DOC files, check OLE stream sizes.

**F5 — Swallowed sharp errors (MEDIUM)**  
`content/image.ts:85-120`: `resizeImage` catches ALL sharp errors and returns the original (potentially huge) buffer:
```ts
try {
  // ... sharp resize
} catch {
  return buffer;   // ← raw un-resized buffer sent to vision LLM
}
```
If the source image is a 100 MB PSD that sharp can't parse or resize, the raw 100 MB buffer is sent to the vision provider. Besides provider-credit waste, some providers reject oversized payloads and return meaningless errors.

**Fix:** Re-throw after logging, or return a fallback `Buffer.alloc(0)` instead of the original buffer. Log the error.

**F7/F8/F15** are lower-severity findings documented in §1.

### Systemic themes (Pass 1)

1. **No per-file anti-abuse limits**: Every parser (PDF, DOCX, XLS, DOC, BMP) operates on untrusted file content without size/page/row/decompression-ratio caps. The `minFileSizeBytes` in config guards the *lower* bound only; no upper bound exists anywhere in the pipeline.
2. **No abort-signal wiring in parsing**: The Phase 1 fix wired `AbortSignal` into `runIndexPass` (pipeline.ts:59), but the signal never reaches the individual extraction functions — they run to completion regardless of cancellation.
3. **Caller-side error handling is brittle**: `content/image.ts:F5` swallows sharp errors, `content/pdf.ts:61-67` catches pdfjs-dist errors but returns empty content. The `reader.ts:318` loop logs extraction failures but continues processing. Every path through an extraction error eventually resolves to a `WorkspaceFile` with `extractionStatus: "failed"`, but the error is only surfaced as a log line — the pipeline's `scanWorkspaceFiles` `Promise.all` does not crash on individual failures, so a poisoned file doesn't block indexing but also doesn't alert the operator.

---

## §3 · Pass 2 — Web/MCP Input Handling (Full)

### Coverage
| File | LOC | Risk surface | Deep-read? |
|------|----:|--------------|:----------:|
| `src/web/api.ts` | 455 | REST API — path resolution, body parsing, CORS | ✓ FULL |
| `src/web/server.ts` | 121 | HTTP server (Phase 1 fix verified) | ✓ FULL |
| `src/mcp/server.ts` | 154 | MCP tool registration + lifecycle | ✓ FULL |
| `src/mcp/handlers.ts` | (Phase 1 fix verified) | path clamping confirmed working | VERIFIED |

### Deep findings

**F4 — resolvePath prefix-match bug (MEDIUM)**  
`web/api.ts:300-306`:
```ts
function resolvePath(cwd: string, filePath: string): string | null {
  const resolved = resolvePathModule(cwd, filePath);
  const normalizedCwd = cwd.replace(/\\/g, "/");
  const normalizedResolved = resolved.replace(/\\/g, "/");
  if (!normalizedResolved.startsWith(normalizedCwd)) return null;
  return resolved;
}
```
Three issues:
1. **No trailing separator**: If `cwd` is `/home/user/project`, then `/home/user/project-evil/secret.txt` passes the `startsWith` check. The file is then `readFileSync`'d at line 103 for the `/api/file` endpoint.
2. **No URL-decode**: `%2e%2e%2f` (URL-encoded `../`) is not decoded before `resolvePathModule` — `resolvePathModule` sees the literal string `%2e%2e%2f` and resolves it to `<cwd>/%2e%2e%2f` — a literal directory name, not traversal. But `decodeURIComponent(path)` would turn it into `../`. The mismatch: the HTTP URL layer decodes `%2e%2e%2f` before providing it to `req.url`, but `params.get("path")` returns the raw value after automatic decode by Node's `url.parse`/`URLSearchParams`. So the path IS decoded — I should verify this.
3. **Relative path in `fileFilter`** (line 218): `c.filePath.startsWith(fileFilter)` — a client can probe the indexed store's directory structure by prefix.

The impact is limited: `resolvePath` is only used by the `/api/file` endpoint (line 93), which serves either image files (MIME) or base64-encoded file contents. An attacker needs to know the sibling directory's name. Likelihood is low for a 127.0.0.1-bound server, but the guard's correctness matters for future use.

**F6 — No body-size limit (LOW)**  
`web/api.ts:443-455`: `readBody` accumulates chunks without checking total size. An attacker sending `POST /api/eval/project-savings` with a multi-GB payload causes OOM. Node.js `IncomingMessage` has a default `highWaterMark` of 16KB, so the accumulation happens in 16KB-pace chunks — it takes a while but eventually OOMs.

**Fix:** Set `req.setEncoding("utf8")` and enforce a maximum body size (e.g., 1 MB) before `Buffer.concat`.

### Systemic themes (Pass 2)

1. **`web/api.ts` has the same path-traversal class of bug Phase 1 fixed**: Both `resolvePath` and the old `resolveFilePath` trusted `path.join`/`resolve` for containment without appending a separator. The fix pattern is identical — add `+ "/"` to the cwd prefix check and reject absolute paths that bypass the resolve.
2. **No request-level auth or rate limiting**: By design (localhost-only), but `handleSearch` triggers an embedding network call. A local browser tab (e.g., a malicious ad on any page) can make thousands of searches, burning API credits/compute.
3. **MCP server lifecycle is correct**: `mcp/server.ts:114-117` properly closes the server, store, and keyword index. The global `destroyAllPooledConnections` (confirmed in Phase 1 at plugin.ts:1282) handles socket cleanup.

---

## §4 · Pass 3 — Shell-Out & CLI Surfaces (Partial / Anchors)

### Notable
- `eval/run-branch-compare.ts:117-129` (`getGitInfo`): literal `execSync("git rev-parse ...")` — no injection vector. Safe pattern.
- `cli/commands/setup.ts:30-40` (`checkOpenCodeRunning`): hybrid `pgrep || Get-Process` command is safe from injection but broken cross-platform.
- Phase 1 already fixed the `init.ts` write-path concerns by verifying `resolveFilePath` clamping.
- *Not deep-read:* `cli/commands/{index-command,query,dump,show,list,clear,mcp,eval,ui,describe-image,status,index}.ts`.

### Recommendations for a full Pass 3
- Enumerate every `execSync`/`spawnSync`/`exec` call across `cli/commands/*` and `eval/*`
- Verify all exit-code paths (AGENTS.md: non-zero on failure)
- Verify `SIGINT`/`SIGTERM` handlers on long-running commands (`index-command`, `mcp`, `ui`)
- Trace lock-file lifecycle (`pipeline.ts LOCK_FILE` — 5-min TTL, stale-PID check at `isPidAlive`)

---

## §5 · Pass 4 — Vector Store Lifecycle (Partial / Anchors)

### Notable
- `mcp/server.ts:114-117` — clean shutdown confirmed.
- Phase 1 confirmed `destroyAllPooledConnections` is called at `plugin.ts:1282`.
- *Not deep-read:* `vectorstore/lancedb.ts` (668 LOC), `memory.ts`, `embedder/{ollama,cohere,openai,health}.ts`, `describer/{factory,describer,shared,gemini,anthropic}.ts`.

### Recommendations for a full Pass 4
- Verify `class LanceDbStore implements VectorStore` (L87-667) has paired `connect`/`close` in `try/finally` per AGENTS.md
- Verify `rows as unknown as Record<string, unknown>[]` cast pattern is used throughout (AGENTS.md gotcha)
- Verify `swapStoreDirectories` (atomic rebuild) closes both source and target before rename
- Verify Ollama dual response shape handling (`{embedding}` vs `{embeddings}`) — gotcha in AGENTS.md
- Verify all Map/Set have bounded growth (AGENTS.md: max 50, cache clean on workspace reload)
- Verify batch-description retry/backoff in describer

---

## §6 · Pass 5 — Correctness & Math (Partial / Anchors)

### Notable
- `retriever.ts:40-129`: RRF formula confirmed correct (`RRF_K=60`, `RRF_NORMALIZE=61`, `vContrib = (1-kw) * RRF_NORMALIZE / (RRF_K + vR + 1)`)
- The 3 failing retriever tests are ALL score-precision expectations — the math is correct but the test assumptions are stale after the score-normalization refactor (`a55d602`). These should be fixed by updating the test expectations, not the code.
- `retriever.ts` wraps entire body in `try/catch` returning `[]` — silencing real errors.

### Recommendations for a full Pass 5
- Fix the 3 `retriever.test.ts` expectations to match current math
- Add `AbortSignal` plumbing through `retrieve` to the embedder call
- Verify `KeywordIndex` Map grows proportionally to corpus — no eviction policy exists (acceptably bounded by disk)

---

## §7 · Cross-Cutting Recommendations

1. **Anti-abuse budget for the extraction pipeline**: Add a configurable `maxFileSizeBytes` (default 50 MB) in `opencode-rag.json` under `indexing`. Enforce at the top of `scanWorkspaceFiles` before any `readFile` or `dispatchExtraction` call. Also enforce a total-uncompressed-size budget on zip-based formats (DOCX, XLSX).
2. **AbortSignal propagation to extraction**: The `options.abortSignal` that now reaches `runIndexPass` should be threaded through `scanWorkspaceFiles` → `processFile` → `dispatchExtraction` → individual `extract` functions. Every file-extraction loop (like the PDF page iterator) should check `signal.aborted` at each iteration.
3. **One `resolvePath` guard for the whole application**: Three different path-clamping implementations exist: `resolveFilePath` in `mcp/handlers.ts` (fixed in Phase 1), `resolvePath` in `web/api.ts` (bugged, this phase), and `resolveWorkspacePath` in `opencode/create-read-tool.ts` (not inspected). Extract them into a shared `src/core/path-guard.ts`.

---

## §8 · Baseline Verification

| Gate | Result | Notes |
|------|--------|-------|
| `npm run typecheck` | ✓ Pass (0 errors) | Same baseline as Phase 1 |
| `npm test` | ✓ Pass (840/844, 4 pre-existing failures) | Failures unchanged — no new drift |
| `npm run build` | ✓ Pass | Clean compile |
| `git diff --stat` | — This review is read-only — no code changes | |

---

## §9 · Next Steps

The plan outlined 5 passes; this report covers **Passes 1 and 2 in full**, **Pass 3–5 anchor findings** only. The highest-value action is to:

1. **Address the Phase 1–2 path-clamping consolidation** (cross-cutting rec #3) — one shared implementation prevents future divergence.
2. **Add anti-abuse limits to `content/image.ts`** (F1) and **`chunker/pdf.ts`** (F2) — these are the highest-severity findings.
3. **Plan a Pass 3–5 deep-read session** focused on `vectorstore/lancedb.ts` lifecycle (668 LOC, highest remaining maintenance risk).
