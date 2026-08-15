import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createReleaseClearance } from "../release/promote.mjs";
import {
  CLEARANCE_ARTIFACT_NAME,
  MAX_ARTIFACT_RANGE_BYTES,
  MAX_CLEARANCE_BYTES,
  MAX_FULL_ARTIFACT_BYTES,
  MAX_ROOTFS_RANGE_BYTES,
  handleArtifactRequest,
} from "./artifacts.mjs";

const RELEASE = `f0020448${"0".repeat(56)}`;
const DIGEST = "0123456789abcdef".repeat(4);
const SYNTHETIC_ETAG = `"sha256-${DIGEST}"`;
const ROOTFS_URL = `https://try.example/omarchy/versions/${RELEASE}/rootfs.ext4`;
const WASM_URL = `https://try.example/omarchy/versions/${RELEASE}/qemu.wasm`;
const CLEARANCE_KEY = `omarchy/versions/${RELEASE}/${CLEARANCE_ARTIFACT_NAME}`;

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validClearance(overrides = {}) {
  return {
    schemaVersion: 1,
    releaseId: RELEASE,
    artifactManifestSha256: RELEASE,
    approvalEvidenceSha256: "a".repeat(64),
    approvalPolicySha256: "b".repeat(64),
    approvals: {
      licensing: { approved: true, approvedAt: "2026-08-15T00:00:00.000Z", approvedBy: "license-owner" },
      runtime: { approved: true, approvedAt: "2026-08-15T00:01:00.000Z", approvedBy: "runtime-owner" },
      security: { approved: true, approvedAt: "2026-08-15T00:02:00.000Z", approvedBy: "security-owner" },
      product: { approved: true, approvedAt: "2026-08-15T00:03:00.000Z", approvedBy: "product-owner" },
    },
    ...overrides,
  };
}

function clearanceEntry(document = validClearance()) {
  const bytes = new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);
  return {
    bytes,
    object: storedObject(CLEARANCE_KEY, bytes, {
      etag: "r2-clearance-generation-one",
      customMetadata: { sha256: digest(bytes), bytes: String(bytes.byteLength) },
      httpMetadata: { contentType: "application/json" },
    }),
  };
}

