import canonicalProductionRuntimeManifestJson from "../runtime/config/demo.json" with { type: "json" };
import {
  CANONICAL_CHECKPOINT_IDENTITY as canonicalRuntimeCheckpointIdentity,
  validateCheckpointSourceEvidence,
  validateCheckpointSourceEvidenceShape,
} from "../runtime/web/production-worker.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_CHECKPOINT_METADATA_BYTES = 4 * 1024 * 1024;

function cloneAndFreeze(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneAndFreeze(item)));
  }
  if (isRecord(value)) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneAndFreeze(item)]),
    ));
  }
  return value;
}

/**
 * The runtime build, browser Worker, release assembler, and promoter all bind
 * to this one checked-in representation. Keep the editable profile in
 * runtime/config/demo.json; do not copy its QEMU argv into release code.
 */
export const CANONICAL_PRODUCTION_RUNTIME_MANIFEST =
  cloneAndFreeze(canonicalProductionRuntimeManifestJson);

export const CANONICAL_CHECKPOINT_IDENTITY =
  cloneAndFreeze(canonicalRuntimeCheckpointIdentity);

export const CHECKPOINT_RELEASE_ARTIFACTS = Object.freeze([
  Object.freeze({
    key: "vmstate",
    path: "omarchy-preboot.vmstate",
    role: "preboot-vmstate",
    mediaType: "application/vnd.qemu.vmstate",
  }),
  Object.freeze({
    key: "bootDelta",
    path: "checkpoint-overlay.qcow2",
    role: "preboot-disk-delta",
    mediaType: "application/vnd.qemu.qcow2",
  }),
  Object.freeze({
    key: "producer",
    path: "checkpoint-manifest.json",
    role: "preboot-checkpoint-metadata",
    mediaType: "application/json",
  }),
]);

export const REQUIRED_PRODUCTION_RUNTIME_ASSETS = Object.freeze([
  Object.freeze({
    key: "hostWorker",
    path: "production-worker.mjs",
    role: "host-worker",
    mediaType: "text/javascript",
  }),
  Object.freeze({
    key: "workerInput",
    path: "worker-input.mjs",
    role: "host-input-bridge",
    mediaType: "text/javascript",
  }),
  Object.freeze({
    key: "pagedDisk",
    path: "paged-disk.mjs",
    role: "paged-disk-adapter",
    mediaType: "text/javascript",
  }),
  Object.freeze({
    key: "boundedOverlay",
    path: "bounded-overlay.mjs",
    role: "snapshot-overlay-guard",
    mediaType: "text/javascript",
  }),
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function describe(value) {
  if (value === undefined) return "missing";
  const encoded = JSON.stringify(value);
  return encoded === undefined ? String(value) : encoded;
}

function validateExactValue(
  actual,
  expected,
  field,
  contract = "canonical production runtime profile",
) {
  if (Array.isArray(expected)) {
    invariant(
      Array.isArray(actual),
      `${field} must exactly match the ${contract}`,
    );
    invariant(
      actual.length === expected.length,
      `${field} must contain exactly ${expected.length} canonical entries; got ${actual.length}`,
    );
    for (let index = 0; index < expected.length; index += 1) {
      validateExactValue(actual[index], expected[index], `${field}[${index}]`, contract);
    }
    return;
  }

  if (isRecord(expected)) {
    invariant(
      isRecord(actual),
      `${field} must exactly match the ${contract}`,
    );
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    invariant(
      actualKeys.length === expectedKeys.length &&
        actualKeys.every((key, index) => key === expectedKeys[index]),
      `${field} must contain exactly the canonical keys ` +
        `[${expectedKeys.join(", ")}]; got [${actualKeys.join(", ")}]`,
    );
    for (const key of expectedKeys) {
      validateExactValue(actual[key], expected[key], `${field}.${key}`, contract);
    }
    return;
  }

  invariant(
    Object.is(actual, expected),
    `${field} must exactly match the ${contract}: ` +
      `expected ${describe(expected)}, got ${describe(actual)}`,
  );
}

function validateExactKeys(value, expectedKeys, field) {
  invariant(isRecord(value), `${field} must be an object`);
  const actualKeys = Object.keys(value).sort();
  const canonicalKeys = [...expectedKeys].sort();
  invariant(
    actualKeys.length === canonicalKeys.length &&
      actualKeys.every((key, index) => key === canonicalKeys[index]),
    `${field} must contain exactly the canonical keys ` +
      `[${canonicalKeys.join(", ")}]; got [${actualKeys.join(", ")}]`,
  );
}

function validateCheckpointDescriptor(value, expected, field) {
  validateExactKeys(value, Object.keys(expected), field);
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue === "<positive-safe-integer>") {
      invariant(
        Number.isSafeInteger(value[key]) && value[key] > 0,
        `${field}.${key} must be a positive safe integer`,
      );
    } else if (expectedValue === "<sha256>") {
      invariant(
        SHA256.test(value[key] ?? ""),
        `${field}.${key} must be a lowercase SHA-256`,
      );
    } else {
      invariant(
        Object.is(value[key], expectedValue),
        `${field}.${key} must be ${describe(expectedValue)}; got ${describe(value[key])}`,
      );
    }
  }
  return value;
}

