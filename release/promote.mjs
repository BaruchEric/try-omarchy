#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { verifyReleaseApprovals } from "./approvals.mjs";
import { validateQcow2BackingFile } from "./qcow2-contract.mjs";
import { R2S3Store } from "./r2-s3-store.mjs";
import {
  validateCheckpointGuestManifestDocument,
  validateCheckpointProducerDocument,
  validateExactProductionRuntimeProfile,
  validateProductionRuntimeContract,
} from "./runtime-contract.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const DEFAULT_CONCURRENCY = 3;
const MANIFEST_NAME = "artifact-manifest.json";
const CLEARANCE_NAME = "clearance.json";
const RESERVED_ARTIFACT_PATHS = new Set([MANIFEST_NAME, CLEARANCE_NAME]);
const MAX_CHECKPOINT_METADATA_BYTES = 4 * 1024 * 1024;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function assertSafeArtifactPath(value, label = "artifact path") {
  invariant(typeof value === "string" && value.length > 0, `${label} is missing`);
  invariant(value.length <= 768, `${label} is too long: ${value}`);
  invariant(!value.includes("%") && !value.includes("\\"), `${label} is not canonical: ${value}`);
  invariant(!path.posix.isAbsolute(value), `${label} must be relative: ${value}`);
  const segments = value.split("/");
  invariant(
    segments.length > 0 && segments.every((segment) => PATH_SEGMENT.test(segment)),
    `${label} contains an unsafe segment: ${value}`,
  );
  return value;
}

export function deriveReleaseId(manifestBytes) {
  invariant(
    typeof manifestBytes === "string" || Buffer.isBuffer(manifestBytes) || manifestBytes instanceof Uint8Array,
    "artifact manifest bytes are required to derive the release identifier",
  );
  return createHash("sha256").update(manifestBytes).digest("hex");
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function resolveInside(root, relativePath) {
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, relativePath);
  invariant(
    target.startsWith(`${absoluteRoot}${path.sep}`),
    `artifact escapes the release directory: ${relativePath}`,
  );
  return target;
}

async function releaseRootIdentity(releaseDirectory) {
  const requestedRoot = path.resolve(releaseDirectory);
  const requestedInfo = await lstat(requestedRoot);
  invariant(!requestedInfo.isSymbolicLink(), "release directory cannot be a symbolic link");
  invariant(requestedInfo.isDirectory(), "release directory is not a directory");
  // Canonicalize platform aliases such as macOS /var -> /private/var once,
  // then reject every symlink component beneath this trusted boundary.
  const realRoot = await realpath(requestedRoot);
  return { absoluteRoot: realRoot, realRoot };
}

async function resolveVerifiedRegularFile(rootIdentity, relativePath, label = "release artifact") {
  const { absoluteRoot, realRoot } = rootIdentity;
  const target = resolveInside(absoluteRoot, relativePath);
  let cursor = absoluteRoot;
  const segments = relativePath.split("/");
  let info = null;
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    info = await lstat(cursor);
    invariant(!info.isSymbolicLink(), `${label} traverses a symbolic link: ${relativePath}`);
    if (index < segments.length - 1) {
      invariant(info.isDirectory(), `${label} parent is not a directory: ${relativePath}`);
    }
  }
  invariant(info?.isFile(), `${label} is not a regular file: ${relativePath}`);
  const realTarget = await realpath(target);
  invariant(
    realTarget.startsWith(`${realRoot}${path.sep}`),
    `${label} escapes the real release directory: ${relativePath}`,
  );
  return { filePath: target, info };
}

function validateMediaType(value, artifactPath) {
  invariant(
    typeof value === "string" &&
      value.length <= 200 &&
      value === value.trim() &&
      value.includes("/") &&
      /^[\x20-\x7e]+$/.test(value),
    `artifact media type is invalid: ${artifactPath}`,
  );
  return value;
}

