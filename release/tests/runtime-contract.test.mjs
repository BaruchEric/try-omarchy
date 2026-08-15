import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_CHECKPOINT_IDENTITY,
  CANONICAL_PRODUCTION_RUNTIME_MANIFEST,
  checkpointArtifactRecords,
  isGuestHibernationProfile,
  validateCheckpointGuestManifestDocument,
  validateCheckpointProducerDocument,
  validateExactProductionRuntimeProfile,
  validateProductionRuntimeContract,
} from "../runtime-contract.mjs";
import {
  checkpointSourceEvidence,
  hibernationProducerDocument,
  hibernationProfile,
  hibernationRuntimeManifest,
} from "./checkpoint-fixture.mjs";

const FIXTURE_UPSTREAM = Object.freeze({
  repository: "https://github.com/basecamp/omarchy",
  commit: "f0020448ca87329199de7cb12f2015ebc4a3e5e7",
  version: "4.0.0.alpha",
  treeSha256: "b".repeat(64),
});

function checkpointProfile() {
  return {
    schemaVersion: 1,
    mode: "preboot-resume",
    vmstate: {
      artifactPath: "omarchy-preboot.vmstate",
      mountPath: "/pack/omarchy-preboot.vmstate",
      bytes: 380_000_000,
      sha256: "1".repeat(64),
      format: "qemu-8.2-migration",
      compression: "none",
      incomingMode: "file",
    },
    bootDelta: {
      artifactPath: "checkpoint-overlay.qcow2",
      mountPath: "/pack/checkpoint-overlay.qcow2",
      bytes: 18_000_000,
      sha256: "2".repeat(64),
      format: "qcow2",
      backingFilename: "rootfs.ext4",
      backingFormat: "raw",
    },
    producer: {
      manifestArtifactPath: "checkpoint-manifest.json",
      manifestBytes: 2048,
      manifestSha256: "3".repeat(64),
      qemuBinarySha256: "4".repeat(64),
    },
    identity: structuredClone(CANONICAL_CHECKPOINT_IDENTITY),
  };
}

function checkpointManifest() {
  return {
    ...structuredClone(CANONICAL_PRODUCTION_RUNTIME_MANIFEST),
    checkpoint: checkpointProfile(),
  };
}

