import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  CANONICAL_HIBERNATION_ARGUMENTS,
  CANONICAL_PRODUCTION_MANIFEST,
  HIBERNATION_SWAP_UUID,
  HIBERNATION_SWAP_VIRTUAL_BYTES,
  HibernationResumeGate,
  ProductionWorkerError,
  checkpointArgumentsForManifest,
  checkpointCachePlan,
  isHibernationCheckpoint,
  normalizedJsonBytes,
  parseHibernationReportLine,
  parseRendererReportLine,
  serializeError,
  validateCheckpointArtifacts,
  validateCheckpointProducerDocument,
  validateProductionManifest,
} from "../web/production-worker.mjs";
import {
  buildRuntimeManifest,
  validateHibernationProducerManifest,
} from "../scripts/prepare-runtime-manifest.mjs";
import { buildFullGuestRelease } from "../scripts/serve-full-guest.mjs";

const SWAP_UUID = "4c9a13d2-7c3a-4f2c-b6e1-5a3048610e8f";
const SOURCE_BOOT_ID = "8d8ea31b-3c52-4cc5-a876-f9e1fc0b68a7";
const NONCE = "ab".repeat(32);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceEvidence() {
  return {
    diagnosticsSha256: "c".repeat(64),
    hibernationEntryMarkerSha256: "d".repeat(64),
    nonceSha256: sha256(NONCE),
    sourceBootId: SOURCE_BOOT_ID,
    gpuBoundAtHibernate: false,
  };
}

function targetCommandLine(swapUuid = SWAP_UUID) {
  return [
    "root=/dev/vda", "rw", "rootwait", "console=tty0", "console=ttyS0,115200n8", "loglevel=4",
    "systemd.show_status=false", "rd.systemd.show_status=false", "mitigations=off", "nowatchdog",
    "omarchy.web_demo=1", `resume=UUID=${swapUuid}`, "ignore_loglevel", "hibernate.compressor=lzo",
    `omarchy.hibernate_swap_uuid=${swapUuid}`,
  ].join(" ");
}

function resumeMarker() {
  return {
    schemaVersion: 1,
    status: "resumed",
    nonce: NONCE,
    sourceBootId: SOURCE_BOOT_ID,
    swapUuid: SWAP_UUID,
    gpuDriver: "virtio_gpu",
    renderNode: "/dev/dri/renderD128",
    renderer: "virgl",
  };
}

function resumeEvidence(marker = resumeMarker()) {
  const hashes = Object.fromEntries([
    "diagnosticsSha256", "rendererProbeSha256", "normalizedGuestReportSha256",
    "reportValidationSha256", "desktopFrame1Sha256", "desktopFrame1HealthSha256",
    "desktopFrame2Sha256", "desktopFrame2HealthSha256", "footFrameSha256",
    "footFrameHealthSha256", "footChangeSha256",
  ].map((key, index) => [key, (index % 10).toString(16).repeat(64)]));
  return {
    ...hashes,
    hibernationMarkerSha256: sha256(normalizedJsonBytes(marker)),
    renderer: "virgl (Mesa 26.2.0)",
    freshPostResumeInteraction: true,
  };
}

