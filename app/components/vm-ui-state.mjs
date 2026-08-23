import {
  DESKTOP_PROOF_SAMPLE_PIXELS,
  isDesktopProof,
} from "../../public/vm/desktop-proof.mjs";
import {
  guestReportProvenanceMatches,
  normalizeGuestReportProvenance,
  normalizeHibernationResumeEvidence,
} from "../../public/vm/host-utils.mjs";

export const DISPLAY_WIDTH = 1600;
export const DISPLAY_HEIGHT = 900;
// Publication replaces this all-zero fail-closed sentinel with the SHA-256 of
// the exact artifact-manifest.json bytes. A commit prefix is not a trust pin.
export const ACTIVE_RELEASE_ID =
  "0000000000000000000000000000000000000000000000000000000000000000";
export const RELEASE_BASE_URL = `/omarchy/versions/${ACTIVE_RELEASE_ID}/`;
export const PRODUCTION_WORKER_URL = `${RELEASE_BASE_URL}production-worker.mjs`;
export const ACTIVE_UPSTREAM = Object.freeze({
  repository: "https://github.com/basecamp/omarchy",
  commit: "7488eaded43de68ff9d2d7e4bf50cd48e112eb0f",
  version: "4.0.0.alpha",
  treeSha256:
    "2b8670686876008cfd1e675a107fddcc01edf3919b2566348308e0bc2857f692",
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const UNPUBLISHED_RELEASE_ID = "0".repeat(64);

export function isPublishableReleaseId(value) {
  return (
    typeof value === "string" &&
    SHA256_PATTERN.test(value) &&
    value.toLowerCase() !== UNPUBLISHED_RELEASE_ID
  );
}

export const CAPABILITY_DEFINITIONS = Object.freeze([
  { key: "webAssembly", label: "WebAssembly" },
  { key: "crossOriginIsolated", label: "Isolated page" },
  { key: "sharedArrayBuffer", label: "Shared memory" },
  { key: "wasmThreads", label: "Wasm threads" },
  { key: "offscreenCanvas", label: "Offscreen canvas" },
]);

function supportsSharedWasmMemory(scope) {
  try {
    if (
      typeof scope.WebAssembly?.Memory !== "function" ||
      typeof scope.SharedArrayBuffer !== "function"
    ) {
      return false;
    }

    const memory = new scope.WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    return memory.buffer instanceof scope.SharedArrayBuffer;
  } catch {
    return false;
  }
}

/**
 * Inspect every browser primitive required by the threaded QEMU-Wasm build.
 * Keeping this independent of the runtime artifact lets the launcher explain
 * unsupported browsers before downloading the VM.
 */
export function inspectVmCapabilities(scope = globalThis) {
  const canvasPrototype = scope.HTMLCanvasElement?.prototype;
  const checks = {
    webAssembly:
      typeof scope.WebAssembly === "object" ||
      typeof scope.WebAssembly === "function",
    workers: typeof scope.Worker === "function",
    atomics: typeof scope.Atomics === "object",
    crossOriginIsolated: scope.crossOriginIsolated === true,
    sharedArrayBuffer: typeof scope.SharedArrayBuffer === "function",
    offscreenCanvas:
      typeof scope.OffscreenCanvas === "function" ||
      typeof canvasPrototype?.transferControlToOffscreen === "function",
    wasmThreads: supportsSharedWasmMemory(scope),
  };

  const missing = Object.entries(checks)
    .filter(([, available]) => !available)
    .map(([key]) => key);

  return { supported: missing.length === 0, checks, missing };
}

const CAPABILITY_ISSUES = {
  webAssembly: "WebAssembly",
  workers: "Web Workers",
  atomics: "Atomics",
  crossOriginIsolated: "COOP/COEP page isolation",
  sharedArrayBuffer: "SharedArrayBuffer",
  offscreenCanvas: "OffscreenCanvas",
  wasmThreads: "shared WebAssembly memory",
};

export function describeCapabilityIssue(report) {
  if (!report || report.supported) return "";
  return report.missing
    .map((key) => CAPABILITY_ISSUES[key] ?? key)
    .join(", ");
}

const PHASES = {
  idle: {
    title: "Ready when you are",
    detail: "The VM starts only after you ask for it.",
    stage: 0,
  },
  "loading-runtime": {
    title: "Connecting the VM runtime",
    detail: "Loading the browser-native x86_64 emulator.",
    stage: 1,
  },
  "loading-manifest": {
    title: "Reading the runtime manifest",
    detail: "Checking the exact emulator and guest artifact set.",
    stage: 1,
  },
  "loading-artifact-manifest": {
    title: "Verifying the release",
    detail: "Checking the immutable emulator and Omarchy artifact set.",
    stage: 1,
  },
  "loading-runtime-manifest": {
    title: "Reading the VM profile",
    detail: "Checking the paged x86_64 runtime configuration.",
    stage: 1,
  },
  "loading-guest": {
    title: "Loading Omarchy",
    detail: "The guest image is moving into this tab's memory.",
    stage: 2,
  },
  "preflighting-rootfs": {
    title: "Connecting the Omarchy disk",
    detail: "Verifying byte-range access without downloading the full image.",
    stage: 2,
  },
  "starting-emulator": {
    title: "Starting the x86_64 machine",
    detail: "QEMU is handing the real guest display to this canvas.",
    stage: 3,
  },
  running: {
    title: "Waiting for the Omarchy desktop",
    detail: "The emulator is running; readiness must come from the guest.",
    stage: 3,
  },
  unsupported: {
    title: "This browser cannot start the VM",
    detail: "A required browser capability is unavailable.",
    stage: 0,
  },
  failed: {
    title: "The emulator stopped",
    detail: "Open diagnostics for the last output, then start a fresh session.",
    stage: 0,
  },
  error: {
    title: "Omarchy could not start",
    detail: "The session did not reach the guest boot stage.",
    stage: 0,
  },
};

export function getPhasePresentation(phase, guestReady = false) {
  if (guestReady) {
    return {
      title: "Omarchy desktop ready",
      detail:
        "The pinned guest, authenticated desktop transition, and later display frame are verified.",
      stage: 4,
    };
  }

  return PHASES[phase] ?? {
    title: "Starting Omarchy",
    detail: `Runtime phase: ${String(phase)}`,
    stage: 1,
  };
}

export function normalizeRuntimeError(error) {
  const technical = error instanceof Error ? error.message : String(error);
  const normalized = technical.toLowerCase();
  const artifactMissing = [
    "failed to fetch dynamically imported module",
    "importing a module script failed",
    "runtime manifest request failed with http 404",
    "artifact manifest request failed with http 404",
    "production worker request failed with http 404",
    "failed to load /omarchy/",
    "failed to load module script",
    "module not found",
    "active release id is required",
  ].some((fragment) => normalized.includes(fragment));

  if (artifactMissing) {
    return {
      kind: "artifacts-missing",
      title: "The VM files are not available yet",
      message:
        "This page is working, but the Omarchy runtime bundle at /omarchy/ could not be loaded. Retry after the artifact upload finishes.",
      technical,
      recoverable: true,
    };
  }

  if (
    normalized.includes("out of memory") ||
    normalized.includes("memory allocation")
  ) {
    return {
      kind: "memory",
      title: "The browser could not reserve enough memory",
      message:
        "Close memory-heavy tabs, reset this disposable session, and try again.",
      technical,
      recoverable: true,
    };
  }

  return {
    kind: "runtime",
    title: "Omarchy could not start",
    message:
      "No changes were made to your computer. Reset to replace this disposable VM with a clean session.",
    technical,
    recoverable: true,
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

export function isActiveReleaseIdentity(
  value,
  expectedReleaseId = ACTIVE_RELEASE_ID,
) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["upstream", "artifactManifestSha256"])) ||
    !isRecord(value.upstream) ||
    !hasOnlyKeys(
      value.upstream,
      new Set(["repository", "commit", "version", "treeSha256"]),
    )
  ) {
    return false;
  }
  return (
    Object.entries(ACTIVE_UPSTREAM).every(
      ([key, expected]) => value.upstream[key] === expected,
    ) &&
    isPublishableReleaseId(expectedReleaseId) &&
    value.artifactManifestSha256 === expectedReleaseId.toLowerCase()
  );
}

