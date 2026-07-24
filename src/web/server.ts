/**
 * @fileoverview HTTP server for the OpenCodeRAG Web UI dashboard with static asset serving and REST API routing.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { LanceDbStore } from "../vectorstore/lancedb.js";
import { KeywordIndex } from "../retriever/keyword-index.js";
import { createApiHandler } from "./api.js";
import { getStaticHtml } from "./static.js";

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
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

/** Read a UI asset file from disk and serve it with the correct MIME type. Falls back to 404 if the file is missing. */
function serveUiAsset(res: ServerResponse, filePath: string): void {
  try {
    const data = readFileSync(filePath);
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
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

  const html = getStaticHtml();
  const apiHandler = createApiHandler(store, keywordIndex, storePath, cwd, cfg);

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";

    if (url === "/" || url === "/index.html") {
      serveStatic(res, html);
      return;
    }

    if (url.startsWith("/ui/")) {
      const decoded = decodeURIComponent(url.slice("/ui/".length));
      if (decoded.includes("..") || decoded === "") {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }
      const assetPath = join(uiDir, decoded);
      if (!assetPath.startsWith(uiDir + sep)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }
      serveUiAsset(res, assetPath);
      return;
    }

    if (url.startsWith("/api/")) {
      const handled = await apiHandler(req, res);
      if (handled) return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        port,
        close: () =>
          new Promise<void>((resolveClose) => {
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