function stream(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function storedObject(key, bytes, overrides = {}) {
  const object = {
    key,
    size: bytes.byteLength,
    etag: "r2-generation-one",
    customMetadata: {
      sha256: DIGEST,
      bytes: String(bytes.byteLength),
    },
    httpMetadata: {
      contentType: key.endsWith(".wasm") ? "application/wasm" : "application/vnd.omarchy.ext4",
    },
    ...overrides,
  };
  return object;
}

class FakeBucket {
  constructor(entries) {
    this.entries = new Map(entries);
    this.headCalls = [];
    this.getCalls = [];
    this.clearanceGetCalls = [];
    this.getOverride = null;
    this.clearanceGetOverride = null;
  }

  async head(key) {
    this.headCalls.push(key);
    return this.entries.get(key)?.object ?? null;
  }

  async get(key, options = undefined) {
    if (key.endsWith(`/${CLEARANCE_ARTIFACT_NAME}`)) {
      this.clearanceGetCalls.push({ key, options });
      if (this.clearanceGetOverride) return this.clearanceGetOverride(key, options);
      const entry = this.entries.get(key);
      if (!entry) return null;
      return { ...entry.object, body: stream(entry.bytes) };
    }
    this.getCalls.push({ key, options });
    if (this.getOverride) return this.getOverride(key, options);
    const entry = this.entries.get(key);
    if (!entry) return null;
    const { object, bytes } = entry;
    if (options?.onlyIf?.etagMatches !== object.etag) return { ...object };
    if (options?.range) {
      const { offset, length } = options.range;
      return {
        ...object,
        range: { offset, length },
        body: stream(bytes.slice(offset, offset + length)),
      };
    }
    return { ...object, body: stream(bytes) };
  }
}

function fixture({ rootfsBytes = 32 * 1024 * 1024, wasmBytes = 32 } = {}) {
  const rootfs = new Uint8Array(rootfsBytes);
  for (let index = 0; index < rootfs.length; index += 1) rootfs[index] = index % 251;
  const wasm = new Uint8Array(wasmBytes).fill(0x61);
  const rootfsKey = `omarchy/versions/${RELEASE}/rootfs.ext4`;
  const wasmKey = `omarchy/versions/${RELEASE}/qemu.wasm`;
  const bucket = new FakeBucket([
    [CLEARANCE_KEY, clearanceEntry()],
    [rootfsKey, { bytes: rootfs, object: storedObject(rootfsKey, rootfs) }],
    [wasmKey, { bytes: wasm, object: storedObject(wasmKey, wasm) }],
  ]);
  return { bucket, rootfs, rootfsKey, wasm, wasmKey };
}

function request(url, options = {}) {
  return new Request(url, options);
}

function rawRequest(url, options = {}) {
  return {
    url,
    method: options.method ?? "GET",
    headers: new Headers(options.headers),
  };
}

async function problem(response) {
  return response.json();
}

function assertIsolation(headers) {
  assert.equal(headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  assert.equal(headers.get("Cross-Origin-Embedder-Policy"), "require-corp");
  assert.equal(headers.get("Cross-Origin-Resource-Policy"), "same-origin");
}

test("non-artifact requests fall through to vinext", async () => {
  const { bucket } = fixture();
  assert.equal(await handleArtifactRequest(request("https://try.example/"), bucket), null);
  assert.deepEqual(bucket.headCalls, []);
  assert.deepEqual(bucket.getCalls, []);
  assert.deepEqual(bucket.clearanceGetCalls, []);
});

test("a partial canonical upload is unreachable through HEAD and ranged GET", async () => {
  const { bucket } = fixture();
  bucket.entries.delete(CLEARANCE_KEY);

  const head = await handleArtifactRequest(request(ROOTFS_URL, { method: "HEAD" }), bucket);
  assert.equal(head.status, 404);
  assert.equal(head.body, null);
  assert.equal(head.headers.get("X-Omarchy-Artifact-Error"), "RELEASE_NOT_CLEARED");

  const ranged = await handleArtifactRequest(request(ROOTFS_URL, {
    headers: { Range: "bytes=0-0", "If-Match": SYNTHETIC_ETAG },
  }), bucket);
  assert.equal(ranged.status, 404);
  assert.equal((await problem(ranged)).error, "RELEASE_NOT_CLEARED");
  assert.equal(ranged.headers.get("X-Omarchy-Artifact-Error"), "RELEASE_NOT_CLEARED");

  assert.equal(bucket.clearanceGetCalls.length, 2, "absent clearance must not be cached");
  assert.deepEqual(bucket.headCalls, [], "target metadata must remain unread before clearance");
  assert.deepEqual(bucket.getCalls, [], "target bodies must remain unread before clearance");
});

test("malformed or release-mismatched clearance fails closed before target metadata", async (t) => {
  const otherwiseValid = validClearance();
  const invalidDocuments = [
    ["wrong schema", { ...otherwiseValid, schemaVersion: 2 }],
    ["wrong release", { ...otherwiseValid, releaseId: "c".repeat(64) }],
    ["wrong manifest", { ...otherwiseValid, artifactManifestSha256: "d".repeat(64) }],
    ["noncanonical evidence digest", { ...otherwiseValid, approvalEvidenceSha256: "A".repeat(64) }],
    ["extra top-level field", { ...otherwiseValid, unexpected: true }],
    ["missing approval", {
      ...otherwiseValid,
      approvals: { ...otherwiseValid.approvals, product: undefined },
    }],
    ["unapproved gate", {
      ...otherwiseValid,
      approvals: {
        ...otherwiseValid.approvals,
        security: { ...otherwiseValid.approvals.security, approved: false },
      },
    }],
    ["noncanonical timestamp", {
      ...otherwiseValid,
      approvals: {
        ...otherwiseValid.approvals,
        runtime: { ...otherwiseValid.approvals.runtime, approvedAt: "2026-08-15T00:01:00Z" },
      },
    }],
    ["unnamed approver", {
      ...otherwiseValid,
      approvals: {
        ...otherwiseValid.approvals,
        licensing: { ...otherwiseValid.approvals.licensing, approvedBy: " " },
      },
    }],
  ];

  for (const [name, document] of invalidDocuments) {
    await t.test(name, async () => {
      const { bucket } = fixture();
      // JSON serialization intentionally removes the undefined product member,
      // exercising the strict missing-key check rather than a JS-only value.
      bucket.entries.set(CLEARANCE_KEY, clearanceEntry(document));
      const response = await handleArtifactRequest(request(WASM_URL, { method: "HEAD" }), bucket);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("X-Omarchy-Artifact-Error"), "RELEASE_NOT_CLEARED");
      assert.deepEqual(bucket.headCalls, []);
      assert.deepEqual(bucket.getCalls, []);
    });
  }
});

test("clearance representation metadata and body integrity are required", async (t) => {
  const cases = [
    ["digest mismatch", (entry) => { entry.object.customMetadata.sha256 = "0".repeat(64); }],
    ["missing declared bytes", (entry) => { delete entry.object.customMetadata.bytes; }],
    ["wrong media type", (entry) => { entry.object.httpMetadata.contentType = "text/plain"; }],
    ["encoded", (entry) => { entry.object.httpMetadata.contentEncoding = "gzip"; }],
    ["partial body", (entry) => { entry.bytes = entry.bytes.slice(0, -1); }],
    ["oversized", (entry) => {
      entry.object.size = MAX_CLEARANCE_BYTES + 1;
      entry.object.customMetadata.bytes = String(MAX_CLEARANCE_BYTES + 1);
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const { bucket } = fixture();
      const entry = clearanceEntry();
      mutate(entry);
      bucket.entries.set(CLEARANCE_KEY, entry);
      const response = await handleArtifactRequest(request(ROOTFS_URL, { method: "HEAD" }), bucket);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("X-Omarchy-Artifact-Error"), "RELEASE_NOT_CLEARED");
      assert.deepEqual(bucket.headCalls, []);
      assert.deepEqual(bucket.getCalls, []);
    });
  }
});

