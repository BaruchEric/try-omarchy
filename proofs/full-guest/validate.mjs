#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { verifyGuestReport } from "../../scripts/verification/verify-guest-report.mjs";
import { verifyGuestArtifacts } from "./artifact-integrity.mjs";
import { qcodesForCharacter } from "./qmp.mjs";

const REPORT_PREFIX = "OMARCHY_GUEST_REPORT ";
const REQUIRED_CONFIGS = new Set([
  "/usr/share/omarchy/default/hypr/omarchy.lua",
  "/usr/share/omarchy/default/omarchy/omarchy-menu.jsonc",
  "/usr/share/omarchy/shell/shell.qml",
]);

function invariant(condition, message, details = undefined) {
  if (!condition) {
    const error = new Error(message);
    if (details !== undefined) error.details = details;
    throw error;
  }
}

async function json(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function sha256(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

export function parsePpm(buffer, label) {
  let cursor = 0;
  function token() {
    while (cursor < buffer.length) {
      const byte = buffer[cursor];
      if (byte === 35) {
        while (cursor < buffer.length && buffer[cursor] !== 10) cursor += 1;
      } else if (byte === 9 || byte === 10 || byte === 13 || byte === 32) {
        cursor += 1;
      } else {
        break;
      }
    }
    const start = cursor;
    while (cursor < buffer.length && ![9, 10, 13, 32, 35].includes(buffer[cursor])) cursor += 1;
    return buffer.subarray(start, cursor).toString("ascii");
  }

  invariant(token() === "P6", `${label} is not a binary P6 screendump`);
  const width = Number(token());
  const height = Number(token());
  const maximum = Number(token());
  while (cursor < buffer.length && [9, 10, 13, 32].includes(buffer[cursor])) cursor += 1;
  invariant(width === 1600 && height === 900 && maximum === 255, `${label} is not 1600x900 RGB`, { width, height, maximum });
  const pixels = buffer.subarray(cursor);
  invariant(pixels.byteLength === width * height * 3, `${label} pixel payload is truncated or oversized`);

  let nonBlack = 0;
  let channelSum = 0;
  const colors = new Set();
  for (let offset = 0; offset < pixels.length; offset += 3) {
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    channelSum += red + green + blue;
    if (red > 8 || green > 8 || blue > 8) nonBlack += 1;
    if (colors.size < 4096) colors.add((red << 16) | (green << 8) | blue);
  }
  const pixelCount = width * height;
  return {
    width,
    height,
    maximum,
    pixels,
    nonBlackRatio: nonBlack / pixelCount,
    meanChannel: channelSum / (pixelCount * 3),
    sampledUniqueColors: colors.size,
  };
}

export function compareFrames(before, after) {
  invariant(before.pixels.length === after.pixels.length, "framebuffer payload lengths differ");
  let changed = 0;
  for (let offset = 0; offset < before.pixels.length; offset += 3) {
    const delta = Math.max(
      Math.abs(before.pixels[offset] - after.pixels[offset]),
      Math.abs(before.pixels[offset + 1] - after.pixels[offset + 1]),
      Math.abs(before.pixels[offset + 2] - after.pixels[offset + 2]),
    );
    if (delta >= 8) changed += 1;
  }
  return changed / (before.width * before.height);
}

function parseQmpLog(contents) {
  return contents.trim().split("\n").filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid QMP log line ${index + 1}: ${error.message}`);
    }
  });
}

function hasExactTypedSession(qmp, text) {
  const expected = Array.from(text, (character) => qcodesForCharacter(character));
  const sessions = [];
  let current = null;
  for (const entry of qmp) {
    if (entry.direction === "connect") {
      current = [];
    } else if (current && entry.direction === "send" && entry.payload?.execute === "send-key") {
      current.push(entry.payload.arguments?.keys?.map((key) => key.data));
    } else if (entry.direction === "disconnect" && current) {
      sessions.push(current);
      current = null;
    }
  }
  return sessions.some((session) => JSON.stringify(session) === JSON.stringify(expected));
}

function commandMap(report) {
  return new Map(report.commands.map((command) => [command.argv.join(" "), command]));
}

function comparableArtifacts(record) {
  return record.artifacts
    .map(({ path: artifactPath, bytes, sha256: digest, role }) => ({ path: artifactPath, bytes, sha256: digest, role }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export async function validateFullGuest({ guestDirectory, evidenceDirectory }) {
  const evidence = path.resolve(evidenceDirectory);
  const [run, beforeIntegrity, afterIntegrity, manifest, serial, diagnostics, qemuLog, qmpText, beforeBuffer, footOpenBuffer, footBuffer] = await Promise.all([
    json(path.join(evidence, "run.json")),
    json(path.join(evidence, "artifact-integrity-before.json")),
    json(path.join(evidence, "artifact-integrity-after.json")),
    json(path.join(guestDirectory, "guest-manifest.json")),
    readFile(path.join(evidence, "serial.log"), "utf8"),
    readFile(path.join(evidence, "diagnostics.log"), "utf8"),
    readFile(path.join(evidence, "qemu.log"), "utf8"),
    readFile(path.join(evidence, "qmp.jsonl"), "utf8"),
    readFile(path.join(evidence, "desktop-before.ppm")),
    readFile(path.join(evidence, "desktop-foot-open.ppm")),
    readFile(path.join(evidence, "desktop-foot.ppm")),
  ]);

  invariant(run.schemaVersion === 1 && run.status === "completed", "run metadata does not record completion");
  invariant(run.qemuExitCode === 0, "QEMU did not exit cleanly", run);
  invariant(run.teardown === "qmp-quit" && run.qemuAliveAfterTeardown === false, "QEMU teardown was not clean", run);
  invariant(/QEMU emulator version 11\./.test(run.qemuVersion), "unexpected native QEMU version", run.qemuVersion);
  invariant(run.machine === "pc-q35-8.2" && run.memoryMiB === 1536 && run.cores === 2, "native machine shape differs from the browser guest shape");
  invariant(run.snapshot === true && run.network === "none", "native run was not disposable and offline");
  invariant(!Number.isNaN(Date.parse(run.startedAt)) && !Number.isNaN(Date.parse(run.finishedAt)), "run timestamps are invalid");

  const currentIntegrity = await verifyGuestArtifacts(guestDirectory);
  const expectedArtifacts = comparableArtifacts(currentIntegrity);
  invariant(JSON.stringify(comparableArtifacts(beforeIntegrity)) === JSON.stringify(expectedArtifacts), "pre-boot artifact record differs from current files");
  invariant(JSON.stringify(comparableArtifacts(afterIntegrity)) === JSON.stringify(expectedArtifacts), "post-boot artifact record differs from current files");
  invariant(beforeIntegrity.manifestSha256 === currentIntegrity.manifestSha256 && afterIntegrity.manifestSha256 === currentIntegrity.manifestSha256, "guest manifest changed around the boot");

  invariant(
    /Linux version\s+[^\n]+arch/i.test(serial) || /Arch Linux\s+\d+\.\d+\.\d+-arch[^\s]*\s+\(ttyS0\)/i.test(serial),
    "serial log has no Arch Linux kernel boot evidence",
  );
  invariant(/systemd\[1\]:\s+systemd\s+/i.test(serial) || /Welcome to.*Arch Linux/i.test(serial), "serial log has no systemd Arch boot evidence");
  invariant(!/(Kernel panic|not syncing|emergency mode|Reached target Emergency|Failed to mount \/sysroot)/i.test(serial), "serial log contains a blocking boot failure");

  const reportLines = diagnostics.split("\n").filter((line) => line.startsWith(REPORT_PREFIX));
  invariant(reportLines.length === 1, `expected one authentic guest report, found ${reportLines.length}`);
  const report = JSON.parse(reportLines[0].slice(REPORT_PREFIX.length));
  const guestResult = await verifyGuestReport(report, { manifest });
  invariant(report.provenance.commit === manifest.upstream.commit, "live Omarchy commit differs from finished guest manifest");
  invariant(report.provenance.version === manifest.upstream.version, "live Omarchy version differs from finished guest manifest");
  invariant(report.provenance.treeSha256 === manifest.upstream.treeSha256, "live Omarchy tree digest differs from finished guest manifest");
  invariant(new Set(report.configs.map((config) => config.path)).size === REQUIRED_CONFIGS.size, "guest report has an unexpected config evidence set");
  for (const required of REQUIRED_CONFIGS) invariant(report.configs.some((config) => config.path === required), `guest report is missing config ${required}`);

  const commands = commandMap(report);
  const monitorCommand = commands.get("hyprctl monitors -j");
  invariant(monitorCommand?.exitCode === 0, "hyprctl monitor evidence failed");
  const monitors = JSON.parse(monitorCommand.stdout);
  const active = monitors.filter((monitor) => monitor.disabled !== true);
  invariant(active.length === 1 && active[0].width === 1600 && active[0].height === 900, "live Hyprland monitor is not exactly one 1600x900 output", active);
  invariant(report.processes.some((process) => process.name.toLowerCase() === "hyprland" && process.executable.includes("Hyprland")), "live Hyprland executable evidence is missing");
  invariant(report.processes.some((process) => process.name.toLowerCase().includes("quickshell") && process.executable.includes("quickshell")), "live Quickshell executable evidence is missing");
  const before = parsePpm(beforeBuffer, "pre-Foot framebuffer");
  const footOpen = parsePpm(footOpenBuffer, "opened-Foot framebuffer");
  const foot = parsePpm(footBuffer, "Foot framebuffer");
  invariant(before.nonBlackRatio >= 0.05 && before.sampledUniqueColors >= 32, "pre-Foot framebuffer is blank or degenerate", before);
  invariant(footOpen.nonBlackRatio >= 0.05 && footOpen.sampledUniqueColors >= 32, "opened-Foot framebuffer is blank or degenerate", footOpen);
  invariant(foot.nonBlackRatio >= 0.05 && foot.sampledUniqueColors >= 32, "Foot framebuffer is blank or degenerate", foot);
  const openChangedPixelRatio = compareFrames(before, footOpen);
  const finalChangedPixelRatio = compareFrames(before, foot);
  const typedChangedPixelRatio = compareFrames(footOpen, foot);
  invariant(openChangedPixelRatio >= 0.005, "Super+Return did not create a materially different visible framebuffer", { openChangedPixelRatio });
  invariant(finalChangedPixelRatio >= 0.005, "Foot with typed output did not differ materially from the base desktop", { finalChangedPixelRatio });
  invariant(typedChangedPixelRatio >= 0.0005, "Foot framebuffer does not show enough change to prove command execution", { typedChangedPixelRatio });

  const qmp = parseQmpLog(qmpText);
  const sent = qmp.filter((entry) => entry.direction === "send").map((entry) => entry.payload);
  invariant(qmp.some((entry) => entry.direction === "receive" && entry.payload?.QMP?.version), "QMP greeting is missing");
  invariant(sent.some((message) => message.execute === "qmp_capabilities"), "QMP capabilities negotiation is missing");
  invariant(sent.some((message) => message.execute === "query-status"), "QMP running-status query is missing");
  const dumps = sent.filter((message) => message.execute === "screendump");
  invariant(dumps.length === 3, `expected three QMP screendumps, found ${dumps.length}`);
  invariant(dumps.some((message) => message.arguments?.filename === path.join(evidence, "desktop-before.ppm")), "pre-Foot QMP screendump command is missing");
  invariant(dumps.some((message) => message.arguments?.filename === path.join(evidence, "desktop-foot-open.ppm")), "opened-Foot QMP screendump command is missing");
  invariant(dumps.some((message) => message.arguments?.filename === path.join(evidence, "desktop-foot.ppm")), "Foot QMP screendump command is missing");
  invariant(sent.some((message) => message.execute === "send-key" && message.arguments?.keys?.some((key) => key.data === "meta_l") && message.arguments?.keys?.some((key) => key.data === "ret")), "QMP did not invoke the authentic Super+Return binding");
  invariant(hasExactTypedSession(qmp, "id\n"), "QMP log does not contain the exact visible Foot command");
  invariant(sent.some((message) => message.execute === "quit"), "QMP graceful quit command is missing");
  invariant(!/(qemu-system-x86_64: terminating on signal|Could not open|failed to initialize|fatal:)/i.test(qemuLog), "QEMU log contains a fatal launch or forced-teardown error");

  // Keep this check after the independent boot, compositor, input, framebuffer,
  // and teardown assertions so a guest-report failure cannot hide whether the
  // surrounding native-QEMU proof actually exercised the finished desktop.
  invariant(guestResult.passed, "committed guest-report verifier rejected the live report", guestResult.toJSON());

  const files = [
    "command.txt",
    "serial.log",
    "diagnostics.log",
    "qemu.log",
    "qmp.jsonl",
    "desktop-before.ppm",
    "desktop-foot-open.ppm",
    "desktop-foot.ppm",
    "artifact-integrity-before.json",
    "artifact-integrity-after.json",
    "run.json",
  ];
  const evidenceArtifacts = [];
  for (const name of files) {
    const filePath = path.join(evidence, name);
    const info = await stat(filePath);
    invariant(info.isFile() && info.size > 0, `evidence file is empty: ${name}`);
    evidenceArtifacts.push({ path: name, bytes: info.size, sha256: await sha256(filePath) });
  }

  return {
    schemaVersion: 1,
    status: "PASS",
    validatedAt: new Date().toISOString(),
    claim: "Exact guest/dist artifacts booted x86_64 Arch/systemd and rendered authentic Omarchy Hyprland, Quickshell, and Foot at 1600x900 under native QEMU.",
    upstream: report.provenance,
    system: report.system,
    monitor: { name: active[0].name, width: active[0].width, height: active[0].height, refreshRate: active[0].refreshRate },
    frames: {
      before: { nonBlackRatio: before.nonBlackRatio, meanChannel: before.meanChannel, sampledUniqueColors: before.sampledUniqueColors },
      footOpen: { nonBlackRatio: footOpen.nonBlackRatio, meanChannel: footOpen.meanChannel, sampledUniqueColors: footOpen.sampledUniqueColors },
      foot: { nonBlackRatio: foot.nonBlackRatio, meanChannel: foot.meanChannel, sampledUniqueColors: foot.sampledUniqueColors },
      openChangedPixelRatio,
      finalChangedPixelRatio,
      typedChangedPixelRatio,
    },
    qemu: { version: run.qemuVersion, machine: run.machine, exitCode: run.qemuExitCode, teardown: run.teardown },
    artifactManifestSha256: currentIntegrity.manifestSha256,
    evidenceArtifacts,
    guestVerification: guestResult.toJSON(),
    caveat: "Native QEMU evidence does not prove the Emscripten SDL/OffscreenCanvas bridge, browser input latency, or browser boot performance.",
  };
}

async function main() {
  const [guestDirectory, evidenceDirectory] = process.argv.slice(2);
  if (!guestDirectory || !evidenceDirectory) throw new Error("Usage: validate.mjs GUEST_DIST EVIDENCE_DIRECTORY");
  process.stdout.write(`${JSON.stringify(await validateFullGuest({ guestDirectory, evidenceDirectory }), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      status: "FAIL",
      validatedAt: new Date().toISOString(),
      reason: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    }, null, 2)}\n`);
    process.stderr.write(`FAIL full guest evidence: ${error.message}\n`);
    if (error.details !== undefined) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    process.exitCode = 1;
  });
}
