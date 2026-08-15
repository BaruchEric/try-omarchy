const TICKET = Symbol("omarchy.paged-disk.preflight");

export const PAGED_DISK_SCHEMA_VERSION = 1;
export const DEFAULT_GUEST_DISK_PATH = "/pack/rootfs.ext4";
export const DEFAULT_CHUNK_BYTES = 1024 * 1024;
export const DEFAULT_MAX_CACHED_BYTES = 128 * 1024 * 1024;

const SHA256 = /^[0-9a-f]{64}$/;
const STRONG_ETAG = /^"[^"\r\n]+"$/;
const MIN_CHUNK_BYTES = 64 * 1024;
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = DEFAULT_MAX_CACHED_BYTES;

export class PagedDiskError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "PagedDiskError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new PagedDiskError(code, message, details);
}

function isPowerOfTwo(value) {
  return value > 0 && (value & (value - 1)) === 0;
}

function header(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? null : String(headers[key]);
}

function normalizePath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value === "/" || value.endsWith("/")) {
    fail("INVALID_PATH", "The guest disk path must be an absolute file path.");
  }
  if (value.includes("\\") || value.includes("\0") || value.split("/").includes("..")) {
    fail("INVALID_PATH", "The guest disk path contains an unsafe segment.");
  }
  return value;
}

function splitPath(value) {
  const slash = value.lastIndexOf("/");
  return {
    parent: slash === 0 ? "/" : value.slice(0, slash),
    name: value.slice(slash + 1),
  };
}