test("only positive immutable clearance is cached per bucket and release", async () => {
  const initiallyMissing = fixture().bucket;
  initiallyMissing.entries.delete(CLEARANCE_KEY);
  const denied = await handleArtifactRequest(request(WASM_URL, { method: "HEAD" }), initiallyMissing);
  assert.equal(denied.status, 404);
  initiallyMissing.entries.set(CLEARANCE_KEY, clearanceEntry());
  const laterCleared = await handleArtifactRequest(request(WASM_URL, { method: "HEAD" }), initiallyMissing);
  assert.equal(laterCleared.status, 200);
  assert.equal(initiallyMissing.clearanceGetCalls.length, 2, "negative result must be retried");

  const { bucket } = fixture();
  const first = await handleArtifactRequest(request(ROOTFS_URL, { method: "HEAD" }), bucket);
  assert.equal(first.status, 200);
  bucket.entries.delete(CLEARANCE_KEY);
  const second = await handleArtifactRequest(request(ROOTFS_URL, { method: "HEAD" }), bucket);
  assert.equal(second.status, 200);
  assert.equal(bucket.clearanceGetCalls.length, 1, "verified immutable clearance must be reused");
});

test("the public clearance object is served only after validating itself", async () => {
  const { bucket } = fixture();
  const response = await handleArtifactRequest(request(`https://try.example/${CLEARANCE_KEY}`), bucket);
  assert.equal(response.status, 200);
  const document = await response.json();
  assert.equal(document.releaseId, RELEASE);
  assert.equal(document.artifactManifestSha256, RELEASE);
  assert.equal(bucket.headCalls.length, 1);
  assert.equal(bucket.headCalls[0], CLEARANCE_KEY);
  assert.equal(bucket.clearanceGetCalls.length, 2, "validation must precede the separately pinned public read");
  assert.equal(bucket.clearanceGetCalls[1].options.onlyIf.etagMatches, "r2-clearance-generation-one");
});

