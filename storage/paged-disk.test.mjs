import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_CACHED_BYTES,
  DEFAULT_GUEST_DISK_PATH,
  PagedDiskError,
  createPagedDiskPreRun,
  preflightPagedDisk,
  preparePagedDisk,
  qemuPagedDiskArguments,
  validatePagedDiskDescriptor,
} from "./paged-disk.mjs";
import { DEFAULT_MAX_OVERLAY_BYTES } from "./bounded-overlay.mjs";

const ORIGIN = "https://demo.example";
const URL = `${ORIGIN}/omarchy/releases/f0020448/rootfs.ext4`;
const SHA256 = "ab".repeat(32);
const ETAG = `"sha256-${SHA256}"`;
const BYTE_LENGTH = 3 * 64 * 1024 + 7;

function headers({
  length = BYTE_LENGTH,
  etag = ETAG,
  range = null,
  acceptRanges = "bytes",
  encoding = null,
  reprDigest = null,
} = {}) {
  const result = new Headers({
    "Content-Length": String(length),
  });
  if (etag !== null) result.set("ETag", etag);
  if (acceptRanges !== null) result.set("Accept-Ranges", acceptRanges);
  if (range !== null) result.set("Content-Range", range);
  if (encoding !== null) result.set("Content-Encoding", encoding);
  if (reprDigest !== null) result.set("Repr-Digest", reprDigest);
  return result;
}

