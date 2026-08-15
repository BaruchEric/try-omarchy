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

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.has(key));
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

  return Object.freeze({
    upstream: Object.freeze(upstream),
    artifactManifestSha256,
    workerArtifact: Object.freeze({
      bytes: workerArtifact.bytes,
      sha256: workerArtifact.sha256,
    }),
    workerBytes,
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
    !Number.isInteger(value.guestWidth) ||
    value.guestWidth <= 0 ||
    !Number.isInteger(value.guestHeight) ||
    value.guestHeight <= 0 ||
    typeof value.timestamp !== "number" ||
    !Number.isFinite(value.timestamp) ||
    value.timestamp < 0 ||
    !Number.isSafeInteger(value.sampledPixels) ||
    value.sampledPixels <= 0 ||
    value.sampledPixels > 1600 * 900 ||
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