function validateManifestArtifacts(manifest) {
  invariant(manifest?.schemaVersion === 1, "artifact manifest has an unsupported schema");
  invariant(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0, "artifact manifest has no artifacts");
  const seenPaths = new Set();
  let rootfsCount = 0;
  const artifacts = manifest.artifacts.map((artifact) => {
    invariant(isRecord(artifact), "artifact manifest contains invalid metadata");
    const artifactPath = assertSafeArtifactPath(artifact.path);
    invariant(!RESERVED_ARTIFACT_PATHS.has(artifactPath), `${artifactPath} is reserved release metadata`);
    invariant(!seenPaths.has(artifactPath), `duplicate artifact path: ${artifactPath}`);
    invariant(Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0, `artifact size is invalid: ${artifactPath}`);
    invariant(SHA256.test(artifact.sha256 ?? ""), `artifact SHA-256 is not canonical: ${artifactPath}`);
    invariant(typeof artifact.role === "string" && artifact.role.length > 0, `artifact role is missing: ${artifactPath}`);
    if (artifact.role === "guest-rootfs") rootfsCount += 1;
    seenPaths.add(artifactPath);
    return Object.freeze({
      path: artifactPath,
      role: artifact.role,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      mediaType: validateMediaType(artifact.mediaType, artifactPath),
    });
  });
  invariant(rootfsCount === 1, "artifact manifest must contain exactly one guest-rootfs artifact");
  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

async function mapLimit(values, limit, mapper) {
  invariant(Number.isInteger(limit) && limit > 0 && limit <= 16, "concurrency must be an integer from 1 through 16");
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

async function verifyLocalArtifact(rootIdentity, artifact) {
  const { filePath, info } = await resolveVerifiedRegularFile(rootIdentity, artifact.path);
  const digest = await sha256File(filePath);
  const after = await lstat(filePath);
  invariant(
    !after.isSymbolicLink() &&
      after.isFile() &&
      info.dev === after.dev &&
      info.ino === after.ino &&
      info.size === after.size &&
      info.mtimeMs === after.mtimeMs,
    `release artifact changed while it was being verified: ${artifact.path}`,
  );
  invariant(after.size === artifact.bytes, `artifact size does not match its manifest: ${artifact.path}`);
  invariant(digest === artifact.sha256, `artifact SHA-256 does not match its manifest: ${artifact.path}`);
  return Object.freeze({ ...artifact, filePath });
}

async function readVerifiedRuntimeManifest(runtimeManifestItem) {
  invariant(
    runtimeManifestItem.role === "runtime-config",
    "runtime-manifest.json must use role runtime-config",
  );
  invariant(
    runtimeManifestItem.mediaType === "application/json",
    "runtime-manifest.json must use media type application/json",
  );
  const bytes = await readFile(runtimeManifestItem.filePath);
  invariant(
    bytes.byteLength === runtimeManifestItem.bytes,
    "runtime-manifest.json size changed after artifact verification",
  );
  invariant(
    createHash("sha256").update(bytes).digest("hex") === runtimeManifestItem.sha256,
    "runtime-manifest.json digest changed after artifact verification",
  );
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`runtime-manifest.json is not valid JSON: ${error.message}`);
  }
}

