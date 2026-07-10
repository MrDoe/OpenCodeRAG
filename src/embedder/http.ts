/**
 * @fileoverview Low-level HTTP client with raw TCP/TLS sockets, connection pooling, proxy support, and redirect following.
 */
import net from "node:net";
import tls from "node:tls";
import type { ProxyConfig } from "../core/config.js";

/**
 * Minimal HTTP response interface compatible with the standard `Response` API.
 * Used internally to abstract over raw socket responses and fetch-based responses.
 */
export interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

const MAX_POOL_SIZE = 4;
const IDLE_TIMEOUT_MS = 30000;

/** A socket tracked in the connection pool with its idle-timeout timer. */
interface PooledSocket {
  socket: net.Socket | tls.TLSSocket;
  idleTimer: ReturnType<typeof setTimeout>;
}

const connectionPool = new Map<string, PooledSocket[]>();

// Serialize proxied fetch requests that mutate process.env,
// preventing races when concurrent requests interleave
// set/restore of HTTP_PROXY/HTTPS_PROXY.
let proxyRequestQueue = Promise.resolve<void>(undefined);

function poolKey(host: string, port: number, isHttps: boolean): string {
  return `${isHttps ? "tls" : "tcp"}:${host}:${port}`;
}

function acquireConnection(host: string, port: number, isHttps: boolean): net.Socket | tls.TLSSocket | null {
  const key = poolKey(host, port, isHttps);
  const pool = connectionPool.get(key);
  if (!pool || pool.length === 0) return null;

  const entry = pool.pop()!;
  clearTimeout(entry.idleTimer);
  if (!entry.socket.destroyed && entry.socket.writable) {
    return entry.socket;
  }
  entry.socket.destroy();
  return acquireConnection(host, port, isHttps);
}

function releaseConnection(socket: net.Socket | tls.TLSSocket, host: string, port: number, isHttps: boolean): void {
  if (socket.destroyed || !socket.writable) {
    socket.destroy();
    return;
  }

  const key = poolKey(host, port, isHttps);
  let pool = connectionPool.get(key);
  if (!pool) {
    pool = [];
    connectionPool.set(key, pool);
  }

  if (pool.length >= MAX_POOL_SIZE) {
    socket.destroy();
    return;
  }

  const idleTimer = setTimeout(() => {
    const idx = pool!.findIndex((e) => e.socket === socket);
    if (idx >= 0) pool!.splice(idx, 1);
    socket.destroy();
  }, IDLE_TIMEOUT_MS);

  // Avoid removeAllListeners — that would strip the error handler
  // and cause an unhandled crash on ECONNRESET/TLS alert.
  socket.removeAllListeners("data");
  socket.removeAllListeners("end");
  socket.removeAllListeners("drain");
  socket.removeAllListeners("error");
  socket.on("error", () => socket.destroy());
  pool.push({ socket, idleTimer });
}

/** Destroy all pooled TCP/TLS sockets and clear the connection pool. */
function destroyAllPooledConnections(): void {
  for (const pool of connectionPool.values()) {
    for (const entry of pool) {
      clearTimeout(entry.idleTimer);
      entry.socket.destroy();
    }
  }
  connectionPool.clear();
}

export { destroyAllPooledConnections };

/**
 * Check whether a hostname refers to the local machine.
 *
 * Matches "localhost", "::1", "127.0.0.1", and any 127.x.x.x address.
 *
 * @param hostname - The hostname to check
 * @returns True if the hostname is a loopback address
 */
export function isLocalhost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.")
  );
}

