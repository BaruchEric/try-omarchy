#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isolationHeaders, parseRange } from "./serve.mjs";

const MIME_TYPES = new Map([
  [".bin", "application/octet-stream"],
  [".css", "text/css; charset=utf-8"],
  [".ext4", "application/octet-stream"],
  [".html", "text/html; charset=utf-8"],
  [".img", "application/octet-stream"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".wasm", "application/wasm"],
]);
const MAX_IMMUTABLE_RANGE_BYTES = 8 * 1024 * 1024;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeRelativePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") ||
      value.includes("\\") || value.includes("\0") || value.split("/").includes("..") ||
      value.split("/").includes("")) {
    throw new Error(`${label} is not a safe relative path: ${String(value)}`);
  }
  return value;
}

function readManifest(path, label) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${label} at ${path}: ${error.message}`);
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.artifacts)) {
    throw new Error(`${label} must be a schema 1 artifact manifest.`);
  }
  return value;
}

function readRuntimeManifest(path) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read runtime manifest at ${path}: ${error.message}`);
  }
  const rootfs = value?.guest?.rootfs?.artifactPath;
  safeRelativePath(rootfs, "runtime guest.rootfs.artifactPath");
  return value;
}

function representationDigest(sha256) {
  return `sha-256=:${Buffer.from(sha256, "hex").toString("base64")}:`;
}