async function readVerifiedJsonArtifact(item, label, maximumBytes) {
  invariant(item, `${label} is not packaged`);
  invariant(item.bytes <= maximumBytes, `${label} exceeds the ${maximumBytes}-byte verification limit`);
  const bytes = await readFile(item.filePath);
  invariant(bytes.byteLength === item.bytes, `${label} size changed after artifact verification`);
  invariant(
    createHash("sha256").update(bytes).digest("hex") === item.sha256,
    `${label} digest changed after artifact verification`,
  );
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function validateVerifiedCheckpointProducer(runtimeManifest, artifacts) {
  if (!Object.hasOwn(runtimeManifest, "checkpoint")) return null;
  const checkpoint = runtimeManifest.checkpoint;
  const producerItem = artifacts.find(
    ({ path: artifactPath }) => artifactPath === checkpoint.producer.manifestArtifactPath,
  );
  const guestManifestItem = artifacts.find(
    ({ path: artifactPath }) => artifactPath === "guest-manifest.json",
  );
  const [producerDocument, guestManifestDocument] = await Promise.all([
    readVerifiedJsonArtifact(
      producerItem,
      "checkpoint producer manifest",
      MAX_CHECKPOINT_METADATA_BYTES,
    ),
    readVerifiedJsonArtifact(
      guestManifestItem,
      "checkpoint base guest manifest",
      MAX_CHECKPOINT_METADATA_BYTES,
    ),
  ]);
  await validateCheckpointProducerDocument(
    producerDocument,
    checkpoint,
    guestManifestDocument.upstream,
  );
  return guestManifestDocument;
}

async function validateVerifiedCheckpointQcow2(runtimeManifest, artifacts) {
  if (!Object.hasOwn(runtimeManifest, "checkpoint")) return;
  const descriptor = runtimeManifest.checkpoint.bootDelta;
  const item = artifacts.find(({ path: artifactPath }) => artifactPath === descriptor.artifactPath);
  const rootfs = artifacts.find(
    ({ path: artifactPath }) => artifactPath === runtimeManifest.guest.rootfs.artifactPath,
  );
  invariant(item, "checkpoint boot delta is not packaged");
  invariant(rootfs, "checkpoint backing rootfs is not packaged");
  await validateQcow2BackingFile(item.filePath, {
    expectedFilename: descriptor.backingFilename,
    expectedFormat: descriptor.backingFormat,
    expectedBytes: descriptor.bytes,
    expectedVirtualBytes: rootfs.bytes,
  });
}

function metadataFor(item) {
  return Object.freeze({
    httpMetadata: Object.freeze({
      contentType: item.mediaType,
      contentEncoding: "identity",
    }),
    customMetadata: Object.freeze({
      sha256: item.sha256,
      bytes: String(item.bytes),
    }),
  });
}

function assertStoredObject(object, item, key) {
  invariant(isRecord(object), `uploaded object is missing: ${key}`);
  invariant(object.key === undefined || object.key === key, `storage returned the wrong key for ${key}`);
  invariant(Number(object.size) === item.bytes, `uploaded object size is wrong: ${key}`);
  invariant(typeof object.etag === "string" && object.etag.length > 0, `uploaded object generation is missing: ${key}`);
  invariant(object.customMetadata?.sha256 === item.sha256, `uploaded object SHA-256 metadata is wrong: ${key}`);
  invariant(object.customMetadata?.bytes === String(item.bytes), `uploaded object byte metadata is wrong: ${key}`);
  invariant(object.httpMetadata?.contentType === item.mediaType, `uploaded object content type is wrong: ${key}`);
  invariant(
    object.httpMetadata?.contentEncoding === "identity",
    `uploaded object content encoding is not identity: ${key}`,
  );
  return object;
}

function sha256Base64(hexDigest) {
  return Buffer.from(hexDigest, "hex").toString("base64");
}

async function verifyHttpResponseMetadata(response, item, url) {
  invariant(response.ok, `deployed HEAD failed (${response.status}): ${url}`);
  invariant(response.headers.get("content-length") === String(item.bytes), `deployed size is wrong: ${url}`);
  invariant(response.headers.get("content-encoding") === "identity", `deployed encoding is not identity: ${url}`);
  invariant(response.headers.get("content-type") === item.mediaType, `deployed content type is wrong: ${url}`);
  invariant(response.headers.get("etag") === `"sha256-${item.sha256}"`, `deployed ETag is wrong: ${url}`);
  invariant(
    response.headers.get("repr-digest") === `sha-256=:${sha256Base64(item.sha256)}:`,
    `deployed representation digest is wrong: ${url}`,
  );
}

function validateDeployedItems(releaseId, items) {
  invariant(SHA256.test(releaseId ?? ""), "deployed release identifier must be 64 lowercase hexadecimal characters");
  invariant(Array.isArray(items) && items.length > 0, "deployed release has no artifacts");
  for (const item of items) {
    assertSafeArtifactPath(item?.path);
    invariant(Number.isSafeInteger(item?.bytes) && item.bytes > 0, `deployed artifact size is invalid: ${item?.path}`);
    invariant(SHA256.test(item?.sha256 ?? ""), `deployed artifact SHA-256 is invalid: ${item?.path}`);
    validateMediaType(item?.mediaType, item?.path);
  }
}

function deployedReleaseRoot(deployedBaseUrl, releaseId) {
  const root = new URL(deployedBaseUrl);
  invariant(root.protocol === "https:", "deployedBaseUrl must use HTTPS");
  invariant(!root.username && !root.password, "deployedBaseUrl cannot include credentials");
  invariant(!root.search && !root.hash, "deployedBaseUrl cannot include a query or fragment");
  if (!root.pathname.endsWith("/")) root.pathname += "/";
  invariant(
    root.pathname.endsWith("/omarchy/versions/"),
    "deployedBaseUrl must end with /omarchy/versions/",
  );
  return new URL(`${releaseId}/`, root);
}

export async function verifyUnclearedReleaseHidden(
  { deployedBaseUrl, releaseId, items },
  { fetchImpl = globalThis.fetch, concurrency = DEFAULT_CONCURRENCY } = {},
) {
  invariant(typeof fetchImpl === "function", "a fetch implementation is required for deployed verification");
  validateDeployedItems(releaseId, items);
  const releaseRoot = deployedReleaseRoot(deployedBaseUrl, releaseId);
  await mapLimit(items, concurrency, async (item) => {
    const url = new URL(item.path, releaseRoot);
    const response = await fetchImpl(url, { method: "HEAD", redirect: "error" });
    invariant(
      response.status === 404 &&
        response.headers.get("x-omarchy-artifact-error") === "RELEASE_NOT_CLEARED",
      `deployed route exposed or ambiguously rejected an uncleared artifact (${response.status}): ${url.href}`,
    );
    await response.body?.cancel().catch(() => {});
  });
}

export async function verifyDeployedRelease(
  { deployedBaseUrl, releaseId, items },
  { fetchImpl = globalThis.fetch, concurrency = DEFAULT_CONCURRENCY } = {},
) {
  invariant(typeof fetchImpl === "function", "a fetch implementation is required for deployed verification");
  validateDeployedItems(releaseId, items);
  const releaseRoot = deployedReleaseRoot(deployedBaseUrl, releaseId);

  await mapLimit(items, concurrency, async (item) => {
    const url = new URL(item.path, releaseRoot);
    const response = await fetchImpl(url, { method: "HEAD", redirect: "error" });
    await verifyHttpResponseMetadata(response, item, url.href);
  });

  const rootfs = items.filter((item) => item.role === "guest-rootfs");
  invariant(rootfs.length === 1, "release must have exactly one guest root filesystem");
  const checkpointPaged = items.filter((item) =>
    item.role === "preboot-vmstate" || item.role === "preboot-disk-delta");
  invariant(
    checkpointPaged.length === 0 || checkpointPaged.length === 2,
    "deployed checkpoint range artifacts are partial",
  );
  for (const item of [...rootfs, ...checkpointPaged]) {
    const url = new URL(item.path, releaseRoot);
    const expectedEtag = `"sha256-${item.sha256}"`;
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Range: "bytes=0-0", "If-Match": expectedEtag },
      redirect: "error",
    });
    invariant(response.status === 206, `deployed range failed (${response.status}): ${url.href}`);
    invariant(
      response.headers.get("content-range") === `bytes 0-0/${item.bytes}`,
      `deployed artifact returned the wrong range: ${url.href}`,
    );
    invariant(
      response.headers.get("content-length") === "1",
      `deployed artifact range returned the wrong length: ${url.href}`,
    );
    invariant(
      response.headers.get("content-encoding") === "identity",
      `deployed artifact range is encoded: ${url.href}`,
    );
    invariant(
      response.headers.get("etag") === expectedEtag,
      `deployed artifact range ETag is wrong: ${url.href}`,
    );
    invariant(
      (await response.arrayBuffer()).byteLength === 1,
      `deployed artifact range body is not one byte: ${url.href}`,
    );
  }
}