function normalizeUrl(value, { baseUrl, origin } = {}) {
  let url;
  try {
    url = new URL(value, baseUrl);
  } catch {
    fail("INVALID_URL", "The guest disk URL is invalid.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    fail("INVALID_URL", "The guest disk URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password || url.hash) {
    fail("INVALID_URL", "The guest disk URL must not contain credentials or a fragment.");
  }

  const expectedOrigin = origin ?? (baseUrl ? new URL(baseUrl).origin : globalThis.location?.origin);
  if (!expectedOrigin) {
    fail("MISSING_ORIGIN", "An expected same-origin base URL is required outside a browser.");
  }
  if (url.origin !== new URL(expectedOrigin).origin) {
    fail("CROSS_ORIGIN", "The guest disk must be served from the page origin.", {
      expected: new URL(expectedOrigin).origin,
      actual: url.origin,
    });
  }
  return url.href;
}

function sha256Base64(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  if (typeof btoa === "function") return btoa(binary);
  // This branch is for non-browser test runners that do not expose btoa.
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  fail("UNSUPPORTED_DIGEST", "This environment cannot encode a SHA-256 digest.");
}

function parseStructuredDigest(value, algorithm = "sha-256") {
  if (!value) return null;
  for (const member of String(value).split(",")) {
    const match = member.trim().match(/^([A-Za-z0-9_-]+)\s*=\s*:([A-Za-z0-9+/]+={0,2}):(?:\s*;.*)?$/);
    if (match && match[1].toLowerCase() === algorithm) return match[2];
  }
  return null;
}

function derivedEtag(sha256) {
  return sha256 ? `"sha256-${sha256}"` : null;
}

function validateIdentityHeaders(headers, descriptor, stage) {
  const actualEtag = header(headers, "etag");
  const reprDigest = parseStructuredDigest(header(headers, "repr-digest"));
  const expectedDigest = descriptor.sha256 ? sha256Base64(descriptor.sha256) : null;

  if (actualEtag?.startsWith("W/")) {
    fail("WEAK_ETAG", `${stage} returned a weak ETag for an immutable disk.`);
  }
  if (descriptor.etag && actualEtag !== descriptor.etag) {
    fail("IDENTITY_MISMATCH", `${stage} ETag does not match the release manifest.`, {
      expected: descriptor.etag,
      actual: actualEtag,
    });
  }
  if (reprDigest && descriptor.sha256 && reprDigest !== expectedDigest) {
    fail("IDENTITY_MISMATCH", `${stage} Repr-Digest does not match the release manifest.`);
  }

  const etagMatches = descriptor.etag
    ? actualEtag === descriptor.etag
    : descriptor.sha256 && actualEtag === derivedEtag(descriptor.sha256);
  const digestMatches = Boolean(descriptor.sha256 && reprDigest === expectedDigest);
  if (!etagMatches && !digestMatches) {
    fail(
      "MISSING_IDENTITY",
      `${stage} did not return a matching strong ETag or Repr-Digest.`,
      { expectedEtag: descriptor.etag ?? derivedEtag(descriptor.sha256) },
    );
  }
  return Object.freeze({
    etag: etagMatches ? actualEtag : null,
    reprDigest: digestMatches ? reprDigest : null,
  });
}

function validateEncoding(headers, stage) {
  const encoding = header(headers, "content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") {
    fail("ENCODED_DISK", `${stage} applied Content-Encoding ${encoding}; byte ranges require identity bytes.`);
  }
}

function parseIntegerHeader(headers, name, stage) {
  const value = header(headers, name);
  if (!/^(0|[1-9][0-9]*)$/.test(value ?? "")) {
    fail("INVALID_LENGTH", `${stage} returned an invalid ${name} header.`, { actual: value });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    fail("INVALID_LENGTH", `${stage} returned a ${name} value outside JavaScript's safe integer range.`);
  }
  return parsed;
}

function validateHead(response, descriptor) {
  if (!response || response.ok !== true) {
    fail("HEAD_FAILED", `Guest disk HEAD failed with HTTP ${response?.status ?? "unknown"}.`);
  }
  validateEncoding(response.headers, "Guest disk HEAD");
  const byteLength = parseIntegerHeader(response.headers, "content-length", "Guest disk HEAD");
  if (byteLength !== descriptor.byteLength) {
    fail("LENGTH_MISMATCH", "Guest disk length does not match the release manifest.", {
      expected: descriptor.byteLength,
      actual: byteLength,
    });
  }
  const ranges = header(response.headers, "accept-ranges");
  if (!ranges || !ranges.split(",").some((value) => value.trim().toLowerCase() === "bytes")) {
    fail("RANGE_UNSUPPORTED", "Guest disk server did not advertise byte range support.");
  }
  return validateIdentityHeaders(response.headers, descriptor, "Guest disk HEAD");
}

function validateRangeHeaders({ status, headers, responseUrl }, descriptor, start, end, stage) {
  if (status !== 206) {
    fail("RANGE_IGNORED", `${stage} must return HTTP 206, not ${status}.`);
  }
  validateEncoding(headers, stage);
  const contentRange = header(headers, "content-range");
  const match = contentRange?.match(/^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/i);
  if (!match) {
    fail("INVALID_CONTENT_RANGE", `${stage} returned an invalid Content-Range header.`, { actual: contentRange });
  }
  const actualStart = Number(match[1]);
  const actualEnd = Number(match[2]);
  const actualTotal = Number(match[3]);
  if (actualStart !== start || actualEnd !== end || actualTotal !== descriptor.byteLength) {
    fail("INVALID_CONTENT_RANGE", `${stage} returned bytes outside the requested immutable range.`, {
      expected: `bytes ${start}-${end}/${descriptor.byteLength}`,
      actual: contentRange,
    });
  }
  const contentLength = parseIntegerHeader(headers, "content-length", stage);
  if (contentLength !== end - start + 1) {
    fail("INVALID_LENGTH", `${stage} returned the wrong number of bytes.`, {
      expected: end - start + 1,
      actual: contentLength,
    });
  }
  if (responseUrl && new URL(responseUrl).href !== descriptor.url) {
    fail("REDIRECTED_DISK", `${stage} redirected the immutable disk request.`);
  }
  return validateIdentityHeaders(headers, descriptor, stage);
}

async function cancelBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The caller is already failing closed; cancellation is best-effort.
  }
}

