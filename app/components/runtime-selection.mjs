export const NATIVE_HELPER_ENDPOINT = "http://127.0.0.1:11555";
export const NATIVE_HELPER_VERSION = "0.1.0";
export const ACTIVE_NATIVE_UPSTREAM = Object.freeze({
  repository: "https://github.com/basecamp/omarchy",
  commit: "7488eaded43de68ff9d2d7e4bf50cd48e112eb0f",
  version: "4.0.0.alpha",
  treeSha256:
    "2b8670686876008cfd1e675a107fddcc01edf3919b2566348308e0bc2857f692",
  channel: "quattro",
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CAPABILITY_KEYS = new Set([
  "schemaVersion",
  "kind",
  "helperVersion",
  "challenge",
  "hostArchitecture",
  "virtualizationAvailable",
  "guestArchitectures",
  "runtime",
  "display",
  "supportsHostBoundResume",
  "guest",
]);
const GUEST_KEYS = new Set([
  "architecture",
  "channel",
  "repository",
  "commit",
  "version",
  "treeSha256",
  "bundleIdentity",
]);
const LAUNCH_KEYS = new Set([
  "schemaVersion",
  "accepted",
  "challenge",
  "bundleIdentity",
  "architecture",
  "display",
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

export function createNativeChallenge(crypto = globalThis.crypto) {
  if (typeof crypto?.getRandomValues !== "function") {
    throw new Error("Secure randomness is unavailable for the native helper probe.");
  }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizeNativeCapability(value, expectedChallenge) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, CAPABILITY_KEYS) ||
    value.schemaVersion !== 1 ||
    value.kind !== "omarchy-native-helper" ||
    value.helperVersion !== NATIVE_HELPER_VERSION ||
    value.challenge !== expectedChallenge ||
    value.hostArchitecture !== "arm64" ||
    value.virtualizationAvailable !== true ||
    value.runtime !== "apple-virtualization-framework" ||
    value.display !== "native-window" ||
    value.supportsHostBoundResume !== true ||
    !Array.isArray(value.guestArchitectures) ||
    value.guestArchitectures.length !== 1 ||
    value.guestArchitectures[0] !== "aarch64" ||
    !isRecord(value.guest) ||
    !hasExactKeys(value.guest, GUEST_KEYS) ||
    value.guest.architecture !== "aarch64" ||
    value.guest.channel !== ACTIVE_NATIVE_UPSTREAM.channel ||
    value.guest.repository !== ACTIVE_NATIVE_UPSTREAM.repository ||
    value.guest.commit !== ACTIVE_NATIVE_UPSTREAM.commit ||
    value.guest.version !== ACTIVE_NATIVE_UPSTREAM.version ||
    value.guest.treeSha256 !== ACTIVE_NATIVE_UPSTREAM.treeSha256 ||
    typeof value.guest.bundleIdentity !== "string" ||
    !SHA256_PATTERN.test(value.guest.bundleIdentity)
  ) {
    return null;
  }
  return Object.freeze({
    kind: "native-arm64",
    endpoint: NATIVE_HELPER_ENDPOINT,
    helperVersion: value.helperVersion,
    bundleIdentity: value.guest.bundleIdentity,
    upstream: Object.freeze({ ...ACTIVE_NATIVE_UPSTREAM }),
    display: value.display,
    supportsHostBoundResume: value.supportsHostBoundResume,
  });
}

export async function probeNativeHelper({
  fetchImpl = globalThis.fetch,
  crypto = globalThis.crypto,
  endpoint = NATIVE_HELPER_ENDPOINT,
  timeoutMs = 600,
} = {}) {
  if (typeof fetchImpl !== "function" || endpoint !== NATIVE_HELPER_ENDPOINT) {
    return null;
  }
  const challenge = createNativeChallenge(crypto);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      `${endpoint}/v1/capabilities?challenge=${challenge}`,
      {
        method: "GET",
        mode: "cors",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      },
    );
    if (
      !response?.ok ||
      response.status !== 200 ||
      !/^application\/json\b/i.test(response.headers?.get?.("content-type") ?? "")
    ) {
      return null;
    }
    return normalizeNativeCapability(await response.json(), challenge);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function launchNativeHelper(
  runtime,
  { fetchImpl = globalThis.fetch, crypto = globalThis.crypto } = {},
) {
  if (
    !isRecord(runtime) ||
    runtime.kind !== "native-arm64" ||
    runtime.endpoint !== NATIVE_HELPER_ENDPOINT ||
    typeof runtime.bundleIdentity !== "string" ||
    !SHA256_PATTERN.test(runtime.bundleIdentity)
  ) {
    throw new Error("The native runtime selection is invalid.");
  }
  const challenge = createNativeChallenge(crypto);
  const response = await fetchImpl(`${runtime.endpoint}/v1/launch`, {
    method: "POST",
    mode: "cors",
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, challenge }),
  });
  if (
    response?.status !== 202 ||
    !/^application\/json\b/i.test(response.headers?.get?.("content-type") ?? "")
  ) {
    throw new Error(
      response?.status === 409
        ? "The native Omarchy window is already running."
        : "The native Omarchy helper rejected the launch.",
    );
  }
  const value = await response.json();
  if (
    !isRecord(value) ||
    !hasExactKeys(value, LAUNCH_KEYS) ||
    value.schemaVersion !== 1 ||
    value.accepted !== true ||
    value.challenge !== challenge ||
    value.bundleIdentity !== runtime.bundleIdentity ||
    value.architecture !== "aarch64" ||
    value.display !== "native-window"
  ) {
    throw new Error("The native Omarchy helper returned an invalid launch receipt.");
  }
  return Object.freeze({ ...value });
}