test("the release promoter's exact clearance bytes satisfy the Worker contract", async () => {
  const approvalGrant = {
    evidenceSha256: "a".repeat(64),
    policySha256: "b".repeat(64),
    approvals: validClearance().approvals,
  };
  const emitted = createReleaseClearance(RELEASE, approvalGrant);
  const bytes = new Uint8Array(emitted);
  const { bucket } = fixture();
  bucket.entries.set(CLEARANCE_KEY, {
    bytes,
    object: storedObject(CLEARANCE_KEY, bytes, {
      etag: "r2-promoter-clearance-generation",
      customMetadata: { sha256: digest(bytes), bytes: String(bytes.byteLength) },
      httpMetadata: { contentType: "application/json", contentEncoding: "identity" },
    }),
  });

  const response = await handleArtifactRequest(request(ROOTFS_URL, { method: "HEAD" }), bucket);
  assert.equal(response.status, 200);
  assert.equal(bucket.clearanceGetCalls.length, 1);
  assert.equal(bucket.headCalls[0], `omarchy/versions/${RELEASE}/rootfs.ext4`);
});

test("HEAD returns full immutable identity metadata without reading the object", async () => {
  const { bucket, rootfs } = fixture();
  const response = await handleArtifactRequest(request(ROOTFS_URL, { method: "HEAD" }), bucket);

  assert.equal(response.status, 200);
  assert.equal(response.body, null);
  assert.equal(response.headers.get("Content-Length"), String(rootfs.byteLength));
  assert.equal(response.headers.get("Accept-Ranges"), "bytes");
  assert.equal(response.headers.get("Content-Encoding"), "identity");
  assert.equal(response.headers.get("ETag"), SYNTHETIC_ETAG);
  assert.equal(
    response.headers.get("Repr-Digest"),
    `sha-256=:${Buffer.from(DIGEST, "hex").toString("base64")}:`,
  );
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=31536000, immutable, no-transform");
  assertIsolation(response.headers);
  assert.equal(bucket.headCalls.length, 1);
  assert.deepEqual(bucket.getCalls, []);
});

test("a rootfs GET reads exactly one pinned R2 range and returns exact 206 bytes", async () => {
  const { bucket, rootfs, rootfsKey } = fixture();
  const response = await handleArtifactRequest(request(ROOTFS_URL, {
    headers: { Range: "bytes=1048576-2097151", "If-Match": SYNTHETIC_ETAG },
  }), bucket);

  assert.equal(response.status, 206);
  assert.equal(response.headers.get("Content-Range"), `bytes 1048576-2097151/${rootfs.byteLength}`);
  assert.equal(response.headers.get("Content-Length"), "1048576");
  assert.equal(response.headers.get("ETag"), SYNTHETIC_ETAG);
  assertIsolation(response.headers);
  assert.deepEqual(bucket.getCalls, [{
    key: rootfsKey,
    options: {
      range: { offset: 1048576, length: 1048576 },
      onlyIf: { etagMatches: "r2-generation-one" },
    },
  }]);
  assert.deepEqual(
    new Uint8Array(await response.arrayBuffer()),
    rootfs.slice(1048576, 2097152),
  );
});

test("open-ended and suffix ranges are normalized before the R2 read", async (t) => {
  await t.test("open ended", async () => {
    const { bucket, rootfs } = fixture({ rootfsBytes: 16 * 1024 * 1024 });
    const start = rootfs.byteLength - 4096;
    const response = await handleArtifactRequest(request(ROOTFS_URL, {
      headers: { Range: `bytes=${start}-`, "If-Match": SYNTHETIC_ETAG },
    }), bucket);
    assert.equal(response.status, 206);
    assert.deepEqual(bucket.getCalls[0].options.range, { offset: start, length: 4096 });
  });

  await t.test("suffix", async () => {
    const { bucket, rootfs } = fixture({ rootfsBytes: 16 * 1024 * 1024 });
    const response = await handleArtifactRequest(request(ROOTFS_URL, {
      headers: { Range: "bytes=-4096", "If-Match": SYNTHETIC_ETAG },
    }), bucket);
    assert.equal(response.status, 206);
    assert.deepEqual(bucket.getCalls[0].options.range, { offset: rootfs.byteLength - 4096, length: 4096 });
  });
});