export function guestReportMatchesRelease(
  report,
  release,
  expectedReleaseId = ACTIVE_RELEASE_ID,
) {
  if (
    !isGuestReadyReport(report) ||
    !isActiveReleaseIdentity(release, expectedReleaseId)
  ) {
    return false;
  }
  return Object.entries(release.upstream).every(
    ([key, expected]) => report.provenance[key] === expected,
  );
}

export function guestReportEvidenceMatchesRelease(
  evidence,
  release,
  expectedReleaseId = ACTIVE_RELEASE_ID,
  expectedProvenance,
) {
  if (
    !isRecord(evidence) ||
    !guestReportMatchesRelease(evidence.report, release, expectedReleaseId) ||
    !guestReportProvenanceMatches(
      evidence.origin === "checkpoint-source-evidence"
        ? {
            origin: evidence.origin,
            sourceEvidence: evidence.sourceEvidence,
          }
        : evidence.origin === "live-hibernation-serial"
          ? { origin: evidence.origin, resume: evidence.resume }
          : { origin: evidence.origin },
      expectedProvenance,
    )
  ) {
    return false;
  }
  const expectedKeys = evidence.origin === "checkpoint-source-evidence"
    ? new Set(["type", "report", "origin", "sourceEvidence"])
    : evidence.origin === "live-hibernation-serial"
      ? new Set(["type", "report", "origin", "resume"])
      : new Set(["type", "report", "origin"]);
  return hasOnlyKeys(evidence, expectedKeys);
}

