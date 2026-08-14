#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORAGE = path.dirname(HERE);
const DISK_BYTES = 4 * 1024 * 1024;

function parsePort(argv) {
  const index = argv.indexOf("--port");
  if (index < 0) return 8091;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error("Usage: node storage/proof/server.mjs [--port 0..65535]");
  }
  return value;
}

function immutableHeaders(metadata, selectedBytes = metadata.bytes) {
  return {
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Length": String(selectedBytes),
    "Content-Type": "application/octet-stream",
    "Cross-Origin-Resource-Policy": "same-origin",
    ETag: metadata.etag,
    "Repr-Digest": metadata.reprDigest,
  };
}

function isolationHeaders(extra = {}) {
  return {
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  };
}

function parseRange(value, total) {
  const match = value?.match(/^bytes=([0-9]+)-([0-9]+)$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= total) return null;
  return { start, end, bytes: end - start + 1 };
}

async function fixture() {
  const directory = path.join(HERE, "dist");
  const diskPath = path.join(directory, "rootfs.ext4");
  await mkdir(directory, { recursive: true });
  const disk = new Uint8Array(DISK_BYTES);
  disk.set(new TextEncoder().encode("OMARCHY_RANGE_ZERO"), 17);
  disk.set(new TextEncoder().encode("OMARCHY_RANGE_TWO"), 2 * 1024 * 1024 + 31);
  await writeFile(diskPath, disk);
  const sha256 = createHash("sha256").update(disk).digest("hex");
  const base64 = Buffer.from(sha256, "hex").toString("base64");
  return {
    path: diskPath,
    bytes: disk.byteLength,
    sha256,
    etag: `"sha256-${sha256}"`,
    reprDigest: `sha-256=:${base64}:`,
  };
}

async function sendStatic(response, filePath, contentType) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    response.writeHead(200, isolationHeaders({
      "Content-Length": String(info.size),
      "Content-Type": contentType,
    }));
    response.end(await readFile(filePath));
  } catch {
    response.writeHead(404, isolationHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
    response.end("Not found\n");
  }
}

export async function startProofServer({ port = 0, host = "127.0.0.1" } = {}) {
  const metadata = await fixture();
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === "/rootfs.ext4") {
      const entry = {
        method: request.method,
        path: url.pathname,
        range: request.headers.range ?? null,
        ifMatch: request.headers["if-match"] ?? null,
        responseBytes: 0,
      };
      requests.push(entry);
      if (request.method === "HEAD") {
        entry.status = 200;
        response.writeHead(200, immutableHeaders(metadata));
        response.end();
        return;
      }
      if (request.method !== "GET" || !request.headers.range) {
        entry.status = 412;
        response.writeHead(412, isolationHeaders({ "Content-Length": "0" }));
        response.end();
        return;
      }
      if (request.headers["if-match"] !== metadata.etag) {
        entry.status = 412;
        response.writeHead(412, isolationHeaders({ "Content-Length": "0" }));
        response.end();
        return;
      }
      const selected = parseRange(request.headers.range, metadata.bytes);
      if (!selected) {
        entry.status = 416;
        response.writeHead(416, isolationHeaders({
          "Content-Length": "0",
          "Content-Range": `bytes */${metadata.bytes}`,
        }));
        response.end();
        return;
      }
      const disk = await readFile(metadata.path);
      const body = disk.subarray(selected.start, selected.end + 1);
      entry.status = 206;
      entry.responseBytes = body.byteLength;
      response.writeHead(206, isolationHeaders({
        ...immutableHeaders(metadata, body.byteLength),
        "Content-Range": `bytes ${selected.start}-${selected.end}/${metadata.bytes}`,
      }));
      response.end(body);
      return;
    }

    if (url.pathname === "/metadata.json") {
      const body = `${JSON.stringify({ path: "/rootfs.ext4", bytes: metadata.bytes, sha256: metadata.sha256 })}\n`;
      response.writeHead(200, isolationHeaders({
        "Cache-Control": "no-store",
        "Content-Length": String(Buffer.byteLength(body)),
        "Content-Type": "application/json; charset=utf-8",
      }));
      response.end(body);
      return;
    }
    if (url.pathname === "/__requests") {
      const body = `${JSON.stringify(requests)}\n`;
      response.writeHead(200, isolationHeaders({
        "Cache-Control": "no-store",
        "Content-Length": String(Buffer.byteLength(body)),
        "Content-Type": "application/json; charset=utf-8",
      }));
      response.end(body);
      return;
    }
    if (url.pathname === "/__reset" && request.method === "POST") {
      requests.length = 0;
      response.writeHead(204, isolationHeaders());
      response.end();
      return;
    }

    const staticFiles = new Map([
      ["/", [path.join(HERE, "index.html"), "text/html; charset=utf-8"]],
      ["/worker.mjs", [path.join(HERE, "worker.mjs"), "text/javascript; charset=utf-8"]],
      ["/paged-disk.mjs", [path.join(STORAGE, "paged-disk.mjs"), "text/javascript; charset=utf-8"]],
      ["/dist/proof.mjs", [path.join(HERE, "dist/proof.mjs"), "text/javascript; charset=utf-8"]],
      ["/dist/proof.wasm", [path.join(HERE, "dist/proof.wasm"), "application/wasm"]],
    ]);
    const target = staticFiles.get(url.pathname);
    if (target) return sendStatic(response, ...target);
    response.writeHead(404, isolationHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
    response.end("Not found\n");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return {
    server,
    requests,
    metadata,
    url: `http://${host}:${address.port}/`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function main() {
  const running = await startProofServer({ port: parsePort(process.argv.slice(2)) });
  console.log(`STORAGE_PROOF_URL ${running.url}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
