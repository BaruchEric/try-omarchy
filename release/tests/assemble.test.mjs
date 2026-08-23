import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assembleRelease } from "../assemble.mjs";
import {
  CANONICAL_CHECKPOINT_IDENTITY,
  CANONICAL_PRODUCTION_RUNTIME_MANIFEST,
} from "../runtime-contract.mjs";
import { verifyArtifactManifest } from "../../scripts/verification/verify-artifact-manifest.mjs";
import {
  checkpointSourceEvidence,
  qcow2Fixture,
} from "./checkpoint-fixture.mjs";

const BUILDER_DIGEST = `sha256:${"a".repeat(64)}`;
const FIXTURE_UPSTREAM = Object.freeze({
  repository: "https://github.com/basecamp/omarchy",
  commit: "f0020448ca87329199de7cb12f2015ebc4a3e5e7",
  version: "4.0.0.alpha",
  treeSha256: "b".repeat(64),
});

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function put(root, relativePath, value) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, value);
  return {
    path: relativePath,
    bytes: Buffer.byteLength(value),
    sha256: digest(value),
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarchy-release-test-"));
  const runtime = path.join(root, "runtime");
  const guest = path.join(root, "guest");
  await Promise.all([
    import("node:fs/promises").then(({ mkdir }) => mkdir(runtime)),
    import("node:fs/promises").then(({ mkdir }) => mkdir(guest)),
  ]);

  const runtimeArtifacts = [];
  for (const [name, role, mediaType, value] of [
    ["qemu.mjs", "emulator-loader", "text/javascript", "export default 1"],
    ["qemu.wasm", "emulator-wasm", "application/wasm", "wasm-fixture"],
    ["qemu.worker.js", "emulator-worker", "text/javascript", "worker-fixture"],
    ["production-worker.mjs", "host-worker", "text/javascript", "host-worker-fixture"],
    ["worker-input.mjs", "host-input-bridge", "text/javascript", "input-fixture"],
    ["paged-disk.mjs", "paged-disk-adapter", "text/javascript", "paged-fixture"],
    ["bounded-overlay.mjs", "snapshot-overlay-guard", "text/javascript", "bounded-overlay-fixture"],
    ["firmware/bios-256k.bin", "firmware", "application/octet-stream", "bios-fixture"],
    ["firmware/vgabios-virtio.bin", "firmware", "application/octet-stream", "vgabios-fixture"],
    ["firmware/kvmvapic.bin", "firmware", "application/octet-stream", "kvmvapic-fixture"],
    ["firmware/linuxboot_dma.bin", "firmware", "application/octet-stream", "linuxboot-fixture"],
  ]) {
    runtimeArtifacts.push({ ...(await put(runtime, name, value)), role, mediaType });
  }

  const runtimeManifest = structuredClone(CANONICAL_PRODUCTION_RUNTIME_MANIFEST);
  const runtimeBuild = {
    schemaVersion: 1,
    generatedAt: "2026-08-14T12:00:00.000Z",
    component: {
      name: "QEMU-Wasm",
      repository: "https://github.com/ktock/qemu-wasm.git",
      commit: "0ef7b4e2814b231705d8371dd7997f5b72e70baf",
      modified: true,
    },
    builderImageId: BUILDER_DIGEST,
    artifacts: runtimeArtifacts,
  };
  await writeFile(path.join(runtime, "runtime-manifest.json"), `${JSON.stringify(runtimeManifest)}\n`);
  await writeFile(path.join(runtime, "runtime-build.json"), `${JSON.stringify(runtimeBuild)}\n`);

  const guestArtifacts = [];
  for (const [name, role, mediaType, value] of [
    ["vmlinuz-linux", "guest-kernel", "application/vnd.linux.kernel", "kernel-fixture"],
    ["initramfs-linux.img", "guest-initramfs", "application/vnd.linux.initramfs", "initramfs-fixture"],
    ["rootfs.ext4", "guest-rootfs", "application/vnd.omarchy.ext4", "rootfs-fixture"],
    ["provenance.json", "guest-metadata", "application/json", "{\"fixture\":true}\n"],
  ]) {
    guestArtifacts.push({ ...(await put(guest, name, value)), role, mediaType });
  }
  const guestManifest = {
    schemaVersion: 1,
    upstream: {
      ...FIXTURE_UPSTREAM,
      license: "MIT",
    },
    normalizedUpstreamTree: { sha256: "b".repeat(64) },
    build: {
      builtAt: "2026-08-14T11:00:00Z",
      sourceDateEpoch: 1786719479,
      builderImageDigest: `sha256:${"c".repeat(64)}`,
    },
    guest: {
      architecture: "x86_64",
      distribution: "Arch Linux",
      display: { width: 1600, height: 900 },
    },
    artifacts: guestArtifacts,
  };
  await writeFile(path.join(guest, "guest-manifest.json"), `${JSON.stringify(guestManifest)}\n`);

  await writeFile(path.join(root, "notices.tar.zst"), "notices-fixture");
  await writeFile(path.join(root, "sbom.spdx.json"), "{\"spdxVersion\":\"SPDX-2.3\"}\n");
  await writeFile(path.join(root, "runtime-source.tar.zst"), "source-fixture");

  const outputDirectory = path.join(root, "release");
  const config = {
    runtimeDirectory: runtime,
    guestDirectory: guest,
    outputDirectory,
    licenseBundle: path.join(root, "notices.tar.zst"),
    licenseBundleName: "THIRD_PARTY_NOTICES.tar.zst",
    sbom: path.join(root, "sbom.spdx.json"),
    runtimeSource: path.join(root, "runtime-source.tar.zst"),
    runtime: {
      license: "GPL-2.0-only",
      correspondingSourceUrl: "https://downloads.example.test/qemu-wasm-source.tar.zst",
    },
    licenses: [
      { component: "Omarchy", spdx: "MIT", noticePath: "THIRD_PARTY_NOTICES.tar.zst", sourceUrl: "https://github.com/basecamp/omarchy" },
      { component: "qemu-wasm", spdx: "GPL-2.0-only", noticePath: "THIRD_PARTY_NOTICES.tar.zst", sourceUrl: "https://github.com/ktock/qemu-wasm" },
      { component: "Linux", spdx: "GPL-2.0-only", noticePath: "THIRD_PARTY_NOTICES.tar.zst", sourceUrl: "https://kernel.org" },
    ],
  };
  return { root, runtime, guest, outputDirectory, config };
}

