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
  "guestreport",
  "guestframe",
  "reload",
  "error",
  "metrics",
]);
const PARENT_COMMAND_TYPES = new Set(["start", "focus"]);

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
    case "guestreport": {
      const keys = new Set([...common, "report"]);
      return hasEnvelope(value, expectedNonce, keys) && isRecord(value.report)
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
          new Set(["sequence", "source", "guestWidth", "guestHeight"]),
        ) &&
        Number.isInteger(frame.sequence) &&
        frame.sequence > 0 &&
        frame.source === "qemu-guest" &&
        (frame.guestWidth === undefined ||
          (Number.isInteger(frame.guestWidth) && frame.guestWidth > 0)) &&
        (frame.guestHeight === undefined ||
          (Number.isInteger(frame.guestHeight) && frame.guestHeight > 0))
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

export function createVmRun(previousRun, runNonce) {
  if (typeof runNonce !== "string" || !NONCE_PATTERN.test(runNonce)) {
    throw new TypeError("A valid VM run nonce is required.");
  }
  const generation = (previousRun?.generation ?? 0) + 1;
  const query = new URLSearchParams({
    run: runNonce,
    protocol: String(VM_HOST_PROTOCOL.version),
  });
  return {
    generation,
    nonce: runNonce,
    src: `${VM_HOST_DOCUMENT_URL}?${query}`,
  };
}
