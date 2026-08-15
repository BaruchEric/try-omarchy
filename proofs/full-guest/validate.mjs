#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { verifyGuestReport } from "../../scripts/verification/verify-guest-report.mjs";
import { verifyGuestArtifacts } from "./artifact-integrity.mjs";
import { explicitInputPayloadsForText, FOOT_PROOF_COMMAND } from "./qmp.mjs";

const REPORT_PREFIX = "OMARCHY_GUEST_REPORT ";
const EXPECTED_KERNEL_COMMAND_LINE = "root=/dev/vda rw rootwait rootfstype=ext4 console=tty0 console=ttyS0,115200n8 loglevel=4 systemd.show_status=true rd.systemd.show_status=true mitigations=off nowatchdog omarchy.web_demo=1";
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
  const separator = buffer[cursor];
  invariant([9, 10, 13, 32].includes(separator), `${label} has no legal PPM raster separator`);
  cursor += separator === 13 && buffer[cursor + 1] === 10 ? 2 : 1;
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

export const FOOT_OUTPUT_REGION = Object.freeze({ x: 400, y: 40, width: 800, height: 840 });

export function compareFrameRegion(before, after, region = FOOT_OUTPUT_REGION) {
  invariant(before.pixels.length === after.pixels.length, "framebuffer payload lengths differ");
  invariant(
    Number.isInteger(region.x) && Number.isInteger(region.y) &&
      Number.isInteger(region.width) && Number.isInteger(region.height) &&
      region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0 &&
      region.x + region.width <= before.width && region.y + region.height <= before.height,
    "framebuffer comparison region is invalid",
    region,
  );
  let changed = 0;
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      const offset = (y * before.width + x) * 3;
      const delta = Math.max(
        Math.abs(before.pixels[offset] - after.pixels[offset]),
        Math.abs(before.pixels[offset + 1] - after.pixels[offset + 1]),
        Math.abs(before.pixels[offset + 2] - after.pixels[offset + 2]),
      );
      if (delta >= 8) changed += 1;
    }
  }
  // Preserve the reviewed 0.0005 whole-frame threshold while excluding
  // unrelated wallpaper and top-bar pixels from the numerator.
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

export function qmpActionSessions(qmp) {
  const sessions = [];
  let current = null;
  for (const entry of qmp) {
    if (entry.direction === "connect") {
      invariant(current === null, "QMP log contains nested connections");
      current = [];
    } else if (entry.direction === "send") {
      invariant(current !== null, "QMP log contains a send outside a connection");
      current.push(entry.payload);
    } else if (entry.direction === "disconnect") {
      invariant(current !== null, "QMP log contains a disconnect outside a connection");
      invariant(current[0]?.execute === "qmp_capabilities", "QMP session did not begin with capabilities negotiation");
      invariant(current.length >= 2, "QMP session contains no reviewed action");
      sessions.push(current.slice(1));
      current = null;
    }
  }
  invariant(current === null, "QMP log ends with an open connection");
  return sessions;
}

export function parseRecordedCommand(contents) {
  invariant(typeof contents === "string" && contents.length > 0, "recorded command is empty");
  const argv = [];
  let word = "";
  let inWord = false;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index];
    if (/\s/.test(character)) {
      if (inWord) {
        argv.push(word);
        word = "";
        inWord = false;
      }
      continue;
    }
    invariant(!["'", '"', "$", "`"].includes(character), `recorded command contains unsupported shell syntax: ${character}`);
    if (character === "\\") {
      index += 1;
      invariant(index < contents.length && contents[index] !== "\n" && contents[index] !== "\r", "recorded command has an invalid escape");
      word += contents[index];
    } else {
      word += character;
    }
    inWord = true;
  }
  if (inWord) argv.push(word);
  invariant(argv.length > 0, "recorded command has no arguments");
  return argv;
}

function exactOption(argv, name) {
  const positions = argv.flatMap((value, index) => value === name ? [index] : []);
  invariant(positions.length === 1, `recorded command must contain exactly one ${name}`);
  const position = positions[0];
  invariant(position + 1 < argv.length && !argv[position + 1].startsWith("-"), `recorded command ${name} has no value`);
  return argv[position + 1];
}

function exactSingleAction(session, execute, argumentsObject = undefined) {
  if (session.length !== 1 || session[0]?.execute !== execute) return false;
  if (argumentsObject === undefined) return session[0].arguments === undefined;
  return JSON.stringify(session[0].arguments) === JSON.stringify(argumentsObject);
}

