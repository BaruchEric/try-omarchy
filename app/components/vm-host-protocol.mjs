import {
  DESKTOP_PROOF_SAMPLE_PIXELS,
  isDesktopProof,
} from "../../public/vm/desktop-proof.mjs";
import {
  normalizeGuestReportProvenance,
  normalizeHibernationResumeEvidence,
} from "../../public/vm/host-utils.mjs";

export const VM_HOST_PROTOCOL = Object.freeze({
  channel: "omarchy-vm-host",
  version: 1,
});

export const VM_HOST_DOCUMENT_URL = "/vm/index.html";

const NONCE_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
const HOST_EVENT_TYPES = new Set([
  "ready",
  "phase",
  "serial",
  "release",
  "guestreport",
  "hibernationresume",
  "guestframe",
  "desktopproof",
  "inputaccepted",
  "reload",
  "error",
  "metrics",
]);
const PARENT_COMMAND_TYPES = new Set([
  "start",
  "focus",
  "menu",
  "terminal",
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function hasEnvelope(value, expectedNonce, allowedKeys) {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, allowedKeys) &&
    value.channel === VM_HOST_PROTOCOL.channel &&
    value.version === VM_HOST_PROTOCOL.version &&
    typeof value.runNonce === "string" &&
    NONCE_PATTERN.test(value.runNonce) &&
    value.runNonce === expectedNonce &&
    typeof value.type === "string"
  );
}

function isFiniteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isReleaseIdentity(value) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["upstream", "artifactManifestSha256"])) ||
    !isRecord(value.upstream) ||
    !hasOnlyKeys(
      value.upstream,
      new Set(["repository", "commit", "version", "treeSha256"]),
    )
  ) {
    return false;
  }
  return (
    value.upstream.repository === "https://github.com/basecamp/omarchy" &&
    typeof value.upstream.commit === "string" &&
    COMMIT_PATTERN.test(value.upstream.commit) &&
    typeof value.upstream.version === "string" &&
    value.upstream.version.length > 0 &&
    value.upstream.version.length <= 128 &&
    typeof value.upstream.treeSha256 === "string" &&
    SHA256_PATTERN.test(value.upstream.treeSha256) &&
    typeof value.artifactManifestSha256 === "string" &&
    SHA256_PATTERN.test(value.artifactManifestSha256)
  );
}

function isAcceptedInput(value) {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "key") {
    return (
      hasOnlyKeys(value, new Set(["kind", "scancode", "down"])) &&
      Number.isInteger(value.scancode) &&
      value.scancode >= 4 &&
      value.scancode <= 255 &&
      typeof value.down === "boolean"
    );
  }
  if (value.kind === "pointer") {
    return (
      hasOnlyKeys(value, new Set(["kind", "x", "y", "buttons"])) &&
      Number.isInteger(value.x) &&
      value.x >= 0 &&
      value.x <= 32767 &&
      Number.isInteger(value.y) &&
      value.y >= 0 &&
      value.y <= 32767 &&
      Number.isInteger(value.buttons) &&
      value.buttons >= 0 &&
      value.buttons <= 31
    );
  }
  if (value.kind === "wheel") {
    return (
      hasOnlyKeys(value, new Set(["kind", "x", "y"])) &&
      Number.isInteger(value.x) &&
      value.x >= -1 &&
      value.x <= 1 &&
      Number.isInteger(value.y) &&
      value.y >= -1 &&
      value.y <= 1 &&
      (value.x !== 0 || value.y !== 0)
    );
  }
  return false;
}

