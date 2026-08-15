import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import http from "node:http";
import https from "node:https";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ACTIVE_UPSTREAM } from "../../app/components/vm-ui-state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = resolve(HERE, "../..");
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_ROOTFS_RANGE_BYTES = 8 * 1024 * 1024;
const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const ISOLATION_HEADERS = Object.freeze({
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
});

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

function safeArtifactPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.split("/").includes("") &&
    !value.split("/").includes(".") &&
    !value.split("/").includes("..")
  );
}

export function normalizeLocalReleaseBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("--release-base must be an absolute local HTTP(S) URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !LOCAL_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("--release-base must be credential-free localhost HTTP(S) with no query or fragment.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function requestClient(url) {
  return url.protocol === "https:" ? https : http;
}

function fetchBounded(url, maximum) {
  return new Promise((resolvePromise, reject) => {
    const request = requestClient(url).request(url, {
      method: "GET",
      headers: { Accept: "application/json", "Accept-Encoding": "identity" },
    });
    request.once("error", reject);
    request.once("response", (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Release manifest preflight returned HTTP ${response.statusCode}.`));
        return;
      }
      if (response.headers.location) {
        response.resume();
        reject(new Error("Release manifest preflight must not redirect."));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.byteLength;
        if (bytes > maximum) {
          request.destroy(new Error(`Release manifest exceeds ${maximum} bytes.`));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => resolvePromise(Buffer.concat(chunks)));
    });
    request.end();
  });
}

export function inspectArtifactManifest(body) {
  let manifest;
  try {
    manifest = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("Release artifact-manifest.json is not valid JSON.");
  }
  if (!isRecord(manifest) || manifest.schemaVersion !== 1 || !Array.isArray(manifest.artifacts)) {
    throw new Error("Release artifact manifest must use schemaVersion 1 and contain artifacts.");
  }
  if (
    !isRecord(manifest.upstream) ||
    !Object.entries(ACTIVE_UPSTREAM).every(([key, expected]) => manifest.upstream[key] === expected)
  ) {
    throw new Error("Release artifact manifest does not identify the exact pinned Omarchy source.");
  }

  const artifacts = new Map();
  for (const record of manifest.artifacts) {
    if (
      !isRecord(record) ||
      !safeArtifactPath(record.path) ||
      artifacts.has(record.path) ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes <= 0 ||
      typeof record.role !== "string" ||
      !record.role ||
      typeof record.mediaType !== "string" ||
      !record.mediaType ||
      typeof record.sha256 !== "string" ||
      !SHA256.test(record.sha256)
    ) {
      throw new Error(`Release contains malformed or duplicate artifact metadata: ${String(record?.path)}.`);
    }
    artifacts.set(record.path, Object.freeze({ ...record }));
  }
  const workers = [...artifacts.values()].filter(
    ({ path, role }) => path === "production-worker.mjs" && role === "host-worker",
  );
  const rootfs = [...artifacts.values()].filter(({ role }) => role === "guest-rootfs");
  if (workers.length !== 1) throw new Error("Release must contain exactly one canonical production Worker.");
  if (rootfs.length !== 1) throw new Error("Release must contain exactly one guest-rootfs artifact.");
  const migrationPaged = [...artifacts.values()].filter(({ role }) =>
    role === "preboot-vmstate" || role === "preboot-disk-delta");
  const hibernationPaged = [...artifacts.values()].filter(({ role }) =>
    role === "hibernation-root-delta" || role === "hibernation-swap-image");
  if (migrationPaged.length !== 0 && migrationPaged.length !== 2) {
    throw new Error("Release contains a partial migration checkpoint range set.");
  }
  if (hibernationPaged.length !== 0 && hibernationPaged.length !== 2) {
    throw new Error("Release contains a partial hibernation range set.");
  }
  if (migrationPaged.length > 0 && hibernationPaged.length > 0) {
    throw new Error("Release mixes migration and hibernation range sets.");
  }
  return Object.freeze({
    manifest,
    artifacts,
    worker: workers[0],
    rootfs: rootfs[0],
    strictRangeArtifacts: Object.freeze([
      rootfs[0],
      ...migrationPaged,
      ...hibernationPaged,
    ]),
  });
}

function staticFiles(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const served = new Map([
    ["/proofs/browser-acceptance/harness.html", "proofs/browser-acceptance/harness.html"],
    ["/proofs/browser-acceptance/harness.mjs", "proofs/browser-acceptance/harness.mjs"],
    ["/proofs/browser-acceptance/contract.mjs", "proofs/browser-acceptance/contract.mjs"],
    ["/app/components/vm-host-protocol.mjs", "app/components/vm-host-protocol.mjs"],
    ["/app/components/vm-ui-state.mjs", "app/components/vm-ui-state.mjs"],
    ["/vm/index.html", "public/vm/index.html"],
    ["/vm/host.mjs", "public/vm/host.mjs"],
    ["/vm/host-utils.mjs", "public/vm/host-utils.mjs"],
    ["/vm/desktop-proof.mjs", "public/vm/desktop-proof.mjs"],
    ["/public/vm/desktop-proof.mjs", "public/vm/desktop-proof.mjs"],
  ]);
  const tooling = [
    "proofs/browser-acceptance/run.mjs",
    "proofs/browser-acceptance/cdp.mjs",
    "proofs/browser-acceptance/png.mjs",
    "proofs/browser-acceptance/server.mjs",
  ];
  const sourceBodies = new Map();
  const files = new Map([...served].map(([pathname, relative]) => {
    const path = resolve(root, relative);
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    if (!path.startsWith(prefix)) throw new Error(`Static acceptance path escapes repository: ${relative}.`);
    const body = readFileSync(path);
    sourceBodies.set(relative, body);
    return [pathname, Object.freeze({ path, body })];
  }));
  for (const relative of tooling) {
    if (sourceBodies.has(relative)) continue;
    const path = resolve(root, relative);
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    if (!path.startsWith(prefix)) throw new Error(`Acceptance tooling path escapes repository: ${relative}.`);
    sourceBodies.set(relative, readFileSync(path));
  }
  const sourceHashes = Object.freeze(Object.fromEntries(
    [...sourceBodies].sort(([left], [right]) => left.localeCompare(right)).map(([relative, body]) => [
      relative,
      Object.freeze({ bytes: body.byteLength, sha256: sha256(body) }),
    ]),
  ));
  return Object.freeze({ files, sourceHashes });
}

function contentType(pathname) {
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
  return "text/javascript; charset=utf-8";
}

function sendText(response, status, body) {
  const bytes = Buffer.from(body);
  response.writeHead(status, {
    ...ISOLATION_HEADERS,
    "Cache-Control": "no-store",
    "Content-Length": String(bytes.byteLength),
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(bytes);
}

function serveStatic(request, response, entry, pathname) {
  const body = entry.body;
  response.writeHead(200, {
    ...ISOLATION_HEADERS,
    "Cache-Control": "no-store",
    "Content-Length": String(body.byteLength),
    "Content-Type": contentType(pathname),
    "X-Content-Type-Options": "nosniff",
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

function selectedUpstreamHeaders(headers) {
  const selected = {};
  for (const name of [
    "accept-ranges",
    "cache-control",
    "content-length",
    "content-range",
    "content-type",
    "etag",
    "last-modified",
    "repr-digest",
  ]) {
    if (headers[name] !== undefined) selected[name] = headers[name];
  }
  return selected;
}

function parseExactRange(value, totalBytes) {
  const match = /^bytes=([0-9]+)-([0-9]+)$/.exec(value ?? "");
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= totalBytes) {
    return null;
  }
  const bytes = end - start + 1;
  return bytes <= MAX_ROOTFS_RANGE_BYTES ? { start, end, bytes } : null;
}

function summarizeRequests(records, release) {
  const complete = records.filter(({ completedAt }) => completedAt !== null);
  const rootfs = complete.filter(({ artifactPath }) => artifactPath === release.rootfs.path);
  const rootfsGets = rootfs.filter(({ method }) => method === "GET");
  const rootfsHeads = rootfs.filter(({ method }) => method === "HEAD");
  const manifestGets = complete.filter(
    ({ method, artifactPath }) => method === "GET" && artifactPath === "artifact-manifest.json",
  );
  const expectedIfMatch = `"sha256-${release.rootfs.sha256}"`;
  const violations = [];
  if (manifestGets.length < 2) {
    violations.push("The parent bootstrap and isolated runtime did not each fetch the artifact manifest.");
  }
  for (const record of complete) {
    if (record.aborted || record.error) {
      violations.push(`Artifact request ${record.id} did not complete cleanly.`);
    }
    const expectedStatus = release.strictRangeArtifacts.some(
      ({ path }) => path === record.artifactPath,
    ) && record.method === "GET"
      ? 206
      : 200;
    if (record.status !== expectedStatus) {
      violations.push(`Artifact request ${record.id} returned HTTP ${record.status}; expected ${expectedStatus}.`);
    }
    if (
      record.method === "GET" &&
      Number.isSafeInteger(record.declaredContentLength) &&
      record.responseBytes !== record.declaredContentLength
    ) {
      violations.push(`Artifact request ${record.id} body length differed from Content-Length.`);
    }
  }
  if (rootfsHeads.length === 0) violations.push("No guest-rootfs HEAD preflight was observed.");
  if (rootfsGets.length === 0) violations.push("No guest-rootfs byte-range GET was observed.");
  for (const record of rootfsHeads) {
    if (record.status !== 200) violations.push(`Rootfs HEAD ${record.id} returned HTTP ${record.status}.`);
    if (record.declaredContentLength !== release.rootfs.bytes) {
      violations.push(`Rootfs HEAD ${record.id} did not expose the manifest byte length.`);
    }
    if (record.etag !== expectedIfMatch) {
      violations.push(`Rootfs HEAD ${record.id} did not expose the manifest digest ETag.`);
    }
    if (record.acceptRanges !== "bytes") {
      violations.push(`Rootfs HEAD ${record.id} did not advertise byte ranges.`);
    }
  }
  for (const record of rootfsGets) {
    const range = parseExactRange(record.range, release.rootfs.bytes);
    if (!range) violations.push(`Rootfs request ${record.id} did not use an exact bounded range.`);
    if (record.ifMatch !== expectedIfMatch) violations.push(`Rootfs request ${record.id} omitted the exact If-Match digest.`);
    if (record.status !== 206) violations.push(`Rootfs request ${record.id} returned HTTP ${record.status}.`);
    if (record.etag !== expectedIfMatch) violations.push(`Rootfs request ${record.id} returned a different ETag.`);
    if (range && record.contentRange !== `bytes ${range.start}-${range.end}/${release.rootfs.bytes}`) {
      violations.push(`Rootfs request ${record.id} returned an invalid Content-Range.`);
    }
    if (range && record.responseBytes !== range.bytes) {
      violations.push(`Rootfs request ${record.id} returned ${record.responseBytes} bytes instead of ${range.bytes}.`);
    }
    if (record.aborted) violations.push(`Rootfs request ${record.id} was aborted.`);
  }
  for (const artifact of release.strictRangeArtifacts.slice(1)) {
    const artifactRecords = complete.filter(
      ({ artifactPath }) => artifactPath === artifact.path,
    );
    const heads = artifactRecords.filter(({ method }) => method === "HEAD");
    const gets = artifactRecords.filter(({ method }) => method === "GET");
    const expectedArtifactEtag = `"sha256-${artifact.sha256}"`;
    if (heads.length === 0) {
      violations.push(`No ${artifact.role} HEAD preflight was observed.`);
    }
    if (gets.length === 0) {
      violations.push(`No ${artifact.role} byte-range GET was observed.`);
    }
    for (const record of heads) {
      if (
        record.status !== 200 ||
        record.declaredContentLength !== artifact.bytes ||
        record.etag !== expectedArtifactEtag ||
        record.acceptRanges !== "bytes"
      ) {
        violations.push(`${artifact.role} HEAD ${record.id} was not identity-bound.`);
      }
    }
    for (const record of gets) {
      const range = parseExactRange(record.range, artifact.bytes);
      if (
        !range ||
        record.ifMatch !== expectedArtifactEtag ||
        record.status !== 206 ||
        record.etag !== expectedArtifactEtag ||
        record.contentRange !==
          `bytes ${range?.start}-${range?.end}/${artifact.bytes}` ||
        record.responseBytes !== range?.bytes
      ) {
        violations.push(`${artifact.role} range ${record.id} was not exact and identity-bound.`);
      }
    }
  }
  if (records.some(({ completedAt }) => completedAt === null)) {
    violations.push("Artifact proxy still had incomplete requests at evidence capture.");
  }

  const statuses = {};
  for (const record of complete) {
    const key = String(record.status);
    statuses[key] = (statuses[key] ?? 0) + 1;
  }
  const uniqueRootfsRanges = new Set(rootfsGets.map(({ range }) => range));
  return {
    schemaVersion: 1,
    totalRequests: records.length,
    completeRequests: complete.length,
    pendingRequests: records.length - complete.length,
    statusCounts: statuses,
    rootfs: {
      path: release.rootfs.path,
      bytes: release.rootfs.bytes,
      sha256: release.rootfs.sha256,
      headRequests: rootfsHeads.length,
      rangeRequests: rootfsGets.length,
      uniqueRanges: uniqueRootfsRanges.size,
      responseBytes: rootfsGets.reduce((sum, { responseBytes }) => sum + responseBytes, 0),
      maximumRangeBytes: rootfsGets.reduce((maximum, { range }) => {
        const parsed = parseExactRange(range, release.rootfs.bytes);
        return Math.max(maximum, parsed?.bytes ?? 0);
      }, 0),
      unboundedGetRequests: rootfsGets.filter(({ range }) => range === null).length,
      exactIfMatchRequests: rootfsGets.filter(({ ifMatch }) => ifMatch === expectedIfMatch).length,
    },
    violations,
    requests: complete,
  };
}

export async function createAcceptanceProxy({ releaseBaseUrl, repositoryRoot = DEFAULT_REPOSITORY_ROOT } = {}) {
  const releaseBase = normalizeLocalReleaseBase(releaseBaseUrl);
  const manifestUrl = new URL("artifact-manifest.json", releaseBase);
  const manifestBody = await fetchBounded(manifestUrl, MAX_MANIFEST_BYTES);
  const releaseId = sha256(manifestBody);
  if (/^0{64}$/.test(releaseId)) throw new Error("Artifact manifest resolved to the unpublished sentinel.");
  const release = inspectArtifactManifest(manifestBody);
  const staticSnapshot = staticFiles(repositoryRoot);
  const records = [];
  let requestId = 0;
  let pending = 0;

  const server = createServer((request, response) => {
    let url;
    try {
      url = new URL(request.url, "http://omarchy-acceptance.invalid");
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
    if (!["GET", "HEAD"].includes(request.method)) {
      sendText(response, 405, "Method not allowed\n");
      return;
    }
    if (pathname === "/") {
      response.writeHead(302, { ...ISOLATION_HEADERS, Location: "/proofs/browser-acceptance/harness.html" });
      response.end();
      return;
    }
    if (pathname === "/favicon.ico") {
      response.writeHead(204, ISOLATION_HEADERS);
      response.end();
      return;
    }
    const staticEntry = staticSnapshot.files.get(pathname);
    if (staticEntry) {
      serveStatic(request, response, staticEntry, pathname);
      return;
    }

    const releasePrefix = `/omarchy/versions/${releaseId}/`;
    if (!pathname.startsWith(releasePrefix)) {
      sendText(response, 404, "Not found\n");
      return;
    }
    const artifactPath = pathname.slice(releasePrefix.length);
    if (artifactPath !== "artifact-manifest.json" && !release.artifacts.has(artifactPath)) {
      sendText(response, 404, "Undeclared release artifact\n");
      return;
    }

    const record = {
      id: ++requestId,
      method: request.method,
      artifactPath,
      range: request.headers.range ?? null,
      ifMatch: request.headers["if-match"] ?? null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      status: null,
      responseBytes: 0,
      declaredContentLength: null,
      contentRange: null,
      etag: null,
      acceptRanges: null,
      aborted: false,
      error: null,
    };
    records.push(record);

    const finish = () => {
      if (record.completedAt !== null) return;
      record.completedAt = new Date().toISOString();
      pending -= 1;
    };
    pending += 1;

    if (artifactPath === "artifact-manifest.json") {
      record.status = 200;
      record.declaredContentLength = manifestBody.byteLength;
      record.etag = `"sha256-${releaseId}"`;
      response.writeHead(200, {
        ...ISOLATION_HEADERS,
        "Cache-Control": "no-store",
        "Content-Length": String(manifestBody.byteLength),
        "Content-Type": "application/json",
        ETag: record.etag,
        "X-Content-Type-Options": "nosniff",
      });
      if (request.method === "HEAD") response.end();
      else {
        record.responseBytes = manifestBody.byteLength;
        response.end(manifestBody);
      }
      finish();
      return;
    }

    const strictRangeArtifact = release.strictRangeArtifacts.find(
      ({ path }) => path === artifactPath,
    );
    if (strictRangeArtifact && request.method === "GET") {
      const range = parseExactRange(request.headers.range, strictRangeArtifact.bytes);
      const expectedIfMatch = `"sha256-${strictRangeArtifact.sha256}"`;
      if (!range || request.headers["if-match"] !== expectedIfMatch) {
        record.status = 412;
        response.writeHead(412, {
          ...ISOLATION_HEADERS,
          "Content-Length": "0",
          ETag: expectedIfMatch,
        });
        response.end();
        finish();
        return;
      }
    }

    const upstreamUrl = new URL(artifactPath, releaseBase);
    const upstreamRequest = requestClient(upstreamUrl).request(upstreamUrl, {
      method: request.method,
      headers: {
        Accept: request.headers.accept ?? "*/*",
        "Accept-Encoding": "identity",
        ...(request.headers.range ? { Range: request.headers.range } : {}),
        ...(request.headers["if-match"] ? { "If-Match": request.headers["if-match"] } : {}),
      },
    });
    upstreamRequest.once("error", (error) => {
      record.error = error.message;
      record.aborted = true;
      if (!response.headersSent) sendText(response, 502, "Release proxy failed\n");
      else response.destroy(error);
      finish();
    });
    upstreamRequest.once("response", (upstream) => {
      record.status = upstream.statusCode;
      record.declaredContentLength = upstream.headers["content-length"] === undefined
        ? null
        : Number(upstream.headers["content-length"]);
      record.contentRange = upstream.headers["content-range"] ?? null;
      record.etag = upstream.headers.etag ?? null;
      record.acceptRanges = upstream.headers["accept-ranges"] ?? null;
      response.writeHead(upstream.statusCode, {
        ...selectedUpstreamHeaders(upstream.headers),
        ...ISOLATION_HEADERS,
        "X-Content-Type-Options": "nosniff",
      });
      upstream.on("data", (chunk) => {
        record.responseBytes += chunk.byteLength;
      });
      upstream.once("aborted", () => {
        record.aborted = true;
      });
      upstream.once("error", (error) => {
        record.error = error.message;
        record.aborted = true;
      });
      upstream.once("end", finish);
      response.once("close", () => {
        if (!response.writableFinished) {
          record.aborted = true;
          upstream.destroy();
          finish();
        }
      });
      upstream.pipe(response);
    });
    upstreamRequest.end();
  });

  return Object.freeze({
    server,
    releaseBaseUrl: releaseBase.href,
    releaseId,
    manifestBody: Buffer.from(manifestBody),
    manifest: release.manifest,
    worker: release.worker,
    rootfs: release.rootfs,
    acceptanceSourceHashes: staticSnapshot.sourceHashes,
    records,
    get pendingRequests() {
      return pending;
    },
    summarizeRequests() {
      return summarizeRequests(records, release);
    },
  });
}

export function listen(server, port = 0) {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolvePromise(`http://127.0.0.1:${address.port}`);
    });
  });
}

export function close(server) {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
    server.closeIdleConnections?.();
  });
}

export function waitForRequestIdle(proxy, { quietMs = 250, timeoutMs = 15_000 } = {}) {
  const started = Date.now();
  let idleSince = null;
  return new Promise((resolvePromise, reject) => {
    const poll = () => {
      if (proxy.pendingRequests === 0) {
        idleSince ??= Date.now();
        if (Date.now() - idleSince >= quietMs) {
          resolvePromise();
          return;
        }
      } else {
        idleSince = null;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Artifact proxy did not become idle within ${timeoutMs}ms.`));
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}