export async function prepareRelease(releaseDirectory, { concurrency = DEFAULT_CONCURRENCY } = {}) {
  const rootIdentity = await releaseRootIdentity(releaseDirectory);
  const { filePath: manifestPath, info: manifestInfo } = await resolveVerifiedRegularFile(
    rootIdentity,
    MANIFEST_NAME,
    "artifact manifest",
  );
  const manifestBytes = await readFile(manifestPath);
  const manifestAfter = await lstat(manifestPath);
  invariant(
    !manifestAfter.isSymbolicLink() &&
      manifestAfter.isFile() &&
      manifestInfo.dev === manifestAfter.dev &&
      manifestInfo.ino === manifestAfter.ino &&
      manifestInfo.size === manifestAfter.size &&
      manifestInfo.mtimeMs === manifestAfter.mtimeMs &&
      manifestBytes.byteLength === manifestAfter.size,
    "artifact manifest changed while it was being read",
  );
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`artifact manifest is not valid JSON: ${error.message}`);
  }
  // The URL identity binds the exact representation visitors fetch and verify,
  // including its whitespace and trailing newline.
  const releaseId = deriveReleaseId(manifestBytes);
  invariant(SHA256.test(releaseId), "derived release identifier is invalid");
  const manifestArtifacts = validateManifestArtifacts(manifest);
  const verifiedArtifacts = await mapLimit(
    manifestArtifacts,
    concurrency,
    (artifact) => verifyLocalArtifact(rootIdentity, artifact),
  );
  const runtimeManifestItem = verifiedArtifacts.find(
    (artifact) => artifact.path === "runtime-manifest.json",
  );
  invariant(runtimeManifestItem, "artifact manifest must package runtime-manifest.json");
  const runtimeManifest = await readVerifiedRuntimeManifest(runtimeManifestItem);
  validateExactProductionRuntimeProfile(runtimeManifest);
  const checkpointGuestManifest = await validateVerifiedCheckpointProducer(
    runtimeManifest,
    verifiedArtifacts,
  );
  validateProductionRuntimeContract(runtimeManifest, verifiedArtifacts);
  await validateVerifiedCheckpointQcow2(runtimeManifest, verifiedArtifacts);
  if (checkpointGuestManifest !== null) {
    validateCheckpointGuestManifestDocument(
      checkpointGuestManifest,
      runtimeManifest.checkpoint,
    );
  }
  const manifestItem = Object.freeze({
    path: MANIFEST_NAME,
    role: "artifact-manifest",
    bytes: manifestBytes.byteLength,
    sha256: createHash("sha256").update(manifestBytes).digest("hex"),
    mediaType: "application/json",
    filePath: manifestPath,
  });
  return Object.freeze({
    releaseDirectory: rootIdentity.absoluteRoot,
    rootIdentity,
    releaseId,
    manifest,
    manifestBytes,
    items: Object.freeze([...verifiedArtifacts, manifestItem]),
  });
}