function validateHostPayload(value, expectedNonce) {
  if (!isRecord(value) || !HOST_EVENT_TYPES.has(value.type)) return null;

  const common = new Set(["channel", "version", "runNonce", "type"]);
  switch (value.type) {
    case "ready":
      return hasEnvelope(value, expectedNonce, common) ? value : null;
    case "phase": {
      const keys = new Set([...common, "phase", "reason"]);
      return hasEnvelope(value, expectedNonce, keys) &&
        typeof value.phase === "string" &&
        value.phase.length > 0 &&
        (value.reason === undefined || typeof value.reason === "string")
        ? value
        : null;
    }
    case "serial": {
      const keys = new Set([...common, "stream", "line"]);
      return hasEnvelope(value, expectedNonce, keys) &&
        (value.stream === "stdout" || value.stream === "stderr") &&
        typeof value.line === "string"
        ? value
        : null;
    }
    case "release": {
      const keys = new Set([
        ...common,
        "upstream",
        "artifactManifestSha256",
        "guestReportProvenance",
      ]);
      return hasEnvelope(value, expectedNonce, keys) &&
        isReleaseIdentity({
          upstream: value.upstream,
          artifactManifestSha256: value.artifactManifestSha256,
        }) &&
        normalizeGuestReportProvenance(value.guestReportProvenance) !== null
        ? value
        : null;
    }
    case "guestreport": {
      const provenance = value.origin === "checkpoint-source-evidence"
        ? { origin: value.origin, sourceEvidence: value.sourceEvidence }
        : value.origin === "live-hibernation-serial"
          ? { origin: value.origin, resume: value.resume }
          : { origin: value.origin };
      const normalizedProvenance = normalizeGuestReportProvenance(provenance);
      const keys = new Set([
        ...common,
        "report",
        "origin",
        ...(normalizedProvenance?.origin === "checkpoint-source-evidence"
          ? ["sourceEvidence"]
          : normalizedProvenance?.origin === "live-hibernation-serial"
            ? ["resume"]
            : []),
      ]);
      return hasEnvelope(value, expectedNonce, keys) &&
        isRecord(value.report) &&
        normalizedProvenance !== null
        ? value
        : null;
    }
    case "hibernationresume": {
      const keys = new Set([...common, "evidence"]);
      return hasEnvelope(value, expectedNonce, keys) &&
        normalizeHibernationResumeEvidence(value.evidence) !== null
        ? value
        : null;
    }
    case "guestframe": {
      const keys = new Set([...common, "frame"]);
      const frame = value.frame;
      return hasEnvelope(value, expectedNonce, keys) &&
        isRecord(frame) &&
        hasOnlyKeys(
          frame,
          new Set([
            "sequence",
            "source",
            "guestWidth",
            "guestHeight",
            "sampledPixels",
            "nonBlackPixels",
          ]),
        ) &&
        Number.isSafeInteger(frame.sequence) &&
        frame.sequence > 0 &&
        frame.source === "qemu-guest" &&
        frame.guestWidth === 1600 &&
        frame.guestHeight === 900 &&
        frame.sampledPixels === DESKTOP_PROOF_SAMPLE_PIXELS &&
        Number.isSafeInteger(frame.nonBlackPixels) &&
        frame.nonBlackPixels >= 0 &&
        frame.nonBlackPixels <= frame.sampledPixels
        ? value
        : null;
    }
    case "desktopproof": {
      const keys = new Set([...common, "proof"]);
      return hasEnvelope(value, expectedNonce, keys) &&
        isDesktopProof(value.proof)
        ? value
        : null;
    }
    case "inputaccepted": {
      const keys = new Set([...common, "event", "readinessProbe"]);
      return hasEnvelope(value, expectedNonce, keys) &&
        isAcceptedInput(value.event) &&
        value.readinessProbe === false
        ? value
        : null;
    }
    case "reload": {
      const keys = new Set([...common, "reason"]);
      return hasEnvelope(value, expectedNonce, keys) &&
        typeof value.reason === "string" &&
        value.reason.length > 0
        ? value
        : null;
    }
    case "error": {
      const keys = new Set([...common, "message", "technical"]);
      return hasEnvelope(value, expectedNonce, keys) &&
        typeof value.message === "string" &&
        value.message.length > 0 &&
        (value.technical === undefined || typeof value.technical === "string")
        ? value
        : null;
    }
    case "metrics": {
      const keys = new Set([...common, "metrics"]);
      const metrics = value.metrics;
      return hasEnvelope(value, expectedNonce, keys) &&
        isRecord(metrics) &&
        hasOnlyKeys(
          metrics,
          new Set([
            "backingWidth",
            "backingHeight",
            "cssWidth",
            "cssHeight",
            "deviceWidth",
            "deviceHeight",
            "devicePixelRatio",
            "pixelPerfect",
            "aspectMatches",
          ]),
        ) &&
        Number.isInteger(metrics.backingWidth) &&
        metrics.backingWidth > 0 &&
        Number.isInteger(metrics.backingHeight) &&
        metrics.backingHeight > 0 &&
        isFiniteNonNegative(metrics.cssWidth) &&
        isFiniteNonNegative(metrics.cssHeight) &&
        isFiniteNonNegative(metrics.deviceWidth) &&
        isFiniteNonNegative(metrics.deviceHeight) &&
        typeof metrics.devicePixelRatio === "number" &&
        Number.isFinite(metrics.devicePixelRatio) &&
        metrics.devicePixelRatio > 0 &&
        typeof metrics.pixelPerfect === "boolean" &&
        typeof metrics.aspectMatches === "boolean"
        ? value
        : null;
    }
    default:
      return null;
  }
}

