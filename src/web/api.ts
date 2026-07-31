/**
 * @fileoverview REST API handler for the OpenCodeRAG Web UI with search, file, chunk, eval, and token analysis endpoints.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join, resolve as resolvePathModule } from "node:path";
import { createHash } from "node:crypto";
import { LanceDbStore } from "../vectorstore/lancedb.js";
import { KeywordIndex } from "../retriever/keyword-index.js";
import { listSessions, getSession, deleteSession, compareSessions, validateSessionID } from "../eval/storage.js";
import { analyzeTokenUsage, compareTokenAnalyses, projectTokenSavings } from "../eval/token-analysis.js";
import { listQuirks, lintQuirks, removeQuirk, type QuirkStoreDeps } from "../quirks/quirk-store.js";
import { retrieve, type RetrieveOptions } from "../retriever/retriever.js";
import type { RagConfig } from "../core/config.js";
import { CODE_SEARCH_FILTER, type EmbeddingProvider } from "../core/interfaces.js";

const FILE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

/** No-op embedder used by quirk endpoints that never need to embed text in the read-only UI context. */
const stubEmbedder: EmbeddingProvider = {
  name: "stub",
  embed: async () => {
    throw new Error("Embedder is not available in the Web UI context");
  },
};

/** Internal shape for a JSON API response: an HTTP status code and a serialisable body. */
interface ApiResponse {
  status: number;
  body: unknown;
}

/** Split a raw URL into its pathname and parsed query-string parameters. */
function parseQuery(url: string): { path: string; params: URLSearchParams } {
  const [path, queryString] = url.split("?");
  return {
    path: path ?? "/",
    params: new URLSearchParams(queryString ?? ""),
  };
}

/** Serialise an {@link ApiResponse} as JSON and write it to the HTTP response with CORS headers. */
function sendJson(res: ServerResponse, response: ApiResponse): void {
  res.writeHead(response.status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(response.body));
}

/**
 * Create the main HTTP request handler for the REST API.
 *
 * Routes incoming requests to the appropriate handler based on the URL path:
 * - `/api/stats`, `/api/files`, `/api/chunks`, `/api/chunks/:id`
 * - `/api/search`, `/api/compare`
 * - `/api/file` – serve file content (images / base64)
 * - `/api/eval/sessions`, `/api/eval/sessions/:id`, `/api/eval/compare`
 * - `/api/eval/sessions/:id/analysis`, `/api/eval/token-compare`, `/api/eval/project-savings`
 *
 * @param store       - The LanceDB vector store instance.
 * @param keywordIndex - The keyword-index instance for text search.
 * @param storePath    - Filesystem path to the store directory (used by eval endpoints).
 * @param cwd          - Optional workspace root for resolving file paths.
 * @param cfg          - Active RAG configuration (used by quirk endpoints).
 * @returns An async handler that returns `true` when a route matched or `false` otherwise.
 */
