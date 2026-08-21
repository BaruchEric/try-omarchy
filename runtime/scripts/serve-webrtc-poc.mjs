#!/usr/bin/env node

import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  WEBRTC_POC_LIMITS,
  normalizeSignalingEnvelope,
} from "../web/webrtc-protocol.mjs";

const scriptDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const webRoot = resolve(scriptDirectory, "../web");
const STATIC_FILES = new Map([
  ["/", "webrtc-poc.html"],
  ["/webrtc-poc.html", "webrtc-poc.html"],
  ["/webrtc-host.html", "webrtc-host.html"],
  ["/webrtc-viewer.html", "webrtc-viewer.html"],
  ["/webrtc-poc.css", "webrtc-poc.css"],
  ["/webrtc-poc-index.mjs", "webrtc-poc-index.mjs"],
  ["/webrtc-host.mjs", "webrtc-host.mjs"],
  ["/webrtc-viewer.mjs", "webrtc-viewer.mjs"],
  ["/webrtc-peer.mjs", "webrtc-peer.mjs"],
  ["/webrtc-protocol.mjs", "webrtc-protocol.mjs"],
]);
const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
]);
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 16;
const MAX_BODY_BYTES = WEBRTC_POC_LIMITS.sdpMaxBytes + 4096;

function securityHeaders() {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self' http://127.0.0.1:11555; img-src 'self' data:; media-src 'self' blob:; script-src 'self'; style-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), display-capture=(self), geolocation=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function json(response, status, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, {
    ...securityHeaders(),
    "Content-Length": String(body.byteLength),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function empty(response, status) {
  response.writeHead(status, { ...securityHeaders(), "Content-Length": "0" });
  response.end();
}

function secret(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

function equalSecret(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function bearer(request) {
  const value = request.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ")
    ? value.slice("Bearer ".length)
    : null;
}

async function readJSON(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    throw new Error("content-type");
  }
  const advertised = Number(request.headers["content-length"] ?? 0);
  if (!Number.isSafeInteger(advertised) || advertised <= 0 || advertised > MAX_BODY_BYTES) {
    throw new Error("content-length");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new Error("body-too-large");
    chunks.push(chunk);
  }
  if (bytes !== advertised) throw new Error("body-length");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createWebRtcPocServer({ now = () => Date.now() } = {}) {
  const sessions = new Map();

  function prune() {
    const cutoff = now() - SESSION_TTL_MS;
    for (const [id, session] of sessions) {
      if (session.updatedAt < cutoff) sessions.delete(id);
    }
  }

  function sessionRoute(pathname) {
    const match = /^\/api\/webrtc\/sessions\/([A-Za-z0-9_-]{22})\/(offer|answer)$/.exec(pathname);
    return match ? { id: match[1], side: match[2] } : null;
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    prune();

    if (request.method === "GET" && url.pathname === "/api/health") {
      json(response, 200, {
        schemaVersion: 1,
        kind: "omarchy-webrtc-poc",
        sessions: sessions.size,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/webrtc/sessions") {
      if ((request.headers["content-length"] ?? "0") !== "0") {
        json(response, 400, { error: "session creation must have an empty body" });
        return;
      }
      if (sessions.size >= MAX_SESSIONS) {
        json(response, 503, { error: "session capacity reached" });
        return;
      }
      const id = secret(16);
      const createdAt = now();
      const session = {
        id,
        hostToken: secret(),
        viewerToken: secret(),
        offer: null,
        answer: null,
        createdAt,
        updatedAt: createdAt,
      };
      sessions.set(id, session);
      json(response, 201, {
        schemaVersion: 1,
        sessionId: id,
        hostToken: session.hostToken,
        viewerToken: session.viewerToken,
        expiresInSeconds: SESSION_TTL_MS / 1000,
      });
      return;
    }

    const route = sessionRoute(url.pathname);
    if (route !== null) {
      const session = sessions.get(route.id);
      const isOffer = route.side === "offer";
      const expectedToken = request.method === "GET"
        ? (isOffer ? session?.viewerToken : session?.hostToken)
        : (isOffer ? session?.hostToken : session?.viewerToken);
      const suppliedToken = request.method === "GET" ? url.searchParams.get("token") : bearer(request);
      if (!session || !equalSecret(suppliedToken, expectedToken)) {
        json(response, 404, { error: "session not found" });
        return;
      }
      if (request.method === "GET") {
        const value = isOffer ? session.offer : session.answer;
        if (value === null) {
          empty(response, 204);
        } else {
          json(response, 200, value);
        }
        return;
      }
      if (request.method === "PUT") {
        try {
          const envelope = normalizeSignalingEnvelope(
            await readJSON(request),
            isOffer ? "offer" : "answer",
          );
          if (envelope === null) throw new Error("invalid-envelope");
          if ((isOffer ? session.offer : session.answer) !== null) {
            json(response, 409, { error: `${route.side} already published` });
            return;
          }
          if (isOffer) session.offer = envelope;
          else session.answer = envelope;
          session.updatedAt = now();
          empty(response, 204);
        } catch {
          json(response, 400, { error: `invalid ${route.side}` });
        }
        return;
      }
      json(response, 405, { error: "method not allowed" });
      return;
    }

    const deleteMatch = /^\/api\/webrtc\/sessions\/([A-Za-z0-9_-]{22})$/.exec(url.pathname);
    if (deleteMatch && request.method === "DELETE") {
      const session = sessions.get(deleteMatch[1]);
      if (!session || !equalSecret(bearer(request), session.hostToken)) {
        json(response, 404, { error: "session not found" });
        return;
      }
      sessions.delete(session.id);
      empty(response, 204);
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && STATIC_FILES.has(url.pathname)) {
      const path = resolve(webRoot, STATIC_FILES.get(url.pathname));
      try {
        const body = await readFile(path);
        response.writeHead(200, {
          ...securityHeaders(),
          "Content-Length": String(body.byteLength),
          "Content-Type": MIME.get(extname(path)) ?? "application/octet-stream",
        });
        response.end(request.method === "HEAD" ? undefined : body);
      } catch {
        json(response, 404, { error: "asset not found" });
      }
      return;
    }

    json(response, 404, { error: "not found" });
  });

  return Object.assign(server, {
    sessionCount: () => sessions.size,
    closeSessions: () => sessions.clear(),
  });
}

function parseArguments(arguments_) {
  let host = "127.0.0.1";
  let port = 8110;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--host" && arguments_[index + 1]) host = arguments_[++index];
    else if (argument === "--port" && /^\d+$/.test(arguments_[index + 1] ?? "")) port = Number(arguments_[++index]);
    else throw new Error(`unsupported argument: ${argument}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be between 1 and 65535");
  return { host, port };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { host, port } = parseArguments(process.argv.slice(2));
  const server = createWebRtcPocServer();
  server.listen(port, host, () => {
    process.stdout.write(`[webrtc] Omarchy streaming POC listening on http://${host}:${port}/\n`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