function response({ status, responseHeaders, bytes = new Uint8Array(0), url = URL, onCancel } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: responseHeaders,
    url,
    body: { async cancel() { onCancel?.(); } },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function descriptor(overrides = {}) {
  return {
    schemaVersion: 1,
    path: DEFAULT_GUEST_DISK_PATH,
    url: URL,
    byteLength: BYTE_LENGTH,
    sha256: SHA256,
    chunkBytes: 64 * 1024,
    maxCachedBytes: 2 * 64 * 1024,
    ...overrides,
  };
}

function successfulFetch(log = [], byteLength = BYTE_LENGTH) {
  return async (url, options) => {
    log.push({ url, ...options, headers: { ...options.headers } });
    if (options.method === "HEAD") {
      return response({ status: 200, responseHeaders: headers({ length: byteLength }) });
    }
    return response({
      status: 206,
      responseHeaders: headers({ length: 1, range: `bytes 0-0/${byteLength}` }),
      bytes: Uint8Array.of(0),
    });
  };
}

test("normalizes a same-origin immutable release descriptor", () => {
  assert.deepEqual(
    validatePagedDiskDescriptor(descriptor(), { origin: ORIGIN }),
    {
      schemaVersion: 1,
      path: DEFAULT_GUEST_DISK_PATH,
      url: URL,
      byteLength: BYTE_LENGTH,
      etag: null,
      sha256: SHA256,
      chunkBytes: 64 * 1024,
      maxCachedBytes: 2 * 64 * 1024,
      maxCachedChunks: 2,
    },
  );
});

test("rejects cross-origin, traversal, weak identity, and unsafe cache metadata", () => {
  assert.throws(
    () => validatePagedDiskDescriptor(descriptor({ url: "https://cdn.example/rootfs.ext4" }), { origin: ORIGIN }),
    (error) => error instanceof PagedDiskError && error.code === "CROSS_ORIGIN",
  );
  assert.throws(
    () => validatePagedDiskDescriptor(descriptor({ path: "/pack/../rootfs.ext4" }), { origin: ORIGIN }),
    (error) => error.code === "INVALID_PATH",
  );
  assert.throws(
    () => validatePagedDiskDescriptor(descriptor({ sha256: null, etag: 'W/"mutable"' }), { origin: ORIGIN }),
    (error) => error.code === "INVALID_DESCRIPTOR",
  );
  assert.throws(
    () => validatePagedDiskDescriptor(descriptor({ maxCachedBytes: 65 * 1024 }), { origin: ORIGIN }),
    (error) => error.code === "INVALID_DESCRIPTOR",
  );
  assert.throws(
    () => validatePagedDiskDescriptor(descriptor({ maxCachedBytes: 129 * 1024 * 1024 }), { origin: ORIGIN }),
    (error) => error.code === "INVALID_DESCRIPTOR" && /128 MiB/.test(error.message),
  );
});

test("defaults and caps the clean cache at 128 MiB for the browser process budget", () => {
  const mebibyte = 1024 * 1024;
  const processBudget = 2560 * mebibyte;
  const productionWasmHeap = 2300 * mebibyte;
  const input = descriptor();
  delete input.chunkBytes;
  delete input.maxCachedBytes;
  const normalized = validatePagedDiskDescriptor(input, { origin: ORIGIN });

  assert.equal(DEFAULT_MAX_CACHED_BYTES, 128 * mebibyte);
  assert.equal(processBudget - productionWasmHeap - DEFAULT_MAX_CACHED_BYTES, 132 * mebibyte);
  assert.equal(normalized.maxCachedBytes, DEFAULT_MAX_CACHED_BYTES);
  assert.equal(normalized.maxCachedChunks, 128);
  assert.equal(
    validatePagedDiskDescriptor(
      descriptor({ maxCachedBytes: DEFAULT_MAX_CACHED_BYTES }),
      { origin: ORIGIN },
    ).maxCachedBytes,
    DEFAULT_MAX_CACHED_BYTES,
  );
});

test("preflight performs HEAD plus a one-byte ranged GET and no whole-file GET", async () => {
  const requests = [];
  const ticket = await preflightPagedDisk(descriptor(), {
    origin: ORIGIN,
    fetch: successfulFetch(requests),
    scope: {},
  });

  assert.deepEqual(requests.map(({ method, headers: requestHeaders }) => ({
    method,
    range: requestHeaders.Range ?? null,
    ifMatch: requestHeaders["If-Match"] ?? null,
  })), [
    { method: "HEAD", range: null, ifMatch: null },
    { method: "GET", range: "bytes=0-0", ifMatch: ETAG },
  ]);
  assert.deepEqual(ticket.audit, {
    requests: [
      { method: "HEAD", range: null, status: 200 },
      { method: "GET", range: "bytes=0-0", status: 206, responseBytes: 1 },
    ],
    rangedGetCount: 1,
    unRangedGetCount: 0,
    responseBytes: 1,
  });
});

test("a matching Repr-Digest works without inventing an If-Match ETag", async () => {
  const reprDigest = `sha-256=:${Buffer.from(SHA256, "hex").toString("base64")}:`;
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ url, ...options, headers: { ...options.headers } });
    return options.method === "HEAD"
      ? response({ status: 200, responseHeaders: headers({ etag: null, reprDigest }) })
      : response({
        status: 206,
        responseHeaders: headers({
          etag: null,
          reprDigest,
          length: 1,
          range: `bytes 0-0/${BYTE_LENGTH}`,
        }),
        bytes: Uint8Array.of(0),
      });
  };
  const ticket = await preflightPagedDisk(descriptor(), { origin: ORIGIN, fetch, scope: {} });
  assert.equal(requests[1].headers.Range, "bytes=0-0");
  assert.equal(requests[1].headers["If-Match"], undefined);
  assert.equal(ticket.audit.unRangedGetCount, 0);

  const disk = new Uint8Array(BYTE_LENGTH);
  const xhrRequests = [];
  const scope = fakeXhrScope(disk, xhrRequests, { etag: null, reprDigest });
  const hook = createPagedDiskPreRun(ticket, { scope });
  const fs = fakeFs();
  hook({ FS: fs });
  assert.equal(fs.node.contents.get(0), 0);
  assert.equal(xhrRequests[0].ifMatch, null);
});

test("preflight fails closed when Range is ignored and cancels before reading the body", async () => {
  let cancelled = false;
  let arrayBufferRead = false;
  const fetch = async (_url, options) => {
    if (options.method === "HEAD") return response({ status: 200, responseHeaders: headers() });
    const result = response({
      status: 200,
      responseHeaders: headers(),
      onCancel: () => { cancelled = true; },
    });
    result.arrayBuffer = async () => {
      arrayBufferRead = true;
      throw new Error("must not read an ignored-range response");
    };
    return result;
  };

  await assert.rejects(
    preflightPagedDisk(descriptor(), { origin: ORIGIN, fetch, scope: {} }),
    (error) => error.code === "RANGE_IGNORED",
  );
  assert.equal(cancelled, true);
  assert.equal(arrayBufferRead, false);
});