/** Parse a comma-separated NO_PROXY list into individual patterns. */
function parseNoProxyList(noProxy?: string): string[] {
  if (!noProxy) return [];
  return noProxy
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Check whether a hostname should bypass the proxy according to the NO_PROXY list.
 *
 * Supports wildcard `*`, domain-prefix `.example.com`, and exact matches.
 * Localhost addresses always bypass the proxy.
 *
 * @param hostname - The hostname to check
 * @param noProxy - The raw NO_PROXY string (comma-separated)
 * @returns True if this hostname should be connected to directly
 */
export function matchesNoProxy(hostname: string, noProxy?: string): boolean {
  const normalized = hostname.toLowerCase();
  const patterns = parseNoProxyList(noProxy);

  if (isLocalhost(normalized)) return true;

  for (const pattern of patterns) {
    if (pattern === "*") return true;
    if (pattern.startsWith(".") && normalized.endsWith(pattern)) return true;
    if (pattern.startsWith(".") && normalized === pattern.slice(1)) return true;
    if (normalized === pattern) return true;
  }

  return false;
}

/** Build a Basic authorization header value from proxy credentials. */
function buildProxyAuthHeader(proxy?: ProxyConfig): string | undefined {
  if (proxy?.username && proxy?.password) {
    const encoded = Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64");
    return `Basic ${encoded}`;
  }
  return undefined;
}

/** Apply the proxy URL to environment variables if they are not already set. */
function applyProxyEnv(proxy?: ProxyConfig): { httpProxy: string; httpsProxy: string } | null {
  if (!proxy?.url) return null;

  const existingHttp = process.env.HTTP_PROXY || process.env.http_proxy;
  const existingHttps = process.env.HTTPS_PROXY || process.env.https_proxy;

  if (existingHttp && existingHttps) return null;

  return {
    httpProxy: existingHttp || proxy.url,
    httpsProxy: existingHttps || proxy.url,
  };
}

/**
 * Send an HTTP POST request directly via raw TCP/TLS sockets, bypassing any
 * proxy. Follows up to 5 redirects automatically.
 *
 * @param url - The target URL
 * @param body - The JSON-serializable request body
 * @param headers - Additional HTTP headers
 * @param timeoutMs - Request timeout in milliseconds
 * @param redirectCount - Internal redirect counter (starts at 0)
 * @returns A promise resolving to an HttpResponseLike
 */
export function directRequest(
  url: URL,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
  redirectCount: number = 0
): Promise<HttpResponseLike> {
  return sendRawHttpRequest(url, body, headers, timeoutMs, redirectCount);
}

const CRLF = Buffer.from("\r\n");

/** Build the full raw HTTP/1.1 request buffer (headers + JSON body). */
function buildRequestPayload(body: unknown, headers: Record<string, string>, url: URL): Buffer {
  const payload = JSON.stringify(body);
  const requestHeaders: Record<string, string> = {
    Host: url.host,
    Connection: "keep-alive",
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload).toString(),
    ...headers,
  };

  const headerLines = Object.entries(requestHeaders).map(([key, value]) => `${key}: ${value}`);
  const requestText = [
    `POST ${url.pathname}${url.search} HTTP/1.1`,
    ...headerLines,
    "",
    payload,
  ].join("\r\n");

  return Buffer.from(requestText, "utf8");
}

/** Parse HTTP/1.1 response header lines into a key-value map. */
function parseHeaderLines(headerText: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const lines = headerText.split("\r\n");

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[name] = value;
  }

  return headers;
}

/** Decode a chunked transfer-encoded body into a single contiguous buffer. */
function decodeChunkedBody(body: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset < body.length) {
    const sizeLineEnd = body.indexOf(CRLF, offset);
    if (sizeLineEnd < 0) break;

    const sizeLine = body.slice(offset, sizeLineEnd).toString("ascii").split(";", 1)[0]?.trim() ?? "0";
    const size = Number.parseInt(sizeLine, 16);
    offset = sizeLineEnd + CRLF.length;

    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`Invalid chunk size: ${sizeLine}`);
    }

    if (size === 0) {
      break;
    }

    const chunkEnd = offset + size;
    if (chunkEnd > body.length) {
      throw new Error("Incomplete chunked HTTP response");
    }

    chunks.push(body.slice(offset, chunkEnd));
    offset = chunkEnd + CRLF.length;
  }

  return Buffer.concat(chunks);
}

/** Parse a raw HTTP/1.1 response buffer into status code, headers, and body. */
function parseResponse(buffer: Buffer): { status: number; headers: Record<string, string>; body: Buffer } {
  const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"));
  if (headerEnd < 0) {
    throw new Error("Invalid HTTP response: missing header terminator");
  }

  const headerText = buffer.slice(0, headerEnd).toString("utf8");
  const body = buffer.slice(headerEnd + 4);
  const statusLine = headerText.split("\r\n")[0] ?? "";
  const statusMatch = /^HTTP\/\d+\.\d+\s+(\d+)/.exec(statusLine);
  if (!statusMatch) {
    throw new Error(`Invalid HTTP response status line: ${statusLine}`);
  }

  const headers = parseHeaderLines(headerText);
  const status = Number.parseInt(statusMatch[1] ?? "0", 10);

  if (headers["transfer-encoding"]?.toLowerCase().includes("chunked")) {
    return { status, headers, body: decodeChunkedBody(body) };
  }

  const contentLength = Number.parseInt(headers["content-length"] ?? "0", 10);
  if (Number.isFinite(contentLength) && contentLength >= 0) {
    return { status, headers, body: body.slice(0, contentLength) };
  }

  return { status, headers, body };
}

