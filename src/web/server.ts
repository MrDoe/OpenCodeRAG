/**
 * @fileoverview HTTP server for the OpenCodeRAG Web UI dashboard with static asset serving and REST API routing.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { LanceDbStore } from "../vectorstore/lancedb.js";
import { KeywordIndex } from "../retriever/keyword-index.js";
import { createApiHandler } from "./api.js";
import { getStaticHtml, resolveDistAsset } from "./static.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiDir = join(__dirname, "ui");

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/** Serve an HTML string as the HTTP response with UTF-8 content type. */
function serveStatic(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(html);
}

/** Read a UI asset file from disk and serve it with the correct MIME type. Falls back to 404 if the file is missing. */
function serveUiAsset(res: ServerResponse, filePath: string): void {
  try {
    const data = readFileSync(filePath);
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    // Vite emits hashed filenames, so assets can be cached aggressively
    const cacheControl = /[.-][a-f0-9]{8,}\./.test(filePath) ? "public, max-age=31536000, immutable" : "no-cache";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
}

/** Describes a running OpenCodeRAG Web UI instance, providing the bound port and a graceful shutdown method. */
export interface WebUiServer {
  /** The port the HTTP server is listening on. */
  port: number;
  /** Random per-run token required on every `/api/*` request (Bearer header or `?token=`). */
  token: string;
  /** Gracefully shut down the HTTP server. */
  close: () => Promise<void>;
}

/**
 * Start the OpenCodeRAG Web UI HTTP server.
 *
 * Creates an embedded HTTP server that serves the static UI at `/` and `/ui/*`, and
 * delegates `/api/*` requests to the REST API handler. The server binds to `127.0.0.1`.
 *
 * @param storePath       - Path to the LanceDB store directory.
 * @param port            - TCP port to listen on.
 * @param cwd             - Optional workspace root used to resolve file paths for the file API.
 * @param vectorDimension - Embedding vector dimension (default 384).
 * @param cfg             - Active RAG configuration (used by quirk endpoints).
 * @returns A {@link WebUiServer} handle for the running server.
 */
export async function startWebUi(
  storePath: string,
  port: number,
  cwd?: string,
  vectorDimension: number = 384,
  cfg?: import("../core/config.js").RagConfig
): Promise<WebUiServer> {
  const store = new LanceDbStore(storePath, vectorDimension);
  const keywordIndex = await KeywordIndex.load(storePath);

  // Lazy embedder for /api/retrieve — initialized on first use
  let embedderPromise: Promise<import("../core/interfaces.js").EmbeddingProvider> | null = null;
  async function getEmbedder(): Promise<import("../core/interfaces.js").EmbeddingProvider> {
    if (!embedderPromise) {
      const { createEmbedder } = await import("../embedder/factory.js");
      embedderPromise = Promise.resolve(createEmbedder(cfg!));
    }
    return embedderPromise;
  }

  const html = getStaticHtml();
  const token = randomBytes(24).toString("hex");
  const apiHandler = createApiHandler(store, keywordIndex, storePath, cwd, cfg, getEmbedder, token);

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = req.url ?? "/";

      if (url === "/" || url === "/index.html") {
        serveStatic(res, html);
        return;
      }

      if (url.startsWith("/ui/")) {
        let decoded: string;
        try {
          decoded = decodeURIComponent(url.slice("/ui/".length));
        } catch {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Bad Request");
          return;
        }
        if (decoded.includes("..") || decoded === "") {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden");
          return;
        }
        // Try production build output first, fall back to dev source
        const distAsset = resolveDistAsset(decoded);
        if (distAsset) {
          serveUiAsset(res, distAsset);
          return;
        }
        const devPath = join(uiDir, decoded);
        if (devPath.startsWith(uiDir + sep) && existsSync(devPath)) {
          serveUiAsset(res, devPath);
          return;
        }
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }

      if (url.startsWith("/api/")) {
        const handled = await apiHandler(req, res);
        if (handled) return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    } catch (err) {
      // Never let a malformed request crash the process
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      } else {
        res.end();
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        port,
        token,
        close: () =>
          new Promise<void>((resolveClose) => {
            // Close idle keep-alive connections so `server.close()` cannot hang
            server.closeAllConnections();
            server.close(() => {
              store.close().catch(() => {});
              keywordIndex.close();
              resolveClose();
            });
          }),
      });
    });
  });
}