test("preflight rejects incorrect size, encoding, identity, and Content-Range", async (t) => {
  const cases = [
    {
      name: "size",
      fetch: async () => response({ status: 200, responseHeaders: headers({ length: BYTE_LENGTH + 1 }) }),
      code: "LENGTH_MISMATCH",
    },
    {
      name: "encoding",
      fetch: async () => response({ status: 200, responseHeaders: headers({ encoding: "gzip" }) }),
      code: "ENCODED_DISK",
    },
    {
      name: "identity",
      fetch: async () => response({ status: 200, responseHeaders: headers({ etag: '"different"' }) }),
      code: "MISSING_IDENTITY",
    },
    {
      name: "content range",
      fetch: async (_url, options) => options.method === "HEAD"
        ? response({ status: 200, responseHeaders: headers() })
        : response({
          status: 206,
          responseHeaders: headers({ length: 1, range: `bytes 1-1/${BYTE_LENGTH}` }),
          bytes: Uint8Array.of(0),
        }),
      code: "INVALID_CONTENT_RANGE",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      await assert.rejects(
        preflightPagedDisk(descriptor(), { origin: ORIGIN, fetch: item.fetch, scope: {} }),
        (error) => error.code === item.code,
      );
    });
  }
});

function fakeFs() {
  const nodes = new Map();
  const fs = {
    ERRNO_CODES: { EROFS: 30 },
    ErrnoError: class ErrnoError extends Error {
      constructor(code) {
        super(`errno ${code}`);
        this.name = "ErrnoError";
        this.errno = code;
      }
    },
    mkdirTree() {},
    analyzePath(path) { return { exists: nodes.has(path) }; },
    createLazyFile(parent, name, url, canRead, canWrite) {
      const lazy = {
        chunks: [],
        lengthKnown: false,
        setDataGetter(getter) { this.getter = getter; },
        get(index) {
          if (index < 0 || index >= this.length) return undefined;
          const chunk = Math.floor(index / this.chunkSize);
          return this.getter(chunk)[index % this.chunkSize];
        },
      };
      Object.defineProperties(lazy, {
        length: { get() { return this._length; } },
        chunkSize: { get() { return this._chunkSize; } },
      });
      const node = {
        parent,
        name,
        url,
        canRead,
        canWrite,
        contents: lazy,
        mode: 0o100666,
        stream_ops: {
          read(_stream, buffer, offset, length, position) {
            if (position >= lazy.length) return 0;
            const size = Math.min(lazy.length - position, length);
            for (let index = 0; index < size; index += 1) {
              buffer[offset + index] = lazy.get(position + index);
            }
            return size;
          },
          write() { throw new Error("permissive writer was not replaced"); },
        },
      };
      node.pinnedLazyRead = node.stream_ops.read;
      nodes.set(`${parent === "/" ? "" : parent}/${name}`, node);
      fs.node = node;
      return node;
    },
  };
  return fs;
}

function fakeXhrScope(disk, log, { ignoreRange = false, etag = ETAG, reprDigest = null } = {}) {
  class FakeXMLHttpRequest {
    requestHeaders = {};
    responseHeaders = new Headers();
    readyState = 0;
    status = 0;
    response = null;
    responseURL = URL;
    aborted = false;

    open(method, url, async) {
      this.method = method;
      this.url = url;
      this.async = async;
      this.readyState = 1;
    }

    setRequestHeader(name, value) {
      this.requestHeaders[name] = value;
    }

    getResponseHeader(name) {
      return this.responseHeaders.get(name);
    }

    abort() {
      this.aborted = true;
    }

    send() {
      const request = {
        method: this.method,
        url: this.url,
        async: this.async,
        range: this.requestHeaders.Range ?? null,
        ifMatch: this.requestHeaders["If-Match"] ?? null,
      };
      log.push(request);
      const match = this.requestHeaders.Range?.match(/^bytes=([0-9]+)-([0-9]+)$/);
      if (ignoreRange) {
        this.status = 200;
        this.responseHeaders = headers({ length: disk.byteLength, etag, reprDigest });
      } else if (!match) {
        this.status = 400;
        this.responseHeaders = headers({ length: 0, etag, reprDigest });
      } else {
        const start = Number(match[1]);
        const end = Number(match[2]);
        this.status = 206;
        this.responseHeaders = headers({
          length: end - start + 1,
          range: `bytes ${start}-${end}/${disk.byteLength}`,
          etag,
          reprDigest,
        });
      }
      this.readyState = 2;
      this.onreadystatechange?.();
      request.statusAtHeaders = this.status;
      request.abortedAtHeaders = this.aborted;
      if (this.aborted) return;
      const start = Number(match[1]);
      const end = Number(match[2]);
      const body = disk.subarray(start, end + 1);
      this.response = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      this.readyState = 4;
      this.onreadystatechange?.();
      request.responseBytes = body.byteLength;
    }
  }
  return { XMLHttpRequest: FakeXMLHttpRequest };
}

