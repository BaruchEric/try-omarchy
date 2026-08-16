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
const HIBERNATION_ROOTFS_CACHE_BYTES = 64 * 1024 * 1024;
const HIBERNATION_ROOT_DELTA_CACHE_BYTES = 32 * 1024 * 1024;
const HIBERNATION_SWAP_CACHE_BYTES = 32 * 1024 * 1024;
const GUEST_REPORT_PREFIX = "OMARCHY_GUEST_REPORT ";
const GUEST_STAGE_PREFIX = "OMARCHY_GUEST_STAGE ";
const HIBERNATION_ENTER_PREFIX = "OMARCHY_HIBERNATION_ENTER ";
const HIBERNATION_REPORT_PREFIX = "OMARCHY_HIBERNATION_REPORT ";
const RENDERER_REPORT_PREFIX = "OMARCHY_RENDERER_REPORT ";
const HIBERNATION_COLD_BOOT_PREFIX = "OMARCHY_HIBERNATION_COLD_BOOT ";
const HIBERNATION_FAILURE_PREFIX = "OMARCHY_HIBERNATION_FAILURE ";
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
const HIBERNATION_RESUME_TIMEOUT_MS = 600_000;
const HIBERNATION_GUEST_REPORT_TIMEOUT_MS = 900_000;
const MAX_DEFERRED_HIBERNATION_EVIDENCE_LINES = 64;
const MAX_DEFERRED_HIBERNATION_EVIDENCE_BYTES = 256 * 1024;
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
const RESUME_NONCE = /^[a-f0-9]{64}$/;

export const HIBERNATION_SWAP_UUID = "4c9a13d2-7c3a-4f2c-b6e1-5a3048610e8f";
export const HIBERNATION_SWAP_VIRTUAL_BYTES = 1_610_612_736;

const HIBERNATION_KERNEL_EVIDENCE = Object.freeze([
  "PM: Image signature found, resuming",
  "PM: Image loading done",
  "PM: Image successfully loaded",
  "PM: hibernation: hibernation exit",
]);
const HIBERNATION_KERNEL_FAILURE = /(?:hibernation|PM:).*(?:image (?:not found|mismatch|loading failed)|resume failed|error)/i;

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

export const CANONICAL_HIBERNATION_KERNEL_COMMAND_LINE_BASE =
  `${CANONICAL_PRODUCTION_MANIFEST.qemu.arguments[
    CANONICAL_PRODUCTION_MANIFEST.qemu.arguments.indexOf("-append") + 1
  ]} resume=UUID=${HIBERNATION_SWAP_UUID} ignore_loglevel hibernate.compressor=lzo ` +
  `omarchy.hibernate_swap_uuid=${HIBERNATION_SWAP_UUID}`;

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

export const CANONICAL_HIBERNATION_PRODUCER_MACHINE = deepFreeze({
  type: "pc-q35-8.2",
  memoryMiB: 1024,
  smp: "2,sockets=1,cores=2,threads=1",
  accel: "tcg,tb-size=128,thread=multi",
  cpu: "qemu64",
  display: "sdl,gl=on,show-cursor=on,full-screen=on",
  displayDevice: "virtio-vga-gl,max_outputs=1,xres=1600,yres=900",
  blockDevices: [
    {
      driveId: "omarchy-hibernate-root",
      device: "virtio-blk-pci",
      serial: "omarchy-root",
      role: "root",
      format: "qcow2",
    },
    {
      driveId: "omarchy-hibernate-swap",
      device: "virtio-blk-pci",
      serial: "omarchy-resume",
      role: "resume",
      format: "qcow2",
    },
  ],
});

export const CANONICAL_HIBERNATION_RUNTIME_MACHINE = deepFreeze({
  ...CANONICAL_HIBERNATION_PRODUCER_MACHINE,
  display: "sdl,gl=es,show-cursor=on",
  blockDevices: CANONICAL_HIBERNATION_PRODUCER_MACHINE.blockDevices.map((device) => ({ ...device })),
});

