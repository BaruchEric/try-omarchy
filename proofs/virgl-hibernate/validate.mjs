#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseUniqueDiagnosticMarker } from "../../scripts/verification/diagnostic-markers.mjs";

const [guestDirectory, evidenceDirectory, browserQemuWasmPath] = process.argv.slice(2);
if (!guestDirectory || !evidenceDirectory || !browserQemuWasmPath) {
  throw new Error("usage: validate.mjs GUEST_DIST EVIDENCE_DIRECTORY BROWSER_QEMU_WASM");
}

const expected = Object.freeze({
  guestManifest: "cabfbb1148ea0cfafd62fccc8ff877ec3dcec09d6af6832624f7e20c27f9df97",
  rootfs: "f03468dd6d0264e80d496188d72dc82501731807e3833acd3842392b4174d2d8",
  kernel: "1f2572d6d03706ed0f818ee17d77df021b7875f4e9fd119a1157f3a208aeed73",
  initramfs: "73c801fdb121254663483f9befd5c902ec7a8b9a14c4e2080323104c6bb7ea4e",
  provenance: "771a12039baff3cf5034442496d0f47e345c2e3e394b49f6c30ed8d9753d6b38",
  qemuCommit: "0ef7b4e2814b231705d8371dd7997f5b72e70baf",
  swapUuid: "4c9a13d2-7c3a-4f2c-b6e1-5a3048610e8f",
});

