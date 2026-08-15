#!/usr/bin/env node
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".data", "application/octet-stream"],
  [".html", "text/html; charset=utf-8"],
  [".img", "application/octet-stream"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".wasm", "application/wasm"],
]);

export const isolationHeaders = Object.freeze({
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Origin-Agent-Cluster": "?1",
});

export function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (match[1] === "" && match[2] === "")) return undefined;

  let start;
  let end;
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return undefined;
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    return undefined;
  }
  return { start, end: Math.min(end, size - 1) };
}

export function cacheControl(pathname) {
  const largeBinary = /\.(?:wasm|data|img|bin)$/.test(pathname);
  const contentAddressed = /(?:^|[./-])[0-9a-f]{16,}(?=[./-]|$)/i.test(pathname);
  return largeBinary && contentAddressed
    ? "public, max-age=31536000, immutable"
    : largeBinary ? "no-store" : "no-cache";
}

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    ...isolationHeaders,
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

export function createRuntimeServer({ root }) {
  const absoluteRoot = resolve(root);
  const rootPrefix = absoluteRoot.endsWith(sep) ? absoluteRoot : `${absoluteRoot}${sep}`;

  return createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendText(response, 405, "Method not allowed\n");
      return;
    }

    let requestUrl;
    try {
      requestUrl = new URL(request.url, "http://runtime.invalid");
    } catch {
      sendText(response, 400, "Bad request\n");
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(requestUrl.pathname);
    } catch {
      sendText(response, 400, "Bad request\n");
      return;
    }
    if (pathname === "/") {
      response.writeHead(302, {
        ...isolationHeaders,
        "Cache-Control": "no-cache",
        "Content-Length": "0",
        Location: `/web/harness.html${requestUrl.search}`,
      });
      response.end();
      return;
    }

    const filePath = resolve(absoluteRoot, `.${pathname}`);
    if (!filePath.startsWith(rootPrefix)) {
      sendText(response, 403, "Forbidden\n");
      return;
    }

    let info;
    try {
      info = statSync(filePath);
    } catch {
      sendText(response, 404, "Not found\n");
      return;
    }
    if (!info.isFile()) {
      sendText(response, 404, "Not found\n");
      return;
    }

    const range = parseRange(request.headers.range, info.size);
    if (range === undefined) {
      response.writeHead(416, {
        ...isolationHeaders,
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${info.size}`,
      });
      response.end();
      return;
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? info.size - 1;
    const statusCode = range ? 206 : 200;
    const headers = {
      ...isolationHeaders,
      "Accept-Ranges": "bytes",
      "Cache-Control": cacheControl(pathname),
      "Content-Type": MIME_TYPES.get(extname(filePath)) ?? "application/octet-stream",
      "Content-Length": String(Math.max(end - start + 1, 0)),
      "X-Content-Type-Options": "nosniff",
    };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
    response.writeHead(statusCode, headers);

    if (request.method === "HEAD" || info.size === 0) {
      response.end();
      return;
    }
    createReadStream(filePath, { start, end }).pipe(response);
  });
}

function parseCliArguments(arguments_) {
  const result = { root: resolve(fileURLToPath(new URL("..", import.meta.url))), host: "127.0.0.1", port: 8088 };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--root") result.root = resolve(arguments_[++index]);
    else if (argument === "--host") result.host = arguments_[++index];
    else if (argument === "--port") result.port = Number(arguments_[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(result.port) || result.port < 0 || result.port > 65535) {
    throw new Error("Port must be an integer between 0 and 65535.");
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseCliArguments(process.argv.slice(2));
  const server = createRuntimeServer(options);
  server.listen(options.port, options.host, () => {
    const address = server.address();
    process.stdout.write(`Omarchy runtime harness: http://${options.host}:${address.port}/\n`);
  });
}