export const CANONICAL_HIBERNATION_ARGUMENTS = deepFreeze([
  "-snapshot",
  "-drive",
  "file=/pack/hibernate-root-overlay.qcow2,if=none,format=qcow2,media=disk,cache=unsafe,id=omarchy-hibernate-root",
  "-device",
  "virtio-blk-pci,drive=omarchy-hibernate-root,serial=omarchy-root",
  "-drive",
  "file=/pack/omarchy-hibernate.qcow2,if=none,format=qcow2,media=disk,cache=unsafe,id=omarchy-hibernate-swap",
  "-device",
  "virtio-blk-pci,drive=omarchy-hibernate-swap,serial=omarchy-resume",
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

export function parseHibernationReportLine(line) {
  if (typeof line !== "string") return null;
  const marker = line.indexOf(HIBERNATION_REPORT_PREFIX);
  if (marker < 0) return null;
  if (line.indexOf(HIBERNATION_REPORT_PREFIX, marker + HIBERNATION_REPORT_PREFIX.length) >= 0) {
    throw new SyntaxError("Hibernation report line contains more than one evidence marker.");
  }
  const payloadStart = marker + HIBERNATION_REPORT_PREFIX.length;
  const lineEnd = line.slice(payloadStart).search(/[\r\n]/);
  const payloadEnd = lineEnd < 0 ? line.length : payloadStart + lineEnd;
  const trailing = line.slice(payloadEnd);
  if (/[^\r\n]/.test(trailing)) {
    throw new SyntaxError("Hibernation report line contains data after its line ending.");
  }
  const encoded = new TextEncoder().encode(line.slice(payloadStart, payloadEnd));
  if (encoded.byteLength === 0 || encoded.byteLength > 2048) {
    throw new SyntaxError("Hibernation report payload exceeds its byte bound.");
  }
  const payload = JSON.parse(line.slice(payloadStart, payloadEnd));
  if (!isRecord(payload)) throw new TypeError("Hibernation report payload must be a JSON object.");
  const expectedKeys = [
    "gpuDriver", "nonce", "renderNode", "renderer", "schemaVersion", "sourceBootId", "status", "swapUuid",
  ];
  const actualKeys = Object.keys(payload).sort();
  if (actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new TypeError("Hibernation report payload must contain exactly the documented keys.");
  }
  if (payload.schemaVersion !== 1 || payload.status !== "resumed" ||
      !RESUME_NONCE.test(payload.nonce ?? "") || !UUID.test(payload.sourceBootId ?? "") ||
      !UUID.test(payload.swapUuid ?? "") || payload.gpuDriver !== "virtio_gpu" ||
      payload.renderer !== "virgl" ||
      payload.renderNode !== "/dev/dri/renderD128") {
    throw new TypeError("Hibernation report payload contains an invalid field value.");
  }
  return payload;
}

export function parseRendererReportLine(line) {
  if (typeof line !== "string") return null;
  const marker = line.indexOf(RENDERER_REPORT_PREFIX);
  if (marker < 0) return null;
  if (line.indexOf(RENDERER_REPORT_PREFIX, marker + RENDERER_REPORT_PREFIX.length) >= 0) {
    throw new SyntaxError("Renderer report line contains more than one evidence marker.");
  }
  const payloadStart = marker + RENDERER_REPORT_PREFIX.length;
  const lineEnd = line.slice(payloadStart).search(/[\r\n]/);
  const payloadEnd = lineEnd < 0 ? line.length : payloadStart + lineEnd;
  if (/[^\r\n]/.test(line.slice(payloadEnd))) {
    throw new SyntaxError("Renderer report line contains data after its line ending.");
  }
  const payloadBytes = new TextEncoder().encode(line.slice(payloadStart, payloadEnd));
  if (payloadBytes.byteLength === 0 || payloadBytes.byteLength > 2048) {
    throw new SyntaxError("Renderer report payload exceeds its byte bound.");
  }
  const payload = JSON.parse(line.slice(payloadStart, payloadEnd));
  const expectedKeys = ["renderNode", "renderer", "schemaVersion", "vendor", "version"];
  const actualKeys = Object.keys(payload ?? {}).sort();
  if (!isRecord(payload) || actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new TypeError("Renderer report payload must contain exactly the documented keys.");
  }
  if (payload.schemaVersion !== 1 || payload.renderNode !== "/dev/dri/renderD128" ||
      typeof payload.renderer !== "string" || !/virgl/i.test(payload.renderer) ||
      typeof payload.vendor !== "string" || typeof payload.version !== "string" ||
      [payload.renderer, payload.vendor, payload.version].some((value) =>
        value.length === 0 || value.length > 256 || /[\r\n\0]/.test(value))) {
    throw new TypeError("Renderer report does not prove a bounded VirGL render node.");
  }
  return payload;
}

export class HibernationResumeGate {
  #checkpoint;
  #scope;
  #onFailure;
  #timeoutMs;
  #state = "idle";
  #timer = null;
  #kernelIndex = 0;
  #kernelEvidence = [];
  #rendererReport = null;
  #promise;
  #resolve;
  #reject;

  constructor({
    checkpoint,
    scope = globalThis,
    onFailure = () => {},
    timeoutMs = HIBERNATION_RESUME_TIMEOUT_MS,
  } = {}) {
    if (!isHibernationCheckpoint(checkpoint)) {
      fail("INVALID_HIBERNATION_GATE", "Hibernation resume gate requires a hibernation checkpoint.");
    }
    validateCheckpointProfile(checkpoint);
    if (!scope?.crypto?.subtle || typeof scope.setTimeout !== "function" ||
        typeof scope.clearTimeout !== "function" || typeof onFailure !== "function" ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      fail("INVALID_HIBERNATION_GATE", "Hibernation resume gate dependencies are invalid.");
    }
    this.#checkpoint = checkpoint;
    this.#scope = scope;
    this.#onFailure = onFailure;
    this.#timeoutMs = timeoutMs;
    this.#promise = new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    this.#promise.catch(() => {});
  }

  get state() { return this.#state; }
  get blocksGuestEvidence() { return this.#state !== "ready"; }

  begin() {
    if (this.#state !== "idle") return false;
    this.#state = "awaiting-kernel-resume";
    this.#timer = this.#scope.setTimeout(() => {
      if (this.#state === "ready" || this.#state === "failed") return;
      this.#abort(new ProductionWorkerError(
        "HIBERNATION_RESUME_TIMEOUT",
        "Guest hibernation did not produce authenticated resume evidence within its bound.",
      ));
    }, this.#timeoutMs);
    return true;
  }

  wait() { return this.#promise; }

  #clearTimer() {
    if (this.#timer !== null) this.#scope.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #abort(error) {
    if (this.#state === "failed") return;
    this.#state = "failed";
    this.#clearTimer();
    // Resume-gate input can contain the plaintext one-time nonce. Never let
    // untrusted serial payloads or parser messages escape through public
    // Worker diagnostics, including if a future call site adds error details.
    const failure = error instanceof ProductionWorkerError
      ? new ProductionWorkerError(error.code, error.message)
      : new ProductionWorkerError(
        "HIBERNATION_RESUME_FAILED",
        "Guest hibernation resume evidence is invalid.",
      );
    try {
      this.#onFailure(failure);
    } catch {
      // Failure reporting must not interfere with the gate's terminal state.
    }
    this.#reject(failure);
  }

  async #authenticateMarker(marker) {
    try {
      const restore = this.#checkpoint.restoreContract;
      const nonceSha256 = await sha256Hex(new TextEncoder().encode(marker.nonce), this.#scope);
      const markerSha256 = await sha256Hex(normalizedJsonBytes(marker), this.#scope);
      const rendererReportSha256 = await sha256Hex(normalizedJsonBytes(this.#rendererReport), this.#scope);
      this.#rendererReport = null;
      if (nonceSha256 !== restore.resumeNonceSha256 ||
          markerSha256 !== this.#checkpoint.resumeEvidence.hibernationMarkerSha256 ||
          marker.sourceBootId !== restore.sourceBootId ||
          marker.swapUuid !== this.#checkpoint.swapImage.swapUuid) {
        fail("HIBERNATION_REPORT_MISMATCH", "Hibernation report does not match its authenticated resume contract.");
      }
      if (this.#state !== "verifying-marker") return;
      this.#state = "ready";
      this.#clearTimer();
      this.#resolve(Object.freeze({
        markerSha256,
        kernelEvidence: Object.freeze([...this.#kernelEvidence]),
        rendererReportSha256,
      }));
    } catch (error) {
      this.#abort(error);
    }
  }

  handleSerialLine(line) {
    if (typeof line !== "string") return false;
    const hibernationControlLine = [
      HIBERNATION_ENTER_PREFIX,
      HIBERNATION_REPORT_PREFIX,
      HIBERNATION_COLD_BOOT_PREFIX,
      HIBERNATION_FAILURE_PREFIX,
      RENDERER_REPORT_PREFIX,
    ].some((prefix) => line.includes(prefix));
    // Hibernation control records can carry the plaintext resume nonce. Keep
    // consuming them after a terminal failure so an immediate replay cannot
    // fall through to the public serial channel while shutdown is pending.
    if (this.#state === "failed") return hibernationControlLine;
    if (this.#state === "idle") {
      if (!hibernationControlLine) return false;
      this.#abort(new ProductionWorkerError(
        "HIBERNATION_REPORT_INVALID",
        "Hibernation control evidence arrived before the resume gate began.",
      ));
      return true;
    }
    if (line.includes(HIBERNATION_ENTER_PREFIX)) {
      this.#abort(new ProductionWorkerError(
        "HIBERNATION_SOURCE_REPLAY",
        "Source hibernation-entry evidence appeared in the resume target.",
      ));
      return true;
    }
    if (line.includes(HIBERNATION_COLD_BOOT_PREFIX) ||
        (this.#state !== "ready" &&
         (line.includes(GUEST_REPORT_PREFIX) || line.includes(GUEST_STAGE_PREFIX)))) {
      this.#abort(new ProductionWorkerError(
        "HIBERNATION_COLD_BOOT_FALLBACK",
        "Hibernation target reached a cold-boot guest path before authenticated resume.",
      ));
      return true;
    }
    if (line.includes(HIBERNATION_FAILURE_PREFIX) || HIBERNATION_KERNEL_FAILURE.test(line)) {
      this.#abort(new ProductionWorkerError(
        "HIBERNATION_RESUME_FAILED",
        "Guest kernel or resume hook reported a hibernation failure.",
      ));
      return true;
    }

    const evidenceMatches = [];
    for (const [index, evidence] of HIBERNATION_KERNEL_EVIDENCE.entries()) {
      const first = line.indexOf(evidence);
      if (first < 0) continue;
      evidenceMatches.push(index);
      if (line.indexOf(evidence, first + evidence.length) >= 0) evidenceMatches.push(index);
    }
    if (evidenceMatches.length > 0) {
      if (hibernationControlLine) {
        this.#abort(new ProductionWorkerError(
          "HIBERNATION_RESUME_EVIDENCE_INVALID",
          "Guest kernel and hibernation control evidence were combined on one serial line.",
        ));
        return true;
      }
      const [evidenceIndex] = evidenceMatches;
      if (this.#state === "ready" || evidenceMatches.length !== 1 ||
          evidenceIndex !== this.#kernelIndex) {
        this.#abort(new ProductionWorkerError(
          "HIBERNATION_RESUME_EVIDENCE_INVALID",
          "Guest kernel hibernation evidence is duplicated, combined, or out of order.",
        ));
        return true;
      }
      this.#kernelEvidence.push(HIBERNATION_KERNEL_EVIDENCE[evidenceIndex]);
      this.#kernelIndex += 1;
      return true;
    }

    if (line.includes(RENDERER_REPORT_PREFIX)) {
      if (this.#state === "ready" || this.#state === "verifying-marker" ||
          this.#kernelIndex !== HIBERNATION_KERNEL_EVIDENCE.length || this.#rendererReport !== null) {
        this.#abort(new ProductionWorkerError(
          "HIBERNATION_RENDERER_REPORT_INVALID",
          "Renderer report was duplicated or arrived before complete kernel resume evidence.",
        ));
        return true;
      }
      try {
        this.#rendererReport = parseRendererReportLine(line);
      } catch {
        this.#abort(new ProductionWorkerError(
          "HIBERNATION_RENDERER_REPORT_INVALID",
          "Renderer report is malformed or does not prove VirGL.",
        ));
      }
      return true;
    }

    if (!line.includes(HIBERNATION_REPORT_PREFIX)) return false;
    if (this.#state === "ready" || this.#state === "verifying-marker" ||
        this.#kernelIndex !== HIBERNATION_KERNEL_EVIDENCE.length || this.#rendererReport === null) {
      this.#abort(new ProductionWorkerError(
        "HIBERNATION_REPORT_INVALID",
        "Hibernation report was duplicated or arrived before complete kernel resume evidence.",
      ));
      return true;
    }
    try {
      const marker = parseHibernationReportLine(line);
      this.#state = "verifying-marker";
      void this.#authenticateMarker(marker);
    } catch {
      this.#abort(new ProductionWorkerError(
        "HIBERNATION_REPORT_INVALID",
        "Hibernation report is malformed.",
      ));
    }
    return true;
  }
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