function hibernationProfile({
  baseGuestManifestSha256 = "1".repeat(64),
  browserQemuWasmSha256 = "2".repeat(64),
  rootfsSha256 = "3".repeat(64),
  guestProvenanceSha256 = "4".repeat(64),
  kernelSha256 = "5".repeat(64),
  baseInitramfsSha256 = "6".repeat(64),
  derivedInitramfsSha256 = "b".repeat(64),
  evidence = sourceEvidence(),
} = {}) {
  const commandLineBase = targetCommandLine();
  const resumed = resumeEvidence();
  return {
    schemaVersion: 1,
    mode: "guest-hibernation-resume",
    derivedInitramfs: {
      artifactPath: "initramfs-virgl-hibernate.img",
      mountPath: "/pack/initramfs-virgl-hibernate.img",
      bytes: 72_000_000,
      sha256: derivedInitramfsSha256,
      format: "linux-initramfs",
      baseArtifactPath: "initramfs-linux.img",
    },
    rootDelta: {
      artifactPath: "hibernate-root-overlay.qcow2",
      mountPath: "/pack/hibernate-root-overlay.qcow2",
      bytes: 24_000_000,
      sha256: "7".repeat(64),
      format: "qcow2",
      backingFilename: "rootfs.ext4",
      backingFormat: "raw",
    },
    swapImage: {
      artifactPath: "omarchy-hibernate.qcow2",
      mountPath: "/pack/omarchy-hibernate.qcow2",
      bytes: 480_000_000,
      sha256: "8".repeat(64),
      format: "qcow2",
      virtualBytes: 1_610_612_736,
      swapUuid: SWAP_UUID,
    },
    producer: {
      manifestArtifactPath: "hibernate-manifest.json",
      manifestBytes: 4096,
      manifestSha256: "9".repeat(64),
      qemuBinarySha256: "a".repeat(64),
    },
    sourceEvidence: structuredClone(evidence),
    resumeEvidence: resumed,
    identity: {
      baseGuestManifestSha256,
      rootfsSha256,
      guestProvenanceSha256,
      kernelSha256,
      baseInitramfsSha256,
      derivedInitramfsSha256,
      browserQemuWasmSha256,
      qemu: {
        repository: "https://github.com/ktock/qemu-wasm.git",
        sourceCommit: "0ef7b4e2814b231705d8371dd7997f5b72e70baf",
        version: "8.2.0",
      },
      producerMachine: {
        type: "pc-q35-8.2,i8042=off",
        memoryMiB: 1024,
        smp: "2,sockets=1,cores=2,threads=1",
        accel: "tcg,tb-size=128,thread=multi",
        cpu: "qemu64",
        display: "sdl,gl=on,show-cursor=on,full-screen=on",
        displayDevice: "virtio-vga-gl,max_outputs=1,xres=1600,yres=900",
        blockDevices: [
          { driveId: "omarchy-hibernate-root", device: "virtio-blk-pci", serial: "omarchy-root", role: "root", format: "qcow2" },
          { driveId: "omarchy-hibernate-swap", device: "virtio-blk-pci", serial: "omarchy-resume", role: "resume", format: "qcow2" },
        ],
      },
      runtimeMachine: {
        type: "pc-q35-8.2,i8042=off",
        memoryMiB: 1024,
        smp: "2,sockets=1,cores=2,threads=1",
        accel: "tcg,tb-size=128,thread=multi",
        cpu: "qemu64",
        display: "sdl,gl=es,show-cursor=on",
        displayDevice: "virtio-vga-gl,max_outputs=1,xres=1600,yres=900",
        blockDevices: [
          { driveId: "omarchy-hibernate-root", device: "virtio-blk-pci", serial: "omarchy-root", role: "root", format: "qcow2" },
          { driveId: "omarchy-hibernate-swap", device: "virtio-blk-pci", serial: "omarchy-resume", role: "resume", format: "qcow2" },
        ],
      },
    },
    restoreContract: {
      coldBootFallbackAllowed: false,
      disposableWrites: "target -snapshot layers over immutable root delta and hibernation image",
      gpuBoundAtHibernate: false,
      kernelCommandLineBase: commandLineBase,
      resumeNonceSha256: evidence.nonceSha256,
      sourceBootId: SOURCE_BOOT_ID,
      sourceEvidenceSha256: sha256(normalizedJsonBytes(evidence)),
      sourceKernelCommandLineSha256: sha256(
        `${commandLineBase} omarchy.hibernate_producer=1 omarchy.hibernate_nonce=${NONCE}`,
      ),
      sourceKernelCommandLineRedacted:
        `${commandLineBase} omarchy.hibernate_producer=1 omarchy.hibernate_nonce=<redacted>`,
      targetKernelCommandLine: `${commandLineBase} omarchy.hibernate_target=1`,
      runtimeDisplay: "sdl,gl=es,show-cursor=on",
      virtioGpuLoadedAfterResume: true,
    },
  };
}

