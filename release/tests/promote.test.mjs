import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  approvalSignaturePayload,
  REQUIRED_APPROVAL_GATES,
  verifyReleaseApprovals,
} from "../approvals.mjs";
import {
  deriveReleaseId,
  prepareRelease,
  promoteRelease,
  verifyDeployedRelease,
  verifyUnclearedReleaseHidden,
} from "../promote.mjs";
import {
  CANONICAL_CHECKPOINT_IDENTITY,
  CANONICAL_PRODUCTION_RUNTIME_MANIFEST,
} from "../runtime-contract.mjs";
import { checkpointSourceEvidence, qcow2Fixture } from "./checkpoint-fixture.mjs";

const DEPLOYED_BASE_URL = "https://try.example/omarchy/versions/";
const APPROVED_AT = "2026-08-15T00:00:00.000Z";
const FIXTURE_UPSTREAM = Object.freeze({
  repository: "https://github.com/basecamp/omarchy",
  commit: "f0020448ca87329199de7cb12f2015ebc4a3e5e7",
  version: "4.0.0.alpha",
  treeSha256: "b".repeat(64),
});
const GATE_KEYS = Object.fromEntries(REQUIRED_APPROVAL_GATES.map((gate) => [
  gate,
  generateKeyPairSync("ed25519"),
]));

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function approvalPolicy() {
  return {
    schemaVersion: 1,
    keys: REQUIRED_APPROVAL_GATES.map((gate) => ({
      gate,
      keyId: `${gate}-release-key-v1`,
      publicKeyPem: GATE_KEYS[gate].publicKey.export({ type: "spki", format: "pem" }),
    })),
  };
}

function approvalDocument(manifestBytes) {
  const releaseId = digest(manifestBytes);
  const artifactManifest = { sha256: releaseId, bytes: manifestBytes.byteLength };
  const approvals = REQUIRED_APPROVAL_GATES.map((gate) => {
    const approval = {
      gate,
      decision: "approved",
      approvedAt: APPROVED_AT,
      approvedBy: `${gate} release owner`,
      evidence: [`https://evidence.example/${gate}/${releaseId}`],
      keyId: `${gate}-release-key-v1`,
    };
    return {
      ...approval,
      signature: sign(
        null,
        approvalSignaturePayload({ releaseId, artifactManifest, approval }),
        GATE_KEYS[gate].privateKey,
      ).toString("base64"),
    };
  });
  return { schemaVersion: 1, releaseId, artifactManifest, approvals };
}

async function writeApprovalFiles(fixture, { mutateDocument, mutatePolicy } = {}) {
  const policy = approvalPolicy();
  const document = approvalDocument(fixture.manifestBytes);
  mutatePolicy?.(policy);
  mutateDocument?.(document);
  const policyBytes = Buffer.from(`${JSON.stringify(policy, null, 2)}\n`);
  const approvalBytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  const approvalPolicyFile = path.join(fixture.root, "approval-policy.json");
  const approvalsFile = path.join(fixture.root, "release-approvals.json");
  await Promise.all([
    writeFile(approvalPolicyFile, policyBytes),
    writeFile(approvalsFile, approvalBytes),
  ]);
  const options = {
    approvalsFile,
    approvalPolicyFile,
    trustedApprovalPolicySha256: digest(policyBytes),
  };
  fixture.approvalOptions = options;
  return { approvalBytes, document, options, policyBytes };
}

async function fixture() {
  const temporaryRoot = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, "omarchy-promotion-test-"));
  const releaseDirectory = path.join(root, "release-candidate");
  await mkdir(releaseDirectory);
  const runtimeManifest = structuredClone(CANONICAL_PRODUCTION_RUNTIME_MANIFEST);
  const definitions = [
    ["rootfs.ext4", "guest-rootfs", "application/vnd.omarchy.ext4", Buffer.from("rootfs-authentic-fixture")],
    ["vmlinuz-linux", "guest-kernel", "application/vnd.linux.kernel", Buffer.from("kernel-authentic-fixture")],
    ["initramfs-linux.img", "guest-initramfs", "application/vnd.linux.initramfs", Buffer.from("initramfs-authentic-fixture")],
    ["provenance.json", "guest-metadata", "application/json", Buffer.from("{\"fixture\":true}\n")],
    [
      "guest-manifest.json",
      "guest-metadata",
      "application/json",
      Buffer.from(`${JSON.stringify({
        schemaVersion: 1,
        upstream: {
          ...FIXTURE_UPSTREAM,
        },
        artifacts: [
          { path: "rootfs.ext4", bytes: 24, sha256: digest("rootfs-authentic-fixture") },
          { path: "provenance.json", bytes: 17, sha256: digest("{\"fixture\":true}\n") },
        ],
      })}\n`),
    ],
    ["qemu.mjs", "emulator-loader", "text/javascript", Buffer.from("loader-authentic-fixture")],
    ["qemu.wasm", "emulator-wasm", "application/wasm", Buffer.from("wasm-authentic-fixture")],
    ["qemu.worker.js", "emulator-worker", "text/javascript", Buffer.from("worker-authentic-fixture")],
    ["production-worker.mjs", "host-worker", "text/javascript", Buffer.from("host-worker-fixture")],
    ["worker-input.mjs", "host-input-bridge", "text/javascript", Buffer.from("input-bridge-fixture")],
    ["paged-disk.mjs", "paged-disk-adapter", "text/javascript", Buffer.from("paged-disk-fixture")],
    ["bounded-overlay.mjs", "snapshot-overlay-guard", "text/javascript", Buffer.from("bounded-overlay-fixture")],
    ["firmware/bios-256k.bin", "firmware", "application/octet-stream", Buffer.from("bios-fixture")],
    ["firmware/vgabios-virtio.bin", "firmware", "application/octet-stream", Buffer.from("vgabios-fixture")],
    ["firmware/kvmvapic.bin", "firmware", "application/octet-stream", Buffer.from("kvmvapic-fixture")],
    ["firmware/linuxboot_dma.bin", "firmware", "application/octet-stream", Buffer.from("linuxboot-fixture")],
    [
      "runtime-manifest.json",
      "runtime-config",
      "application/json",
      Buffer.from(`${JSON.stringify(runtimeManifest, null, 2)}\n`),
    ],
  ];
  const files = new Map(definitions.map(([artifactPath, , , bytes]) => [artifactPath, bytes]));
  const artifacts = [];
  for (const [artifactPath, role, mediaType, bytes] of definitions) {
    const filePath = path.join(releaseDirectory, artifactPath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);
    artifacts.push({
      path: artifactPath,
      role,
      bytes: bytes.byteLength,
      sha256: digest(bytes),
      mediaType,
    });
  }
  const manifest = {
    schemaVersion: 1,
    product: "Omarchy browser demo",
    artifacts,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(releaseDirectory, "artifact-manifest.json"), manifestBytes);
  const result = {
    artifacts,
    files,
    manifest,
    manifestBytes,
    releaseDirectory,
    root,
    runtimeManifest,
  };
  await writeApprovalFiles(result);
  return result;
}

