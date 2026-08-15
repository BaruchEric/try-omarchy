import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { R2S3Store } from "../r2-s3-store.mjs";

const FIXED_DATE = new Date("2026-08-15T12:34:56.000Z");
const ACCOUNT_ID = "a".repeat(32);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function store(fetchImpl, overrides = {}) {
  return new R2S3Store({
    accountId: ACCOUNT_ID,
    bucket: "omarchy-artifacts",
    accessKeyId: "fixture-access-key",
    secretAccessKey: "fixture-secret-key",
    fetchImpl,
    now: () => FIXED_DATE,
    ...overrides,
  });
}

function metadata(bytes, sha256, contentType = "application/octet-stream") {
  return {
    bytes,
    sha256,
    httpMetadata: { contentType, contentEncoding: "identity" },
    customMetadata: { bytes: String(bytes), sha256 },
    ifNoneMatch: true,
  };
}

async function temporaryFile(bytes) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omarchy-r2-store-test-"));
  const filePath = path.join(directory, "artifact.bin");
  await writeFile(filePath, bytes);
  return filePath;
}

test("single PUT streams the file and signs exact identity/custom metadata", async () => {
  const bytes = Buffer.from("streamed-r2-fixture");
  const sha256 = digest(bytes);
  const filePath = await temporaryFile(bytes);
  let observed;
  const fetchImpl = async (url, init) => {
    observed = { url: String(url), init };
    assert.equal(init.body instanceof ReadableStream, true);
    const uploaded = Buffer.from(await new Response(init.body).arrayBuffer());
    assert.deepEqual(uploaded, bytes);
    return new Response(null, { status: 200, headers: { ETag: '"stored"' } });
  };

  await store(fetchImpl).putFile({
    key: "omarchy/versions/a/binary.bin",
    filePath,
    ...metadata(bytes.byteLength, sha256, "application/wasm"),
  });

  assert.equal(observed.url, `https://${ACCOUNT_ID}.r2.cloudflarestorage.com/omarchy-artifacts/omarchy/versions/a/binary.bin`);
  assert.equal(observed.init.method, "PUT");
  assert.equal(observed.init.headers.get("content-length"), String(bytes.byteLength));
  assert.equal(observed.init.headers.get("content-type"), "application/wasm");
  assert.equal(observed.init.headers.get("content-encoding"), "identity");
  assert.equal(observed.init.headers.get("x-amz-meta-sha256"), sha256);
  assert.equal(observed.init.headers.get("x-amz-meta-bytes"), String(bytes.byteLength));
  assert.equal(observed.init.headers.get("if-none-match"), "*");
  assert.equal(observed.init.headers.get("x-amz-content-sha256"), sha256);
  assert.equal(observed.init.headers.get("x-amz-date"), "20260815T123456Z");
  assert.match(observed.init.headers.get("authorization"), /^AWS4-HMAC-SHA256 Credential=fixture-access-key\/20260815\/auto\/s3\/aws4_request,/);
  assert.equal(observed.init.headers.get("authorization").includes("fixture-secret-key"), false);
});

test("the configured upload limit is global across concurrent artifacts", async () => {
  const bytes = Buffer.from("global-upload-limit-fixture");
  const sha256 = digest(bytes);
  const filePath = await temporaryFile(bytes);
  let active = 0;
  let maximum = 0;
  const fetchImpl = async (_url, init) => {
    active += 1;
    maximum = Math.max(maximum, active);
    try {
      await new Response(init.body).arrayBuffer();
      await new Promise((resolve) => setImmediate(resolve));
      return new Response(null, { status: 200 });
    } finally {
      active -= 1;
    }
  };
  const r2 = store(fetchImpl, { concurrency: 2 });
  await Promise.all(Array.from({ length: 5 }, (_, index) => r2.putFile({
    key: `omarchy/versions/a/artifact-${index}.bin`,
    filePath,
    ...metadata(bytes.byteLength, sha256),
  })));
  assert.equal(maximum, 2);
});