export function isHibernationCheckpoint(checkpoint) {
  return checkpoint?.schemaVersion === 1 && checkpoint?.mode === "guest-hibernation-resume";
}

export function validateHibernationSourceEvidence(value) {
  const expectedKeys = [
    "diagnosticsSha256", "gpuBoundAtHibernate", "hibernationEntryMarkerSha256",
    "nonceSha256", "sourceBootId",
  ].sort();
  const actualKeys = Object.keys(value ?? {}).sort();
  if (!isRecord(value) || actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index])) {
    exactProfileMismatch("manifest.checkpoint.sourceEvidence keys", expectedKeys, actualKeys);
  }
  for (const key of ["diagnosticsSha256", "hibernationEntryMarkerSha256", "nonceSha256"]) {
    if (!SHA256.test(value[key] ?? "") || value[key] !== value[key].toLowerCase()) {
      exactProfileMismatch(`manifest.checkpoint.sourceEvidence.${key}`, "<sha256>", value[key]);
    }
  }
  if (!UUID.test(value.sourceBootId ?? "") || value.sourceBootId !== value.sourceBootId?.toLowerCase() ||
      value.gpuBoundAtHibernate !== false) {
    exactProfileMismatch(
      "manifest.checkpoint.sourceEvidence",
      "pre-desktop source identity with GPU unbound at hibernate entry",
      value,
    );
  }
  return value;
}

export function validateHibernationResumeEvidence(value) {
  const digestKeys = [
    "desktopFrame1HealthSha256", "desktopFrame1Sha256", "desktopFrame2HealthSha256",
    "desktopFrame2Sha256", "diagnosticsSha256", "footChangeSha256", "footFrameHealthSha256",
    "footFrameSha256", "hibernationMarkerSha256", "normalizedGuestReportSha256",
    "rendererProbeSha256", "reportValidationSha256",
  ];
  const expectedKeys = [...digestKeys, "freshPostResumeInteraction", "renderer"].sort();
  const actualKeys = Object.keys(value ?? {}).sort();
  if (!isRecord(value) || actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index])) {
    exactProfileMismatch("manifest.checkpoint.resumeEvidence keys", expectedKeys, actualKeys);
  }
  if (digestKeys.some((key) => !SHA256.test(value[key] ?? "") || value[key] !== value[key].toLowerCase())) {
    exactProfileMismatch("manifest.checkpoint.resumeEvidence digests", "lowercase SHA-256 values", value);
  }
  if (value.freshPostResumeInteraction !== true || typeof value.renderer !== "string" ||
      value.renderer.length === 0 || value.renderer.length > 256 || !/virgl/i.test(value.renderer) ||
      /[\r\n\0]/.test(value.renderer)) {
    exactProfileMismatch(
      "manifest.checkpoint.resumeEvidence",
      "fresh native post-resume VirGL report, healthy frames, and interaction proof",
      value,
    );
  }
  return value;
}

