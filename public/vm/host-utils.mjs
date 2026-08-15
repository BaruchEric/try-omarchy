import {
  copyDesktopProof,
  DESKTOP_PROOF_SAMPLE_PIXELS,
} from "./desktop-proof.mjs";

export const EXPECTED_UPSTREAM = Object.freeze({
  repository: "https://github.com/basecamp/omarchy",
  commit: "f0020448ca87329199de7cb12f2015ebc4a3e5e7",
  version: "4.0.0.alpha",
  treeSha256:
    "7c053841c0b43df796cb002441f3e0cccad4a32288769f499c86b509b4f86980",
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_WORKER_BYTES = 4 * 1024 * 1024;
const MAX_BOOTSTRAP_BYTES = MAX_MANIFEST_BYTES * 3 + MAX_WORKER_BYTES;
const CHECKPOINT_SOURCE_EVIDENCE_KEYS = Object.freeze([
  "normalizedGuestReportSha256",
  "reportValidationSha256",
  "checkpointFrameSha256",
  "checkpointFrameHealthSha256",
]);

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function hasExactKeys(value, expectedKeys) {
  return (
    isRecord(value) &&
    Object.keys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function normalizedJsonValue(value) {
  if (Array.isArray(value)) return value.map((item) => normalizedJsonValue(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizedJsonValue(value[key])]),
  );
}

function normalizedJsonText(value) {
  return JSON.stringify(normalizedJsonValue(value));
}

function sameJsonValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJsonValue(item, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && sameJsonValue(left[key], right[key]),
    )
  );
}

function normalizeCheckpointDigests(value) {
  if (!hasExactKeys(value, CHECKPOINT_SOURCE_EVIDENCE_KEYS)) return null;
  if (
    CHECKPOINT_SOURCE_EVIDENCE_KEYS.some(
      (key) =>
        typeof value[key] !== "string" ||
        !SHA256_PATTERN.test(value[key]) ||
        value[key] !== value[key].toLowerCase(),
    )
  ) {
    return null;
  }
  return Object.freeze(
    Object.fromEntries(
      CHECKPOINT_SOURCE_EVIDENCE_KEYS.map((key) => [key, value[key]]),
    ),
  );
}

export function normalizeGuestReportProvenance(value) {
  if (!isRecord(value) || typeof value.origin !== "string") return null;
  if (value.origin === "live-guest-serial") {
    return hasExactKeys(value, ["origin"])
      ? Object.freeze({ origin: "live-guest-serial" })
      : null;
  }
  if (
    value.origin !== "checkpoint-source-evidence" ||
    !hasExactKeys(value, ["origin", "sourceEvidence"])
  ) {
    return null;
  }
  const sourceEvidence = normalizeCheckpointDigests(value.sourceEvidence);
  return sourceEvidence
    ? Object.freeze({
        origin: "checkpoint-source-evidence",
        sourceEvidence,
      })
    : null;
}

export function guestReportProvenanceMatches(value, expected) {
  const actual = normalizeGuestReportProvenance(value);
  const required = normalizeGuestReportProvenance(expected);
  if (!actual || !required || actual.origin !== required.origin) return false;
  if (actual.origin === "live-guest-serial") return true;
  return CHECKPOINT_SOURCE_EVIDENCE_KEYS.every(
    (key) => actual.sourceEvidence[key] === required.sourceEvidence[key],
  );
}

function mediaType(value) {
  return String(value ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

function isJavaScriptMediaType(value) {
  return [
    "application/javascript",
    "application/ecmascript",
    "text/javascript",
    "text/ecmascript",
  ].includes(mediaType(value));
}

function canonicalUpstream(value) {
  if (!isRecord(value)) return null;
  const matches = Object.entries(EXPECTED_UPSTREAM).every(
    ([key, expected]) => value[key] === expected,
  );
  return matches ? { ...EXPECTED_UPSTREAM } : null;
}

function parseDeclaredLength(response, label, maximum) {
  const header = response.headers.get("content-length");
  if (header === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(header)) {
    fail(`${label} has an invalid Content-Length.`);
  }
  const value = Number(header);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    fail(`${label} exceeds its ${maximum}-byte bootstrap limit.`);
  }
  return value;
}

async function responseBytes(response, label, maximum) {
  const declared = parseDeclaredLength(response, label, maximum);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > maximum) {
    fail(`${label} exceeds its ${maximum}-byte bootstrap limit.`);
  }
  if (declared !== null && declared !== bytes.byteLength) {
    fail(`${label} body length differs from Content-Length.`);
  }
  return bytes;
}

export async function sha256Hex(bytes, cryptoScope = globalThis.crypto) {
  if (typeof cryptoScope?.subtle?.digest !== "function") {
    fail("SHA-256 verification is unavailable in this browser.");
  }
  const digest = await cryptoScope.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(digest),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}

export function isSelfContainedWorkerSource(source) {
  if (typeof source !== "string" || source.length === 0) return false;
  // Blob module Workers cannot resolve relative static imports. The production
  // Worker may still use dynamic import() with absolute release URLs after it
  // validates the referenced artifacts itself.
  return (
    !/(?:^|[;}\n])\s*import\s+(?!\()/m.test(source) &&
    !/(?:^|[;}\n])\s*export\s+[^;\n]+\s+from\s+["']/m.test(source)
  );
}

function jsonArtifactRecord(manifest, path, role, maximum) {
  const records = manifest.artifacts.filter(
    (artifact) => isRecord(artifact) && artifact.path === path,
  );
  if (records.length !== 1) {
    fail(`Artifact manifest must contain exactly one ${path}.`);
  }
  const artifact = records[0];
  if (
    artifact.role !== role ||
    mediaType(artifact.mediaType) !== "application/json" ||
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes <= 0 ||
    artifact.bytes > maximum ||
    typeof artifact.sha256 !== "string" ||
    !SHA256_PATTERN.test(artifact.sha256)
  ) {
    fail(`${path} metadata is invalid.`);
  }
  return artifact;
}

async function fetchVerifiedJsonArtifact(
  artifact,
  releaseBaseUrl,
  label,
  fetchImpl,
  cryptoScope,
) {
  const url = new URL(artifact.path, releaseBaseUrl);
  const response = await fetchImpl(url, {
    credentials: "same-origin",
    cache: "force-cache",
    redirect: "error",
  });
  if (!response.ok) {
    fail(`${label} request failed with HTTP ${response.status}: ${url.pathname}`);
  }
  if (mediaType(response.headers.get("content-type")) !== "application/json") {
    fail(`${label} has an unsafe Content-Type.`);
  }
  const bytes = await responseBytes(response, label, MAX_MANIFEST_BYTES);
  if (bytes.byteLength !== artifact.bytes) {
    fail(`${label} body length differs from the artifact manifest.`);
  }
  if ((await sha256Hex(bytes, cryptoScope)) !== artifact.sha256) {
    fail(`${label} SHA-256 differs from the artifact manifest.`);
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail(`${label} is not valid JSON.`);
  }
  return { bytes, value };
}

async function verifiedGuestReportContract({
  manifest,
  releaseBaseUrl,
  upstream,
  fetchImpl,
  cryptoScope,
}) {
  const runtimeRecords = manifest.artifacts.filter(
    (artifact) => isRecord(artifact) && artifact.path === "runtime-manifest.json",
  );
  if (runtimeRecords.length === 0) {
    return {
      bytes: 0,
      guestReportProvenance: Object.freeze({ origin: "live-guest-serial" }),
      checkpointGuestReport: null,
    };
  }
  const runtimeArtifact = jsonArtifactRecord(
    manifest,
    "runtime-manifest.json",
    "runtime-config",
    MAX_MANIFEST_BYTES,
  );
  const runtimeFile = await fetchVerifiedJsonArtifact(
    runtimeArtifact,
    releaseBaseUrl,
    "Runtime manifest",
    fetchImpl,
    cryptoScope,
  );
  const runtimeManifest = runtimeFile.value;
  if (!isRecord(runtimeManifest) || runtimeManifest.schemaVersion !== 2) {
    fail("Runtime manifest has an unsupported schema.");
  }
  if (!Object.hasOwn(runtimeManifest, "checkpoint")) {
    return {
      bytes: runtimeFile.bytes.byteLength,
      guestReportProvenance: Object.freeze({ origin: "live-guest-serial" }),
      checkpointGuestReport: null,
    };
  }

  const checkpoint = runtimeManifest.checkpoint;
  if (
    !isRecord(checkpoint) ||
    checkpoint.schemaVersion !== 1 ||
    checkpoint.mode !== "preboot-resume" ||
    !isRecord(checkpoint.producer) ||
    !hasExactKeys(checkpoint.producer, [
      "manifestArtifactPath",
      "manifestBytes",
      "manifestSha256",
      "qemuBinarySha256",
    ]) ||
    checkpoint.producer.manifestArtifactPath !== "checkpoint-manifest.json" ||
    !Number.isSafeInteger(checkpoint.producer.manifestBytes) ||
    checkpoint.producer.manifestBytes <= 0 ||
    checkpoint.producer.manifestBytes > MAX_MANIFEST_BYTES ||
    !SHA256_PATTERN.test(checkpoint.producer.manifestSha256 ?? "") ||
    !SHA256_PATTERN.test(checkpoint.producer.qemuBinarySha256 ?? "")
  ) {
    fail("Runtime checkpoint producer metadata is invalid.");
  }
  const checkpointArtifact = jsonArtifactRecord(
    manifest,
    checkpoint.producer.manifestArtifactPath,
    "preboot-checkpoint-metadata",
    MAX_MANIFEST_BYTES,
  );
  if (
    checkpointArtifact.bytes !== checkpoint.producer.manifestBytes ||
    checkpointArtifact.sha256 !== checkpoint.producer.manifestSha256
  ) {
    fail("Checkpoint manifest differs from the verified runtime metadata.");
  }
  const checkpointFile = await fetchVerifiedJsonArtifact(
    checkpointArtifact,
    releaseBaseUrl,
    "Checkpoint manifest",
    fetchImpl,
    cryptoScope,
  );
  const checkpointDocument = checkpointFile.value;
  const sourceEvidence = checkpointDocument?.sourceEvidence;
  if (
    !isRecord(checkpointDocument) ||
    checkpointDocument.schemaVersion !== 1 ||
    checkpointDocument.kind !== "omarchy-web-preboot-checkpoint" ||
    !hasExactKeys(sourceEvidence, [
      "guestReport",
      ...CHECKPOINT_SOURCE_EVIDENCE_KEYS,
    ]) ||
    !isRecord(sourceEvidence.guestReport)
  ) {
    fail("Checkpoint source evidence is malformed.");
  }
  const guestReport = sourceEvidence.guestReport;
  if (
    guestReport.schemaVersion !== 1 ||
    !isRecord(guestReport.provenance) ||
    !Object.entries(upstream).every(
      ([key, expected]) => guestReport.provenance[key] === expected,
    )
  ) {
    fail("Checkpoint guest report does not match the verified release.");
  }
  const sourceDigests = Object.fromEntries(
    CHECKPOINT_SOURCE_EVIDENCE_KEYS.map((key) => [key, sourceEvidence[key]]),
  );
  const guestReportProvenance = normalizeGuestReportProvenance({
    origin: "checkpoint-source-evidence",
    sourceEvidence: sourceDigests,
  });
  if (!guestReportProvenance) {
    fail("Checkpoint source-evidence digests are malformed.");
  }
  const normalizedGuestReportSha256 = await sha256Hex(
    new TextEncoder().encode(normalizedJsonText(guestReport)),
    cryptoScope,
  );
  if (
    normalizedGuestReportSha256 !==
    guestReportProvenance.sourceEvidence.normalizedGuestReportSha256
  ) {
    fail("Checkpoint guest report digest does not match its source evidence.");
  }
  return {
    bytes: runtimeFile.bytes.byteLength + checkpointFile.bytes.byteLength,
    guestReportProvenance,
    checkpointGuestReport: guestReport,
  };
}

export async function fetchVerifiedWorkerBootstrap({
  releaseBaseUrl,
  expectedReleaseId,
  fetchImpl = globalThis.fetch,
  cryptoScope = globalThis.crypto,
} = {}) {
  if (!(releaseBaseUrl instanceof URL)) {
    fail("The immutable release base URL is invalid.");
  }
  if (
    typeof expectedReleaseId !== "string" ||
    !SHA256_PATTERN.test(expectedReleaseId) ||
    /^0{64}$/.test(expectedReleaseId)
  ) {
    fail("The active release ID is not a published SHA-256 digest.");
  }
  if (
    releaseBaseUrl.pathname !== `/omarchy/versions/${expectedReleaseId}/` ||
    releaseBaseUrl.search !== "" ||
    releaseBaseUrl.hash !== ""
  ) {
    fail("The immutable release URL does not match the active release ID.");
  }
  if (typeof fetchImpl !== "function") fail("Fetch is unavailable.");

  const manifestUrl = new URL("artifact-manifest.json", releaseBaseUrl);
  const manifestResponse = await fetchImpl(manifestUrl, {
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  if (!manifestResponse.ok) {
    fail(
      `Artifact manifest request failed with HTTP ${manifestResponse.status}: ${manifestUrl.pathname}`,
    );
  }
  if (mediaType(manifestResponse.headers.get("content-type")) !== "application/json") {
    fail("Artifact manifest has an unsafe Content-Type.");
  }
  const manifestBytes = await responseBytes(
    manifestResponse,
    "Artifact manifest",
    MAX_MANIFEST_BYTES,
  );
  const artifactManifestSha256 = await sha256Hex(manifestBytes, cryptoScope);
  if (artifactManifestSha256 !== expectedReleaseId) {
    fail("Artifact manifest SHA-256 does not match the active release ID.");
  }

  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    fail("Artifact manifest is not valid JSON.");
  }
  const upstream = canonicalUpstream(manifest?.upstream);
  if (
    !isRecord(manifest) ||
    manifest.schemaVersion !== 1 ||
    !upstream ||
    !Array.isArray(manifest.artifacts)
  ) {
    fail("Artifact manifest does not describe the pinned Omarchy release.");
  }

  const workerRecords = manifest.artifacts.filter(
    (artifact) => isRecord(artifact) && artifact.path === "production-worker.mjs",
  );
  if (workerRecords.length !== 1) {
    fail("Artifact manifest must contain exactly one production Worker.");
  }
  const workerArtifact = workerRecords[0];
  if (
    workerArtifact.role !== "host-worker" ||
    !isJavaScriptMediaType(workerArtifact.mediaType) ||
    !Number.isSafeInteger(workerArtifact.bytes) ||
    workerArtifact.bytes <= 0 ||
    workerArtifact.bytes > MAX_WORKER_BYTES ||
    typeof workerArtifact.sha256 !== "string" ||
    !SHA256_PATTERN.test(workerArtifact.sha256)
  ) {
    fail("Production Worker metadata is invalid.");
  }

  const workerUrl = new URL(workerArtifact.path, releaseBaseUrl);
  const workerResponse = await fetchImpl(workerUrl, {
    credentials: "same-origin",
    cache: "force-cache",
    redirect: "error",
  });
  if (!workerResponse.ok) {
    fail(
      `Production Worker request failed with HTTP ${workerResponse.status}: ${workerUrl.pathname}`,
    );
  }
  if (!isJavaScriptMediaType(workerResponse.headers.get("content-type"))) {
    fail("Production Worker has an unsafe Content-Type.");
  }
  const workerBytes = await responseBytes(
    workerResponse,
    "Production Worker",
    MAX_WORKER_BYTES,
  );
  if (workerBytes.byteLength !== workerArtifact.bytes) {
    fail("Production Worker body length differs from the artifact manifest.");
  }
  const workerSha256 = await sha256Hex(workerBytes, cryptoScope);
  if (workerSha256 !== workerArtifact.sha256) {
    fail("Production Worker SHA-256 differs from the artifact manifest.");
  }
  const workerSource = new TextDecoder().decode(workerBytes);
  if (!isSelfContainedWorkerSource(workerSource)) {
    fail(
      "Production Worker is not a self-contained module and cannot be verified before execution.",
    );
  }
  const guestReportContract = await verifiedGuestReportContract({
    manifest,
    releaseBaseUrl,
    upstream,
    fetchImpl,
    cryptoScope,
  });
  if (
    manifestBytes.byteLength +
      workerBytes.byteLength +
      guestReportContract.bytes >
    MAX_BOOTSTRAP_BYTES
  ) {
    fail("Verified bootstrap exceeds its aggregate byte limit.");
  }

  return Object.freeze({
    upstream: Object.freeze(upstream),
    artifactManifestSha256,
    workerArtifact: Object.freeze({
      bytes: workerArtifact.bytes,
      sha256: workerArtifact.sha256,
    }),
    workerBytes,
    guestReportProvenance: guestReportContract.guestReportProvenance,
    checkpointGuestReport: guestReportContract.checkpointGuestReport,
  });
}

export function validateRuntimeRelease(value, expected) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      new Set(["type", "upstream", "artifactManifestSha256"]),
    ) ||
    value.type !== "release" ||
    !expected ||
    canonicalUpstream(value.upstream) === null ||
    value.artifactManifestSha256 !== expected.artifactManifestSha256 ||
    !Object.entries(expected.upstream).every(
      ([key, expectedValue]) => value.upstream[key] === expectedValue,
    )
  ) {
    return null;
  }
  return {
    upstream: { ...EXPECTED_UPSTREAM },
    artifactManifestSha256: value.artifactManifestSha256,
  };
}