async function rewriteRuntimeManifest(fixtureValue) {
  const bytes = Buffer.from(`${JSON.stringify(fixtureValue.runtimeManifest, null, 2)}\n`);
  const artifact = fixtureValue.manifest.artifacts.find(({ path: artifactPath }) =>
    artifactPath === "runtime-manifest.json");
  artifact.bytes = bytes.byteLength;
  artifact.sha256 = digest(bytes);
  fixtureValue.files.set("runtime-manifest.json", bytes);
  await writeFile(path.join(fixtureValue.releaseDirectory, "runtime-manifest.json"), bytes);
  await rewriteArtifactManifest(fixtureValue);
}

async function rewriteArtifactManifest(fixtureValue) {
  const bytes = Buffer.from(`${JSON.stringify(fixtureValue.manifest, null, 2)}\n`);
  fixtureValue.manifestBytes = bytes;
  await writeFile(path.join(fixtureValue.releaseDirectory, "artifact-manifest.json"), bytes);
}

function checkpointProducerDocument(checkpoint) {
  return {
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
    producer: { qemuBinarySha256: checkpoint.producer.qemuBinarySha256 },
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
    sourceEvidence: checkpointSourceEvidence(FIXTURE_UPSTREAM),
  };
}

async function addReleaseArtifact(fixtureValue, artifactPath, role, mediaType, bytes) {
  const filePath = path.join(fixtureValue.releaseDirectory, artifactPath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
  const record = {
    path: artifactPath,
    role,
    bytes: bytes.byteLength,
    sha256: digest(bytes),
    mediaType,
  };
  fixtureValue.manifest.artifacts.push(record);
  fixtureValue.files.set(artifactPath, bytes);
  return record;
}

async function declareCheckpoint(fixtureValue) {
  const vmstate = Buffer.from("checkpoint-vmstate-fixture");
  const bootDelta = qcow2Fixture({
    virtualBytes: Buffer.byteLength("rootfs-authentic-fixture"),
  });
  const checkpoint = {
    schemaVersion: 1,
    mode: "preboot-resume",
    vmstate: {
      artifactPath: "omarchy-preboot.vmstate",
      mountPath: "/pack/omarchy-preboot.vmstate",
      bytes: vmstate.byteLength,
      sha256: digest(vmstate),
      format: "qemu-8.2-migration",
      compression: "none",
      incomingMode: "file",
    },
    bootDelta: {
      artifactPath: "checkpoint-overlay.qcow2",
      mountPath: "/pack/checkpoint-overlay.qcow2",
      bytes: bootDelta.byteLength,
      sha256: digest(bootDelta),
      format: "qcow2",
      backingFilename: "rootfs.ext4",
      backingFormat: "raw",
    },
    producer: {
      manifestArtifactPath: "checkpoint-manifest.json",
      manifestBytes: 1,
      manifestSha256: "3".repeat(64),
      qemuBinarySha256: "4".repeat(64),
    },
    identity: structuredClone(CANONICAL_CHECKPOINT_IDENTITY),
  };
  let producerDocument = checkpointProducerDocument(checkpoint);
  let producerBytes = Buffer.from(`${JSON.stringify(producerDocument)}\n`);
  checkpoint.producer.manifestBytes = producerBytes.byteLength;
  checkpoint.producer.manifestSha256 = digest(producerBytes);
  fixtureValue.runtimeManifest.checkpoint = checkpoint;
  await addReleaseArtifact(
    fixtureValue,
    checkpoint.vmstate.artifactPath,
    "preboot-vmstate",
    "application/vnd.qemu.vmstate",
    vmstate,
  );
  await addReleaseArtifact(
    fixtureValue,
    checkpoint.bootDelta.artifactPath,
    "preboot-disk-delta",
    "application/vnd.qemu.qcow2",
    bootDelta,
  );
  const producerRecord = await addReleaseArtifact(
    fixtureValue,
    checkpoint.producer.manifestArtifactPath,
    "preboot-checkpoint-metadata",
    "application/json",
    producerBytes,
  );
  await rewriteRuntimeManifest(fixtureValue);
  return {
    checkpoint,
    producerDocument,
    async rewriteProducer(mutator) {
      mutator(producerDocument);
      producerBytes = Buffer.from(`${JSON.stringify(producerDocument)}\n`);
      checkpoint.producer.manifestBytes = producerBytes.byteLength;
      checkpoint.producer.manifestSha256 = digest(producerBytes);
      producerRecord.bytes = producerBytes.byteLength;
      producerRecord.sha256 = digest(producerBytes);
      fixtureValue.files.set(checkpoint.producer.manifestArtifactPath, producerBytes);
      await writeFile(
        path.join(fixtureValue.releaseDirectory, checkpoint.producer.manifestArtifactPath),
        producerBytes,
      );
      await rewriteRuntimeManifest(fixtureValue);
    },
  };
}

class FakeStore {
  constructor(entries = []) {
    this.entries = new Map(entries);
    this.bodies = new Map();
    this.calls = [];
    this.deploymentCalls = [];
    this.maxUploadConcurrency = 0;
    this.activeUploads = 0;
    this.maxChunkBytes = 0;
  }

  async head(key) {
    this.calls.push({ operation: "head", key });
    return this.entries.get(key) ?? null;
  }

  async putFile(options) {
    this.calls.push({ operation: "putFile", ...options });
    if (options.ifNoneMatch && this.entries.has(options.key)) throw new Error("precondition failed");
    assert.equal(typeof options.filePath, "string");
    this.activeUploads += 1;
    this.maxUploadConcurrency = Math.max(this.maxUploadConcurrency, this.activeUploads);
    const hash = createHash("sha256");
    const chunks = [];
    let bytes = 0;
    try {
      for await (const chunk of createReadStream(options.filePath, { highWaterMark: 7 })) {
        this.maxChunkBytes = Math.max(this.maxChunkBytes, chunk.byteLength);
        chunks.push(chunk);
        bytes += chunk.byteLength;
        hash.update(chunk);
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      this.activeUploads -= 1;
    }
    assert.equal(bytes, options.bytes);
    assert.equal(hash.digest("hex"), options.sha256);
    this.bodies.set(options.key, Buffer.concat(chunks));
    this.entries.set(options.key, this.object(options.key, options));
  }

  async putBytes(options) {
    this.calls.push({ operation: "putBytes", ...options });
    if (options.ifNoneMatch && this.entries.has(options.key)) throw new Error("precondition failed");
    assert.equal(options.bytes.byteLength, Number(options.customMetadata.bytes));
    assert.equal(digest(options.bytes), options.sha256);
    this.bodies.set(options.key, Buffer.from(options.bytes));
    this.entries.set(options.key, this.object(options.key, {
      ...options,
      bytes: options.bytes.byteLength,
    }));
  }

  object(key, options) {
    return {
      key,
      size: options.bytes,
      etag: `"generation-${this.entries.size + 1}"`,
      customMetadata: { ...options.customMetadata },
      httpMetadata: { ...options.httpMetadata },
    };
  }
}

function clearanceValid(store, releaseId) {
  const body = store.bodies.get(`omarchy/versions/${releaseId}/clearance.json`);
  if (!body) return false;
  try {
    const document = JSON.parse(body);
    return document.schemaVersion === 1 &&
      document.releaseId === releaseId &&
      document.artifactManifestSha256 === releaseId &&
      REQUIRED_APPROVAL_GATES.every((gate) => document.approvals?.[gate]?.approved === true);
  } catch {
    return false;
  }
}

function clearanceAwareFetch(store) {
  return async (url, options) => {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/omarchy\/versions\/([0-9a-f]{64})\/(.+)$/);
    assert.ok(match, `unexpected deployed URL: ${url}`);
    const [, releaseId, artifactPath] = match;
    const key = `omarchy/versions/${releaseId}/${artifactPath}`;
    const cleared = clearanceValid(store, releaseId);
    store.deploymentCalls.push({ key, options, cleared });
    if (!cleared) {
      return new Response(null, {
        status: 404,
        headers: { "X-Omarchy-Artifact-Error": "RELEASE_NOT_CLEARED" },
      });
    }
    const object = store.entries.get(key);
    if (!object) return new Response(null, { status: 404 });
    const common = {
      "Content-Encoding": "identity",
      "Content-Type": object.httpMetadata.contentType,
      ETag: `"sha256-${object.customMetadata.sha256}"`,
      "Repr-Digest": `sha-256=:${Buffer.from(object.customMetadata.sha256, "hex").toString("base64")}:`,
    };
    if (options.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { ...common, "Content-Length": String(object.size) },
      });
    }
    assert.equal(options.headers.Range, "bytes=0-0");
    assert.equal(options.headers["If-Match"], common.ETag);
    return new Response(new Uint8Array([store.bodies.get(key)?.[0] ?? 0]), {
      status: 206,
      headers: {
        ...common,
        "Content-Length": "1",
        "Content-Range": `bytes 0-0/${object.size}`,
      },
    });
  };
}