export function validatePagedDiskDescriptor(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("INVALID_DESCRIPTOR", "Paged disk descriptor must be an object.");
  }
  if ((input.schemaVersion ?? PAGED_DISK_SCHEMA_VERSION) !== PAGED_DISK_SCHEMA_VERSION) {
    fail("INVALID_DESCRIPTOR", `Unsupported paged disk schema ${input.schemaVersion}.`);
  }

  const byteLength = input.byteLength ?? input.bytes;
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    fail("INVALID_DESCRIPTOR", "Guest disk byteLength must be a positive safe integer.");
  }
  const etag = input.etag ?? null;
  if (etag !== null && (!STRONG_ETAG.test(etag) || etag.startsWith("W/"))) {
    fail("INVALID_DESCRIPTOR", "Guest disk ETag must be a quoted strong ETag.");
  }
  const sha256 = input.sha256?.toLowerCase() ?? null;
  if (sha256 !== null && !SHA256.test(sha256)) {
    fail("INVALID_DESCRIPTOR", "Guest disk sha256 must contain exactly 64 hexadecimal characters.");
  }
  if (!etag && !sha256) {
    fail("INVALID_DESCRIPTOR", "Guest disk metadata must include a strong ETag or SHA-256 digest.");
  }

  const chunkBytes = input.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  if (
    !Number.isSafeInteger(chunkBytes) ||
    !isPowerOfTwo(chunkBytes) ||
    chunkBytes < MIN_CHUNK_BYTES ||
    chunkBytes > MAX_CHUNK_BYTES
  ) {
    fail("INVALID_DESCRIPTOR", "chunkBytes must be a power of two from 64 KiB through 8 MiB.");
  }
  const maxCachedBytes = input.maxCachedBytes ?? DEFAULT_MAX_CACHED_BYTES;
  if (
    !Number.isSafeInteger(maxCachedBytes) ||
    maxCachedBytes < chunkBytes ||
    maxCachedBytes > MAX_CACHE_BYTES ||
    maxCachedBytes % chunkBytes !== 0
  ) {
    fail("INVALID_DESCRIPTOR", "maxCachedBytes must be a chunk-aligned value no larger than 128 MiB.");
  }

  return Object.freeze({
    schemaVersion: PAGED_DISK_SCHEMA_VERSION,
    path: normalizePath(input.path ?? DEFAULT_GUEST_DISK_PATH),
    url: normalizeUrl(input.url, options),
    byteLength,
    etag,
    sha256,
    chunkBytes,
    maxCachedBytes,
    maxCachedChunks: maxCachedBytes / chunkBytes,
  });
}

/**
 * Verify the immutable object before Emscripten starts. This method performs
 * one HEAD and one one-byte ranged GET. It never issues an un-ranged GET.
 */
export async function preflightPagedDisk(input, options = {}) {
  const descriptor = validatePagedDiskDescriptor(input, options);
  const scope = options.scope ?? globalThis;
  const fetchFunction = options.fetch ?? scope.fetch;
  if (typeof fetchFunction !== "function") {
    fail("FETCH_UNAVAILABLE", "fetch is required for the paged disk preflight.");
  }
  const fetcher = fetchFunction.bind(scope);
  const requests = [];
  const common = {
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    signal: options.signal,
  };

  const headRequest = { method: "HEAD", range: null };
  requests.push(headRequest);
  let head;
  let validatorEtag = null;
  try {
    head = await fetcher(descriptor.url, { ...common, method: "HEAD" });
    headRequest.status = head.status;
    validatorEtag = validateHead(head, descriptor).etag;
    await cancelBody(head);
  } catch (error) {
    headRequest.error = error instanceof Error ? error.message : String(error);
    throw error;
  }

  const range = "bytes=0-0";
  const probeRequest = { method: "GET", range };
  requests.push(probeRequest);
  let probe;
  try {
    const headers = { Range: range };
    if (validatorEtag) headers["If-Match"] = validatorEtag;
    probe = await fetcher(descriptor.url, { ...common, method: "GET", headers });
    probeRequest.status = probe.status;
    try {
      validateRangeHeaders(
        { status: probe.status, headers: probe.headers, responseUrl: probe.url },
        descriptor,
        0,
        0,
        "Guest disk range probe",
      );
    } catch (error) {
      await cancelBody(probe);
      throw error;
    }
    const bytes = new Uint8Array(await probe.arrayBuffer());
    if (bytes.byteLength !== 1) {
      fail("INVALID_LENGTH", "Guest disk range probe body was not exactly one byte.");
    }
    probeRequest.responseBytes = bytes.byteLength;
  } catch (error) {
    probeRequest.error = error instanceof Error ? error.message : String(error);
    throw error;
  }

  const audit = Object.freeze({
    requests: Object.freeze(requests.map((request) => Object.freeze({ ...request }))),
    rangedGetCount: 1,
    unRangedGetCount: 0,
    responseBytes: 1,
  });
  return Object.freeze({
    [TICKET]: true,
    descriptor,
    audit,
    validatorEtag,
  });
}

