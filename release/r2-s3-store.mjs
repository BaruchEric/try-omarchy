import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const MIN_MULTIPART_PART_BYTES = 5 * 1024 * 1024;
const MAX_MULTIPART_PART_BYTES = 5 * 1024 * 1024 * 1024 - MIN_MULTIPART_PART_BYTES;
const DEFAULT_PART_BYTES = 64 * 1024 * 1024;
const DEFAULT_SINGLE_PUT_LIMIT = 4 * 1024 * 1024 * 1024;
const MAX_PARTS = 10_000;
const MAX_ERROR_BYTES = 64 * 1024;
const SAFE_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const SAFE_KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function rfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeKey(value) {
  return value.split("/").map(rfc3986).join("/");
}

function normalizeHeaderValue(value) {
  return String(value).trim().replace(/\s+/g, " ");
}

function hmac(key, value, encoding = undefined) {
  return createHmac("sha256", key).update(value).digest(encoding);
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlDecode(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function xmlElement(xml, name) {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  invariant(match, `R2 response is missing ${name}`);
  return xmlDecode(match[1]);
}

async function boundedResponseText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < MAX_ERROR_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_ERROR_BYTES - total;
      const selected = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(selected);
      total += selected.byteLength;
      if (selected.byteLength !== value.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

async function sha256FileRange(filePath, start, length) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath, {
    start,
    end: start + length - 1,
    highWaterMark: 1024 * 1024,
  });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function fileRangeBody(filePath, start, length) {
  return Readable.toWeb(createReadStream(filePath, {
    start,
    end: start + length - 1,
    highWaterMark: 1024 * 1024,
  }));
}

async function mapLimit(values, limit, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  let firstError = null;
  async function worker() {
    while (cursor < values.length && firstError === null) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await mapper(values[index], index);
      } catch (error) {
        firstError ??= error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  if (firstError) throw firstError;
  return results;
}

function splitParts(bytes, partSizeBytes) {
  invariant(Number.isSafeInteger(bytes) && bytes > 0, "object byte length is invalid");
  const count = Math.ceil(bytes / partSizeBytes);
  invariant(count <= MAX_PARTS, `object requires more than ${MAX_PARTS} multipart parts`);
  return Array.from({ length: count }, (_, index) => {
    const start = index * partSizeBytes;
    return Object.freeze({
      partNumber: index + 1,
      start,
      length: Math.min(partSizeBytes, bytes - start),
    });
  });
}

function objectHeaders({ bytes, httpMetadata, customMetadata, ifNoneMatch = false }) {
  invariant(Number.isSafeInteger(bytes) && bytes > 0, "object byte length is invalid");
  invariant(SHA256.test(customMetadata?.sha256 ?? ""), "object SHA-256 metadata is invalid");
  invariant(customMetadata?.bytes === String(bytes), "object byte metadata is invalid");
  invariant(httpMetadata?.contentEncoding === "identity", "R2 objects must use identity content encoding");
  invariant(
    typeof httpMetadata?.contentType === "string" &&
      httpMetadata.contentType.length <= 200 &&
      httpMetadata.contentType === httpMetadata.contentType.trim() &&
      httpMetadata.contentType.includes("/") &&
      /^[\x20-\x7e]+$/.test(httpMetadata.contentType),
    "object content type is invalid",
  );
  return {
    "content-encoding": "identity",
    "content-type": httpMetadata.contentType,
    "x-amz-meta-bytes": customMetadata.bytes,
    "x-amz-meta-sha256": customMetadata.sha256,
    ...(ifNoneMatch ? { "if-none-match": "*" } : {}),
  };
}

function ensureSuccessXml(xml) {
  invariant(!/<Error(?:\s|>)/.test(xml), `R2 returned an error in a successful HTTP response: ${xml.slice(0, 500)}`);
}

export class R2S3Store {
  constructor({
    accountId,
    bucket,
    accessKeyId,
    secretAccessKey,
    endpoint,
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    concurrency = 3,
    partSizeBytes = DEFAULT_PART_BYTES,
    singlePutLimitBytes = DEFAULT_SINGLE_PUT_LIMIT,
  }) {
    invariant(SAFE_BUCKET.test(bucket ?? ""), "R2 bucket name is invalid");
    invariant(/^[0-9a-f]{32}$/i.test(accountId ?? ""), "Cloudflare account ID is invalid");
    invariant(typeof accessKeyId === "string" && accessKeyId.length > 0, "CLOUDFLARE_R2_ACCESS_KEY_ID is missing");
    invariant(typeof secretAccessKey === "string" && secretAccessKey.length > 0, "CLOUDFLARE_R2_SECRET_ACCESS_KEY is missing");
    invariant(typeof fetchImpl === "function", "R2 fetch implementation is missing");
    invariant(Number.isInteger(concurrency) && concurrency > 0 && concurrency <= 16, "R2 concurrency must be from 1 through 16");
    invariant(
      Number.isSafeInteger(partSizeBytes) &&
        partSizeBytes >= MIN_MULTIPART_PART_BYTES &&
        partSizeBytes <= MAX_MULTIPART_PART_BYTES,
      `R2 multipart parts must be from ${MIN_MULTIPART_PART_BYTES} through ${MAX_MULTIPART_PART_BYTES} bytes`,
    );
    invariant(Number.isSafeInteger(singlePutLimitBytes) && singlePutLimitBytes > 0, "R2 single PUT limit is invalid");
    const expectedHost = `${accountId.toLowerCase()}.r2.cloudflarestorage.com`;
    const selectedEndpoint = endpoint ?? `https://${expectedHost}`;
    const endpointUrl = new URL(selectedEndpoint);
    invariant(endpointUrl.protocol === "https:", "R2 endpoint must use HTTPS");
    invariant(!endpointUrl.username && !endpointUrl.password, "R2 endpoint cannot include credentials");
    invariant(endpointUrl.host === expectedHost, "R2 endpoint must match the configured Cloudflare account");
    invariant(!endpointUrl.search && !endpointUrl.hash, "R2 endpoint cannot include a query or fragment");
    invariant(endpointUrl.pathname === "/", "R2 endpoint cannot include a path");

    this.bucket = bucket;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.endpoint = endpointUrl.href.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.concurrency = concurrency;
    this.partSizeBytes = partSizeBytes;
    this.singlePutLimitBytes = singlePutLimitBytes;
    this.activeUploadSlots = 0;
    this.uploadSlotWaiters = [];
  }

  async withUploadSlot(callback) {
    if (this.activeUploadSlots < this.concurrency) {
      this.activeUploadSlots += 1;
    } else {
      await new Promise((resolve) => this.uploadSlotWaiters.push(resolve));
    }
    try {
      return await callback();
    } finally {
      const next = this.uploadSlotWaiters.shift();
      if (next) next();
      else this.activeUploadSlots -= 1;
    }
  }

  objectUrl(key, query = {}) {
    invariant(
      typeof key === "string" &&
        key.length > 0 &&
        key.length <= 1024 &&
        key.split("/").every((segment) => SAFE_KEY_SEGMENT.test(segment)),
      "R2 key is invalid",
    );
    const canonicalQuery = Object.entries(query)
      .map(([name, value]) => [rfc3986(name), rfc3986(value)])
      .sort(([leftName, leftValue], [rightName, rightValue]) => {
        if (leftName !== rightName) return leftName < rightName ? -1 : 1;
        if (leftValue === rightValue) return 0;
        return leftValue < rightValue ? -1 : 1;
      })
      .map(([name, value]) => `${name}=${value}`)
      .join("&");
    const url = `${this.endpoint}/${rfc3986(this.bucket)}/${encodeKey(key)}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
    return { url: new URL(url), canonicalQuery };
  }

  authorization({ method, url, canonicalQuery, headers, payloadHash, date }) {
    const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const canonical = {
      ...Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name.toLowerCase(), normalizeHeaderValue(value)]),
      ),
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    const signedHeaders = Object.keys(canonical).sort();
    const canonicalHeaders = `${signedHeaders.map((name) => `${name}:${canonical[name]}`).join("\n")}\n`;
    const canonicalRequest = [
      method,
      url.pathname,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders.join(";"),
      payloadHash,
    ].join("\n");
    const scope = `${dateStamp}/auto/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");
    const dateKey = hmac(`AWS4${this.secretAccessKey}`, dateStamp);
    const regionKey = hmac(dateKey, "auto");
    const serviceKey = hmac(regionKey, "s3");
    const signingKey = hmac(serviceKey, "aws4_request");
    const signature = hmac(signingKey, stringToSign, "hex");
    return {
      amzDate,
      value: `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`,
    };
  }

  async request({
    method,
    key,
    query = {},
    headers = {},
    payloadHash = EMPTY_SHA256,
    body,
    ok = [200],
    allowNotFound = false,
  }) {
    const { url, canonicalQuery } = this.objectUrl(key, query);
    const { amzDate, value: authorization } = this.authorization({
      method,
      url,
      canonicalQuery,
      headers,
      payloadHash,
      date: this.now(),
    });
    const requestHeaders = new Headers(headers);
    requestHeaders.set("authorization", authorization);
    requestHeaders.set("x-amz-content-sha256", payloadHash);
    requestHeaders.set("x-amz-date", amzDate);
    const response = await this.fetchImpl(url, {
      method,
      headers: requestHeaders,
      body,
      redirect: "error",
      ...(body ? { duplex: "half" } : {}),
    });
    if (allowNotFound && response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (!ok.includes(response.status)) {
      const details = (await boundedResponseText(response)).trim();
      const suffix = details ? `: ${details}` : "";
      throw new Error(`R2 ${method} failed for ${key} (${response.status})${suffix}`);
    }
    return response;
  }

  async head(key) {
    const response = await this.request({ method: "HEAD", key, allowNotFound: true });
    if (response === null) return null;
    const size = Number(response.headers.get("content-length"));
    return {
      key,
      size,
      etag: response.headers.get("etag"),
      customMetadata: {
        sha256: response.headers.get("x-amz-meta-sha256"),
        bytes: response.headers.get("x-amz-meta-bytes"),
      },
      httpMetadata: {
        contentType: response.headers.get("content-type"),
        contentEncoding: response.headers.get("content-encoding"),
      },
    };
  }

  async putFile(options) {
    if (options.bytes <= this.singlePutLimitBytes) return this.putFileSingle(options);
    return this.putFileMultipart(options);
  }

  async putFileSingle({ key, filePath, bytes, sha256, httpMetadata, customMetadata, ifNoneMatch }) {
    invariant(sha256 === customMetadata?.sha256, "file payload SHA-256 does not match its custom metadata");
    const headers = {
      ...objectHeaders({ bytes, httpMetadata, customMetadata, ifNoneMatch }),
      "content-length": String(bytes),
    };
    await this.withUploadSlot(async () => {
      const response = await this.request({
        method: "PUT",
        key,
        headers,
        payloadHash: sha256,
        body: fileRangeBody(filePath, 0, bytes),
      });
      await response.body?.cancel().catch(() => {});
    });
  }

  async beginMultipart({ key, bytes, httpMetadata, customMetadata }) {
    const response = await this.request({
      method: "POST",
      key,
      query: { uploads: "" },
      headers: {
        ...objectHeaders({ bytes, httpMetadata, customMetadata }),
        "content-length": "0",
      },
      ok: [200],
    });
    const xml = await boundedResponseText(response);
    ensureSuccessXml(xml);
    return xmlElement(xml, "UploadId");
  }

  async abortMultipart(key, uploadId) {
    await this.request({
      method: "DELETE",
      key,
      query: { uploadId },
      ok: [200, 204],
    }).catch(() => {});
  }

  async completeMultipart({ key, uploadId, parts }) {
    const body = Buffer.from(
      `<CompleteMultipartUpload>${parts.map(({ partNumber, etag }) =>
        `<Part><PartNumber>${partNumber}</PartNumber><ETag>${xmlEscape(etag)}</ETag></Part>`
      ).join("")}</CompleteMultipartUpload>`,
      "utf8",
    );
    const response = await this.request({
      method: "POST",
      key,
      query: { uploadId },
      headers: {
        "content-length": String(body.byteLength),
        "content-type": "application/xml",
      },
      payloadHash: createHash("sha256").update(body).digest("hex"),
      body,
    });
    ensureSuccessXml(await boundedResponseText(response));
  }

  async putFileMultipart({ key, filePath, bytes, httpMetadata, customMetadata }) {
    invariant((await this.head(key)) === null, `refusing to replace existing immutable object: ${key}`);
    const uploadId = await this.beginMultipart({ key, bytes, httpMetadata, customMetadata });
    try {
      const parts = await mapLimit(splitParts(bytes, this.partSizeBytes), this.concurrency, async (part) => {
        return this.withUploadSlot(async () => {
          const digest = await sha256FileRange(filePath, part.start, part.length);
          const response = await this.request({
            method: "PUT",
            key,
            query: { partNumber: String(part.partNumber), uploadId },
            headers: { "content-length": String(part.length) },
            payloadHash: digest,
            body: fileRangeBody(filePath, part.start, part.length),
          });
          const etag = response.headers.get("etag");
          invariant(etag, `R2 multipart upload is missing part ${part.partNumber} ETag`);
          await response.body?.cancel().catch(() => {});
          return { partNumber: part.partNumber, etag };
        });
      });
      await this.completeMultipart({ key, uploadId, parts });
    } catch (error) {
      await this.abortMultipart(key, uploadId);
      throw error;
    }
  }

  async putBytes({ key, bytes: body, sha256, httpMetadata, customMetadata, ifNoneMatch }) {
    invariant(Buffer.isBuffer(body) || body instanceof Uint8Array, "small R2 object body must be bytes");
    invariant(body.byteLength === Number(customMetadata?.bytes), "small R2 object length is inconsistent");
    invariant(createHash("sha256").update(body).digest("hex") === sha256, "small R2 object SHA-256 is inconsistent");
    await this.withUploadSlot(async () => {
      const response = await this.request({
        method: "PUT",
        key,
        headers: {
          ...objectHeaders({ bytes: body.byteLength, httpMetadata, customMetadata, ifNoneMatch }),
          "content-length": String(body.byteLength),
        },
        payloadHash: sha256,
        body,
      });
      await response.body?.cancel().catch(() => {});
    });
  }
}
