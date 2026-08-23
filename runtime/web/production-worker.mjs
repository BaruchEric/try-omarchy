import {
  dispatchSanitizedWorkerInput,
  dispatchSanitizedWorkerInputWithReceipt,
  sanitizeWorkerInput,
} from "./worker-input.mjs";
import {
  createBrowserPerformanceRuntimeController,
  normalizeBrowserPerformanceCommand,
} from "./browser-performance-runtime.mjs";
import {
  createPagedDiskPreRun,
  preflightPagedDisk,
  preparePagedDisk,
} from "../../storage/paged-disk.mjs";

const SHA256 = /^[a-f0-9]{64}$/i;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_MODULE_BYTES = 4 * 1024 * 1024;
const MAX_WASM_BYTES = 64 * 1024 * 1024;
const MAX_FIRMWARE_BYTES = 16 * 1024 * 1024;
const MAX_KERNEL_BYTES = 128 * 1024 * 1024;
const MAX_INITRAMFS_BYTES = 512 * 1024 * 1024;
const MAX_BOOTSTRAP_BYTES = 128 * 1024 * 1024;
const CHECKPOINT_TOTAL_CACHE_BYTES = 128 * 1024 * 1024;
const CHECKPOINT_ROOTFS_CACHE_BYTES = 88 * 1024 * 1024;
const CHECKPOINT_DELTA_CACHE_BYTES = 32 * 1024 * 1024;
const CHECKPOINT_VMSTATE_CACHE_BYTES = 8 * 1024 * 1024;
const CHECKPOINT_VMSTATE_CHUNK_BYTES = 8 * 1024 * 1024;
const GUEST_REPORT_PREFIX = "OMARCHY_GUEST_REPORT ";
const GUEST_STAGE_PREFIX = "OMARCHY_GUEST_STAGE ";
const RUNTIME_DIAGNOSTIC_PREFIX = "OMARCHY_RUNTIME_DIAGNOSTIC ";
const DESKTOP_PROOF_ACK_PREFIX = "omarchy-input-ack-";
const DESKTOP_PROOF_ACK_HEX = /^[a-f0-9]{32}$/;
const MAX_DESKTOP_PROOF_ACK_LINE_BYTES = 64;
const DESKTOP_PROOF_SAMPLE_COUNT = 32 * 18;
const DESKTOP_PROOF_MIN_CHANGED_PIXELS = 29;
const DESKTOP_PROOF_MAX_DOMINANT_PIXELS = 547;
const DESKTOP_PROOF_STAGE_TIMEOUT_MS = 90_000;
const DESKTOP_PROOF_RESPONSE_TIMEOUT_MS = 180_000;
const DESKTOP_PROOF_INPUT_PACING_MS = 40;
const QEMU_RUNNING_TIMEOUT_MS = 120_000;
const QEMU_RUNNING_POLL_MS = 25;
const CHECKPOINT_DESKTOP_SETTLE_MIN_RUNNING_MS = 15_000;
const CHECKPOINT_DESKTOP_SETTLE_MIN_FRAME_GAP_MS = 5_000;
const CHECKPOINT_DESKTOP_SETTLE_TIMEOUT_MS = 180_000;
const MAX_DEFERRED_HOST_INPUTS = 128;
const DESKTOP_PROOF_FRAME_NONE = 0;
const DESKTOP_PROOF_FRAME_BASELINE = 1;
const DESKTOP_PROOF_FRAME_RESPONSE = 2;
const MAX_GUEST_STAGE_LINE_BYTES = 2048;
const MAX_GUEST_STAGE_MESSAGE_BYTES = 512;
const GUEST_STAGE_KEYS = Object.freeze([
  "attempt", "message", "monotonicMs", "schemaVersion", "sequence", "stage", "status",
]);
const GUEST_STAGE_NAMES = new Set(["autologin", "uwsm", "hyprland", "quickshell", "report"]);
const GUEST_STAGE_STATUSES = new Set(["started", "waiting", "ready", "failed"]);
const OFFICIAL_OMARCHY_REPOSITORY = "https://github.com/basecamp/omarchy";
const COMMIT = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const CANONICAL_PRODUCTION_MANIFEST = deepFreeze({
  schemaVersion: 2,
  name: "Omarchy browser demo",
  runtimeMode: "worker-paged",
  display: { width: 1600, height: 900, devicePixelRatioCap: 2 },
  assets: {
    module: "qemu.mjs",
    hostWorker: "production-worker.mjs",
    workerInput: "worker-input.mjs",
    pagedDisk: "paged-disk.mjs",
    boundedOverlay: "bounded-overlay.mjs",
    locate: {
      "qemu-system-x86_64.wasm": "qemu.wasm",
      "qemu-system-x86_64.worker.js": "qemu.worker.js",
    },
    firmware: {
      "bios-256k.bin": "firmware/bios-256k.bin",
      "vgabios-virtio.bin": "firmware/vgabios-virtio.bin",
      "kvmvapic.bin": "firmware/kvmvapic.bin",
      "linuxboot_dma.bin": "firmware/linuxboot_dma.bin",
    },
  },
  guest: {
    rootfs: { artifactPath: "rootfs.ext4", mountPath: "/pack/rootfs.ext4" },
    kernel: { artifactPath: "vmlinuz-linux", mountPath: "/pack/vmlinuz-linux" },
    initramfs: { artifactPath: "initramfs-linux.img", mountPath: "/pack/initramfs-linux.img" },
  },
  qemu: {
    memoryMiB: 1024,
    cores: 2,
    arguments: [
      "-machine", "pc-q35-8.2",
      "-m", "1024M",
      "-accel", "tcg,tb-size=128,thread=multi",
      "-smp", "2,sockets=1,cores=2,threads=1",
      "-L", "/pack",
      "-display", "sdl,gl=off,show-cursor=on",
      "-device", "virtio-vga,max_outputs=1,xres=1600,yres=900",
      "-device", "virtio-keyboard-pci",
      "-device", "virtio-tablet-pci",
      "-kernel", "/pack/vmlinuz-linux",
      "-initrd", "/pack/initramfs-linux.img",
      "-append",
      "root=/dev/vda rw rootwait console=tty0 console=ttyS0,115200n8 loglevel=4 systemd.show_status=false rd.systemd.show_status=false mitigations=off nowatchdog omarchy.web_demo=1",
      "-device", "virtio-serial-pci",
      "-chardev", "stdio,id=omarchy-diag,mux=on",
      "-serial", "chardev:omarchy-diag",
      "-device", "virtserialport,chardev=omarchy-diag,name=omarchy.web.diagnostics",
      "-monitor", "none",
      "-parallel", "none",
      "-nic", "none",
      "-no-reboot",
    ],
  },
});

export function qemuGeneratedAssetNames(manifest) {
  const names = Object.freeze({
    architecture: "x86_64",
    wasm: "qemu-system-x86_64.wasm",
    pthread: "qemu-system-x86_64.worker.js",
  });
  if (!isRecord(manifest?.assets?.locate) ||
      manifest.assets.locate[names.wasm] !== "qemu.wasm" ||
      manifest.assets.locate[names.pthread] !== "qemu.worker.js" ||
      Object.keys(manifest.assets.locate).length !== 2) {
    fail("INVALID_RUNTIME_MANIFEST", "Runtime executable mapping is invalid for x86_64.");
  }
  return names;
}

export const CANONICAL_PAGED_DISK_ARGUMENTS = deepFreeze([
  "-snapshot",
  "-drive",
  "file=/pack/rootfs.ext4,if=virtio,format=raw,media=disk,cache=unsafe",
]);

export const CANONICAL_CHECKPOINT_IDENTITY = deepFreeze({
  baseGuestManifestSha256: "55aecd33a4e285f4caba5c565cde0831e8a556cb6160bb2dbf6173d915ff3d37",
  rootfsSha256: "db677ce248761affd81967501fc21fd3687d2ca8c1644499268a5c3dc39e7cac",
  guestProvenanceSha256: "527c0e84e7594a44363cc7ff3ac2b5c871643a3eeb86ba104ed9be4040d0d738",
  browserQemuWasmSha256: "c49072051ba41f5edc9c5044ff3623563aa9088314b0e63207f53d36b3a7dae8",
  qemu: {
    repository: "https://github.com/ktock/qemu-wasm.git",
    sourceCommit: "0ef7b4e2814b231705d8371dd7997f5b72e70baf",
    version: "8.2.0",
  },
  machine: {
    type: "pc-q35-8.2",
    memoryMiB: 1024,
    smp: "2,sockets=1,cores=2,threads=1",
    accel: "tcg,tb-size=128,thread=multi",
  },
});

export const CANONICAL_CHECKPOINT_ARGUMENTS = deepFreeze([
  "-snapshot",
  "-drive",
  "file=/pack/checkpoint-overlay.qcow2,if=virtio,format=qcow2,media=disk,cache=unsafe",
  "-incoming",
  "file:/pack/omarchy-preboot.vmstate",
]);

export class ProductionWorkerError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ProductionWorkerError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new ProductionWorkerError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedJsonValue(value, depth = 0) {
  if (depth > 16) fail("INVALID_NORMALIZED_JSON", "Checkpoint evidence exceeds the JSON depth bound.");
  if (Array.isArray(value)) return value.map((item) => normalizedJsonValue(item, depth + 1));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, normalizedJsonValue(value[key], depth + 1)]),
    );
  }
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))) return value;
  fail("INVALID_NORMALIZED_JSON", "Checkpoint evidence contains a non-JSON value.");
}

export function normalizedJsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(normalizedJsonValue(value)));
}

function exactObjectKeys(value, expected, label) {
  if (!isRecord(value)) fail("CHECKPOINT_SOURCE_EVIDENCE_INVALID", `${label} must be an object.`);
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  if (actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index])) {
    fail("CHECKPOINT_SOURCE_EVIDENCE_INVALID", `${label} contains unexpected or missing keys.`, {
      expected: expectedKeys,
      actual: actualKeys,
    });
  }
}

function validateCheckpointSourceGuestReport(report, expectedUpstream) {
  exactObjectKeys(report, [
    "schemaVersion", "generatedAt", "provenance", "system", "components",
    "processes", "commands", "configs",
  ], "Checkpoint source guest report");
  if (report.schemaVersion !== 1 || typeof report.generatedAt !== "string" ||
      report.generatedAt.length > 64 || Number.isNaN(Date.parse(report.generatedAt))) {
    fail("CHECKPOINT_SOURCE_EVIDENCE_INVALID", "Checkpoint source guest report header is invalid.");
  }
  assertGuestReportProvenance(report, expectedUpstream);
  exactObjectKeys(report.system, ["architecture", "distribution", "kernel", "sessionType"],
    "Checkpoint source system identity");
  if (report.system.architecture !== "x86_64" || report.system.distribution !== "Arch Linux" ||
      report.system.sessionType !== "wayland" || typeof report.system.kernel !== "string" ||
      report.system.kernel.length === 0 || report.system.kernel.length > 128) {
    fail("CHECKPOINT_SOURCE_EVIDENCE_INVALID", "Checkpoint source system identity is invalid.");
  }
  if (!Array.isArray(report.components) || report.components.length === 0 || report.components.length > 16 ||
      !Array.isArray(report.processes) || report.processes.length === 0 || report.processes.length > 64 ||
      !Array.isArray(report.commands) || report.commands.length === 0 || report.commands.length > 32 ||
      !Array.isArray(report.configs) || report.configs.length === 0 || report.configs.length > 128) {
    fail("CHECKPOINT_SOURCE_EVIDENCE_INVALID", "Checkpoint source guest report arrays are invalid.");
  }
  const compositor = report.components.find((component) => component?.role === "compositor");
  const shell = report.components.find((component) => component?.role === "shell");
  const hyprlandProcess = report.processes.find((process) =>
    process?.name?.toLowerCase?.() === "hyprland" && Number.isSafeInteger(process.pid) && process.pid > 1);
  const shellProcess = report.processes.find((process) =>
    typeof shell?.name === "string" && process?.name?.toLowerCase?.().includes(shell.name.toLowerCase()) &&
    Number.isSafeInteger(process.pid) && process.pid > 1);
  if (compositor?.name?.toLowerCase?.() !== "hyprland" ||
      typeof compositor.version !== "string" || !compositor.executable?.startsWith?.("/") ||
      typeof shell?.name !== "string" || typeof shell.version !== "string" ||
      !shell.executable?.startsWith?.("/") || !hyprlandProcess || !shellProcess) {
    fail("CHECKPOINT_SOURCE_EVIDENCE_INVALID", "Checkpoint source desktop components are invalid.");
  }
  const commands = new Map(report.commands.map((command) => [command?.argv?.join?.(" "), command]));
  for (const name of ["uname -m", "hyprctl version", "hyprctl monitors -j", "omarchy-version"]) {
    const command = commands.get(name);
    if (command?.exitCode !== 0 || typeof command.stdout !== "string" || typeof command.stderr !== "string") {
      fail("CHECKPOINT_SOURCE_EVIDENCE_INVALID", `Checkpoint source command failed: ${name}.`);
    }
  }
  if (commands.get("uname -m").stdout.trim() !== "x86_64" ||
      !/hyprland/i.test(commands.get("hyprctl version").stdout) ||
      !commands.get("omarchy-version").stdout.includes(expectedUpstream.version)) {
    fail("CHECKPOINT_SOURCE_EVIDENCE_INVALID", "Checkpoint source command identity is invalid.");
  }
  let monitors;
  try {
    monitors = JSON.parse(commands.get("hyprctl monitors -j").stdout)
      .filter((monitor) => monitor?.disabled !== true);
  } catch {
    fail("CHECKPOINT_SOURCE_EVIDENCE_INVALID", "Checkpoint source monitor evidence is invalid JSON.");
  }
  if (monitors.length !== 1 || monitors[0].width !== 1600 || monitors[0].height !== 900) {
    fail("CHECKPOINT_SOURCE_EVIDENCE_INVALID", "Checkpoint source monitor is not exactly 1600x900.");
  }
  if (!report.configs.every((config) => isRecord(config) && config.path?.startsWith?.("/") &&
      SHA256.test(config.sha256 ?? "") && config.sha256 === config.sha256.toLowerCase() &&
      config.origin === "omarchy-upstream")) {
    fail("CHECKPOINT_SOURCE_EVIDENCE_INVALID", "Checkpoint source configuration evidence is invalid.");
  }
  return report;
}