function promotionOptions(fixtureValue, store, overrides = {}) {
  return {
    releaseDirectory: fixtureValue.releaseDirectory,
    store,
    deployedBaseUrl: DEPLOYED_BASE_URL,
    fetchImpl: clearanceAwareFetch(store),
    snapshotRoot: fixtureValue.root,
    snapshotMode: "copy",
    concurrency: 2,
    ...fixtureValue.approvalOptions,
    ...overrides,
  };
}

test("release ID is the full SHA-256 of the exact uploaded manifest bytes", () => {
  const compact = Buffer.from('{"schemaVersion":1}\n');
  const spaced = Buffer.from('{"schemaVersion": 1}\n');
  assert.equal(deriveReleaseId(compact), digest(compact));
  assert.match(deriveReleaseId(compact), /^[0-9a-f]{64}$/);
  assert.notEqual(deriveReleaseId(compact), deriveReleaseId(spaced));
});

test("prepares a release only after every artifact size and digest match", async () => {
  const value = await fixture();
  const prepared = await prepareRelease(value.releaseDirectory, { concurrency: 2 });
  assert.equal(prepared.releaseId, digest(value.manifestBytes));
  assert.deepEqual(prepared.items.map((item) => item.path), [
    "bounded-overlay.mjs",
    "firmware/bios-256k.bin",
    "firmware/kvmvapic.bin",
    "firmware/linuxboot_dma.bin",
    "firmware/vgabios-virtio.bin",
    "guest-manifest.json",
    "initramfs-linux.img",
    "paged-disk.mjs",
    "production-worker.mjs",
    "provenance.json",
    "qemu.mjs",
    "qemu.wasm",
    "qemu.worker.js",
    "rootfs.ext4",
    "runtime-manifest.json",
    "vmlinuz-linux",
    "worker-input.mjs",
    "artifact-manifest.json",
  ]);

  await writeFile(path.join(value.releaseDirectory, "rootfs.ext4"), "Rootfs-authentic-fixture");
  await assert.rejects(prepareRelease(value.releaseDirectory), /SHA-256 does not match/);
});