function hibernationManifest(profile = hibernationProfile()) {
  const manifest = structuredClone(CANONICAL_PRODUCTION_MANIFEST);
  manifest.qemu.arguments[manifest.qemu.arguments.indexOf("-machine") + 1] =
    profile.identity.runtimeMachine.type;
  const display = manifest.qemu.arguments.indexOf("-display");
  manifest.qemu.arguments[display + 1] = profile.identity.runtimeMachine.display;
  const device = manifest.qemu.arguments.indexOf("virtio-vga,max_outputs=1,xres=1600,yres=900");
  manifest.qemu.arguments[device] = profile.identity.runtimeMachine.displayDevice;
  const append = manifest.qemu.arguments.indexOf("-append");
  manifest.qemu.arguments[append + 1] = profile.restoreContract.targetKernelCommandLine;
  manifest.guest.initramfs = {
    artifactPath: profile.derivedInitramfs.artifactPath,
    mountPath: profile.derivedInitramfs.mountPath,
  };
  const initrd = manifest.qemu.arguments.indexOf("-initrd");
  manifest.qemu.arguments[initrd + 1] = profile.derivedInitramfs.mountPath;
  manifest.qemu.arguments.splice(6, 0, "-cpu", profile.identity.runtimeMachine.cpu);
  manifest.checkpoint = profile;
  return manifest;
}

function hibernationProducer(profile, evidence = sourceEvidence()) {
  return {
    schemaVersion: 1,
    kind: "omarchy-web-guest-hibernation",
    derivedInitramfs: {
      artifactPath: profile.derivedInitramfs.artifactPath,
      bytes: profile.derivedInitramfs.bytes,
      sha256: profile.derivedInitramfs.sha256,
      format: profile.derivedInitramfs.format,
      baseArtifactPath: profile.derivedInitramfs.baseArtifactPath,
    },
    rootDelta: {
      path: profile.rootDelta.artifactPath,
      bytes: profile.rootDelta.bytes,
      sha256: profile.rootDelta.sha256,
      format: profile.rootDelta.format,
      backingFilename: profile.rootDelta.backingFilename,
      backingFormat: profile.rootDelta.backingFormat,
    },
    swapImage: {
      path: profile.swapImage.artifactPath,
      bytes: profile.swapImage.bytes,
      sha256: profile.swapImage.sha256,
      format: profile.swapImage.format,
      virtualBytes: profile.swapImage.virtualBytes,
      swapUuid: profile.swapImage.swapUuid,
    },
    producer: { qemuBinarySha256: profile.producer.qemuBinarySha256 },
    resumeEvidence: structuredClone(profile.resumeEvidence),
    identity: {
      baseGuestManifestSha256: profile.identity.baseGuestManifestSha256,
      rootfsSha256: profile.identity.rootfsSha256,
      guestProvenanceSha256: profile.identity.guestProvenanceSha256,
      kernelSha256: profile.identity.kernelSha256,
      baseInitramfsSha256: profile.identity.baseInitramfsSha256,
      derivedInitramfsSha256: profile.identity.derivedInitramfsSha256,
      browserQemuWasmSha256: profile.identity.browserQemuWasmSha256,
    },
    qemu: { ...profile.identity.qemu },
    producerMachine: structuredClone(profile.identity.producerMachine),
    runtimeMachine: structuredClone(profile.identity.runtimeMachine),
    restoreContract: { ...profile.restoreContract },
    sourceEvidence: evidence,
  };
}