export function validateCheckpointSourceEvidenceShape(sourceEvidence) {
  exactObjectKeys(sourceEvidence, [
    "guestReport", "normalizedGuestReportSha256", "reportValidationSha256",
    "checkpointFrameSha256", "checkpointFrameHealthSha256",
  ], "Checkpoint source evidence");
  if (!isRecord(sourceEvidence.guestReport) || [
    "normalizedGuestReportSha256", "reportValidationSha256",
    "checkpointFrameSha256", "checkpointFrameHealthSha256",
  ].some((key) => !SHA256.test(sourceEvidence[key] ?? "") ||
    sourceEvidence[key] !== sourceEvidence[key].toLowerCase())) {
    fail("CHECKPOINT_SOURCE_EVIDENCE_INVALID", "Checkpoint source evidence digests are invalid.");
  }
  return sourceEvidence;
}

export async function validateCheckpointSourceEvidence(
  sourceEvidence,
  expectedUpstream,
  scope = globalThis,
) {
  validateCheckpointSourceEvidenceShape(sourceEvidence);
  validateCheckpointSourceGuestReport(sourceEvidence.guestReport, expectedUpstream);
  const digest = await sha256Hex(normalizedJsonBytes(sourceEvidence.guestReport), scope);
  if (digest !== sourceEvidence.normalizedGuestReportSha256) {
    fail("CHECKPOINT_SOURCE_EVIDENCE_INVALID", "Checkpoint source guest report digest is invalid.");
  }
  return sourceEvidence;
}

export function parseGuestReportLine(line) {
  if (typeof line !== "string") return null;
  const marker = line.indexOf(GUEST_REPORT_PREFIX);
  if (marker < 0) return null;
  if (line.indexOf(GUEST_REPORT_PREFIX, marker + GUEST_REPORT_PREFIX.length) >= 0) {
    throw new SyntaxError("Guest report line contains more than one evidence marker.");
  }

  const payloadStart = marker + GUEST_REPORT_PREFIX.length;
  const lineEnd = line.slice(payloadStart).search(/[\r\n]/);
  const payloadEnd = lineEnd < 0 ? line.length : payloadStart + lineEnd;
  const trailing = line.slice(payloadEnd);
  if (/[^\r\n]/.test(trailing)) {
    throw new SyntaxError("Guest report line contains data after its line ending.");
  }

  const payload = JSON.parse(line.slice(payloadStart, payloadEnd));
  if (!isRecord(payload)) throw new TypeError("Guest report payload must be a JSON object.");
  return payload;
}

export function validateGuestStage(stage, previous = null) {
  if (!isRecord(stage)) throw new TypeError("Guest stage payload must be a JSON object.");
  const keys = Object.keys(stage).sort();
  if (keys.length !== GUEST_STAGE_KEYS.length ||
      keys.some((key, index) => key !== GUEST_STAGE_KEYS[index])) {
    throw new TypeError("Guest stage payload must contain exactly the documented keys.");
  }
  if (stage.schemaVersion !== 1 || !Number.isSafeInteger(stage.sequence) || stage.sequence <= 0 ||
      !Number.isSafeInteger(stage.monotonicMs) || stage.monotonicMs < 0 ||
      !GUEST_STAGE_NAMES.has(stage.stage) || !GUEST_STAGE_STATUSES.has(stage.status) ||
      !Number.isSafeInteger(stage.attempt) || stage.attempt <= 0 || typeof stage.message !== "string") {
    throw new TypeError("Guest stage payload contains an invalid field value.");
  }
  if (/[\r\n]/.test(stage.message) ||
      new TextEncoder().encode(stage.message).byteLength > MAX_GUEST_STAGE_MESSAGE_BYTES) {
    throw new TypeError("Guest stage message must be a single line no longer than 512 UTF-8 bytes.");
  }
  if (previous !== null) {
    if (!isRecord(previous) || stage.sequence <= previous.sequence) {
      throw new RangeError("Guest stage sequence must increase strictly.");
    }
    if (stage.monotonicMs <= previous.monotonicMs) {
      throw new RangeError("Guest stage monotonicMs must increase strictly.");
    }
  }
  return Object.freeze({ ...stage });
}

export function parseGuestStageLine(line, previous = null) {
  if (typeof line !== "string") return null;
  const marker = line.indexOf(GUEST_STAGE_PREFIX);
  if (marker < 0) return null;
  if (new TextEncoder().encode(line).byteLength > MAX_GUEST_STAGE_LINE_BYTES) {
    throw new RangeError("Guest stage line exceeds its bounded protocol size.");
  }
  if (line.indexOf(GUEST_STAGE_PREFIX, marker + GUEST_STAGE_PREFIX.length) >= 0) {
    throw new SyntaxError("Guest stage line contains more than one diagnostic marker.");
  }

  const payloadStart = marker + GUEST_STAGE_PREFIX.length;
  const lineEnd = line.slice(payloadStart).search(/[\r\n]/);
  const payloadEnd = lineEnd < 0 ? line.length : payloadStart + lineEnd;
  if (/[^\r\n]/.test(line.slice(payloadEnd))) {
    throw new SyntaxError("Guest stage line contains data after its line ending.");
  }
  return validateGuestStage(JSON.parse(line.slice(payloadStart, payloadEnd)), previous);
}

export function parseDesktopProofAcknowledgementLine(line) {
  if (typeof line !== "string") return null;
  const marker = line.indexOf(DESKTOP_PROOF_ACK_PREFIX);
  if (marker < 0) return null;
  if (new TextEncoder().encode(line).byteLength > MAX_DESKTOP_PROOF_ACK_LINE_BYTES) {
    throw new RangeError("Desktop proof acknowledgement exceeds its bounded line size.");
  }
  if (marker !== 0 || line.indexOf(
    DESKTOP_PROOF_ACK_PREFIX,
    marker + DESKTOP_PROOF_ACK_PREFIX.length,
  ) >= 0) {
    throw new SyntaxError("Desktop proof acknowledgement must be the unique complete line payload.");
  }
  const lineEndingBytes = line.endsWith("\r\n") ? 2 :
    line.endsWith("\r") || line.endsWith("\n") ? 1 : 0;
  const acknowledgement = line.slice(0, line.length - lineEndingBytes);
  if (/[\r\n]/.test(acknowledgement)) {
    throw new SyntaxError("Desktop proof acknowledgement contains more than one line.");
  }
  if (!DESKTOP_PROOF_ACK_HEX.test(acknowledgement.slice(DESKTOP_PROOF_ACK_PREFIX.length)) ||
      acknowledgement.length !== DESKTOP_PROOF_ACK_PREFIX.length + 32) {
    throw new SyntaxError("Desktop proof acknowledgement has an invalid challenge token.");
  }
  return acknowledgement;
}

export function createDesktopProofChallenge(scope = globalThis) {
  if (typeof scope?.crypto?.getRandomValues !== "function" ||
      typeof scope?.crypto?.subtle?.digest !== "function") {
    fail("DESKTOP_PROOF_RANDOM_UNAVAILABLE", "Desktop proof requires browser cryptography.");
  }
  const random = new Uint8Array(16);
  scope.crypto.getRandomValues(random);
  const secret = [...random].map((value) => value.toString(16).padStart(2, "0")).join("");
  const acknowledgement = `${DESKTOP_PROOF_ACK_PREFIX}${secret}`;
  return Object.freeze({
    acknowledgement,
    challengeSha256: sha256Hex(new TextEncoder().encode(acknowledgement), scope),
  });
}

export function desktopProofCommand(acknowledgement) {
  if (typeof acknowledgement !== "string" ||
      !DESKTOP_PROOF_ACK_HEX.test(acknowledgement.slice(DESKTOP_PROOF_ACK_PREFIX.length)) ||
      acknowledgement.length !== DESKTOP_PROOF_ACK_PREFIX.length + 32) {
    fail("INVALID_DESKTOP_PROOF_CHALLENGE", "Desktop proof challenge is invalid.");
  }
  return `echo ${acknowledgement} > /dev/virtio-ports/omarchy.web.diagnostics`;
}

function desktopProofCharacterKey(character) {
  if (/^[a-z]$/.test(character)) {
    return { scancode: 4 + character.charCodeAt(0) - "a".charCodeAt(0), shift: false };
  }
  if (/^[1-9]$/.test(character)) {
    return { scancode: 29 + Number(character), shift: false };
  }
  if (character === "0") return { scancode: 39, shift: false };
  const punctuation = {
    " ": { scancode: 44, shift: false },
    "-": { scancode: 45, shift: false },
    ".": { scancode: 55, shift: false },
    "/": { scancode: 56, shift: false },
    ">": { scancode: 55, shift: true },
  };
  return punctuation[character] ?? null;
}

function keyEvent(scancode, down) {
  return Object.freeze({ kind: "key", scancode, down });
}

function monotonicNow(scope) {
  return scope.performance?.now?.() ?? Date.now();
}

