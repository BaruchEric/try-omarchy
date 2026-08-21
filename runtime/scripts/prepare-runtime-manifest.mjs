#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_CHECKPOINT_IDENTITY,
  CANONICAL_HIBERNATION_KERNEL_COMMAND_LINE_BASE,
  CANONICAL_HIBERNATION_PRODUCER_MACHINE,
  CANONICAL_HIBERNATION_RUNTIME_MACHINE,
  CANONICAL_PRODUCTION_MANIFEST,
  HIBERNATION_SWAP_UUID,
  HIBERNATION_SWAP_VIRTUAL_BYTES,
  normalizedJsonBytes,
  validateCheckpointSourceEvidence,
  validateCheckpointSourceEvidenceShape,
  validateHibernationResumeEvidence,
  validateHibernationSourceEvidence,
  validateProductionManifest,
} from "../web/production-worker.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const CHECKPOINT_MANIFEST_NAME = "checkpoint-manifest.json";
const VMSTATE_NAME = "omarchy-preboot.vmstate";
const BOOT_DELTA_NAME = "checkpoint-overlay.qcow2";
const HIBERNATION_MANIFEST_NAME = "hibernate-manifest.json";
const HIBERNATION_ROOT_DELTA_NAME = "hibernate-root-overlay.qcow2";
const HIBERNATION_SWAP_NAME = "omarchy-hibernate.qcow2";
const HIBERNATION_INITRAMFS_NAME = "initramfs-virgl-hibernate.img";
const BASE_INITRAMFS_NAME = "initramfs-linux.img";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const EXPECTED = Object.freeze({
  baseGuestManifestSha256: CANONICAL_CHECKPOINT_IDENTITY.baseGuestManifestSha256,
  rootfsSha256: CANONICAL_CHECKPOINT_IDENTITY.rootfsSha256,
  guestProvenanceSha256: CANONICAL_CHECKPOINT_IDENTITY.guestProvenanceSha256,
  browserQemuWasmSha256: CANONICAL_CHECKPOINT_IDENTITY.browserQemuWasmSha256,
  qemuRepository: CANONICAL_CHECKPOINT_IDENTITY.qemu.repository,
  qemuSourceCommit: CANONICAL_CHECKPOINT_IDENTITY.qemu.sourceCommit,
  qemuVersion: CANONICAL_CHECKPOINT_IDENTITY.qemu.version,
  machineType: CANONICAL_CHECKPOINT_IDENTITY.machine.type,
  memoryMiB: CANONICAL_CHECKPOINT_IDENTITY.machine.memoryMiB,
  smp: CANONICAL_CHECKPOINT_IDENTITY.machine.smp,
  accel: CANONICAL_CHECKPOINT_IDENTITY.machine.accel,
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  invariant(isRecord(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  invariant(
    actual.length === expected.length && actual.every((key, index) => key === expected[index]),
    `${label} must contain exactly [${expected.join(", ")}]`,
  );
}

function digestBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function fileRecord(path) {
  const info = await stat(path);
  invariant(info.isFile() && info.size > 0, `${path} must be a non-empty regular file`);
  return { bytes: info.size, sha256: await sha256File(path) };
}

function validateArtifactDescriptor(value, expected, label) {
  exactKeys(value, Object.keys(expected), label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue === "<bytes>") {
      invariant(Number.isSafeInteger(value[key]) && value[key] > 0, `${label}.${key} must be positive bytes`);
    } else if (expectedValue === "<sha256>") {
      invariant(SHA256.test(value[key] ?? ""), `${label}.${key} must be lowercase SHA-256`);
    } else {
      invariant(value[key] === expectedValue, `${label}.${key} must be ${JSON.stringify(expectedValue)}`);
    }
  }
}

export function validateCheckpointProducerManifest(value, expected = EXPECTED) {
  exactKeys(value, [
    "schemaVersion", "kind", "vmstate", "bootDelta", "producer", "identity",
    "qemu", "machine", "restoreContract", "sourceEvidence",
  ], "checkpoint manifest");
  invariant(value.schemaVersion === 1, "checkpoint manifest schemaVersion must be 1");
  invariant(value.kind === "omarchy-web-preboot-checkpoint", "checkpoint manifest kind is invalid");
  validateCheckpointSourceEvidenceShape(value.sourceEvidence);
  validateArtifactDescriptor(value.vmstate, {
    path: VMSTATE_NAME,
    bytes: "<bytes>",
    sha256: "<sha256>",
    format: "qemu-8.2-migration",
    compression: "none",
    incomingMode: "file",
  }, "checkpoint manifest vmstate");
  validateArtifactDescriptor(value.bootDelta, {
    path: BOOT_DELTA_NAME,
    bytes: "<bytes>",
    sha256: "<sha256>",
    format: "qcow2",
    backingFilename: "rootfs.ext4",
    backingFormat: "raw",
  }, "checkpoint manifest bootDelta");
  exactKeys(value.producer, ["qemuBinarySha256"], "checkpoint manifest producer");
  invariant(
    SHA256.test(value.producer.qemuBinarySha256 ?? ""),
    "checkpoint producer QEMU binary SHA-256 is invalid",
  );
  exactKeys(value.identity, [
    "baseGuestManifestSha256", "rootfsSha256", "guestProvenanceSha256",
  ], "checkpoint manifest identity");
  for (const key of ["baseGuestManifestSha256", "rootfsSha256", "guestProvenanceSha256"]) {
    invariant(value.identity[key] === expected[key], `checkpoint identity ${key} is not canonical`);
  }
  exactKeys(value.qemu, ["repository", "sourceCommit", "version"], "checkpoint manifest qemu");
  invariant(value.qemu.repository === expected.qemuRepository, "checkpoint QEMU repository is invalid");
  invariant(value.qemu.sourceCommit === expected.qemuSourceCommit, "checkpoint QEMU commit is invalid");
  invariant(value.qemu.version === expected.qemuVersion, "checkpoint QEMU version is invalid");
  exactKeys(value.machine, ["type", "memoryMiB", "smp", "accel"], "checkpoint manifest machine");
  invariant(value.machine.type === expected.machineType, "checkpoint machine type is invalid");
  invariant(value.machine.memoryMiB === expected.memoryMiB, "checkpoint memory is invalid");
  invariant(value.machine.smp === expected.smp, "checkpoint SMP profile is invalid");
  invariant(value.machine.accel === expected.accel, "checkpoint accelerator profile is invalid");
  exactKeys(
    value.restoreContract,
    ["sourceRunstate", "immediateIncomingAutoRuns", "qmpContRequired", "disposableWrites"],
    "checkpoint manifest restoreContract",
  );
  invariant(value.restoreContract.sourceRunstate === "running", "checkpoint source runstate must be running");
  invariant(value.restoreContract.immediateIncomingAutoRuns === true, "checkpoint immediate incoming must auto-run");
  invariant(value.restoreContract.qmpContRequired === false, "checkpoint must not require QMP cont");
  invariant(
    value.restoreContract.disposableWrites === "target -snapshot layer over immutable boot delta",
    "checkpoint disposable-write contract is invalid",
  );
  return value;
}

export function validateHibernationProducerManifest(value) {
  exactKeys(value, [
    "schemaVersion", "kind", "derivedInitramfs", "rootDelta", "swapImage", "producer",
    "identity", "qemu", "producerMachine", "runtimeMachine", "restoreContract", "sourceEvidence",
    "resumeEvidence",
  ], "hibernation manifest");
  invariant(value.schemaVersion === 1, "hibernation manifest schemaVersion must be 1");
  invariant(value.kind === "omarchy-web-guest-hibernation", "hibernation manifest kind is invalid");
  validateHibernationSourceEvidence(value.sourceEvidence);
  validateHibernationResumeEvidence(value.resumeEvidence);
  validateArtifactDescriptor(value.derivedInitramfs, {
    artifactPath: HIBERNATION_INITRAMFS_NAME,
    bytes: "<bytes>",
    sha256: "<sha256>",
    format: "linux-initramfs",
    baseArtifactPath: BASE_INITRAMFS_NAME,
  }, "hibernation manifest derivedInitramfs");
  validateArtifactDescriptor(value.rootDelta, {
    path: HIBERNATION_ROOT_DELTA_NAME,
    bytes: "<bytes>",
    sha256: "<sha256>",
    format: "qcow2",
    backingFilename: "rootfs.ext4",
    backingFormat: "raw",
  }, "hibernation manifest rootDelta");
  validateArtifactDescriptor(value.swapImage, {
    path: HIBERNATION_SWAP_NAME,
    bytes: "<bytes>",
    sha256: "<sha256>",
    format: "qcow2",
    virtualBytes: HIBERNATION_SWAP_VIRTUAL_BYTES,
    swapUuid: HIBERNATION_SWAP_UUID,
  }, "hibernation manifest swapImage");
  exactKeys(value.producer, ["qemuBinarySha256"], "hibernation manifest producer");
  invariant(SHA256.test(value.producer.qemuBinarySha256 ?? ""),
    "hibernation producer QEMU binary SHA-256 is invalid");
  const identityKeys = [
    "baseGuestManifestSha256", "rootfsSha256", "guestProvenanceSha256", "kernelSha256",
    "baseInitramfsSha256", "derivedInitramfsSha256", "browserQemuWasmSha256",
  ];
  exactKeys(value.identity, identityKeys, "hibernation manifest identity");
  invariant(identityKeys.every((key) => SHA256.test(value.identity[key] ?? "")),
    "hibernation identity digests are invalid");
  invariant(value.identity.derivedInitramfsSha256 === value.derivedInitramfs.sha256,
    "hibernation derived initramfs identity is inconsistent");
  exactKeys(value.qemu, ["repository", "sourceCommit", "version"], "hibernation manifest qemu");
  invariant(
    digestBytes(normalizedJsonBytes(value.qemu)) ===
      digestBytes(normalizedJsonBytes(CANONICAL_CHECKPOINT_IDENTITY.qemu)),
    "hibernation QEMU source identity is invalid",
  );
  invariant(
    digestBytes(normalizedJsonBytes(value.producerMachine)) ===
      digestBytes(normalizedJsonBytes(CANONICAL_HIBERNATION_PRODUCER_MACHINE)),
    "hibernation native machine topology is invalid",
  );
  invariant(
    digestBytes(normalizedJsonBytes(value.runtimeMachine)) ===
      digestBytes(normalizedJsonBytes(CANONICAL_HIBERNATION_RUNTIME_MACHINE)),
    "hibernation browser machine topology is invalid",
  );
  const restoreKeys = [
    "coldBootFallbackAllowed", "disposableWrites", "gpuBoundAtHibernate", "kernelCommandLineBase",
    "resumeNonceSha256", "runtimeDisplay", "sourceBootId", "sourceEvidenceSha256",
    "sourceKernelCommandLineRedacted", "sourceKernelCommandLineSha256", "targetKernelCommandLine",
    "virtioGpuLoadedAfterResume",
  ];
  exactKeys(value.restoreContract, restoreKeys, "hibernation manifest restoreContract");
  const restore = value.restoreContract;
  invariant(restore.coldBootFallbackAllowed === false && restore.gpuBoundAtHibernate === false &&
    restore.virtioGpuLoadedAfterResume === true,
  "hibernation restore flags are invalid");
  invariant(
    restore.disposableWrites === "target -snapshot layers over immutable root delta and hibernation image",
    "hibernation disposable-write contract is invalid",
  );
  invariant(restore.runtimeDisplay === CANONICAL_HIBERNATION_RUNTIME_MACHINE.display,
    "hibernation browser runtime display is invalid");
  invariant(SHA256.test(restore.resumeNonceSha256 ?? "") &&
    SHA256.test(restore.sourceEvidenceSha256 ?? "") &&
    SHA256.test(restore.sourceKernelCommandLineSha256 ?? ""),
  "hibernation restore digests are invalid");
  invariant(UUID.test(restore.sourceBootId ?? ""), "hibernation source boot ID is invalid");
  invariant(
    digestBytes(normalizedJsonBytes(value.sourceEvidence)) === restore.sourceEvidenceSha256,
    "hibernation source evidence digest is invalid",
  );
  invariant(restore.resumeNonceSha256 === value.sourceEvidence.nonceSha256 &&
    restore.sourceBootId === value.sourceEvidence.sourceBootId &&
    restore.gpuBoundAtHibernate === value.sourceEvidence.gpuBoundAtHibernate,
  "hibernation source evidence does not match the restore contract");
  for (const key of ["kernelCommandLineBase", "sourceKernelCommandLineRedacted", "targetKernelCommandLine"]) {
    invariant(typeof restore[key] === "string" && restore[key].length > 0 && restore[key].length <= 2048 &&
      !/[\r\n\0]/.test(restore[key]), `hibernation ${key} is invalid`);
  }
  invariant(
    restore.kernelCommandLineBase === CANONICAL_HIBERNATION_KERNEL_COMMAND_LINE_BASE &&
    restore.sourceKernelCommandLineRedacted ===
      `${restore.kernelCommandLineBase} omarchy.hibernate_producer=1 omarchy.hibernate_nonce=<redacted>` &&
    restore.targetKernelCommandLine === `${restore.kernelCommandLineBase} omarchy.hibernate_target=1`,
    "hibernation source and target role suffixes are invalid",
  );
  const arguments_ = restore.kernelCommandLineBase.split(/\s+/);
  invariant(arguments_.includes("root=/dev/vda") &&
    arguments_.includes(`resume=UUID=${HIBERNATION_SWAP_UUID}`) &&
    arguments_.includes("ignore_loglevel") && arguments_.includes("hibernate.compressor=lzo") &&
    !arguments_.some((argument) =>
      /^omarchy\.hibernate_(?:producer|target|nonce)=/.test(argument)),
  "hibernation kernel command line is missing its exact resume contract");
  return value;
}

function artifactFromGuestManifest(guestManifest, path) {
  const matches = guestManifest?.artifacts?.filter((artifact) => artifact?.path === path) ?? [];
  invariant(matches.length === 1, `guest manifest must record ${path} exactly once`);
  const [artifact] = matches;
  invariant(Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0, `${path} guest size is invalid`);
  invariant(SHA256.test(artifact.sha256 ?? ""), `${path} guest SHA-256 is invalid`);
  return artifact;
}

export async function buildRuntimeManifest({
  baseManifestPath,
  guestDirectory,
  qemuWasmPath,
  expected = EXPECTED,
  forceCold = false,
}) {
  const [baseBytes, guestManifestBytes] = await Promise.all([
    readFile(baseManifestPath),
    readFile(join(guestDirectory, "guest-manifest.json")),
  ]);
  const baseManifest = JSON.parse(baseBytes);
  invariant(!("checkpoint" in baseManifest), "base runtime manifest must remain the explicit cold-boot profile");
  const checkpointNames = [CHECKPOINT_MANIFEST_NAME, VMSTATE_NAME, BOOT_DELTA_NAME];
  const hibernationNames = [
    HIBERNATION_MANIFEST_NAME,
    HIBERNATION_ROOT_DELTA_NAME,
    HIBERNATION_SWAP_NAME,
    HIBERNATION_INITRAMFS_NAME,
  ];
  const allNames = [...checkpointNames, ...hibernationNames];
  const allPresence = await Promise.all(allNames.map(async (name) => {
    const path = join(guestDirectory, name);
    try {
      return (await stat(path)).isFile();
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }));
  const checkpointPresence = allPresence.slice(0, checkpointNames.length);
  const hibernationPresence = allPresence.slice(checkpointNames.length);
  if (forceCold) {
    invariant(
      hibernationPresence.every((exists) => !exists),
      "force-cold packaging refuses to ignore any guest-hibernation artifact",
    );
    return Object.freeze({ mode: "cold", manifest: baseManifest });
  }
  if (allPresence.every((exists) => !exists)) {
    return Object.freeze({ mode: "cold", manifest: baseManifest });
  }
  invariant(
    !(checkpointPresence.some(Boolean) && hibernationPresence.some(Boolean)),
    "runtime packaging refuses ambiguous migration-checkpoint and hibernation artifact sets",
  );

  if (hibernationPresence.some(Boolean)) {
    invariant(
      hibernationPresence.every(Boolean),
      "hibernation packaging refuses a partial descriptor/root-delta/swap/derived-initramfs set",
    );
    const [producerBytes, rootDeltaRecord, swapImageRecord, derivedInitramfsRecord, wasmRecord] =
      await Promise.all([
        readFile(join(guestDirectory, HIBERNATION_MANIFEST_NAME)),
        fileRecord(join(guestDirectory, HIBERNATION_ROOT_DELTA_NAME)),
        fileRecord(join(guestDirectory, HIBERNATION_SWAP_NAME)),
        fileRecord(join(guestDirectory, HIBERNATION_INITRAMFS_NAME)),
        fileRecord(qemuWasmPath),
      ]);
    const producer = validateHibernationProducerManifest(JSON.parse(producerBytes));
    invariant(
      producer.rootDelta.bytes === rootDeltaRecord.bytes &&
        producer.rootDelta.sha256 === rootDeltaRecord.sha256,
      "hibernation root delta differs from hibernate-manifest.json",
    );
    invariant(
      producer.swapImage.bytes === swapImageRecord.bytes &&
        producer.swapImage.sha256 === swapImageRecord.sha256,
      "hibernation swap image differs from hibernate-manifest.json",
    );
    invariant(
      producer.derivedInitramfs.bytes === derivedInitramfsRecord.bytes &&
        producer.derivedInitramfs.sha256 === derivedInitramfsRecord.sha256,
      "hibernation derived initramfs differs from hibernate-manifest.json",
    );
    invariant(
      producer.identity.browserQemuWasmSha256 === wasmRecord.sha256,
      "hibernation browser QEMU Wasm identity is invalid",
    );

    const guestManifest = JSON.parse(guestManifestBytes);
    invariant(
      digestBytes(guestManifestBytes) === producer.identity.baseGuestManifestSha256,
      "hibernation base guest manifest identity is invalid",
    );
    const artifactBindings = [
      ["rootfs.ext4", "rootfsSha256", "rootfs"],
      ["provenance.json", "guestProvenanceSha256", "guest provenance"],
      ["vmlinuz-linux", "kernelSha256", "kernel"],
      [BASE_INITRAMFS_NAME, "baseInitramfsSha256", "base initramfs"],
    ];
    for (const [path, identityKey, label] of artifactBindings) {
      const artifact = artifactFromGuestManifest(guestManifest, path);
      const actual = await fileRecord(join(guestDirectory, path));
      invariant(artifact.bytes === actual.bytes && artifact.sha256 === actual.sha256,
        `hibernation ${label} differs from the guest manifest`);
      invariant(artifact.sha256 === producer.identity[identityKey],
        `hibernation ${label} identity is invalid`);
    }

    const checkpoint = {
      schemaVersion: 1,
      mode: "guest-hibernation-resume",
      derivedInitramfs: {
        artifactPath: producer.derivedInitramfs.artifactPath,
        mountPath: "/pack/initramfs-virgl-hibernate.img",
        bytes: producer.derivedInitramfs.bytes,
        sha256: producer.derivedInitramfs.sha256,
        format: producer.derivedInitramfs.format,
        baseArtifactPath: producer.derivedInitramfs.baseArtifactPath,
      },
      rootDelta: {
        artifactPath: producer.rootDelta.path,
        mountPath: "/pack/hibernate-root-overlay.qcow2",
        bytes: producer.rootDelta.bytes,
        sha256: producer.rootDelta.sha256,
        format: producer.rootDelta.format,
        backingFilename: producer.rootDelta.backingFilename,
        backingFormat: producer.rootDelta.backingFormat,
      },
      swapImage: {
        artifactPath: producer.swapImage.path,
        mountPath: "/pack/omarchy-hibernate.qcow2",
        bytes: producer.swapImage.bytes,
        sha256: producer.swapImage.sha256,
        format: producer.swapImage.format,
        virtualBytes: producer.swapImage.virtualBytes,
        swapUuid: producer.swapImage.swapUuid,
      },
      producer: {
        manifestArtifactPath: HIBERNATION_MANIFEST_NAME,
        manifestBytes: producerBytes.byteLength,
        manifestSha256: digestBytes(producerBytes),
        qemuBinarySha256: producer.producer.qemuBinarySha256,
      },
      sourceEvidence: { ...producer.sourceEvidence },
      resumeEvidence: structuredClone(producer.resumeEvidence),
      identity: {
        ...producer.identity,
        browserQemuWasmSha256: wasmRecord.sha256,
        qemu: { ...producer.qemu },
        producerMachine: structuredClone(producer.producerMachine),
        runtimeMachine: structuredClone(producer.runtimeMachine),
      },
      restoreContract: { ...producer.restoreContract },
    };

    const manifest = structuredClone(baseManifest);
    const arguments_ = manifest.qemu?.arguments;
    invariant(Array.isArray(arguments_), "hibernation base manifest must declare QEMU arguments");
    const exactArgument = (flag, expectedValue, label) => {
      const indexes = arguments_.flatMap((value, index) => value === flag ? [index] : []);
      invariant(indexes.length === 1 && arguments_[indexes[0] + 1] === expectedValue,
        `hibernation base manifest ${label} is invalid`);
      return indexes[0];
    };
    const canonicalMachineIndex = CANONICAL_PRODUCTION_MANIFEST.qemu.arguments.indexOf("-machine");
    const machineIndex = exactArgument(
      "-machine",
      CANONICAL_PRODUCTION_MANIFEST.qemu.arguments[canonicalMachineIndex + 1],
      "cold machine type",
    );
    arguments_[machineIndex + 1] = checkpoint.identity.runtimeMachine.type;
    exactArgument("-display", checkpoint.restoreContract.runtimeDisplay, "runtime display");
    const displayDeviceIndexes = arguments_.flatMap((value, index) =>
      value === "-device" && arguments_[index + 1] === checkpoint.identity.runtimeMachine.displayDevice ? [index] : []);
    invariant(displayDeviceIndexes.length === 1, "hibernation base manifest VirGL device is invalid");
    invariant(!arguments_.includes("-cpu"), "hibernation base manifest must not predeclare a CPU override");
    const smpIndex = exactArgument("-smp", checkpoint.identity.runtimeMachine.smp, "SMP topology");
    arguments_.splice(smpIndex, 0, "-cpu", checkpoint.identity.runtimeMachine.cpu);
    const appendIndex = exactArgument(
      "-append",
      baseManifest.qemu.arguments[baseManifest.qemu.arguments.indexOf("-append") + 1],
      "kernel command line",
    );
    arguments_[appendIndex + 1] = checkpoint.restoreContract.targetKernelCommandLine;
    const initrdIndex = exactArgument(
      "-initrd",
      baseManifest.guest.initramfs.mountPath,
      "base initramfs",
    );
    arguments_[initrdIndex + 1] = checkpoint.derivedInitramfs.mountPath;
    manifest.guest.initramfs = {
      artifactPath: checkpoint.derivedInitramfs.artifactPath,
      mountPath: checkpoint.derivedInitramfs.mountPath,
    };
    manifest.checkpoint = checkpoint;
    validateProductionManifest(manifest);
    return Object.freeze({ mode: "hibernation", manifest });
  }

  invariant(
    checkpointPresence.every(Boolean),
    "checkpoint packaging refuses a partial descriptor/vmstate/boot-delta set",
  );
  const checkpointPaths = checkpointNames.map((name) => join(guestDirectory, name));

  const [producerBytes, vmstateRecord, bootDeltaRecord, wasmRecord] = await Promise.all([
    readFile(checkpointPaths[0]),
    fileRecord(checkpointPaths[1]),
    fileRecord(checkpointPaths[2]),
    fileRecord(qemuWasmPath),
  ]);
  const producer = validateCheckpointProducerManifest(JSON.parse(producerBytes), expected);
  invariant(
    producer.vmstate.bytes === vmstateRecord.bytes && producer.vmstate.sha256 === vmstateRecord.sha256,
    "checkpoint vmstate differs from checkpoint-manifest.json",
  );
  invariant(
    producer.bootDelta.bytes === bootDeltaRecord.bytes && producer.bootDelta.sha256 === bootDeltaRecord.sha256,
    "checkpoint boot delta differs from checkpoint-manifest.json",
  );
  invariant(wasmRecord.sha256 === expected.browserQemuWasmSha256, "browser QEMU Wasm is not the canonical checkpoint build");

  const guestManifest = JSON.parse(guestManifestBytes);
  await validateCheckpointSourceEvidence(producer.sourceEvidence, guestManifest.upstream, globalThis);
  invariant(
    digestBytes(guestManifestBytes) === producer.identity.baseGuestManifestSha256,
    "checkpoint base guest manifest identity is invalid",
  );
  const rootfs = artifactFromGuestManifest(guestManifest, "rootfs.ext4");
  const provenance = artifactFromGuestManifest(guestManifest, "provenance.json");
  invariant(rootfs.sha256 === producer.identity.rootfsSha256, "checkpoint rootfs identity is invalid");
  invariant(provenance.sha256 === producer.identity.guestProvenanceSha256, "checkpoint provenance identity is invalid");

  const checkpoint = {
    schemaVersion: 1,
    mode: "preboot-resume",
    vmstate: {
      artifactPath: producer.vmstate.path,
      mountPath: "/pack/omarchy-preboot.vmstate",
      bytes: producer.vmstate.bytes,
      sha256: producer.vmstate.sha256,
      format: producer.vmstate.format,
      compression: producer.vmstate.compression,
      incomingMode: producer.vmstate.incomingMode,
    },
    bootDelta: {
      artifactPath: producer.bootDelta.path,
      mountPath: "/pack/checkpoint-overlay.qcow2",
      bytes: producer.bootDelta.bytes,
      sha256: producer.bootDelta.sha256,
      format: producer.bootDelta.format,
      backingFilename: producer.bootDelta.backingFilename,
      backingFormat: producer.bootDelta.backingFormat,
    },
    producer: {
      manifestArtifactPath: CHECKPOINT_MANIFEST_NAME,
      manifestBytes: producerBytes.byteLength,
      manifestSha256: digestBytes(producerBytes),
      qemuBinarySha256: producer.producer.qemuBinarySha256,
    },
    identity: {
      baseGuestManifestSha256: producer.identity.baseGuestManifestSha256,
      rootfsSha256: producer.identity.rootfsSha256,
      guestProvenanceSha256: producer.identity.guestProvenanceSha256,
      browserQemuWasmSha256: wasmRecord.sha256,
      qemu: {
        repository: producer.qemu.repository,
        sourceCommit: producer.qemu.sourceCommit,
        version: producer.qemu.version,
      },
      machine: { ...producer.machine },
    },
  };
  return Object.freeze({ mode: "checkpoint", manifest: { ...baseManifest, checkpoint } });
}

const scriptPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (scriptPath && scriptPath === fileURLToPath(import.meta.url)) {
  const runtimeDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const guestDirectory = resolve(process.argv[2] ?? "");
  const outputPath = resolve(process.argv[3] ?? "");
  if (!process.argv[2] || !process.argv[3]) {
    throw new Error(`usage: ${basename(process.argv[1])} GUEST_DIRECTORY OUTPUT_MANIFEST`);
  }
  const experimentValue = process.env.OMARCHY_TCG_HOT_THRESHOLD_EXPERIMENT;
  let graphicsExperiment = process.env.OMARCHY_GRAPHICS_EXPERIMENT;
  const vcpuExperiment = process.env.OMARCHY_VCPU_EXPERIMENT;
  const hibernationRequested = await stat(join(guestDirectory, HIBERNATION_MANIFEST_NAME))
    .then((info) => info.isFile())
    .catch((error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });
  if (hibernationRequested) {
    invariant(!graphicsExperiment || graphicsExperiment === "virgl-webgl2",
      "guest hibernation requires the VirGL/WebGL2 runtime profile");
    invariant(!vcpuExperiment, "guest hibernation requires its exact two-vCPU restore topology");
    graphicsExperiment = "virgl-webgl2";
  }
  invariant(
    experimentValue === undefined || experimentValue === "" || experimentValue === "250" ||
      experimentValue === "750" ||
      experimentValue === "1500-metrics" || experimentValue === "1500-clock" ||
      experimentValue === "6000-fill",
    "unsupported QEMU-Wasm TCG threshold experiment",
  );
  invariant(
    vcpuExperiment === undefined || vcpuExperiment === "" || vcpuExperiment === "4",
    "unsupported browser vCPU experiment",
  );
  invariant(
    !vcpuExperiment ||
      (experimentValue === "750" && graphicsExperiment === "virgl-webgl2"),
    "the four-vCPU experiment requires VirGL/WebGL2 plus the threshold-750 TCG profile",
  );
  invariant(
    graphicsExperiment === undefined || graphicsExperiment === "" ||
      graphicsExperiment === "virgl-webgl2" || graphicsExperiment === "webgl2-present",
    "unsupported QEMU-Wasm graphics experiment",
  );
  invariant(
    !experimentValue || !graphicsExperiment ||
      ((experimentValue === "1500-metrics" || experimentValue === "750" ||
        experimentValue === "1500-clock" || experimentValue === "6000-fill") &&
        graphicsExperiment === "virgl-webgl2"),
    "only an instrumented VirGL-compatible TCG profile may be combined with VirGL/WebGL2",
  );
  const qemuWasmPath = join(resolve(outputPath, ".."), "qemu.wasm");
  const expected = experimentValue === "250" || experimentValue === "750" ||
    experimentValue === "1500-metrics" || experimentValue === "1500-clock" ||
    experimentValue === "6000-fill" ||
    graphicsExperiment === "webgl2-present"
    ? { ...EXPECTED, browserQemuWasmSha256: (await fileRecord(qemuWasmPath)).sha256 }
    : EXPECTED;
  const baseManifestName = graphicsExperiment === "virgl-webgl2"
    ? "config/virgl-webgl2.json"
    : graphicsExperiment === "webgl2-present"
      ? "config/webgl2-present.json"
      : "config/demo.json";
  const result = await buildRuntimeManifest({
    baseManifestPath: join(runtimeDirectory, baseManifestName),
    guestDirectory,
    qemuWasmPath,
    expected,
    forceCold: graphicsExperiment === "virgl-webgl2" && !hibernationRequested,
  });
  if (vcpuExperiment === "4") {
    result.manifest.qemu.cores = 4;
    const smpIndexes = result.manifest.qemu.arguments.flatMap((value, index) =>
      value === "2,sockets=1,cores=2,threads=1" ? [index] : []);
    invariant(smpIndexes.length === 1, "canonical two-vCPU SMP argument must occur exactly once");
    result.manifest.qemu.arguments[smpIndexes[0]] = "4,sockets=1,cores=4,threads=1";
  }
  if (graphicsExperiment === "virgl-webgl2" &&
      result.mode !== "cold" && result.mode !== "hibernation") {
    throw new Error("VirGL/WebGL2 may use only cold boot or its exact guest-hibernation profile");
  }
  await writeFile(outputPath, `${JSON.stringify(result.manifest, null, 2)}\n`, "utf8");
  if (experimentValue === "250") {
    process.stdout.write("runtime experiment: qemu-wasm-tcg-hot-threshold threshold=250 promotion-eligible=false\n");
  }
  if (experimentValue === "750") {
    process.stdout.write("runtime experiment: qemu-wasm-tcg-hot-threshold threshold=750 promotion-eligible=false\n");
  }
  if (experimentValue === "1500-clock") {
    process.stdout.write(
      "runtime experiment: qemu-wasm-tcg-bounded-clock threshold=1500 metrics-schema=4 cache=bounded-clock-v2 promotion-eligible=false\n",
    );
  }
  if (experimentValue === "6000-fill") {
    process.stdout.write(
      "runtime experiment: qemu-wasm-tcg-fill-only threshold=6000 metrics-schema=5 cache=fill-only-v1 active-cap=120000 promotion-eligible=false\n",
    );
  }
  if (graphicsExperiment === "virgl-webgl2") {
    process.stdout.write("runtime experiment: graphics=virgl-webgl2 promotion-eligible=false\n");
  }
  if (graphicsExperiment === "webgl2-present") {
    process.stdout.write(
      "runtime experiment: graphics=webgl2-present checkpoint-compatible=true promotion-eligible=false\n",
    );
  }
  process.stdout.write(`runtime boot mode: ${result.mode}\n`);
}