test("hibernation manifest binds exact devices, immutable artifacts, cache, and no migration stream", () => {
  assert.equal(HIBERNATION_SWAP_UUID, SWAP_UUID);
  assert.equal(HIBERNATION_SWAP_VIRTUAL_BYTES, 1_610_612_736);
  const evidence = sourceEvidence();
  const profile = hibernationProfile({ evidence });
  const manifest = hibernationManifest(profile);
  assert.equal(isHibernationCheckpoint(profile), true);
  assert.equal(validateProductionManifest(manifest), manifest);
  assert.deepEqual(checkpointArgumentsForManifest(manifest), CANONICAL_HIBERNATION_ARGUMENTS);
  assert.equal(CANONICAL_HIBERNATION_ARGUMENTS.includes("-incoming"), false);
  assert.equal(CANONICAL_HIBERNATION_ARGUMENTS.some((value) => value.includes(profile.rootDelta.mountPath)), true);
  assert.equal(CANONICAL_HIBERNATION_ARGUMENTS.some((value) => value.includes(profile.swapImage.mountPath)), true);

  const plan = checkpointCachePlan(manifest);
  assert.deepEqual(Object.keys(plan), ["rootfs", "rootDelta", "swapImage"]);
  assert.equal(Object.values(plan).reduce((total, entry) => total + entry.maxCachedBytes, 0), 128 * 1024 * 1024);
  assert.deepEqual(Object.values(plan).map(({ maxCachedBytes }) => maxCachedBytes), [64, 32, 32].map((mib) => mib * 1024 * 1024));

  const producer = hibernationProducer(profile, evidence);
  assert.equal(validateCheckpointProducerDocument(producer, profile), producer);
  const artifacts = new Map([
    [profile.rootDelta.artifactPath, { path: profile.rootDelta.artifactPath, bytes: profile.rootDelta.bytes, sha256: profile.rootDelta.sha256 }],
    [profile.swapImage.artifactPath, { path: profile.swapImage.artifactPath, bytes: profile.swapImage.bytes, sha256: profile.swapImage.sha256 }],
    [profile.derivedInitramfs.artifactPath, { path: profile.derivedInitramfs.artifactPath, bytes: profile.derivedInitramfs.bytes, sha256: profile.derivedInitramfs.sha256 }],
    [profile.producer.manifestArtifactPath, { path: profile.producer.manifestArtifactPath, bytes: profile.producer.manifestBytes, sha256: profile.producer.manifestSha256 }],
    ["guest-manifest.json", { path: "guest-manifest.json", bytes: 1, sha256: profile.identity.baseGuestManifestSha256 }],
    ["rootfs.ext4", { path: "rootfs.ext4", bytes: 1, sha256: profile.identity.rootfsSha256 }],
    ["provenance.json", { path: "provenance.json", bytes: 1, sha256: profile.identity.guestProvenanceSha256 }],
    ["vmlinuz-linux", { path: "vmlinuz-linux", bytes: 1, sha256: profile.identity.kernelSha256 }],
    ["initramfs-linux.img", { path: "initramfs-linux.img", bytes: 1, sha256: profile.identity.baseInitramfsSha256 }],
    ["qemu.wasm", { path: "qemu.wasm", bytes: 1, sha256: profile.identity.browserQemuWasmSha256 }],
  ]);
  const bound = validateCheckpointArtifacts(manifest, artifacts);
  assert.equal(bound.rootDelta.path, profile.rootDelta.artifactPath);
  assert.equal(bound.swapImage.path, profile.swapImage.artifactPath);
  assert.equal(bound.initramfs.path, profile.derivedInitramfs.artifactPath);

  const hostile = hibernationManifest(structuredClone(profile));
  hostile.checkpoint.swapImage.swapUuid = "11111111-2222-4333-8444-555555555555";
  assert.throws(
    () => validateProductionManifest(hostile),
    (error) => error instanceof ProductionWorkerError && error.code === "INVALID_RUNTIME_MANIFEST",
  );
});