export function validateCheckpointProfile(checkpoint) {
  validateExactKeys(
    checkpoint,
    ["schemaVersion", "mode", "vmstate", "bootDelta", "producer", "identity"],
    "runtime manifest checkpoint",
  );
  invariant(
    checkpoint.schemaVersion === 1 && checkpoint.mode === "preboot-resume",
    "runtime manifest checkpoint must use schema 1 preboot-resume mode",
  );
  validateCheckpointDescriptor(checkpoint.vmstate, {
    artifactPath: "omarchy-preboot.vmstate",
    mountPath: "/pack/omarchy-preboot.vmstate",
    bytes: "<positive-safe-integer>",
    sha256: "<sha256>",
    format: "qemu-8.2-migration",
    compression: "none",
    incomingMode: "file",
  }, "runtime manifest checkpoint.vmstate");
  validateCheckpointDescriptor(checkpoint.bootDelta, {
    artifactPath: "checkpoint-overlay.qcow2",
    mountPath: "/pack/checkpoint-overlay.qcow2",
    bytes: "<positive-safe-integer>",
    sha256: "<sha256>",
    format: "qcow2",
    backingFilename: "rootfs.ext4",
    backingFormat: "raw",
  }, "runtime manifest checkpoint.bootDelta");
  validateCheckpointDescriptor(checkpoint.producer, {
    manifestArtifactPath: "checkpoint-manifest.json",
    manifestBytes: "<positive-safe-integer>",
    manifestSha256: "<sha256>",
    qemuBinarySha256: "<sha256>",
  }, "runtime manifest checkpoint.producer");
  validateExactValue(
    checkpoint.identity,
    CANONICAL_CHECKPOINT_IDENTITY,
    "runtime manifest checkpoint.identity",
    "canonical checkpoint identity",
  );
  invariant(
    checkpoint.bootDelta.backingFilename ===
      CANONICAL_PRODUCTION_RUNTIME_MANIFEST.guest.rootfs.artifactPath,
    "checkpoint qcow2 backing filename must name the canonical rootfs artifact",
  );
  return checkpoint;
}

export function checkpointArtifactRecords(runtimeManifest) {
  validateExactProductionRuntimeProfile(runtimeManifest);
  if (!Object.hasOwn(runtimeManifest, "checkpoint")) return Object.freeze([]);
  const { checkpoint } = runtimeManifest;
  return Object.freeze(CHECKPOINT_RELEASE_ARTIFACTS.map((definition) => {
    const descriptor = definition.key === "producer"
      ? {
          bytes: checkpoint.producer.manifestBytes,
          sha256: checkpoint.producer.manifestSha256,
        }
      : checkpoint[definition.key];
    return Object.freeze({
      path: definition.path,
      role: definition.role,
      mediaType: definition.mediaType,
      bytes: descriptor.bytes,
      sha256: descriptor.sha256,
    });
  }));
}