export function createApiHandler(
  store: LanceDbStore,
  keywordIndex: KeywordIndex,
  storePath: string,
  cwd?: string,
  cfg?: RagConfig,
  getEmbedder?: () => Promise<EmbeddingProvider>
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    const { path, params } = parseQuery(url);

    // Quirk store dependencies (embedder is a no-op stub for the read-only UI context).
    const quirkDeps: QuirkStoreDeps = {
      embedder: stubEmbedder,
      store,
      keywordIndex,
      cfg: cfg ?? ({} as RagConfig),
      storePath,
    };

    // CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return true;
    }

    let response: ApiResponse;

    try {
      // Existing endpoints
      if (path === "/api/stats") {
        response = await handleStats(store);
      } else if (path === "/api/files") {
        response = await handleFiles(store);
      } else if (path === "/api/chunks" && !path.includes("/api/chunks/")) {
        response = await handleChunks(store, params);
      } else if (path.startsWith("/api/chunks/")) {
        const id = path.slice("/api/chunks/".length);
        response = await handleChunkById(store, id);
      } else if (path === "/api/search") {
        response = await handleSearch(keywordIndex, params);
      } else if (path === "/api/compare") {
        response = await handleCompare(store, params);
      } else if (path === "/api/retrieve") {
        response = await handleRetrieve(store, keywordIndex, getEmbedder, cfg!, params);
      } else if (path === "/api/indexing/status") {
        response = await handleIndexingStatus(storePath, cwd);
      } else if (path === "/api/indexing/reindex" && method === "POST") {
        response = await handleReindex(cwd!, cfg!, storePath, store, getEmbedder);
      } else if (path === "/api/config") {
        response = await handleConfig(cfg!);
      } else if (path === "/api/embeddings/projection") {
        response = await handleEmbeddingProjection(store, params);
      }
      // File content endpoint (for serving images)
      else if (path === "/api/file" && method === "GET") {
        if (!cwd) {
          response = { status: 400, body: { error: "Workspace path not configured" } };
        } else {
          const filePath = params.get("path");
          if (!filePath) {
            response = { status: 400, body: { error: "Missing 'path' query parameter" } };
          } else {
            const resolved = resolvePath(cwd, filePath);
            if (!resolved) {
              response = { status: 403, body: { error: "Invalid file path" } };
            } else {
              try {
                const raw = readFileSync(resolved);
                const ext = extname(resolved).toLowerCase();
                const mime = FILE_MIME_TYPES[ext] ?? "application/octet-stream";
                if (mime.startsWith("image/")) {
                  res.writeHead(200, { "Content-Type": mime, "Content-Length": raw.length, "Cache-Control": "no-cache" });
                  res.end(raw);
                  return true;
                }
                response = { status: 200, body: { data: raw.toString("base64"), mime } };
              } catch {
                response = { status: 404, body: { error: "File not found" } };
              }
            }
          }
        }
      }
      // Eval endpoints
      else if (path === "/api/eval/sessions" && method === "GET") {
        response = await handleEvalSessions(storePath);
      } else if (path.startsWith("/api/eval/sessions/") && method === "GET") {
        const id = path.slice("/api/eval/sessions/".length);
        response = await handleEvalSession(storePath, id);
      } else if (path.startsWith("/api/eval/sessions/") && method === "DELETE") {
        const id = path.slice("/api/eval/sessions/".length);
        response = await handleEvalDeleteSession(storePath, id);
      }       else if (path === "/api/eval/compare" && method === "GET") {
        response = await handleEvalCompare(storePath, params);
      }
      // Token analysis endpoints
      else if (path.startsWith("/api/eval/sessions/") && path.endsWith("/analysis") && method === "GET") {
        const id = path.slice("/api/eval/sessions/".length, -"/analysis".length);
        response = await handleEvalAnalysis(storePath, id);
      } else if (path === "/api/eval/token-compare" && method === "GET") {
        response = await handleEvalTokenCompare(storePath, params);
      } else if (path === "/api/eval/project-savings" && method === "POST") {
        const body = await readBody(req);
        response = handleEvalProjectSavings(body);
      }
      // Quirk memory endpoints
      else if (path === "/api/quirks" && method === "GET") {
        response = await handleQuirks(quirkDeps);
      } else if (path === "/api/quirks/lint" && method === "GET") {
        response = await handleQuirkLint(quirkDeps);
      } else if (path.startsWith("/api/quirks/") && method === "DELETE") {
        const id = path.slice("/api/quirks/".length);
        if (!id) {
          response = { status: 400, body: { error: "Missing quirk ID" } };
        } else {
          response = await handleQuirkDelete(quirkDeps, id);
        }
      } else {
        return false;
      }

      sendJson(res, response);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, { status: 500, body: { error: message } });
      return true;
    }
  };
}

/** Respond with total chunk/file counts and a breakdown by programming language. */
async function handleStats(store: LanceDbStore): Promise<ApiResponse> {
  const totalChunks = await store.count();
  const files = await store.listFiles();

  const langMap = new Map<string, number>();
  for (const file of files) {
    langMap.set(file.language, (langMap.get(file.language) ?? 0) + file.chunkCount);
  }

  const languages = [...langMap.entries()]
    .map(([language, count]) => ({ language, count }))
    .sort((a, b) => b.count - a.count);

  return {
    status: 200,
    body: {
      totalChunks,
      totalFiles: files.length,
      languages,
    },
  };
}

/** Respond with the list of all indexed files from the store. */
async function handleFiles(store: LanceDbStore): Promise<ApiResponse> {
  const files = await store.listFiles();
  return { status: 200, body: files };
}

// ── Quirk Memory API ─────────────────────────────────────────────────

/** Respond with all stored quirks, sorted by last-observed time (most recent first). */
async function handleQuirks(deps: QuirkStoreDeps): Promise<ApiResponse> {
  const quirks = await listQuirks(deps);
  return { status: 200, body: { quirks } };
}