async function mountedFixture({
  byteLength = BYTE_LENGTH,
  chunkBytes = 64 * 1024,
  maxCachedBytes = 2 * 64 * 1024,
  xhrOptions,
} = {}) {
  const disk = Uint8Array.from({ length: byteLength }, (_, index) => index % 251);
  const preflightRequests = [];
  const ticket = await preflightPagedDisk(descriptor({ byteLength, chunkBytes, maxCachedBytes }), {
    origin: ORIGIN,
    fetch: successfulFetch(preflightRequests, byteLength),
    scope: {},
  });
  const requests = [];
  const scope = fakeXhrScope(disk, requests, xhrOptions);
  const observed = [];
  const hook = createPagedDiskPreRun(ticket, { scope, onRequest: (event) => observed.push(event) });
  const fs = fakeFs();
  hook({ FS: fs });
  return { disk, fs, hook, requests, observed, preflightRequests };
}

test("synchronous preRun mounts a read-only range file and bounds its clean chunk cache", async () => {
  const { disk, fs, hook, requests, observed } = await mountedFixture();
  const lazy = fs.node.contents;

  assert.equal(lazy.length, BYTE_LENGTH);
  assert.equal(lazy.chunkSize, 64 * 1024);
  assert.equal(lazy.get(9), disk[9]);
  assert.equal(lazy.get(2 * 64 * 1024 + 17), disk[2 * 64 * 1024 + 17]);
  assert.equal(lazy.get(64 * 1024 + 5), disk[64 * 1024 + 5]);
  assert.deepEqual(hook.snapshot().loadedChunks, [1, 2]);
  assert.equal(hook.snapshot().evictions, 1);
  assert.equal(hook.snapshot().cacheBytes, 2 * 64 * 1024);

  // Chunk zero was evicted, so this is a bounded re-fetch, never a whole GET.
  assert.equal(lazy.get(11), disk[11]);
  assert.equal(requests.length, 4);
  assert.ok(requests.every((request) => request.method === "GET" && request.range?.startsWith("bytes=")));
  assert.ok(requests.every((request) => request.async === false && request.ifMatch === ETAG));
  assert.equal(observed.length, 4);
  assert.equal(hook.snapshot().unRangedGetCount, 0);
  assert.equal(hook.snapshot().requestedBytes, 4 * 64 * 1024);
  assert.equal(fs.node.mode & 0o222, 0);
  assert.throws(() => fs.node.stream_ops.write(), (error) => error.errno === 30);
  assert.equal(hook.snapshot().writeAttempts, 1);
});

