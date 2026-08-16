#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { verifyGuestReport } from "../../scripts/verification/verify-guest-report.mjs";
import { compareFrameRegion, parsePpm } from "../full-guest/validate.mjs";
import { verifyGuestArtifacts } from "./artifact-integrity.mjs";

const EXPECTED = {
  qemuCommit: "0ef7b4e2814b231705d8371dd7997f5b72e70baf",
  guestManifestSha256: "9f9e8c2782186466854cb70c4e1ffd50ed32baed766dee4cdfd6518e3d95b333",
  rootfsSha256: "836d5d47dd8af90ffdf4389b8d9f4471ddb16e1a215b05a964a3c3ae18a22d8a",
  provenanceSha256: "771a12039baff3cf5034442496d0f47e345c2e3e394b49f6c30ed8d9753d6b38",
};
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

function recursivelySort(value) {
  if (Array.isArray(value)) return value.map(recursivelySort);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, recursivelySort(value[key])]));
  }
  return value;
}

function sha256NormalizedJson(value) {
  return createHash("sha256").update(JSON.stringify(recursivelySort(value))).digest("hex");
}

function comparableArtifacts(record) {
  return record.artifacts
    .map(({ path: artifactPath, bytes, sha256: digest, role }) => ({ path: artifactPath, bytes, sha256: digest, role }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function parseQmp(contents) {
  return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function sentPayloads(entries) {
  return entries.filter((entry) => entry.direction === "send").map((entry) => entry.payload);
}

function inputTransitions(payloads) {
  return payloads.flatMap((payload) => payload.execute === "input-send-event"
    ? (payload.arguments?.events ?? []).filter((event) => event.type === "key").map((event) => ({
      code: event.data?.key?.data,
      down: event.data?.down,
    }))
    : []);
}

function containsSequence(values, expected) {
  return values.some((_, start) => expected.every((item, offset) => {
    const actual = values[start + offset];
    return actual?.code === item.code && actual?.down === item.down;
  }));
}

function hasChord(payloads, finalKey) {
  return containsSequence(inputTransitions(payloads), [
    { code: "meta_l", down: true },
    { code: finalKey, down: true },
    { code: finalKey, down: false },
    { code: "meta_l", down: false },
  ]);
}

function assertHealthy(health, label) {
  invariant(health.schemaVersion === 2 && health.clean === true, `${label} did not pass structural frame health`, health);
  invariant(health.width === 1600 && health.height === 900 && health.payloadMatches === true, `${label} is not an exact 1600x900 framebuffer`, health);
  invariant(health.topAlertRedRatio < health.thresholds.maximumTopAlertRedRatio, `${label} has a structural red error banner`, health);
  invariant(health.visualShellReservationHealthy === true && health.uniqueColors >= health.thresholds.minimumUniqueColors, `${label} lacks the Omarchy shell/wallpaper structure`, health);
}

export async function validatePrebootResume({ guestDirectory, evidenceDirectory }) {
  const evidence = path.resolve(evidenceDirectory);
  const guest = path.resolve(guestDirectory);
  const files = {
    vmstate: path.join(evidence, "omarchy-preboot.vmstate"),
    overlay: path.join(evidence, "checkpoint-overlay.qcow2"),
    checkpointManifest: path.join(evidence, "checkpoint-manifest.json"),
  };
  const [
    run, checkpointManifest, beforeIntegrity, afterIntegrity, manifest,
    sourceDiagnostics, sourceReportGate, sourceMigration, targetMigration,
    sourcePremigrationStatus, sourcePostmigrationStatus, targetRunningStatus,
    overlayInfo, sourceQmpText, targetQmpText, sourceCommand, targetCommand,
    sourceQemu, targetQemu, sourceHealth1, sourceHealth2, sourceFootHealth,
    sourceCheckpointHealth, resumedHealth1, resumedHealth2, resumedFootHealth,
    sourceFootChange, sourceReturnChange, resumedFootChange,
    sourceDesktopBuffer, sourceFootBuffer, sourceCheckpointBuffer,
    resumedDesktopBuffer, resumedFootBuffer, sumsText,
  ] = await Promise.all([
    json(path.join(evidence, "run.json")),
    json(files.checkpointManifest),
    json(path.join(evidence, "artifact-integrity-before.json")),
    json(path.join(evidence, "artifact-integrity-after.json")),
    json(path.join(guest, "guest-manifest.json")),
    readFile(path.join(evidence, "source-diagnostics.log"), "utf8"),
    json(path.join(evidence, "source-report-validation.json")),
    json(path.join(evidence, "source-migration-final.json")),
    json(path.join(evidence, "target-migration-final.json")),
    json(path.join(evidence, "source-premigration-status.json")),
    json(path.join(evidence, "source-postmigration-status.json")),
    json(path.join(evidence, "target-running-status.json")),
    json(path.join(evidence, "checkpoint-overlay-info.json")),
    readFile(path.join(evidence, "source-qmp.jsonl"), "utf8"),
    readFile(path.join(evidence, "target-qmp.jsonl"), "utf8"),
    readFile(path.join(evidence, "source-command.txt"), "utf8"),
    readFile(path.join(evidence, "target-command.txt"), "utf8"),
    readFile(path.join(evidence, "source-qemu.log"), "utf8"),
    readFile(path.join(evidence, "target-qemu.log"), "utf8"),
    json(path.join(evidence, "source-desktop-1-health.json")),
    json(path.join(evidence, "source-desktop-2-health.json")),
    json(path.join(evidence, "source-foot-health.json")),
    json(path.join(evidence, "source-checkpoint-desktop-health.json")),
    json(path.join(evidence, "resumed-desktop-1-health.json")),
    json(path.join(evidence, "resumed-desktop-2-health.json")),
    json(path.join(evidence, "resumed-foot-health.json")),
    json(path.join(evidence, "source-foot-change.json")),
    json(path.join(evidence, "source-return-change.json")),
    json(path.join(evidence, "resumed-foot-change.json")),
    readFile(path.join(evidence, "source-desktop-2.ppm")),
    readFile(path.join(evidence, "source-foot.ppm")),
    readFile(path.join(evidence, "source-checkpoint-desktop.ppm")),
    readFile(path.join(evidence, "resumed-desktop-2.ppm")),
    readFile(path.join(evidence, "resumed-foot.ppm")),
    readFile(path.join(evidence, "SHA256SUMS"), "utf8"),
  ]);

  invariant(run.schemaVersion === 2 && run.status === "completed", "run did not complete", run);
  invariant(run.qemuVersion === "QEMU emulator version 8.2.0" && run.qemuSourceCommit === EXPECTED.qemuCommit, "producer is not exact pinned QEMU 8.2", run);
  invariant(run.machine === "pc-q35-8.2" && run.memoryMiB === 1024 && run.vcpus === 2, "machine shape differs from checkpoint contract", run);
  invariant(run.smp === "2,sockets=1,cores=2,threads=1" && run.accelerator === "tcg,tb-size=128,thread=multi", "producer did not use exact 2-vCPU MTTCG profile", run);
  invariant(run.migrationCompression === "none" && run.incomingMode === "immediate-cli-file", "checkpoint is not raw immediate-file migration", run);
  invariant(run.capturedRunstate === "running" && run.targetAutoRanWithoutQmpCont === true, "checkpoint cannot auto-run under the Worker startup contract", run);
  invariant(run.browserAcceptance === false && run.nativeCheckpointHandoff === true, "native evidence claim boundary is invalid", run);
  invariant(run.sourceProcess?.exitCode === 0 && run.targetProcess?.exitCode === 0, "source or target process did not exit cleanly", run);
  invariant(run.sourceExitedBeforeTargetLaunch === true, "source did not exit before fresh target launch");
  invariant(run.sourceProcess.pid !== run.targetProcess.pid || run.sourceProcess.startTicks !== run.targetProcess.startTicks, "source and target process identities are not distinct");
  for (const timing of ["guestReportMilliseconds", "bootToCheckpointReadyMilliseconds", "checkpointMilliseconds", "resumeToRunningMilliseconds", "resumeToHealthyMilliseconds", "resumedFootProofMilliseconds"]) {
    invariant(Number.isInteger(run[timing]) && run[timing] > 0, `invalid timing ${timing}`, run[timing]);
  }
  invariant(run.resumeToHealthyMilliseconds < run.bootToCheckpointReadyMilliseconds, "restored healthy desktop was not faster than cold boot", run);

  const currentIntegrity = await verifyGuestArtifacts(guest);
  const currentArtifacts = comparableArtifacts(currentIntegrity);
  invariant(currentIntegrity.manifestSha256 === EXPECTED.guestManifestSha256, "canonical guest manifest SHA-256 differs");
  invariant(JSON.stringify(comparableArtifacts(beforeIntegrity)) === JSON.stringify(currentArtifacts), "guest artifacts differed before checkpoint");
  invariant(JSON.stringify(comparableArtifacts(afterIntegrity)) === JSON.stringify(currentArtifacts), "guest artifacts differed after restore smoke");
  invariant(await sha256(path.join(guest, "rootfs.ext4")) === EXPECTED.rootfsSha256, "canonical rootfs SHA-256 differs");
  invariant(await sha256(path.join(guest, "provenance.json")) === EXPECTED.provenanceSha256, "canonical provenance SHA-256 differs");

  const reportLines = sourceDiagnostics.split("\n").filter((line) => line.startsWith(REPORT_PREFIX));
  invariant(reportLines.length === 1, `expected exactly one authentic report, found ${reportLines.length}`);
  const report = JSON.parse(reportLines[0].slice(REPORT_PREFIX.length));
  const guestResult = await verifyGuestReport(report, { manifest });
  invariant(guestResult.passed && sourceReportGate.status === "PASS", "source report was not authentic Omarchy", guestResult.toJSON());
  const monitorCommand = report.commands.find((command) => command.argv.join(" ") === "hyprctl monitors -j");
  const monitors = JSON.parse(monitorCommand.stdout).filter((monitor) => monitor.disabled !== true);
  invariant(monitors.length === 1 && monitors[0].width === 1600 && monitors[0].height === 900, "authentic report did not prove one 1600x900 monitor", monitors);
  invariant(!/^OMARCHY_GUEST_STAGE .*"stage":"uwsm","status":"failed"/m.test(sourceDiagnostics), "source emitted UWSM failure");

  invariant(sourcePremigrationStatus.status === "running" && sourcePremigrationStatus.running === true, "source was not running immediately before migration", sourcePremigrationStatus);
  invariant(sourceMigration.status === "completed" && sourceMigration.ram?.total > 0 && sourceMigration.ram?.transferred > 0, "source raw migration did not complete", sourceMigration);
  invariant(!sourceMigration.compression || (sourceMigration.compression.pages ?? 0) === 0, "source stream unexpectedly used internal compression", sourceMigration.compression);
  invariant(sourcePostmigrationStatus.status === "postmigrate" && sourcePostmigrationStatus.running === false, "source did not reach postmigrate", sourcePostmigrationStatus);
  invariant(targetMigration.status === "completed", "fresh target did not record completed incoming migration", targetMigration);
  invariant(targetRunningStatus.result?.status === "running" || targetRunningStatus.status === "running", "fresh target did not auto-run", targetRunningStatus);

  for (const [label, health] of [
    ["source frame 1", sourceHealth1], ["source frame 2", sourceHealth2],
    ["source Foot", sourceFootHealth], ["source checkpoint desktop", sourceCheckpointHealth],
    ["resumed frame 1", resumedHealth1], ["resumed frame 2", resumedHealth2], ["resumed Foot", resumedFootHealth],
  ]) assertHealthy(health, label);
  invariant(sourceFootChange.status === "PASS" && sourceFootChange.mode === "minimum" && sourceFootChange.ratio >= 0.0005, "source Super+Return did not visibly open Foot", sourceFootChange);
  invariant(sourceReturnChange.status === "PASS" && sourceReturnChange.mode === "maximum" && sourceReturnChange.ratio <= 0.05, "source did not return to clean shell before checkpoint", sourceReturnChange);
  invariant(resumedFootChange.status === "PASS" && resumedFootChange.mode === "minimum" && resumedFootChange.ratio >= 0.0005, "resumed Super+Return did not visibly open Foot", resumedFootChange);
  const sourceDesktop = parsePpm(sourceDesktopBuffer, "source desktop");
  const sourceFoot = parsePpm(sourceFootBuffer, "source Foot");
  const sourceCheckpoint = parsePpm(sourceCheckpointBuffer, "source checkpoint desktop");
  const resumedDesktop = parsePpm(resumedDesktopBuffer, "resumed desktop");
  const resumedFoot = parsePpm(resumedFootBuffer, "resumed Foot");
  invariant(compareFrameRegion(sourceDesktop, sourceFoot) === sourceFootChange.ratio, "source Foot delta metadata is inconsistent");
  invariant(compareFrameRegion(sourceDesktop, sourceCheckpoint) === sourceReturnChange.ratio, "source close delta metadata is inconsistent");
  invariant(compareFrameRegion(resumedDesktop, resumedFoot) === resumedFootChange.ratio, "resumed Foot delta metadata is inconsistent");

  const requiredArgs = [
    "-machine pc-q35-8.2", "-m 1024M", "-accel tcg\\,tb-size=128\\,thread=multi",
    "-smp 2\\,sockets=1\\,cores=2\\,threads=1", "-device virtio-vga\\,max_outputs=1\\,xres=1600\\,yres=900",
    "-device virtio-keyboard-pci", "-device virtio-tablet-pci", "-parallel none", "-nic none",
  ];
  for (const argument of requiredArgs) invariant(sourceCommand.includes(argument) && targetCommand.includes(argument), `source/target command misses ${argument}`);
  invariant(!sourceCommand.includes("-incoming") && !sourceCommand.includes("-snapshot") && sourceCommand.includes("source-overlay.qcow2"), "source storage/startup contract is invalid");
  invariant(targetCommand.includes("-snapshot") && targetCommand.includes("checkpoint-overlay.qcow2"), "target did not add a disposable disk layer");
  invariant(targetCommand.includes("-incoming") && targetCommand.includes("file:") && targetCommand.includes("omarchy-preboot.vmstate") && !targetCommand.includes("defer"), "target did not use immediate CLI file incoming");

  const sourceSent = sentPayloads(parseQmp(sourceQmpText));
  const targetSent = sentPayloads(parseQmp(targetQmpText));
  invariant(!sourceSent.some((message) => message.execute === "stop"), "source was manually stopped, which would serialize a paused runstate");
  invariant(!sourceSent.some((message) => message.execute === "migrate-set-capabilities"), "raw source enabled migration compression");
  invariant(sourceSent.some((message) => message.execute === "migrate" && message.arguments?.uri?.startsWith("file:") && message.arguments.uri.endsWith("omarchy-preboot.vmstate")), "source did not produce file vmstate");
  invariant(hasChord(sourceSent, "ret") && hasChord(sourceSent, "w"), "source lacks paced Super+Return/close input transitions");
  invariant(hasChord(targetSent, "ret"), "target lacks paced Super+Return input transitions");
  invariant(!targetSent.some((message) => ["cont", "migrate-incoming", "migrate-set-capabilities"].includes(message.execute)), "target required forbidden pre-main/post-load QMP migration control", targetSent);

  invariant(!/(qemu-system-x86_64: terminating on signal|failed to initialize|fatal:|load of migration failed)/i.test(sourceQemu), "source QEMU log has a fatal error");
  invariant(!/(qemu-system-x86_64: terminating on signal|failed to initialize|fatal:|load of migration failed)/i.test(targetQemu), "target QEMU log has a fatal error");

  const [vmstateStat, overlayStat, vmstateDigest, overlayDigest] = await Promise.all([
    stat(files.vmstate), stat(files.overlay), sha256(files.vmstate), sha256(files.overlay),
  ]);
  invariant(vmstateStat.isFile() && vmstateStat.size === run.vmstateBytes && vmstateDigest === run.vmstateSha256, "raw vmstate identity differs from run metadata");
  invariant(overlayStat.isFile() && overlayStat.size === run.overlayBytes && overlayDigest === run.overlaySha256, "qcow2 delta identity differs from run metadata");
  invariant(overlayInfo.format === "qcow2" && overlayInfo["backing-filename"] === "rootfs.ext4" && overlayInfo["backing-filename-format"] === "raw", "qcow2 backing contract differs", overlayInfo);

  invariant(checkpointManifest.schemaVersion === 1 && checkpointManifest.kind === "omarchy-web-preboot-checkpoint", "checkpoint manifest kind/schema differs");
  invariant(checkpointManifest.vmstate.path === "omarchy-preboot.vmstate" && checkpointManifest.vmstate.bytes === vmstateStat.size && checkpointManifest.vmstate.sha256 === vmstateDigest, "checkpoint manifest vmstate record differs");
  invariant(checkpointManifest.vmstate.format === "qemu-8.2-migration" && checkpointManifest.vmstate.compression === "none" && checkpointManifest.vmstate.incomingMode === "file", "checkpoint manifest vmstate format differs");
  invariant(checkpointManifest.bootDelta.path === "checkpoint-overlay.qcow2" && checkpointManifest.bootDelta.bytes === overlayStat.size && checkpointManifest.bootDelta.sha256 === overlayDigest, "checkpoint manifest boot delta record differs");
  invariant(checkpointManifest.bootDelta.format === "qcow2" && checkpointManifest.bootDelta.backingFilename === "rootfs.ext4" && checkpointManifest.bootDelta.backingFormat === "raw", "checkpoint manifest backing contract differs");
  invariant(checkpointManifest.producer.qemuBinarySha256 === run.qemuSha256, "checkpoint producer hash differs");
  invariant(checkpointManifest.identity.baseGuestManifestSha256 === EXPECTED.guestManifestSha256 && checkpointManifest.identity.rootfsSha256 === EXPECTED.rootfsSha256 && checkpointManifest.identity.guestProvenanceSha256 === EXPECTED.provenanceSha256, "checkpoint base identity differs");
  invariant(checkpointManifest.qemu.sourceCommit === EXPECTED.qemuCommit && checkpointManifest.qemu.version === "8.2.0", "checkpoint QEMU identity differs");
  invariant(checkpointManifest.machine.type === "pc-q35-8.2" && checkpointManifest.machine.memoryMiB === 1024 && checkpointManifest.machine.smp === run.smp && checkpointManifest.machine.accel === run.accelerator, "checkpoint machine profile differs");
  invariant(checkpointManifest.restoreContract.immediateIncomingAutoRuns === true && checkpointManifest.restoreContract.qmpContRequired === false, "checkpoint manifest is not Worker-compatible immediate incoming");
  invariant(JSON.stringify(checkpointManifest.sourceEvidence?.guestReport) === JSON.stringify(report), "checkpoint source evidence does not contain the authenticated report");
  invariant(checkpointManifest.sourceEvidence.normalizedGuestReportSha256 === sha256NormalizedJson(report), "checkpoint normalized source guest report digest differs");
  const [reportValidationDigest, checkpointFrameDigest, checkpointFrameHealthDigest] = await Promise.all([
    sha256(path.join(evidence, "source-report-validation.json")),
    sha256(path.join(evidence, "source-checkpoint-desktop.ppm")),
    sha256(path.join(evidence, "source-checkpoint-desktop-health.json")),
  ]);
  invariant(checkpointManifest.sourceEvidence.reportValidationSha256 === reportValidationDigest, "checkpoint source report validation digest differs");
  invariant(checkpointManifest.sourceEvidence.checkpointFrameSha256 === checkpointFrameDigest, "checkpoint source framebuffer digest differs");
  invariant(checkpointManifest.sourceEvidence.checkpointFrameHealthSha256 === checkpointFrameHealthDigest, "checkpoint source framebuffer health digest differs");
  const expectedSums = new Map([
    ["omarchy-preboot.vmstate", vmstateDigest],
    ["checkpoint-overlay.qcow2", overlayDigest],
    ["checkpoint-manifest.json", await sha256(files.checkpointManifest)],
  ]);
  const actualSums = new Map(sumsText.trim().split("\n").map((line) => {
    const match = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
    invariant(match, `invalid SHA256SUMS line: ${line}`);
    return [match[2], match[1]];
  }));
  invariant(actualSums.size === expectedSums.size && [...expectedSums].every(([name, digest]) => actualSums.get(name) === digest), "checkpoint SHA256SUMS differs");

  return {
    schemaVersion: 2,
    status: "PASS",
    validatedAt: new Date().toISOString(),
    claim: "Pinned QEMU 8.2 created a raw running-state checkpoint paired with its qcow2 boot delta, then a distinct fresh exact-profile process restored it through immediate CLI -incoming file:, auto-ran without QMP cont, rendered two healthy 1600x900 Omarchy shell frames, and visibly opened Foot through the real Super+Return binding. This is a native checkpoint handoff, not browser acceptance.",
    identity: checkpointManifest.identity,
    machine: checkpointManifest.machine,
    artifacts: { vmstate: checkpointManifest.vmstate, bootDelta: checkpointManifest.bootDelta },
    performance: {
      guestReportMilliseconds: run.guestReportMilliseconds,
      coldBootToCheckpointReadyMilliseconds: run.bootToCheckpointReadyMilliseconds,
      checkpointMilliseconds: run.checkpointMilliseconds,
      resumeToRunningMilliseconds: run.resumeToRunningMilliseconds,
      resumeToHealthyMilliseconds: run.resumeToHealthyMilliseconds,
      speedupToHealthy: run.bootToCheckpointReadyMilliseconds / run.resumeToHealthyMilliseconds,
      resumedFootProofMilliseconds: run.resumedFootProofMilliseconds,
    },
    pixels: {
      sourceFootChangedRatio: sourceFootChange.ratio,
      sourceReturnChangedRatio: sourceReturnChange.ratio,
      resumedFootChangedRatio: resumedFootChange.ratio,
    },
    caveat: "Browser acceptance must independently range-deliver both bound artifacts and the exact rootfs, then provide its own fresh randomized desktop text acknowledgement. The native proof intentionally does not claim unreliable QMP terminal-text delivery.",
  };
}

async function main() {
  const [guestDirectory, evidenceDirectory] = process.argv.slice(2);
  if (!guestDirectory || !evidenceDirectory) throw new Error("usage: validate.mjs GUEST_DIST EVIDENCE_DIRECTORY");
  process.stdout.write(`${JSON.stringify(await validatePrebootResume({ guestDirectory, evidenceDirectory }), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`PREBOOT_RESUME_VALIDATION_FAIL ${error.message}\n`);
    if (error.details !== undefined) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    process.exitCode = 1;
  });
}
