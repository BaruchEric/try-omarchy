export const DISPLAY_WIDTH = 1600;
export const DISPLAY_HEIGHT = 900;
export const RUNTIME_MODULE_URL = "/omarchy/runtime.mjs";
export const RUNTIME_BASE_URL = "/omarchy/";

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
  "loading-guest": {
    title: "Loading Omarchy",
    detail: "The guest image is moving into this tab's memory.",
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
      detail: "Readiness was reported by the running guest.",
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
    "failed to load /omarchy/",
    "module not found",
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
  const commandsMatch =
    requiredCommands.every((key) => {
      const command = commandMap.get(key);
      return command?.exitCode === 0 && typeof command.stdout === "string";
    }) &&
    commandMap.get("uname -m")?.stdout.trim() === "x86_64" &&
    /hyprland/i.test(commandMap.get("hyprctl version")?.stdout ?? "") &&
    commandMap
      .get("omarchy-version")
      ?.stdout.includes(value.provenance.version);

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
    Number.isInteger(value.sequence) &&
    value.sequence > 0 &&
    value.guestWidth === DISPLAY_WIDTH &&
    value.guestHeight === DISPLAY_HEIGHT
  );
}

export function createDesktopEvidence() {
  return {
    eventOrdinal: 0,
    report: null,
    reportOrdinal: null,
    frame: null,
    frameOrdinal: null,
    ready: false,
  };
}

/**
 * Desktop readiness requires a valid guest report followed by a fresh, real
 * 1600x900 framebuffer presentation. A frame that happened before the report
 * remains useful diagnostics, but cannot prove the reported desktop is visible.
 */
export function advanceDesktopEvidence(evidence, event) {
  const current = evidence ?? createDesktopEvidence();
  const eventOrdinal = current.eventOrdinal + 1;

  if (event?.type === "guestreport") {
    if (!isGuestReadyReport(event.report)) {
      return { ...current, eventOrdinal };
    }
    return {
      ...current,
      eventOrdinal,
      report: event.report,
      reportOrdinal: eventOrdinal,
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
        current.ready ||
        (current.report !== null && current.reportOrdinal < eventOrdinal),
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