function validateHibernationCheckpointProfile(checkpoint) {
  const expectedKeys = [
    "derivedInitramfs", "identity", "mode", "producer", "restoreContract", "resumeEvidence",
    "rootDelta", "schemaVersion", "sourceEvidence", "swapImage",
  ].sort();
  const actualKeys = Object.keys(checkpoint).sort();
  if (actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index])) {
    exactProfileMismatch("manifest.checkpoint keys", expectedKeys, actualKeys);
  }
  validateCheckpointFile(checkpoint.rootDelta, {
    artifactPath: "hibernate-root-overlay.qcow2",
    mountPath: "/pack/hibernate-root-overlay.qcow2",
    bytes: "<positive-safe-integer>",
    sha256: "<sha256>",
    format: "qcow2",
    backingFilename: "rootfs.ext4",
    backingFormat: "raw",
  }, "rootDelta");
  validateCheckpointFile(checkpoint.derivedInitramfs, {
    artifactPath: "initramfs-virgl-hibernate.img",
    mountPath: "/pack/initramfs-virgl-hibernate.img",
    bytes: "<positive-safe-integer>",
    sha256: "<sha256>",
    format: "linux-initramfs",
    baseArtifactPath: "initramfs-linux.img",
  }, "derivedInitramfs");
  validateCheckpointFile(checkpoint.swapImage, {
    artifactPath: "omarchy-hibernate.qcow2",
    mountPath: "/pack/omarchy-hibernate.qcow2",
    bytes: "<positive-safe-integer>",
    sha256: "<sha256>",
    format: "qcow2",
    virtualBytes: HIBERNATION_SWAP_VIRTUAL_BYTES,
    swapUuid: HIBERNATION_SWAP_UUID,
  }, "swapImage");
  validateCheckpointFile(checkpoint.producer, {
    manifestArtifactPath: "hibernate-manifest.json",
    manifestBytes: "<positive-safe-integer>",
    manifestSha256: "<sha256>",
    qemuBinarySha256: "<sha256>",
  }, "producer");
  validateHibernationSourceEvidence(checkpoint.sourceEvidence);
  validateHibernationResumeEvidence(checkpoint.resumeEvidence);

  const identityKeys = [
    "baseGuestManifestSha256", "baseInitramfsSha256", "browserQemuWasmSha256",
    "derivedInitramfsSha256", "guestProvenanceSha256", "kernelSha256", "producerMachine",
    "qemu", "rootfsSha256", "runtimeMachine",
  ].sort();
  const identity = checkpoint.identity;
  if (!isRecord(identity) || Object.keys(identity).sort().join("\0") !== identityKeys.join("\0")) {
    exactProfileMismatch("manifest.checkpoint.identity keys", identityKeys, Object.keys(identity ?? {}).sort());
  }
  for (const key of [
    "baseGuestManifestSha256", "baseInitramfsSha256", "browserQemuWasmSha256",
    "derivedInitramfsSha256", "guestProvenanceSha256", "kernelSha256", "rootfsSha256",
  ]) {
    if (!SHA256.test(identity[key] ?? "") || identity[key] !== identity[key].toLowerCase()) {
      exactProfileMismatch(`manifest.checkpoint.identity.${key}`, "<sha256>", identity[key]);
    }
  }
  assertExactProfile(identity.qemu, CANONICAL_CHECKPOINT_IDENTITY.qemu,
    "manifest.checkpoint.identity.qemu");
  assertExactProfile(identity.producerMachine, CANONICAL_HIBERNATION_PRODUCER_MACHINE,
    "manifest.checkpoint.identity.producerMachine");
  assertExactProfile(identity.runtimeMachine, CANONICAL_HIBERNATION_RUNTIME_MACHINE,
    "manifest.checkpoint.identity.runtimeMachine");
  if (checkpoint.derivedInitramfs.sha256 !== identity.derivedInitramfsSha256) {
    exactProfileMismatch(
      "manifest.checkpoint.derivedInitramfs.sha256",
      identity.derivedInitramfsSha256,
      checkpoint.derivedInitramfs.sha256,
    );
  }

  const restore = checkpoint.restoreContract;
  const restoreKeys = [
    "coldBootFallbackAllowed", "disposableWrites", "gpuBoundAtHibernate", "kernelCommandLineBase",
    "resumeNonceSha256", "runtimeDisplay", "sourceBootId", "sourceEvidenceSha256",
    "sourceKernelCommandLineRedacted", "sourceKernelCommandLineSha256", "targetKernelCommandLine",
    "virtioGpuLoadedAfterResume",
  ].sort();
  if (!isRecord(restore) || Object.keys(restore).sort().join("\0") !== restoreKeys.join("\0")) {
    exactProfileMismatch("manifest.checkpoint.restoreContract keys", restoreKeys, Object.keys(restore ?? {}).sort());
  }
  for (const key of ["resumeNonceSha256", "sourceEvidenceSha256", "sourceKernelCommandLineSha256"]) {
    if (!SHA256.test(restore[key] ?? "") || restore[key] !== restore[key].toLowerCase()) {
      exactProfileMismatch(`manifest.checkpoint.restoreContract.${key}`, "<sha256>", restore[key]);
    }
  }
  if (!UUID.test(restore.sourceBootId ?? "") || restore.sourceBootId !== restore.sourceBootId?.toLowerCase()) {
    exactProfileMismatch("manifest.checkpoint.restoreContract.sourceBootId", "<lowercase-uuid>", restore.sourceBootId);
  }
  if (restore.coldBootFallbackAllowed !== false || restore.gpuBoundAtHibernate !== false ||
      restore.virtioGpuLoadedAfterResume !== true ||
      restore.runtimeDisplay !== CANONICAL_HIBERNATION_RUNTIME_MACHINE.display ||
      restore.disposableWrites !== "target -snapshot layers over immutable root delta and hibernation image") {
    exactProfileMismatch("manifest.checkpoint.restoreContract", "canonical fail-closed hibernation contract", restore);
  }
  for (const key of ["kernelCommandLineBase", "sourceKernelCommandLineRedacted", "targetKernelCommandLine"]) {
    if (typeof restore[key] !== "string" || restore[key].length === 0 || restore[key].length > 2048 ||
        /[\r\n\0]/.test(restore[key])) {
      exactProfileMismatch(`manifest.checkpoint.restoreContract.${key}`, "<bounded-kernel-command-line>", restore[key]);
    }
  }
  const targetArguments = restore.kernelCommandLineBase.split(/\s+/);
  const resumeArgument = `resume=UUID=${HIBERNATION_SWAP_UUID}`;
  if (restore.kernelCommandLineBase !== CANONICAL_HIBERNATION_KERNEL_COMMAND_LINE_BASE ||
      restore.targetKernelCommandLine !== `${restore.kernelCommandLineBase} omarchy.hibernate_target=1` ||
      restore.sourceKernelCommandLineRedacted !==
        `${restore.kernelCommandLineBase} omarchy.hibernate_producer=1 omarchy.hibernate_nonce=<redacted>` ||
      targetArguments.some((argument) =>
        /^omarchy\.hibernate_(?:producer|target|nonce)=/.test(argument)) ||
      !targetArguments.includes(resumeArgument) || !targetArguments.includes("ignore_loglevel") ||
      !targetArguments.includes("hibernate.compressor=lzo") || !targetArguments.includes("root=/dev/vda") ||
      restore.resumeNonceSha256 !== checkpoint.sourceEvidence.nonceSha256 ||
      restore.sourceBootId !== checkpoint.sourceEvidence.sourceBootId ||
      restore.gpuBoundAtHibernate !== checkpoint.sourceEvidence.gpuBoundAtHibernate) {
    exactProfileMismatch(
      "manifest.checkpoint.restoreContract.targetKernelCommandLine",
      `a shared base containing root=/dev/vda, ${resumeArgument}, ignore_loglevel, and hibernate.compressor=lzo with exclusive source/target role suffixes`,
      restore.targetKernelCommandLine,
    );
  }
  return checkpoint;
}