export async function waitForQemuRunning(instance, {
  scope = globalThis,
  timeoutMs = QEMU_RUNNING_TIMEOUT_MS,
  pollMs = QEMU_RUNNING_POLL_MS,
} = {}) {
  const isRunning = instance?._omarchy_runtime_is_running;
  if (typeof isRunning !== "function") {
    fail("QEMU_RUNSTATE_BRIDGE_MISSING", "QEMU module is missing _omarchy_runtime_is_running.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ||
      !Number.isSafeInteger(pollMs) || pollMs <= 0 || pollMs > timeoutMs ||
      typeof scope.setTimeout !== "function") {
    fail("INVALID_QEMU_RUNSTATE_WAIT", "QEMU runstate wait configuration is invalid.");
  }
  const startedAt = monotonicNow(scope);
  let checks = 0;
  while (true) {
    checks += 1;
    const status = isRunning.call(instance);
    const elapsedMs = Math.max(0, monotonicNow(scope) - startedAt);
    if (status === 1) return Object.freeze({ checks, elapsedMs });
    if (status !== 0) {
      fail("INVALID_QEMU_RUNSTATE", `QEMU runstate bridge returned invalid status ${status}.`);
    }
    if (elapsedMs >= timeoutMs) {
      fail(
        "QEMU_RUNNING_TIMEOUT",
        "QEMU did not enter running state within the bounded resume window.",
        { checks, elapsedMs, timeoutMs },
      );
    }
    await new Promise((resolve) => scope.setTimeout(resolve, pollMs));
  }
}

export class CheckpointDesktopSettleGate {
  #scope;
  #onReady;
  #onFailure;
  #onProgress;
  #minRunningMs;
  #minFrameGapMs;
  #timeoutMs;
  #state = "idle";
  #runningAt = null;
  #firstFrame = null;
  #timer = null;

  constructor({
    scope = globalThis,
    onReady,
    onFailure,
    onProgress = () => {},
    minRunningMs = CHECKPOINT_DESKTOP_SETTLE_MIN_RUNNING_MS,
    minFrameGapMs = CHECKPOINT_DESKTOP_SETTLE_MIN_FRAME_GAP_MS,
    timeoutMs = CHECKPOINT_DESKTOP_SETTLE_TIMEOUT_MS,
  } = {}) {
    if (typeof onReady !== "function" || typeof onFailure !== "function" ||
        typeof onProgress !== "function" || typeof scope.setTimeout !== "function" ||
        typeof scope.clearTimeout !== "function" ||
        !Number.isSafeInteger(minRunningMs) || minRunningMs < 0 ||
        !Number.isSafeInteger(minFrameGapMs) || minFrameGapMs <= 0 ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs <= minRunningMs + minFrameGapMs) {
      fail("INVALID_CHECKPOINT_DESKTOP_SETTLE", "Checkpoint desktop settle configuration is invalid.");
    }
    this.#scope = scope;
    this.#onReady = onReady;
    this.#onFailure = onFailure;
    this.#onProgress = onProgress;
    this.#minRunningMs = minRunningMs;
    this.#minFrameGapMs = minFrameGapMs;
    this.#timeoutMs = timeoutMs;
  }

  get state() {
    return this.#state;
  }

  get blocksHostInput() {
    return this.#state === "settling";
  }

  beginAfterRunning() {
    if (this.#state !== "idle") {
      fail("CHECKPOINT_DESKTOP_SETTLE_REPLAY", "Checkpoint desktop settle can only begin once.");
    }
    this.#state = "settling";
    this.#runningAt = monotonicNow(this.#scope);
    this.#onProgress(Object.freeze({
      stage: "start",
      minRunningMs: this.#minRunningMs,
      minFrameGapMs: this.#minFrameGapMs,
      timeoutMs: this.#timeoutMs,
    }));
    this.#timer = this.#scope.setTimeout(() => {
      if (this.#state !== "settling") return;
      this.#timer = null;
      this.#state = "failed";
      this.#onFailure(new ProductionWorkerError(
        "CHECKPOINT_DESKTOP_SETTLE_TIMEOUT",
        "The resumed checkpoint did not produce two settled 1600x900 desktop frames in time.",
        {
          timeoutMs: this.#timeoutMs,
          firstFrameSequence: this.#firstFrame?.sequence ?? null,
        },
      ));
    }, this.#timeoutMs);
    return true;
  }

  handleFrame(frame, observedAt = monotonicNow(this.#scope)) {
    if (this.#state !== "settling") return false;
    if (!Number.isFinite(observedAt) || observedAt < this.#runningAt) {
      fail("INVALID_CHECKPOINT_DESKTOP_SETTLE_TIME", "Checkpoint desktop frame time is invalid.");
    }
    const healthy = Number.isSafeInteger(frame?.sequence) && frame.sequence > 0 &&
      frame.guestWidth === 1600 && frame.guestHeight === 900 &&
      frame.sampledPixels === DESKTOP_PROOF_SAMPLE_COUNT && frame.nonBlackPixels > 0 &&
      frame.proofFrame === DESKTOP_PROOF_FRAME_NONE;
    if (!healthy) return false;

    const runningElapsedMs = observedAt - this.#runningAt;
    if (this.#firstFrame === null) {
      this.#firstFrame = Object.freeze({ sequence: frame.sequence, observedAt });
      this.#onProgress(Object.freeze({
        stage: "first-frame",
        sequence: frame.sequence,
        runningElapsedMs,
      }));
      return false;
    }

    const frameGapMs = observedAt - this.#firstFrame.observedAt;
    if (frame.sequence <= this.#firstFrame.sequence ||
        runningElapsedMs < this.#minRunningMs || frameGapMs < this.#minFrameGapMs) {
      return false;
    }
    this.#scope.clearTimeout(this.#timer);
    this.#timer = null;
    this.#state = "ready";
    const evidence = Object.freeze({
      firstFrameSequence: this.#firstFrame.sequence,
      secondFrameSequence: frame.sequence,
      runningElapsedMs,
      frameGapMs,
    });
    this.#onProgress(Object.freeze({ stage: "ready", ...evidence }));
    this.#onReady(evidence);
    return true;
  }
}

export function desktopProofTextInputEvents(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 160) {
    fail("INVALID_DESKTOP_PROOF_TEXT", "Desktop proof input text is outside its fixed bound.");
  }
  const events = [];
  for (const character of text) {
    const key = desktopProofCharacterKey(character);
    if (!key) fail("INVALID_DESKTOP_PROOF_TEXT", "Desktop proof input contains an unsupported key.");
    if (key.shift) events.push(keyEvent(225, true));
    events.push(keyEvent(key.scancode, true), keyEvent(key.scancode, false));
    if (key.shift) events.push(keyEvent(225, false));
  }
  return Object.freeze(events);
}

export function normalizeNativeGuestFrame({
  guestWidth,
  guestHeight,
  sampledPixels,
  nonBlackPixels,
  proofFrame,
  changedPixels,
  dominantPixels,
}) {
  if (!Number.isSafeInteger(guestWidth) || guestWidth <= 0 || guestWidth > 16_384 ||
      !Number.isSafeInteger(guestHeight) || guestHeight <= 0 || guestHeight > 16_384 ||
      !Number.isSafeInteger(sampledPixels) || sampledPixels < 0 ||
      sampledPixels > DESKTOP_PROOF_SAMPLE_COUNT ||
      !Number.isSafeInteger(nonBlackPixels) || nonBlackPixels < 0 ||
      nonBlackPixels > sampledPixels ||
      ![DESKTOP_PROOF_FRAME_NONE, DESKTOP_PROOF_FRAME_BASELINE,
        DESKTOP_PROOF_FRAME_RESPONSE].includes(proofFrame) ||
      !Number.isSafeInteger(changedPixels) || changedPixels < 0 ||
      changedPixels > DESKTOP_PROOF_SAMPLE_COUNT ||
      !Number.isSafeInteger(dominantPixels) || dominantPixels < 0 ||
      dominantPixels > DESKTOP_PROOF_SAMPLE_COUNT) {
    fail("INVALID_GUEST_FRAME", "QEMU emitted malformed framebuffer evidence.");
  }
  if (proofFrame !== DESKTOP_PROOF_FRAME_NONE &&
      (guestWidth !== 1600 || guestHeight !== 900 ||
       sampledPixels !== DESKTOP_PROOF_SAMPLE_COUNT)) {
    fail("INVALID_DESKTOP_PROOF_FRAME", "Desktop proof frame has the wrong dimensions or sample count.");
  }
  if (proofFrame === DESKTOP_PROOF_FRAME_BASELINE &&
      (changedPixels !== 0 || dominantPixels !== 0)) {
    fail("INVALID_DESKTOP_PROOF_FRAME", "Desktop proof baseline contains response-only metrics.");
  }
  if (proofFrame === DESKTOP_PROOF_FRAME_RESPONSE &&
      (changedPixels < DESKTOP_PROOF_MIN_CHANGED_PIXELS ||
       dominantPixels < 1 ||
       dominantPixels > DESKTOP_PROOF_MAX_DOMINANT_PIXELS)) {
    fail("INVALID_DESKTOP_PROOF_FRAME", "Desktop proof response does not contain a material visual delta.");
  }
  return Object.freeze({
    guestWidth,
    guestHeight,
    sampledPixels,
    nonBlackPixels,
    proofFrame,
    changedPixels,
    dominantPixels,
  });
}

export function nextPublicNativeGuestFrame(previousSequence, nativeFrame) {
  if (!Number.isSafeInteger(previousSequence) || previousSequence < 0) {
    fail("INVALID_GUEST_FRAME_SEQUENCE", "QEMU guest frame sequence is invalid.");
  }
  const frame = normalizeNativeGuestFrame(nativeFrame);
  if (frame.proofFrame === DESKTOP_PROOF_FRAME_NONE &&
      (frame.guestWidth !== 1600 || frame.guestHeight !== 900 ||
       frame.sampledPixels !== DESKTOP_PROOF_SAMPLE_COUNT)) {
    return null;
  }
  return Object.freeze({ sequence: previousSequence + 1, ...frame });
}

function safeRelativePath(value, label = "asset path") {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") ||
      value.includes("\\") || value.includes("\0") || value.split("/").includes("..") ||
      value.split("/").includes("")) {
    fail("INVALID_PATH", `${label} must be a safe relative path.`, { value });
  }
  return value;
}

function exactProfileMismatch(path, expected, actual) {
  fail(
    "INVALID_RUNTIME_MANIFEST",
    `Production runtime profile differs from the canonical profile at ${path}.`,
    { path, expected, actual },
  );
}

function assertExactProfile(actual, expected, path = "manifest") {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) exactProfileMismatch(path, expected, actual);
    if (actual.length !== expected.length) {
      exactProfileMismatch(`${path}.length`, expected.length, actual.length);
    }
    for (let index = 0; index < expected.length; index += 1) {
      assertExactProfile(actual[index], expected[index], `${path}[${index}]`);
    }
    return;
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) exactProfileMismatch(path, expected, actual);
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    if (actualKeys.length !== expectedKeys.length ||
        actualKeys.some((key, index) => key !== expectedKeys[index])) {
      exactProfileMismatch(`${path} keys`, expectedKeys, actualKeys);
    }
    for (const key of expectedKeys) assertExactProfile(actual[key], expected[key], `${path}.${key}`);
    return;
  }
  if (!Object.is(actual, expected)) exactProfileMismatch(path, expected, actual);
}

function validateCheckpointFile(value, expected, label) {
  if (!isRecord(value)) exactProfileMismatch(`manifest.checkpoint.${label}`, expected, value);
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index])) {
    exactProfileMismatch(`manifest.checkpoint.${label} keys`, expectedKeys, actualKeys);
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue === "<positive-safe-integer>") {
      if (!Number.isSafeInteger(value[key]) || value[key] <= 0) {
        exactProfileMismatch(`manifest.checkpoint.${label}.${key}`, expectedValue, value[key]);
      }
    } else if (expectedValue === "<sha256>") {
      if (!SHA256.test(value[key] ?? "") || value[key] !== value[key].toLowerCase()) {
        exactProfileMismatch(`manifest.checkpoint.${label}.${key}`, expectedValue, value[key]);
      }
    } else if (expectedValue === "<uuid>") {
      if (!UUID.test(value[key] ?? "") || value[key] !== value[key].toLowerCase()) {
        exactProfileMismatch(`manifest.checkpoint.${label}.${key}`, expectedValue, value[key]);
      }
    } else if (!Object.is(value[key], expectedValue)) {
      exactProfileMismatch(`manifest.checkpoint.${label}.${key}`, expectedValue, value[key]);
    }
  }
  return value;
}