/** Respond with the health-check issues for the quirk store (confidence, staleness, duplicates). */
async function handleQuirkLint(deps: QuirkStoreDeps): Promise<ApiResponse> {
  const issues = await lintQuirks(deps);
  return { status: 200, body: { issues } };
}

/** Delete a single quirk by its ID from the store, index, and audit log. */
async function handleQuirkDelete(deps: QuirkStoreDeps, id: string): Promise<ApiResponse> {
  try {
    await removeQuirk(deps, id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Quirk not found/.test(message)) {
      return { status: 404, body: { error: message } };
    }
    throw err;
  }
  return { status: 200, body: { deleted: true, id } };
}

/**
 * Respond with a paginated, optionally filtered list of chunks.
 *
 * Query params: `offset` (default 0), `limit` (default 50), `lang`, `file`.
 */
async function handleChunks(
  store: LanceDbStore,
  params: URLSearchParams
): Promise<ApiResponse> {
  const offset = parseInt(params.get("offset") ?? "0", 10);
  const limit = parseInt(params.get("limit") ?? "50", 10);
  const langFilter = params.get("lang");
  const fileFilter = params.get("file");

  const allChunks = await store.getChunks(0, 100000);

  let filtered = allChunks;

  if (langFilter) {
    filtered = filtered.filter((c) => c.language === langFilter);
  }

  if (fileFilter) {
    filtered = filtered.filter((c) => c.filePath.startsWith(fileFilter));
  }

  const total = filtered.length;
  const chunks = filtered.slice(offset, offset + limit);

  return {
    status: 200,
    body: { chunks, total, offset, limit },
  };
}

/** Respond with a single chunk identified by its ID, or 404 if not found. */
async function handleChunkById(
  store: LanceDbStore,
  id: string
): Promise<ApiResponse> {
  const chunks = await store.getChunks(0, 100000);
  const chunk = chunks.find((c) => c.id === id);

  if (!chunk) {
    return { status: 404, body: { error: "Chunk not found" } };
  }

  return { status: 200, body: chunk };
}

/** Run a keyword search against the index and return ranked results. Query param: `q` (query string), `topK` (default 20). */
async function handleSearch(
  keywordIndex: KeywordIndex,
  params: URLSearchParams
): Promise<ApiResponse> {
  const query = params.get("q") ?? "";
  const topK = parseInt(params.get("topK") ?? "20", 10);

  if (!query.trim()) {
    return { status: 200, body: { results: [] } };
  }

  const results = keywordIndex.search(query, topK, CODE_SEARCH_FILTER);

  return {
    status: 200,
    body: {
      results: results.map((r) => ({
        chunk: {
          id: r.chunk.id,
          filePath: r.chunk.metadata.filePath,
          startLine: r.chunk.metadata.startLine,
          endLine: r.chunk.metadata.endLine,
          language: r.chunk.metadata.language,
          content: r.chunk.content,
          description: r.chunk.description,
        },
        score: Math.round(r.score * 1000) / 1000,
      })),
    },
  };
}

/**
 * Perform a full vector+hybrid semantic search via the retrieve() pipeline.
 * Accepts GET or POST with query parameters: q, topK, minScore, keywordWeight, hybrid, path, lang, explain.
 * The embedder is lazily initialized on the first call; returns 202 if still initializing.
 */
