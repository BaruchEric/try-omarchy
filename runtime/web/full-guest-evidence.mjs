export const FULL_GUEST_SAMPLE_PIXELS = 32 * 18;
export const FULL_GUEST_MIN_CHANGED_PIXELS = 29;
export const FULL_GUEST_MAX_DOMINANT_PIXELS = 547;

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_BROWSER_PERFORMANCE_EVENTS = 20_000;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  const keys = Object.keys(value);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("Browser performance capture contains a non-JSON value.");
}

async function sha256Hex(bytes, cryptoScope) {
  const digest = await cryptoScope.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

function performanceEventIsValid(event) {
  if (!isRecord(event) || !Number.isFinite(event.timestampMs) || event.timestampMs < 0) {
    return false;
  }
  if (event.type === "window-start") {
    return hasOnlyKeys(event, new Set([
      "type", "timestampMs", "windowId", "challengeSha256", "activity",
    ])) && IDENTIFIER.test(event.windowId ?? "") &&
      SHA256.test(event.challengeSha256 ?? "") && event.activity === "guest-animation";
  }
  if (event.type === "input-sent") {
    return hasOnlyKeys(event, new Set([
      "type", "timestampMs", "inputId", "challengeSha256", "actionDigest", "kind",
    ])) && IDENTIFIER.test(event.inputId ?? "") &&
      SHA256.test(event.challengeSha256 ?? "") && SHA256.test(event.actionDigest ?? "") &&
      ["key", "pointer", "wheel"].includes(event.kind);
  }
  if (event.type === "input-accepted") {
    return hasOnlyKeys(event, new Set([
      "type", "timestampMs", "inputId", "challengeSha256", "actionDigest",
      "guestInputSequence", "deliverySource",
    ])) && IDENTIFIER.test(event.inputId ?? "") &&
      SHA256.test(event.challengeSha256 ?? "") && SHA256.test(event.actionDigest ?? "") &&
      Number.isSafeInteger(event.guestInputSequence) && event.guestInputSequence > 0 &&
      event.deliverySource === "qemu-virtio-input-ring";
  }
  if (event.type === "frame-presented") {
    return hasOnlyKeys(event, new Set([
      "type", "timestampMs", "presentSequence", "scanoutEpoch", "source",
      "contentDigest", "sampledPixels", "changedPixels", "latestGuestInputSequence",
    ])) && Number.isSafeInteger(event.presentSequence) && event.presentSequence > 0 &&
      Number.isSafeInteger(event.scanoutEpoch) && event.scanoutEpoch > 0 &&
      event.source === "qemu-virtio-gpu-scanout" && SHA256.test(event.contentDigest ?? "") &&
      event.sampledPixels === FULL_GUEST_SAMPLE_PIXELS &&
      Number.isSafeInteger(event.changedPixels) && event.changedPixels >= 0 &&
      event.changedPixels <= event.sampledPixels &&
      Number.isSafeInteger(event.latestGuestInputSequence) &&
      event.latestGuestInputSequence >= 0;
  }
  if (event.type === "window-end") {
    return hasOnlyKeys(event, new Set([
      "type", "timestampMs", "windowId", "challengeSha256", "completion",
    ])) && IDENTIFIER.test(event.windowId ?? "") &&
      SHA256.test(event.challengeSha256 ?? "") &&
      event.completion === "guest-animation-complete";
  }
  return false;
}

export async function verifyFullGuestBrowserPerformanceCapture(
  value,
  artifactManifestSha256,
  cryptoScope = globalThis.crypto,
) {
  const capture = value?.capture;
  const trace = capture?.trace;
  const identity = trace?.identity;
  const telemetry = trace?.telemetry;
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["type", "capture"])) ||
      value.type !== "browserperformancecapture" || !isRecord(capture) ||
      !hasOnlyKeys(capture, new Set(["schemaVersion", "traceSha256", "trace"])) ||
      capture.schemaVersion !== 1 || !SHA256.test(capture.traceSha256 ?? "") ||
      !isRecord(trace) || !hasOnlyKeys(trace, new Set([
        "schemaVersion", "runId", "identity", "clock", "telemetry", "events",
      ])) || trace.schemaVersion !== 1 || !IDENTIFIER.test(trace.runId ?? "") ||
      trace.clock !== "performance.now" || !isRecord(identity) ||
      !hasOnlyKeys(identity, new Set([
        "artifactManifestSha256", "runtimeManifestSha256", "guestDescriptorSha256",
        "hibernateDescriptorSha256",
      ])) || identity.artifactManifestSha256 !== artifactManifestSha256 ||
      !SHA256.test(identity.artifactManifestSha256 ?? "") ||
      !SHA256.test(identity.runtimeManifestSha256 ?? "") ||
      (identity.guestDescriptorSha256 !== null &&
        !SHA256.test(identity.guestDescriptorSha256 ?? "")) ||
      (identity.hibernateDescriptorSha256 !== null &&
        !SHA256.test(identity.hibernateDescriptorSha256 ?? "")) ||
      !isRecord(telemetry) || !hasOnlyKeys(telemetry, new Set([
        "source", "cadence", "exportMode",
      ])) || telemetry.source !== "qemu-virtio-gpu-scanout" ||
      telemetry.cadence !== "uncapped-internal" ||
      telemetry.exportMode !== "post-window-hashed" ||
      !Array.isArray(trace.events) || trace.events.length < 3 ||
      trace.events.length > MAX_BROWSER_PERFORMANCE_EVENTS ||
      !trace.events.every(performanceEventIsValid) ||
      trace.events[0].type !== "window-start" ||
      trace.events.at(-1).type !== "window-end") {
    return null;
  }
  let previousTimestamp = -1;
  for (const event of trace.events) {
    if (event.timestampMs < previousTimestamp) return null;
    previousTimestamp = event.timestampMs;
  }
  let digest;
  try {
    digest = await sha256Hex(
      new TextEncoder().encode(canonicalJson(trace)),
      cryptoScope,
    );
  } catch {
    return null;
  }
  if (digest !== capture.traceSha256) return null;
  return deepFreeze(structuredClone(capture));
}