export function validateCheckpointProfile(checkpoint) {
  if (!isRecord(checkpoint)) {
    exactProfileMismatch("manifest.checkpoint", "canonical checkpoint profile", checkpoint);
  }
  const expectedKeys = ["bootDelta", "identity", "mode", "producer", "schemaVersion", "vmstate"];
  const actualKeys = Object.keys(checkpoint).sort();
  if (actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index])) {
    exactProfileMismatch("manifest.checkpoint keys", expectedKeys, actualKeys);
  }
  if (checkpoint.schemaVersion !== 1 || checkpoint.mode !== "preboot-resume") {
    exactProfileMismatch(
      "manifest.checkpoint mode",
      { schemaVersion: 1, mode: "preboot-resume" },
      { schemaVersion: checkpoint.schemaVersion, mode: checkpoint.mode },
    );
  }
  validateCheckpointFile(checkpoint.vmstate, {
    artifactPath: "omarchy-preboot.vmstate",
    mountPath: "/pack/omarchy-preboot.vmstate",
    bytes: "<positive-safe-integer>",
    sha256: "<sha256>",
    format: "qemu-8.2-migration",
    compression: "none",
    incomingMode: "file",
  }, "vmstate");
  validateCheckpointFile(checkpoint.bootDelta, {
    artifactPath: "checkpoint-overlay.qcow2",
    mountPath: "/pack/checkpoint-overlay.qcow2",
    bytes: "<positive-safe-integer>",
    sha256: "<sha256>",
    format: "qcow2",
    backingFilename: "rootfs.ext4",
    backingFormat: "raw",
  }, "bootDelta");
  validateCheckpointFile(checkpoint.producer, {
    manifestArtifactPath: "checkpoint-manifest.json",
    manifestBytes: "<positive-safe-integer>",
    manifestSha256: "<sha256>",
    qemuBinarySha256: "<sha256>",
  }, "producer");
  if (!isRecord(checkpoint.identity)) {
    exactProfileMismatch("manifest.checkpoint.identity", CANONICAL_CHECKPOINT_IDENTITY, checkpoint.identity);
  }
  assertExactProfile(checkpoint.identity, CANONICAL_CHECKPOINT_IDENTITY, "manifest.checkpoint.identity");
  return checkpoint;
}

export function validateCheckpointProducerDocument(value, checkpoint) {
  validateCheckpointProfile(checkpoint);
  if (!isRecord(value)) {
    fail("CHECKPOINT_PROVENANCE_MISMATCH", "Checkpoint producer manifest must be an object.");
  }
  validateCheckpointSourceEvidenceShape(value.sourceEvidence);
  const comparableValue = { ...value };
  delete comparableValue.sourceEvidence;
  const expected = {
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
    producer: {
      qemuBinarySha256: checkpoint.producer.qemuBinarySha256,
    },
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
  };
  try {
    assertExactProfile(comparableValue, expected, "checkpoint producer manifest");
  } catch (error) {
    if (error instanceof ProductionWorkerError) {
      fail(
        "CHECKPOINT_PROVENANCE_MISMATCH",
        "Checkpoint producer manifest does not match the canonical runtime checkpoint contract.",
        { cause: serializeError(error) },
      );
    }
    throw error;
  }
  return value;
}

export function validateCheckpointGuestManifestDocument(value, checkpoint, expectedUpstream) {
  try {
    if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.artifacts)) {
      fail("CHECKPOINT_GUEST_MISMATCH", "Checkpoint guest manifest has an invalid schema.");
    }
    const upstream = releaseIdentityFromArtifactManifest(value);
    assertGuestReportProvenance({ provenance: upstream }, expectedUpstream);
    const artifacts = validateArtifactManifest(value);
    const rootfs = artifactAt(artifacts, "rootfs.ext4");
    const provenance = artifactAt(artifacts, "provenance.json");
    if (rootfs.sha256 !== checkpoint.identity.rootfsSha256 ||
        provenance.sha256 !== checkpoint.identity.guestProvenanceSha256) {
      fail("CHECKPOINT_GUEST_MISMATCH", "Checkpoint guest manifest contents are not canonical.");
    }
  } catch (error) {
    if (error instanceof ProductionWorkerError && error.code === "CHECKPOINT_GUEST_MISMATCH") {
      throw error;
    }
    fail("CHECKPOINT_GUEST_MISMATCH", "Checkpoint guest manifest does not match the verified release.", {
      cause: serializeError(error),
    });
  }
  return value;
}

export function validateProductionManifest(manifest) {
  if (!isRecord(manifest) || !("checkpoint" in manifest)) {
    assertExactProfile(manifest, CANONICAL_PRODUCTION_MANIFEST);
    qemuGeneratedAssetNames(manifest);
    return manifest;
  }
  const coldProfile = {
    ...manifest,
    qemu: { ...manifest.qemu, arguments: [...(manifest.qemu?.arguments ?? [])] },
  };
  delete coldProfile.checkpoint;
  validateCheckpointProfile(manifest.checkpoint);
  assertExactProfile(coldProfile, CANONICAL_PRODUCTION_MANIFEST);
  return manifest;
}

export function checkpointArgumentsForManifest(manifest) {
  if (!isRecord(manifest) || !("checkpoint" in manifest)) return null;
  validateProductionManifest(manifest);
  return [...CANONICAL_CHECKPOINT_ARGUMENTS];
}

export function validatePagedDiskArguments(arguments_) {
  try {
    assertExactProfile(arguments_, CANONICAL_PAGED_DISK_ARGUMENTS, "pagedDisk.arguments");
  } catch (error) {
    if (error instanceof ProductionWorkerError) {
      fail("INVALID_PAGED_DISK_PROFILE", "Paged storage returned non-canonical QEMU arguments.", {
        cause: serializeError(error),
      });
    }
    throw error;
  }
  return arguments_;
}

export function validateArtifactManifest(manifest) {
  if (!isRecord(manifest) || manifest.schemaVersion !== 1 || !Array.isArray(manifest.artifacts)) {
    fail("INVALID_ARTIFACT_MANIFEST", "Release artifact manifest is invalid.");
  }
  const byPath = new Map();
  for (const artifact of manifest.artifacts) {
    if (!isRecord(artifact)) fail("INVALID_ARTIFACT_MANIFEST", "Artifact record is invalid.");
    const path = safeRelativePath(artifact.path, "artifact path");
    if (byPath.has(path)) fail("INVALID_ARTIFACT_MANIFEST", `Duplicate artifact path: ${path}.`);
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || !SHA256.test(artifact.sha256 ?? "")) {
      fail("INVALID_ARTIFACT_MANIFEST", `Artifact size or digest is invalid: ${path}.`);
    }
    byPath.set(path, Object.freeze({ ...artifact, path, sha256: artifact.sha256.toLowerCase() }));
  }
  return byPath;
}

export function releaseIdentityFromArtifactManifest(manifest) {
  const upstream = manifest?.upstream;
  if (!isRecord(upstream) || upstream.repository !== OFFICIAL_OMARCHY_REPOSITORY ||
      !COMMIT.test(upstream.commit ?? "") || typeof upstream.version !== "string" ||
      upstream.version.length === 0 || upstream.version.length > 128 ||
      !/^[a-f0-9]{64}$/.test(upstream.treeSha256 ?? "")) {
    fail("INVALID_RELEASE_IDENTITY", "Artifact manifest has no canonical Omarchy release identity.");
  }
  return Object.freeze({
    repository: upstream.repository,
    commit: upstream.commit,
    version: upstream.version,
    treeSha256: upstream.treeSha256,
  });
}

export function assertGuestReportProvenance(report, expectedUpstream) {
  const actual = report?.provenance;
  const fields = ["repository", "commit", "version", "treeSha256"];
  if (!isRecord(actual) || !isRecord(expectedUpstream) ||
      fields.some((field) => actual[field] !== expectedUpstream[field])) {
    fail(
      "GUEST_PROVENANCE_MISMATCH",
      "Guest evidence provenance does not match the verified release.",
      {
        expected: Object.fromEntries(fields.map((field) => [field, expectedUpstream?.[field] ?? null])),
        actual: Object.fromEntries(fields.map((field) => [field, actual?.[field] ?? null])),
      },
    );
  }
  return report;
}

export function authenticateRuntimeGuestReport(report, {
  checkpoint = false,
  alreadySeen = false,
  expectedUpstream,
} = {}) {
  if (checkpoint) {
    fail(
      "CHECKPOINT_REPORT_REPLAY",
      "Checkpoint guest report replayed from serial instead of using its bound source evidence.",
    );
  }
  if (alreadySeen) throw new SyntaxError("Guest emitted more than one evidence report.");
  return assertGuestReportProvenance(report, expectedUpstream);
}

function releaseUrl(base, path) {
  return new URL(safeRelativePath(path), base).href;
}