async function snapshotRelease(prepared, { snapshotRoot, snapshotMode = "reflink-required" } = {}) {
  invariant(
    snapshotMode === "reflink-required" || snapshotMode === "copy",
    "snapshotMode must be reflink-required or copy",
  );
  const selectedRoot = path.resolve(snapshotRoot ?? path.dirname(prepared.releaseDirectory));
  invariant(
    selectedRoot !== prepared.releaseDirectory &&
      !selectedRoot.startsWith(`${prepared.releaseDirectory}${path.sep}`),
    "snapshotRoot must be outside the release directory",
  );
  await mkdir(selectedRoot, { recursive: true, mode: 0o700 });
  const snapshotRootIdentity = await releaseRootIdentity(selectedRoot);
  const snapshotDirectory = await mkdtemp(path.join(snapshotRootIdentity.absoluteRoot, ".omarchy-release-snapshot-"));
  try {
    if (snapshotMode === "reflink-required") {
      invariant(
        Number.isInteger(fsConstants.COPYFILE_FICLONE_FORCE),
        "this Node runtime cannot require copy-on-write release snapshots",
      );
    }
    const copyMode = snapshotMode === "reflink-required" ? fsConstants.COPYFILE_FICLONE_FORCE : 0;
    for (const item of prepared.items) {
      const destination = path.join(snapshotDirectory, item.path);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(item.filePath, destination, copyMode);
      await chmod(destination, 0o400);
    }
    const rootIdentity = await releaseRootIdentity(snapshotDirectory);
    const items = [];
    for (const item of prepared.items) {
      items.push(await verifyLocalArtifact(rootIdentity, item));
    }
    return Object.freeze({ directory: snapshotDirectory, rootIdentity, items: Object.freeze(items) });
  } catch (error) {
    await rm(snapshotDirectory, { recursive: true, force: false }).catch(() => {});
    throw error;
  }
}

async function assertKeysAbsent(store, keys, concurrency) {
  await mapLimit(keys, concurrency, async (key) => {
    invariant((await store.head(key)) === null, `refusing to replace existing immutable object: ${key}`);
  });
}