test("hibernation resume gate accepts only ordered kernel proof plus the nonce-bound post-GPU marker", async () => {
  assert.equal(parseHibernationReportLine("ordinary serial"), null);
  const marker = resumeMarker();
  const rendererReport = {
    schemaVersion: 1,
    renderNode: "/dev/dri/renderD128",
    renderer: "virgl (llvmpipe (LLVM 20.1.8, 256 bits))",
    vendor: "Mesa",
    version: "4.6 (Core Profile) Mesa 26.2.0",
  };
  assert.deepEqual(
    parseRendererReportLine(`OMARCHY_RENDERER_REPORT ${JSON.stringify(rendererReport)}`),
    rendererReport,
  );
  assert.deepEqual(
    parseHibernationReportLine(`OMARCHY_HIBERNATION_REPORT ${JSON.stringify(marker)}\r\n`),
    marker,
  );

  let timerCallback;
  let cleared = false;
  const failures = [];
  const profile = hibernationProfile();
  const gate = new HibernationResumeGate({
    checkpoint: profile,
    scope: {
      crypto: globalThis.crypto,
      setTimeout(callback) { timerCallback = callback; return 1; },
      clearTimeout() { cleared = true; },
    },
    onFailure: (error) => failures.push(error),
  });
  gate.begin();
  assert.equal(gate.handleSerialLine("PM: Image signature found, resuming"), true);
  assert.equal(gate.handleSerialLine("PM: Image loading done"), true);
  assert.equal(gate.handleSerialLine("PM: Image successfully loaded"), true);
  assert.equal(gate.handleSerialLine("PM: hibernation: hibernation exit"), true);
  assert.equal(gate.handleSerialLine(`OMARCHY_RENDERER_REPORT ${JSON.stringify(rendererReport)}`), true);
  assert.equal(gate.handleSerialLine(`OMARCHY_HIBERNATION_REPORT ${JSON.stringify(marker)}`), true);
  const evidence = await gate.wait();
  assert.equal(Object.hasOwn(evidence, "marker"), false);
  assert.deepEqual(evidence.kernelEvidence, [
    "PM: Image signature found, resuming",
    "PM: Image loading done",
    "PM: Image successfully loaded",
    "PM: hibernation: hibernation exit",
  ]);
  assert.equal(Object.hasOwn(evidence, "rendererReport"), false);
  assert.equal(
    evidence.rendererReportSha256,
    sha256(normalizedJsonBytes(rendererReport)),
  );
  assert.equal(gate.state, "ready");
  assert.equal(cleared, true);
  assert.deepEqual(failures, []);
  timerCallback();
  assert.deepEqual(failures, [], "a cleared timeout cannot fail an authenticated resume");
  assert.equal(
    gate.handleSerialLine(`OMARCHY_HIBERNATION_REPORT ${JSON.stringify(marker)}`),
    true,
  );
  assert.equal(gate.state, "failed", "duplicate authenticated markers fail closed");
  assert.equal(failures[0].code, "HIBERNATION_REPORT_INVALID");

  const coldFailures = [];
  const cold = new HibernationResumeGate({
    checkpoint: profile,
    scope: { crypto: globalThis.crypto, setTimeout() { return 1; }, clearTimeout() {} },
    onFailure: (error) => coldFailures.push(error),
  });
  cold.begin();
  assert.equal(cold.handleSerialLine("OMARCHY_GUEST_STAGE {\"schemaVersion\":1}"), true);
  await assert.rejects(cold.wait(), (error) => error.code === "HIBERNATION_COLD_BOOT_FALLBACK");
  assert.equal(coldFailures[0].code, "HIBERNATION_COLD_BOOT_FALLBACK");

  const duplicateKernel = new HibernationResumeGate({
    checkpoint: profile,
    scope: { crypto: globalThis.crypto, setTimeout() { return 1; }, clearTimeout() {} },
  });
  duplicateKernel.begin();
  assert.equal(duplicateKernel.handleSerialLine(
    "PM: Image signature found, resuming PM: Image signature found, resuming",
  ), true);
  await assert.rejects(
    duplicateKernel.wait(),
    (error) => error.code === "HIBERNATION_RESUME_EVIDENCE_INVALID",
  );

  let timeoutCallback;
  const timeoutFailures = [];
  const timedOut = new HibernationResumeGate({
    checkpoint: profile,
    scope: {
      crypto: globalThis.crypto,
      setTimeout(callback) { timeoutCallback = callback; return 1; },
      clearTimeout() {},
    },
    onFailure: (error) => timeoutFailures.push(error),
  });
  timedOut.begin();
  timeoutCallback();
  await assert.rejects(
    timedOut.wait(),
    (error) => error.code === "HIBERNATION_RESUME_TIMEOUT",
  );
  assert.equal(timedOut.state, "failed");
  assert.equal(timeoutFailures.length, 1);
});