function normalizeReleaseBase(value, scope) {
  let url;
  try {
    url = new URL(value, scope.location.href);
  } catch {
    fail("INVALID_RELEASE_URL", "releaseBaseUrl is invalid.");
  }
  if (url.origin !== scope.location.origin || (url.protocol !== "https:" && url.protocol !== "http:")) {
    fail("INVALID_RELEASE_URL", "Release assets must use the Worker origin.");
  }
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

async function sha256Hex(bytes, scope) {
  const digest = await scope.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function readBoundedResponseBody(response, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    fail("INVALID_FETCH_BOUND", "Response byte bound must be a positive safe integer.");
  }
  const reader = response?.body?.getReader?.();
  if (!reader) fail("UNSTREAMABLE_RESPONSE", "Artifact response body is not a bounded readable stream.");
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (!Number.isSafeInteger(total) || total > maxBytes) {
        await reader.cancel?.("bounded artifact response exceeded its byte limit");
        fail("ASSET_TOO_LARGE", `Artifact response exceeds ${maxBytes} bytes.`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchJsonFile(url, scope, maxBytes = MAX_MANIFEST_BYTES) {
  const response = await scope.fetch(url, { credentials: "same-origin", cache: "no-store", redirect: "error" });
  if (!response.ok) fail("FETCH_FAILED", `Manifest request failed with HTTP ${response.status}.`, { url });
  const declaredHeader = response.headers.get("content-length");
  if (declaredHeader !== null && (!/^(0|[1-9][0-9]*)$/.test(declaredHeader) ||
      Number(declaredHeader) > maxBytes)) {
    fail("ASSET_TOO_LARGE", `Manifest exceeds ${maxBytes} bytes.`);
  }
  const bytes = await readBoundedResponseBody(response, maxBytes);
  try {
    return Object.freeze({ bytes, value: JSON.parse(new TextDecoder().decode(bytes)) });
  } catch (error) {
    fail("INVALID_JSON", "Manifest response is not valid JSON.", { reason: error.message });
  }
}

export async function fetchVerifiedArtifact(artifact, base, scope, maxBytes) {
  if (!artifact) fail("MISSING_ARTIFACT", "A required release artifact is missing.");
  if (artifact.bytes > maxBytes) {
    fail("ASSET_TOO_LARGE", `${artifact.path} exceeds its bounded-fetch limit.`, {
      bytes: artifact.bytes,
      maxBytes,
    });
  }
  const url = releaseUrl(base, artifact.path);
  const response = await scope.fetch(url, { credentials: "same-origin", cache: "force-cache", redirect: "error" });
  if (!response.ok) fail("FETCH_FAILED", `${artifact.path} failed with HTTP ${response.status}.`);
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) !== artifact.bytes) {
    fail("LENGTH_MISMATCH", `${artifact.path} Content-Length differs from the release manifest.`);
  }
  const bytes = await readBoundedResponseBody(response, artifact.bytes);
  if (bytes.byteLength !== artifact.bytes) fail("LENGTH_MISMATCH", `${artifact.path} body length is invalid.`);
  const digest = await sha256Hex(bytes, scope);
  if (digest !== artifact.sha256) fail("DIGEST_MISMATCH", `${artifact.path} SHA-256 is invalid.`);
  return Object.freeze({ artifact, bytes, url });
}

export function assertBootstrapArtifactsWithinLimit(artifacts, maxBytes = MAX_BOOTSTRAP_BYTES) {
  if (!Array.isArray(artifacts) || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    fail("INVALID_BOOTSTRAP_SET", "Bootstrap artifact bound is invalid.");
  }
  let totalBytes = 0;
  for (const artifact of artifacts) {
    if (!isRecord(artifact) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
      fail("INVALID_BOOTSTRAP_SET", "Bootstrap artifact metadata is invalid.");
    }
    totalBytes += artifact.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) {
      fail("BOOTSTRAP_TOO_LARGE", `Firmware, kernel, and initramfs exceed ${maxBytes} aggregate bytes.`, {
        totalBytes,
        maxBytes,
      });
    }
  }
  return totalBytes;
}

export function createVerifiedBlobUrl(file, scope, mediaType) {
  const BlobConstructor = scope?.Blob;
  const createObjectURL = scope?.URL?.createObjectURL;
  if (!isRecord(file?.artifact) || !(file.bytes instanceof Uint8Array) ||
      typeof BlobConstructor !== "function" || typeof createObjectURL !== "function") {
    fail("VERIFIED_BLOB_UNAVAILABLE", "Verified executable bytes cannot be bound to an in-memory URL.");
  }
  const url = createObjectURL.call(scope.URL, new BlobConstructor([file.bytes], { type: mediaType }));
  if (typeof url !== "string" || !url.startsWith("blob:")) {
    fail("VERIFIED_BLOB_UNAVAILABLE", "Browser returned an invalid verified executable URL.");
  }
  return url;
}

export function createVerifiedExecutableUrls({ module, pthread, wasm }, scope, generatedAssets = null) {
  const names = generatedAssets ?? Object.freeze({
    architecture: "x86_64",
    wasm: "qemu-system-x86_64.wasm",
    pthread: "qemu-system-x86_64.worker.js",
  });
  return deepFreeze({
    module: createVerifiedBlobUrl(module, scope, "text/javascript"),
    locate: {
      [names.wasm]: createVerifiedBlobUrl(wasm, scope, "application/wasm"),
      [names.pthread]: createVerifiedBlobUrl(pthread, scope, "text/javascript"),
    },
  });
}

export async function prepareVerifiedExecutables(artifacts, base, scope, generatedAssets = null) {
  if (!isRecord(artifacts)) fail("MISSING_ARTIFACT", "Verified executable artifact set is invalid.");
  const [moduleFile, wasmFile, pthreadFile] = await Promise.all([
    fetchVerifiedArtifact(artifacts.module, base, scope, MAX_MODULE_BYTES),
    fetchVerifiedArtifact(artifacts.wasm, base, scope, MAX_WASM_BYTES),
    fetchVerifiedArtifact(artifacts.pthread, base, scope, MAX_MODULE_BYTES),
  ]);
  return Object.freeze({
    moduleFile,
    wasmFile,
    pthreadFile,
    urls: createVerifiedExecutableUrls(
      { module: moduleFile, pthread: pthreadFile, wasm: wasmFile },
      scope,
      generatedAssets,
    ),
  });
}

function artifactAt(artifacts, path) {
  const safePath = safeRelativePath(path);
  const artifact = artifacts.get(safePath);
  if (!artifact) fail("MISSING_ARTIFACT", `Release does not contain ${safePath}.`);
  return artifact;
}

function assertCheckpointArtifactRecord(artifacts, descriptor, label) {
  const artifact = artifactAt(artifacts, descriptor.artifactPath);
  if (artifact.bytes !== descriptor.bytes || artifact.sha256 !== descriptor.sha256) {
    fail(
      "CHECKPOINT_ARTIFACT_MISMATCH",
      `${label} release identity differs from the verified runtime checkpoint contract.`,
      {
        path: descriptor.artifactPath,
        expected: { bytes: descriptor.bytes, sha256: descriptor.sha256 },
        actual: { bytes: artifact.bytes, sha256: artifact.sha256 },
      },
    );
  }
  return artifact;
}

export function validateCheckpointArtifacts(manifest, artifacts) {
  validateProductionManifest(manifest);
  if (!("checkpoint" in manifest)) return null;
  if (!(artifacts instanceof Map)) {
    fail("INVALID_ARTIFACT_MANIFEST", "Checkpoint release artifacts must be an indexed manifest.");
  }
  const checkpoint = manifest.checkpoint;
  const vmstate = assertCheckpointArtifactRecord(artifacts, checkpoint.vmstate, "VM state");
  const bootDelta = assertCheckpointArtifactRecord(artifacts, checkpoint.bootDelta, "Boot delta");
  const producerManifest = artifactAt(artifacts, checkpoint.producer.manifestArtifactPath);
  if (producerManifest.bytes !== checkpoint.producer.manifestBytes ||
      producerManifest.sha256 !== checkpoint.producer.manifestSha256) {
    fail(
      "CHECKPOINT_PROVENANCE_MISMATCH",
      "Checkpoint producer manifest differs from the verified runtime checkpoint contract.",
    );
  }
  const rootfs = artifactAt(artifacts, manifest.guest.rootfs.artifactPath);
  if (rootfs.sha256 !== checkpoint.identity.rootfsSha256) {
    fail("CHECKPOINT_ROOTFS_MISMATCH", "Checkpoint qcow2 backing rootfs identity is invalid.");
  }
  const provenance = artifactAt(artifacts, "provenance.json");
  if (provenance.sha256 !== checkpoint.identity.guestProvenanceSha256) {
    fail("CHECKPOINT_GUEST_PROVENANCE_MISMATCH", "Checkpoint guest provenance artifact is invalid.");
  }
  const guestManifest = artifactAt(artifacts, "guest-manifest.json");
  if (guestManifest.sha256 !== checkpoint.identity.baseGuestManifestSha256) {
    fail("CHECKPOINT_GUEST_MISMATCH", "Checkpoint base guest manifest artifact is invalid.");
  }
  const wasmPath = manifest.assets.locate[qemuGeneratedAssetNames(manifest).wasm];
  const wasm = artifactAt(artifacts, wasmPath);
  if (wasm.sha256 !== checkpoint.identity.browserQemuWasmSha256) {
    fail("CHECKPOINT_QEMU_MISMATCH", "Checkpoint is not compatible with the verified browser QEMU build.");
  }
  return Object.freeze({
    vmstate,
    bootDelta,
    producerManifest,
    guestManifest,
    rootfs,
    provenance,
    wasm,
  });
}

export function checkpointCachePlan(manifest) {
  if (!isRecord(manifest) || !("checkpoint" in manifest)) return null;
  validateProductionManifest(manifest);
  const plan = Object.freeze({
    rootfs: Object.freeze({ chunkBytes: 1024 * 1024, maxCachedBytes: CHECKPOINT_ROOTFS_CACHE_BYTES }),
    bootDelta: Object.freeze({ chunkBytes: 1024 * 1024, maxCachedBytes: CHECKPOINT_DELTA_CACHE_BYTES }),
    vmstate: Object.freeze({
      chunkBytes: CHECKPOINT_VMSTATE_CHUNK_BYTES,
      maxCachedBytes: CHECKPOINT_VMSTATE_CACHE_BYTES,
    }),
  });
  const total = Object.values(plan).reduce((sum, item) => sum + item.maxCachedBytes, 0);
  if (total !== CHECKPOINT_TOTAL_CACHE_BYTES) {
    fail("CHECKPOINT_CACHE_MISMATCH", "Checkpoint paging exceeds the canonical 128 MiB cache budget.");
  }
  return plan;
}

export function createCheckpointVmstateRangeLedger(maxRangeBytes = CHECKPOINT_VMSTATE_CHUNK_BYTES) {
  if (!Number.isSafeInteger(maxRangeBytes) || maxRangeBytes <= 0 ||
      maxRangeBytes > CHECKPOINT_VMSTATE_CACHE_BYTES) {
    fail("INVALID_CHECKPOINT_RANGE_BOUND", "Checkpoint vmstate range bound is invalid.");
  }
  let previousStart = -1;
  let previousEnd = -1;
  let requestedBytes = 0;
  let rangeRequests = 0;
  const starts = new Set();
  const record = (request) => {
    const match = typeof request?.range === "string"
      ? request.range.match(/^bytes=([0-9]+)-([0-9]+)$/)
      : null;
    if (!match || request.status !== 206) {
      fail("CHECKPOINT_VMSTATE_RANGE_INVALID", "Checkpoint vmstate used an invalid range response.");
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    const bytes = end - start + 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start ||
        !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > maxRangeBytes ||
        request.responseBytes !== bytes) {
      fail("CHECKPOINT_VMSTATE_RANGE_INVALID", "Checkpoint vmstate range exceeds its exact bound.");
    }
    if (start <= previousStart || starts.has(start)) {
      fail(
        "CHECKPOINT_VMSTATE_REFETCH",
        "Checkpoint vmstate requested an old or duplicate range instead of streaming forward.",
        { previousStart, previousEnd, start, end },
      );
    }
    starts.add(start);
    previousStart = start;
    previousEnd = end;
    requestedBytes += bytes;
    rangeRequests += 1;
    return Object.freeze({ start, end, bytes });
  };
  const snapshot = () => Object.freeze({
    rangeRequests,
    requestedBytes,
    uniqueRanges: starts.size,
    refetches: 0,
    previousStart,
    previousEnd,
    maxRangeBytes,
    maxCachedBytes: CHECKPOINT_VMSTATE_CACHE_BYTES,
  });
  return Object.freeze({ record, snapshot });
}

async function prepareImmutablePagedFile(input, options) {
  const ticket = await preflightPagedDisk(input, options);
  const preRun = createPagedDiskPreRun(ticket, options);
  return Object.freeze({
    descriptor: ticket.descriptor,
    preflight: ticket.audit,
    preRun,
    snapshot: preRun.snapshot,
  });
}

export function createMountPreRun(files) {
  return (module) => {
    const fs = module?.FS;
    if (!fs?.mkdirTree || !fs?.writeFile || !fs?.analyzePath) {
      fail("EMSCRIPTEN_FS_UNAVAILABLE", "QEMU did not expose the required Emscripten FS methods.");
    }
    // QEMU's -snapshot block layer creates its disposable overlay with
    // g_file_open_tmp(), which defaults to /var/tmp in this Worker runtime.
    // Emscripten's MEMFS does not create either conventional temporary
    // directory for us, so establish both before C main starts.
    fs.mkdirTree("/tmp");
    fs.mkdirTree("/var/tmp");
    fs.mkdirTree("/pack");
    for (const file of files) {
      if (fs.analyzePath(file.mountPath).exists) fail("PATH_EXISTS", `Refusing to replace ${file.mountPath}.`);
      fs.writeFile(file.mountPath, file.bytes, { canOwn: false });
      // MEMFS copied the bounded artifact into Wasm memory. Drop the outer
      // Worker view immediately so kernel/initramfs bytes are not retained for
      // the lifetime of QEMU's long-running factory promise.
      file.bytes = null;
    }
  };
}

export function qemuStartupFailureForLine(line) {
  if (typeof line !== "string") return null;
  if (/Could not open temporary file\b/.test(line)) {
    return new ProductionWorkerError("QEMU_STARTUP_FAILED", line);
  }
  return null;
}

export function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    code: error?.code ?? "RUNTIME_FAILED",
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && typeof error.stack === "string" ? { stack: error.stack } : {}),
    ...(error?.details === undefined ? {} : { details: error.details }),
  };
}

export class DesktopProofProtocol {
  #scope;
  #post;
  #onFailure;
  #getInstance;
  #getArtifactManifestSha256;
  #dispatchInput;
  #onComplete;
  #stageTimeoutMs;
  #responseTimeoutMs;
  #inputPacingMs;
  #state = "before-report";
  #timer = null;
  #acknowledgement = null;
  #challengeSha256 = null;
  #baselineSequence = null;
  #response = null;
  #commandInputComplete = false;
  #verificationStarted = false;
  #postProofFrameSeen = false;
  #postProofInputComplete = false;

  constructor({
    scope = globalThis,
    post,
    onFailure,
    getInstance,
    getArtifactManifestSha256,
    dispatchInput = dispatchSanitizedWorkerInput,
    onComplete = () => {},
    stageTimeoutMs = DESKTOP_PROOF_STAGE_TIMEOUT_MS,
    responseTimeoutMs = DESKTOP_PROOF_RESPONSE_TIMEOUT_MS,
    inputPacingMs = DESKTOP_PROOF_INPUT_PACING_MS,
  } = {}) {
    if (typeof post !== "function" || typeof onFailure !== "function" ||
        typeof getInstance !== "function" ||
        typeof getArtifactManifestSha256 !== "function" ||
        typeof dispatchInput !== "function" || typeof onComplete !== "function" ||
        !Number.isSafeInteger(stageTimeoutMs) || stageTimeoutMs <= 0 ||
        !Number.isSafeInteger(responseTimeoutMs) || responseTimeoutMs <= 0 ||
        !Number.isSafeInteger(inputPacingMs) || inputPacingMs < 0) {
      fail("INVALID_DESKTOP_PROOF_HOST", "Desktop proof host configuration is invalid.");
    }
    this.#scope = scope;
    this.#post = post;
    this.#onFailure = onFailure;
    this.#getInstance = getInstance;
    this.#getArtifactManifestSha256 = getArtifactManifestSha256;
    this.#dispatchInput = dispatchInput;
    this.#onComplete = onComplete;
    this.#stageTimeoutMs = stageTimeoutMs;
    this.#responseTimeoutMs = responseTimeoutMs;
    this.#inputPacingMs = inputPacingMs;
  }