test("rootfs reads require a range and the synthetic If-Match", async (t) => {
  await t.test("missing range", async () => {
    const { bucket } = fixture();
    const response = await handleArtifactRequest(request(ROOTFS_URL, {
      headers: { "If-Match": SYNTHETIC_ETAG },
    }), bucket);
    assert.equal(response.status, 400);
    assert.equal((await problem(response)).error, "RANGE_REQUIRED");
    assert.deepEqual(bucket.getCalls, []);
  });

  await t.test("missing condition", async () => {
    const { bucket } = fixture();
    const response = await handleArtifactRequest(request(ROOTFS_URL, {
      headers: { Range: "bytes=0-0" },
    }), bucket);
    assert.equal(response.status, 428);
    assert.equal((await problem(response)).error, "IF_MATCH_REQUIRED");
    assert.deepEqual(bucket.getCalls, []);
  });

  await t.test("wrong condition", async () => {
    const { bucket } = fixture();
    const response = await handleArtifactRequest(request(ROOTFS_URL, {
      headers: { Range: "bytes=0-0", "If-Match": '"wrong"' },
    }), bucket);
    assert.equal(response.status, 412);
    assert.equal((await problem(response)).error, "IF_MATCH_FAILED");
    assert.deepEqual(bucket.getCalls, []);
  });
});

test("invalid, multiple, oversized, and whole-object rootfs ranges never reach R2 get", async (t) => {
  const cases = [
    ["malformed", "items=0-1", "INVALID_RANGE"],
    ["multiple", "bytes=0-1,4-5", "SINGLE_RANGE_REQUIRED"],
    ["backwards", "bytes=10-2", "UNSATISFIABLE_RANGE"],
    ["outside", "bytes=999999999-", "UNSATISFIABLE_RANGE"],
    ["zero suffix", "bytes=-0", "UNSATISFIABLE_RANGE"],
    ["too large", `bytes=0-${MAX_ROOTFS_RANGE_BYTES}`, "RANGE_TOO_LARGE"],
  ];
  for (const [name, range, code] of cases) {
    await t.test(name, async () => {
      const { bucket, rootfs } = fixture();
      const response = await handleArtifactRequest(request(ROOTFS_URL, {
        headers: { Range: range, "If-Match": SYNTHETIC_ETAG },
      }), bucket);
      assert.equal(response.status, 416);
      assert.equal(response.headers.get("Content-Range"), `bytes */${rootfs.byteLength}`);
      assert.equal((await problem(response)).error, code);
      assert.deepEqual(bucket.getCalls, []);
    });
  }

  await t.test("whole object", async () => {
    const { bucket, rootfs } = fixture({ rootfsBytes: 1024 });
    const response = await handleArtifactRequest(request(ROOTFS_URL, {
      headers: { Range: "bytes=0-1023", "If-Match": SYNTHETIC_ETAG },
    }), bucket);
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("Content-Range"), `bytes */${rootfs.byteLength}`);
    assert.equal((await problem(response)).error, "FULL_DISK_RANGE_FORBIDDEN");
    assert.deepEqual(bucket.getCalls, []);
  });
});