function producerDocument(checkpoint) {
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

function artifact(path, role, mediaType, sha256 = "a".repeat(64), bytes = 1024) {
  return { path, role, mediaType, sha256, bytes };
}

function coldArtifacts() {
  return [
    artifact("qemu.mjs", "emulator-loader", "text/javascript"),
    artifact("production-worker.mjs", "host-worker", "text/javascript"),
    artifact("worker-input.mjs", "host-input-bridge", "text/javascript"),
    artifact("paged-disk.mjs", "paged-disk-adapter", "text/javascript"),
    artifact("bounded-overlay.mjs", "snapshot-overlay-guard", "text/javascript"),
    artifact(
      "qemu.wasm",
      "emulator-wasm",
      "application/wasm",
      CANONICAL_CHECKPOINT_IDENTITY.browserQemuWasmSha256,
    ),
    artifact("qemu.worker.js", "emulator-worker", "text/javascript"),
    artifact("firmware/bios-256k.bin", "firmware", "application/octet-stream"),
    artifact("firmware/vgabios-virtio.bin", "firmware", "application/octet-stream"),
    artifact("firmware/kvmvapic.bin", "firmware", "application/octet-stream"),
    artifact("firmware/linuxboot_dma.bin", "firmware", "application/octet-stream"),
    artifact(
      "rootfs.ext4",
      "guest-rootfs",
      "application/vnd.omarchy.ext4",
      CANONICAL_CHECKPOINT_IDENTITY.rootfsSha256,
    ),
    artifact("vmlinuz-linux", "guest-kernel", "application/vnd.linux.kernel"),
    artifact("initramfs-linux.img", "guest-initramfs", "application/vnd.linux.initramfs"),
    artifact(
      "guest-manifest.json",
      "guest-metadata",
      "application/json",
      CANONICAL_CHECKPOINT_IDENTITY.baseGuestManifestSha256,
    ),
    artifact(
      "provenance.json",
      "guest-metadata",
      "application/json",
      CANONICAL_CHECKPOINT_IDENTITY.guestProvenanceSha256,
    ),
  ];
}

function checkpointArtifacts(manifest = checkpointManifest()) {
  return [
    ...coldArtifacts(),
    ...checkpointArtifactRecords(manifest),
  ];
}

function hibernationManifest() {
  const profile = hibernationProfile({ upstream: FIXTURE_UPSTREAM });
  return hibernationRuntimeManifest(
    CANONICAL_PRODUCTION_RUNTIME_MANIFEST,
    profile,
  );
}

function hibernationArtifacts(manifest = hibernationManifest()) {
  const { checkpoint } = manifest;
  const artifacts = coldArtifacts().map((record) => ({ ...record }));
  const bind = (path, sha256) => {
    artifacts.find((record) => record.path === path).sha256 = sha256;
  };
  bind("qemu.wasm", checkpoint.identity.browserQemuWasmSha256);
  bind("rootfs.ext4", checkpoint.identity.rootfsSha256);
  bind("provenance.json", checkpoint.identity.guestProvenanceSha256);
  bind("guest-manifest.json", checkpoint.identity.baseGuestManifestSha256);
  bind("vmlinuz-linux", checkpoint.identity.kernelSha256);
  bind("initramfs-linux.img", checkpoint.identity.baseInitramfsSha256);
  artifacts.push(
    artifact(
      checkpoint.derivedInitramfs.artifactPath,
      "hibernation-initramfs",
      "application/vnd.linux.initramfs",
      checkpoint.derivedInitramfs.sha256,
      checkpoint.derivedInitramfs.bytes,
    ),
    artifact(
      checkpoint.rootDelta.artifactPath,
      "hibernation-root-delta",
      "application/vnd.qemu.qcow2",
      checkpoint.rootDelta.sha256,
      checkpoint.rootDelta.bytes,
    ),
    artifact(
      checkpoint.swapImage.artifactPath,
      "hibernation-swap-image",
      "application/vnd.qemu.qcow2",
      checkpoint.swapImage.sha256,
      checkpoint.swapImage.bytes,
    ),
    artifact(
      checkpoint.producer.manifestArtifactPath,
      "hibernation-metadata",
      "application/json",
      checkpoint.producer.manifestSha256,
      checkpoint.producer.manifestBytes,
    ),
  );
  return artifacts;
}

function guestManifestDocument(checkpoint) {
  return {
    schemaVersion: 1,
    upstream: {
      ...FIXTURE_UPSTREAM,
    },
    artifacts: [
      {
        path: "rootfs.ext4",
        bytes: 6_442_450_944,
        sha256: checkpoint.identity.rootfsSha256,
      },
      {
        path: "provenance.json",
        bytes: 4096,
        sha256: checkpoint.identity.guestProvenanceSha256,
      },
    ],
  };
}

test("cold and complete checkpoint production contracts are exact", async () => {
  const cold = structuredClone(CANONICAL_PRODUCTION_RUNTIME_MANIFEST);
  assert.equal(validateExactProductionRuntimeProfile(cold), CANONICAL_PRODUCTION_RUNTIME_MANIFEST);
  validateProductionRuntimeContract(cold, coldArtifacts());

  const manifest = checkpointManifest();
  assert.equal(validateExactProductionRuntimeProfile(manifest), manifest);
  validateProductionRuntimeContract(manifest, checkpointArtifacts(manifest));
  assert.deepEqual(
    checkpointArtifactRecords(manifest).map(({ path, role, mediaType }) => ({ path, role, mediaType })),
    [
      {
        path: "omarchy-preboot.vmstate",
        role: "preboot-vmstate",
        mediaType: "application/vnd.qemu.vmstate",
      },
      {
        path: "checkpoint-overlay.qcow2",
        role: "preboot-disk-delta",
        mediaType: "application/vnd.qemu.qcow2",
      },
      {
        path: "checkpoint-manifest.json",
        role: "preboot-checkpoint-metadata",
        mediaType: "application/json",
      },
    ],
  );
  await validateCheckpointProducerDocument(
    producerDocument(manifest.checkpoint),
    manifest.checkpoint,
    FIXTURE_UPSTREAM,
  );
  validateCheckpointGuestManifestDocument(
    guestManifestDocument(manifest.checkpoint),
    manifest.checkpoint,
  );
});

test("partial, extended, or mismatched checkpoint declarations fail closed", async (t) => {
  const hostile = [
    ["missing vmstate", (checkpoint) => delete checkpoint.vmstate],
    ["extra key", (checkpoint) => { checkpoint.fallback = "cold"; }],
    ["wrong mode", (checkpoint) => { checkpoint.mode = "best-effort"; }],
    ["wrong vmstate path", (checkpoint) => { checkpoint.vmstate.artifactPath = "other.vmstate"; }],
    ["wrong vmstate mount", (checkpoint) => { checkpoint.vmstate.mountPath = "/tmp/state"; }],
    ["empty vmstate", (checkpoint) => { checkpoint.vmstate.bytes = 0; }],
    ["noncanonical digest", (checkpoint) => { checkpoint.vmstate.sha256 = "A".repeat(64); }],
    ["compressed migration", (checkpoint) => { checkpoint.vmstate.compression = "gzip"; }],
    ["absolute backing", (checkpoint) => { checkpoint.bootDelta.backingFilename = "/rootfs.ext4"; }],
    ["wrong backing format", (checkpoint) => { checkpoint.bootDelta.backingFormat = "qcow2"; }],
    ["rootfs identity drift", (checkpoint) => { checkpoint.identity.rootfsSha256 = "f".repeat(64); }],
    ["machine drift", (checkpoint) => { checkpoint.identity.machine.memoryMiB = 2048; }],
    ["QEMU drift", (checkpoint) => { checkpoint.identity.qemu.version = "9.0.0"; }],
  ];
  for (const [name, mutate] of hostile) {
    await t.test(name, () => {
      const manifest = checkpointManifest();
      mutate(manifest.checkpoint);
      assert.throws(
        () => validateExactProductionRuntimeProfile(manifest),
        /checkpoint|canonical/,
      );
    });
  }
});

test("checkpoint release records bind every artifact, role, media type, and identity", async (t) => {
  const hostile = [
    ["missing vmstate", (artifacts) => artifacts.splice(
      artifacts.findIndex(({ path }) => path === "omarchy-preboot.vmstate"), 1,
    )],
    ["vmstate role", (artifacts) => {
      artifacts.find(({ path }) => path === "omarchy-preboot.vmstate").role = "guest-metadata";
    }],
    ["delta media", (artifacts) => {
      artifacts.find(({ path }) => path === "checkpoint-overlay.qcow2").mediaType = "application/octet-stream";
    }],
    ["producer bytes", (artifacts) => {
      artifacts.find(({ path }) => path === "checkpoint-manifest.json").bytes += 1;
    }],
    ["rootfs identity", (artifacts) => {
      artifacts.find(({ path }) => path === "rootfs.ext4").sha256 = "f".repeat(64);
    }],
    ["guest manifest identity", (artifacts) => {
      artifacts.find(({ path }) => path === "guest-manifest.json").sha256 = "f".repeat(64);
    }],
    ["provenance identity", (artifacts) => {
      artifacts.find(({ path }) => path === "provenance.json").sha256 = "f".repeat(64);
    }],
    ["browser QEMU identity", (artifacts) => {
      artifacts.find(({ path }) => path === "qemu.wasm").sha256 = "f".repeat(64);
    }],
  ];
  for (const [name, mutate] of hostile) {
    await t.test(name, () => {
      const manifest = checkpointManifest();
      const artifacts = checkpointArtifacts(manifest).map((record) => ({ ...record }));
      mutate(artifacts);
      assert.throws(
        () => validateProductionRuntimeContract(manifest, artifacts),
        /checkpoint|vmstate|delta|producer|rootfs|guest manifest|provenance|QEMU|canonical/i,
      );
    });
  }

  const cold = structuredClone(CANONICAL_PRODUCTION_RUNTIME_MANIFEST);
  assert.throws(
    () => validateProductionRuntimeContract(cold, [
      ...coldArtifacts(),
      artifact("unused.vmstate", "preboot-vmstate", "application/vnd.qemu.vmstate"),
    ]),
    /cold runtime must not package undeclared checkpoint artifacts/,
  );
});

test("producer and guest documents cannot contradict the normalized checkpoint block", async (t) => {
  const checkpoint = checkpointProfile();
  const producerHostile = [
    ["legacy kind", (document) => { document.kind = "omarchy-preboot-checkpoint"; }],
    ["missing restore contract", (document) => delete document.restoreContract],
    ["paused source", (document) => { document.restoreContract.sourceRunstate = "paused"; }],
    ["QMP cont", (document) => { document.restoreContract.qmpContRequired = true; }],
    ["producer QEMU", (document) => { document.producer.qemuBinarySha256 = "f".repeat(64); }],
    ["delta backing", (document) => { document.bootDelta.backingFilename = "other.ext4"; }],
    ["extra top-level field", (document) => { document.note = "ignore mismatch"; }],
    ["source report digest", (document) => {
      document.sourceEvidence.normalizedGuestReportSha256 = "f".repeat(64);
    }],
    ["source monitor", (document) => {
      const monitorCommand = document.sourceEvidence.guestReport.commands.find(
        ({ argv }) => argv.join(" ") === "hyprctl monitors -j",
      );
      monitorCommand.stdout = "[{\"width\":1280,\"height\":720}]";
    }],
  ];
  for (const [name, mutate] of producerHostile) {
    await t.test(name, async () => {
      const document = producerDocument(checkpoint);
      mutate(document);
      await assert.rejects(
        validateCheckpointProducerDocument(document, checkpoint, FIXTURE_UPSTREAM),
        /producer|checkpoint|runtime checkpoint|source/i,
      );
    });
  }

  const guest = guestManifestDocument(checkpoint);
  guest.artifacts.find(({ path }) => path === "rootfs.ext4").sha256 = "f".repeat(64);
  assert.throws(
    () => validateCheckpointGuestManifestDocument(guest, checkpoint),
    /rootfs SHA-256 does not match checkpoint identity/,
  );
});

test("guest hibernation release binds exact profile, argv, artifacts, and producer", async () => {
  const manifest = hibernationManifest();
  assert.equal(isGuestHibernationProfile(manifest.checkpoint), true);
  assert.equal(validateExactProductionRuntimeProfile(manifest), manifest);
  validateProductionRuntimeContract(manifest, hibernationArtifacts(manifest));
  assert.deepEqual(
    checkpointArtifactRecords(manifest).map(({ path, role, mediaType }) => ({
      path,
      role,
      mediaType,
    })),
    [
      {
        path: "initramfs-virgl-hibernate.img",
        role: "hibernation-initramfs",
        mediaType: "application/vnd.linux.initramfs",
      },
      {
        path: "hibernate-root-overlay.qcow2",
        role: "hibernation-root-delta",
        mediaType: "application/vnd.qemu.qcow2",
      },
      {
        path: "omarchy-hibernate.qcow2",
        role: "hibernation-swap-image",
        mediaType: "application/vnd.qemu.qcow2",
      },
      {
        path: "hibernate-manifest.json",
        role: "hibernation-metadata",
        mediaType: "application/json",
      },
    ],
  );
  await validateCheckpointProducerDocument(
    hibernationProducerDocument(manifest.checkpoint, FIXTURE_UPSTREAM),
    manifest.checkpoint,
    FIXTURE_UPSTREAM,
  );
});

test("hibernation profile rejects omission, mutation, replay, and downgrade", async (t) => {
  const hostileProfiles = [
    ["missing derived initramfs", (manifest) => delete manifest.checkpoint.derivedInitramfs],
    ["cold fallback", (manifest) => { manifest.checkpoint.restoreContract.coldBootFallbackAllowed = true; }],
    ["migration downgrade", (manifest) => { manifest.checkpoint.mode = "preboot-resume"; }],
    ["swap UUID", (manifest) => { manifest.checkpoint.swapImage.swapUuid = "11111111-2222-4333-8444-555555555555"; }],
    ["derived identity", (manifest) => { manifest.checkpoint.identity.derivedInitramfsSha256 = "f".repeat(64); }],
    ["producer display", (manifest) => {
      manifest.checkpoint.identity.producerMachine.display = "sdl,gl=es,show-cursor=on";
    }],
    ["runtime display", (manifest) => {
      manifest.checkpoint.identity.runtimeMachine.display = "sdl,gl=on,show-cursor=on";
    }],
    ["runtime topology", (manifest) => {
      manifest.checkpoint.identity.runtimeMachine.smp = "4,sockets=1,cores=4,threads=1";
    }],
    ["cold initrd argv", (manifest) => {
      manifest.qemu.arguments[manifest.qemu.arguments.indexOf("-initrd") + 1] = "/pack/initramfs-linux.img";
    }],
    ["software display argv", (manifest) => {
      manifest.qemu.arguments[manifest.qemu.arguments.indexOf("-display") + 1] = "sdl,gl=off,show-cursor=on";
    }],
    ["migration argv", (manifest) => manifest.qemu.arguments.push("-incoming", "file:/pack/replayed.vmstate")],
    ["direct root downgrade", (manifest) => manifest.qemu.arguments.push(
      "-drive",
      "file=/pack/rootfs.ext4,if=virtio,format=raw,media=disk,cache=unsafe",
    )],
  ];
  for (const [name, mutate] of hostileProfiles) {
    await t.test(name, () => {
      const manifest = hibernationManifest();
      mutate(manifest);
      assert.throws(
        () => validateExactProductionRuntimeProfile(manifest),
        /hibernation|checkpoint|canonical|profile|runtime manifest/i,
      );
    });
  }

  const manifest = hibernationManifest();
  const hostileArtifacts = [
    "initramfs-virgl-hibernate.img",
    "hibernate-root-overlay.qcow2",
    "omarchy-hibernate.qcow2",
    "hibernate-manifest.json",
    "rootfs.ext4",
    "vmlinuz-linux",
    "initramfs-linux.img",
    "guest-manifest.json",
    "provenance.json",
    "qemu.wasm",
  ];
  for (const path of hostileArtifacts) {
    await t.test(`artifact mutation ${path}`, () => {
      const artifacts = hibernationArtifacts(manifest);
      artifacts.find((record) => record.path === path).sha256 = "f".repeat(64);
      assert.throws(
        () => validateProductionRuntimeContract(manifest, artifacts),
        /hibernation|checkpoint|initramfs|rootfs|kernel|manifest|provenance|QEMU/i,
      );
    });
  }

  await t.test("producer source evidence replay", async () => {
    const document = hibernationProducerDocument(
      manifest.checkpoint,
      FIXTURE_UPSTREAM,
    );
    document.sourceEvidence.nonceSha256 = "f".repeat(64);
    await assert.rejects(
      validateCheckpointProducerDocument(
        document,
        manifest.checkpoint,
        FIXTURE_UPSTREAM,
      ),
      /source|evidence|producer|checkpoint/i,
    );
  });
  await t.test("producer resume evidence mutation", async () => {
    const document = hibernationProducerDocument(
      manifest.checkpoint,
      FIXTURE_UPSTREAM,
    );
    document.resumeEvidence.hibernationMarkerSha256 = "f".repeat(64);
    await assert.rejects(
      validateCheckpointProducerDocument(
        document,
        manifest.checkpoint,
        FIXTURE_UPSTREAM,
      ),
      /hibernation|producer|checkpoint/i,
    );
  });
});