/**
 * A phase named `running` only proves that QEMU started. The UI may claim the
 * desktop is ready exclusively after this guest-originated evidence arrives.
 */
export function isGuestReadyReport(value) {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (!isRecord(value.system) || !isRecord(value.provenance)) return false;

  const generatedAtMatches =
    typeof value.generatedAt === "string" &&
    !Number.isNaN(Date.parse(value.generatedAt));

  const systemMatches =
    value.system.architecture === "x86_64" &&
    value.system.distribution === "Arch Linux" &&
    value.system.sessionType === "wayland" &&
    typeof value.system.kernel === "string" &&
    value.system.kernel.length > 0;
  const provenanceMatches =
    value.provenance.repository === "https://github.com/basecamp/omarchy" &&
    typeof value.provenance.commit === "string" &&
    /^[0-9a-f]{40}$/i.test(value.provenance.commit) &&
    typeof value.provenance.version === "string" &&
    value.provenance.version.length > 0 &&
    typeof value.provenance.treeSha256 === "string" &&
    /^[0-9a-f]{64}$/i.test(value.provenance.treeSha256);

  const components = Array.isArray(value.components) ? value.components : [];
  const processes = Array.isArray(value.processes) ? value.processes : [];
  const compositor = components.find(
    (component) => isRecord(component) && component.role === "compositor",
  );
  const shell = components.find(
    (component) => isRecord(component) && component.role === "shell",
  );
  const compositorMatches =
    isRecord(compositor) &&
    String(compositor.name).toLowerCase() === "hyprland" &&
    typeof compositor.version === "string" &&
    compositor.version.length > 0 &&
    typeof compositor.executable === "string" &&
    compositor.executable.startsWith("/") &&
    processes.some(
      (process) =>
        isRecord(process) &&
        String(process.name).toLowerCase() === "hyprland" &&
        Number.isInteger(process.pid) &&
        process.pid > 1,
    );
  const shellMatches =
    isRecord(shell) &&
    typeof shell.name === "string" &&
    shell.name.length > 0 &&
    typeof shell.version === "string" &&
    shell.version.length > 0 &&
    typeof shell.executable === "string" &&
    shell.executable.startsWith("/") &&
    processes.some(
      (process) =>
        isRecord(process) &&
        typeof process.name === "string" &&
        process.name.toLowerCase().includes(shell.name.toLowerCase()) &&
        Number.isInteger(process.pid) &&
        process.pid > 1,
    );

  const commands = Array.isArray(value.commands) ? value.commands : [];
  const commandMap = new Map(
    commands
      .filter(isRecord)
      .map((command) => [
        Array.isArray(command.argv) ? command.argv.join(" ") : "",
        command,
      ]),
  );
  const requiredCommands = [
    "uname -m",
    "hyprctl version",
    "hyprctl monitors -j",
    "omarchy-version",
  ];
  const monitorCommand = commandMap.get("hyprctl monitors -j");
  let monitorMatches = false;
  try {
    const monitors = JSON.parse(monitorCommand?.stdout ?? "");
    monitorMatches =
      Array.isArray(monitors) &&
      monitors.length === 1 &&
      isRecord(monitors[0]) &&
      monitors[0].width === DISPLAY_WIDTH &&
      monitors[0].height === DISPLAY_HEIGHT &&
      monitors[0].disabled !== true &&
      monitors[0].dpmsStatus !== false;
  } catch {
    monitorMatches = false;
  }
  const installedOmarchyVersion = commandMap
    .get("omarchy-version")
    ?.stdout.trim();
  const escapedReleaseVersion = value.provenance.version.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const omarchyVersionMatches =
    installedOmarchyVersion === value.provenance.version ||
    new RegExp(`^${escapedReleaseVersion}-[1-9][0-9]*(?:\\.[0-9]+)*$`).test(
      installedOmarchyVersion ?? "",
    );
  const commandsMatch =
    requiredCommands.every((key) => {
      const command = commandMap.get(key);
      return command?.exitCode === 0 && typeof command.stdout === "string";
    }) &&
    commandMap.get("uname -m")?.stdout.trim() === "x86_64" &&
    /hyprland/i.test(commandMap.get("hyprctl version")?.stdout ?? "") &&
    monitorMatches &&
    omarchyVersionMatches;

  const configs = Array.isArray(value.configs) ? value.configs : [];
  const configsMatch =
    configs.length > 0 &&
    configs.every(
      (config) =>
        isRecord(config) &&
        typeof config.path === "string" &&
        config.path.startsWith("/") &&
        typeof config.sha256 === "string" &&
        /^[0-9a-f]{64}$/i.test(config.sha256) &&
        config.origin === "omarchy-upstream",
    );

  return (
    generatedAtMatches &&
    systemMatches &&
    provenanceMatches &&
    compositorMatches &&
    shellMatches &&
    commandsMatch &&
    configsMatch
  );
}

