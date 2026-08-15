const ROUTE_PREFIX = "/omarchy/versions/";
const RELEASE_ID = /^[0-9a-f]{64}$/;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;
const CLEARANCE_TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

export const CLEARANCE_ARTIFACT_NAME = "clearance.json";
export const MAX_CLEARANCE_BYTES = 64 * 1024;

export const MAX_ROOTFS_RANGE_BYTES = 8 * 1024 * 1024;
export const MAX_ARTIFACT_RANGE_BYTES = 64 * 1024 * 1024;
export const MAX_FULL_ARTIFACT_BYTES = 512 * 1024 * 1024;

const ISOLATION_HEADERS = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

// A clearance object is immutable once conditionally created by the release
// pipeline. Cache only successfully verified attestations. Missing, malformed,
// or mismatched objects are deliberately retried so a newly cleared release
// can become visible without recycling the Worker isolate.
const positiveClearanceByBucket = new WeakMap();

class RouteFailure extends Error {
  constructor(status, code, message, headers = undefined) {
    super(message);
    this.name = "RouteFailure";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

function fail(status, code, message, headers) {
  throw new RouteFailure(status, code, message, headers);
}

function releaseNotCleared() {
  fail(404, "RELEASE_NOT_CLEARED", "The requested release has not been cleared for publication.", {
    "X-Omarchy-Artifact-Error": "RELEASE_NOT_CLEARED",
  });
}

function problemResponse(request, status, code, message, extraHeaders = undefined) {
  const headers = new Headers({
    ...ISOLATION_HEADERS,
    "Cache-Control": "no-store",
    "Content-Type": "application/problem+json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  const body = JSON.stringify({ error: code, message });
  return new Response(request.method === "HEAD" ? null : body, { status, headers });
}

function rawPathname(urlString) {
  const authorityStart = urlString.indexOf("://");
  if (authorityStart < 0) return null;
  const pathStart = urlString.indexOf("/", authorityStart + 3);
  if (pathStart < 0) return "/";
  const queryStart = urlString.search(/[?#]/);
  return urlString.slice(pathStart, queryStart >= pathStart ? queryStart : undefined);
}

function parseArtifactRoute(request) {
  const rawPath = rawPathname(request.url);
  const url = new URL(request.url);
  const rawRoute = rawPath?.startsWith(ROUTE_PREFIX) === true;
  const normalizedRoute = url.pathname.startsWith(ROUTE_PREFIX);
  if (!rawRoute && !normalizedRoute) return null;
  if (rawPath !== url.pathname) {
    fail(400, "NON_CANONICAL_URL", "Artifact URLs cannot rely on path normalization.");
  }
  if (url.search || url.hash) {
    fail(400, "NON_CANONICAL_URL", "Artifact URLs cannot include a query or fragment.");
  }

  // Artifact URLs intentionally have a narrow ASCII grammar. In particular,
  // percent escapes are rejected instead of decoded, so encoded dot segments
  // and separators can never be normalized into a different R2 key.
  const remainder = url.pathname.slice(ROUTE_PREFIX.length);
  if (!remainder || remainder.length > 1024 || remainder.includes("%") || remainder.includes("\\")) {
    fail(400, "UNSAFE_ARTIFACT_PATH", "The artifact path is not canonical.");
  }
  const segments = remainder.split("/");
  if (segments.length < 2 || segments.some((segment) => !PATH_SEGMENT.test(segment))) {
    fail(400, "UNSAFE_ARTIFACT_PATH", "The artifact path contains an unsafe segment.");
  }
  const [release, ...artifactSegments] = segments;
  if (!RELEASE_ID.test(release)) {
    fail(400, "INVALID_RELEASE", "The release identifier must be a lowercase hexadecimal content address.");
  }

  const artifactPath = artifactSegments.join("/");
  return Object.freeze({
    release,
    artifactPath,
    key: `omarchy/versions/${release}/${artifactPath}`,
    isRootfs: artifactSegments.at(-1) === "rootfs.ext4",
  });
}

function sha256Base64(hexDigest) {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hexDigest.slice(index * 2, index * 2 + 2), 16);
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function safeContentType(object) {
  const value = object.httpMetadata?.contentType;
  if (
    typeof value === "string" &&
    value.length <= 200 &&
    /^[\x20-\x7e]+$/.test(value) &&
    value.includes("/")
  ) {
    return value;
  }
  return "application/octet-stream";
}

function validateStoredObject(object, expected = undefined) {
  if (!object || typeof object !== "object") {
    fail(502, "INVALID_STORED_OBJECT", "Artifact storage returned invalid object metadata.");
  }
  if (!Number.isSafeInteger(object.size) || object.size <= 0) {
    fail(502, "INVALID_STORED_SIZE", "Artifact storage returned an invalid object size.");
  }
  const digest = object.customMetadata?.sha256;
  if (typeof digest !== "string" || !SHA256.test(digest)) {
    fail(502, "INVALID_DIGEST_METADATA", "The artifact is missing canonical SHA-256 metadata.");
  }
  const declaredBytes = object.customMetadata?.bytes;
  if (declaredBytes !== undefined) {
    if (!DECIMAL_INTEGER.test(declaredBytes) || Number(declaredBytes) !== object.size) {
      fail(502, "STORED_SIZE_MISMATCH", "The artifact size does not match its stored metadata.");
    }
  }
  const encoding = object.httpMetadata?.contentEncoding;
  if (encoding !== undefined && String(encoding).toLowerCase() !== "identity") {
    fail(502, "ENCODED_ARTIFACT", "Stored artifacts must use the identity representation.");
  }
  if (typeof object.etag !== "string" || object.etag.length === 0 || /[\r\n]/.test(object.etag)) {
    fail(502, "INVALID_STORAGE_ETAG", "Artifact storage did not provide a usable object validator.");
  }

  if (expected) {
    if (object.size !== expected.size) {
      fail(502, "STORED_SIZE_MISMATCH", "The artifact changed size while it was being requested.");
    }
    if (digest !== expected.digest || object.etag !== expected.storageEtag) {
      fail(412, "ARTIFACT_CHANGED", "The immutable artifact changed while it was being requested.");
    }
  }

  return Object.freeze({
    size: object.size,
    digest,
    storageEtag: object.etag,
    etag: `"sha256-${digest}"`,
    reprDigest: `sha-256=:${sha256Base64(digest)}:`,
    contentType: safeContentType(object),
  });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function hasControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

function isCanonicalApproval(value) {
  if (!hasExactKeys(value, ["approved", "approvedAt", "approvedBy"])) return false;
  if (value.approved !== true) return false;
  if (
    typeof value.approvedBy !== "string" ||
    value.approvedBy.length === 0 ||
    value.approvedBy.length > 200 ||
    value.approvedBy !== value.approvedBy.trim() ||
    hasControlCharacter(value.approvedBy)
  ) {
    return false;
  }
  if (typeof value.approvedAt !== "string" || !CLEARANCE_TIMESTAMP.test(value.approvedAt)) {
    return false;
  }
  try {
    return new Date(value.approvedAt).toISOString() === value.approvedAt;
  } catch {
    return false;
  }
}

function validateClearanceDocument(value, release) {
  if (!hasExactKeys(value, [
    "schemaVersion",
    "releaseId",
    "artifactManifestSha256",
    "approvalEvidenceSha256",
    "approvalPolicySha256",
    "approvals",
  ])) {
    releaseNotCleared();
  }
  if (
    value.schemaVersion !== 1 ||
    value.releaseId !== release ||
    value.artifactManifestSha256 !== release ||
    !SHA256.test(value.approvalEvidenceSha256 ?? "") ||
    !SHA256.test(value.approvalPolicySha256 ?? "")
  ) {
    releaseNotCleared();
  }
  if (!hasExactKeys(value.approvals, ["licensing", "runtime", "security", "product"])) {
    releaseNotCleared();
  }
  for (const name of ["licensing", "runtime", "security", "product"]) {
    if (!isCanonicalApproval(value.approvals[name])) releaseNotCleared();
  }
  return Object.freeze(value);
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function loadReleaseClearance(bucket, release) {
  let byRelease = positiveClearanceByBucket.get(bucket);
  if (byRelease?.has(release)) return byRelease.get(release);

  const key = `omarchy/versions/${release}/${CLEARANCE_ARTIFACT_NAME}`;
  const object = await getFromBucket(bucket, key, undefined);
  if (!object || !("body" in object) || object.body === undefined || object.body === null) {
    releaseNotCleared();
  }

  let identity;
  try {
    identity = validateStoredObject(object);
  } catch (error) {
    if (error instanceof RouteFailure) releaseNotCleared();
    throw error;
  }
  if (
    identity.size > MAX_CLEARANCE_BYTES ||
    identity.contentType !== "application/json" ||
    object.customMetadata?.bytes !== String(identity.size) ||
    object.range !== undefined
  ) {
    releaseNotCleared();
  }

  let bytes;
  try {
    bytes = await new Response(object.body).arrayBuffer();
  } catch {
    releaseNotCleared();
  }
  if (bytes.byteLength !== identity.size || await sha256Hex(bytes) !== identity.digest) {
    releaseNotCleared();
  }

  let document;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    document = JSON.parse(json);
  } catch {
    releaseNotCleared();
  }
  const clearance = validateClearanceDocument(document, release);
  if (!byRelease) {
    byRelease = new Map();
    positiveClearanceByBucket.set(bucket, byRelease);
  }
  byRelease.set(release, clearance);
  return clearance;
}

function immutableHeaders(identity, contentLength) {
  return new Headers({
    ...ISOLATION_HEADERS,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable, no-transform",
    "Content-Encoding": "identity",
    "Content-Length": String(contentLength),
    "Content-Type": identity.contentType,
    ETag: identity.etag,
    "Repr-Digest": identity.reprDigest,
    "X-Content-Type-Options": "nosniff",
  });
}

function validateClientCondition(request, identity, { required }) {
  const condition = request.headers.get("If-Match");
  if (condition === null) {
    if (required) {
      fail(428, "IF_MATCH_REQUIRED", "Guest disk ranges require the strong ETag returned by HEAD.");
    }
    return;
  }
  if (condition.trim() !== identity.etag) {
    fail(412, "IF_MATCH_FAILED", "If-Match does not identify this immutable artifact.");
  }
}

function parseDecimal(value) {
  if (!DECIMAL_INTEGER.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseSingleRange(header, size, maxBytes) {
  if (typeof header !== "string" || header.includes(",")) {
    fail(416, "SINGLE_RANGE_REQUIRED", "Exactly one byte range is required.", {
      "Content-Range": `bytes */${size}`,
    });
  }
  const match = header.trim().match(/^bytes=([0-9]*)-([0-9]*)$/i);
  if (!match || (!match[1] && !match[2])) {
    fail(416, "INVALID_RANGE", "The byte range is malformed.", {
      "Content-Range": `bytes */${size}`,
    });
  }

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = parseDecimal(match[2]);
    if (!suffixLength || suffixLength > size) {
      fail(416, "UNSATISFIABLE_RANGE", "The suffix range is outside the artifact.", {
        "Content-Range": `bytes */${size}`,
      });
    }
    start = size - suffixLength;
    end = size - 1;
  } else {
    start = parseDecimal(match[1]);
    const requestedEnd = match[2] ? parseDecimal(match[2]) : size - 1;
    if (start === null || requestedEnd === null || start >= size || requestedEnd < start) {
      fail(416, "UNSATISFIABLE_RANGE", "The byte range is outside the artifact.", {
        "Content-Range": `bytes */${size}`,
      });
    }
    end = Math.min(requestedEnd, size - 1);
  }

  const length = end - start + 1;
  if (length > maxBytes) {
    fail(416, "RANGE_TOO_LARGE", `Byte ranges are limited to ${maxBytes} bytes.`, {
      "Content-Range": `bytes */${size}`,
    });
  }
  return Object.freeze({ start, end, length });
}

async function exactRangeBody(body, expectedLength) {
  if (body === undefined || body === null) {
    fail(412, "ARTIFACT_CHANGED", "Artifact storage did not return the requested object generation.");
  }
  let bytes;
  try {
    bytes = await new Response(body).arrayBuffer();
  } catch {
    fail(502, "INVALID_STORED_BODY", "Artifact storage returned an unreadable range body.");
  }
  if (bytes.byteLength !== expectedLength) {
    fail(502, "STORED_SIZE_MISMATCH", "Artifact storage returned the wrong number of range bytes.");
  }
  return bytes;
}

function validateReturnedRange(object, requested) {
  const range = object.range;
  if (
    !range ||
    range.offset !== requested.start ||
    range.length !== requested.length ||
    "suffix" in range
  ) {
    fail(502, "STORED_RANGE_MISMATCH", "Artifact storage returned a different byte range.");
  }
}

async function getFromBucket(bucket, key, options) {
  try {
    return await bucket.get(key, options);
  } catch {
    fail(502, "ARTIFACT_STORAGE_FAILED", "Artifact storage could not complete the request.");
  }
}

async function rangedResponse(request, bucket, route, identity) {
  const rangeHeader = request.headers.get("Range");
  if (route.isRootfs && rangeHeader === null) {
    fail(400, "RANGE_REQUIRED", "The guest root filesystem can only be read through byte ranges.");
  }
  const maxBytes = route.isRootfs ? MAX_ROOTFS_RANGE_BYTES : MAX_ARTIFACT_RANGE_BYTES;
  const selected = parseSingleRange(rangeHeader, identity.size, maxBytes);
  if (route.isRootfs && selected.length === identity.size) {
    fail(416, "FULL_DISK_RANGE_FORBIDDEN", "A guest root filesystem request cannot select the full object.", {
      "Content-Range": `bytes */${identity.size}`,
    });
  }
  validateClientCondition(request, identity, { required: route.isRootfs });

  const object = await getFromBucket(bucket, route.key, {
    range: { offset: selected.start, length: selected.length },
    onlyIf: { etagMatches: identity.storageEtag },
  });
  if (!object || !("body" in object) || object.body === undefined || object.body === null) {
    fail(412, "ARTIFACT_CHANGED", "The immutable artifact changed while it was being requested.");
  }
  validateStoredObject(object, identity);
  validateReturnedRange(object, selected);
  const body = await exactRangeBody(object.body, selected.length);
  const headers = immutableHeaders(identity, selected.length);
  headers.set("Content-Range", `bytes ${selected.start}-${selected.end}/${identity.size}`);
  return new Response(body, { status: 206, headers });
}

function knownBodyLength(body) {
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  return null;
}

async function fullArtifactResponse(request, bucket, route, identity) {
  if (identity.size > MAX_FULL_ARTIFACT_BYTES) {
    fail(413, "ARTIFACT_TOO_LARGE", "This artifact must be fetched through bounded byte ranges.");
  }
  validateClientCondition(request, identity, { required: false });
  const object = await getFromBucket(bucket, route.key, {
    onlyIf: { etagMatches: identity.storageEtag },
  });
  if (!object || !("body" in object) || object.body === undefined || object.body === null) {
    fail(412, "ARTIFACT_CHANGED", "The immutable artifact changed while it was being requested.");
  }
  validateStoredObject(object, identity);
  if (object.range !== undefined) {
    fail(502, "STORED_RANGE_MISMATCH", "Artifact storage unexpectedly returned a partial object.");
  }
  const bodyLength = knownBodyLength(object.body);
  if (bodyLength !== null && bodyLength !== identity.size) {
    fail(502, "STORED_SIZE_MISMATCH", "Artifact storage returned the wrong number of bytes.");
  }
  return new Response(object.body, { status: 200, headers: immutableHeaders(identity, identity.size) });
}

/**
 * Serve an immutable release artifact, or return null when the request belongs
 * to the vinext application. The bucket key is the canonical URL path without
 * its leading slash.
 */
export async function handleArtifactRequest(request, bucket) {
  let route;
  try {
    route = parseArtifactRoute(request);
    if (route === null) return null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      fail(405, "METHOD_NOT_ALLOWED", "Artifact routes support GET and HEAD only.", {
        Allow: "GET, HEAD",
      });
    }
    if (!bucket || typeof bucket.head !== "function" || typeof bucket.get !== "function") {
      fail(503, "ARTIFACT_STORAGE_UNAVAILABLE", "Artifact storage is not configured.");
    }

    // The clearance body is the sole publication boundary. This check must
    // complete before even reading target artifact metadata: partially
    // uploaded canonical objects remain unreachable through GET, HEAD, or
    // Range until the immutable attestation exists and matches this release.
    await loadReleaseClearance(bucket, route.release);

    let head;
    try {
      head = await bucket.head(route.key);
    } catch {
      fail(502, "ARTIFACT_STORAGE_FAILED", "Artifact storage could not complete the request.");
    }
    if (head === null) {
      fail(404, "ARTIFACT_NOT_FOUND", "The requested release artifact does not exist.");
    }
    const identity = validateStoredObject(head);
    validateClientCondition(request, identity, { required: false });

    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers: immutableHeaders(identity, identity.size) });
    }
    if (request.headers.has("Range") || route.isRootfs) {
      return await rangedResponse(request, bucket, route, identity);
    }
    return await fullArtifactResponse(request, bucket, route, identity);
  } catch (error) {
    if (error instanceof RouteFailure) {
      return problemResponse(request, error.status, error.code, error.message, error.headers);
    }
    return problemResponse(request, 500, "ARTIFACT_ROUTE_FAILED", "The artifact route failed closed.");
  }
}