test("promotion rejects overridden, duplicated, or appended production QEMU options", async (t) => {
  const hostileProfiles = [
    ["-m 4096", (manifest) => {
      manifest.qemu.arguments[manifest.qemu.arguments.indexOf("-m") + 1] = "4096";
    }],
    ["-smp 8", (manifest) => {
      manifest.qemu.arguments[manifest.qemu.arguments.indexOf("-smp") + 1] = "8";
    }],
    ["-nic user", (manifest) => {
      manifest.qemu.arguments[manifest.qemu.arguments.indexOf("-nic") + 1] = "user";
    }],
    ["-display none", (manifest) => {
      manifest.qemu.arguments[manifest.qemu.arguments.indexOf("-display") + 1] = "none";
    }],
    ["duplicate -nic override", (manifest) => {
      manifest.qemu.arguments.push("-nic", "user");
    }],
  ];

  for (const [name, mutate] of hostileProfiles) {
    await t.test(name, async () => {
      const value = await fixture();
      mutate(value.runtimeManifest);
      await rewriteRuntimeManifest(value);
      const store = new FakeStore();
      await assert.rejects(
        promoteRelease(promotionOptions(value, store)),
        /canonical production runtime profile|canonical entries/,
      );
      assert.deepEqual(store.calls, []);
      assert.deepEqual(store.deploymentCalls, []);
    });
  }
});

test("promotion requires every artifact referenced by the exact production profile", async () => {
  const value = await fixture();
  value.manifest.artifacts = value.manifest.artifacts.filter(
    ({ path: artifactPath }) => artifactPath !== "vmlinuz-linux",
  );
  await rewriteArtifactManifest(value);
  const store = new FakeStore();
  await assert.rejects(
    promoteRelease(promotionOptions(value, store)),
    /release must record referenced production artifact vmlinuz-linux exactly once/,
  );
  assert.deepEqual(store.calls, []);
  assert.deepEqual(store.deploymentCalls, []);
});

test("promotion fails closed on partial, undeclared, or mismatched checkpoints", async (t) => {
  await t.test("partial runtime declaration", async () => {
    const value = await fixture();
    value.runtimeManifest.checkpoint = { schemaVersion: 1, mode: "preboot-resume" };
    await rewriteRuntimeManifest(value);
    await assert.rejects(
      prepareRelease(value.releaseDirectory),
      /runtime manifest checkpoint must contain exactly the canonical keys/,
    );
  });

  await t.test("undeclared checkpoint artifact", async () => {
    const value = await fixture();
    await addReleaseArtifact(
      value,
      "undeclared.vmstate",
      "preboot-vmstate",
      "application/vnd.qemu.vmstate",
      Buffer.from("undeclared checkpoint bytes"),
    );
    await rewriteArtifactManifest(value);
    await assert.rejects(
      prepareRelease(value.releaseDirectory),
      /cold runtime must not package undeclared checkpoint artifacts/,
    );
  });

  await t.test("missing checkpoint delta record", async () => {
    const value = await fixture();
    await declareCheckpoint(value);
    value.manifest.artifacts = value.manifest.artifacts.filter(
      ({ path: artifactPath }) => artifactPath !== "checkpoint-overlay.qcow2",
    );
    await rewriteArtifactManifest(value);
    await assert.rejects(
      prepareRelease(value.releaseDirectory),
      /release must record (?:referenced production artifact )?checkpoint-overlay\.qcow2 exactly once/,
    );
  });

  await t.test("checkpoint artifact role drift", async () => {
    const value = await fixture();
    await declareCheckpoint(value);
    value.manifest.artifacts.find(
      ({ path: artifactPath }) => artifactPath === "omarchy-preboot.vmstate",
    ).role = "guest-metadata";
    await rewriteArtifactManifest(value);
    await assert.rejects(
      prepareRelease(value.releaseDirectory),
      /omarchy-preboot\.vmstate must use role preboot-vmstate/,
    );
  });

  await t.test("producer restore contract drift", async () => {
    const value = await fixture();
    const declared = await declareCheckpoint(value);
    await declared.rewriteProducer((document) => {
      document.restoreContract.qmpContRequired = true;
    });
    await assert.rejects(
      prepareRelease(value.releaseDirectory),
      /restoreContract\.qmpContRequired must exactly match the runtime checkpoint producer document/,
    );
  });

  await t.test("backing rootfs identity drift", async () => {
    const value = await fixture();
    await declareCheckpoint(value);
    await assert.rejects(
      prepareRelease(value.releaseDirectory),
      /checkpoint backing rootfs SHA-256 does not match checkpoint identity/,
    );
  });
});