export function isGuestDisplayFrame(value) {
  return (
    isRecord(value) &&
    value.source === "qemu-guest" &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence > 0 &&
    value.guestWidth === DISPLAY_WIDTH &&
    value.guestHeight === DISPLAY_HEIGHT &&
    value.sampledPixels === DESKTOP_PROOF_SAMPLE_PIXELS &&
    Number.isSafeInteger(value.nonBlackPixels) &&
    value.nonBlackPixels > 0 &&
    value.nonBlackPixels <= value.sampledPixels
  );
}

export function createDesktopEvidence(expectedReleaseId = ACTIVE_RELEASE_ID) {
  return {
    expectedReleaseId,
    eventOrdinal: 0,
    release: null,
    releaseOrdinal: null,
    guestReportProvenance: null,
    hibernationResume: null,
    hibernationResumeOrdinal: null,
    report: null,
    reportProvenance: null,
    reportOrdinal: null,
    desktopProof: null,
    desktopProofOrdinal: null,
    frame: null,
    frameOrdinal: null,
    terminal: null,
    invalid: false,
    ready: false,
  };
}

/**
 * Desktop readiness requires the exact release and guest report, then the
 * Worker's guest-acknowledged visual transition proof, then a fresh 1600x900
 * guest frame whose sequence is later than the proof's response frame.
 */