function exactExplicitAction(session, text) {
  const expected = explicitInputPayloadsForText(text);
  return session.length === expected.length && session.every((payload, index) =>
    payload.execute === "input-send-event" && JSON.stringify(payload.arguments) === JSON.stringify(expected[index]));
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
  const [run, beforeIntegrity, afterIntegrity, manifest, serial, diagnostics, qemuLog, qmpText, commandText, typedDelta, beforeBuffer, footOpenBuffer, footTypedBuffer, footBuffer] = await Promise.all([
    json(path.join(evidence, "run.json")),
    json(path.join(evidence, "artifact-integrity-before.json")),
    json(path.join(evidence, "artifact-integrity-after.json")),
    json(path.join(guestDirectory, "guest-manifest.json")),
    readFile(path.join(evidence, "serial.log"), "utf8"),
    readFile(path.join(evidence, "diagnostics.log"), "utf8"),
    readFile(path.join(evidence, "qemu.log"), "utf8"),
    readFile(path.join(evidence, "qmp.jsonl"), "utf8"),
    readFile(path.join(evidence, "command.txt"), "utf8"),
    json(path.join(evidence, "typed-frame-delta.json")),
    readFile(path.join(evidence, "desktop-before.ppm")),
    readFile(path.join(evidence, "desktop-foot-open.ppm")),
    readFile(path.join(evidence, "desktop-foot-typed.ppm")),
    readFile(path.join(evidence, "desktop-foot.ppm")),
  ]);

  invariant(run.schemaVersion === 1 && run.status === "completed", "run metadata does not record completion");
  invariant(run.qemuExitCode === 0, "QEMU did not exit cleanly", run);
  invariant(run.qmpQuitClientStatus === 0, "QMP quit request did not complete successfully", run);
  invariant(run.teardown === "qmp-quit" && run.qemuAliveAfterTeardown === false, "QEMU teardown was not clean", run);
  invariant(/QEMU emulator version 11\./.test(run.qemuVersion), "unexpected native QEMU version", run.qemuVersion);
  invariant(run.machine === "pc-q35-8.2" && run.memoryMiB === 1536 && run.cores === 2, "native machine shape differs from the reviewed proof profile");
  invariant(run.snapshot === true && run.network === "none", "native run was not disposable and offline");
  invariant(!Number.isNaN(Date.parse(run.startedAt)) && !Number.isNaN(Date.parse(run.finishedAt)), "run timestamps are invalid");
  invariant(Date.parse(run.finishedAt) >= Date.parse(run.startedAt), "run completion predates its start");
  invariant(run.kernelCommandLine === EXPECTED_KERNEL_COMMAND_LINE, "kernel command line differs from the reviewed boot contract");
  invariant(Number.isInteger(run.guestReportElapsedSeconds) && run.guestReportElapsedSeconds > 0, "guest-report timing is invalid");
  invariant(Number.isInteger(run.inputProofElapsedSeconds) && run.inputProofElapsedSeconds > 0, "input-proof timing is invalid");
  invariant(run.footProofCommand === FOOT_PROOF_COMMAND, "Foot proof command differs from the reviewed command");
  invariant(run.inputEnterAttempts === 1 || run.inputEnterAttempts === 2, "Foot submit attempt count is invalid");

  const qemuArgv = parseRecordedCommand(commandText);
  invariant(path.basename(qemuArgv[0]) === "qemu-system-x86_64", "recorded command did not launch qemu-system-x86_64");
  const recordedMachine = exactOption(qemuArgv, "-machine");
  const recordedMemory = exactOption(qemuArgv, "-m");
  const recordedSmp = exactOption(qemuArgv, "-smp");
  const recordedNic = exactOption(qemuArgv, "-nic");
  invariant(recordedMachine === "pc-q35-8.2", "recorded command machine is not pc-q35-8.2");
  invariant(recordedMemory === "1536M", "recorded command memory is not 1536 MiB");
  invariant(recordedSmp === "2,sockets=1,cores=2,threads=1", "recorded command SMP topology is not the reviewed two-vCPU shape");
  invariant(recordedNic === "none", "recorded command did not disable NIC creation");
  invariant(qemuArgv.filter((argument) => argument === "-snapshot").length === 1, "recorded command did not enable exactly one snapshot mode");
  invariant(!qemuArgv.includes("-net") && !qemuArgv.includes("-netdev"), "recorded command contains an additional network backend");
  const recordedDevices = qemuArgv.flatMap((argument, index) => qemuArgv[index - 1] === "-device" ? [argument] : []);
  invariant(!recordedDevices.some((device) => /(virtio-net|e1000|rtl8139|vmxnet)/i.test(device)), "recorded command contains a network device");
  invariant(exactOption(qemuArgv, "-append") === EXPECTED_KERNEL_COMMAND_LINE, "recorded command kernel line differs from the reviewed boot contract");
  invariant(run.machine === recordedMachine && run.memoryMiB === 1536 && run.cores === 2, "run metadata differs from recorded machine arguments");
  invariant(run.snapshot === true && run.network === recordedNic, "run metadata differs from recorded isolation arguments");

  const currentIntegrity = await verifyGuestArtifacts(guestDirectory);
  invariant(exactOption(qemuArgv, "-kernel") === path.join(currentIntegrity.guestDirectory, "vmlinuz-linux"), "recorded command kernel differs from the verified artifact");
  invariant(exactOption(qemuArgv, "-initrd") === path.join(currentIntegrity.guestDirectory, "initramfs-linux.img"), "recorded command initramfs differs from the verified artifact");
  const recordedDrive = exactOption(qemuArgv, "-drive").split(",");
  invariant(recordedDrive.includes("if=virtio") && recordedDrive.includes("format=raw") && recordedDrive.includes(`file=${path.join(currentIntegrity.guestDirectory, "rootfs.ext4")}`), "recorded command drive differs from the verified rootfs");
  invariant(path.resolve(run.guestDirectory) === currentIntegrity.guestDirectory, "run metadata points at a different guest distribution");
  const expectedArtifacts = comparableArtifacts(currentIntegrity);
  invariant(JSON.stringify(comparableArtifacts(beforeIntegrity)) === JSON.stringify(expectedArtifacts), "pre-boot artifact record differs from current files");
  invariant(JSON.stringify(comparableArtifacts(afterIntegrity)) === JSON.stringify(expectedArtifacts), "post-boot artifact record differs from current files");
  invariant(beforeIntegrity.manifestSha256 === currentIntegrity.manifestSha256 && afterIntegrity.manifestSha256 === currentIntegrity.manifestSha256, "guest manifest changed around the boot");

  invariant(
    /Linux version\s+[^\n]+arch/i.test(serial) || /Arch Linux\s+\d+\.\d+\.\d+-arch[^\s]*\s+\(ttyS0\)/i.test(serial),
    "serial log has no Arch Linux kernel boot evidence",
  );
  invariant(/systemd\[1\]:\s+systemd\s+/i.test(serial) || /Welcome to.*Arch Linux/i.test(serial), "serial log has no systemd Arch boot evidence");
  invariant(/Reached target[^\r\n]*Graphical Interface/i.test(serial), "serial log never reached systemd's graphical target");
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
  const identityLines = diagnostics.split("\n").filter((line) => /^uid=1000\(omarchy\) /.test(line));
  invariant(identityLines.length === 1, `expected one Foot identity result, found ${identityLines.length}`);
  const before = parsePpm(beforeBuffer, "pre-Foot framebuffer");
  const footOpen = parsePpm(footOpenBuffer, "opened-Foot framebuffer");
  const footTyped = parsePpm(footTypedBuffer, "pre-submit Foot framebuffer");
  const foot = parsePpm(footBuffer, "Foot framebuffer");
  invariant(before.nonBlackRatio >= 0.05 && before.sampledUniqueColors >= 32, "pre-Foot framebuffer is blank or degenerate", before);
  invariant(footOpen.nonBlackRatio >= 0.05 && footOpen.sampledUniqueColors >= 32, "opened-Foot framebuffer is blank or degenerate", footOpen);
  invariant(footTyped.nonBlackRatio >= 0.05 && footTyped.sampledUniqueColors >= 32, "pre-submit Foot framebuffer is blank or degenerate", footTyped);
  invariant(foot.nonBlackRatio >= 0.05 && foot.sampledUniqueColors >= 32, "Foot framebuffer is blank or degenerate", foot);
  const openChangedPixelRatio = compareFrames(before, footOpen);
  const commandTypedChangedPixelRatio = compareFrames(footOpen, footTyped);
  const finalChangedPixelRatio = compareFrames(before, foot);
  const typedChangedPixelRatio = compareFrames(footOpen, foot);
  const executedOutputChangedPixelRatio = compareFrameRegion(footTyped, foot);
  invariant(openChangedPixelRatio >= 0.005, "Super+Return did not create a materially different visible framebuffer", { openChangedPixelRatio });
  invariant(commandTypedChangedPixelRatio >= 0.0005, "explicit keyboard input did not visibly type the reviewed Foot command", { commandTypedChangedPixelRatio });
  invariant(finalChangedPixelRatio >= 0.005, "Foot with typed output did not differ materially from the base desktop", { finalChangedPixelRatio });
  invariant(typedChangedPixelRatio >= 0.0005, "Foot framebuffer does not show enough change to prove command execution", { typedChangedPixelRatio });
  invariant(executedOutputChangedPixelRatio >= 0.0005, "post-Enter Foot framebuffer lacks a material executed-output delta", { executedOutputChangedPixelRatio });
  invariant(typedDelta.schemaVersion === 1 && typedDelta.status === "PASS" && typedDelta.minimum === 0.0005, "runtime framebuffer-delta gate did not pass", typedDelta);
  invariant(JSON.stringify(typedDelta.region) === JSON.stringify(FOOT_OUTPUT_REGION), "runtime framebuffer-delta region differs from validation", typedDelta.region);
  invariant(Math.abs(typedDelta.ratio - executedOutputChangedPixelRatio) < Number.EPSILON, "recorded runtime framebuffer delta differs from validation", { recorded: typedDelta.ratio, validated: executedOutputChangedPixelRatio });

  const qmp = parseQmpLog(qmpText);
  invariant(qmp.some((entry) => entry.direction === "receive" && entry.payload?.QMP?.version), "QMP greeting is missing");
  const actions = qmpActionSessions(qmp);
  invariant(actions.length === 8 + run.inputEnterAttempts, `unexpected QMP action-session count: ${actions.length}`);
  let actionIndex = 0;
  invariant(exactSingleAction(actions[actionIndex++], "query-status"), "QMP action 1 was not the initial status query");
  invariant(exactSingleAction(actions[actionIndex++], "screendump", { filename: path.join(evidence, "desktop-before.ppm"), format: "ppm" }), "QMP action 2 was not the pre-Foot screendump");
  invariant(exactSingleAction(actions[actionIndex++], "send-key", { keys: [{ type: "qcode", data: "meta_l" }, { type: "qcode", data: "ret" }], "hold-time": 100 }), "QMP action 3 was not the exact Super+Return binding");
  invariant(exactSingleAction(actions[actionIndex++], "screendump", { filename: path.join(evidence, "desktop-foot-open.ppm"), format: "ppm" }), "QMP action 4 was not the opened-Foot screendump");
  invariant(exactExplicitAction(actions[actionIndex++], FOOT_PROOF_COMMAND), "QMP action 5 was not the exact explicit Foot command");
  invariant(exactSingleAction(actions[actionIndex++], "screendump", { filename: path.join(evidence, "desktop-foot-typed.ppm"), format: "ppm" }), "QMP action 6 was not the synchronized pre-submit screendump");
  for (let attempt = 0; attempt < run.inputEnterAttempts; attempt += 1) {
    invariant(exactExplicitAction(actions[actionIndex++], "\n"), `QMP submit attempt ${attempt + 1} was not an explicit Enter down/up pair`);
  }
  invariant(exactSingleAction(actions[actionIndex++], "screendump", { filename: path.join(evidence, "desktop-foot.ppm"), format: "ppm" }), "QMP completed-output screendump was out of order");
  invariant(exactSingleAction(actions[actionIndex++], "quit"), "QMP graceful quit was missing or out of order");
  invariant(actionIndex === actions.length, "QMP log contains an unreviewed trailing action");
  invariant(qmp.some((entry) => entry.direction === "receive" && entry.payload?.event === "SHUTDOWN" && entry.payload?.data?.guest === false && entry.payload?.data?.reason === "host-qmp-quit"), "QMP host-quit shutdown event is missing");
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
    "desktop-foot-typed.ppm",
    "desktop-foot.ppm",
    "typed-frame-delta.json",
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
      footTyped: { nonBlackRatio: footTyped.nonBlackRatio, meanChannel: footTyped.meanChannel, sampledUniqueColors: footTyped.sampledUniqueColors },
      foot: { nonBlackRatio: foot.nonBlackRatio, meanChannel: foot.meanChannel, sampledUniqueColors: foot.sampledUniqueColors },
      openChangedPixelRatio,
      commandTypedChangedPixelRatio,
      finalChangedPixelRatio,
      typedChangedPixelRatio,
      executedOutputChangedPixelRatio,
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