function checkpointProfile({ vmstate, bootDelta, producerBytes = null }) {
  return {
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
      manifestBytes: producerBytes?.byteLength ?? 1,
      manifestSha256: producerBytes ? digest(producerBytes) : "3".repeat(64),
      qemuBinarySha256: "4".repeat(64),
    },
    identity: structuredClone(CANONICAL_CHECKPOINT_IDENTITY),
  };
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

test("assembles verified fragments into a validator-clean atomic release", async () => {
  const { outputDirectory, config } = await fixture();
  const { manifest } = await assembleRelease(config);
  assert.equal(manifest.product, "Omarchy browser demo");
  assert.equal(manifest.artifacts.find((item) => item.role === "emulator-wasm").mediaType, "application/wasm");
  assert.deepEqual(
    manifest.artifacts.filter((item) => item.role === "snapshot-overlay-guard"),
    [{
      path: "bounded-overlay.mjs",
      role: "snapshot-overlay-guard",
      bytes: Buffer.byteLength("bounded-overlay-fixture"),
      sha256: digest("bounded-overlay-fixture"),
      mediaType: "text/javascript",
    }],
  );
  assert.equal(manifest.runtime.modified, true);

  const result = await verifyArtifactManifest(manifest, {
    artifactRoot: outputDirectory,
    checkFiles: true,
  });
  assert.equal(result.passed, true, JSON.stringify(result.toJSON(), null, 2));
  assert.equal((await stat(path.join(outputDirectory, "artifact-manifest.json"))).size > 0, true);
});

test("refuses a fragment when an artifact changed after hashing", async () => {
  const { runtime, config } = await fixture();
  await writeFile(path.join(runtime, "qemu.wasm"), "tampered-after-fragment");
  await assert.rejects(assembleRelease(config), /artifact (size|digest) changed/);
});