  get state() {
    return this.#state;
  }

  get blocksHostInput() {
    return this.#state !== "before-report" && this.#state !== "complete";
  }

  #abort(error) {
    if (this.#state === "failed") return false;
    this.#clearTimer();
    this.#state = "failed";
    this.#onFailure(error instanceof Error ? error : new Error(String(error)));
    return false;
  }

  #protocolError(code, message, details = undefined) {
    return this.#abort(new ProductionWorkerError(code, message, details));
  }

  #clearTimer() {
    if (this.#timer === null) return;
    this.#scope.clearTimeout?.call(this.#scope, this.#timer);
    this.#timer = null;
  }

  #setTimer(code, message, timeoutMs = this.#stageTimeoutMs) {
    this.#clearTimer();
    if (typeof this.#scope.setTimeout !== "function") {
      this.#protocolError(
        "DESKTOP_PROOF_TIMER_UNAVAILABLE",
        "Desktop proof requires bounded stage timers.",
      );
      return;
    }
    this.#timer = this.#scope.setTimeout(() => {
      this.#timer = null;
      this.#protocolError(code, message);
    }, timeoutMs);
  }

  #instanceExport(name) {
    const instance = this.#getInstance();
    const exported = instance?.[name];
    if (typeof exported !== "function") {
      this.#protocolError(
        "DESKTOP_PROOF_BRIDGE_MISSING",
        `QEMU module is missing ${name}.`,
      );
      return null;
    }
    return exported.bind(instance);
  }

  beginAfterAuthenticatedReport() {
    if (this.#state !== "before-report") {
      return this.#protocolError(
        "DESKTOP_PROOF_DUPLICATE_REPORT",
        "Desktop proof can only be armed by one authenticated guest report.",
      );
    }
    const artifactManifestSha256 = this.#getArtifactManifestSha256();
    if (!/^[a-f0-9]{64}$/.test(artifactManifestSha256 ?? "")) {
      return this.#protocolError(
        "DESKTOP_PROOF_RELEASE_UNBOUND",
        "Desktop proof is not bound to a verified release manifest.",
      );
    }

    let challenge;
    try {
      challenge = createDesktopProofChallenge(this.#scope);
    } catch (error) {
      return this.#abort(error);
    }
    this.#acknowledgement = challenge.acknowledgement;
    this.#challengeSha256 = challenge.challengeSha256;
    this.#challengeSha256.catch((error) => this.#protocolError(
      "DESKTOP_PROOF_DIGEST_FAILED",
      "Desktop proof challenge digest failed.",
      { cause: serializeError(error) },
    ));

    const arm = this.#instanceExport("_omarchy_desktop_proof_arm");
    if (!arm) return false;
    this.#state = "awaiting-baseline";
    let status;
    try {
      status = arm();
    } catch (error) {
      return this.#protocolError(
        "DESKTOP_PROOF_ARM_FAILED",
        "QEMU rejected the desktop proof baseline arm request.",
        { cause: serializeError(error) },
      );
    }
    if (status !== 0) {
      return this.#protocolError(
        "DESKTOP_PROOF_ARM_FAILED",
        `QEMU rejected the desktop proof baseline arm request with status ${status}.`,
      );
    }
    this.#setTimer(
      "DESKTOP_PROOF_BASELINE_TIMEOUT",
      "QEMU did not present a 1600x900 desktop proof baseline in time.",
    );
    return true;
  }

  handleFrame(frame) {
    if (!Number.isSafeInteger(frame?.sequence) || frame.sequence <= 0) {
      return this.#protocolError(
        "INVALID_DESKTOP_PROOF_FRAME",
        "Desktop proof frame has an invalid sequence.",
      );
    }
    if (this.#state === "awaiting-post-proof-frame") {
      if (frame.proofFrame !== DESKTOP_PROOF_FRAME_NONE) {
        return this.#protocolError(
          "DESKTOP_PROOF_FRAME_REPLAY",
          "QEMU replayed native desktop proof state after acknowledgement.",
        );
      }
      if (frame.sequence > this.#response.sequence &&
          frame.guestWidth === 1600 && frame.guestHeight === 900 &&
          frame.sampledPixels === DESKTOP_PROOF_SAMPLE_COUNT) {
        this.#postProofFrameSeen = true;
        if (this.#postProofInputComplete) this.#completeAfterLiveness();
      }
      return true;
    }
    if (frame.proofFrame === DESKTOP_PROOF_FRAME_NONE) return true;
    if (this.#state === "before-report") {
      return this.#protocolError(
        "DESKTOP_PROOF_PRE_REPORT_FRAME",
        "QEMU emitted desktop proof state before an authenticated guest report.",
      );
    }

    if (frame.proofFrame === DESKTOP_PROOF_FRAME_BASELINE) {
      if (this.#state !== "awaiting-baseline") {
        return this.#protocolError(
          "DESKTOP_PROOF_BASELINE_REPLAY",
          "QEMU emitted a duplicate or out-of-order desktop proof baseline.",
        );
      }
      this.#clearTimer();
      this.#baselineSequence = frame.sequence;
      this.#state = "opening-terminal";
      this.#setTimer(
        "DESKTOP_PROOF_INPUT_TIMEOUT",
        "The internal terminal shortcut could not be queued in time.",
      );
      this.#openTerminal().catch((error) => this.#protocolError(
        "DESKTOP_PROOF_INPUT_FAILED",
        "The internal terminal shortcut failed.",
        { cause: serializeError(error) },
      ));
      return true;
    }

    if (this.#state !== "awaiting-response" ||
        frame.sequence <= this.#baselineSequence) {
      return this.#protocolError(
        "DESKTOP_PROOF_RESPONSE_REPLAY",
        "QEMU emitted a duplicate or out-of-order desktop proof response.",
      );
    }
    this.#clearTimer();
    this.#response = Object.freeze({
      sequence: frame.sequence,
      sampledPixels: frame.sampledPixels,
      changedPixels: frame.changedPixels,
      dominantPixels: frame.dominantPixels,
    });
    this.#state = "typing-challenge";
    this.#setTimer(
      "DESKTOP_PROOF_INPUT_TIMEOUT",
      "The internal acknowledgement command could not be queued in time.",
    );
    this.#typeAcknowledgement().catch((error) => this.#protocolError(
      "DESKTOP_PROOF_INPUT_FAILED",
      "The internal acknowledgement command failed.",
      { cause: serializeError(error) },
    ));
    return true;
  }

  handleSerialLine(line) {
    let acknowledgement;
    try {
      acknowledgement = parseDesktopProofAcknowledgementLine(line);
    } catch (error) {
      this.#protocolError(
        "DESKTOP_PROOF_ACK_MALFORMED",
        "Guest desktop proof acknowledgement is malformed or ambiguous.",
        { cause: serializeError(error) },
      );
      return true;
    }
    if (acknowledgement === null) return false;
    if (this.#state === "before-report") {
      this.#protocolError(
        "DESKTOP_PROOF_ACK_BEFORE_REPORT",
        "Guest emitted a desktop proof acknowledgement before authentication.",
      );
      return true;
    }
    if (["complete", "verifying-ack", "awaiting-post-proof-frame"].includes(this.#state)) {
      this.#protocolError(
        "DESKTOP_PROOF_ACK_REPLAY",
        "Guest replayed the desktop proof acknowledgement.",
      );
      return true;
    }
    if (this.#state !== "awaiting-ack") {
      this.#protocolError(
        "DESKTOP_PROOF_ACK_OUT_OF_ORDER",
        "Guest emitted the desktop proof acknowledgement before the visual response.",
      );
      return true;
    }
    if (acknowledgement !== this.#acknowledgement) {
      this.#protocolError(
        "DESKTOP_PROOF_ACK_MISMATCH",
        "Guest desktop proof acknowledgement does not match the live challenge.",
      );
      return true;
    }
    this.#state = "verifying-ack";
    this.#setTimer(
      "DESKTOP_PROOF_DIGEST_TIMEOUT",
      "Desktop proof challenge digest verification did not finish in time.",
    );
    this.#startDigestVerification();
    return true;
  }

  #startDigestVerification() {
    if (this.#state !== "verifying-ack" || !this.#commandInputComplete ||
        this.#verificationStarted) return;
    this.#verificationStarted = true;
    this.#finish().catch((error) => this.#protocolError(
      "DESKTOP_PROOF_DIGEST_FAILED",
      "Desktop proof challenge digest failed.",
      { cause: serializeError(error) },
    ));
  }

  async #pause() {
    if (this.#inputPacingMs === 0) {
      await Promise.resolve();
      return;
    }
    await new Promise((resolve) => {
      this.#scope.setTimeout(resolve, this.#inputPacingMs);
    });
  }

  #queueInternalInput(event) {
    if (this.#state === "failed") return false;
    const instance = this.#getInstance();
    this.#dispatchInput(instance, event);
    return true;
  }

  async #queueSequence(events, expectedState) {
    for (const event of events) {
      if (this.#state !== expectedState) return false;
      this.#queueInternalInput(event);
      await this.#pause();
    }
    return this.#state === expectedState;
  }

  async #openTerminal() {
    const releaseModifiers = this.#instanceExport("_omarchy_input_release_modifiers");
    if (!releaseModifiers) return;
    const releaseStatus = releaseModifiers();
    if (releaseStatus !== 0) {
      this.#protocolError(
        "DESKTOP_PROOF_MODIFIER_RELEASE_FAILED",
        `QEMU rejected the pre-shortcut modifier release with status ${releaseStatus}.`,
      );
      return;
    }
    await this.#pause();
    if (this.#state !== "opening-terminal") return;
    const shortcut = Object.freeze([
      keyEvent(227, true),
      keyEvent(40, true),
      keyEvent(40, false),
      keyEvent(227, false),
    ]);
    if (!await this.#queueSequence(shortcut, "opening-terminal")) return;
    const expectResponse = this.#instanceExport("_omarchy_desktop_proof_expect_response");
    if (!expectResponse) return;
    const status = expectResponse();
    if (status !== 0) {
      this.#protocolError(
        "DESKTOP_PROOF_RESPONSE_ARM_FAILED",
        `QEMU rejected the desktop proof response arm request with status ${status}.`,
      );
      return;
    }
    this.#clearTimer();
    this.#state = "awaiting-response";
    this.#setTimer(
      "DESKTOP_PROOF_RESPONSE_TIMEOUT",
      "The internal terminal shortcut did not cause a material 1600x900 framebuffer change.",
      this.#responseTimeoutMs,
    );
  }

  async #typeAcknowledgement() {
    const command = desktopProofCommand(this.#acknowledgement);
    if (!await this.#queueSequence(
      desktopProofTextInputEvents(command),
      "typing-challenge",
    )) return;
    this.#clearTimer();
    this.#state = "awaiting-ack";
    this.#setTimer(
      "DESKTOP_PROOF_ACK_TIMEOUT",
      "Guest did not return the live desktop proof acknowledgement in time.",
    );
    if (this.#state !== "awaiting-ack") return;
    this.#queueInternalInput(keyEvent(40, true));
    await this.#pause();
    if (this.#state === "failed") return;
    this.#queueInternalInput(keyEvent(40, false));
    this.#commandInputComplete = true;
    this.#startDigestVerification();
  }

  async #finish() {
    const challengeSha256 = await this.#challengeSha256;
    if (this.#state !== "verifying-ack") return;
    if (!/^[a-f0-9]{64}$/.test(challengeSha256)) {
      this.#protocolError(
        "DESKTOP_PROOF_DIGEST_FAILED",
        "Desktop proof challenge digest is invalid.",
      );
      return;
    }
    const artifactManifestSha256 = this.#getArtifactManifestSha256();
    const proof = Object.freeze({
      schemaVersion: 1,
      artifactManifestSha256,
      challengeSha256,
      baselineSequence: this.#baselineSequence,
      responseSequence: this.#response.sequence,
      sampledPixels: this.#response.sampledPixels,
      changedPixels: this.#response.changedPixels,
      dominantPixels: this.#response.dominantPixels,
    });
    this.#state = "awaiting-post-proof-frame";
    this.#post("desktopproof", { proof });
    this.#setTimer(
      "DESKTOP_PROOF_LIVENESS_TIMEOUT",
      "QEMU did not present a live 1600x900 frame after desktop proof.",
    );
    this.#forcePostProofPresentation().catch((error) => this.#protocolError(
      "DESKTOP_PROOF_INPUT_FAILED",
      "The post-proof liveness input failed.",
      { cause: serializeError(error) },
    ));
  }

  async #forcePostProofPresentation() {
    const livenessInput = Object.freeze([
      keyEvent(44, true),
      keyEvent(44, false),
      keyEvent(42, true),
      keyEvent(42, false),
    ]);
    if (!await this.#queueSequence(livenessInput, "awaiting-post-proof-frame")) return;
    this.#postProofInputComplete = true;
    if (this.#postProofFrameSeen) this.#completeAfterLiveness();
  }

  #completeAfterLiveness() {
    if (this.#state !== "awaiting-post-proof-frame") return;
    this.#clearTimer();
    this.#state = "complete";
    this.#onComplete();
  }
}

