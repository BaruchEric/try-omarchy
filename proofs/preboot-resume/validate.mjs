#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { verifyGuestReport } from "../../scripts/verification/verify-guest-report.mjs";
import { verifyGuestArtifacts } from "./artifact-integrity.mjs";
import { compareFrames, parsePpm } from "../full-guest/validate.mjs";

const EXPECTED_COMMIT = "0ef7b4e2814b231705d8371dd7997f5b72e70baf";
const REPORT_PREFIX = "OMARCHY_GUEST_REPORT ";

function invariant(condition, message, details = undefined) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

async function json(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function comparableArtifacts(record) {
  return record.artifacts
    .map(({ path: artifactPath, bytes, sha256: digest, role }) => ({ path: artifactPath, bytes, sha256: digest, role }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function parseQmp(contents) {
  return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export async function validatePrebootResume({ guestDirectory, evidenceDirectory }) {
  const evidence = path.resolve(evidenceDirectory);
  const [run, proofScope, beforeIntegrity, afterIntegrity, manifest, sourceDiagnostics, targetDiagnostics, migration, targetMigration, sourceHealth, sourceAfterInputHealth, resumedHealth, sourceQmpText, targetQmpText, sourceCommand, targetCommand, sourceQemu, targetQemu, sourceFrameBuffer, sourceFootFrameBuffer, sourceAfterInputFrameBuffer, resumedFrameBuffer, footFrameBuffer, wasmSupport] = await Promise.all([
    json(path.join(evidence, "run.json")),
    json(path.join(evidence, "proof-scope.json")),
    json(path.join(evidence, "artifact-integrity-before.json")),
    json(path.join(evidence, "artifact-integrity-after.json")),
    json(path.join(guestDirectory, "guest-manifest.json")),
    readFile(path.join(evidence, "source-diagnostics.log"), "utf8"),
    readFile(path.join(evidence, "target-diagnostics.log"), "utf8"),
    json(path.join(evidence, "source-migration-final.json")),
    json(path.join(evidence, "target-migration-final.json")),
    json(path.join(evidence, "source-frame-health.json")),
    json(path.join(evidence, "source-frame-health-after-input.json")),
    json(path.join(evidence, "resumed-frame-health.json")),
    readFile(path.join(evidence, "source-qmp.jsonl"), "utf8"),
    readFile(path.join(evidence, "target-qmp.jsonl"), "utf8"),
    readFile(path.join(evidence, "source-command.txt"), "utf8"),
    readFile(path.join(evidence, "target-command.txt"), "utf8"),
    readFile(path.join(evidence, "source-qemu.log"), "utf8"),
    readFile(path.join(evidence, "target-qemu.log"), "utf8"),
    readFile(path.join(evidence, "source-desktop.ppm")),
    readFile(path.join(evidence, "source-foot.ppm")),
    readFile(path.join(evidence, "source-desktop-after-input.ppm")),
    readFile(path.join(evidence, "resumed-desktop.ppm")),
    readFile(path.join(evidence, "resumed-foot.ppm")),
    json(path.join(evidence, "wasm-incoming-support.json")),
  ]);

  invariant(run.schemaVersion === 1 && run.status === "completed", "run did not complete", run);
  invariant(run.qemuVersion === "QEMU emulator version 8.2.0", "proof did not use QEMU 8.2.0", run.qemuVersion);
  invariant(run.qemuSourceCommit === EXPECTED_COMMIT, "native QEMU commit is not the pinned Wasm commit");
  invariant(run.sourceProcess?.exitCode === 0 && run.targetProcess?.exitCode === 0, "source or fresh target process did not exit cleanly", { source: run.sourceProcess, target: run.targetProcess });
  invariant(run.sourceExitedBeforeTargetLaunch === true, "run does not attest the source exited before target launch");
  invariant(run.sourceProcess.pid !== run.targetProcess.pid || run.sourceProcess.startTicks !== run.targetProcess.startTicks, "source and target process identities are not distinct");
  invariant(run.machine === "pc-q35-8.2" && run.memoryMiB === 1024 && Number.isInteger(run.vcpus) && run.vcpus > 0, "machine shape is invalid", run);
  invariant(run.proofScope === proofScope.proofScope && run.vcpus === proofScope.vcpus, "proof scope and run metadata disagree", { run, proofScope });
  const legacyCompression = run.migrationCompression === "QEMU legacy compress capability, zlib level 6, two threads";
  const rawImmediate = run.migrationCompression === "none; raw QEMU stream" && run.incomingMode === "immediate-cli-file";
  invariant(legacyCompression || rawImmediate, "migration transport mode is not recognized", run);
  invariant(proofScope.migrationCompression === (legacyCompression ? "legacy" : "none"), "proof scope migration mode disagrees with the run", { run, proofScope });
  invariant(proofScope.immediateFileIncoming === rawImmediate, "proof scope immediate-incoming label is inconsistent", proofScope);
  invariant(run.browserAcceptance === false && proofScope.browserAcceptance === false, "native mechanism evidence must not claim browser acceptance");
  invariant(run.topologyMatchesBrowser === (run.vcpus === 1) && proofScope.topologyMatchesBrowser === (run.vcpus === 1), "browser topology label is inconsistent", { run, proofScope });
  if (run.vcpus !== 1) {
    invariant(run.proofScope === "migration-mechanism-only", "non-browser topology must be explicitly labeled migration-mechanism-only", run);
  }
  invariant(run.diskMode === "packaged preboot qcow2 delta over exact immutable rootfs; resumed target adds -snapshot", "disk checkpoint/isolation mode is not explicit");
  invariant(Number.isInteger(run.bootMilliseconds) && run.bootMilliseconds > 0, "cold boot timing is invalid");
  invariant(Number.isInteger(run.checkpointMilliseconds) && run.checkpointMilliseconds > 0, "checkpoint timing is invalid");
  invariant(Number.isInteger(run.resumeLoadMilliseconds) && run.resumeLoadMilliseconds > 0, "resume timing is invalid");
  invariant(run.resumeLoadMilliseconds < run.bootMilliseconds, "vmstate load was not faster than cold boot", run);

  const currentIntegrity = await verifyGuestArtifacts(guestDirectory);
  const currentArtifacts = comparableArtifacts(currentIntegrity);
  invariant(JSON.stringify(comparableArtifacts(beforeIntegrity)) === JSON.stringify(currentArtifacts), "guest artifacts differed before checkpointing");
  invariant(JSON.stringify(comparableArtifacts(afterIntegrity)) === JSON.stringify(currentArtifacts), "guest artifacts differed after resuming");
  invariant(beforeIntegrity.manifestSha256 === afterIntegrity.manifestSha256 && beforeIntegrity.manifestSha256 === currentIntegrity.manifestSha256, "guest manifest identity changed");

  const reportLines = sourceDiagnostics.split("\n").filter((line) => line.startsWith(REPORT_PREFIX));
  invariant(reportLines.length === 1, `expected one authentic guest report, found ${reportLines.length}`);
  const report = JSON.parse(reportLines[0].slice(REPORT_PREFIX.length));
  const guestResult = await verifyGuestReport(report, { manifest });
  invariant(guestResult.passed, "source checkpoint was not authentic Omarchy", guestResult.toJSON());
  invariant(report.provenance.commit === manifest.upstream.commit, "source report commit differs from guest manifest");
  const monitorCommand = report.commands.find((command) => command.argv.join(" ") === "hyprctl monitors -j");
  invariant(monitorCommand?.exitCode === 0, "source report has no successful Hyprland monitor query");
  const monitors = JSON.parse(monitorCommand.stdout).filter((monitor) => monitor.disabled !== true);
  invariant(monitors.length === 1 && monitors[0].width === 1600 && monitors[0].height === 900, "checkpoint source was not one 1600x900 Omarchy output", monitors);

  invariant(migration.status === "completed", "QEMU migration did not complete", migration);
  invariant(targetMigration.status === "completed", "fresh target did not record completed incoming migration", targetMigration);
  invariant(migration.ram?.total > 0 && migration.ram?.transferred > 0, "migration has no RAM transfer evidence", migration);
  if (legacyCompression) {
    invariant(migration.compression?.pages > 0 && migration.compression?.["compressed-size"] > 0, "legacy migration has no built-in compression evidence", migration.compression);
  } else {
    invariant(!migration.compression || (migration.compression.pages ?? 0) === 0, "raw immediate stream unexpectedly depends on QEMU migration compression", migration.compression);
  }
  invariant(sourceHealth.clean === true && sourceHealth.width === 1600 && sourceHealth.height === 900 && sourceHealth.topAlertRedRatio < 0.005, "checkpoint source frame was not settled and free of the Hyprland error banner", sourceHealth);
  invariant(sourceAfterInputHealth.clean === true && sourceAfterInputHealth.width === 1600 && sourceAfterInputHealth.height === 900 && sourceAfterInputHealth.topAlertRedRatio < 0.005, "checkpoint source did not return to a settled error-free desktop after its input proof", sourceAfterInputHealth);
  invariant(resumedHealth.clean === true && resumedHealth.width === 1600 && resumedHealth.height === 900 && resumedHealth.topAlertRedRatio < 0.005, "resumed frame was not settled and free of the Hyprland error banner", resumedHealth);

  const sourceFrame = parsePpm(sourceFrameBuffer, "source desktop");
  const sourceFootFrame = parsePpm(sourceFootFrameBuffer, "source Foot desktop");
  const sourceAfterInputFrame = parsePpm(sourceAfterInputFrameBuffer, "source desktop after input proof");
  const resumedFrame = parsePpm(resumedFrameBuffer, "resumed desktop");
  const footFrame = parsePpm(footFrameBuffer, "resumed Foot desktop");
  for (const [label, frame] of [["source", sourceFrame], ["source Foot", sourceFootFrame], ["source after input", sourceAfterInputFrame], ["resumed", resumedFrame], ["Foot", footFrame]]) {
    invariant(frame.nonBlackRatio >= 0.05 && frame.sampledUniqueColors >= 32, `${label} framebuffer is blank or degenerate`, frame);
  }
  const sourceFootChangedPixelRatio = compareFrames(sourceFrame, sourceFootFrame);
  invariant(sourceFootChangedPixelRatio >= 0.005, "Super+Return did not visibly open Foot before checkpointing", { sourceFootChangedPixelRatio });
  invariant(/uid=1000\(omarchy\)/.test(sourceDiagnostics), "checkpoint source did not execute id as the Omarchy desktop user");
  const footChangedPixelRatio = compareFrames(resumedFrame, footFrame);
  invariant(footChangedPixelRatio >= 0.005, "Super+Return did not visibly open Foot after resume", { footChangedPixelRatio });
  invariant(/uid=1000\(omarchy\)/.test(targetDiagnostics), "resumed guest did not execute id as the Omarchy desktop user");

  const requiredArgs = [
    "-machine pc-q35-8.2",
    "-m 1024M",
    "-accel tcg\\,tb-size=128\\,thread=single",
    `-smp ${run.vcpus}\\,sockets=1\\,cores=${run.vcpus}\\,threads=1`,
    "-device virtio-vga\\,max_outputs=1\\,xres=1600\\,yres=900",
    "-parallel none",
    "-nic none",
  ];
  for (const argument of requiredArgs) {
    invariant(sourceCommand.includes(argument) && targetCommand.includes(argument), `source/target command is missing ${argument}`);
  }
  invariant(!sourceCommand.includes("-incoming"), "checkpoint source unexpectedly used incoming migration");
  invariant(!sourceCommand.includes("-snapshot") && sourceCommand.includes("source-overlay.qcow2"), "source did not persist boot-time writes in the explicit preboot overlay");
  invariant(targetCommand.includes("-snapshot") && targetCommand.includes("checkpoint-overlay.qcow2"), "target did not add a disposable layer over the packaged preboot overlay");
  if (legacyCompression) {
    invariant(targetCommand.includes("-incoming") && targetCommand.includes("defer"), "compressed target did not defer incoming migration until decompression was configured");
  } else {
    invariant(targetCommand.includes("-incoming") && targetCommand.includes("file:") && targetCommand.includes("omarchy-preboot.vmstate"), "raw target did not use immediate CLI file incoming migration");
    invariant(!targetCommand.includes("defer"), "raw immediate target unexpectedly deferred incoming migration");
  }

  const sourceQmp = parseQmp(sourceQmpText);
  const targetQmp = parseQmp(targetQmpText);
  const sourceSent = sourceQmp.filter((entry) => entry.direction === "send").map((entry) => entry.payload);
  const targetSent = targetQmp.filter((entry) => entry.direction === "send").map((entry) => entry.payload);
  invariant(sourceSent.some((message) => message.execute === "stop"), "source was not paused for a deterministic checkpoint");
  invariant(sourceSent.some((message) => message.execute === "input-send-event" && message.arguments?.events?.filter((event) => event.type === "key" && event.data?.down === false).length >= 8), "checkpoint source did not explicitly release keyboard modifiers");
  invariant(sourceSent.some((message) => message.execute === "send-key" && message.arguments?.keys?.some((key) => key.data === "meta_l") && message.arguments?.keys?.some((key) => key.data === "ret")), "checkpoint source did not receive Omarchy's Super+Return binding");
  invariant(sourceSent.some((message) => message.execute === "migrate" && message.arguments?.uri?.startsWith("file:")), "source did not write a file migration stream");
  if (legacyCompression) {
    invariant(sourceSent.some((message) => message.execute === "migrate-set-capabilities" && message.arguments?.capabilities?.some((capability) => capability.capability === "compress" && capability.state === true)), "source did not enable QEMU migration compression");
    invariant(targetSent.some((message) => message.execute === "migrate-set-capabilities" && message.arguments?.capabilities?.some((capability) => capability.capability === "compress" && capability.state === true)), "target did not enable matching QEMU migration decompression");
    invariant(targetSent.some((message) => message.execute === "migrate-set-parameters" && message.arguments?.["decompress-threads"] === 2), "target did not configure decompression before incoming migration");
    invariant(targetSent.some((message) => message.execute === "migrate-incoming" && message.arguments?.uri?.startsWith("file:") && message.arguments.uri.endsWith("omarchy-preboot.vmstate")), "target did not consume the compressed vmstate through QEMU's file incoming path");
  } else {
    invariant(!sourceSent.some((message) => message.execute === "migrate-set-capabilities"), "raw source unexpectedly enabled migration compression");
    invariant(!targetSent.some((message) => message.execute === "migrate-incoming"), "immediate CLI target unexpectedly required pre-main QMP migrate-incoming");
  }
  invariant(targetSent.some((message) => message.execute === "cont"), "resumed target was not continued after loading");
  invariant(targetSent.some((message) => message.execute === "input-send-event" && message.arguments?.events?.filter((event) => event.type === "key" && event.data?.down === false).length >= 8), "resumed target did not explicitly release keyboard modifiers");
  invariant(targetSent.some((message) => message.execute === "send-key" && message.arguments?.keys?.some((key) => key.data === "meta_l") && message.arguments?.keys?.some((key) => key.data === "ret")), "resumed target did not receive Omarchy's Super+Return binding");

  invariant(!/(qemu-system-x86_64: terminating on signal|failed to initialize|fatal:|load of migration failed)/i.test(sourceQemu), "source QEMU log has a fatal error");
  invariant(!/(qemu-system-x86_64: terminating on signal|failed to initialize|fatal:|load of migration failed)/i.test(targetQemu), "target QEMU log has a fatal error");

  const vmstatePath = path.join(evidence, "omarchy-preboot.vmstate");
  const gzipPath = `${vmstatePath}.gz`;
  const overlayPath = path.join(evidence, "checkpoint-overlay.qcow2");
  const overlayGzipPath = `${overlayPath}.gz`;
  const [vmstateStat, gzipStat, digest, overlayStat, overlayGzipStat, overlayDigest] = await Promise.all([
    stat(vmstatePath),
    stat(gzipPath),
    sha256(vmstatePath),
    stat(overlayPath),
    stat(overlayGzipPath),
    sha256(overlayPath),
  ]);
  invariant(vmstateStat.isFile() && vmstateStat.size === run.vmstateBytes && digest === run.vmstateSha256, "vmstate identity differs from run metadata");
  invariant(gzipStat.isFile() && gzipStat.size === run.gzipBytes && gzipStat.size > 0, "external gzip artifact is missing or inconsistent");
  invariant(Math.abs(run.gzipRatio - gzipStat.size / vmstateStat.size) < 1e-12, "gzip ratio is inconsistent");
  invariant(overlayStat.isFile() && overlayStat.size === run.overlayBytes && overlayDigest === run.overlaySha256, "preboot overlay identity differs from run metadata");
  invariant(overlayGzipStat.isFile() && overlayGzipStat.size === run.overlayGzipBytes && overlayGzipStat.size > 0, "compressed preboot overlay is missing or inconsistent");
  invariant(Math.abs(run.overlayGzipRatio - overlayGzipStat.size / overlayStat.size) < 1e-12, "overlay gzip ratio is inconsistent");

  invariant(wasmSupport.qemu.version === "8.2.0" && wasmSupport.qemu.commit === EXPECTED_COMMIT, "Wasm incoming-path evidence covers another QEMU");
  invariant(Object.values(wasmSupport.sourceChecks).every(Boolean), "Wasm source incoming checks did not all pass", wasmSupport.sourceChecks);
  invariant(Object.values(wasmSupport.linkedWasm.checks).every(Boolean), "linked Wasm incoming markers did not all pass", wasmSupport.linkedWasm.checks);

  const topologyQualifier = run.topologyMatchesBrowser
    ? "at the planned one-vCPU topology"
    : `as a topology-divergent ${run.vcpus}-vCPU migration mechanism proof`;

  return {
    schemaVersion: 1,
    status: "PASS",
    validatedAt: new Date().toISOString(),
    claim: `Pinned QEMU 8.2 restored authentic Omarchy from a ${rawImmediate ? "raw immediate CLI" : "capability-negotiated compressed"} file migration stream into a fresh process ${topologyQualifier}, settled to one clean 1600x900 desktop, opened Foot, and executed input as uid 1000; the exact linked Wasm contains the same incoming-file code path. This is not browser acceptance.`,
    proofScope: {
      name: run.proofScope,
      vcpus: run.vcpus,
      browserTopologyVcpus: run.browserTopologyVcpus,
      topologyMatchesBrowser: run.topologyMatchesBrowser,
      browserAcceptance: false,
      incomingMode: run.incomingMode,
    },
    upstream: report.provenance,
    performance: {
      coldBootMilliseconds: run.bootMilliseconds,
      checkpointMilliseconds: run.checkpointMilliseconds,
      resumeLoadMilliseconds: run.resumeLoadMilliseconds,
      speedup: run.bootMilliseconds / run.resumeLoadMilliseconds,
      vmstateBytes: run.vmstateBytes,
      gzipBytes: run.gzipBytes,
      gzipRatio: run.gzipRatio,
      overlayBytes: run.overlayBytes,
      overlayGzipBytes: run.overlayGzipBytes,
      overlayGzipRatio: run.overlayGzipRatio,
    },
    framebuffers: {
      sourceNonBlackRatio: sourceFrame.nonBlackRatio,
      sourceFootNonBlackRatio: sourceFootFrame.nonBlackRatio,
      sourceFootChangedPixelRatio,
      sourceAfterInputNonBlackRatio: sourceAfterInputFrame.nonBlackRatio,
      resumedNonBlackRatio: resumedFrame.nonBlackRatio,
      footNonBlackRatio: footFrame.nonBlackRatio,
      footChangedPixelRatio,
    },
    caveat: `Correct resume requires both the vmstate and its paired preboot qcow2 delta over the exact rootfs. ${run.topologyMatchesBrowser ? "" : "This run used two vCPUs to bypass the old guest's 30-second UWSM timeout and proves only the migration mechanism, not the planned one-vCPU topology. "}${legacyCompression ? "This compressed mode also requires pre-main QMP control which the current browser Worker does not expose. " : "The raw immediate file path matches the current Worker's no-QMP startup contract, but does not itself prove browser range paging or latency. "}Browser startup, range delivery of both artifacts, and bounded writable-overlay behavior still require an integration gate.`,
  };
}

async function main() {
  const [guestDirectory, evidenceDirectory] = process.argv.slice(2);
  const result = await validatePrebootResume({ guestDirectory, evidenceDirectory });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`PREBOOT_RESUME_VALIDATION_FAIL ${error.message}\n`);
    if (error.details !== undefined) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    process.exitCode = 1;
  });
}