test("refuses to overwrite an immutable release directory", async () => {
  const { outputDirectory, config } = await fixture();
  await assembleRelease(config);
  await assert.rejects(assembleRelease(config), /refusing to replace existing release directory/);
  assert.equal(JSON.parse(await readFile(path.join(outputDirectory, "artifact-manifest.json"), "utf8")).schemaVersion, 1);
});

test("refuses legacy preload runtimes and missing paged guest artifacts", async () => {
  const { runtime, config } = await fixture();
  const manifestPath = path.join(runtime, "runtime-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.assets.preload = "load.js";
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  await assert.rejects(assembleRelease(config), /must not package preload or data assets/);

  delete manifest.assets.preload;
  manifest.guest.rootfs.artifactPath = "missing-rootfs.ext4";
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  await assert.rejects(
    assembleRelease(config),
    /guest\.rootfs\.artifactPath must exactly match the canonical production runtime profile/,
  );
});

test("rejects QEMU last-one-wins overrides and every production profile drift", async (t) => {
  const hostileProfiles = [
    ["-m 4096 override", (manifest) => {
      manifest.qemu.arguments[manifest.qemu.arguments.indexOf("-m") + 1] = "4096";
    }],
    ["-smp 8 override", (manifest) => {
      manifest.qemu.arguments[manifest.qemu.arguments.indexOf("-smp") + 1] = "8";
    }],
    ["-nic user override", (manifest) => {
      manifest.qemu.arguments[manifest.qemu.arguments.indexOf("-nic") + 1] = "user";
    }],
    ["-display none override", (manifest) => {
      manifest.qemu.arguments[manifest.qemu.arguments.indexOf("-display") + 1] = "none";
    }],
    ["appended duplicate option", (manifest) => {
      manifest.qemu.arguments.push("-m", "4096");
    }],
    ["memory metadata override", (manifest) => {
      manifest.qemu.memoryMiB = 4096;
    }],
    ["extra QEMU key", (manifest) => {
      manifest.qemu.unreviewedArguments = ["-nic", "user"];
    }],
    ["kernel command-line drift", (manifest) => {
      manifest.qemu.arguments[manifest.qemu.arguments.indexOf("-append") + 1] += " init=/bin/sh";
    }],
    ["storage descriptor drift", (manifest) => {
      manifest.guest.rootfs.mountPath = "/pack/attacker.ext4";
    }],
    ["diagnostic channel drift", (manifest) => {
      const index = manifest.qemu.arguments.indexOf(
        "virtserialport,chardev=omarchy-diag,name=omarchy.web.diagnostics",
      );
      manifest.qemu.arguments[index] = "virtserialport,chardev=omarchy-diag,name=attacker.channel";
    }],
  ];

  for (const [name, mutate] of hostileProfiles) {
    await t.test(name, async () => {
      const { runtime, outputDirectory, config } = await fixture();
      const manifestPath = path.join(runtime, "runtime-manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      mutate(manifest);
      await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
      await assert.rejects(
        assembleRelease(config),
        /canonical production runtime profile|canonical entries|canonical keys/,
      );
      await assert.rejects(stat(outputDirectory), { code: "ENOENT" });
    });
  }
});

test("assembly fails closed on partial checkpoint declarations and source sets", async (t) => {
  await t.test("partial runtime block", async () => {
    const { runtime, config } = await fixture();
    const manifestPath = path.join(runtime, "runtime-manifest.json");
    const manifest = structuredClone(CANONICAL_PRODUCTION_RUNTIME_MANIFEST);
    manifest.checkpoint = { schemaVersion: 1, mode: "preboot-resume" };
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(
      assembleRelease(config),
      /runtime manifest checkpoint must contain exactly the canonical keys/,
    );
  });

  await t.test("declared artifacts absent", async () => {
    const { runtime, config } = await fixture();
    const manifestPath = path.join(runtime, "runtime-manifest.json");
    const manifest = structuredClone(CANONICAL_PRODUCTION_RUNTIME_MANIFEST);
    manifest.checkpoint = checkpointProfile({
      vmstate: Buffer.from("vmstate"),
      bootDelta: Buffer.from("qcow2"),
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(assembleRelease(config), /ENOENT|checkpoint-manifest\.json/);
  });

  await t.test("canonical guest/rootfs identity mismatch", async () => {
    const { runtime, guest, config } = await fixture();
    const vmstate = Buffer.from("vmstate-fixture");
    const bootDelta = qcow2Fixture({ virtualBytes: Buffer.byteLength("rootfs-fixture") });
    const checkpoint = checkpointProfile({ vmstate, bootDelta });
    const producerBytes = Buffer.from(
      `${JSON.stringify(checkpointProducerDocument(checkpoint))}\n`,
    );
    checkpoint.producer.manifestBytes = producerBytes.byteLength;
    checkpoint.producer.manifestSha256 = digest(producerBytes);
    await Promise.all([
      writeFile(path.join(guest, "omarchy-preboot.vmstate"), vmstate),
      writeFile(path.join(guest, "checkpoint-overlay.qcow2"), bootDelta),
      writeFile(path.join(guest, "checkpoint-manifest.json"), producerBytes),
      writeFile(
        path.join(runtime, "runtime-manifest.json"),
        `${JSON.stringify({ ...structuredClone(CANONICAL_PRODUCTION_RUNTIME_MANIFEST), checkpoint })}\n`,
      ),
    ]);
    await assert.rejects(
      assembleRelease(config),
      /checkpoint base guest manifest rootfs SHA-256 does not match checkpoint identity/,
    );
  });
});

test("requires one exact bounded-overlay runtime artifact", async (t) => {
  await t.test("missing manifest pointer", async () => {
    const { runtime, config } = await fixture();
    const manifestPath = path.join(runtime, "runtime-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.assets.boundedOverlay;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(
      assembleRelease(config),
      /runtime manifest asset boundedOverlay must be bounded-overlay\.mjs/,
    );
  });

  await t.test("aliased storage guard", async () => {
    const { runtime, config } = await fixture();
    const manifestPath = path.join(runtime, "runtime-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.assets.boundedOverlay = manifest.assets.pagedDisk;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(
      assembleRelease(config),
      /runtime manifest asset boundedOverlay must be bounded-overlay\.mjs/,
    );
  });

  await t.test("missing artifact record", async () => {
    const { runtime, config } = await fixture();
    const buildPath = path.join(runtime, "runtime-build.json");
    const build = JSON.parse(await readFile(buildPath, "utf8"));
    build.artifacts = build.artifacts.filter(({ path: artifactPath }) =>
      artifactPath !== "bounded-overlay.mjs");
    await writeFile(buildPath, `${JSON.stringify(build)}\n`);
    await assert.rejects(
      assembleRelease(config),
      /release must record bounded-overlay\.mjs exactly once/,
    );
  });

  await t.test("wrong artifact role", async () => {
    const { runtime, config } = await fixture();
    const buildPath = path.join(runtime, "runtime-build.json");
    const build = JSON.parse(await readFile(buildPath, "utf8"));
    build.artifacts.find(({ path: artifactPath }) =>
      artifactPath === "bounded-overlay.mjs").role = "paged-disk-adapter";
    await writeFile(buildPath, `${JSON.stringify(build)}\n`);
    await assert.rejects(
      assembleRelease(config),
      /release must record role paged-disk-adapter exactly once|release must record role snapshot-overlay-guard exactly once/,
    );
  });

  await t.test("wrong artifact media type", async () => {
    const { runtime, config } = await fixture();
    const buildPath = path.join(runtime, "runtime-build.json");
    const build = JSON.parse(await readFile(buildPath, "utf8"));
    build.artifacts.find(({ path: artifactPath }) =>
      artifactPath === "bounded-overlay.mjs").mediaType = "application/octet-stream";
    await writeFile(buildPath, `${JSON.stringify(build)}\n`);
    await assert.rejects(
      assembleRelease(config),
      /bounded-overlay\.mjs must use media type text\/javascript/,
    );
  });

  await t.test("tampered artifact bytes", async () => {
    const { runtime, config } = await fixture();
    await writeFile(path.join(runtime, "bounded-overlay.mjs"), "tampered-overlay-fixture");
    await assert.rejects(
      assembleRelease(config),
      /artifact (size|digest) changed after fragment creation: bounded-overlay\.mjs/,
    );
  });
});