test("unsafe and non-canonical artifact paths never touch R2", async (t) => {
  const paths = [
    `/omarchy/versions/${RELEASE}/nested//rootfs.ext4`,
    `/omarchy/versions/${RELEASE}/%2e%2e/rootfs.ext4`,
    `/omarchy/versions/${RELEASE}/nested%2frootfs.ext4`,
    `/omarchy/versions/${RELEASE.toUpperCase()}/rootfs.ext4`,
    "/omarchy/versions/not-a-digest/rootfs.ext4",
    `/omarchy/versions/${RELEASE}/rootfs.ext4?download=1`,
  ];
  for (const urlPath of paths) {
    await t.test(urlPath, async () => {
      const { bucket } = fixture();
      const response = await handleArtifactRequest(request(`https://try.example${urlPath}`, { method: "HEAD" }), bucket);
      assert.equal(response.status, 400);
      assertIsolation(response.headers);
      assert.deepEqual(bucket.headCalls, []);
      assert.deepEqual(bucket.getCalls, []);
    });
  }


  const rawTraversalPaths = [
    `/omarchy/versions/${RELEASE}/nested/../rootfs.ext4`,
    `/omarchy/versions/${RELEASE}/nested/%2e%2e/rootfs.ext4`,
    `/omarchy/versions/${RELEASE}/../../../private`,
  ];
  for (const urlPath of rawTraversalPaths) {
    await t.test(`raw ${urlPath}`, async () => {
      const { bucket } = fixture();
      const response = await handleArtifactRequest(
        rawRequest(`https://try.example${urlPath}`, { method: "HEAD" }),
        bucket,
      );
      assert.equal(response.status, 400);
      assert.deepEqual(bucket.headCalls, []);
      assert.deepEqual(bucket.getCalls, []);
    });
  }
});

test("missing objects, methods, and missing bindings fail closed", async (t) => {
  await t.test("not found", async () => {
    const { bucket } = fixture();
    const response = await handleArtifactRequest(
      request(`https://try.example/omarchy/versions/${RELEASE}/missing.bin`, { method: "HEAD" }),
      bucket,
    );
    assert.equal(response.status, 404);
  });

  await t.test("method", async () => {
    const { bucket } = fixture();
    const response = await handleArtifactRequest(request(WASM_URL, { method: "POST" }), bucket);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "GET, HEAD");
    assert.deepEqual(bucket.headCalls, []);
  });

  await t.test("binding", async () => {
    const response = await handleArtifactRequest(request(WASM_URL), undefined);
    assert.equal(response.status, 503);
    assert.equal((await problem(response)).error, "ARTIFACT_STORAGE_UNAVAILABLE");
  });
});

test("invalid digest, declared size, and content encoding fail before any get", async (t) => {
  const cases = [
    ["missing digest", (object) => { object.customMetadata = {}; }, "INVALID_DIGEST_METADATA"],
    ["noncanonical digest", (object) => { object.customMetadata.sha256 = DIGEST.toUpperCase(); }, "INVALID_DIGEST_METADATA"],
    ["declared size", (object) => { object.customMetadata.bytes = String(object.size + 1); }, "STORED_SIZE_MISMATCH"],
    ["content encoding", (object) => { object.httpMetadata.contentEncoding = "gzip"; }, "ENCODED_ARTIFACT"],
  ];
  for (const [name, mutate, code] of cases) {
    await t.test(name, async () => {
      const { bucket, rootfsKey } = fixture();
      mutate(bucket.entries.get(rootfsKey).object);
      const response = await handleArtifactRequest(request(ROOTFS_URL, {
        headers: { Range: "bytes=0-0", "If-Match": SYNTHETIC_ETAG },
      }), bucket);
      assert.equal(response.status, 502);
      assert.equal((await problem(response)).error, code);
      assert.deepEqual(bucket.getCalls, []);
    });
  }
});

test("R2 generation, size, encoding, range, body, and body length mismatches fail closed", async (t) => {
  const cases = [
    ["generation", (object) => { object.etag = "changed"; }, "ARTIFACT_CHANGED", 412],
    ["digest", (object) => { object.customMetadata = { ...object.customMetadata, sha256: "a".repeat(64) }; }, "ARTIFACT_CHANGED", 412],
    ["size", (object) => { object.size += 1; object.customMetadata = { ...object.customMetadata, bytes: String(object.size) }; }, "STORED_SIZE_MISMATCH", 502],
    ["encoding", (object) => { object.httpMetadata = { ...object.httpMetadata, contentEncoding: "br" }; }, "ENCODED_ARTIFACT", 502],
    ["range", (object) => { object.range = { offset: 1, length: 1 }; }, "STORED_RANGE_MISMATCH", 502],
    ["no body", (object) => { delete object.body; }, "ARTIFACT_CHANGED", 412],
    ["short body", (object) => { object.body = stream(new Uint8Array(0)); }, "STORED_SIZE_MISMATCH", 502],
  ];
  for (const [name, mutate, code, status] of cases) {
    await t.test(name, async () => {
      const { bucket, rootfsKey } = fixture();
      bucket.getOverride = (_key, options) => {
        const head = bucket.entries.get(rootfsKey).object;
        const object = {
          ...head,
          customMetadata: { ...head.customMetadata },
          httpMetadata: { ...head.httpMetadata },
          range: { offset: options.range.offset, length: options.range.length },
          body: stream(new Uint8Array(options.range.length)),
        };
        mutate(object);
        return object;
      };
      const response = await handleArtifactRequest(request(ROOTFS_URL, {
        headers: { Range: "bytes=0-0", "If-Match": SYNTHETIC_ETAG },
      }), bucket);
      assert.equal(response.status, status);
      assert.equal((await problem(response)).error, code);
      assert.equal(bucket.getCalls.length, 1);
      assert.ok(bucket.getCalls[0].options.range, "rootfs get must remain ranged");
    });
  }
});

