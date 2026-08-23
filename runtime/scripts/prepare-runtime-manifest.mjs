#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_CHECKPOINT_IDENTITY,
  validateCheckpointSourceEvidence,
  validateCheckpointSourceEvidenceShape,
} from "../web/production-worker.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const CHECKPOINT_MANIFEST_NAME = "checkpoint-manifest.json";
const VMSTATE_NAME = "omarchy-preboot.vmstate";
const BOOT_DELTA_NAME = "checkpoint-overlay.qcow2";
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
}) {
  const [baseBytes, guestManifestBytes] = await Promise.all([
    readFile(baseManifestPath),
    readFile(join(guestDirectory, "guest-manifest.json")),
  ]);
  const baseManifest = JSON.parse(baseBytes);
  invariant(!("checkpoint" in baseManifest), "base runtime manifest must remain the explicit cold-boot profile");
  const checkpointNames = [CHECKPOINT_MANIFEST_NAME, VMSTATE_NAME, BOOT_DELTA_NAME];
  const checkpointPresence = await Promise.all(checkpointNames.map(async (name) => {
    const path = join(guestDirectory, name);
    try {
      return (await stat(path)).isFile();
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }));
  if (checkpointPresence.every((exists) => !exists)) {
    return Object.freeze({ mode: "cold", manifest: baseManifest });
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
  const qemuWasmPath = join(resolve(outputPath, ".."), "qemu.wasm");
  const result = await buildRuntimeManifest({
    baseManifestPath: join(runtimeDirectory, "config/demo.json"),
    guestDirectory,
    qemuWasmPath,
    expected: EXPECTED,
  });
  await writeFile(outputPath, `${JSON.stringify(result.manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`runtime boot mode: ${result.mode}\n`);
}