export class OmarchyProductionWorkerHost {
  #scope;
  #phase = "idle";
  #instance = null;
  #started = false;
  #frameSequence = 0;
  #guestReportSeen = false;
  #guestStage = null;
  #failure = null;
  #releaseIdentity = null;
  #terminationScheduled = false;
  #desktopProof;
  #checkpointDesktopSettle = null;
  #deferredHostInputs = [];
  #browserPerformance = null;
  #browserPerformanceCommandChain = Promise.resolve();

  constructor(scope = globalThis) {
    this.#scope = scope;
    this.#desktopProof = new DesktopProofProtocol({
      scope,
      post: (type, detail) => this.#post(type, detail),
      onFailure: (error) => this.fail(error),
      getInstance: () => this.#instance,
      getArtifactManifestSha256: () => this.#releaseIdentity?.artifactManifestSha256,
      onComplete: () => this.#flushDeferredHostInputs(),
    });
  }

  get phase() {
    return this.#phase;
  }

  get instance() {
    return this.#instance;
  }

  fail(error) {
    if (this.#phase !== "failed" && this.#phase !== "exited") {
      this.#failure = error instanceof Error ? error : new Error(String(error));
      this.#setPhase("failed", { error: serializeError(error) });
      this.#terminateRuntime();
    }
  }

  #terminateRuntime() {
    if (this.#terminationScheduled) return;
    this.#terminationScheduled = true;
    try {
      this.#instance?.PThread?.terminateAllThreads?.();
    } catch (error) {
      this.#post("terminationerror", { error: serializeError(error) });
    }
    const close = () => this.#scope.close?.call(this.#scope);
    if (typeof this.#scope.queueMicrotask === "function") this.#scope.queueMicrotask(close);
    else if (typeof this.#scope.setTimeout === "function") this.#scope.setTimeout(close, 0);
    else close();
  }

  #post(type, detail = {}) {
    this.#scope.postMessage({ type, ...detail });
  }

  #setPhase(phase, detail = {}) {
    if (this.#phase === "failed" || this.#phase === "exited") return false;
    this.#phase = phase;
    this.#post("phase", { phase, ...detail });
    return true;
  }

  #flushDeferredHostInputs() {
    const events = this.#deferredHostInputs.splice(0);
    try {
      for (const event of events) dispatchSanitizedWorkerInput(this.#instance, event);
    } catch (error) {
      this.fail(new ProductionWorkerError(
        "DEFERRED_INPUT_FAILED",
        "A host input queued during desktop proof could not reach QEMU.",
        { cause: serializeError(error) },
      ));
    }
  }

  async start({ canvas, releaseBaseUrl } = {}) {
    if (this.#started) fail("ALREADY_STARTED", "The production VM Worker can only start once.");
    this.#started = true;
    try {
      if (!canvas || typeof canvas.getContext !== "function") {
        fail("INVALID_CANVAS", "start.canvas must be the transferred OffscreenCanvas.");
      }
      if (!("style" in canvas)) Object.defineProperty(canvas, "style", { value: {}, configurable: true });
      const base = normalizeReleaseBase(releaseBaseUrl, this.#scope);

      this.#setPhase("loading-artifact-manifest");
      const artifactManifestFile = await fetchJsonFile(
        releaseUrl(base, "artifact-manifest.json"), this.#scope,
      );
      const artifactManifest = artifactManifestFile.value;
      const upstream = releaseIdentityFromArtifactManifest(artifactManifest);
      const artifacts = validateArtifactManifest(artifactManifest);
      const artifactManifestSha256 = await sha256Hex(artifactManifestFile.bytes, this.#scope);
      this.#releaseIdentity = Object.freeze({ upstream, artifactManifestSha256 });
      this.#post("release", this.#releaseIdentity);

      this.#setPhase("loading-runtime-manifest");
      const runtimeManifestArtifact = artifactAt(artifacts, "runtime-manifest.json");
      const runtimeManifestFile = await fetchVerifiedArtifact(
        runtimeManifestArtifact, base, this.#scope, MAX_MANIFEST_BYTES,
      );
      const runtimeManifest = validateProductionManifest(
        JSON.parse(new TextDecoder().decode(runtimeManifestFile.bytes)),
      );
      const checkpointArtifacts = validateCheckpointArtifacts(runtimeManifest, artifacts);
      const guestDescriptorArtifact = artifactAt(artifacts, "guest-manifest.json");
      this.#browserPerformance = createBrowserPerformanceRuntimeController({
        identity: Object.freeze({
          artifactManifestSha256,
          runtimeManifestSha256: runtimeManifestArtifact.sha256,
          guestDescriptorSha256: guestDescriptorArtifact.sha256,
          hibernateDescriptorSha256: null,
        }),
        clock: this.#scope.performance,
        cryptoScope: this.#scope.crypto,
        getInstance: () => this.#instance,
        dispatchInput: dispatchSanitizedWorkerInputWithReceipt,
        onState: (performance) => this.#post("browserperformancestate", { performance }),
        onCapture: (capture) => this.#post("browserperformancecapture", { capture }),
      });
      let checkpointSourceEvidence = null;
      if (checkpointArtifacts !== null) {
        this.#setPhase("loading-checkpoint-provenance");
        const [producerFile, guestManifestFile] = await Promise.all([
          fetchVerifiedArtifact(
            checkpointArtifacts.producerManifest,
            base,
            this.#scope,
            MAX_MANIFEST_BYTES,
          ),
          fetchVerifiedArtifact(
            checkpointArtifacts.guestManifest,
            base,
            this.#scope,
            MAX_MANIFEST_BYTES,
          ),
        ]);
        let producerDocument;
        let guestManifestDocument;
        try {
          producerDocument = JSON.parse(new TextDecoder().decode(producerFile.bytes));
          guestManifestDocument = JSON.parse(new TextDecoder().decode(guestManifestFile.bytes));
        } catch (error) {
          fail("CHECKPOINT_PROVENANCE_MISMATCH", "Checkpoint provenance metadata is not valid JSON.", {
            cause: serializeError(error),
          });
        }
        validateCheckpointProducerDocument(producerDocument, runtimeManifest.checkpoint);
        validateCheckpointGuestManifestDocument(
          guestManifestDocument,
          runtimeManifest.checkpoint,
          this.#releaseIdentity.upstream,
        );
        await validateCheckpointSourceEvidence(
          producerDocument.sourceEvidence,
          this.#releaseIdentity.upstream,
          this.#scope,
        );
        checkpointSourceEvidence = producerDocument.sourceEvidence;
      }
      const checkpointPaths = checkpointArtifacts === null ? [] : [
            runtimeManifest.checkpoint.vmstate.artifactPath,
            runtimeManifest.checkpoint.bootDelta.artifactPath,
            runtimeManifest.checkpoint.producer.manifestArtifactPath,
            "guest-manifest.json",
            "provenance.json",
          ];
      for (const path of [
        runtimeManifest.assets.hostWorker,
        runtimeManifest.assets.workerInput,
        runtimeManifest.assets.pagedDisk,
        runtimeManifest.assets.boundedOverlay,
        runtimeManifest.assets.module,
        ...Object.values(runtimeManifest.assets.locate),
        ...Object.values(runtimeManifest.assets.firmware),
        ...["rootfs", "kernel", "initramfs"].map((key) => runtimeManifest.guest[key].artifactPath),
        ...checkpointPaths,
      ]) artifactAt(artifacts, path);
      canvas.width = runtimeManifest.display.width;
      canvas.height = runtimeManifest.display.height;
      this.#post("display", {
        width: runtimeManifest.display.width,
        height: runtimeManifest.display.height,
      });

      const firmwareArtifacts = Object.entries(runtimeManifest.assets.firmware).map(
        ([guestName, path]) => ({ guestName, artifact: artifactAt(artifacts, path) }),
      );
      const kernelArtifact = artifactAt(artifacts, runtimeManifest.guest.kernel.artifactPath);
      const initramfsArtifact = artifactAt(artifacts, runtimeManifest.guest.initramfs.artifactPath);
      assertBootstrapArtifactsWithinLimit([
        ...firmwareArtifacts.map(({ artifact }) => artifact),
        kernelArtifact,
        initramfsArtifact,
      ]);
      const firmwareFiles = await Promise.all(firmwareArtifacts.map(
        async ({ guestName, artifact }) => {
          const file = await fetchVerifiedArtifact(artifact, base, this.#scope, MAX_FIRMWARE_BYTES);
          return { mountPath: `/pack/${guestName}`, bytes: file.bytes };
        },
      ));
      const kernelBytes = (await fetchVerifiedArtifact(
        kernelArtifact, base, this.#scope, MAX_KERNEL_BYTES,
      )).bytes;
      const initramfsBytes = (await fetchVerifiedArtifact(
        initramfsArtifact, base, this.#scope, MAX_INITRAMFS_BYTES,
      )).bytes;
      const boundedFiles = [
        ...firmwareFiles,
        { mountPath: runtimeManifest.guest.kernel.mountPath, bytes: kernelBytes },
        { mountPath: runtimeManifest.guest.initramfs.mountPath, bytes: initramfsBytes },
      ];

      const rootfs = artifactAt(artifacts, runtimeManifest.guest.rootfs.artifactPath);
      const cachePlan = checkpointCachePlan(runtimeManifest);
      this.#setPhase("preflighting-rootfs");
      const disk = await preparePagedDisk({
        url: releaseUrl(base, rootfs.path),
        path: runtimeManifest.guest.rootfs.mountPath,
        byteLength: rootfs.bytes,
        sha256: rootfs.sha256,
        ...(cachePlan === null ? {} : cachePlan.rootfs),
      }, {
        scope: this.#scope,
        origin: this.#scope.location.origin,
        onRequest: (request) => this.#post("diskrequest", { artifact: "rootfs", request }),
        onOverlayLimit: (event) => {
          this.#post("overlaylimit", { event });
          this.fail(new ProductionWorkerError(
            "OVERLAY_QUOTA_EXCEEDED",
            "The disposable QEMU snapshot reached its browser memory quota.",
            event,
          ));
        },
      });
      let checkpointPagedFiles = [];
      let pagedDiskArguments;
      if (checkpointArtifacts === null) {
        pagedDiskArguments = validatePagedDiskArguments(disk.qemuArguments);
      } else {
        const checkpoint = runtimeManifest.checkpoint;
        this.#setPhase("preflighting-checkpoint");
        const commonCheckpointOptions = {
          scope: this.#scope,
          origin: this.#scope.location.origin,
        };
        const vmstateRangeLedger = createCheckpointVmstateRangeLedger();
        const [bootDeltaFile, vmstateFile] = await Promise.all([
          prepareImmutablePagedFile({
            url: releaseUrl(base, checkpointArtifacts.bootDelta.path),
            path: checkpoint.bootDelta.mountPath,
            byteLength: checkpointArtifacts.bootDelta.bytes,
            sha256: checkpointArtifacts.bootDelta.sha256,
            ...cachePlan.bootDelta,
          }, {
            ...commonCheckpointOptions,
            onRequest: (request) => this.#post("diskrequest", {
              artifact: "checkpoint-boot-delta",
              request,
            }),
          }),
          prepareImmutablePagedFile({
            url: releaseUrl(base, checkpointArtifacts.vmstate.path),
            path: checkpoint.vmstate.mountPath,
            byteLength: checkpointArtifacts.vmstate.bytes,
            sha256: checkpointArtifacts.vmstate.sha256,
            ...cachePlan.vmstate,
          }, {
            ...commonCheckpointOptions,
            onRequest: (request) => {
              vmstateRangeLedger.record(request);
              this.#post("diskrequest", {
                artifact: "checkpoint-vmstate",
                request,
                checkpointLedger: vmstateRangeLedger.snapshot(),
              });
            },
          }),
        ]);
        checkpointPagedFiles = [bootDeltaFile, vmstateFile];
        this.#post("checkpoint", {
          mode: checkpoint.mode,
          vmstateBytes: checkpoint.vmstate.bytes,
          bootDeltaBytes: checkpoint.bootDelta.bytes,
          cacheBytes: CHECKPOINT_TOTAL_CACHE_BYTES,
          vmstateRangeLedger: vmstateRangeLedger.snapshot(),
        });
        pagedDiskArguments = checkpointArgumentsForManifest(runtimeManifest);
      }

      const locate = runtimeManifest.assets.locate;
      const generatedAssets = qemuGeneratedAssetNames(runtimeManifest);
      const executables = await prepareVerifiedExecutables(
        {
          module: artifactAt(artifacts, runtimeManifest.assets.module),
          wasm: artifactAt(artifacts, locate[generatedAssets.wasm]),
          pthread: artifactAt(artifacts, locate[generatedAssets.pthread]),
        },
        base,
        this.#scope,
        generatedAssets,
      );
      this.#setPhase("starting-emulator");
      const { default: createQemu } = await import(executables.urls.module);
      if (typeof createQemu !== "function") fail("INVALID_QEMU_MODULE", "QEMU module has no default factory export.");

      const processSerial = (stream, line) => {
        this.#post("serial", { stream, line });
        if (stream === "stderr") {
          const startupFailure = qemuStartupFailureForLine(line);
          if (startupFailure) this.fail(startupFailure);
        }
        if (line.startsWith(RUNTIME_DIAGNOSTIC_PREFIX)) {
          this.#post("runtimediagnostic", { line });
        }
        try {
          const stage = parseGuestStageLine(line, this.#guestStage);
          if (stage) {
            this.#guestStage = stage;
            this.#post("gueststage", { stage });
          }
        } catch (error) {
          this.#post("gueststageerror", { line, error: serializeError(error) });
          this.fail(new ProductionWorkerError(
            "INVALID_GUEST_STAGE",
            "Guest stage diagnostics are malformed, ambiguous, or out of order.",
            { cause: serializeError(error) },
          ));
          return;
        }
        try {
          const report = parseGuestReportLine(line);
          if (report) {
            authenticateRuntimeGuestReport(report, {
              checkpoint: checkpointArtifacts !== null,
              alreadySeen: this.#guestReportSeen,
              expectedUpstream: this.#releaseIdentity.upstream,
            });
            this.#guestReportSeen = true;
            this.#post("guestreport", { report, origin: "live-guest-serial" });
            this.#desktopProof.beginAfterAuthenticatedReport();
          }
        } catch (error) {
          this.#post("guestreporterror", { line, error: serializeError(error) });
          this.fail(error instanceof ProductionWorkerError ? error : new ProductionWorkerError(
            "INVALID_GUEST_REPORT",
            "Guest evidence report is malformed or ambiguous.",
            { cause: serializeError(error) },
          ));
        }
      };
      const emitSerial = (stream, value) => {
        const line = String(value);
        if (this.#desktopProof.handleSerialLine(line)) return;
        processSerial(stream, line);
      };
      const moduleOptions = {
        canvas,
        wasmBinary: executables.wasmFile.bytes,
        arguments: [...runtimeManifest.qemu.arguments, ...pagedDiskArguments],
        preRun: [
          createMountPreRun(boundedFiles),
          disk.overlayPreRun,
          disk.preRun,
          ...checkpointPagedFiles.map(({ preRun }) => preRun),
        ],
        mainScriptUrlOrBlob: executables.urls.module,
        locateFile: (generatedName) => {
          if (!(generatedName in executables.urls.locate)) {
            fail("UNDECLARED_GENERATED_ASSET", `QEMU requested undeclared generated asset ${generatedName}.`);
          }
          return executables.urls.locate[generatedName];
        },
        print: (line) => emitSerial("stdout", line),
        printErr: (line) => emitSerial("stderr", line),
        onGuestFrame: (
          guestWidth,
          guestHeight,
          sampledPixels,
          nonBlackPixels,
          proofFrame,
          changedPixels,
          dominantPixels,
        ) => {
          try {
            const frame = nextPublicNativeGuestFrame(this.#frameSequence, {
              guestWidth,
              guestHeight,
              sampledPixels,
              nonBlackPixels,
              proofFrame,
              changedPixels,
              dominantPixels,
            });
            if (frame === null) return;
            this.#frameSequence = frame.sequence;
            const observedAt = monotonicNow(this.#scope);
            this.#post("guestframe", {
              sequence: frame.sequence,
              source: "qemu-guest",
              guestWidth: frame.guestWidth,
              guestHeight: frame.guestHeight,
              sampledPixels: frame.sampledPixels,
              nonBlackPixels: frame.nonBlackPixels,
              timestamp: observedAt,
            });
            this.#checkpointDesktopSettle?.handleFrame(frame, observedAt);
            this.#desktopProof.handleFrame(frame);
          } catch (error) {
            this.fail(error);
          }
        },
        ...this.#browserPerformance.moduleCallbacks(),
        onAbort: (reason) => this.fail(reason),
        onExit: (status) => {
          if (checkpointArtifacts !== null && this.#phase !== "failed") {
            this.fail(new ProductionWorkerError(
              "CHECKPOINT_RESUME_EXITED",
              "Checkpoint QEMU exited; the production checkpoint runtime is no longer valid.",
              { status },
            ));
            return;
          }
          this.#setPhase("exited", { status });
          this.#terminateRuntime();
        },
      };
      this.#instance = await createQemu(moduleOptions);
      if (this.#phase === "failed") {
        throw this.#failure ?? new ProductionWorkerError(
          "QEMU_STARTUP_FAILED",
          "QEMU failed while its module factory was starting.",
        );
      }
      if (this.#phase === "exited") return this.#instance;
      this.#post("runtimediagnostic", {
        line: `${RUNTIME_DIAGNOSTIC_PREFIX}qemu-running-wait-start`,
      });
      const runningEvidence = await waitForQemuRunning(this.#instance, { scope: this.#scope });
      this.#post("runtimediagnostic", {
        line: `${RUNTIME_DIAGNOSTIC_PREFIX}qemu-running checks=${runningEvidence.checks} elapsed-ms=${runningEvidence.elapsedMs.toFixed(3)}`,
      });
      if (checkpointSourceEvidence !== null) {
        if (this.#guestReportSeen) {
          fail("CHECKPOINT_REPORT_REPLAY", "Checkpoint source report was duplicated by the resumed guest.");
        }
        this.#guestReportSeen = true;
        this.#post("guestreport", {
          report: checkpointSourceEvidence.guestReport,
          origin: "checkpoint-source-evidence",
          sourceEvidence: {
            normalizedGuestReportSha256: checkpointSourceEvidence.normalizedGuestReportSha256,
            reportValidationSha256: checkpointSourceEvidence.reportValidationSha256,
            checkpointFrameSha256: checkpointSourceEvidence.checkpointFrameSha256,
            checkpointFrameHealthSha256: checkpointSourceEvidence.checkpointFrameHealthSha256,
          },
        });
        this.#checkpointDesktopSettle = new CheckpointDesktopSettleGate({
          scope: this.#scope,
          onProgress: (evidence) => {
            const fields = Object.entries(evidence)
              .map(([key, value]) => `${key}=${value}`)
              .join(" ");
            this.#post("runtimediagnostic", {
              line: `${RUNTIME_DIAGNOSTIC_PREFIX}checkpoint-desktop-settle ${fields}`,
            });
          },
          onFailure: (error) => this.fail(error),
          onReady: () => {
            if (!this.#desktopProof.beginAfterAuthenticatedReport()) {
              throw this.#failure ?? new ProductionWorkerError(
                "CHECKPOINT_DESKTOP_PROOF_ARM_FAILED",
                "Checkpoint desktop proof could not be armed after resume.",
              );
            }
          },
        });
        this.#checkpointDesktopSettle.beginAfterRunning();
      }
      if (!this.#setPhase("running")) {
        throw this.#failure ?? new ProductionWorkerError(
          "RUNTIME_TERMINAL_PHASE",
          "QEMU startup reached a terminal phase before it could become ready.",
        );
      }
      return this.#instance;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  input(value) {
    if (!this.#instance || this.#phase !== "running") {
      fail("NOT_RUNNING", "The VM must be running before input is accepted.");
    }
    const event = sanitizeWorkerInput(value);
    if (this.#checkpointDesktopSettle?.blocksHostInput || this.#desktopProof.blocksHostInput) {
      if (this.#deferredHostInputs.length >= MAX_DEFERRED_HOST_INPUTS) {
        fail("INPUT_QUEUE_FULL", "Host input queue is full while desktop proof is active.");
      }
      this.#deferredHostInputs.push(event);
    } else {
      dispatchSanitizedWorkerInput(this.#instance, event);
    }
    this.#post("inputaccepted", { event });
    return event;
  }

  browserPerformance(value) {
    const command = normalizeBrowserPerformanceCommand(value);
    const operation = this.#browserPerformanceCommandChain.then(async () => {
      if (!this.#browserPerformance || this.#phase !== "running") {
        fail(
          "PERFORMANCE_RUNTIME_NOT_READY",
          "Browser performance capture requires a running verified VM.",
        );
      }
      if (command.action === "begin") {
        if (!this.#guestReportSeen || this.#desktopProof.state !== "complete") {
          fail(
            "PERFORMANCE_DESKTOP_NOT_READY",
            "Browser performance capture requires completed guest and desktop proof.",
          );
        }
        return this.#browserPerformance.begin(command);
      }
      if (command.action === "input") {
        const event = sanitizeWorkerInput(command.event);
        return this.#browserPerformance.input({
          inputId: command.inputId,
          actionDigest: command.actionDigest,
          event,
        });
      }
      return this.#browserPerformance.end();
    });
    this.#browserPerformanceCommandChain = operation.catch(() => {});
    return operation;
  }
}