function errno(fs, name, fallback) {
  const code = fs?.ERRNO_CODES?.[name] ?? fallback;
  return new fs.ErrnoError(code);
}

function assertWorkerRuntime(scope) {
  if (scope?.document) {
    fail(
      "WINDOW_RUNTIME_UNSUPPORTED",
      "Paged disk mounting must run in the outer Emscripten Worker; synchronous range XHR is not allowed on Window.",
    );
  }
  if (typeof scope?.XMLHttpRequest !== "function") {
    fail("XHR_UNAVAILABLE", "The outer Emscripten Worker must provide XMLHttpRequest.");
  }
}

function xhrHeaders(xhr) {
  return {
    get(name) {
      return xhr.getResponseHeader(name);
    },
  };
}

/**
 * Turn a successful async preflight ticket into a synchronous Emscripten
 * preRun hook. The hook must execute in the same dedicated Worker that owns
 * the Emscripten runtime and its pthread FS.
 */
export function createPagedDiskPreRun(ticket, options = {}) {
  if (!ticket?.[TICKET]) {
    fail("PREFLIGHT_REQUIRED", "A successful paged disk preflight ticket is required.");
  }
  const descriptor = ticket.descriptor;
  const scope = options.scope ?? globalThis;
  const onRequest = typeof options.onRequest === "function" ? options.onRequest : () => {};
  const state = {
    mounted: false,
    rangeRequests: 0,
    unRangedGetCount: 0,
    requestedBytes: 0,
    cacheBytes: 0,
    evictions: 0,
    writeAttempts: 0,
    streamReadCalls: 0,
    streamReadChunks: 0,
    streamReadBytes: 0,
    lruTouches: 0,
    loadedChunks: new Map(),
    node: null,
  };

  function requestChunk(chunkNumber) {
    const start = chunkNumber * descriptor.chunkBytes;
    if (!Number.isSafeInteger(chunkNumber) || chunkNumber < 0 || start >= descriptor.byteLength) {
      fail("INVALID_CHUNK", `Invalid guest disk chunk ${chunkNumber}.`);
    }
    const end = Math.min(start + descriptor.chunkBytes, descriptor.byteLength) - 1;
    const range = `bytes=${start}-${end}`;
    const xhr = new scope.XMLHttpRequest();
    let headerFailure = null;
    let responseMeta = null;

    xhr.onreadystatechange = () => {
      if (xhr.readyState !== 2 || headerFailure) return;
      responseMeta = {
        status: xhr.status,
        headers: xhrHeaders(xhr),
        responseUrl: xhr.responseURL,
      };
      try {
        validateRangeHeaders(responseMeta, descriptor, start, end, `Guest disk chunk ${chunkNumber}`);
      } catch (error) {
        headerFailure = error;
        xhr.abort();
      }
    };
    xhr.open("GET", descriptor.url, false);
    xhr.responseType = "arraybuffer";
    xhr.setRequestHeader("Range", range);
    if (ticket.validatorEtag) xhr.setRequestHeader("If-Match", ticket.validatorEtag);

    try {
      xhr.send(null);
    } catch (error) {
      if (headerFailure) throw headerFailure;
      fail("RANGE_REQUEST_FAILED", `Guest disk chunk ${chunkNumber} request failed.`, {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    if (headerFailure) throw headerFailure;
    validateRangeHeaders(
      responseMeta ?? { status: xhr.status, headers: xhrHeaders(xhr), responseUrl: xhr.responseURL },
      descriptor,
      start,
      end,
      `Guest disk chunk ${chunkNumber}`,
    );
    if (!(xhr.response instanceof ArrayBuffer)) {
      fail("INVALID_BODY", `Guest disk chunk ${chunkNumber} did not return an ArrayBuffer.`);
    }
    const bytes = new Uint8Array(xhr.response);
    if (bytes.byteLength !== end - start + 1) {
      fail("INVALID_LENGTH", `Guest disk chunk ${chunkNumber} body length is invalid.`);
    }
    state.rangeRequests += 1;
    state.requestedBytes += bytes.byteLength;
    onRequest(Object.freeze({ method: "GET", range, status: xhr.status, responseBytes: bytes.byteLength }));
    return bytes;
  }

  function snapshot() {
    return Object.freeze({
      mounted: state.mounted,
      path: descriptor.path,
      byteLength: descriptor.byteLength,
      chunkBytes: descriptor.chunkBytes,
      maxCachedBytes: descriptor.maxCachedBytes,
      rangeRequests: state.rangeRequests,
      unRangedGetCount: state.unRangedGetCount,
      requestedBytes: state.requestedBytes,
      cacheBytes: state.cacheBytes,
      loadedChunks: [...state.loadedChunks.keys()].sort((left, right) => left - right),
      evictions: state.evictions,
      writeAttempts: state.writeAttempts,
      streamReadCalls: state.streamReadCalls,
      streamReadChunks: state.streamReadChunks,
      streamReadBytes: state.streamReadBytes,
      lruTouches: state.lruTouches,
    });
  }

  function preRun(module) {
    if (state.mounted) fail("ALREADY_MOUNTED", `Guest disk is already mounted at ${descriptor.path}.`);
    assertWorkerRuntime(scope);
    const fs = module?.FS;
    if (!fs?.mkdirTree || !fs?.createLazyFile || !fs?.ErrnoError) {
      fail("EMSCRIPTEN_FS_UNAVAILABLE", "QEMU must export Emscripten FS and FS.createLazyFile.");
    }

    const { parent, name } = splitPath(descriptor.path);
    fs.mkdirTree(parent);
    if (fs.analyzePath?.(descriptor.path)?.exists) {
      fail("PATH_EXISTS", `Refusing to replace existing Emscripten path ${descriptor.path}.`);
    }
    const node = fs.createLazyFile(parent, name, descriptor.url, true, false);
    const lazy = node?.contents;
    if (
      !lazy ||
      !Array.isArray(lazy.chunks) ||
      typeof lazy.setDataGetter !== "function" ||
      typeof node.stream_ops?.read !== "function"
    ) {
      fail(
        "INCOMPATIBLE_EMSCRIPTEN",
        "Emscripten FS.createLazyFile internals do not match the pinned 3.1.50 adapter.",
      );
    }

    // Avoid Emscripten's implicit synchronous HEAD and permissive range getter.
    // The asynchronous preflight already established immutable length/identity.
    lazy.lengthKnown = true;
    lazy._length = descriptor.byteLength;
    lazy._chunkSize = descriptor.chunkBytes;
    lazy.chunks.length = Math.ceil(descriptor.byteLength / descriptor.chunkBytes);

    let lastTouchedChunk = -1;
    const touch = (chunkNumber, bytes) => {
      // A byte-oriented LazyUint8Array read calls its getter for every byte.
      // Consecutive accesses to one chunk cannot change its relative recency,
      // so mutate the LRU only when the accessed chunk changes.
      if (lastTouchedChunk === chunkNumber) return;
      if (state.loadedChunks.has(chunkNumber)) state.loadedChunks.delete(chunkNumber);
      state.loadedChunks.set(chunkNumber, bytes);
      lastTouchedChunk = chunkNumber;
      state.lruTouches += 1;
    };
    const evict = (protectedChunk) => {
      while (state.loadedChunks.size > descriptor.maxCachedChunks) {
        const candidate = state.loadedChunks.keys().next().value;
        if (candidate === protectedChunk) {
          const bytes = state.loadedChunks.get(candidate);
          state.loadedChunks.delete(candidate);
          state.loadedChunks.set(candidate, bytes);
          continue;
        }
        const bytes = state.loadedChunks.get(candidate);
        state.loadedChunks.delete(candidate);
        lazy.chunks[candidate] = undefined;
        state.cacheBytes -= bytes.byteLength;
        state.evictions += 1;
      }
    };
    const getChunk = (chunkNumber) => {
      let bytes = state.loadedChunks.get(chunkNumber);
      if (bytes) {
        touch(chunkNumber, bytes);
        return bytes;
      }
      bytes = requestChunk(chunkNumber);
      lazy.chunks[chunkNumber] = bytes;
      state.cacheBytes += bytes.byteLength;
      touch(chunkNumber, bytes);
      evict(chunkNumber);
      return bytes;
    };
    lazy.setDataGetter(getChunk);

    // Emscripten 3.1.50's createLazyFile stream reader copies through
    // LazyUint8Array.get() one byte at a time. Besides the JavaScript call
    // overhead, a naive cache getter therefore mutates an LRU Map once per
    // byte. QEMU issues ordinary FS stream reads, so replace that one hot path
    // with chunk-granular typed-array copies while retaining the lazy getter
    // for the pinned runtime's mmap and compatibility paths.
    node.stream_ops.read = (_stream, buffer, offset, length, position) => {
      state.streamReadCalls += 1;
      if (length <= 0 || position >= descriptor.byteLength) return 0;

      const readBytes = Math.min(length, descriptor.byteLength - position);
      let sourcePosition = position;
      let targetOffset = offset;
      let remaining = readBytes;

      while (remaining > 0) {
        const chunkNumber = Math.floor(sourcePosition / descriptor.chunkBytes);
        const chunkOffset = sourcePosition - chunkNumber * descriptor.chunkBytes;
        const chunk = getChunk(chunkNumber);
        const copyBytes = Math.min(remaining, chunk.byteLength - chunkOffset);
        const source = chunk.subarray(chunkOffset, chunkOffset + copyBytes);

        if (typeof buffer.set === "function") {
          buffer.set(source, targetOffset);
        } else {
          for (let index = 0; index < copyBytes; index += 1) {
            buffer[targetOffset + index] = source[index];
          }
        }

        state.streamReadChunks += 1;
        sourcePosition += copyBytes;
        targetOffset += copyBytes;
        remaining -= copyBytes;
      }

      state.streamReadBytes += readBytes;
      return readBytes;
    };

    const rejectWrite = () => {
      state.writeAttempts += 1;
      throw errno(fs, "EROFS", 30);
    };
    node.stream_ops.write = rejectWrite;
    node.stream_ops.allocate = rejectWrite;
    node.mode &= ~0o222;
    state.node = node;
    state.mounted = true;
    return node;
  }

  Object.defineProperties(preRun, {
    descriptor: { value: descriptor, enumerable: true },
    preflightAudit: { value: ticket.audit, enumerable: true },
    snapshot: { value: snapshot, enumerable: true },
  });
  return preRun;
}

export function qemuPagedDiskArguments(path = DEFAULT_GUEST_DISK_PATH) {
  const diskPath = normalizePath(path);
  if (diskPath.includes(",")) fail("INVALID_PATH", "QEMU drive paths must not contain commas.");
  return Object.freeze([
    "-snapshot",
    "-drive",
    `file=${diskPath},if=virtio,format=raw,media=disk,cache=unsafe`,
  ]);
}

/** Prepare the descriptor and return the exact hook/argument integration. */
export async function preparePagedDisk(input, options = {}) {
  const ticket = await preflightPagedDisk(input, options);
  const preRun = createPagedDiskPreRun(ticket, options);
  return Object.freeze({
    descriptor: ticket.descriptor,
    preflight: ticket.audit,
    preRun,
    qemuArguments: qemuPagedDiskArguments(ticket.descriptor.path),
    snapshot: preRun.snapshot,
  });
}