test("hibernation resume gate never exposes nonce-bearing serial input in failures", async () => {
  const enterLine = `OMARCHY_HIBERNATION_ENTER ${JSON.stringify({
    schemaVersion: 1,
    nonce: NONCE,
    sourceBootId: SOURCE_BOOT_ID,
    swapUuid: SWAP_UUID,
    gpuBoundAtHibernate: false,
  })}`;
  const markerLine = `OMARCHY_HIBERNATION_REPORT ${JSON.stringify(resumeMarker())}`;
  const rendererLine = `OMARCHY_RENDERER_REPORT ${JSON.stringify({
    schemaVersion: 1,
    renderNode: "/dev/dri/renderD128",
    renderer: "virgl (llvmpipe (LLVM 20.1.8, 256 bits))",
    vendor: "Mesa",
    version: "4.6 (Core Profile) Mesa 26.2.0",
  })}`;
  const profile = hibernationProfile();
  const scope = {
    crypto: globalThis.crypto,
    setTimeout() { return 1; },
    clearTimeout() {},
  };
  const waitForFailure = async (gate) => {
    let timeout;
    const outcome = await Promise.race([
      gate.wait().then(
        () => ({ status: "resolved" }),
        (error) => ({ status: "rejected", error }),
      ),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve({ status: "timeout" }), 250);
      }),
    ]);
    clearTimeout(timeout);
    assert.equal(outcome.status, "rejected", "resume-gate rejection must be bounded");
    return outcome.error;
  };
  const assertSanitizedFailure = async (feed) => {
    const failures = [];
    const gate = new HibernationResumeGate({
      checkpoint: profile,
      scope,
      onFailure: (error) => failures.push(error),
    });
    gate.begin();
    feed(gate);
    await waitForFailure(gate);
    assert.equal(failures.length, 1);
    const serialized = JSON.stringify(serializeError(failures[0]));
    assert.equal(serialized.includes(NONCE), false);
    assert.equal(serialized.includes(markerLine), false);
    assert.equal(Object.hasOwn(failures[0], "details"), false);
    assert.equal(gate.handleSerialLine(markerLine), true);
    assert.equal(gate.handleSerialLine(rendererLine), true);
    assert.equal(gate.handleSerialLine(enterLine), true);
    assert.equal(
      failures.length,
      1,
      "replayed control records remain consumed without new public diagnostics",
    );
  };

  await assertSanitizedFailure((gate) => gate.handleSerialLine(enterLine));
  await assertSanitizedFailure((gate) => gate.handleSerialLine(markerLine));
  await assertSanitizedFailure((gate) => gate.handleSerialLine(
    `PM: Image signature found, resuming ${markerLine}`,
  ));
  await assertSanitizedFailure((gate) => gate.handleSerialLine(
    `PM: Image signature found, resuming ${rendererLine}`,
  ));
  await assertSanitizedFailure((gate) => gate.handleSerialLine(
    `PM: Image signature found, resuming OMARCHY_HIBERNATION_COLD_BOOT {"nonce":"${NONCE}"}`,
  ));
  await assertSanitizedFailure((gate) => gate.handleSerialLine(
    `PM: Image signature found, resuming OMARCHY_HIBERNATION_FAILURE ${NONCE}`,
  ));
  await assertSanitizedFailure((gate) => gate.handleSerialLine(
    `OMARCHY_HIBERNATION_FAILURE ${NONCE}`,
  ));
  await assertSanitizedFailure((gate) => {
    gate.handleSerialLine("PM: Image signature found, resuming");
    gate.handleSerialLine("PM: Image loading done");
    gate.handleSerialLine("PM: Image successfully loaded");
    gate.handleSerialLine("PM: hibernation: hibernation exit");
    gate.handleSerialLine(rendererLine);
    gate.handleSerialLine(`OMARCHY_HIBERNATION_REPORT {"nonce":"${NONCE}",`);
  });

  const idleFailures = [];
  const idle = new HibernationResumeGate({
    checkpoint: profile,
    scope,
    onFailure: (error) => idleFailures.push(error),
  });
  assert.equal(idle.handleSerialLine(enterLine), true);
  await waitForFailure(idle);
  assert.equal(idleFailures.length, 1);
  assert.equal(JSON.stringify(serializeError(idleFailures[0])).includes(NONCE), false);
  assert.equal(idle.handleSerialLine(enterLine), true);
  assert.equal(idleFailures.length, 1);
});