test("bounded non-rootfs artifacts support safe full and ranged GETs", async (t) => {
  await t.test("full", async () => {
    const { bucket, wasm, wasmKey } = fixture();
    const response = await handleArtifactRequest(request(WASM_URL), bucket);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "application/wasm");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), wasm);
    assert.deepEqual(bucket.getCalls, [{
      key: wasmKey,
      options: { onlyIf: { etagMatches: "r2-generation-one" } },
    }]);
  });

  await t.test("range", async () => {
    const { bucket } = fixture();
    const response = await handleArtifactRequest(request(WASM_URL, {
      headers: { Range: "bytes=2-5", "If-Match": SYNTHETIC_ETAG },
    }), bucket);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("Content-Range"), "bytes 2-5/32");
    assert.deepEqual(bucket.getCalls[0].options.range, { offset: 2, length: 4 });
  });

  await t.test("range limit", async () => {
    const { bucket, wasmKey } = fixture({ wasmBytes: MAX_ARTIFACT_RANGE_BYTES + 1 });
    const response = await handleArtifactRequest(request(WASM_URL, {
      headers: { Range: `bytes=0-${MAX_ARTIFACT_RANGE_BYTES}` },
    }), bucket);
    assert.equal(response.status, 416);
    assert.deepEqual(bucket.getCalls, []);
    assert.equal(bucket.entries.get(wasmKey).object.size, MAX_ARTIFACT_RANGE_BYTES + 1);
  });

  await t.test("full size limit", async () => {
    const key = `omarchy/versions/${RELEASE}/large.img`;
    const object = storedObject(key, new Uint8Array(1), {
      size: MAX_FULL_ARTIFACT_BYTES + 1,
      customMetadata: { sha256: DIGEST, bytes: String(MAX_FULL_ARTIFACT_BYTES + 1) },
    });
    const bucket = new FakeBucket([
      [CLEARANCE_KEY, clearanceEntry()],
      [key, { object, bytes: new Uint8Array(1) }],
    ]);
    const response = await handleArtifactRequest(
      request(`https://try.example/omarchy/versions/${RELEASE}/large.img`),
      bucket,
    );
    assert.equal(response.status, 413);
    assert.deepEqual(bucket.getCalls, []);
  });
});

test("the rootfs route never performs a full R2 get", async () => {
  const { bucket } = fixture();
  const requests = [
    request(ROOTFS_URL),
    request(ROOTFS_URL, { headers: { Range: "bytes=0-0" } }),
    request(ROOTFS_URL, { headers: { Range: "bytes=0-0", "If-Match": '"wrong"' } }),
    request(ROOTFS_URL, { headers: { Range: "bytes=0-0", "If-Match": SYNTHETIC_ETAG } }),
    request(ROOTFS_URL, { headers: { Range: "bytes=1-8", "If-Match": SYNTHETIC_ETAG } }),
  ];
  for (const item of requests) await handleArtifactRequest(item, bucket);
  assert.ok(bucket.getCalls.length > 0);
  assert.equal(bucket.getCalls.every((call) => call.options?.range?.length > 0), true);
});