export function validateCheckpointProfile(checkpoint) {
  if (!isRecord(checkpoint)) {
    exactProfileMismatch("manifest.checkpoint", "canonical checkpoint profile", checkpoint);
  }
  if (isHibernationCheckpoint(checkpoint)) return validateHibernationCheckpointProfile(checkpoint);
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
  if (isHibernationCheckpoint(checkpoint)) {
    validateHibernationSourceEvidence(value.sourceEvidence);
    assertExactProfile(value.sourceEvidence, checkpoint.sourceEvidence,
      "hibernation producer manifest.sourceEvidence");
  } else {
    validateCheckpointSourceEvidenceShape(value.sourceEvidence);
  }
  const comparableValue = { ...value };
  delete comparableValue.sourceEvidence;
  if (isHibernationCheckpoint(checkpoint)) {
    const expected = {
      schemaVersion: 1,
      kind: "omarchy-web-guest-hibernation",
      derivedInitramfs: {
        artifactPath: checkpoint.derivedInitramfs.artifactPath,
        bytes: checkpoint.derivedInitramfs.bytes,
        sha256: checkpoint.derivedInitramfs.sha256,
        format: checkpoint.derivedInitramfs.format,
        baseArtifactPath: checkpoint.derivedInitramfs.baseArtifactPath,
      },
      rootDelta: {
        path: checkpoint.rootDelta.artifactPath,
        bytes: checkpoint.rootDelta.bytes,
        sha256: checkpoint.rootDelta.sha256,
        format: checkpoint.rootDelta.format,
        backingFilename: checkpoint.rootDelta.backingFilename,
        backingFormat: checkpoint.rootDelta.backingFormat,
      },
      swapImage: {
        path: checkpoint.swapImage.artifactPath,
        bytes: checkpoint.swapImage.bytes,
        sha256: checkpoint.swapImage.sha256,
        format: checkpoint.swapImage.format,
        virtualBytes: checkpoint.swapImage.virtualBytes,
        swapUuid: checkpoint.swapImage.swapUuid,
      },
      producer: { qemuBinarySha256: checkpoint.producer.qemuBinarySha256 },
      resumeEvidence: { ...checkpoint.resumeEvidence },
      identity: {
        baseGuestManifestSha256: checkpoint.identity.baseGuestManifestSha256,
        rootfsSha256: checkpoint.identity.rootfsSha256,
        guestProvenanceSha256: checkpoint.identity.guestProvenanceSha256,
        kernelSha256: checkpoint.identity.kernelSha256,
        baseInitramfsSha256: checkpoint.identity.baseInitramfsSha256,
        derivedInitramfsSha256: checkpoint.identity.derivedInitramfsSha256,
        browserQemuWasmSha256: checkpoint.identity.browserQemuWasmSha256,
      },
      qemu: { ...checkpoint.identity.qemu },
      producerMachine: structuredClone(checkpoint.identity.producerMachine),
      runtimeMachine: structuredClone(checkpoint.identity.runtimeMachine),
      restoreContract: { ...checkpoint.restoreContract },
    };
    try {
      assertExactProfile(comparableValue, expected, "hibernation producer manifest");
    } catch (error) {
      if (error instanceof ProductionWorkerError) {
        fail(
          "CHECKPOINT_PROVENANCE_MISMATCH",
          "Hibernation producer manifest does not match the verified browser resume contract.",
          { cause: serializeError(error) },
        );
      }
      throw error;
    }
    return value;
  }
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

export async function validateHibernationProducerEvidence(
  value,
  checkpoint,
  scope = globalThis,
) {
  if (!isHibernationCheckpoint(checkpoint)) {
    fail("INVALID_HIBERNATION_EVIDENCE", "Hibernation producer evidence requires a hibernation checkpoint.");
  }
  validateCheckpointProducerDocument(value, checkpoint);
  validateHibernationSourceEvidence(value.sourceEvidence);
  const sourceEvidenceSha256 = await sha256Hex(normalizedJsonBytes(value.sourceEvidence), scope);
  if (sourceEvidenceSha256 !== checkpoint.restoreContract.sourceEvidenceSha256) {
    fail("CHECKPOINT_SOURCE_EVIDENCE_INVALID", "Hibernation source evidence digest is invalid.");
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
    const kernel = isHibernationCheckpoint(checkpoint) ? artifactAt(artifacts, "vmlinuz-linux") : null;
    const initramfs = isHibernationCheckpoint(checkpoint)
      ? artifactAt(artifacts, checkpoint.derivedInitramfs.baseArtifactPath)
      : null;
    if (rootfs.sha256 !== checkpoint.identity.rootfsSha256 ||
        provenance.sha256 !== checkpoint.identity.guestProvenanceSha256 ||
        (isHibernationCheckpoint(checkpoint) &&
         (kernel.sha256 !== checkpoint.identity.kernelSha256 ||
          initramfs.sha256 !== checkpoint.identity.baseInitramfsSha256))) {
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
    return manifest;
  }
  const coldProfile = {
    ...manifest,
    qemu: { ...manifest.qemu, arguments: [...(manifest.qemu?.arguments ?? [])] },
  };
  delete coldProfile.checkpoint;
  validateCheckpointProfile(manifest.checkpoint);
  if (isHibernationCheckpoint(manifest.checkpoint)) {
    const { runtimeMachine } = manifest.checkpoint.identity;
    assertExactProfile(coldProfile.guest.initramfs, {
      artifactPath: manifest.checkpoint.derivedInitramfs.artifactPath,
      mountPath: manifest.checkpoint.derivedInitramfs.mountPath,
    }, "manifest.guest.initramfs");
    coldProfile.guest = {
      ...coldProfile.guest,
      initramfs: { ...CANONICAL_PRODUCTION_MANIFEST.guest.initramfs },
    };
    const initrdIndexes = coldProfile.qemu.arguments.flatMap((value, index) => value === "-initrd" ? [index] : []);
    if (initrdIndexes.length !== 1 ||
        coldProfile.qemu.arguments[initrdIndexes[0] + 1] !== manifest.checkpoint.derivedInitramfs.mountPath) {
      exactProfileMismatch(
        "manifest.qemu.arguments hibernation initrd",
        manifest.checkpoint.derivedInitramfs.mountPath,
        initrdIndexes.length === 1 ? coldProfile.qemu.arguments[initrdIndexes[0] + 1] : initrdIndexes,
      );
    }
    coldProfile.qemu.arguments[initrdIndexes[0] + 1] =
      CANONICAL_PRODUCTION_MANIFEST.guest.initramfs.mountPath;
    const appendIndexes = coldProfile.qemu.arguments.flatMap((value, index) => value === "-append" ? [index] : []);
    if (appendIndexes.length !== 1 ||
        coldProfile.qemu.arguments[appendIndexes[0] + 1] !== manifest.checkpoint.restoreContract.targetKernelCommandLine) {
      exactProfileMismatch(
        "manifest.qemu.arguments hibernation command line",
        manifest.checkpoint.restoreContract.targetKernelCommandLine,
        appendIndexes.length === 1 ? coldProfile.qemu.arguments[appendIndexes[0] + 1] : appendIndexes,
      );
    }
    const canonicalAppend = CANONICAL_PRODUCTION_MANIFEST.qemu.arguments.indexOf("-append");
    coldProfile.qemu.arguments[appendIndexes[0] + 1] =
      CANONICAL_PRODUCTION_MANIFEST.qemu.arguments[canonicalAppend + 1];

    const cpuIndexes = coldProfile.qemu.arguments.flatMap((value, index) => value === "-cpu" ? [index] : []);
    if (cpuIndexes.length !== 1 || coldProfile.qemu.arguments[cpuIndexes[0] + 1] !== runtimeMachine.cpu) {
      exactProfileMismatch("manifest.qemu.arguments hibernation CPU", runtimeMachine.cpu, cpuIndexes);
    }
    coldProfile.qemu.arguments.splice(cpuIndexes[0], 2);

    const runtimeDisplay = manifest.checkpoint.restoreContract.runtimeDisplay;
    const displayIndexes = coldProfile.qemu.arguments.flatMap((value, index) =>
      value === "-display" && coldProfile.qemu.arguments[index + 1] === runtimeDisplay ? [index] : []);
    if (displayIndexes.length !== 1) {
      exactProfileMismatch("manifest.qemu.arguments hibernation display", runtimeDisplay, displayIndexes);
    }
    coldProfile.qemu.arguments[displayIndexes[0] + 1] =
      CANONICAL_PRODUCTION_MANIFEST.qemu.arguments[CANONICAL_PRODUCTION_MANIFEST.qemu.arguments.indexOf("-display") + 1];
    const deviceIndexes = coldProfile.qemu.arguments.flatMap((value, index) =>
      value === "-device" && coldProfile.qemu.arguments[index + 1] === runtimeMachine.displayDevice ? [index] : []);
    if (deviceIndexes.length !== 1) {
      exactProfileMismatch("manifest.qemu.arguments hibernation display device", runtimeMachine.displayDevice, deviceIndexes);
    }
    const canonicalDevice = CANONICAL_PRODUCTION_MANIFEST.qemu.arguments.findIndex((value, index, values) =>
      values[index - 1] === "-device" &&
      /^virtio-vga(?:-gl)?,max_outputs=1,xres=1600,yres=900$/.test(value));
    if (canonicalDevice < 0) {
      exactProfileMismatch("canonical display device", "one canonical virtio-vga display", canonicalDevice);
    }
    coldProfile.qemu.arguments[deviceIndexes[0] + 1] = CANONICAL_PRODUCTION_MANIFEST.qemu.arguments[canonicalDevice];
  }
  assertExactProfile(coldProfile, CANONICAL_PRODUCTION_MANIFEST);
  return manifest;
}

export function checkpointArgumentsForManifest(manifest) {
  if (!isRecord(manifest) || !("checkpoint" in manifest)) return null;
  validateProductionManifest(manifest);
  if (isHibernationCheckpoint(manifest.checkpoint)) return [...CANONICAL_HIBERNATION_ARGUMENTS];
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

export function createVerifiedExecutableUrls({ module, pthread, wasm }, scope) {
  return deepFreeze({
    module: createVerifiedBlobUrl(module, scope, "text/javascript"),
    locate: {
      "qemu-system-x86_64.wasm": createVerifiedBlobUrl(wasm, scope, "application/wasm"),
      "qemu-system-x86_64.worker.js": createVerifiedBlobUrl(pthread, scope, "text/javascript"),
    },
  });
}

export async function prepareVerifiedExecutables(artifacts, base, scope) {
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
  const hibernation = isHibernationCheckpoint(checkpoint);
  const vmstate = hibernation ? null : assertCheckpointArtifactRecord(artifacts, checkpoint.vmstate, "VM state");
  const bootDelta = hibernation ? null : assertCheckpointArtifactRecord(artifacts, checkpoint.bootDelta, "Boot delta");
  const rootDelta = hibernation
    ? assertCheckpointArtifactRecord(artifacts, checkpoint.rootDelta, "Hibernation root delta")
    : null;
  const swapImage = hibernation
    ? assertCheckpointArtifactRecord(artifacts, checkpoint.swapImage, "Hibernation swap image")
    : null;
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
  const wasmPath = manifest.assets.locate["qemu-system-x86_64.wasm"];
  const wasm = artifactAt(artifacts, wasmPath);
  if (wasm.sha256 !== checkpoint.identity.browserQemuWasmSha256) {
    fail("CHECKPOINT_QEMU_MISMATCH", "Checkpoint is not compatible with the verified browser QEMU build.");
  }
  const kernel = hibernation ? artifactAt(artifacts, manifest.guest.kernel.artifactPath) : null;
  const initramfs = hibernation ? assertCheckpointArtifactRecord(
    artifacts,
    checkpoint.derivedInitramfs,
    "Hibernation initramfs",
  ) : null;
  const baseInitramfs = hibernation
    ? artifactAt(artifacts, checkpoint.derivedInitramfs.baseArtifactPath)
    : null;
  if (hibernation && (kernel.sha256 !== checkpoint.identity.kernelSha256 ||
      initramfs.sha256 !== checkpoint.identity.derivedInitramfsSha256 ||
      baseInitramfs.sha256 !== checkpoint.identity.baseInitramfsSha256)) {
    fail("HIBERNATION_BOOTSTRAP_MISMATCH", "Hibernation kernel or initramfs differs from its resume image.");
  }
  return Object.freeze({
    vmstate,
    bootDelta,
    rootDelta,
    swapImage,
    producerManifest,
    guestManifest,
    rootfs,
    provenance,
    wasm,
    kernel,
    initramfs,
    baseInitramfs,
  });
}

export function checkpointCachePlan(manifest) {
  if (!isRecord(manifest) || !("checkpoint" in manifest)) return null;
  validateProductionManifest(manifest);
  const plan = isHibernationCheckpoint(manifest.checkpoint)
    ? Object.freeze({
        rootfs: Object.freeze({ chunkBytes: 1024 * 1024, maxCachedBytes: HIBERNATION_ROOTFS_CACHE_BYTES }),
        rootDelta: Object.freeze({
          chunkBytes: 1024 * 1024,
          maxCachedBytes: HIBERNATION_ROOT_DELTA_CACHE_BYTES,
        }),
        swapImage: Object.freeze({ chunkBytes: 1024 * 1024, maxCachedBytes: HIBERNATION_SWAP_CACHE_BYTES }),
      })
    : Object.freeze({
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
  #hibernationResumeGate = null;
  #hibernationResumeEvidence = null;
  #hibernationGuestReportTimer = null;
  #deferredHibernationEvidence = [];
  #deferredHibernationEvidenceBytes = 0;
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
    if (this.#hibernationGuestReportTimer !== null) {
      this.#scope.clearTimeout?.(this.#hibernationGuestReportTimer);
      this.#hibernationGuestReportTimer = null;
    }
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
      const hibernationCheckpoint = checkpointArtifacts !== null &&
        isHibernationCheckpoint(runtimeManifest.checkpoint);
      const guestDescriptorArtifact = artifactAt(artifacts, "guest-manifest.json");
      this.#browserPerformance = createBrowserPerformanceRuntimeController({
        identity: Object.freeze({
          artifactManifestSha256,
          runtimeManifestSha256: runtimeManifestArtifact.sha256,
          guestDescriptorSha256: guestDescriptorArtifact.sha256,
          hibernateDescriptorSha256: hibernationCheckpoint
            ? checkpointArtifacts.producerManifest.sha256
            : null,
        }),
        clock: this.#scope.performance,
        cryptoScope: this.#scope.crypto,
        getInstance: () => this.#instance,
        dispatchInput: dispatchSanitizedWorkerInputWithReceipt,
        onState: (performance) => this.#post("browserperformancestate", { performance }),
        onCapture: (capture) => this.#post("browserperformancecapture", { capture }),
      });
      let checkpointSourceEvidence = null;
      let hibernationProducerDocument = null;
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
        if (hibernationCheckpoint) {
          await validateHibernationProducerEvidence(
            producerDocument,
            runtimeManifest.checkpoint,
            this.#scope,
          );
          hibernationProducerDocument = producerDocument;
        } else {
          await validateCheckpointSourceEvidence(
            producerDocument.sourceEvidence,
            this.#releaseIdentity.upstream,
            this.#scope,
          );
          checkpointSourceEvidence = producerDocument.sourceEvidence;
        }
      }
      const checkpointPaths = checkpointArtifacts === null ? [] : hibernationCheckpoint
        ? [
            runtimeManifest.checkpoint.derivedInitramfs.artifactPath,
            runtimeManifest.checkpoint.derivedInitramfs.baseArtifactPath,
            runtimeManifest.checkpoint.rootDelta.artifactPath,
            runtimeManifest.checkpoint.swapImage.artifactPath,
            runtimeManifest.checkpoint.producer.manifestArtifactPath,
            "guest-manifest.json",
            "provenance.json",
          ]
        : [
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
        if (hibernationCheckpoint) {
          const [rootDeltaFile, swapImageFile] = await Promise.all([
            prepareImmutablePagedFile({
              url: releaseUrl(base, checkpointArtifacts.rootDelta.path),
              path: checkpoint.rootDelta.mountPath,
              byteLength: checkpointArtifacts.rootDelta.bytes,
              sha256: checkpointArtifacts.rootDelta.sha256,
              ...cachePlan.rootDelta,
            }, {
              ...commonCheckpointOptions,
              onRequest: (request) => this.#post("diskrequest", {
                artifact: "hibernation-root-delta",
                request,
              }),
            }),
            prepareImmutablePagedFile({
              url: releaseUrl(base, checkpointArtifacts.swapImage.path),
              path: checkpoint.swapImage.mountPath,
              byteLength: checkpointArtifacts.swapImage.bytes,
              sha256: checkpointArtifacts.swapImage.sha256,
              ...cachePlan.swapImage,
            }, {
              ...commonCheckpointOptions,
              onRequest: (request) => this.#post("diskrequest", {
                artifact: "hibernation-swap-image",
                request,
              }),
            }),
          ]);
          checkpointPagedFiles = [rootDeltaFile, swapImageFile];
          this.#post("checkpoint", {
            mode: checkpoint.mode,
            derivedInitramfsBytes: checkpoint.derivedInitramfs.bytes,
            rootDeltaBytes: checkpoint.rootDelta.bytes,
            swapImageBytes: checkpoint.swapImage.bytes,
            swapVirtualBytes: checkpoint.swapImage.virtualBytes,
            cacheBytes: CHECKPOINT_TOTAL_CACHE_BYTES,
          });
        } else {
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
        }
        pagedDiskArguments = checkpointArgumentsForManifest(runtimeManifest);
      }

      const locate = runtimeManifest.assets.locate;
      const executables = await prepareVerifiedExecutables(
        {
          module: artifactAt(artifacts, runtimeManifest.assets.module),
          wasm: artifactAt(artifacts, locate["qemu-system-x86_64.wasm"]),
          pthread: artifactAt(artifacts, locate["qemu-system-x86_64.worker.js"]),
        },
        base,
        this.#scope,
      );
      this.#setPhase("starting-emulator");
      const { default: createQemu } = await import(executables.urls.module);
      if (typeof createQemu !== "function") fail("INVALID_QEMU_MODULE", "QEMU module has no default factory export.");
      if (hibernationCheckpoint) {
        this.#hibernationResumeGate = new HibernationResumeGate({
          checkpoint: runtimeManifest.checkpoint,
          scope: this.#scope,
          onFailure: (error) => this.fail(error),
        });
        this.#hibernationResumeGate.begin();
      }

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
              checkpoint: checkpointArtifacts !== null && !hibernationCheckpoint,
              alreadySeen: this.#guestReportSeen,
              expectedUpstream: this.#releaseIdentity.upstream,
            });
            this.#guestReportSeen = true;
            if (this.#hibernationGuestReportTimer !== null) {
              this.#scope.clearTimeout(this.#hibernationGuestReportTimer);
              this.#hibernationGuestReportTimer = null;
            }
            this.#post("guestreport", hibernationCheckpoint ? {
              report,
              origin: "live-hibernation-serial",
              resume: {
                descriptorSha256: runtimeManifest.checkpoint.producer.manifestSha256,
                markerSha256: this.#hibernationResumeEvidence.markerSha256,
                sourceBootId: runtimeManifest.checkpoint.restoreContract.sourceBootId,
                swapUuid: runtimeManifest.checkpoint.swapImage.swapUuid,
              },
            } : { report, origin: "live-guest-serial" });
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
      const queueHibernationEvidence = (stream, line) => {
        const lineBytes = new TextEncoder().encode(line).byteLength;
        if (this.#deferredHibernationEvidence.length >= MAX_DEFERRED_HIBERNATION_EVIDENCE_LINES ||
            this.#deferredHibernationEvidenceBytes + lineBytes >
              MAX_DEFERRED_HIBERNATION_EVIDENCE_BYTES) {
          this.fail(new ProductionWorkerError(
            "HIBERNATION_EVIDENCE_QUEUE_FULL",
            "Post-resume guest evidence exceeded its bounded authentication queue.",
          ));
          return;
        }
        this.#deferredHibernationEvidence.push(Object.freeze({ stream, line }));
        this.#deferredHibernationEvidenceBytes += lineBytes;
      };
      const emitSerial = (stream, value) => {
        const line = String(value);
        if (this.#desktopProof.handleSerialLine(line)) return;
        const hibernationEvidenceLine = hibernationCheckpoint &&
          (line.includes(GUEST_REPORT_PREFIX) || line.includes(GUEST_STAGE_PREFIX));
        if (hibernationEvidenceLine && this.#hibernationResumeEvidence === null &&
            this.#hibernationResumeGate?.state === "verifying-marker") {
          queueHibernationEvidence(stream, line);
          return;
        }
        if (this.#hibernationResumeGate?.handleSerialLine(line)) return;
        if (hibernationEvidenceLine && this.#hibernationResumeEvidence === null) {
          queueHibernationEvidence(stream, line);
          return;
        }
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
      if (hibernationCheckpoint) {
        if (hibernationProducerDocument === null || this.#guestReportSeen) {
          fail(
            "HIBERNATION_REPORT_ORDER_INVALID",
            "Hibernation runtime reached resume acceptance without an authenticated descriptor or emitted a guest report too early.",
          );
        }
        this.#hibernationResumeEvidence = await this.#hibernationResumeGate.wait();
        const resumeEvidence = Object.freeze({
          schemaVersion: 1,
          checkpointMode: "guest-hibernation-resume",
          descriptorSha256: runtimeManifest.checkpoint.producer.manifestSha256,
          markerSha256: this.#hibernationResumeEvidence.markerSha256,
          rendererReportSha256: this.#hibernationResumeEvidence.rendererReportSha256,
          renderer: "virgl",
          sourceBootId: runtimeManifest.checkpoint.restoreContract.sourceBootId,
          swapUuid: runtimeManifest.checkpoint.swapImage.swapUuid,
          kernelEvidence: this.#hibernationResumeEvidence.kernelEvidence,
          runtimeDisplay: runtimeManifest.checkpoint.restoreContract.runtimeDisplay,
          derivedInitramfsSha256: runtimeManifest.checkpoint.identity.derivedInitramfsSha256,
        });
        this.#post("hibernationresume", { evidence: resumeEvidence });
        this.#hibernationGuestReportTimer = this.#scope.setTimeout(() => this.fail(
          new ProductionWorkerError(
            "HIBERNATION_GUEST_REPORT_TIMEOUT",
            "Resumed guest did not emit a fresh authenticated serial report within its bound.",
          ),
        ), HIBERNATION_GUEST_REPORT_TIMEOUT_MS);
        const deferredEvidence = this.#deferredHibernationEvidence.splice(0);
        this.#deferredHibernationEvidenceBytes = 0;
        for (const { stream, line } of deferredEvidence) {
          processSerial(stream, line);
          if (this.#phase === "failed") break;
        }
        if (this.#phase === "failed") {
          throw this.#failure ?? new ProductionWorkerError(
            "HIBERNATION_DEFERRED_EVIDENCE_INVALID",
            "Deferred post-resume guest evidence failed authentication.",
          );
        }
      }
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
    if ((this.#hibernationResumeGate !== null && !this.#guestReportSeen) ||
        this.#checkpointDesktopSettle?.blocksHostInput || this.#desktopProof.blocksHostInput) {
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