test("runtime manifest packaging authenticates the complete hibernation set and refuses mutation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-hibernation-package-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const guestDirectory = join(root, "guest");
  await mkdir(guestDirectory);
  const baseManifestPath = new URL("../config/virgl-webgl2.json", import.meta.url);
  const qemuWasmPath = join(root, "qemu.wasm");
  const files = {
    "rootfs.ext4": Buffer.from("rootfs"),
    "provenance.json": Buffer.from("provenance"),
    "vmlinuz-linux": Buffer.from("kernel"),
    "initramfs-linux.img": Buffer.from("initramfs-with-resume-hook"),
    "initramfs-virgl-hibernate.img": Buffer.from("derived-initramfs-with-resume-hook-and-virgl"),
    "hibernate-root-overlay.qcow2": Buffer.from("qcow2-root-delta"),
    "omarchy-hibernate.qcow2": Buffer.from("qcow2-hibernation-swap"),
  };
  const wasm = Buffer.from("virgl browser qemu wasm");
  await writeFile(qemuWasmPath, wasm);
  await Promise.all(Object.entries(files).map(([path, bytes]) => writeFile(join(guestDirectory, path), bytes)));
  const upstream = {
    repository: "https://github.com/basecamp/omarchy",
    commit: "a".repeat(40),
    version: "4.0.0.alpha",
    treeSha256: "b".repeat(64),
  };
  const guestManifestBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    upstream,
    artifacts: ["rootfs.ext4", "provenance.json", "vmlinuz-linux", "initramfs-linux.img"].map((path) => ({
      path,
      bytes: files[path].byteLength,
      sha256: sha256(files[path]),
    })),
  }));
  await writeFile(join(guestDirectory, "guest-manifest.json"), guestManifestBytes);
  const evidence = sourceEvidence();
  const profile = hibernationProfile({
    baseGuestManifestSha256: sha256(guestManifestBytes),
    browserQemuWasmSha256: sha256(wasm),
    rootfsSha256: sha256(files["rootfs.ext4"]),
    guestProvenanceSha256: sha256(files["provenance.json"]),
    kernelSha256: sha256(files["vmlinuz-linux"]),
    baseInitramfsSha256: sha256(files["initramfs-linux.img"]),
    derivedInitramfsSha256: sha256(files["initramfs-virgl-hibernate.img"]),
    evidence,
  });
  profile.rootDelta.bytes = files["hibernate-root-overlay.qcow2"].byteLength;
  profile.rootDelta.sha256 = sha256(files["hibernate-root-overlay.qcow2"]);
  profile.swapImage.bytes = files["omarchy-hibernate.qcow2"].byteLength;
  profile.swapImage.sha256 = sha256(files["omarchy-hibernate.qcow2"]);
  profile.derivedInitramfs.bytes = files["initramfs-virgl-hibernate.img"].byteLength;
  profile.derivedInitramfs.sha256 = sha256(files["initramfs-virgl-hibernate.img"]);
  const producer = hibernationProducer(profile, evidence);
  const producerBytes = Buffer.from(`${JSON.stringify(producer)}\n`);
  await writeFile(join(guestDirectory, "hibernate-manifest.json"), producerBytes);

  assert.equal(validateHibernationProducerManifest(producer), producer);
  const result = await buildRuntimeManifest({ baseManifestPath, guestDirectory, qemuWasmPath });
  assert.equal(result.mode, "hibernation");
  assert.equal(result.manifest.checkpoint.mode, "guest-hibernation-resume");
  assert.equal(result.manifest.checkpoint.producer.manifestSha256, sha256(producerBytes));
  assert.equal(result.manifest.qemu.arguments.includes("-incoming"), false);
  assert.equal(
    result.manifest.qemu.arguments[result.manifest.qemu.arguments.indexOf("-append") + 1],
    profile.restoreContract.targetKernelCommandLine,
  );

  await assert.rejects(
    buildRuntimeManifest({ baseManifestPath, guestDirectory, qemuWasmPath, forceCold: true }),
    /force-cold packaging refuses to ignore any guest-hibernation artifact/,
  );
  await rm(join(guestDirectory, "hibernate-manifest.json"));
  await assert.rejects(
    buildRuntimeManifest({ baseManifestPath, guestDirectory, qemuWasmPath, forceCold: true }),
    /force-cold packaging refuses to ignore any guest-hibernation artifact/,
  );
  await writeFile(join(guestDirectory, "hibernate-manifest.json"), producerBytes);

  await writeFile(join(guestDirectory, "omarchy-hibernate.qcow2"), "mutated swap image");
  await assert.rejects(
    buildRuntimeManifest({ baseManifestPath, guestDirectory, qemuWasmPath }),
    /hibernation swap image differs from hibernate-manifest\.json/,
  );
});