const evidencePath = (name) => path.join(evidenceDirectory, name);
const guestPath = (name) => path.join(guestDirectory, name);
const bytes = async (name) => readFile(evidencePath(name));
const text = async (name) => readFile(evidencePath(name), "utf8");
const json = async (name) => JSON.parse(await text(name));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const hashFile = (file) => new Promise((resolve, reject) => {
  const hash = createHash("sha256");
  const stream = createReadStream(file);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("error", reject);
  stream.on("end", () => resolve(hash.digest("hex")));
});
const fileDigest = async (name) => hashFile(evidencePath(name));
const guestDigest = async (name) => hashFile(guestPath(name));
const invariant = (condition, message, details = undefined) => {
  if (!condition) throw new Error(details === undefined ? message : `${message}: ${JSON.stringify(details)}`);
};
const exactKeys = (value, keys, label) => {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} keys differ`);
};
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
};
const normalizedJsonDigest = (value) => digest(Buffer.from(JSON.stringify(canonicalize(value)), "utf8"));
const oneMarker = parseUniqueDiagnosticMarker;
const VIRTIO_QUEUE_INDEX_MODULUS = 0x1_0000;
const VIRTIO_DRIVER_OK = "VIRTIO_CONFIG_S_DRIVER_OK: Driver setup and ready";
const queueIndexDelta = (before, after, label) => {
  invariant(
    Number.isInteger(before) && before >= 0 && before < VIRTIO_QUEUE_INDEX_MODULUS &&
      Number.isInteger(after) && after >= 0 && after < VIRTIO_QUEUE_INDEX_MODULUS,
    `${label} contains invalid Virtio queue indices`,
    { before, after },
  );
  return (after - before + VIRTIO_QUEUE_INDEX_MODULUS) % VIRTIO_QUEUE_INDEX_MODULUS;
};
const queueProgress = (before, after, label) => ({
  lastAvailDelta: queueIndexDelta(before["last-avail-idx"], after["last-avail-idx"], `${label} available`),
  usedDelta: queueIndexDelta(before["used-idx"], after["used-idx"], `${label} used`),
});
const assertQueueProgress = (before, after, recorded, expected, label) => {
  exactKeys(recorded, ["lastAvailDelta", "usedDelta"], `${label} progress`);
  const recomputed = queueProgress(before, after, label);
  assert.deepEqual(recorded, recomputed, `${label} recorded progress differs from its queue snapshots`);
  assert.deepEqual(recomputed, { lastAvailDelta: expected, usedDelta: expected },
    `${label} did not consume exactly ${expected} Virtio descriptors`);
};
const explicitKeyEvent = (code, down) => ({
  type: "key",
  data: {
    down,
    key: { type: "qcode", data: code },
  },
});
const assertLiveVirtioQueue = (queue, label) => {
  assert.equal(queue.name, "virtio-input", `${label} name differs`);
  assert.equal(queue["queue-index"], 0, `${label} is not the event queue`);
  assert.equal(queue["vring-num"], 64, `${label} ring size differs`);
  for (const field of ["last-avail-idx", "used-idx"]) {
    invariant(
      Number.isInteger(queue[field]) && queue[field] >= 0 && queue[field] < VIRTIO_QUEUE_INDEX_MODULUS,
      `${label} has an invalid ${field}`,
      queue,
    );
  }
  for (const field of ["vring-desc", "vring-avail", "vring-used"]) {
    invariant(Number.isSafeInteger(queue[field]) && queue[field] > 0,
      `${label} has no live ${field}`, queue);
  }
};
const assertLiveVirtioInput = (device) => {
  const { status } = device;
  invariant(typeof device.path === "string" && device.path.length > 0,
    "Virtio input proof has an invalid device path", device);
  assert.equal(status.name, "virtio-input");
  assert.equal(status.started, true);
  assert.equal(status["vm-running"], true);
  assert.equal(status.broken, false);
  assert.equal(status.disabled, false);
  invariant(Array.isArray(status.status?.statuses) && status.status.statuses.includes(VIRTIO_DRIVER_OK),
    "Virtio input device is not DRIVER_OK", { path: device.path, status });
  for (const [label, queue] of [
    ["before probe", device.queueBeforeProbe],
    ["after probe", device.queueAfterProbe],
  ]) {
    assertLiveVirtioQueue(queue, `${device.path} ${label}`);
  }
};

const [manifest, run, sourceLog, targetLog, sourceCommand, targetCommand] = await Promise.all([
  json("hibernate-manifest.json"),
  json("run.json"),
  text("source-diagnostics.log"),
  text("target-diagnostics.log"),
  text("source-command.txt"),
  text("target-command.txt"),
]);

assert.equal(await guestDigest("guest-manifest.json"), expected.guestManifest);
assert.equal(await guestDigest("rootfs.ext4"), expected.rootfs);
assert.equal(await guestDigest("vmlinuz-linux"), expected.kernel);
assert.equal(await guestDigest("initramfs-linux.img"), expected.initramfs);
assert.equal(await guestDigest("provenance.json"), expected.provenance);
const browserQemuWasmSha256 = await hashFile(browserQemuWasmPath);

exactKeys(manifest, [
  "schemaVersion", "kind", "derivedInitramfs", "rootDelta", "swapImage", "producer",
  "identity", "qemu", "producerMachine", "runtimeMachine", "restoreContract",
  "sourceEvidence", "resumeEvidence",
], "producer manifest");
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.kind, "omarchy-web-guest-hibernation");
assert.equal(manifest.identity.baseGuestManifestSha256, expected.guestManifest);
assert.equal(manifest.identity.rootfsSha256, expected.rootfs);
assert.equal(manifest.identity.kernelSha256, expected.kernel);
assert.equal(manifest.identity.baseInitramfsSha256, expected.initramfs);
assert.equal(manifest.identity.guestProvenanceSha256, expected.provenance);
assert.equal(manifest.identity.browserQemuWasmSha256, browserQemuWasmSha256);
assert.deepEqual(manifest.qemu, {
  repository: "https://github.com/ktock/qemu-wasm.git",
  version: "8.2.0",
  sourceCommit: expected.qemuCommit,
});
assert.equal(manifest.producer.qemuBinarySha256, run.qemuSha256);

const blockDevices = [
  { driveId: "omarchy-hibernate-root", device: "virtio-blk-pci", serial: "omarchy-root", role: "root", format: "qcow2" },
  { driveId: "omarchy-hibernate-swap", device: "virtio-blk-pci", serial: "omarchy-resume", role: "resume", format: "qcow2" },
];
const machineCommon = {
  type: "pc-q35-8.2,i8042=off",
  cpu: "qemu64",
  memoryMiB: 1024,
  smp: "2,sockets=1,cores=2,threads=1",
  accel: "tcg,tb-size=128,thread=multi",
  displayDevice: "virtio-vga-gl,max_outputs=1,xres=1600,yres=900",
  blockDevices,
};
assert.deepEqual(manifest.producerMachine, {
  ...machineCommon,
  display: "sdl,gl=on,show-cursor=on,full-screen=on",
});
assert.deepEqual(manifest.runtimeMachine, {
  ...machineCommon,
  display: "sdl,gl=es,show-cursor=on",
});

for (const [field, name, cap] of [
  ["rootDelta", "hibernate-root-overlay.qcow2", 256 * 1024 * 1024],
  ["swapImage", "omarchy-hibernate.qcow2", 1024 * 1024 * 1024],
  ["derivedInitramfs", "initramfs-virgl-hibernate.img", 64 * 1024 * 1024],
]) {
  const descriptor = manifest[field];
  assert.equal(descriptor[field === "derivedInitramfs" ? "artifactPath" : "path"], name);
  assert.equal(descriptor.bytes, (await stat(evidencePath(name))).size);
  assert.equal(descriptor.sha256, await fileDigest(name));
  invariant(descriptor.bytes <= cap, `${field} exceeds its artifact cap`);
}
assert.equal(manifest.rootDelta.format, "qcow2");
assert.equal(manifest.rootDelta.backingFilename, "rootfs.ext4");
assert.equal(manifest.rootDelta.backingFormat, "raw");
assert.equal(manifest.swapImage.format, "qcow2");
assert.equal(Object.hasOwn(manifest.swapImage, "backingFilename"), false);
assert.equal(manifest.swapImage.virtualBytes, 1610612736);
assert.equal(manifest.swapImage.swapUuid, expected.swapUuid);
assert.equal(manifest.derivedInitramfs.format, "linux-initramfs");
assert.equal(manifest.derivedInitramfs.baseArtifactPath, "initramfs-linux.img");
assert.equal(manifest.identity.derivedInitramfsSha256, manifest.derivedInitramfs.sha256);

const [baseInitramfs, derivedInitramfs] = await Promise.all([
  readFile(guestPath("initramfs-linux.img")),
  bytes("initramfs-virgl-hibernate.img"),
]);
invariant(derivedInitramfs.length > baseInitramfs.length, "derived initramfs has no appended overlay");
assert.equal(
  Buffer.compare(derivedInitramfs.subarray(0, baseInitramfs.length), baseInitramfs),
  0,
  "derived initramfs does not preserve the canonical base prefix",
);
assert.deepEqual(
  [...derivedInitramfs.subarray(baseInitramfs.length, baseInitramfs.length + 4)],
  [0x28, 0xb5, 0x2f, 0xfd],
  "appended initramfs overlay is not a zstd frame",
);
assert.match(await text("initramfs-preparation.log"), /^VIRGL_HIBERNATE_INITRAMFS_PASS /m);

const rootInfo = await json("hibernate-root-overlay-info.json");
const swapInfo = await json("omarchy-hibernate-info.json");
assert.equal(rootInfo.format, "qcow2");
assert.equal(rootInfo["virtual-size"], 6442450944);
assert.equal(rootInfo["backing-filename"], "rootfs.ext4");
assert.equal(rootInfo["backing-filename-format"], "raw");
assert.equal(swapInfo.format, "qcow2");
assert.equal(swapInfo["virtual-size"], 1610612736);
assert.equal(swapInfo["backing-filename"], undefined);
assert.equal(
  await text("hibernation-artifacts-before-target.sha256"),
  await text("hibernation-artifacts-after-target.sha256"),
  "target -snapshot mutated immutable artifacts",
);

const enter = oneMarker(sourceLog, "OMARCHY_HIBERNATION_ENTER ");
const hibernation = oneMarker(targetLog, "OMARCHY_HIBERNATION_REPORT ");
const renderer = oneMarker(targetLog, "OMARCHY_RENDERER_REPORT ");
const guestReport = oneMarker(targetLog, "OMARCHY_GUEST_REPORT ");
exactKeys(enter, ["schemaVersion", "nonce", "sourceBootId", "swapUuid", "gpuBoundAtHibernate"], "entry marker");
exactKeys(hibernation, ["schemaVersion", "status", "nonce", "sourceBootId", "swapUuid", "gpuDriver", "renderNode", "renderer"], "resume marker");
exactKeys(renderer, ["schemaVersion", "renderNode", "renderer", "vendor", "version"], "renderer report");
assert.equal(enter.schemaVersion, 1);
assert.equal(enter.gpuBoundAtHibernate, false);
assert.equal(enter.swapUuid, expected.swapUuid);
assert.equal(hibernation.schemaVersion, 1);
assert.equal(hibernation.status, "resumed");
assert.equal(hibernation.nonce, enter.nonce);
assert.equal(hibernation.sourceBootId, enter.sourceBootId);
assert.equal(hibernation.swapUuid, expected.swapUuid);
assert.equal(hibernation.gpuDriver, "virtio_gpu");
assert.equal(hibernation.renderNode, "/dev/dri/renderD128");
assert.equal(hibernation.renderer, "virgl");
assert.match(renderer.renderer, /virgl/i);
assert.equal(renderer.renderNode, "/dev/dri/renderD128");
assert.doesNotMatch(sourceLog, /^OMARCHY_HIBERNATION_FAILURE /m);
assert.doesNotMatch(targetLog, /^OMARCHY_HIBERNATION_FAILURE /m);
assert.doesNotMatch(targetLog, /^OMARCHY_HIBERNATION_COLD_BOOT /m);

const requiredKernelEvidence = [
  "PM: Image signature found, resuming",
  "PM: Image loading done",
  "PM: Image successfully loaded",
  "PM: hibernation: hibernation exit",
];
let previous = -1;
for (const line of requiredKernelEvidence) {
  const index = targetLog.indexOf(line);
  invariant(index > previous, `required kernel evidence is missing or out of order: ${line}`);
  previous = index;
}
invariant(
  targetLog.indexOf("OMARCHY_HIBERNATION_REPORT ") < targetLog.indexOf("OMARCHY_GUEST_REPORT "),
  "fresh guest report preceded the authenticated resume marker",
);

exactKeys(manifest.sourceEvidence, [
  "diagnosticsSha256", "hibernationEntryMarkerSha256", "nonceSha256",
  "sourceBootId", "gpuBoundAtHibernate",
], "source evidence");
assert.deepEqual(manifest.sourceEvidence, {
  diagnosticsSha256: digest(sourceLog),
  hibernationEntryMarkerSha256: normalizedJsonDigest(enter),
  nonceSha256: digest(enter.nonce),
  sourceBootId: enter.sourceBootId,
  gpuBoundAtHibernate: false,
});
assert.equal(manifest.resumeEvidence.diagnosticsSha256, digest(targetLog));
assert.equal(manifest.resumeEvidence.hibernationMarkerSha256, normalizedJsonDigest(hibernation));
assert.equal(manifest.resumeEvidence.rendererProbeSha256, normalizedJsonDigest(renderer));
assert.equal(manifest.resumeEvidence.renderer, renderer.renderer);
assert.equal(manifest.resumeEvidence.normalizedGuestReportSha256, normalizedJsonDigest(guestReport));
for (const [field, name] of [
  ["reportValidationSha256", "target-report-validation.json"],
  ["desktopFrame1Sha256", "resumed-desktop-1.ppm"],
  ["desktopFrame1HealthSha256", "resumed-desktop-1-health.json"],
  ["desktopFrame2Sha256", "resumed-desktop-2.ppm"],
  ["desktopFrame2HealthSha256", "resumed-desktop-2-health.json"],
  ["footFrameSha256", "resumed-foot.ppm"],
  ["footFrameHealthSha256", "resumed-foot-health.json"],
  ["footChangeSha256", "resumed-foot-change.json"],
]) assert.equal(manifest.resumeEvidence[field], await fileDigest(name));
assert.equal(manifest.resumeEvidence.freshPostResumeInteraction, true);

assert.equal((await json("target-report-validation.json")).status, "PASS");
for (const name of ["resumed-desktop-1-health.json", "resumed-desktop-2-health.json", "resumed-foot-health.json"]) {
  const health = await json(name);
  assert.equal(health.clean, true, `${name} is not structurally healthy`);
  assert.equal(health.width, 1600);
  assert.equal(health.height, 900);
}
const captureKeys = [
  "schemaVersion", "captureMode", "stabilitySampleCount", "stabilitySampleSha256",
  "sourceFormat", "sourceBytes", "sourceSha256", "width", "height", "bitsPerPixel",
  "bytesPerLine", "byteOrder", "redMask", "greenMask", "blueMask", "windowName",
  "ppmBytes", "ppmSha256",
];
for (const stem of ["resumed-desktop-1", "resumed-desktop-2", "resumed-foot"]) {
  const capture = await json(`${stem}-capture.json`);
  exactKeys(capture, captureKeys, `${stem} capture metadata`);
  assert.equal(capture.schemaVersion, 1);
  assert.equal(capture.captureMode, "xvfb-fbdir-sigstop-copy-stable-pair");
  assert.equal(capture.stabilitySampleCount, 2);
  assert.deepEqual(capture.stabilitySampleSha256, [capture.sourceSha256, capture.sourceSha256]);
  assert.equal(capture.sourceFormat, "XWD-v7-ZPixmap");
  assert.equal(capture.sourceBytes, 5763232);
  assert.equal(capture.sourceBytes, (await stat(evidencePath(`${stem}.xwd`))).size);
  assert.equal(capture.sourceSha256, await fileDigest(`${stem}.xwd`));
  assert.equal(capture.width, 1600);
  assert.equal(capture.height, 900);
  assert.equal(capture.bitsPerPixel, 32);
  assert.equal(capture.bytesPerLine, 6400);
  assert.equal(capture.byteOrder, "LSBFirst");
  assert.equal(capture.redMask, 0x00ff0000);
  assert.equal(capture.greenMask, 0x0000ff00);
  assert.equal(capture.blueMask, 0x000000ff);
  assert.match(capture.windowName, /^Xvfb .+:\d+\.0$/);
  assert.equal(capture.ppmBytes, 4320016);
  assert.equal(capture.ppmBytes, (await stat(evidencePath(`${stem}.ppm`))).size);
  assert.equal(capture.ppmSha256, await fileDigest(`${stem}.ppm`));
}
const change = await json("resumed-foot-change.json");
assert.equal(change.status, "PASS");
assert.equal(change.mode, "minimum");
invariant(change.ratio >= 0.0005, "Foot frame change is below threshold");
assert.equal((await json("target-running-status.json")).status, "running");

const input = await json("target-virtio-super-return.json");
exactKeys(input, [
  "schemaVersion", "action", "keyCode", "vmStatus", "requestedHoldMilliseconds",
  "keyboardPath", "devices", "press", "release",
], "Virtio Super+Return proof");
assert.equal(input.schemaVersion, 1);
assert.equal(input.action, "virtio-super-return");
assert.equal(input.keyCode, "ret");
assert.equal(input.requestedHoldMilliseconds, 150);
assert.equal(input.vmStatus.status, "running");
assert.equal(input.vmStatus.running, true);
invariant(Array.isArray(input.devices) && input.devices.length === 2,
  "Virtio input proof must contain exactly keyboard and tablet", input.devices);
assert.equal(new Set(input.devices.map(({ path: devicePath }) => devicePath)).size, 2,
  "Virtio input proof device paths are not unique");
for (const device of input.devices) {
  exactKeys(device, ["path", "status", "queueBeforeProbe", "queueAfterProbe", "probeProgress"],
    `Virtio input device ${device.path}`);
  assertLiveVirtioInput(device);
}
const keyboard = input.devices.find(({ path: devicePath }) => devicePath === input.keyboardPath);
invariant(keyboard !== undefined, "Virtio keyboard path does not identify one recorded device", input.keyboardPath);
const nonKeyboard = input.devices.find(({ path: devicePath }) => devicePath !== input.keyboardPath);
assertQueueProgress(
  keyboard.queueBeforeProbe,
  keyboard.queueAfterProbe,
  keyboard.probeProgress,
  9,
  "Virtio keyboard modifier-release probe",
);
assertQueueProgress(
  nonKeyboard.queueBeforeProbe,
  nonKeyboard.queueAfterProbe,
  nonKeyboard.probeProgress,
  0,
  "non-keyboard Virtio input isolation probe",
);
for (const [label, report, events] of [
  ["press", input.press, [explicitKeyEvent("meta_l", true), explicitKeyEvent("ret", true)]],
  ["release", input.release, [explicitKeyEvent("ret", false), explicitKeyEvent("meta_l", false)]],
]) {
  exactKeys(report, ["events", "queueBefore", "queueAfter", "progress"],
    `Virtio Super+Return ${label}`);
  assert.deepEqual(report.events, events, `Virtio Super+Return ${label} events differ`);
  assertLiveVirtioQueue(report.queueBefore, `Virtio Super+Return ${label} queue before`);
  assertLiveVirtioQueue(report.queueAfter, `Virtio Super+Return ${label} queue after`);
  assertQueueProgress(report.queueBefore, report.queueAfter, report.progress, 3,
    `Virtio Super+Return ${label}`);
}
assert.deepEqual(input.press.queueBefore, keyboard.queueAfterProbe,
  "Virtio Super+Return press does not continue from the proven keyboard queue");
assert.deepEqual(input.release.queueBefore, input.press.queueAfter,
  "Virtio Super+Return release does not continue from the press queue");
for (const field of ["vring-desc", "vring-avail", "vring-used"]) {
  const expectedAddress = keyboard.queueBeforeProbe[field];
  for (const [label, queue] of [
    ["keyboard after probe", keyboard.queueAfterProbe],
    ["press before", input.press.queueBefore],
    ["press after", input.press.queueAfter],
    ["release before", input.release.queueBefore],
    ["release after", input.release.queueAfter],
  ]) {
    assert.equal(queue[field], expectedAddress,
      `Virtio keyboard ${field} changed at ${label}`);
  }
}

// The runner records an executable shell reconstruction with Bash `printf %q`.
// Bash escapes commas in QEMU's comma-delimited option arguments, so normalize
// that lossless presentation detail before checking the exact argument tokens.
const normalizedSourceCommand = sourceCommand.replaceAll("\\,", ",");
const normalizedTargetCommand = targetCommand.replaceAll("\\,", ",");
for (const command of [normalizedSourceCommand, normalizedTargetCommand]) {
  for (const token of [
    "SDL_VIDEO_X11_WINDOW_VISUALID=0x3b7",
    "-machine pc-q35-8.2,i8042=off", "-cpu qemu64", "-m 1024M",
    "-accel tcg,tb-size=128,thread=multi", "-smp 2,sockets=1,cores=2,threads=1",
    "-display sdl,gl=on,show-cursor=on,full-screen=on",
    "-device virtio-vga-gl,max_outputs=1,xres=1600,yres=900",
    "ignore_loglevel", "hibernate.compressor=lzo",
    "id=omarchy-hibernate-root", "drive=omarchy-hibernate-root,serial=omarchy-root",
    "id=omarchy-hibernate-swap", "drive=omarchy-hibernate-swap,serial=omarchy-resume",
  ]) invariant(command.includes(token), `recorded command is missing ${token}`);
  invariant(!command.includes("-incoming"), "hibernation restore must not use QEMU incoming migration");
  invariant(command.indexOf("id=omarchy-hibernate-root") < command.indexOf("drive=omarchy-hibernate-root,serial=omarchy-root"));
  invariant(command.indexOf("drive=omarchy-hibernate-root,serial=omarchy-root") < command.indexOf("id=omarchy-hibernate-swap"));
  invariant(command.indexOf("id=omarchy-hibernate-swap") < command.indexOf("drive=omarchy-hibernate-swap,serial=omarchy-resume"));
}
assert.doesNotMatch(normalizedSourceCommand, /(^| )-snapshot( |$)/);
assert.match(normalizedSourceCommand, /omarchy\.hibernate_producer=1/);
assert.match(normalizedSourceCommand, new RegExp(`omarchy\\.hibernate_nonce=${enter.nonce}`));
assert.match(normalizedTargetCommand, /(^| )-snapshot( |$)/);
assert.match(normalizedTargetCommand, /omarchy\.hibernate_target=1/);
assert.doesNotMatch(normalizedTargetCommand, /omarchy\.hibernate_producer=1/);

const baseKernelCommandLine = [
  "root=/dev/vda", "rw", "rootwait", "console=tty0", "console=ttyS0,115200n8",
  "loglevel=4", "systemd.show_status=false", "rd.systemd.show_status=false", "mitigations=off",
  "nowatchdog", "omarchy.web_demo=1", `resume=UUID=${expected.swapUuid}`, "ignore_loglevel",
  "hibernate.compressor=lzo", `omarchy.hibernate_swap_uuid=${expected.swapUuid}`,
].join(" ");
const expectedSourceKernelCommandLine = `${baseKernelCommandLine} omarchy.hibernate_producer=1 omarchy.hibernate_nonce=${enter.nonce}`;
const expectedTargetKernelCommandLine = `${baseKernelCommandLine} omarchy.hibernate_target=1`;
exactKeys(manifest.restoreContract, [
  "coldBootFallbackAllowed", "disposableWrites", "gpuBoundAtHibernate", "kernelCommandLineBase",
  "resumeNonceSha256", "sourceBootId", "sourceEvidenceSha256",
  "sourceKernelCommandLineRedacted", "sourceKernelCommandLineSha256",
  "targetKernelCommandLine", "runtimeDisplay", "virtioGpuLoadedAfterResume",
], "restore contract");
assert.equal(manifest.restoreContract.coldBootFallbackAllowed, false);
assert.equal(
  manifest.restoreContract.disposableWrites,
  "target -snapshot layers over immutable root delta and hibernation image",
);
assert.equal(manifest.restoreContract.gpuBoundAtHibernate, false);
assert.equal(manifest.restoreContract.kernelCommandLineBase, baseKernelCommandLine);
assert.equal(manifest.restoreContract.resumeNonceSha256, digest(enter.nonce));
assert.equal(manifest.restoreContract.sourceBootId, enter.sourceBootId);
assert.equal(
  manifest.restoreContract.sourceEvidenceSha256,
  normalizedJsonDigest(manifest.sourceEvidence),
);
assert.equal(
  manifest.restoreContract.sourceKernelCommandLineRedacted,
  `${baseKernelCommandLine} omarchy.hibernate_producer=1 omarchy.hibernate_nonce=<redacted>`,
);
assert.equal(
  manifest.restoreContract.sourceKernelCommandLineSha256,
  digest(expectedSourceKernelCommandLine),
);
assert.equal(manifest.restoreContract.targetKernelCommandLine, expectedTargetKernelCommandLine);
assert.equal(manifest.restoreContract.runtimeDisplay, "sdl,gl=es,show-cursor=on");
assert.equal(manifest.restoreContract.virtioGpuLoadedAfterResume, true);
invariant(
  !JSON.stringify(manifest).includes(enter.nonce),
  "producer manifest leaks its plaintext resume nonce",
);

assert.equal(run.status, "completed");
assert.equal(run.mode, "guest-hibernation-resume");
assert.equal(run.qemuSourceCommit, expected.qemuCommit);
assert.equal(run.sourceExitCode, 0);
assert.equal(run.targetExitCode, 0);
assert.equal(run.sourceExitedBeforeTargetLaunch, true);
assert.equal(run.nativeMechanismProof, true);
assert.equal(run.desktopAcceptance, true);
assert.equal(run.freshVirglContext, true);
assert.equal(run.authenticGuestReport, true);
assert.equal(run.twoHealthyFrames, true);
assert.equal(run.footInputProof, true);
assert.equal(run.browserAcceptance, false);
assert.equal(run.browserQemuWasmSha256, browserQemuWasmSha256);
assert.equal(run.nonceSha256, digest(enter.nonce));
assert.equal(run.sourceDiagnosticsSha256, digest(sourceLog));
assert.equal(run.sourceEvidenceSha256, manifest.restoreContract.sourceEvidenceSha256);
assert.equal(run.derivedInitramfsSha256, manifest.derivedInitramfs.sha256);

if (process.env.VIRGL_HIBERNATE_SKIP_EVIDENCE_INDEX !== "1") {
  const indexed = new Map();
  const indexText = await text("SHA256SUMS");
  for (const line of indexText.split("\n").filter(Boolean)) {
    const match = /^([0-9a-f]{64}) {2}\.\/(.+)$/.exec(line);
    invariant(match !== null, "SHA256SUMS contains a malformed line", { line });
    const [, sha256, relative] = match;
    invariant(
      !path.isAbsolute(relative) && !relative.split("/").includes("..") && relative !== "SHA256SUMS",
      "SHA256SUMS contains an unsafe path",
      { relative },
    );
    invariant(!indexed.has(relative), "SHA256SUMS contains a duplicate path", { relative });
    indexed.set(relative, sha256);
  }
  const regularFiles = [];
  const walk = async (directory, prefix = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, relative);
      else if ((await lstat(absolute)).isFile() && relative !== "SHA256SUMS") regularFiles.push(relative);
    }
  };
  await walk(evidenceDirectory);
  regularFiles.sort();
  assert.deepEqual([...indexed.keys()], regularFiles, "SHA256SUMS file set/order is incomplete or nondeterministic");
  for (const relative of regularFiles) {
    assert.equal(
      await hashFile(evidencePath(relative)),
      indexed.get(relative),
      `SHA256SUMS digest differs for ${relative}`,
    );
  }
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  status: "PASS",
  scope: "native fresh-kernel guest-hibernation handoff with post-resume VirGL, desktop, and input proof",
  browserAcceptance: false,
  artifacts: {
    rootDeltaBytes: manifest.rootDelta.bytes,
    swapImageBytes: manifest.swapImage.bytes,
    swapVirtualBytes: manifest.swapImage.virtualBytes,
    derivedInitramfsBytes: manifest.derivedInitramfs.bytes,
  },
  timings: {
    sourceHibernateMilliseconds: run.sourceHibernateMilliseconds,
    targetResumeMilliseconds: run.targetResumeMilliseconds,
    targetAcceptanceMilliseconds: run.targetAcceptanceMilliseconds,
  },
}, null, 2)}\n`);