export function normalizeRuntimeGuestReport(value, expected) {
  const suppliedProvenance = isRecord(value) && value.origin === "checkpoint-source-evidence"
    ? { origin: value.origin, sourceEvidence: value.sourceEvidence }
    : { origin: value?.origin };
  if (
    !isRecord(value) ||
    value.type !== "guestreport" ||
    !isRecord(value.report) ||
    !expected ||
    !guestReportProvenanceMatches(
      suppliedProvenance,
      expected.guestReportProvenance,
    )
  ) {
    return null;
  }
  const provenance = normalizeGuestReportProvenance(suppliedProvenance);
  if (!provenance) return null;
  const expectedKeys = provenance.origin === "live-guest-serial"
    ? ["type", "report", "origin"]
    : ["type", "report", "origin", "sourceEvidence"];
  if (!hasExactKeys(value, expectedKeys)) return null;
  if (
    provenance.origin === "checkpoint-source-evidence" &&
    (!isRecord(expected.checkpointGuestReport) ||
      !sameJsonValue(value.report, expected.checkpointGuestReport))
  ) {
    return null;
  }
  return {
    report: value.report,
    origin: provenance.origin,
    ...(provenance.origin === "checkpoint-source-evidence"
      ? { sourceEvidence: provenance.sourceEvidence }
      : {}),
  };
}