test("production promotion requires the exact bounded-overlay contract", async (t) => {
  await t.test("missing manifest pointer", async () => {
    const value = await fixture();
    delete value.runtimeManifest.assets.boundedOverlay;
    await rewriteRuntimeManifest(value);
    await assert.rejects(
      prepareRelease(value.releaseDirectory),
      /runtime manifest asset boundedOverlay must be bounded-overlay\.mjs/,
    );
  });

  await t.test("aliased to the paged disk adapter", async () => {
    const value = await fixture();
    value.runtimeManifest.assets.boundedOverlay = value.runtimeManifest.assets.pagedDisk;
    await rewriteRuntimeManifest(value);
    await assert.rejects(
      prepareRelease(value.releaseDirectory),
      /runtime manifest asset boundedOverlay must be bounded-overlay\.mjs/,
    );
  });

  await t.test("missing artifact record", async () => {
    const value = await fixture();
    value.manifest.artifacts = value.manifest.artifacts.filter(({ path: artifactPath }) =>
      artifactPath !== "bounded-overlay.mjs");
    await rewriteArtifactManifest(value);
    const store = new FakeStore();
    await assert.rejects(
      promoteRelease(promotionOptions(value, store)),
      /release must record bounded-overlay\.mjs exactly once/,
    );
    assert.deepEqual(store.calls, []);
    assert.deepEqual(store.deploymentCalls, []);
  });

  await t.test("wrong role", async () => {
    const value = await fixture();
    value.manifest.artifacts.find(({ path: artifactPath }) =>
      artifactPath === "bounded-overlay.mjs").role = "emulator-worker";
    await rewriteArtifactManifest(value);
    await assert.rejects(
      prepareRelease(value.releaseDirectory),
      /release must record role snapshot-overlay-guard exactly once/,
    );
  });

  await t.test("wrong media type", async () => {
    const value = await fixture();
    value.manifest.artifacts.find(({ path: artifactPath }) =>
      artifactPath === "bounded-overlay.mjs").mediaType = "application/octet-stream";
    await rewriteArtifactManifest(value);
    await assert.rejects(
      prepareRelease(value.releaseDirectory),
      /bounded-overlay\.mjs must use media type text\/javascript/,
    );
  });

  await t.test("tampered bytes", async () => {
    const value = await fixture();
    await writeFile(
      path.join(value.releaseDirectory, "bounded-overlay.mjs"),
      "tampered-overlay-fixture",
    );
    await assert.rejects(
      prepareRelease(value.releaseDirectory),
      /bounded-overlay\.mjs/,
    );
  });
});

test("symlinked files and artifact or manifest parents are rejected", async (t) => {
  await t.test("artifact file", async () => {
    const value = await fixture();
    const target = path.join(value.releaseDirectory, "rootfs.real");
    await rename(path.join(value.releaseDirectory, "rootfs.ext4"), target);
    await symlink("rootfs.real", path.join(value.releaseDirectory, "rootfs.ext4"));
    await assert.rejects(prepareRelease(value.releaseDirectory), /symbolic link/);
  });

  await t.test("artifact parent", async () => {
    const value = await fixture();
    await rename(path.join(value.releaseDirectory, "firmware"), path.join(value.releaseDirectory, "firmware-real"));
    await symlink("firmware-real", path.join(value.releaseDirectory, "firmware"));
    await assert.rejects(prepareRelease(value.releaseDirectory), /symbolic link/);
  });

  await t.test("manifest", async () => {
    const value = await fixture();
    const target = path.join(value.releaseDirectory, "manifest.real.json");
    await rename(path.join(value.releaseDirectory, "artifact-manifest.json"), target);
    await symlink("manifest.real.json", path.join(value.releaseDirectory, "artifact-manifest.json"));
    await assert.rejects(prepareRelease(value.releaseDirectory), /symbolic link/);
  });

  await t.test("release root", async () => {
    const value = await fixture();
    const alias = path.join(value.root, "release-root-link");
    await symlink(path.basename(value.releaseDirectory), alias);
    await assert.rejects(prepareRelease(alias), /release directory cannot be a symbolic link/);
  });

});

test("unsafe and encoded artifact paths fail before deployment or storage is touched", async (t) => {
  for (const unsafePath of ["../escape", "nested/../../escape", "/absolute", "nested//file", "nested/%2e%2e/file", "nested\\file"]) {
    await t.test(unsafePath, async () => {
      const value = await fixture();
      value.manifest.artifacts[0].path = unsafePath;
      await writeFile(path.join(value.releaseDirectory, "artifact-manifest.json"), `${JSON.stringify(value.manifest)}\n`);
      const store = new FakeStore();
      await assert.rejects(promoteRelease(promotionOptions(value, store)), /(unsafe|canonical|relative)/);
      assert.deepEqual(store.calls, []);
      assert.deepEqual(store.deploymentCalls, []);
    });
  }
});