async function handleRetrieve(
  store: LanceDbStore,
  keywordIndex: KeywordIndex,
  getEmbedder: (() => Promise<EmbeddingProvider>) | undefined,
  cfg: RagConfig,
  params: URLSearchParams
): Promise<ApiResponse> {
  if (!getEmbedder) {
    return { status: 503, body: { error: "Embedder not configured for this server instance" } };
  }

  const q = params.get("q") ?? "";
  if (!q.trim()) {
    return { status: 400, body: { error: "Missing 'q' query parameter" } };
  }

  let embedder: EmbeddingProvider;
  try {
    embedder = await getEmbedder();
  } catch (err) {
    return { status: 503, body: { error: `Embedding model unavailable: ${(err as Error).message}. Check that your embedding provider is running.` } };
  }

  const topK = parseInt(params.get("topK") ?? "10", 10);
  const minScore = parseFloat(params.get("minScore") ?? "0.35");
  const keywordWeight = parseFloat(params.get("keywordWeight") ?? "0.4");
  const hybrid = params.get("hybrid") !== "false";
  const explain = params.get("explain") !== "false";
  const pathFilter = params.get("path") ?? undefined;
  const langFilter = params.get("lang") ?? undefined;

  try {
    const results = await retrieve(q, embedder, store, {
      topK,
      minScore,
      keywordIndex,
      keywordWeight,
      hybridEnabled: hybrid,
      queryPrefix: cfg.embedding.queryPrefix,
      explain,
      filter: {
        pathPatterns: pathFilter ? pathFilter.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        languages: langFilter ? langFilter.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        kinds: CODE_SEARCH_FILTER.kinds,
      },
    } satisfies RetrieveOptions);

    return {
      status: 200,
      body: {
        query: q,
        params: { topK, minScore, keywordWeight, hybrid, queryPrefix: cfg.embedding.queryPrefix },
        results: results.map((r) => ({
          chunk: {
            id: r.chunk.id,
            filePath: r.chunk.metadata.filePath,
            startLine: r.chunk.metadata.startLine,
            endLine: r.chunk.metadata.endLine,
            language: r.chunk.metadata.language,
            content: r.chunk.content,
            description: r.chunk.description,
          },
          score: Math.round(r.score * 1000) / 1000,
          explanation: r.explanation
            ? {
                scoreBreakdown: {
                  vectorScore: r.explanation.scoreBreakdown.vectorScore,
                  keywordScore: r.explanation.scoreBreakdown.keywordScore,
                  rawVectorScore: r.explanation.scoreBreakdown.rawVectorScore,
                  rawKeywordScore: r.explanation.scoreBreakdown.rawKeywordScore,
                  keywordWeight: r.explanation.scoreBreakdown.keywordWeight,
                  vectorRank: r.explanation.scoreBreakdown.vectorRank,
                  keywordRank: r.explanation.scoreBreakdown.keywordRank,
                },
                matchedTerms: r.explanation.matchedTerms,
              }
            : undefined,
        })),
      },
    };
  } catch (err) {
    return { status: 500, body: { error: `Retrieval failed: ${(err as Error).message}` } };
  }
}

/** Fetch multiple chunks by their comma-separated IDs (`ids` query param) for side-by-side comparison. */
async function handleCompare(
  store: LanceDbStore,
  params: URLSearchParams
): Promise<ApiResponse> {
  const idsParam = params.get("ids") ?? "";
  const ids = idsParam.split(",").filter(Boolean);

  if (ids.length === 0) {
    return { status: 400, body: { error: "No chunk IDs provided" } };
  }

  const allChunks = await store.getChunks(0, 100000);
  const chunks = allChunks.filter((c) =>
    ids.includes((c as unknown as { id?: string }).id ?? "")
  );

  return { status: 200, body: { chunks } };
}

/**
 * Return indexing status — manifest stats, staleness, and a placeholder for watcher state.
 */
async function handleIndexingStatus(storePath: string, cwd?: string): Promise<ApiResponse> {
  const manifestPath = join(storePath, "manifest.json");
  let manifest: Record<string, unknown> | null = null;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch { /* no manifest yet */ }

  let staleFileCount = 0;
  let totalChunks = 0;
  let totalFiles = 0;
  let lastIndexedAt: string | null = null;
  let schemaVersion = manifest?.schemaVersion as number ?? 0;

  if (manifest?.files) {
    const storedFiles = manifest.files as Record<string, { hash: string; chunkCount: number }>;
    totalFiles = Object.keys(storedFiles).length;
    totalChunks = Object.values(storedFiles).reduce((sum, f) => sum + (f.chunkCount ?? 0), 0);
  }

  if (manifest?.lastIndexedAt) {
    lastIndexedAt = new Date(manifest.lastIndexedAt as number).toISOString();
  }

      // Count stale files by comparing manifest file list against current disk state
      if (cwd && manifest?.files) {
        const storedFiles = manifest.files as Record<string, { hash: string }>;
        for (const [filePath, fileMeta] of Object.entries(storedFiles)) {
          try {
            const fullPath = filePath;
            const content = readFileSync(fullPath, "utf-8");
            const hash = createHash("sha256").update(content).digest("hex");
            if (hash !== fileMeta.hash) staleFileCount++;
          } catch {
            staleFileCount++; // file was deleted or unreadable
          }
        }
      }

  return {
    status: 200,
    body: {
      manifest: { totalChunks, totalFiles, schemaVersion, lastIndexedAt },
      staleFileCount,
      watcherActive: false,
    },
  };
}

/**
 * Trigger a one-shot reindex pass in the background.
 */