async function verifyStoredItems(store, entries, concurrency) {
  return mapLimit(entries, concurrency, async ({ key, item }) => {
    const object = assertStoredObject(await store.head(key), item, key);
    return { key, item, etag: object.etag };
  });
}

export function createReleaseClearance(releaseId, approvalGrant) {
  const body = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    releaseId,
    artifactManifestSha256: releaseId,
    approvalEvidenceSha256: approvalGrant.evidenceSha256,
    approvalPolicySha256: approvalGrant.policySha256,
    approvals: {
      licensing: approvalGrant.approvals.licensing,
      runtime: approvalGrant.approvals.runtime,
      security: approvalGrant.approvals.security,
      product: approvalGrant.approvals.product,
    },
  }, null, 2)}\n`, "utf8");
  invariant(body.byteLength <= 64 * 1024, "release clearance exceeds the artifact route limit");
  return body;
}

function stagingClaim(releaseId, manifestItem, artifactCount, approvalGrant) {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    purpose: "exclusive immutable release upload claim",
    releaseId,
    artifactManifest: {
      bytes: manifestItem.bytes,
      sha256: manifestItem.sha256,
    },
    artifactCount,
    approvalEvidenceSha256: approvalGrant.evidenceSha256,
    approvalPolicySha256: approvalGrant.policySha256,
  }, null, 2)}\n`, "utf8");
}

export async function promoteRelease({
  releaseDirectory,
  store,
  deployedBaseUrl,
  approvalsFile,
  approvalPolicyFile,
  trustedApprovalPolicySha256,
  snapshotRoot,
  snapshotMode = "reflink-required",
  fetchImpl = globalThis.fetch,
  concurrency = DEFAULT_CONCURRENCY,
}) {
  invariant(store && typeof store.head === "function", "release storage does not implement head");
  invariant(typeof store.putFile === "function", "release storage does not implement streaming file uploads");
  invariant(typeof store.putBytes === "function", "release storage does not implement small object uploads");

  const prepared = await prepareRelease(releaseDirectory, { concurrency });
  const { releaseId } = prepared;
  const approvalGrant = await verifyReleaseApprovals({
    releaseId,
    manifestBytes: prepared.manifestBytes,
    approvalsFile,
    approvalPolicyFile,
    trustedApprovalPolicySha256,
  });

  // This check runs before the first storage write. It proves that the
  // deployed route understands the clearance contract for this exact ID,
  // even while none of the target artifact keys exist yet.
  await verifyUnclearedReleaseHidden(
    { deployedBaseUrl, releaseId, items: prepared.items },
    { fetchImpl, concurrency },
  );

  const snapshot = await snapshotRelease(prepared, { snapshotRoot, snapshotMode });
  try {
    const { items } = snapshot;
    const versionPrefix = `omarchy/versions/${releaseId}`;
    const clearanceKey = `${versionPrefix}/${CLEARANCE_NAME}`;
    const claimKey = `omarchy/staging/${releaseId}/claim.json`;
    const versionEntries = items.map((item) => ({ item, key: `${versionPrefix}/${item.path}` }));

    // Existing keys are never interpreted as a resumable upload. The small,
    // conditional claim serializes writers because R2 does not offer a
    // conditional CompleteMultipartUpload operation for the 6+ GiB rootfs.
    await assertKeysAbsent(
      store,
      [claimKey, ...versionEntries.map(({ key }) => key), clearanceKey],
      concurrency,
    );

    const manifestItem = items.find((item) => item.path === MANIFEST_NAME);
    const claimBody = stagingClaim(releaseId, manifestItem, items.length, approvalGrant);
    const claimItem = {
      bytes: claimBody.byteLength,
      sha256: createHash("sha256").update(claimBody).digest("hex"),
      mediaType: "application/json",
    };
    await store.putBytes({
      key: claimKey,
      bytes: claimBody,
      sha256: claimItem.sha256,
      ...metadataFor(claimItem),
      ifNoneMatch: true,
    });
    assertStoredObject(await store.head(claimKey), claimItem, claimKey);

    await mapLimit(versionEntries, concurrency, async ({ key, item }) => {
      await store.putFile({
        key,
        filePath: item.filePath,
        bytes: item.bytes,
        sha256: item.sha256,
        ...metadataFor(item),
        ifNoneMatch: true,
      });
    });
    await verifyStoredItems(store, versionEntries, concurrency);

    // The upload can only read the frozen copy-on-write/full-copy snapshot.
    // Verify that same snapshot once more before creating clearance.
    await mapLimit(items, concurrency, (item) => verifyLocalArtifact(snapshot.rootIdentity, item));

    // Canonical keys now exist, but the route must still hide every one. A
    // 200, a generic 404, or a missing denial header aborts clearance.
    await verifyUnclearedReleaseHidden(
      { deployedBaseUrl, releaseId, items },
      { fetchImpl, concurrency },
    );

    const clearanceBody = createReleaseClearance(releaseId, approvalGrant);
    const clearanceItem = {
      path: CLEARANCE_NAME,
      role: "release-clearance",
      bytes: clearanceBody.byteLength,
      sha256: createHash("sha256").update(clearanceBody).digest("hex"),
      mediaType: "application/json",
    };
    await store.putBytes({
      key: clearanceKey,
      bytes: clearanceBody,
      sha256: clearanceItem.sha256,
      ...metadataFor(clearanceItem),
      ifNoneMatch: true,
    });
    assertStoredObject(await store.head(clearanceKey), clearanceItem, clearanceKey);

    // Positive deployed verification is mandatory immediately after the
    // single-object clearance boundary becomes visible.
    await verifyDeployedRelease(
      { deployedBaseUrl, releaseId, items: [...items, clearanceItem] },
      { fetchImpl, concurrency },
    );

    return Object.freeze({
      releaseId,
      artifactCount: items.length,
      versionPrefix,
      clearanceKey,
      claimKey,
      approvalEvidenceSha256: approvalGrant.evidenceSha256,
      approvalPolicySha256: approvalGrant.policySha256,
    });
  } finally {
    await rm(snapshot.directory, { recursive: true, force: false });
  }
}