/** Raw HTTP/1.1 POST over TCP/TLS with connection pooling, redirect following, and timeout. */
async function sendRawHttpRequest(
  url: URL,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
  redirectCount: number
): Promise<HttpResponseLike> {
  const requestBuffer = buildRequestPayload(body, headers, url);
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const isHttps = url.protocol === "https:";

  const responseBuffer = await new Promise<Buffer>((resolve, reject) => {
    const pooled = acquireConnection(url.hostname, port, isHttps);
    let socket: net.Socket | tls.TLSSocket;

    const chunks: Buffer[] = [];
    let settled = false;
    let headerEndIndex = -1;
    let expectedBodyLength = -1;
    let isChunked = false;
    let responseConnectionClose = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    };

    const timeout = setTimeout(() => {
      settle(() => {
        socket.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
        reject(new Error(`Request timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);

    const releaseOrDestroy = () => {
      if (responseConnectionClose) {
        socket.destroy();
      } else {
        releaseConnection(socket, url.hostname, port, isHttps);
      }
    };

    const dataHandler = (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (settled) return;

      const assembled = Buffer.concat(chunks);

      if (headerEndIndex < 0) {
        headerEndIndex = assembled.indexOf(Buffer.from("\r\n\r\n"));
        if (headerEndIndex < 0) return;

        const headerText = assembled.slice(0, headerEndIndex).toString("utf8");
        const lines = headerText.split("\r\n");
        for (let i = 1; i < lines.length; i++) {
          const line = (lines[i] ?? "").trim();
          if (!line) continue;
          const idx = line.indexOf(":");
          if (idx < 0) continue;
          const name = line.slice(0, idx).trim().toLowerCase();
          const value = line.slice(idx + 1).trim();
          if (name === "content-length") {
            expectedBodyLength = Number.parseInt(value, 10);
          }
          if (name === "transfer-encoding" && value.toLowerCase().includes("chunked")) {
            isChunked = true;
          }
          if (name === "connection" && value.toLowerCase().includes("close")) {
            responseConnectionClose = true;
          }
        }
      }

      const bodyBuffer = assembled.slice(headerEndIndex + 4);

      if (expectedBodyLength >= 0) {
        if (bodyBuffer.length >= expectedBodyLength) {
          settle(() => {
            releaseOrDestroy();
            resolve(assembled.slice(0, headerEndIndex + 4 + expectedBodyLength));
          });
        }
        return;
      }

      if (isChunked) {
        if (bodyBuffer.length >= 7) {
          const ascii = bodyBuffer.toString("ascii");
          if (/0(?:;[^\n]*)?\r\n(?:[^\n]+:[^\n]*\r\n)*\r\n$/.test(ascii)) {
            settle(() => {
              releaseOrDestroy();
              resolve(assembled);
            });
          }
        }
        return;
      }

      // No Content-Length and not chunked — response body is empty (e.g., 301 redirect).
      if (headerEndIndex >= 0) {
        settle(() => {
          releaseOrDestroy();
          resolve(assembled);
        });
      }
    };

    const endHandler = () => {
      const buffer = Buffer.concat(chunks);
      settle(() => resolve(buffer));
    };

    const errorHandler = (err: Error) => {
      settle(() => reject(err));
    };

    if (pooled) {
      socket = pooled;
      socket.on("data", dataHandler);
      socket.on("end", endHandler);
      socket.on("error", errorHandler);
      socket.write(requestBuffer);
    } else {
      socket = isHttps
        ? tls.connect({ host: url.hostname, port, servername: url.hostname })
        : net.connect({ host: url.hostname, port });

      socket.on("connect", () => {
        socket.write(requestBuffer);
      });
      socket.on("data", dataHandler);
      socket.on("end", endHandler);
      socket.on("error", errorHandler);
    }
  });

  const response = parseResponse(responseBuffer);
  const location = response.headers.location;

  if (
    response.status >= 300 &&
    response.status < 400 &&
    typeof location === "string" &&
    location.length > 0
  ) {
    if (redirectCount >= 5) {
      const text = `Redirect limit exceeded for ${url.toString()}`;
      return {
        ok: false,
        status: response.status,
        async text() {
          return text;
        },
        async json<T = unknown>() {
          return JSON.parse(`{"error":"Redirect limit exceeded"}`) as T;
        },
      };
    }

    const redirectUrl = new URL(location, url);

    const sameOrigin =
      url.protocol === redirectUrl.protocol &&
      url.hostname === redirectUrl.hostname &&
      (url.port || (url.protocol === "https:" ? "443" : "80")) ===
        (redirectUrl.port || (redirectUrl.protocol === "https:" ? "443" : "80"));

    const safeHeaders: Record<string, string> = sameOrigin
      ? headers
      : Object.fromEntries(
          Object.entries(headers).filter(
            ([key]) => key.toLowerCase() !== "authorization"
          )
        );

    return sendRawHttpRequest(redirectUrl, body, safeHeaders, timeoutMs, redirectCount + 1);
  }

  const text = response.body.toString("utf8");
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    async text() {
      return text;
    },
    async json<T = unknown>() {
      return JSON.parse(text) as T;
    },
  };
}

/**
 * POST JSON to a URL, optionally routing through a proxy.
 *
 * For direct (non-proxied) connections to localhost or NO_PROXY-listed hosts
 * it uses raw TCP/TLS sockets (`directRequest`). Otherwise it falls back to
 * the global `fetch` API with environment-variable proxy support.
 *
 * @param urlString - The target URL string
 * @param body - The JSON-serializable request body
 * @param headers - Additional HTTP headers
 * @param timeoutMs - Request timeout in milliseconds
 * @param proxy - Optional proxy configuration
 * @returns A promise resolving to an HttpResponseLike
 */
export async function postJson(
  urlString: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
  proxy?: ProxyConfig,
  signal?: AbortSignal,
): Promise<HttpResponseLike> {
  const url = new URL(urlString);

  const bypassProxy = isLocalhost(url.hostname) || matchesNoProxy(url.hostname, proxy?.noProxy);

  if (bypassProxy || !proxy?.url) {
    return directRequest(url, body, headers, timeoutMs);
  }

  return postJsonViaFetch(urlString, body, headers, timeoutMs, proxy, signal);
}

/** Send JSON via the global `fetch` API with proxy environment variable overrides. */
async function postJsonViaFetch(
  urlString: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
  proxy?: ProxyConfig,
  signal?: AbortSignal,
): Promise<HttpResponseLike> {
  const authHeader = buildProxyAuthHeader(proxy);
  const envOverride = applyProxyEnv(proxy);

  // Serialize fetch requests that mutate process.env to prevent
  // concurrent requests from interleaving set/restore of proxy vars.
  const [savedHttpProxy, savedHttpsProxy] = [process.env.HTTP_PROXY, process.env.HTTPS_PROXY];

  return new Promise<HttpResponseLike>((resolve, reject) => {
    proxyRequestQueue = proxyRequestQueue.then(async () => {
      try {
        if (envOverride) {
          process.env.HTTP_PROXY = envOverride.httpProxy;
          process.env.HTTPS_PROXY = envOverride.httpsProxy;
        }

        const requestHeaders: Record<string, string> = {
          "Content-Type": "application/json",
          ...headers,
        };

        if (authHeader) {
          requestHeaders["Proxy-Authorization"] = authHeader;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        const onAbort = () => { controller.abort(); clearTimeout(timeout); };
        signal?.addEventListener("abort", onAbort, { once: true });

        try {
          const response = await fetch(urlString, {
            method: "POST",
            headers: requestHeaders,
            body: JSON.stringify(body),
            signal: controller.signal,
          });

          resolve(response as unknown as HttpResponseLike);
        } finally {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
          if (envOverride) {
            process.env.HTTP_PROXY = savedHttpProxy;
            process.env.HTTPS_PROXY = savedHttpsProxy;
          }
        }
      } catch (err) {
        if (envOverride) {
          process.env.HTTP_PROXY = savedHttpProxy;
          process.env.HTTPS_PROXY = savedHttpsProxy;
        }
        reject(err);
      }
    });
  });
}