export async function validateCheckpointProducerDocument(value, checkpoint, expectedUpstream) {
  validateCheckpointProfile(checkpoint);
  invariant(isRecord(value), "checkpoint producer manifest must be an object");
  validateCheckpointSourceEvidenceShape(value.sourceEvidence);
  const comparableValue = { ...value };
  delete comparableValue.sourceEvidence;
  const expected = {
    schemaVersion: 1,
    kind: "omarchy-web-preboot-checkpoint",
    vmstate: {
      path: checkpoint.vmstate.artifactPath,
      bytes: checkpoint.vmstate.bytes,
      sha256: checkpoint.vmstate.sha256,
      format: checkpoint.vmstate.format,
      compression: checkpoint.vmstate.compression,
      incomingMode: checkpoint.vmstate.incomingMode,
    },
    bootDelta: {
      path: checkpoint.bootDelta.artifactPath,
      bytes: checkpoint.bootDelta.bytes,
      sha256: checkpoint.bootDelta.sha256,
      format: checkpoint.bootDelta.format,
      backingFilename: checkpoint.bootDelta.backingFilename,
      backingFormat: checkpoint.bootDelta.backingFormat,
    },
    producer: {
      qemuBinarySha256: checkpoint.producer.qemuBinarySha256,
    },
    identity: {
      baseGuestManifestSha256: checkpoint.identity.baseGuestManifestSha256,
      rootfsSha256: checkpoint.identity.rootfsSha256,
      guestProvenanceSha256: checkpoint.identity.guestProvenanceSha256,
    },
    qemu: { ...checkpoint.identity.qemu },
    machine: { ...checkpoint.identity.machine },
    restoreContract: {
      sourceRunstate: "running",
      immediateIncomingAutoRuns: true,
      qmpContRequired: false,
      disposableWrites: "target -snapshot layer over immutable boot delta",
    },
  };
  validateExactValue(
    comparableValue,
    expected,
    "checkpoint producer manifest",
    "runtime checkpoint producer document",
  );
  await validateCheckpointSourceEvidence(value.sourceEvidence, expectedUpstream, globalThis);
  return value;
}

export function validateCheckpointGuestManifestDocument(value, checkpoint) {
  validateCheckpointProfile(checkpoint);
  invariant(
    isRecord(value) && value.schemaVersion === 1 && Array.isArray(value.artifacts),
    "checkpoint base guest manifest has an unsupported schema",
  );
  invariant(
    value.upstream?.repository === "https://github.com/basecamp/omarchy",
    "checkpoint base guest manifest is not official Omarchy",
  );
  invariant(
    /^[0-9a-f]{40}$/.test(value.upstream?.commit ?? ""),
    "checkpoint base guest manifest does not pin an immutable Omarchy commit",
  );
  const artifactIdentity = (artifactPath) => {
    const records = value.artifacts.filter((artifact) => artifact?.path === artifactPath);
    invariant(
      records.length === 1,
      `checkpoint base guest manifest must record ${artifactPath} exactly once`,
    );
    const [record] = records;
    invariant(
      Number.isSafeInteger(record.bytes) && record.bytes > 0 && SHA256.test(record.sha256 ?? ""),
      `checkpoint base guest manifest has invalid ${artifactPath} identity`,
    );
    return record;
  };
  invariant(
    artifactIdentity("rootfs.ext4").sha256 === checkpoint.identity.rootfsSha256,
    "checkpoint base guest manifest rootfs SHA-256 does not match checkpoint identity",
  );
  invariant(
    artifactIdentity("provenance.json").sha256 === checkpoint.identity.guestProvenanceSha256,
    "checkpoint base guest manifest provenance SHA-256 does not match checkpoint identity",
  );
  return value;
}

/**
 * Reject every QEMU flag, ordering, descriptor, or manifest-key drift. Exact
 * array comparison is intentional: QEMU generally accepts repeated options
 * with last-one-wins semantics, so permissive presence checks would let an
 * appended -m/-smp/-nic/-display override the reviewed profile.
 */
export function validateExactProductionRuntimeProfile(runtimeManifest) {
  invariant(
    runtimeManifest?.schemaVersion === 2 && runtimeManifest?.runtimeMode === "worker-paged",
    "runtime manifest must use schema 2 worker-paged mode",
  );
  invariant(isRecord(runtimeManifest.assets), "runtime manifest is missing assets");
  invariant(
    !("preload" in runtimeManifest.assets) && !("data" in runtimeManifest.assets),
    "worker-paged runtime must not package preload or data assets",
  );
  for (const required of REQUIRED_PRODUCTION_RUNTIME_ASSETS) {
    invariant(
      runtimeManifest.assets[required.key] === required.path,
      `runtime manifest asset ${required.key} must be ${required.path}`,
    );
  }
  if (isRecord(runtimeManifest) && Object.hasOwn(runtimeManifest, "checkpoint")) {
    const coldProfile = { ...runtimeManifest };
    delete coldProfile.checkpoint;
    validateExactValue(
      coldProfile,
      CANONICAL_PRODUCTION_RUNTIME_MANIFEST,
      "runtime manifest",
    );
    validateCheckpointProfile(runtimeManifest.checkpoint);
    return runtimeManifest;
  }
  validateExactValue(
    runtimeManifest,
    CANONICAL_PRODUCTION_RUNTIME_MANIFEST,
    "runtime manifest",
  );
  return CANONICAL_PRODUCTION_RUNTIME_MANIFEST;
}