test("multipart upload uses bounded parallel file streams and aborts no successful upload", async () => {
  const partSizeBytes = 5 * 1024 * 1024;
  const bytes = Buffer.alloc(partSizeBytes * 2 + 17, 0x5a);
  const sha256 = digest(bytes);
  const filePath = await temporaryFile(bytes);
  const calls = [];
  let activeParts = 0;
  let maxActiveParts = 0;

  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    calls.push({ pathname: parsed.pathname, search: parsed.search, init });
    if (init.method === "HEAD") return new Response(null, { status: 404 });
    if (init.method === "POST" && parsed.searchParams.has("uploads")) {
      assert.equal(init.headers.get("content-type"), "application/vnd.omarchy.ext4");
      assert.equal(init.headers.get("content-encoding"), "identity");
      assert.equal(init.headers.get("x-amz-meta-sha256"), sha256);
      assert.equal(init.headers.get("x-amz-meta-bytes"), String(bytes.byteLength));
      return new Response("<InitiateMultipartUploadResult><UploadId>upload-fixture</UploadId></InitiateMultipartUploadResult>", {
        status: 200,
      });
    }
    if (init.method === "PUT" && parsed.searchParams.has("partNumber")) {
      activeParts += 1;
      maxActiveParts = Math.max(maxActiveParts, activeParts);
      try {
        assert.equal(init.body instanceof ReadableStream, true);
        const body = Buffer.from(await new Response(init.body).arrayBuffer());
        assert.equal(init.headers.get("content-length"), String(body.byteLength));
        assert.equal(init.headers.get("x-amz-content-sha256"), digest(body));
        await new Promise((resolve) => setImmediate(resolve));
        return new Response(null, {
          status: 200,
          headers: { ETag: `"part-${parsed.searchParams.get("partNumber")}"` },
        });
      } finally {
        activeParts -= 1;
      }
    }
    if (init.method === "POST" && parsed.searchParams.has("uploadId")) {
      const body = await new Response(init.body).text();
      assert.match(body, /<PartNumber>1<\/PartNumber><ETag>&quot;part-1&quot;<\/ETag>/);
      assert.match(body, /<PartNumber>3<\/PartNumber><ETag>&quot;part-3&quot;<\/ETag>/);
      assert.equal(init.headers.has("if-none-match"), false);
      return new Response("<CompleteMultipartUploadResult><ETag>\"complete\"</ETag></CompleteMultipartUploadResult>", {
        status: 200,
      });
    }
    throw new Error(`unexpected request: ${init.method} ${parsed.href}`);
  };

  await store(fetchImpl, {
    concurrency: 2,
    partSizeBytes,
    singlePutLimitBytes: 1,
  }).putFile({
    key: "omarchy/versions/a/rootfs.ext4",
    filePath,
    ...metadata(bytes.byteLength, sha256, "application/vnd.omarchy.ext4"),
  });

  assert.equal(calls.filter(({ init }) => init.method === "PUT").length, 3);
  assert.equal(maxActiveParts <= 2, true);
  assert.equal(maxActiveParts > 1, true);
  assert.equal(calls.some(({ init }) => init.method === "DELETE"), false);
});

test("multipart failure is aborted and original failure wins", async () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024 + 1, 0x2a);
  const filePath = await temporaryFile(bytes);
  let aborted = false;
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    if (init.method === "HEAD") return new Response(null, { status: 404 });
    if (init.method === "POST" && parsed.searchParams.has("uploads")) {
      return new Response("<InitiateMultipartUploadResult><UploadId>failed-upload</UploadId></InitiateMultipartUploadResult>");
    }
    if (init.method === "PUT") return new Response("failed part", { status: 500 });
    if (init.method === "DELETE") {
      aborted = true;
      return new Response(null, { status: 204 });
    }
    throw new Error("unexpected multipart request");
  };
  await assert.rejects(
    store(fetchImpl, { partSizeBytes: 5 * 1024 * 1024, singlePutLimitBytes: 1 }).putFile({
      key: "omarchy/versions/a/rootfs.ext4",
      filePath,
      ...metadata(bytes.byteLength, digest(bytes)),
    }),
    /R2 PUT failed/,
  );
  assert.equal(aborted, true);
});

test("HEAD exposes exact generation and custom metadata and treats only 404 as absent", async () => {
  const expected = {
    "Content-Length": "42",
    "Content-Type": "application/wasm",
    "Content-Encoding": "identity",
    ETag: '"generation"',
    "x-amz-meta-sha256": "a".repeat(64),
    "x-amz-meta-bytes": "42",
  };
  const foundStore = store(async () => new Response(null, { status: 200, headers: expected }));
  assert.deepEqual(await foundStore.head("omarchy/versions/a/qemu.wasm"), {
    key: "omarchy/versions/a/qemu.wasm",
    size: 42,
    etag: '"generation"',
    customMetadata: { sha256: "a".repeat(64), bytes: "42" },
    httpMetadata: { contentType: "application/wasm", contentEncoding: "identity" },
  });

  assert.equal(await store(async () => new Response("missing", { status: 404 })).head("missing"), null);
  await assert.rejects(
    store(async () => new Response("denied", { status: 403 })).head("denied"),
    /R2 HEAD failed.*403/,
  );
});