function sendText(response, status, body, headers = {}) {
  response.writeHead(status, {
    ...isolationHeaders,
    "Cache-Control": "no-store",
    "Content-Length": String(Buffer.byteLength(body)),
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(body);
}

function serveBuffer(request, response, body, contentType, headers = {}) {
  response.writeHead(200, {
    ...isolationHeaders,
    "Cache-Control": "no-store",
    "Content-Length": String(body.byteLength),
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

function serveFile(request, response, entry, pathname, requests, strictRangePaths, artifactManifestSha256 = null) {
  const isStrictRangeArtifact = strictRangePaths.has(entry.artifact.path);
  const etag = `"sha256-${entry.artifact.sha256}"`;
  const requestRecord = {
    method: request.method,
    path: entry.artifact.path,
    range: request.headers.range ?? null,
    ifMatch: request.headers["if-match"] ?? null,
    responseBytes: 0,
    artifactManifestSha256,
  };
  requests.push(requestRecord);

  const identityHeaders = {
    ...isolationHeaders,
    "Accept-Ranges": "bytes",
    "Cache-Control": isStrictRangeArtifact ? "public, max-age=31536000, immutable" : "no-store",
    "Content-Type": entry.artifact.mediaType ?? MIME_TYPES.get(extname(entry.path)) ?? "application/octet-stream",
    ETag: etag,
    "Repr-Digest": representationDigest(entry.artifact.sha256),
    "X-Content-Type-Options": "nosniff",
    ...(artifactManifestSha256 === null ? {} : {
      "X-Omarchy-Verified-Artifact-Manifest-Sha256": artifactManifestSha256,
    }),
  };

  if (request.method === "HEAD") {
    requestRecord.status = 200;
    response.writeHead(200, { ...identityHeaders, "Content-Length": String(entry.artifact.bytes) });
    response.end();
    return;
  }

  if (isStrictRangeArtifact && !request.headers.range) {
    requestRecord.status = 412;
    response.writeHead(412, { ...identityHeaders, "Content-Length": "0" });
    response.end();
    return;
  }
  if (isStrictRangeArtifact && request.headers["if-match"] !== etag) {
    requestRecord.status = 412;
    response.writeHead(412, { ...identityHeaders, "Content-Length": "0" });
    response.end();
    return;
  }

  const hasStrictRange = !isStrictRangeArtifact || /^bytes=[0-9]+-[0-9]+$/.test(request.headers.range ?? "");
  const range = hasStrictRange ? parseRange(request.headers.range, entry.artifact.bytes) : undefined;
  if (range === undefined) {
    requestRecord.status = 416;
    response.writeHead(416, {
      ...identityHeaders,
      "Content-Length": "0",
      "Content-Range": `bytes */${entry.artifact.bytes}`,
    });
    response.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? entry.artifact.bytes - 1;
  const selectedBytes = Math.max(end - start + 1, 0);
  if (isStrictRangeArtifact && selectedBytes > MAX_IMMUTABLE_RANGE_BYTES) {
    requestRecord.status = 416;
    requestRecord.responseBytes = 0;
    response.writeHead(416, {
      ...identityHeaders,
      "Content-Length": "0",
      "Content-Range": `bytes */${entry.artifact.bytes}`,
    });
    response.end();
    return;
  }
  const status = range ? 206 : 200;
  requestRecord.status = status;
  requestRecord.responseBytes = selectedBytes;
  const headers = { ...identityHeaders, "Content-Length": String(selectedBytes) };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${entry.artifact.bytes}`;
  response.writeHead(status, headers);
  if (selectedBytes === 0) {
    response.end();
    return;
  }
  const stream = createReadStream(entry.path, { start, end });
  stream.on("error", () => response.destroy());
  stream.pipe(response);
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function buildFullGuestRelease({ runtimeRoot, guestRoot }) {
  const absoluteRuntimeRoot = resolve(runtimeRoot);
  const absoluteGuestRoot = resolve(guestRoot);
  const runtimeBuild = readManifest(resolve(absoluteRuntimeRoot, "runtime-build.json"), "runtime build metadata");
  const guestManifest = readManifest(resolve(absoluteGuestRoot, "guest-manifest.json"), "guest manifest");
  const runtimeManifestPath = resolve(absoluteRuntimeRoot, "runtime-manifest.json");
  const runtimeManifest = readRuntimeManifest(runtimeManifestPath);
  const entries = new Map();

  for (const [root, manifest, label] of [
    [absoluteRuntimeRoot, runtimeBuild, "runtime"],
    [absoluteGuestRoot, guestManifest, "guest"],
  ]) {
    for (const artifact of manifest.artifacts) {
      if (!isRecord(artifact)) throw new Error(`${label} artifact record is invalid.`);
      const artifactPath = safeRelativePath(artifact.path, `${label} artifact path`);
      if (entries.has(artifactPath)) throw new Error(`Duplicate release artifact path: ${artifactPath}`);
      if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 ||
          !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "")) {
        throw new Error(`${label} artifact metadata is invalid: ${artifactPath}`);
      }
      const path = resolve(root, artifactPath);
      const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
      if (!path.startsWith(prefix)) throw new Error(`${label} artifact escapes its root: ${artifactPath}`);
      const info = statSync(path);
      if (!info.isFile() || info.size !== artifact.bytes) {
        throw new Error(`${label} artifact size differs from its manifest: ${artifactPath}`);
      }
      const digest = await sha256File(path);
      if (digest !== artifact.sha256) {
        throw new Error(`${label} artifact SHA-256 differs from its manifest: ${artifactPath}`);
      }
      entries.set(artifactPath, { artifact: Object.freeze({ ...artifact }), path });
    }
    if (label === "runtime" && !entries.has("runtime-manifest.json")) {
      const body = readFileSync(runtimeManifestPath);
      entries.set("runtime-manifest.json", {
        artifact: Object.freeze({
          path: "runtime-manifest.json",
          role: "runtime-config",
          mediaType: "application/json",
          bytes: body.byteLength,
          sha256: createHash("sha256").update(body).digest("hex"),
        }),
        path: runtimeManifestPath,
      });
    }
  }

  if (!entries.has("guest-manifest.json")) {
    const guestManifestPath = resolve(absoluteGuestRoot, "guest-manifest.json");
    const body = readFileSync(guestManifestPath);
    entries.set("guest-manifest.json", {
      artifact: Object.freeze({
        path: "guest-manifest.json",
        role: "guest-metadata",
        mediaType: "application/json",
        bytes: body.byteLength,
        sha256: createHash("sha256").update(body).digest("hex"),
      }),
      path: guestManifestPath,
    });
  }

  if (runtimeManifest.checkpoint !== undefined) {
    const checkpointRecords = [
      {
        path: runtimeManifest.checkpoint?.vmstate?.artifactPath,
        bytes: runtimeManifest.checkpoint?.vmstate?.bytes,
        sha256: runtimeManifest.checkpoint?.vmstate?.sha256,
        role: "preboot-vmstate",
        mediaType: "application/vnd.qemu.vmstate",
      },
      {
        path: runtimeManifest.checkpoint?.bootDelta?.artifactPath,
        bytes: runtimeManifest.checkpoint?.bootDelta?.bytes,
        sha256: runtimeManifest.checkpoint?.bootDelta?.sha256,
        role: "preboot-disk-delta",
        mediaType: "application/vnd.qemu.qcow2",
      },
      {
        path: runtimeManifest.checkpoint?.producer?.manifestArtifactPath,
        bytes: runtimeManifest.checkpoint?.producer?.manifestBytes,
        sha256: runtimeManifest.checkpoint?.producer?.manifestSha256,
        role: "preboot-checkpoint-metadata",
        mediaType: "application/json",
      },
    ];
    for (const artifact of checkpointRecords) {
      const artifactPath = safeRelativePath(artifact.path, "checkpoint artifact path");
      if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 ||
          !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "")) {
        throw new Error(`checkpoint artifact metadata is invalid: ${artifactPath}`);
      }
      const existing = entries.get(artifactPath);
      if (existing) {
        if (existing.artifact.bytes !== artifact.bytes || existing.artifact.sha256 !== artifact.sha256) {
          throw new Error(`checkpoint artifact conflicts with guest manifest: ${artifactPath}`);
        }
        continue;
      }
      const path = resolve(absoluteGuestRoot, artifactPath);
      const guestPrefix = absoluteGuestRoot.endsWith(sep) ? absoluteGuestRoot : `${absoluteGuestRoot}${sep}`;
      if (!path.startsWith(guestPrefix)) throw new Error(`checkpoint artifact escapes guest root: ${artifactPath}`);
      const info = statSync(path);
      if (!info.isFile() || info.size !== artifact.bytes) {
        throw new Error(`checkpoint artifact size differs from runtime manifest: ${artifactPath}`);
      }
      const digest = await sha256File(path);
      if (digest !== artifact.sha256) {
        throw new Error(`checkpoint artifact SHA-256 differs from runtime manifest: ${artifactPath}`);
      }
      entries.set(artifactPath, { artifact: Object.freeze({ ...artifact }), path });
    }
  }

  const rootfsPath = runtimeManifest.guest.rootfs.artifactPath;
  const strictRangePaths = new Set([rootfsPath]);
  if (runtimeManifest.checkpoint !== undefined) {
    const rangedCheckpointArtifacts = [
      ["checkpoint vmstate", runtimeManifest.checkpoint?.vmstate?.artifactPath],
      ["checkpoint boot delta", runtimeManifest.checkpoint?.bootDelta?.artifactPath],
    ];
    for (const [label, artifactPath] of rangedCheckpointArtifacts) {
      strictRangePaths.add(safeRelativePath(artifactPath, label));
    }
  }
  for (const artifactPath of strictRangePaths) {
    if (!entries.has(artifactPath)) throw new Error(`Guest release is missing ${artifactPath}.`);
  }
  const artifactManifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    kind: "omarchy-local-full-guest-release",
    upstream: {
      repository: guestManifest.upstream?.repository,
      commit: guestManifest.upstream?.commit,
      version: guestManifest.upstream?.version,
      license: guestManifest.upstream?.license,
      treeSha256: guestManifest.normalizedUpstreamTree?.sha256 ?? guestManifest.upstream?.treeSha256,
    },
    artifacts: [...entries.values()].map(({ artifact }) => artifact),
  }, null, 2)}\n`);
  const artifactManifestSha256 = createHash("sha256").update(artifactManifest).digest("hex");
  const verification = Object.freeze({
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    artifactManifestSha256,
    artifactCount: entries.size,
    totalArtifactBytes: [...entries.values()].reduce(
      (total, { artifact }) => total + artifact.bytes,
      0,
    ),
    artifacts: Object.freeze([...entries.values()].map(({ artifact }) => Object.freeze({
      path: artifact.path,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    }))),
  });
  return { entries, strictRangePaths, artifactManifest, artifactManifestSha256, verification };
}

export async function createFullGuestServer({ runtimeRoot, guestRoot, webRoot }) {
  const release = await buildFullGuestRelease({ runtimeRoot, guestRoot });
  const absoluteWebRoot = resolve(webRoot);
  const webPrefix = absoluteWebRoot.endsWith(sep) ? absoluteWebRoot : `${absoluteWebRoot}${sep}`;
  const requests = [];

  const server = createServer((request, response) => {
    let url;
    try {
      url = new URL(request.url, "http://omarchy-full-guest.invalid");
    } catch {
      sendText(response, 400, "Bad request\n");
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      sendText(response, 400, "Bad request\n");
      return;
    }

    if (pathname === "/__requests" && (request.method === "GET" || request.method === "HEAD")) {
      const body = Buffer.from(`${JSON.stringify(requests, null, 2)}\n`);
      serveBuffer(request, response, body, "application/json; charset=utf-8");
      return;
    }
    if (pathname === "/__verification" && (request.method === "GET" || request.method === "HEAD")) {
      const body = Buffer.from(`${JSON.stringify(release.verification, null, 2)}\n`);
      serveBuffer(request, response, body, "application/json; charset=utf-8");
      return;
    }
    if (pathname === "/__reset" && request.method === "POST") {
      requests.length = 0;
      response.writeHead(204, { ...isolationHeaders, "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendText(response, 405, "Method not allowed\n");
      return;
    }
    if (pathname === "/") {
      response.writeHead(302, {
        ...isolationHeaders,
        "Cache-Control": "no-store",
        "Content-Length": "0",
        Location: `/web/full-guest.html${url.search}`,
      });
      response.end();
      return;
    }
    if (pathname === "/release/artifact-manifest.json") {
      serveBuffer(
        request,
        response,
        release.artifactManifest,
        "application/json; charset=utf-8",
        { "X-Omarchy-Verified-Artifact-Manifest-Sha256": release.artifactManifestSha256 },
      );
      return;
    }
    if (pathname.startsWith("/release/")) {
      const artifactPath = pathname.slice("/release/".length);
      const entry = release.entries.get(artifactPath);
      if (!entry) {
        sendText(response, 404, "Release artifact not found\n");
        return;
      }
      serveFile(
        request,
        response,
        entry,
        pathname,
        requests,
        release.strictRangePaths,
        release.artifactManifestSha256,
      );
      return;
    }
    if (pathname.startsWith("/web/")) {
      const path = resolve(absoluteWebRoot, `.${pathname.slice("/web".length)}`);
      if (!path.startsWith(webPrefix)) {
        sendText(response, 403, "Forbidden\n");
        return;
      }
      let info;
      try {
        info = statSync(path);
      } catch {
        sendText(response, 404, "Not found\n");
        return;
      }
      if (!info.isFile()) {
        sendText(response, 404, "Not found\n");
        return;
      }
      const entry = {
        artifact: {
          path: pathname.slice(1),
          bytes: info.size,
          sha256: "0".repeat(64),
          mediaType: MIME_TYPES.get(extname(path)) ?? "application/octet-stream",
        },
        path,
      };
      serveFile(request, response, entry, pathname, [], new Set());
      return;
    }
    sendText(response, 404, "Not found\n");
  });
  return Object.assign(server, {
    releaseRequests: requests,
    releaseVerification: release.verification,
  });
}

function parseCli(arguments_) {
  const runtimeDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const result = {
    runtimeRoot: resolve(runtimeDirectory, "dist"),
    guestRoot: resolve(runtimeDirectory, "../guest/dist"),
    webRoot: resolve(runtimeDirectory, "web"),
    host: "127.0.0.1",
    port: 8094,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--runtime-root") result.runtimeRoot = resolve(arguments_[++index]);
    else if (argument === "--guest-root") result.guestRoot = resolve(arguments_[++index]);
    else if (argument === "--web-root") result.webRoot = resolve(arguments_[++index]);
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
  const options = parseCli(process.argv.slice(2));
  const server = await createFullGuestServer(options);
  server.listen(options.port, options.host, () => {
    const address = server.address();
    process.stdout.write(
      `OMARCHY_FULL_GUEST_URL http://${options.host}:${address.port}/web/full-guest.html\n`,
    );
  });
}