test("a realistic 1 MiB stream read copies by chunk without byte-wise lazy getter churn", async () => {
  const mebibyte = 1024 * 1024;
  const chunkBytes = 64 * 1024;
  const { disk, fs, hook, requests } = await mountedFixture({
    byteLength: 2 * mebibyte,
    chunkBytes,
    maxCachedBytes: mebibyte,
  });
  const lazy = fs.node.contents;
  let lazyGetterCalls = 0;
  const originalGetter = lazy.getter;
  lazy.setDataGetter((chunkNumber) => {
    lazyGetterCalls += 1;
    return originalGetter(chunkNumber);
  });

  const destination = new Uint8Array(mebibyte + 32);
  const copied = fs.node.stream_ops.read({}, destination, 17, mebibyte, 0);

  assert.equal(copied, mebibyte);
  assert.deepEqual(destination.subarray(17, 17 + mebibyte), disk.subarray(0, mebibyte));
  assert.equal(lazyGetterCalls, 0);
  assert.equal(requests.length, 16);
  assert.ok(requests.every((request) => request.range?.startsWith("bytes=")));
  assert.deepEqual(hook.snapshot(), {
    mounted: true,
    path: DEFAULT_GUEST_DISK_PATH,
    byteLength: 2 * mebibyte,
    chunkBytes,
    maxCachedBytes: mebibyte,
    rangeRequests: 16,
    unRangedGetCount: 0,
    requestedBytes: mebibyte,
    cacheBytes: mebibyte,
    loadedChunks: Array.from({ length: 16 }, (_, index) => index),
    evictions: 0,
    writeAttempts: 0,
    streamReadCalls: 1,
    streamReadChunks: 16,
    streamReadBytes: mebibyte,
    lruTouches: 16,
  });

  // Pinned Emscripten's original reader would invoke LazyUint8Array.get once
  // per byte for the same operation; the installed reader is not that path.
  assert.notEqual(fs.node.stream_ops.read, fs.node.pinnedLazyRead);
  assert.equal(mebibyte / hook.snapshot().streamReadChunks, chunkBytes);
});

test("synchronous loader aborts an ignored Range response at headers before reading a body", async () => {
  const { fs, requests } = await mountedFixture({ xhrOptions: { ignoreRange: true } });
  assert.throws(
    () => fs.node.contents.get(0),
    (error) => error.code === "RANGE_IGNORED",
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].range, "bytes=0-65535");
  assert.equal(requests[0].abortedAtHeaders, true);
  assert.equal(requests[0].responseBytes, undefined);
});

test("preRun refuses Window and incompatible Emscripten runtimes", async () => {
  const ticket = await preflightPagedDisk(descriptor(), {
    origin: ORIGIN,
    fetch: successfulFetch(),
    scope: {},
  });
  assert.throws(
    () => createPagedDiskPreRun(ticket, { scope: { document: {}, XMLHttpRequest() {} } })({ FS: fakeFs() }),
    (error) => error.code === "WINDOW_RUNTIME_UNSUPPORTED",
  );
  assert.throws(
    () => createPagedDiskPreRun(ticket, { scope: { XMLHttpRequest() {} } })({ FS: {} }),
    (error) => error.code === "EMSCRIPTEN_FS_UNAVAILABLE",
  );
});

test("preparePagedDisk returns the exact disposable QEMU integration", async () => {
  const prepared = await preparePagedDisk(descriptor(), {
    origin: ORIGIN,
    fetch: successfulFetch(),
    scope: fakeXhrScope(new Uint8Array(BYTE_LENGTH), []),
  });
  assert.deepEqual(prepared.qemuArguments, [
    "-snapshot",
    "-drive",
    `file=${DEFAULT_GUEST_DISK_PATH},if=virtio,format=raw,media=disk,cache=unsafe`,
  ]);
  assert.deepEqual(qemuPagedDiskArguments(), prepared.qemuArguments);
  assert.equal(typeof prepared.preRun, "function");
  assert.equal(typeof prepared.overlayPreRun, "function");
  assert.equal(prepared.overlayPreRun.maxBytes, DEFAULT_MAX_OVERLAY_BYTES);
  assert.equal(prepared.overlaySnapshot().installed, false);
  assert.equal(prepared.preflight.unRangedGetCount, 0);
});

test("preparePagedDisk accepts only a hard-capped overlay configuration", async () => {
  const prepared = await preparePagedDisk(descriptor(), {
    origin: ORIGIN,
    fetch: successfulFetch(),
    scope: fakeXhrScope(new Uint8Array(BYTE_LENGTH), []),
    maxOverlayBytes: 8 * 1024 * 1024,
  });
  assert.equal(prepared.overlayPreRun.maxBytes, 8 * 1024 * 1024);
  const requests = [];
  await assert.rejects(
    preparePagedDisk(descriptor(), {
      origin: ORIGIN,
      fetch: successfulFetch(requests),
      scope: fakeXhrScope(new Uint8Array(BYTE_LENGTH), []),
      maxOverlayBytes: 129 * 1024 * 1024,
    }),
    /maxBytes must be a positive integer/,
  );
  assert.deepEqual(requests, [], "invalid overlay limits fail before rootfs network access");
});