export function normalizeFullGuestRelease(value) {
  const upstream = value?.upstream;
  if (!isRecord(value) ||
      !hasOnlyKeys(value, new Set(["type", "upstream", "artifactManifestSha256"])) ||
      value.type !== "release" || !isRecord(upstream) ||
      !hasOnlyKeys(upstream, new Set(["repository", "commit", "version", "treeSha256"])) ||
      upstream.repository !== "https://github.com/basecamp/omarchy" ||
      !COMMIT.test(upstream.commit ?? "") || typeof upstream.version !== "string" ||
      upstream.version.length === 0 || upstream.version.length > 128 ||
      !SHA256.test(upstream.treeSha256 ?? "") ||
      !SHA256.test(value.artifactManifestSha256 ?? "")) {
    return null;
  }
  return Object.freeze({
    upstream: Object.freeze({ ...upstream }),
    artifactManifestSha256: value.artifactManifestSha256,
  });
}

export function fullGuestReportMatchesRelease(report, release) {
  const provenance = report?.provenance;
  return isRecord(report) && isRecord(provenance) && isRecord(release?.upstream) &&
    ["repository", "commit", "version", "treeSha256"].every(
      (key) => provenance[key] === release.upstream[key],
    );
}

export function normalizeFullGuestFrame(value) {
  if (!isRecord(value) ||
      !hasOnlyKeys(value, new Set([
        "type", "sequence", "source", "guestWidth", "guestHeight", "timestamp",
        "sampledPixels", "nonBlackPixels",
      ])) || value.type !== "guestframe" || value.source !== "qemu-guest" ||
      !Number.isSafeInteger(value.sequence) || value.sequence <= 0 ||
      value.guestWidth !== 1600 || value.guestHeight !== 900 ||
      typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp) ||
      value.timestamp < 0 || value.sampledPixels !== FULL_GUEST_SAMPLE_PIXELS ||
      !Number.isSafeInteger(value.nonBlackPixels) || value.nonBlackPixels < 0 ||
      value.nonBlackPixels > value.sampledPixels) {
    return null;
  }
  return Object.freeze({
    sequence: value.sequence,
    source: value.source,
    guestWidth: value.guestWidth,
    guestHeight: value.guestHeight,
    sampledPixels: value.sampledPixels,
    nonBlackPixels: value.nonBlackPixels,
  });
}

export function normalizeFullGuestDesktopProof(value, artifactManifestSha256) {
  const proof = value?.proof;
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["type", "proof"])) ||
      value.type !== "desktopproof" || !isRecord(proof) ||
      !hasOnlyKeys(proof, new Set([
        "schemaVersion", "artifactManifestSha256", "challengeSha256",
        "baselineSequence", "responseSequence", "sampledPixels",
        "changedPixels", "dominantPixels",
      ])) || proof.schemaVersion !== 1 ||
      proof.artifactManifestSha256 !== artifactManifestSha256 ||
      !SHA256.test(proof.artifactManifestSha256 ?? "") ||
      !SHA256.test(proof.challengeSha256 ?? "") ||
      !Number.isSafeInteger(proof.baselineSequence) || proof.baselineSequence <= 0 ||
      !Number.isSafeInteger(proof.responseSequence) ||
      proof.responseSequence <= proof.baselineSequence ||
      proof.sampledPixels !== FULL_GUEST_SAMPLE_PIXELS ||
      !Number.isSafeInteger(proof.changedPixels) ||
      proof.changedPixels < FULL_GUEST_MIN_CHANGED_PIXELS ||
      proof.changedPixels > proof.sampledPixels ||
      !Number.isSafeInteger(proof.dominantPixels) || proof.dominantPixels < 1 ||
      proof.dominantPixels > FULL_GUEST_MAX_DOMINANT_PIXELS) {
    return null;
  }
  return Object.freeze({ ...proof });
}