export function advanceDesktopEvidence(evidence, event) {
  const current = evidence ?? createDesktopEvidence();
  const eventOrdinal = current.eventOrdinal + 1;

  if (event?.type === "terminal") {
    return {
      ...current,
      eventOrdinal,
      terminal: Object.freeze({
        kind: String(event.kind ?? "runtime"),
        reason: String(event.reason ?? "The VM session ended."),
      }),
      invalid: true,
      ready: false,
    };
  }

  if (current.invalid) return { ...current, eventOrdinal, ready: false };

  if (event?.type === "release") {
    const guestReportProvenance = normalizeGuestReportProvenance(
      event.guestReportProvenance,
    );
    if (
      !hasOnlyKeys(
        event,
        new Set(["type", "release", "guestReportProvenance"]),
      ) ||
      current.release !== null ||
      !isActiveReleaseIdentity(event.release, current.expectedReleaseId) ||
      guestReportProvenance === null
    ) {
      return { ...current, eventOrdinal, invalid: true, ready: false };
    }
    return {
      ...current,
      eventOrdinal,
      release: event.release,
      releaseOrdinal: eventOrdinal,
      guestReportProvenance,
      hibernationResume: null,
      hibernationResumeOrdinal: null,
      report: null,
      reportProvenance: null,
      reportOrdinal: null,
      desktopProof: null,
      desktopProofOrdinal: null,
      frame: null,
      frameOrdinal: null,
      terminal: null,
      invalid: false,
      ready: false,
    };
  }

  if (event?.type === "hibernationresume") {
    const hibernationResume = normalizeHibernationResumeEvidence(
      event.evidence,
    );
    const eventBinding = hibernationResume
      ? {
          origin: "live-hibernation-serial",
          resume: {
            descriptorSha256: hibernationResume.descriptorSha256,
            markerSha256: hibernationResume.markerSha256,
            sourceBootId: hibernationResume.sourceBootId,
            swapUuid: hibernationResume.swapUuid,
          },
        }
      : null;
    if (
      !hasOnlyKeys(event, new Set(["type", "evidence"])) ||
      current.release === null ||
      current.report !== null ||
      current.hibernationResume !== null ||
      current.guestReportProvenance?.origin !==
        "live-hibernation-serial" ||
      !hibernationResume ||
      !guestReportProvenanceMatches(
        eventBinding,
        current.guestReportProvenance,
      )
    ) {
      return { ...current, eventOrdinal, invalid: true, ready: false };
    }
    return {
      ...current,
      eventOrdinal,
      hibernationResume: event.evidence,
      hibernationResumeOrdinal: eventOrdinal,
      ready: false,
    };
  }

  if (event?.type === "guestreport") {
    if (
      current.release === null ||
      current.guestReportProvenance === null ||
      (current.guestReportProvenance.origin ===
        "live-hibernation-serial" &&
        current.hibernationResume === null) ||
      current.report !== null ||
      !guestReportEvidenceMatchesRelease(
        event,
        current.release,
        current.expectedReleaseId,
        current.guestReportProvenance,
      )
    ) {
      return { ...current, eventOrdinal, invalid: true, ready: false };
    }
    return {
      ...current,
      eventOrdinal,
      report: event.report,
      reportProvenance: current.guestReportProvenance,
      reportOrdinal: eventOrdinal,
      desktopProof: null,
      desktopProofOrdinal: null,
      invalid: false,
      ready: false,
    };
  }

  if (event?.type === "desktopproof") {
    if (
      current.report === null ||
      current.reportOrdinal >= eventOrdinal ||
      current.desktopProof !== null ||
      !isDesktopProof(event.proof, current.expectedReleaseId)
    ) {
      return {
        ...current,
        eventOrdinal,
        desktopProof: null,
        desktopProofOrdinal: null,
        invalid: true,
        ready: false,
      };
    }
    return {
      ...current,
      eventOrdinal,
      desktopProof: event.proof,
      desktopProofOrdinal: eventOrdinal,
      ready: false,
    };
  }

  if (event?.type === "guestframe") {
    if (!isGuestDisplayFrame(event.frame)) {
      return { ...current, eventOrdinal };
    }
    if (
      current.frame &&
      event.frame.sequence <= current.frame.sequence
    ) {
      return { ...current, eventOrdinal };
    }

    return {
      ...current,
      eventOrdinal,
      frame: event.frame,
      frameOrdinal: eventOrdinal,
      ready:
        !current.invalid &&
        (current.ready ||
          (current.report !== null &&
            current.reportProvenance !== null &&
            guestReportProvenanceMatches(
              current.reportProvenance,
              current.guestReportProvenance,
            ) &&
            current.desktopProof !== null &&
            current.reportOrdinal < current.desktopProofOrdinal &&
            current.desktopProofOrdinal < eventOrdinal &&
            event.frame.sequence > current.desktopProof.responseSequence)),
    };
  }

  return { ...current, eventOrdinal };
}

export function formatGuestIdentity(report) {
  if (!isGuestReadyReport(report)) return "Guest evidence pending";
  const version =
    typeof report.provenance.version === "string"
      ? report.provenance.version
      : "pinned build";
  return `Omarchy ${version} · Arch Linux x86_64`;
}

export function appendDiagnosticLine(lines, value, limit = 240) {
  const next = [...lines, String(value)];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export function measureCanvasDisplay(rect, devicePixelRatio = 1) {
  const cssWidth = Number(rect?.width) || 0;
  const cssHeight = Number(rect?.height) || 0;
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;

  return {
    backingWidth: DISPLAY_WIDTH,
    backingHeight: DISPLAY_HEIGHT,
    cssWidth,
    cssHeight,
    deviceWidth: cssWidth * dpr,
    deviceHeight: cssHeight * dpr,
    devicePixelRatio: dpr,
    pixelPerfect:
      Math.abs(cssWidth * dpr - DISPLAY_WIDTH) < 1 &&
      Math.abs(cssHeight * dpr - DISPLAY_HEIGHT) < 1,
    aspectMatches:
      cssWidth > 0 &&
      cssHeight > 0 &&
      Math.abs(cssWidth / cssHeight - DISPLAY_WIDTH / DISPLAY_HEIGHT) < 0.002,
  };
}

/** Map CSS-pixel pointer coordinates to the fixed guest framebuffer. */
export function mapCanvasPointToGuest(clientX, clientY, rect) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const x = ((clientX - rect.left) / rect.width) * DISPLAY_WIDTH;
  const y = ((clientY - rect.top) / rect.height) * DISPLAY_HEIGHT;
  return {
    x: Math.min(DISPLAY_WIDTH - 1, Math.max(0, x)),
    y: Math.min(DISPLAY_HEIGHT - 1, Math.max(0, y)),
  };
}
