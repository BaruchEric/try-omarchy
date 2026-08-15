export const DESKTOP_PROOF_SCHEMA_VERSION = 1;
export const DESKTOP_PROOF_SAMPLE_PIXELS = 32 * 18;
// A real Foot launch changed 304/576 samples; the failed QEMU8 run changed 0.
// Five percent is a conservative causal floor, and 95% caps a flat response.
export const DESKTOP_PROOF_MIN_CHANGED_PIXELS = 29;
export const DESKTOP_PROOF_MAX_DOMINANT_PIXELS = 547;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PROOF_KEYS = new Set([
  "schemaVersion",
  "artifactManifestSha256",
  "challengeSha256",
  "baselineSequence",
  "responseSequence",
  "sampledPixels",
  "changedPixels",
  "dominantPixels",
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate the complete, one-shot proof emitted by the production Worker.
 * Extra keys are rejected so a future or attacker-controlled payload cannot
 * silently weaken the evidence contract consumed by the host and UI.
 */
export function isDesktopProof(value, expectedReleaseId) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== PROOF_KEYS.size ||
    !Object.keys(value).every((key) => PROOF_KEYS.has(key)) ||
    value.schemaVersion !== DESKTOP_PROOF_SCHEMA_VERSION ||
    typeof value.artifactManifestSha256 !== "string" ||
    !SHA256_PATTERN.test(value.artifactManifestSha256) ||
    (expectedReleaseId !== undefined &&
      value.artifactManifestSha256 !== expectedReleaseId) ||
    typeof value.challengeSha256 !== "string" ||
    !SHA256_PATTERN.test(value.challengeSha256) ||
    !Number.isSafeInteger(value.baselineSequence) ||
    value.baselineSequence <= 0 ||
    !Number.isSafeInteger(value.responseSequence) ||
    value.responseSequence <= value.baselineSequence ||
    value.sampledPixels !== DESKTOP_PROOF_SAMPLE_PIXELS ||
    !Number.isSafeInteger(value.changedPixels) ||
    value.changedPixels < DESKTOP_PROOF_MIN_CHANGED_PIXELS ||
    value.changedPixels > value.sampledPixels ||
    !Number.isSafeInteger(value.dominantPixels) ||
    value.dominantPixels < 1 ||
    value.dominantPixels > DESKTOP_PROOF_MAX_DOMINANT_PIXELS
  ) {
    return false;
  }
  return true;
}

export function copyDesktopProof(value, expectedReleaseId) {
  if (!isDesktopProof(value, expectedReleaseId)) return null;
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    artifactManifestSha256: value.artifactManifestSha256,
    challengeSha256: value.challengeSha256,
    baselineSequence: value.baselineSequence,
    responseSequence: value.responseSequence,
    sampledPixels: value.sampledPixels,
    changedPixels: value.changedPixels,
    dominantPixels: value.dominantPixels,
  });
}