/**
 * Accept a host event only from the active same-origin iframe and the current
 * run. `event.source` and the nonce are both required so a destroyed VM can
 * never update the replacement session.
 */
export function acceptVmHostMessage(
  event,
  { expectedOrigin, expectedSource, expectedNonce },
) {
  if (
    !event ||
    event.origin !== expectedOrigin ||
    event.source !== expectedSource
  ) {
    return null;
  }
  return validateHostPayload(event.data, expectedNonce);
}

export function vmHostMessagePayload(value) {
  if (
    !isRecord(value) ||
    value.channel !== VM_HOST_PROTOCOL.channel ||
    value.version !== VM_HOST_PROTOCOL.version ||
    typeof value.runNonce !== "string" ||
    !NONCE_PATTERN.test(value.runNonce)
  ) {
    return null;
  }
  const { channel: _channel, version: _version, runNonce: _runNonce, ...payload } = value;
  return payload;
}

export function createVmHostCommand(type, runNonce) {
  if (!PARENT_COMMAND_TYPES.has(type)) {
    throw new TypeError(`Unsupported VM host command: ${String(type)}`);
  }
  if (typeof runNonce !== "string" || !NONCE_PATTERN.test(runNonce)) {
    throw new TypeError("A valid VM run nonce is required.");
  }
  return {
    channel: VM_HOST_PROTOCOL.channel,
    version: VM_HOST_PROTOCOL.version,
    runNonce,
    type,
  };
}

export function createVmRunNonce(cryptoScope = globalThis.crypto) {
  if (typeof cryptoScope?.randomUUID === "function") {
    return cryptoScope.randomUUID().replaceAll("-", "_");
  }
  if (typeof cryptoScope?.getRandomValues === "function") {
    const bytes = cryptoScope.getRandomValues(new Uint8Array(24));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }
  throw new Error("Secure randomness is unavailable for the VM run boundary.");
}

export function createVmRun(previousRun, runNonce, releaseId) {
  if (typeof runNonce !== "string" || !NONCE_PATTERN.test(runNonce)) {
    throw new TypeError("A valid VM run nonce is required.");
  }
  if (
    typeof releaseId !== "string" ||
    !SHA256_PATTERN.test(releaseId) ||
    /^0{64}$/.test(releaseId)
  ) {
    throw new TypeError(
      "A published 64-hex active release ID is required before the VM can start.",
    );
  }
  const generation = (previousRun?.generation ?? 0) + 1;
  const query = new URLSearchParams({
    run: runNonce,
    protocol: String(VM_HOST_PROTOCOL.version),
    release: releaseId.toLowerCase(),
  });
  return {
    generation,
    nonce: runNonce,
    src: `${VM_HOST_DOCUMENT_URL}?${query}`,
  };
}