function artifactAtPath(artifacts, artifactPath, { role, mediaType }, label = artifactPath) {
  const pathRecords = artifacts.filter((artifact) => artifact?.path === artifactPath);
  invariant(pathRecords.length === 1, `release must record ${label} exactly once`);
  const [record] = pathRecords;
  invariant(record.role === role, `${label} must use role ${role}`);
  invariant(record.mediaType === mediaType, `${label} must use media type ${mediaType}`);
  invariant(
    Number.isSafeInteger(record.bytes) && record.bytes > 0,
    `${label} must record a positive byte length`,
  );
  invariant(SHA256.test(record.sha256 ?? ""), `${label} must record a canonical SHA-256`);
  return record;
}

function validateCheckpointReleaseArtifacts(runtimeManifest, artifacts) {
  const reservedPaths = new Set(CHECKPOINT_RELEASE_ARTIFACTS.map(({ path }) => path));
  const reservedRoles = new Set(CHECKPOINT_RELEASE_ARTIFACTS.map(({ role }) => role));
  if (!Object.hasOwn(runtimeManifest, "checkpoint")) {
    invariant(
      !artifacts.some((artifact) =>
        reservedPaths.has(artifact?.path) || reservedRoles.has(artifact?.role)),
      "cold runtime must not package undeclared checkpoint artifacts",
    );
    return;
  }

  const checkpoint = runtimeManifest.checkpoint;
  const expectedRecords = checkpointArtifactRecords(runtimeManifest);
  for (const expected of expectedRecords) {
    const record = artifactAtPath(artifacts, expected.path, expected, expected.path);
    invariant(
      artifacts.filter((artifact) => artifact?.role === expected.role).length === 1,
      `release must record role ${expected.role} exactly once`,
    );
    invariant(
      record.bytes === expected.bytes && record.sha256 === expected.sha256,
      `${expected.path} must match the runtime checkpoint byte length and SHA-256`,
    );
    if (expected.role === "preboot-checkpoint-metadata") {
      invariant(
        record.bytes <= MAX_CHECKPOINT_METADATA_BYTES,
        "checkpoint producer manifest exceeds the 4 MiB browser verification limit",
      );
    }
  }

  const rootfs = artifactAtPath(artifacts, runtimeManifest.guest.rootfs.artifactPath, {
    role: "guest-rootfs",
    mediaType: "application/vnd.omarchy.ext4",
  }, "checkpoint backing rootfs");
  invariant(
    rootfs.sha256 === checkpoint.identity.rootfsSha256,
    "checkpoint backing rootfs SHA-256 does not match checkpoint identity",
  );
  const guestManifest = artifactAtPath(artifacts, "guest-manifest.json", {
    role: "guest-metadata",
    mediaType: "application/json",
  }, "checkpoint base guest manifest");
  invariant(
    guestManifest.sha256 === checkpoint.identity.baseGuestManifestSha256,
    "checkpoint base guest manifest SHA-256 does not match checkpoint identity",
  );
  invariant(
    guestManifest.bytes <= MAX_CHECKPOINT_METADATA_BYTES,
    "checkpoint base guest manifest exceeds the 4 MiB browser verification limit",
  );
  const provenance = artifactAtPath(artifacts, "provenance.json", {
    role: "guest-metadata",
    mediaType: "application/json",
  }, "checkpoint guest provenance");
  invariant(
    provenance.sha256 === checkpoint.identity.guestProvenanceSha256,
    "checkpoint guest provenance SHA-256 does not match checkpoint identity",
  );
  const wasmPath = runtimeManifest.assets.locate["qemu-system-x86_64.wasm"];
  const wasm = artifactAtPath(artifacts, wasmPath, {
    role: "emulator-wasm",
    mediaType: "application/wasm",
  }, "checkpoint browser QEMU Wasm");
  invariant(
    wasm.sha256 === checkpoint.identity.browserQemuWasmSha256,
    "checkpoint browser QEMU Wasm SHA-256 does not match checkpoint identity",
  );
}