export function normalizeRuntimeDesktopProof(value, expectedReleaseId) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["type", "proof"])) ||
    value.type !== "desktopproof"
  ) {
    return null;
  }
  return copyDesktopProof(value.proof, expectedReleaseId);
}

export function normalizeRuntimeGuestFrame(value) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      new Set([
        "type",
        "sequence",
        "source",
        "guestWidth",
        "guestHeight",
        "timestamp",
        "sampledPixels",
        "nonBlackPixels",
      ]),
    ) ||
    value.type !== "guestframe" ||
    value.source !== "qemu-guest" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence <= 0 ||
    value.guestWidth !== 1600 ||
    value.guestHeight !== 900 ||
    typeof value.timestamp !== "number" ||
    !Number.isFinite(value.timestamp) ||
    value.timestamp < 0 ||
    value.sampledPixels !== DESKTOP_PROOF_SAMPLE_PIXELS ||
    !Number.isSafeInteger(value.nonBlackPixels) ||
    value.nonBlackPixels < 0 ||
    value.nonBlackPixels > value.sampledPixels
  ) {
    return null;
  }
  return {
    sequence: value.sequence,
    source: value.source,
    guestWidth: value.guestWidth,
    guestHeight: value.guestHeight,
    sampledPixels: value.sampledPixels,
    nonBlackPixels: value.nonBlackPixels,
  };
}