async function writeArtifact(root, path, body, role = "fixture", mediaType = "application/octet-stream") {
  const bytes = Buffer.from(body);
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), bytes);
  return { path, role, mediaType, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

test("full-guest release exposes root delta and swap only through authenticated strict ranges", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-hibernation-release-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, "runtime");
  const guestRoot = join(root, "guest");
  await Promise.all([mkdir(runtimeRoot), mkdir(guestRoot)]);
  const rootfs = await writeArtifact(guestRoot, "rootfs.ext4", "rootfs", "guest-rootfs");
  const derivedInitramfs = await writeArtifact(
    guestRoot,
    "initramfs-virgl-hibernate.img",
    "derived-initramfs",
  );
  const rootDelta = await writeArtifact(guestRoot, "hibernate-root-overlay.qcow2", "root-delta");
  const swapImage = await writeArtifact(guestRoot, "omarchy-hibernate.qcow2", "swap-image");
  const producer = await writeArtifact(guestRoot, "hibernate-manifest.json", "{}\n", "metadata", "application/json");
  await writeFile(join(guestRoot, "guest-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    upstream: { repository: "r", commit: "a".repeat(40), version: "v", license: "MIT", treeSha256: "b".repeat(64) },
    artifacts: [rootfs],
  })}\n`);
  const runtimeManifest = {
    schemaVersion: 2,
    guest: { rootfs: { artifactPath: rootfs.path } },
    checkpoint: {
      mode: "guest-hibernation-resume",
      derivedInitramfs: {
        artifactPath: derivedInitramfs.path,
        bytes: derivedInitramfs.bytes,
        sha256: derivedInitramfs.sha256,
      },
      rootDelta: { artifactPath: rootDelta.path, bytes: rootDelta.bytes, sha256: rootDelta.sha256 },
      swapImage: { artifactPath: swapImage.path, bytes: swapImage.bytes, sha256: swapImage.sha256 },
      producer: { manifestArtifactPath: producer.path, manifestBytes: producer.bytes, manifestSha256: producer.sha256 },
    },
  };
  await writeFile(join(runtimeRoot, "runtime-manifest.json"), `${JSON.stringify(runtimeManifest)}\n`);
  await writeFile(join(runtimeRoot, "runtime-build.json"), `${JSON.stringify({ schemaVersion: 1, artifacts: [] })}\n`);

  const release = await buildFullGuestRelease({ runtimeRoot, guestRoot });
  assert.equal(release.strictRangePaths.has(rootDelta.path), true);
  assert.equal(release.strictRangePaths.has(swapImage.path), true);
  assert.equal(release.strictRangePaths.has(producer.path), false);
  assert.equal(release.strictRangePaths.has(derivedInitramfs.path), false);
  assert.equal(release.entries.get(derivedInitramfs.path).artifact.role, "hibernation-initramfs");
  assert.equal(
    release.entries.get(derivedInitramfs.path).artifact.mediaType,
    "application/vnd.linux.initramfs",
  );
  assert.equal(release.entries.get(rootDelta.path).artifact.role, "hibernation-root-delta");
  assert.equal(release.entries.get(swapImage.path).artifact.role, "hibernation-swap-image");
  assert.equal(release.entries.has("omarchy-preboot.vmstate"), false);
});

test("package and verifier source recognize hibernation without mutating generated artifacts", async () => {
  const [packageSource, verifierSource, workerSource] = await Promise.all([
    readFile(new URL("../scripts/package-guest.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/verify-runtime-artifacts.mjs", import.meta.url), "utf8"),
    readFile(new URL("../web/production-worker.mjs", import.meta.url), "utf8"),
  ]);
  for (const source of [packageSource, verifierSource]) {
    assert.match(source, /guest-hibernation-resume/);
    assert.match(source, /hibernate-root-overlay\.qcow2/);
    assert.match(source, /omarchy-hibernate\.qcow2/);
  }
  assert.match(verifierSource, /OMARCHY_HIBERNATION_REPORT/);
  assert.match(workerSource, /const HIBERNATION_RESUME_TIMEOUT_MS = 600_000;/);
  assert.match(workerSource, /const HIBERNATION_GUEST_REPORT_TIMEOUT_MS = 900_000;/);
  assert.match(verifierSource, /HIBERNATION_RESUME_TIMEOUT_MS = 600_000/);
  assert.match(verifierSource, /HIBERNATION_GUEST_REPORT_TIMEOUT_MS = 900_000/);
  const deferredFlush = workerSource.indexOf(
    "const deferredEvidence = this.#deferredHibernationEvidence.splice(0)",
  );
  const deferredFailureGuard = workerSource.indexOf(
    'if (this.#phase === "failed") {',
    deferredFlush,
  );
  const runningTransition = workerSource.indexOf('this.#setPhase("running")', deferredFlush);
  assert.ok(deferredFlush >= 0 && deferredFailureGuard > deferredFlush);
  assert.ok(
    runningTransition > deferredFailureGuard,
    "deferred evidence failure must be terminal before the running transition",
  );
  assert.match(
    workerSource,
    /if \(this\.#phase === "failed" \|\| this\.#phase === "exited"\) return false;/,
    "terminal Worker phases must be irreversible",
  );
});