function parseArguments(argv) {
  const args = { config: null, upload: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--config") args.config = argv[++index];
    else if (argv[index] === "--upload") args.upload = true;
    else throw new Error("Usage: node release/promote.mjs --config promotion-input.json [--upload]");
  }
  invariant(args.config, "Usage: node release/promote.mjs --config promotion-input.json [--upload]");
  return args;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const configPath = path.resolve(args.config);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  invariant(isRecord(config), "promotion config must be an object");
  const configRoot = path.dirname(configPath);
  invariant(typeof config.releaseDirectory === "string" && config.releaseDirectory.length > 0, "releaseDirectory is missing");
  const releaseDirectory = path.resolve(configRoot, config.releaseDirectory);
  const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;

  process.stderr.write(
    "NOTICE: upload requires four independently signed, release-bound approvals; validation-only mode grants no clearance.\n",
  );
  if (!args.upload) {
    const prepared = await prepareRelease(releaseDirectory, { concurrency });
    process.stdout.write(`${JSON.stringify({
      mode: "validation-only",
      releaseId: prepared.releaseId,
      artifacts: prepared.items.length,
    }, null, 2)}\n`);
    return;
  }

  invariant(typeof config.bucket === "string" && config.bucket.length > 0, "R2 bucket is missing");
  invariant(typeof config.approvalsFile === "string" && config.approvalsFile.length > 0, "approvalsFile is missing");
  invariant(typeof config.approvalPolicyFile === "string" && config.approvalPolicyFile.length > 0, "approvalPolicyFile is missing");
  invariant(typeof config.deployedBaseUrl === "string" && config.deployedBaseUrl.length > 0, "deployedBaseUrl is required for upload");
  const store = new R2S3Store({
    accountId: config.accountId,
    bucket: config.bucket,
    endpoint: config.endpoint,
    accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
    concurrency,
    partSizeBytes: config.partSizeBytes,
  });
  const result = await promoteRelease({
    releaseDirectory,
    store,
    deployedBaseUrl: config.deployedBaseUrl,
    approvalsFile: path.resolve(configRoot, config.approvalsFile),
    approvalPolicyFile: path.resolve(configRoot, config.approvalPolicyFile),
    trustedApprovalPolicySha256: process.env.OMARCHY_APPROVAL_POLICY_SHA256,
    snapshotRoot: config.snapshotRoot ? path.resolve(configRoot, config.snapshotRoot) : undefined,
    snapshotMode: config.snapshotMode,
    concurrency,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
