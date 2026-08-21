const DESCRIPTION_TYPES = new Set(["offer", "answer"]);
const SDP_MAX_BYTES = 256 * 1024;
const STREAM_SEQUENCE_MAX = Number.MAX_SAFE_INTEGER;

const FIXED_KEY_CODES = new Set([
  "Enter", "Escape", "Backspace", "Tab", "Space", "Minus", "Equal",
  "BracketLeft", "BracketRight", "Backslash", "IntlHash", "Semicolon",
  "Quote", "Backquote", "Comma", "Period", "Slash", "CapsLock",
  "Insert", "Home", "PageUp",
  "Delete", "End", "PageDown", "ArrowRight", "ArrowLeft", "ArrowDown",
  "ArrowUp", "NumLock", "NumpadDivide", "NumpadMultiply", "NumpadSubtract",
  "NumpadAdd", "NumpadEnter", "Numpad1", "Numpad2", "Numpad3",
  "Numpad4", "Numpad5", "Numpad6", "Numpad7", "Numpad8", "Numpad9",
  "Numpad0", "NumpadDecimal", "IntlBackslash", "ContextMenu", "NumpadEqual",
  "ControlLeft", "ShiftLeft", "AltLeft", "MetaLeft", "ControlRight",
  "ShiftRight", "AltRight", "MetaRight",
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isAllowedKeyCode(code) {
  return typeof code === "string" && (
    FIXED_KEY_CODES.has(code) ||
    /^Key[A-Z]$/.test(code) ||
    /^Digit[0-9]$/.test(code) ||
    /^F(?:[1-9]|1[0-9]|20)$/.test(code)
  );
}

export function normalizeSessionDescription(value, expectedType) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["type", "sdp"]) ||
    !DESCRIPTION_TYPES.has(expectedType) ||
    value.type !== expectedType ||
    typeof value.sdp !== "string" ||
    value.sdp.length === 0 ||
    new TextEncoder().encode(value.sdp).byteLength > SDP_MAX_BYTES ||
    !value.sdp.startsWith("v=0")
  ) {
    return null;
  }
  return Object.freeze({ type: value.type, sdp: value.sdp });
}

export function normalizeSignalingEnvelope(value, expectedType) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "description"]) ||
    value.schemaVersion !== 1
  ) {
    return null;
  }
  const description = normalizeSessionDescription(value.description, expectedType);
  return description === null
    ? null
    : Object.freeze({ schemaVersion: 1, description });
}

export function normalizeStreamInput(value) {
  if (!isRecord(value) || !Number.isSafeInteger(value.sequence) ||
      value.sequence < 1 || value.sequence > STREAM_SEQUENCE_MAX ||
      typeof value.kind !== "string") {
    return null;
  }
  if (value.kind === "key") {
    return hasExactKeys(value, ["kind", "sequence", "code", "down"]) &&
      isAllowedKeyCode(value.code) && typeof value.down === "boolean"
      ? Object.freeze({ ...value })
      : null;
  }
  if (value.kind === "pointer") {
    return hasExactKeys(value, ["kind", "sequence", "x", "y", "buttons"]) &&
      Number.isFinite(value.x) && value.x >= 0 && value.x <= 1 &&
      Number.isFinite(value.y) && value.y >= 0 && value.y <= 1 &&
      Number.isInteger(value.buttons) && value.buttons >= 0 && value.buttons <= 31
      ? Object.freeze({ ...value })
      : null;
  }
  if (value.kind === "wheel") {
    return hasExactKeys(value, ["kind", "sequence", "deltaX", "deltaY"]) &&
      Number.isFinite(value.deltaX) && Number.isFinite(value.deltaY) &&
      (value.deltaX !== 0 || value.deltaY !== 0) &&
      Math.abs(value.deltaX) <= 4096 && Math.abs(value.deltaY) <= 4096
      ? Object.freeze({ ...value })
      : null;
  }
  if (value.kind === "release-all") {
    return hasExactKeys(value, ["kind", "sequence"])
      ? Object.freeze({ ...value })
      : null;
  }
  return null;
}

export function encodeStreamInput(value) {
  const normalized = normalizeStreamInput(value);
  if (normalized === null) throw new TypeError("Invalid Omarchy stream input event.");
  return JSON.stringify(normalized);
}

export function decodeStreamInput(value) {
  if (typeof value !== "string" || value.length > 1024) return null;
  try {
    return normalizeStreamInput(JSON.parse(value));
  } catch {
    return null;
  }
}

export const WEBRTC_POC_LIMITS = Object.freeze({
  sdpMaxBytes: SDP_MAX_BYTES,
  inputMaxBytes: 1024,
});