function validateProductionProfileArtifactReferences(runtimeManifest, artifacts) {
  const referencedPaths = [
    runtimeManifest.assets.module,
    runtimeManifest.assets.hostWorker,
    runtimeManifest.assets.workerInput,
    runtimeManifest.assets.pagedDisk,
    runtimeManifest.assets.boundedOverlay,
    ...Object.values(runtimeManifest.assets.locate),
    ...Object.values(runtimeManifest.assets.firmware),
    runtimeManifest.guest.rootfs.artifactPath,
    runtimeManifest.guest.kernel.artifactPath,
    runtimeManifest.guest.initramfs.artifactPath,
    ...(Object.hasOwn(runtimeManifest, "checkpoint")
      ? [
          runtimeManifest.checkpoint.vmstate.artifactPath,
          runtimeManifest.checkpoint.bootDelta.artifactPath,
          runtimeManifest.checkpoint.producer.manifestArtifactPath,
          "guest-manifest.json",
          "provenance.json",
        ]
      : []),
  ];
  const uniquePaths = new Set(referencedPaths);
  invariant(
    uniquePaths.size === referencedPaths.length,
    "canonical production runtime profile must not alias executable artifact paths",
  );
  for (const artifactPath of uniquePaths) {
    invariant(
      artifacts.filter((artifact) => artifact?.path === artifactPath).length === 1,
      `release must record referenced production artifact ${artifactPath} exactly once`,
    );
  }
}

/**
 * Bind the executable schema-2 runtime manifest to the four exact bootstrap
 * and storage records that make worker-paged production safe. Callers still
 * verify the record hashes against local files; this function prevents a
 * self-consistent manifest from omitting, aliasing, or relabelling a guard.
 */
export function validateProductionRuntimeContract(runtimeManifest, artifacts) {
  invariant(
    runtimeManifest?.schemaVersion === 2 && runtimeManifest?.runtimeMode === "worker-paged",
    "runtime manifest must use schema 2 worker-paged mode",
  );
  invariant(isRecord(runtimeManifest.assets), "runtime manifest is missing assets");
  invariant(
    !("preload" in runtimeManifest.assets) && !("data" in runtimeManifest.assets),
    "worker-paged runtime must not package preload or data assets",
  );
  invariant(Array.isArray(artifacts), "release artifact records are missing");

  for (const required of REQUIRED_PRODUCTION_RUNTIME_ASSETS) {
    invariant(
      runtimeManifest.assets[required.key] === required.path,
      `runtime manifest asset ${required.key} must be ${required.path}`,
    );

    const pathRecords = artifacts.filter((artifact) => artifact?.path === required.path);
    invariant(
      pathRecords.length === 1,
      `release must record ${required.path} exactly once`,
    );
    const roleRecords = artifacts.filter((artifact) => artifact?.role === required.role);
    invariant(
      roleRecords.length === 1,
      `release must record role ${required.role} exactly once`,
    );

    const [record] = pathRecords;
    invariant(
      record === roleRecords[0],
      `${required.path} must use role ${required.role}`,
    );
    invariant(
      record.mediaType === required.mediaType,
      `${required.path} must use media type ${required.mediaType}`,
    );
    invariant(
      Number.isSafeInteger(record.bytes) && record.bytes > 0,
      `${required.path} must record a positive byte length`,
    );
    invariant(
      SHA256.test(record.sha256 ?? ""),
      `${required.path} must record a canonical SHA-256`,
    );
  }

  validateExactProductionRuntimeProfile(runtimeManifest);
  validateProductionProfileArtifactReferences(runtimeManifest, artifacts);
  validateCheckpointReleaseArtifacts(runtimeManifest, artifacts);

  return REQUIRED_PRODUCTION_RUNTIME_ASSETS.map(({ key, path, role, mediaType }) =>
    Object.freeze({ key, path, role, mediaType }));
}