test("four Ed25519 approvals and an independently pinned policy are mandatory", async (t) => {
  await t.test("valid exact release approvals", async () => {
    const value = await fixture();
    const grant = await verifyReleaseApprovals({
      releaseId: digest(value.manifestBytes),
      manifestBytes: value.manifestBytes,
      ...value.approvalOptions,
    });
    assert.deepEqual(Object.keys(grant.approvals), REQUIRED_APPROVAL_GATES);
  });

  await t.test("unpublished policy sentinel", async () => {
    const value = await fixture();
    await assert.rejects(
      verifyReleaseApprovals({
        releaseId: digest(value.manifestBytes),
        manifestBytes: value.manifestBytes,
        ...value.approvalOptions,
        trustedApprovalPolicySha256: "0".repeat(64),
      }),
      /unpublished sentinel/,
    );
  });

  await t.test("policy substitution", async () => {
    const value = await fixture();
    await writeApprovalFiles(value, { mutatePolicy: (policy) => { policy.keys[0].keyId = "attacker-key"; } });
    await assert.rejects(
      verifyReleaseApprovals({
        releaseId: digest(value.manifestBytes),
        manifestBytes: value.manifestBytes,
        ...value.approvalOptions,
        trustedApprovalPolicySha256: "a".repeat(64),
      }),
      /policy SHA-256 does not match/,
    );
  });

  await t.test("independent gate keys", async () => {
    const value = await fixture();
    await writeApprovalFiles(value, {
      mutatePolicy: (policy) => {
        policy.keys[1].publicKeyPem = policy.keys[0].publicKeyPem;
      },
    });
    await assert.rejects(
      verifyReleaseApprovals({
        releaseId: digest(value.manifestBytes),
        manifestBytes: value.manifestBytes,
        ...value.approvalOptions,
      }),
      /reuses a public key across gates/,
    );
  });

  await t.test("release binding", async () => {
    const value = await fixture();
    const document = JSON.parse(await readFile(value.approvalOptions.approvalsFile, "utf8"));
    document.releaseId = "f".repeat(64);
    await writeFile(value.approvalOptions.approvalsFile, `${JSON.stringify(document)}\n`);
    await assert.rejects(
      verifyReleaseApprovals({
        releaseId: digest(value.manifestBytes),
        manifestBytes: value.manifestBytes,
        ...value.approvalOptions,
      }),
      /different release ID/,
    );
  });

  await t.test("signature tamper", async () => {
    const value = await fixture();
    const document = JSON.parse(await readFile(value.approvalOptions.approvalsFile, "utf8"));
    document.approvals[0].approvedBy = "different signer";
    await writeFile(value.approvalOptions.approvalsFile, `${JSON.stringify(document)}\n`);
    await assert.rejects(
      verifyReleaseApprovals({
        releaseId: digest(value.manifestBytes),
        manifestBytes: value.manifestBytes,
        ...value.approvalOptions,
      }),
      /signature is invalid/,
    );
  });

  await t.test("missing gate", async () => {
    const value = await fixture();
    const document = JSON.parse(await readFile(value.approvalOptions.approvalsFile, "utf8"));
    document.approvals.pop();
    await writeFile(value.approvalOptions.approvalsFile, `${JSON.stringify(document)}\n`);
    await assert.rejects(
      verifyReleaseApprovals({
        releaseId: digest(value.manifestBytes),
        manifestBytes: value.manifestBytes,
        ...value.approvalOptions,
      }),
      /exactly four gate records/,
    );
  });
});

test("upload cannot start without approvals or deployed clearance gating", async (t) => {
  await t.test("missing approvals", async () => {
    const value = await fixture();
    const store = new FakeStore();
    await assert.rejects(
      promoteRelease(promotionOptions(value, store, { approvalsFile: undefined })),
      /approvals file is required/,
    );
    assert.deepEqual(store.calls, []);
    assert.deepEqual(store.deploymentCalls, []);
  });

  await t.test("route does not prove clearance denial", async () => {
    const value = await fixture();
    const store = new FakeStore();
    await assert.rejects(
      promoteRelease(promotionOptions(value, store, {
        fetchImpl: async () => new Response(null, { status: 404 }),
      })),
      /ambiguously rejected an uncleared artifact/,
    );
    assert.deepEqual(store.calls, []);
  });
});

test("any existing claim, version, or clearance generation stops before upload", async (t) => {
  for (const namespace of ["staging", "versions", "clearance"]) {
    await t.test(namespace, async () => {
      const value = await fixture();
      const releaseId = digest(value.manifestBytes);
      const key = namespace === "staging"
        ? `omarchy/staging/${releaseId}/claim.json`
        : namespace === "clearance"
          ? `omarchy/versions/${releaseId}/clearance.json`
          : `omarchy/versions/${releaseId}/rootfs.ext4`;
      const store = new FakeStore([[key, { key, size: 1, etag: '"existing"' }]]);
      await assert.rejects(
        promoteRelease(promotionOptions(value, store)),
        /refusing to replace existing immutable object/,
      );
      assert.equal(store.calls.some((call) => call.operation === "putFile"), false);
      assert.equal(store.calls.some((call) => call.operation === "putBytes"), false);
    });
  }
});

test("uploads frozen streams and emits exact worker-compatible clearance last", async () => {
  const value = await fixture();
  const store = new FakeStore();
  const result = await promoteRelease(promotionOptions(value, store));

  assert.equal(result.releaseId, digest(value.manifestBytes));
  assert.equal(result.versionPrefix, `omarchy/versions/${result.releaseId}`);
  assert.equal(result.clearanceKey, `${result.versionPrefix}/clearance.json`);
  assert.equal(result.claimKey, `omarchy/staging/${result.releaseId}/claim.json`);
  assert.equal(store.maxUploadConcurrency <= 2, true);
  assert.equal(store.maxUploadConcurrency > 1, true);
  assert.equal(store.maxChunkBytes <= 7, true);

  const artifactPuts = store.calls.filter((call) => call.operation === "putFile");
  assert.equal(artifactPuts.length, value.artifacts.length + 1);
  for (const call of artifactPuts) {
    assert.match(call.key, new RegExp(`^omarchy/versions/${result.releaseId}/`));
    assert.equal(call.filePath.startsWith(value.releaseDirectory), false);
    assert.equal(call.ifNoneMatch, true);
    assert.equal(call.customMetadata.bytes, String(call.bytes));
    assert.equal(call.customMetadata.sha256, call.sha256);
    assert.equal(call.httpMetadata.contentEncoding, "identity");
    assert.ok(call.httpMetadata.contentType.includes("/"));
  }

  const smallWrites = store.calls.filter((call) => call.operation === "putBytes");
  assert.deepEqual(smallWrites.map((call) => call.key), [result.claimKey, result.clearanceKey]);
  const clearance = JSON.parse(store.bodies.get(result.clearanceKey));
  assert.deepEqual(Object.keys(clearance).sort(), [
    "approvalEvidenceSha256",
    "approvalPolicySha256",
    "approvals",
    "artifactManifestSha256",
    "releaseId",
    "schemaVersion",
  ]);
  assert.deepEqual(Object.keys(clearance.approvals), REQUIRED_APPROVAL_GATES);
  for (const gate of REQUIRED_APPROVAL_GATES) {
    assert.deepEqual(Object.keys(clearance.approvals[gate]).sort(), ["approved", "approvedAt", "approvedBy"]);
    assert.equal(clearance.approvals[gate].approved, true);
    assert.equal(clearance.approvals[gate].approvedAt, APPROVED_AT);
  }
  const clearanceCallIndex = store.calls.findIndex(
    (call) => call.operation === "putBytes" && call.key === result.clearanceKey,
  );
  assert.ok(clearanceCallIndex > store.calls.findLastIndex((call) => call.operation === "putFile"));
  assert.equal(store.deploymentCalls.filter((call) => !call.cleared).length, (value.artifacts.length + 1) * 2);
  assert.equal(store.deploymentCalls.some((call) => call.cleared), true);
  for (const call of artifactPuts) await assert.rejects(lstat(call.filePath), { code: "ENOENT" });
});