export function normalizeRuntimeInputAccepted(value) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["type", "event"])) ||
    value.type !== "inputaccepted" ||
    !isRecord(value.event)
  ) {
    return null;
  }
  const event = value.event;
  if (
    event.kind === "key" &&
    hasOnlyKeys(event, new Set(["kind", "scancode", "down"])) &&
    Number.isInteger(event.scancode) &&
    event.scancode >= 4 &&
    event.scancode <= 255 &&
    typeof event.down === "boolean"
  ) {
    return { ...event };
  }
  if (
    event.kind === "pointer" &&
    hasOnlyKeys(event, new Set(["kind", "x", "y", "buttons"])) &&
    Number.isInteger(event.x) &&
    event.x >= 0 &&
    event.x <= 32767 &&
    Number.isInteger(event.y) &&
    event.y >= 0 &&
    event.y <= 32767 &&
    Number.isInteger(event.buttons) &&
    event.buttons >= 0 &&
    event.buttons <= 31
  ) {
    return { ...event };
  }
  if (
    event.kind === "wheel" &&
    hasOnlyKeys(event, new Set(["kind", "x", "y"])) &&
    Number.isInteger(event.x) &&
    event.x >= -1 &&
    event.x <= 1 &&
    Number.isInteger(event.y) &&
    event.y >= -1 &&
    event.y <= 1 &&
    (event.x !== 0 || event.y !== 0)
  ) {
    return { ...event };
  }
  return null;
}

export function normalizedPointerForCanvas(
  clientX,
  clientY,
  rect,
  { clamp = false } = {},
) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  const scale = Math.min(rect.width / 1600, rect.height / 900);
  const contentWidth = 1600 * scale;
  const contentHeight = 900 * scale;
  const left = rect.left + (rect.width - contentWidth) / 2;
  const top = rect.top + (rect.height - contentHeight) / 2;
  let x = (clientX - left) / contentWidth;
  let y = (clientY - top) / contentHeight;
  if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
  x = Math.min(1, Math.max(0, x));
  y = Math.min(1, Math.max(0, y));
  return { x, y };
}