async function handleReindex(
  cwd: string,
  cfg: import("../core/config.js").RagConfig,
  storePath: string,
  store: LanceDbStore,
  getEmbedder?: () => Promise<EmbeddingProvider>
): Promise<ApiResponse> {
  try {
    const { runIndexPass } = await import("../indexer.js");
    const embedder = getEmbedder ? await getEmbedder() : undefined;
    if (!embedder) {
      return { status: 503, body: { error: "Embedder not available" } };
    }
    runIndexPass({ cwd, storePath, config: cfg, store, embedder }).catch((err: Error) => {
      console.error("Background reindex failed:", err);
    });
    return { status: 200, body: { started: true } };
  } catch (err) {
    return { status: 500, body: { error: `Failed to start reindex: ${(err as Error).message}` } };
  }
}

/**
 * Return the effective configuration with API keys redacted.
 */
function handleConfig(cfg: import("../core/config.js").RagConfig): ApiResponse {
  const redacted = JSON.parse(JSON.stringify(cfg));
  redactKeys(redacted);
  return { status: 200, body: { config: redacted } };
}

function redactKeys(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase().includes("apikey") || key === "apiKey") {
      obj[key] = "***";
    } else if (typeof obj[key] === "object" && obj[key] !== null) {
      redactKeys(obj[key] as Record<string, unknown>);
    }
  }
}

/**
 * Project chunk embeddings to 2D via PCA for the Embedding Space Explorer.
 */
async function handleEmbeddingProjection(store: LanceDbStore, params: URLSearchParams): Promise<ApiResponse> {
  const maxChunks = parseInt(params.get("maxChunks") ?? "5000", 10);
  try {
    const chunks = await store.getChunksWithEmbeddings(maxChunks);
    if (chunks.length === 0) {
      return { status: 200, body: { points: [], totalChunks: 0 } };
    }
    if (chunks.length === 1) {
      return { status: 200, body: { points: [{ id: chunks[0]!.id, x: 0.5, y: 0.5, filePath: chunks[0]!.filePath, startLine: chunks[0]!.startLine, endLine: chunks[0]!.endLine, language: chunks[0]!.language, description: chunks[0]!.description }], totalChunks: 1, displayedChunks: 1 } };
    }

    const { computePCA } = await import("./pca.js");
    const vectors = chunks.map(c => c.embedding);
    const projected = computePCA(vectors);

    const points = chunks.map((c, i) => ({
      id: c.id,
      x: projected[i]!.x,
      y: projected[i]!.y,
      filePath: c.filePath,
      startLine: c.startLine,
      endLine: c.endLine,
      language: c.language,
      description: c.description,
    }));

    return {
      status: 200,
      body: { points, totalChunks: chunks.length, displayedChunks: points.length },
    };
  } catch (err) {
    return { status: 500, body: { error: `Projection failed: ${(err as Error).message}` } };
  }
}

// ── File Content API ──────────────────────────────────────────────────

/** Resolve a user-supplied file path against the workspace root, preventing directory traversal outside `cwd`. Returns `null` when the path escapes the workspace. */
function resolvePath(cwd: string, filePath: string): string | null {
  const resolved = resolvePathModule(cwd, filePath);
  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/$/, "") + "/";
  const normalizedResolved = resolved.replace(/\\/g, "/");
  if (!normalizedResolved.startsWith(normalizedCwd)) return null;
  return resolved;
}

// ── Eval API ──────────────────────────────────────────────────────────

/** List all available evaluation sessions for the given store. */
async function handleEvalSessions(storePath: string): Promise<ApiResponse> {
  const sessions = listSessions(storePath);
  return { status: 200, body: { sessions } };
}

/** Return a single evaluation session by ID. Validates the ID format before lookup. */
async function handleEvalSession(storePath: string, id: string): Promise<ApiResponse> {
  if (!validateSessionID(id)) {
    return { status: 400, body: { error: "Invalid session ID" } };
  }
  const session = getSession(storePath, id);
  if (!session) {
    return { status: 404, body: { error: "Session not found" } };
  }
  return { status: 200, body: session };
}

/** Delete an evaluation session by ID. Validates the ID format before deletion. */
async function handleEvalDeleteSession(storePath: string, id: string): Promise<ApiResponse> {
  if (!validateSessionID(id)) {
    return { status: 400, body: { error: "Invalid session ID" } };
  }
  deleteSession(storePath, id);
  return { status: 200, body: { deleted: true } };
}