test("source mutation between uploaded ranges cannot change the frozen snapshot", async () => {
  const value = await fixture();
  const sourcePath = path.join(value.releaseDirectory, "rootfs.ext4");
  const original = await readFile(sourcePath);
  const replacement = Buffer.alloc(original.byteLength, 0x78);
  const store = new FakeStore();
  const originalPut = store.putFile.bind(store);
  let attacked = false;
  store.putFile = async (options) => {
    if (options.key.endsWith("rootfs.ext4")) {
      attacked = true;
      await writeFile(sourcePath, replacement);
      try {
        await originalPut(options);
      } finally {
        await writeFile(sourcePath, original);
      }
      return;
    }
    await originalPut(options);
  };

  const result = await promoteRelease(promotionOptions(value, store));
  assert.equal(attacked, true);
  assert.deepEqual(store.bodies.get(`${result.versionPrefix}/rootfs.ext4`), original);
  assert.deepEqual(await readFile(sourcePath), original);
});

test("failures before clearance leave canonical objects publicly hidden", async (t) => {
  await t.test("artifact upload", async () => {
    const value = await fixture();
    const store = new FakeStore();
    store.putFile = async (options) => {
      store.calls.push({ operation: "putFile", ...options });
      throw new Error("upload failed");
    };
    await assert.rejects(promoteRelease(promotionOptions(value, store)), /upload failed/);
    const smallWrites = store.calls.filter((call) => call.operation === "putBytes");
    assert.equal(smallWrites.length, 1);
    assert.match(smallWrites[0].key, /\/staging\//);
  });

  await t.test("post-upload metadata", async () => {
    const value = await fixture();
    const store = new FakeStore();
    const originalHead = store.head.bind(store);
    store.head = async (key) => {
      const object = await originalHead(key);
      if (object && key.includes("/versions/") && key.endsWith("rootfs.ext4")) {
        return { ...object, customMetadata: { ...object.customMetadata, sha256: "f".repeat(64) } };
      }
      return object;
    };
    await assert.rejects(promoteRelease(promotionOptions(value, store)), /SHA-256 metadata is wrong/);
    assert.equal([...store.entries.keys()].some((key) => key.endsWith("clearance.json")), false);
  });

  await t.test("route exposes a canonical object before clearance", async () => {
    const value = await fixture();
    const store = new FakeStore();
    let hiddenChecks = 0;
    const correctFetch = clearanceAwareFetch(store);
    const fetchImpl = async (url, options) => {
      hiddenChecks += 1;
      if (hiddenChecks > value.artifacts.length + 1 && !clearanceValid(store, digest(value.manifestBytes))) {
        return new Response(null, { status: 200 });
      }
      return correctFetch(url, options);
    };
    await assert.rejects(
      promoteRelease(promotionOptions(value, store, { fetchImpl })),
      /exposed or ambiguously rejected/,
    );
    assert.equal([...store.entries.keys()].some((key) => key.endsWith("clearance.json")), false);
  });
});

test("deployed verification HEADs every object and pins a one-byte rootfs range", async () => {
  const value = await fixture();
  const prepared = await prepareRelease(value.releaseDirectory);
  const deployedItems = prepared.items.map((item) =>
    item.path === "qemu.wasm"
      ? { ...item, path: "runtime/qemu+worker.js", mediaType: "text/javascript" }
      : item,
  );
  const requests = [];
  const fetchImpl = async (url, options) => {
    const artifactPath = decodeURIComponent(new URL(url).pathname.split(`/${prepared.releaseId}/`)[1]);
    const item = deployedItems.find((candidate) => candidate.path === artifactPath);
    assert.ok(item, `unexpected deployed path: ${artifactPath}`);
    requests.push({ url: String(url), options, item });
    const common = {
      "Content-Encoding": "identity",
      "Content-Type": item.mediaType,
      ETag: `"sha256-${item.sha256}"`,
      "Repr-Digest": `sha-256=:${Buffer.from(item.sha256, "hex").toString("base64")}:`,
    };
    if (options.method === "HEAD") {
      return new Response(null, { status: 200, headers: { ...common, "Content-Length": String(item.bytes) } });
    }
    return new Response(new Uint8Array([0]), {
      status: 206,
      headers: { ...common, "Content-Length": "1", "Content-Range": `bytes 0-0/${item.bytes}` },
    });
  };

  await verifyDeployedRelease({
    deployedBaseUrl: DEPLOYED_BASE_URL,
    releaseId: prepared.releaseId,
    items: deployedItems,
  }, { fetchImpl, concurrency: 2 });
  assert.equal(requests.filter(({ options }) => options.method === "HEAD").length, deployedItems.length);
  assert.equal(requests.filter(({ options }) => options.method === "GET").length, 1);
  assert.equal(requests.some(({ url }) => url.includes("qemu+worker.js")), true);
  assert.equal(requests.some(({ url }) => url.includes("%2B")), false);
});

test("deployed checkpoint verification range-probes rootfs, vmstate, and qcow2 delta", async () => {
  const items = [
    {
      path: "rootfs.ext4",
      role: "guest-rootfs",
      bytes: 6000,
      sha256: "1".repeat(64),
      mediaType: "application/vnd.omarchy.ext4",
    },
    {
      path: "omarchy-preboot.vmstate",
      role: "preboot-vmstate",
      bytes: 3000,
      sha256: "2".repeat(64),
      mediaType: "application/vnd.qemu.vmstate",
    },
    {
      path: "checkpoint-overlay.qcow2",
      role: "preboot-disk-delta",
      bytes: 2000,
      sha256: "3".repeat(64),
      mediaType: "application/vnd.qemu.qcow2",
    },
  ];
  const requests = [];
  const fetchImpl = async (url, options) => {
    const artifactPath = new URL(url).pathname.split("/").at(-1);
    const item = items.find(({ path: itemPath }) => itemPath === artifactPath);
    assert.ok(item);
    requests.push({ item, options });
    const headers = {
      "Content-Encoding": "identity",
      "Content-Type": item.mediaType,
      ETag: `"sha256-${item.sha256}"`,
      "Repr-Digest": `sha-256=:${Buffer.from(item.sha256, "hex").toString("base64")}:`,
      "Content-Length": options.method === "HEAD" ? String(item.bytes) : "1",
    };
    if (options.method === "HEAD") return new Response(null, { status: 200, headers });
    return new Response(new Uint8Array([0]), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes 0-0/${item.bytes}` },
    });
  };

  await verifyDeployedRelease({
    deployedBaseUrl: DEPLOYED_BASE_URL,
    releaseId: "a".repeat(64),
    items,
  }, { fetchImpl });
  const ranges = requests.filter(({ options }) => options.method === "GET");
  assert.equal(ranges.length, 3);
  assert.deepEqual(ranges.map(({ item }) => item.path).sort(), items.map(({ path: itemPath }) => itemPath).sort());
  for (const { item, options } of ranges) {
    assert.equal(options.headers.Range, "bytes=0-0");
    assert.equal(options.headers["If-Match"], `"sha256-${item.sha256}"`);
  }
});

test("deployed hibernation verification range-probes rootfs, root delta, and swap", async () => {
  const items = [
    {
      path: "rootfs.ext4",
      role: "guest-rootfs",
      bytes: 6000,
      sha256: "1".repeat(64),
      mediaType: "application/vnd.omarchy.ext4",
    },
    {
      path: "hibernate-root-overlay.qcow2",
      role: "hibernation-root-delta",
      bytes: 3000,
      sha256: "2".repeat(64),
      mediaType: "application/vnd.qemu.qcow2",
    },
    {
      path: "omarchy-hibernate.qcow2",
      role: "hibernation-swap-image",
      bytes: 2000,
      sha256: "3".repeat(64),
      mediaType: "application/vnd.qemu.qcow2",
    },
  ];
  const requests = [];
  const fetchImpl = async (url, options) => {
    const artifactPath = new URL(url).pathname.split("/").at(-1);
    const item = items.find(({ path: itemPath }) => itemPath === artifactPath);
    assert.ok(item);
    requests.push({ item, options });
    const headers = {
      "Content-Encoding": "identity",
      "Content-Type": item.mediaType,
      ETag: `"sha256-${item.sha256}"`,
      "Repr-Digest": `sha-256=:${Buffer.from(item.sha256, "hex").toString("base64")}:`,
      "Content-Length": options.method === "HEAD" ? String(item.bytes) : "1",
    };
    if (options.method === "HEAD") return new Response(null, { status: 200, headers });
    return new Response(new Uint8Array([0]), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes 0-0/${item.bytes}` },
    });
  };

  await verifyDeployedRelease({
    deployedBaseUrl: DEPLOYED_BASE_URL,
    releaseId: "a".repeat(64),
    items,
  }, { fetchImpl });
  assert.deepEqual(
    requests
      .filter(({ options }) => options.method === "GET")
      .map(({ item }) => item.path)
      .sort(),
    items.map(({ path: itemPath }) => itemPath).sort(),
  );

  await assert.rejects(
    verifyDeployedRelease({
      deployedBaseUrl: DEPLOYED_BASE_URL,
      releaseId: "a".repeat(64),
      items: items.slice(0, 2),
    }, { fetchImpl }),
    /hibernation range artifacts are partial/,
  );
});

test("uncleared verification rejects generic 404s", async () => {
  const value = await fixture();
  const prepared = await prepareRelease(value.releaseDirectory);
  await assert.rejects(
    verifyUnclearedReleaseHidden(
      { deployedBaseUrl: DEPLOYED_BASE_URL, releaseId: prepared.releaseId, items: prepared.items },
      { fetchImpl: async () => new Response(null, { status: 404 }) },
    ),
    /ambiguously rejected/,
  );
});

test("the uploaded manifest item is byte-for-byte the file that names the release", async () => {
  const value = await fixture();
  const prepared = await prepareRelease(value.releaseDirectory);
  const manifestItem = prepared.items.find((item) => item.path === "artifact-manifest.json");
  assert.equal(manifestItem.sha256, digest(await readFile(manifestItem.filePath)));
  assert.equal(prepared.releaseId, digest(value.manifestBytes));
  assert.equal(prepared.releaseId, manifestItem.sha256);
});