export function installProductionWorker(scope = globalThis) {
  const host = new OmarchyProductionWorkerHost(scope);
  scope.addEventListener("message", (message) => {
    const data = message.data;
    if (!isRecord(data)) return;
    if (data.type === "start") {
      host.start(data).catch(() => {});
    } else if (data.type === "input") {
      try {
        host.input(data.event);
      } catch (error) {
        scope.postMessage({ type: "inputerror", error: serializeError(error) });
      }
    } else if (data.type === "browserperformance") {
      try {
        host.browserPerformance(data).catch((error) => {
          scope.postMessage({
            type: "browserperformanceerror",
            error: serializeError(error),
          });
        });
      } catch (error) {
        scope.postMessage({
          type: "browserperformanceerror",
          error: serializeError(error),
        });
      }
    }
  });
  scope.addEventListener("error", (event) => {
    event.preventDefault?.();
    host.fail(event.error ?? event.message);
    scope.postMessage({ type: "error", error: serializeError(event.error ?? event.message) });
  });
  scope.addEventListener("unhandledrejection", (event) => {
    event.preventDefault?.();
    host.fail(event.reason);
    scope.postMessage({ type: "error", error: serializeError(event.reason) });
  });
  return host;
}

if (typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope) {
  installProductionWorker(globalThis);
}