/** Compare two evaluation sessions side-by-side. Expects `a` and `b` query params containing session IDs. */
async function handleEvalCompare(storePath: string, params: URLSearchParams): Promise<ApiResponse> {
  const idA = params.get("a") ?? "";
  const idB = params.get("b") ?? "";

  if (!idA || !idB) {
    return { status: 400, body: { error: "Both 'a' and 'b' session IDs are required" } };
  }

  if (!validateSessionID(idA) || !validateSessionID(idB)) {
    return { status: 400, body: { error: "Invalid session ID" } };
  }

  const result = compareSessions(storePath, idA, idB);
  if (!result) {
    return { status: 404, body: { error: "One or both sessions not found" } };
  }

  return { status: 200, body: result };
}

// ── Token Analysis API ────────────────────────────────────────────────

/**
 * Perform token-usage analysis for a single evaluation session.
 *
 * @param storePath - Path to the store directory containing session data.
 * @param id        - Validated evaluation session ID.
 * @returns An {@link ApiResponse} wrapping the analysis result or an error.
 */
export async function handleEvalAnalysis(storePath: string, id: string): Promise<ApiResponse> {
  if (!validateSessionID(id)) {
    return { status: 400, body: { error: "Invalid session ID" } };
  }
  const session = getSession(storePath, id);
  if (!session) {
    return { status: 404, body: { error: "Session not found" } };
  }
  const analysis = analyzeTokenUsage(storePath, id);
  return { status: 200, body: { analysis } };
}

/**
 * Compare token-usage analysis between two evaluation sessions.
 *
 * Expects `a` and `b` query params containing session IDs. Returns analysis
 * for each session together with a comparison object.
 */
export async function handleEvalTokenCompare(storePath: string, params: URLSearchParams): Promise<ApiResponse> {
  const idA = params.get("a") ?? "";
  const idB = params.get("b") ?? "";

  if (!idA || !idB) {
    return { status: 400, body: { error: "Both 'a' and 'b' session IDs are required" } };
  }
  if (!validateSessionID(idA) || !validateSessionID(idB)) {
    return { status: 400, body: { error: "Invalid session ID" } };
  }

  const sessionA = getSession(storePath, idA);
  const sessionB = getSession(storePath, idB);
  if (!sessionA || !sessionB) {
    return { status: 404, body: { error: "One or both sessions not found" } };
  }

  const analysisA = analyzeTokenUsage(storePath, idA);
  const analysisB = analyzeTokenUsage(storePath, idB);
  const comparison = compareTokenAnalyses(analysisA, analysisB);

  return { status: 200, body: { ragOn: analysisA, ragOff: analysisB, comparison } };
}

/**
 * Project token savings for a whole project based on per-query averages.
 *
 * Expects a JSON body with numeric fields:
 * `avgChunkSize`, `avgChunksPerQuery`, `avgReadsPerQueryWithoutRAG`,
 * `avgReadsPerQueryWithRAG`, `queryCount`.
 */
export function handleEvalProjectSavings(body: unknown): ApiResponse {
  if (!body || typeof body !== "object") {
    return { status: 400, body: { error: "Request body required" } };
  }
  const b = body as Record<string, unknown>;
  const avgChunkSize = Number(b.avgChunkSize);
  const avgChunksPerQuery = Number(b.avgChunksPerQuery);
  const avgReadsPerQueryWithoutRAG = Number(b.avgReadsPerQueryWithoutRAG);
  const avgReadsPerQueryWithRAG = Number(b.avgReadsPerQueryWithRAG);
  const queryCount = Number(b.queryCount);

  if ([avgChunkSize, avgChunksPerQuery, avgReadsPerQueryWithoutRAG, avgReadsPerQueryWithRAG, queryCount].some(isNaN)) {
    return { status: 400, body: { error: "All projection parameters must be numbers" } };
  }

  const projection = projectTokenSavings({
    avgChunkSize,
    avgChunksPerQuery,
    avgReadsPerQueryWithoutRAG,
    avgReadsPerQueryWithRAG,
    queryCount,
  });

  return { status: 200, body: { projection } };
}

/** Collect the full request body as a Buffer and parse it as JSON. Returns `{}` on empty or invalid input. */
const MAX_BODY_BYTES = 1_048_576; // 1 MB

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalSize = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    totalSize += buf.length;
    if (totalSize > MAX_BODY_BYTES) {
      req.destroy(new Error("Request body too large"));
      throw new Error(`Request body exceeds ${MAX_BODY_BYTES} byte limit`);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}
