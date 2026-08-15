export const FULL_GUEST_SAMPLE_PIXELS = 32 * 18;
export const FULL_GUEST_MIN_CHANGED_PIXELS = 29;
export const FULL_GUEST_MAX_DOMINANT_PIXELS = 547;

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  const keys = Object.keys(value);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
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
