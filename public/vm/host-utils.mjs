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
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HIBERNATION_RESUME_BINDING_KEYS = Object.freeze([
  "descriptorSha256",
  "markerSha256",
  "sourceBootId",
  "swapUuid",
]);
const HIBERNATION_KERNEL_EVIDENCE = Object.freeze([
  "PM: Image signature found, resuming",
  "PM: Image loading done",
  "Hibernation image restored successfully",
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

export function normalizeHibernationResumeBinding(value) {
  if (!hasExactKeys(value, HIBERNATION_RESUME_BINDING_KEYS)) return null;
  if (
    !SHA256_PATTERN.test(value.descriptorSha256 ?? "") ||
    !SHA256_PATTERN.test(value.markerSha256 ?? "") ||
    !UUID_PATTERN.test(value.sourceBootId ?? "") ||
    !UUID_PATTERN.test(value.swapUuid ?? "")
  ) {
    return null;
  }
  return Object.freeze(
    Object.fromEntries(
      HIBERNATION_RESUME_BINDING_KEYS.map((key) => [key, value[key]]),
    ),
  );
}

export function normalizeHibernationResumeEvidence(value) {
  const keys = [
    "schemaVersion",
    "checkpointMode",
    ...HIBERNATION_RESUME_BINDING_KEYS,
    "rendererReportSha256",
    "renderer",
    "kernelEvidence",
    "runtimeDisplay",
    "derivedInitramfsSha256",
  ];
  if (!hasExactKeys(value, keys)) return null;
  const binding = normalizeHibernationResumeBinding(
    Object.fromEntries(
      HIBERNATION_RESUME_BINDING_KEYS.map((key) => [key, value[key]]),
    ),
  );
  if (
    !binding ||
    value.schemaVersion !== 1 ||
    value.checkpointMode !== "guest-hibernation-resume" ||
    !SHA256_PATTERN.test(value.rendererReportSha256 ?? "") ||
    value.renderer !== "virgl" ||
    !sameJsonValue(value.kernelEvidence, HIBERNATION_KERNEL_EVIDENCE) ||
    value.runtimeDisplay !== "sdl,gl=es,show-cursor=on" ||
    !SHA256_PATTERN.test(value.derivedInitramfsSha256 ?? "")
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 1,
    checkpointMode: "guest-hibernation-resume",
    ...binding,
    rendererReportSha256: value.rendererReportSha256,
    renderer: "virgl",
    kernelEvidence: HIBERNATION_KERNEL_EVIDENCE,
    runtimeDisplay: "sdl,gl=es,show-cursor=on",
    derivedInitramfsSha256: value.derivedInitramfsSha256,
  });
}

export function normalizeGuestReportProvenance(value) {
  if (!isRecord(value) || typeof value.origin !== "string") return null;
  if (value.origin === "live-guest-serial") {
    return hasExactKeys(value, ["origin"])
      ? Object.freeze({ origin: "live-guest-serial" })
      : null;
  }
  if (value.origin === "live-hibernation-serial") {
    if (!hasExactKeys(value, ["origin", "resume"])) return null;
    const resume = normalizeHibernationResumeBinding(value.resume);
    return resume
      ? Object.freeze({ origin: "live-hibernation-serial", resume })
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
  if (actual.origin === "live-hibernation-serial") {
    return HIBERNATION_RESUME_BINDING_KEYS.every(
      (key) => actual.resume[key] === required.resume[key],
    );
  }
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

function canonicalHibernationSourceEvidence(value) {
  const keys = [
    "diagnosticsSha256",
    "hibernationEntryMarkerSha256",
    "nonceSha256",
    "sourceBootId",
    "gpuBoundAtHibernate",
  ];
  if (!hasExactKeys(value, keys)) return null;
  if (
    !SHA256_PATTERN.test(value.diagnosticsSha256 ?? "") ||
    !SHA256_PATTERN.test(value.hibernationEntryMarkerSha256 ?? "") ||
    !SHA256_PATTERN.test(value.nonceSha256 ?? "") ||
    !UUID_PATTERN.test(value.sourceBootId ?? "") ||
    value.gpuBoundAtHibernate !== false
  ) {
    return null;
  }
  return Object.freeze({ ...value });
}

function artifactIdentity(manifest, path, role, mediaTypeValue) {
  const records = manifest.artifacts.filter(
    (artifact) => isRecord(artifact) && artifact.path === path,
  );
  if (records.length !== 1) {
    fail(`Artifact manifest must contain exactly one ${path}.`);
  }
  const [artifact] = records;
  if (
    artifact.role !== role ||
    mediaType(artifact.mediaType) !== mediaTypeValue ||
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes <= 0 ||
    !SHA256_PATTERN.test(artifact.sha256 ?? "")
  ) {
    fail(`${path} metadata is invalid.`);
  }
  return artifact;
}

function validatedHibernationCheckpoint(checkpoint) {
  const checkpointKeys = [
    "schemaVersion",
    "mode",
    "derivedInitramfs",
    "rootDelta",
    "swapImage",
    "producer",
    "sourceEvidence",
    "resumeEvidence",
    "identity",
    "restoreContract",
  ];
  if (
    !hasExactKeys(checkpoint, checkpointKeys) ||
    checkpoint.schemaVersion !== 1 ||
    checkpoint.mode !== "guest-hibernation-resume"
  ) {
    fail("Runtime hibernation descriptor is invalid.");
  }
  const descriptor = (value, expected, label) => {
    if (!hasExactKeys(value, Object.keys(expected))) {
      fail(`Runtime hibernation ${label} descriptor is invalid.`);
    }
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (expectedValue === "sha256") {
        if (!SHA256_PATTERN.test(value[key] ?? "")) {
          fail(`Runtime hibernation ${label} descriptor is invalid.`);
        }
      } else if (expectedValue === "positive") {
        if (!Number.isSafeInteger(value[key]) || value[key] <= 0) {
          fail(`Runtime hibernation ${label} descriptor is invalid.`);
        }
      } else if (value[key] !== expectedValue) {
        fail(`Runtime hibernation ${label} descriptor is invalid.`);
      }
    }
  };
  descriptor(checkpoint.derivedInitramfs, {
    artifactPath: "initramfs-virgl-hibernate.img",
    mountPath: "/pack/initramfs-virgl-hibernate.img",
    bytes: "positive",
    sha256: "sha256",
    format: "linux-initramfs",
    baseArtifactPath: "initramfs-linux.img",
  }, "derived initramfs");
  descriptor(checkpoint.rootDelta, {
    artifactPath: "hibernate-root-overlay.qcow2",
    mountPath: "/pack/hibernate-root-overlay.qcow2",
    bytes: "positive",
    sha256: "sha256",
    format: "qcow2",
    backingFilename: "rootfs.ext4",
    backingFormat: "raw",
  }, "root delta");
  descriptor(checkpoint.swapImage, {
    artifactPath: "omarchy-hibernate.qcow2",
    mountPath: "/pack/omarchy-hibernate.qcow2",
    bytes: "positive",
    sha256: "sha256",
    format: "qcow2",
    virtualBytes: 1_610_612_736,
    swapUuid: "4c9a13d2-7c3a-4f2c-b6e1-5a3048610e8f",
  }, "swap image");
  descriptor(checkpoint.producer, {
    manifestArtifactPath: "hibernate-manifest.json",
    manifestBytes: "positive",
    manifestSha256: "sha256",
    qemuBinarySha256: "sha256",
  }, "producer");
  const identityKeys = [
    "baseGuestManifestSha256",
    "rootfsSha256",
    "guestProvenanceSha256",
    "kernelSha256",
    "baseInitramfsSha256",
    "derivedInitramfsSha256",
    "browserQemuWasmSha256",
    "qemu",
    "producerMachine",
    "runtimeMachine",
  ];
  if (!hasExactKeys(checkpoint.identity, identityKeys)) {
    fail("Runtime hibernation identity is invalid.");
  }
  for (const key of identityKeys.slice(0, 7)) {
    if (!SHA256_PATTERN.test(checkpoint.identity[key] ?? "")) {
      fail("Runtime hibernation identity is invalid.");
    }
  }
  if (
    checkpoint.derivedInitramfs.sha256 !==
      checkpoint.identity.derivedInitramfsSha256 ||
    !hasExactKeys(checkpoint.identity.qemu, [
      "repository",
      "sourceCommit",
      "version",
    ]) ||
    checkpoint.identity.qemu.repository !==
      "https://github.com/ktock/qemu-wasm.git" ||
    checkpoint.identity.qemu.sourceCommit !==
      "0ef7b4e2814b231705d8371dd7997f5b72e70baf" ||
    checkpoint.identity.qemu.version !== "8.2.0"
  ) {
    fail("Runtime hibernation identity is invalid.");
  }
  const expectedProducerMachine = {
    type: "pc-q35-8.2",
    memoryMiB: 1024,
    smp: "2,sockets=1,cores=2,threads=1",
    accel: "tcg,tb-size=128,thread=multi",
    cpu: "qemu64",
    display: "sdl,gl=on,show-cursor=on",
    displayDevice: "virtio-vga-gl,max_outputs=1,xres=1600,yres=900",
    blockDevices: [
      {
        driveId: "omarchy-hibernate-root",
        device: "virtio-blk-pci",
        serial: "omarchy-root",
        role: "root",
        format: "qcow2",
      },
      {
        driveId: "omarchy-hibernate-swap",
        device: "virtio-blk-pci",
        serial: "omarchy-resume",
        role: "resume",
        format: "qcow2",
      },
    ],
  };
  const expectedRuntimeMachine = {
    ...expectedProducerMachine,
    display: "sdl,gl=es,show-cursor=on",
    blockDevices: expectedProducerMachine.blockDevices.map((device) => ({
      ...device,
    })),
  };
  if (!sameJsonValue(checkpoint.identity.producerMachine, expectedProducerMachine)) {
    fail("Runtime hibernation native machine identity is invalid.");
  }
  if (!sameJsonValue(checkpoint.identity.runtimeMachine, expectedRuntimeMachine)) {
    fail("Runtime hibernation browser machine identity is invalid.");
  }
  const restore = checkpoint.restoreContract;
  const restoreKeys = [
    "coldBootFallbackAllowed",
    "disposableWrites",
    "gpuBoundAtHibernate",
    "kernelCommandLineBase",
    "resumeNonceSha256",
    "sourceBootId",
    "sourceEvidenceSha256",
    "sourceKernelCommandLineRedacted",
    "sourceKernelCommandLineSha256",
    "targetKernelCommandLine",
    "runtimeDisplay",
    "virtioGpuLoadedAfterResume",
  ];
  if (
    !hasExactKeys(restore, restoreKeys) ||
    restore.coldBootFallbackAllowed !== false ||
    restore.gpuBoundAtHibernate !== false ||
    restore.virtioGpuLoadedAfterResume !== true ||
    restore.disposableWrites !==
      "target -snapshot layers over immutable root delta and hibernation image" ||
    restore.runtimeDisplay !== "sdl,gl=es,show-cursor=on" ||
    !SHA256_PATTERN.test(restore.resumeNonceSha256 ?? "") ||
    !SHA256_PATTERN.test(restore.sourceEvidenceSha256 ?? "") ||
    !SHA256_PATTERN.test(restore.sourceKernelCommandLineSha256 ?? "") ||
    !UUID_PATTERN.test(restore.sourceBootId ?? "") ||
    typeof restore.kernelCommandLineBase !== "string" ||
    restore.targetKernelCommandLine !==
      `${restore.kernelCommandLineBase} omarchy.hibernate_target=1` ||
    restore.sourceKernelCommandLineRedacted !==
      `${restore.kernelCommandLineBase} omarchy.hibernate_producer=1 omarchy.hibernate_nonce=<redacted>` ||
    !restore.kernelCommandLineBase.includes(
      `resume=UUID=${checkpoint.swapImage.swapUuid}`,
    )
  ) {
    fail("Runtime hibernation restore contract is invalid.");
  }
  const sourceEvidence = canonicalHibernationSourceEvidence(
    checkpoint.sourceEvidence,
  );
  if (
    !sourceEvidence ||
    sourceEvidence.sourceBootId !== restore.sourceBootId ||
    sourceEvidence.nonceSha256 !== restore.resumeNonceSha256 ||
    sourceEvidence.gpuBoundAtHibernate !== restore.gpuBoundAtHibernate
  ) {
    fail("Runtime hibernation source evidence is invalid.");
  }
  const resume = checkpoint.resumeEvidence;
  const resumeDigestKeys = [
    "diagnosticsSha256",
    "hibernationMarkerSha256",
    "rendererProbeSha256",
    "normalizedGuestReportSha256",
    "reportValidationSha256",
    "desktopFrame1Sha256",
    "desktopFrame1HealthSha256",
    "desktopFrame2Sha256",
    "desktopFrame2HealthSha256",
    "footFrameSha256",
    "footFrameHealthSha256",
    "footChangeSha256",
  ];
  if (
    !hasExactKeys(resume, [
      ...resumeDigestKeys,
      "renderer",
      "freshPostResumeInteraction",
    ]) ||
    resumeDigestKeys.some((key) => !SHA256_PATTERN.test(resume[key] ?? "")) ||
    typeof resume.renderer !== "string" ||
    resume.renderer.length === 0 ||
    resume.renderer.length > 256 ||
    !/virgl/i.test(resume.renderer) ||
    /[\r\n\0]/.test(resume.renderer) ||
    resume.freshPostResumeInteraction !== true
  ) {
    fail("Runtime hibernation resume evidence is invalid.");
  }
  return checkpoint;
}

async function verifiedHibernationContract({
  manifest,
  checkpoint,
  releaseBaseUrl,
  fetchImpl,
  cryptoScope,
}) {
  validatedHibernationCheckpoint(checkpoint);
  const producerArtifact = jsonArtifactRecord(
    manifest,
    checkpoint.producer.manifestArtifactPath,
    "hibernation-metadata",
    MAX_MANIFEST_BYTES,
  );
  if (
    producerArtifact.bytes !== checkpoint.producer.manifestBytes ||
    producerArtifact.sha256 !== checkpoint.producer.manifestSha256
  ) {
    fail("Hibernation manifest differs from the verified runtime descriptor.");
  }
  const producerFile = await fetchVerifiedJsonArtifact(
    producerArtifact,
    releaseBaseUrl,
    "Hibernation manifest",
    fetchImpl,
    cryptoScope,
  );
  const document = producerFile.value;
  const documentKeys = [
    "schemaVersion",
    "kind",
    "derivedInitramfs",
    "rootDelta",
    "swapImage",
    "producer",
    "resumeEvidence",
    "identity",
    "qemu",
    "producerMachine",
    "runtimeMachine",
    "restoreContract",
    "sourceEvidence",
  ];
  if (
    !hasExactKeys(document, documentKeys) ||
    document.schemaVersion !== 1 ||
    document.kind !== "omarchy-web-guest-hibernation"
  ) {
    fail("Hibernation producer manifest is malformed.");
  }
  const expectedDocument = {
    derivedInitramfs: {
      artifactPath: checkpoint.derivedInitramfs.artifactPath,
      bytes: checkpoint.derivedInitramfs.bytes,
      sha256: checkpoint.derivedInitramfs.sha256,
      format: checkpoint.derivedInitramfs.format,
      baseArtifactPath: checkpoint.derivedInitramfs.baseArtifactPath,
    },
    rootDelta: {
      path: checkpoint.rootDelta.artifactPath,
      bytes: checkpoint.rootDelta.bytes,
      sha256: checkpoint.rootDelta.sha256,
      format: checkpoint.rootDelta.format,
      backingFilename: checkpoint.rootDelta.backingFilename,
      backingFormat: checkpoint.rootDelta.backingFormat,
    },
    swapImage: {
      path: checkpoint.swapImage.artifactPath,
      bytes: checkpoint.swapImage.bytes,
      sha256: checkpoint.swapImage.sha256,
      format: checkpoint.swapImage.format,
      virtualBytes: checkpoint.swapImage.virtualBytes,
      swapUuid: checkpoint.swapImage.swapUuid,
    },
    producer: { qemuBinarySha256: checkpoint.producer.qemuBinarySha256 },
    resumeEvidence: checkpoint.resumeEvidence,
    identity: Object.fromEntries(
      [
        "baseGuestManifestSha256",
        "rootfsSha256",
        "guestProvenanceSha256",
        "kernelSha256",
        "baseInitramfsSha256",
        "derivedInitramfsSha256",
        "browserQemuWasmSha256",
      ].map((key) => [key, checkpoint.identity[key]]),
    ),
    qemu: checkpoint.identity.qemu,
    producerMachine: checkpoint.identity.producerMachine,
    runtimeMachine: checkpoint.identity.runtimeMachine,
    restoreContract: checkpoint.restoreContract,
  };
  for (const [key, expected] of Object.entries(expectedDocument)) {
    if (!sameJsonValue(document[key], expected)) {
      fail(`Hibernation producer ${key} differs from the runtime descriptor.`);
    }
  }
  const sourceEvidence = canonicalHibernationSourceEvidence(
    document.sourceEvidence,
  );
  if (
    !sourceEvidence ||
    !sameJsonValue(sourceEvidence, checkpoint.sourceEvidence) ||
    sourceEvidence.sourceBootId !== checkpoint.restoreContract.sourceBootId ||
    sourceEvidence.nonceSha256 !== checkpoint.restoreContract.resumeNonceSha256 ||
    (await sha256Hex(
      new TextEncoder().encode(normalizedJsonText(sourceEvidence)),
      cryptoScope,
    )) !== checkpoint.restoreContract.sourceEvidenceSha256
  ) {
    fail("Hibernation source evidence differs from the runtime descriptor.");
  }
  for (const [definition, descriptor] of [
    [
      ["hibernation-initramfs", "application/vnd.linux.initramfs"],
      checkpoint.derivedInitramfs,
    ],
    [
      ["hibernation-root-delta", "application/vnd.qemu.qcow2"],
      checkpoint.rootDelta,
    ],
    [
      ["hibernation-swap-image", "application/vnd.qemu.qcow2"],
      checkpoint.swapImage,
    ],
  ]) {
    const artifact = artifactIdentity(
      manifest,
      descriptor.artifactPath,
      definition[0],
      definition[1],
    );
    if (
      artifact.bytes !== descriptor.bytes ||
      artifact.sha256 !== descriptor.sha256
    ) {
      fail(`${descriptor.artifactPath} differs from the hibernation descriptor.`);
    }
  }
  const resumeBinding = Object.freeze({
    descriptorSha256: checkpoint.producer.manifestSha256,
    markerSha256: checkpoint.resumeEvidence.hibernationMarkerSha256,
    sourceBootId: checkpoint.restoreContract.sourceBootId,
    swapUuid: checkpoint.swapImage.swapUuid,
  });
  const hibernationResume = Object.freeze({
    schemaVersion: 1,
    checkpointMode: "guest-hibernation-resume",
    ...resumeBinding,
    renderer: "virgl",
    kernelEvidence: HIBERNATION_KERNEL_EVIDENCE,
    runtimeDisplay: checkpoint.restoreContract.runtimeDisplay,
    derivedInitramfsSha256: checkpoint.identity.derivedInitramfsSha256,
  });
  return {
    bytes: producerFile.bytes.byteLength,
    guestReportProvenance: Object.freeze({
      origin: "live-hibernation-serial",
      resume: resumeBinding,
    }),
    checkpointGuestReport: null,
    hibernationResume,
  };
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
      hibernationResume: null,
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
    const undeclaredResumeRoles = new Set([
      "preboot-vmstate",
      "preboot-disk-delta",
      "preboot-checkpoint-metadata",
      "hibernation-initramfs",
      "hibernation-root-delta",
      "hibernation-swap-image",
      "hibernation-metadata",
    ]);
    if (
      manifest.artifacts.some((artifact) =>
        undeclaredResumeRoles.has(artifact?.role),
      )
    ) {
      fail("Cold runtime packages undeclared resume artifacts.");
    }
    return {
      bytes: runtimeFile.bytes.byteLength,
      guestReportProvenance: Object.freeze({ origin: "live-guest-serial" }),
      checkpointGuestReport: null,
      hibernationResume: null,
    };
  }

  const checkpoint = runtimeManifest.checkpoint;
  if (
    isRecord(checkpoint) &&
    checkpoint.schemaVersion === 1 &&
    checkpoint.mode === "guest-hibernation-resume"
  ) {
    const hibernation = await verifiedHibernationContract({
      manifest,
      checkpoint,
      releaseBaseUrl,
      fetchImpl,
      cryptoScope,
    });
    return {
      ...hibernation,
      bytes: runtimeFile.bytes.byteLength + hibernation.bytes,
    };
  }
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
    hibernationResume: null,
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
    hibernationResume: guestReportContract.hibernationResume,
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
    : isRecord(value) && value.origin === "live-hibernation-serial"
      ? { origin: value.origin, resume: value.resume }
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
    : provenance.origin === "checkpoint-source-evidence"
      ? ["type", "report", "origin", "sourceEvidence"]
      : ["type", "report", "origin", "resume"];
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
      : provenance.origin === "live-hibernation-serial"
        ? { resume: provenance.resume }
        : {}),
  };
}

export function normalizeRuntimeHibernationResume(value, expected) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["type", "evidence"]) ||
    value.type !== "hibernationresume" ||
    !expected?.hibernationResume
  ) {
    return null;
  }
  const evidence = normalizeHibernationResumeEvidence(value.evidence);
  if (!evidence) return null;
  const staticEvidence = { ...evidence };
  delete staticEvidence.rendererReportSha256;
  return sameJsonValue(staticEvidence, expected.hibernationResume)
    ? evidence
    : null;
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
