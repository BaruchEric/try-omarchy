const PROTOCOL_CHANNEL = "omarchy-vm-host";
const PROTOCOL_VERSION = 1;
const DISPLAY_WIDTH = 1600;
const DISPLAY_HEIGHT = 900;
const RUNTIME_MODULE_URL = "/omarchy/runtime.mjs";
const RUNTIME_BASE_URL = "/omarchy/";
const NONCE_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

const query = new URLSearchParams(window.location.search);
const runNonce = query.get("run") ?? "";
const requestedProtocol = Number(query.get("protocol"));
const canvas = document.getElementById("canvas");
const hostBoundaryValid =
  canvas instanceof HTMLCanvasElement &&
  NONCE_PATTERN.test(runNonce) &&
  requestedProtocol === PROTOCOL_VERSION &&
  window.parent !== window;
let started = false;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function text(value, fallback) {
  if (typeof value === "string" && value.length > 0) return value;
  if (value instanceof Error && value.message) return value.message;
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function post(type, detail = {}) {
  window.parent.postMessage(
    {
      channel: PROTOCOL_CHANNEL,
      version: PROTOCOL_VERSION,
      runNonce,
      type,
      ...detail,
    },
    window.location.origin,
  );
}

function postError(error, message = "The isolated VM host could not start.") {
  post("error", {
    message,
    technical: text(error, message),
  });
}

function eventDetail(event) {
  return event?.detail && typeof event.detail === "object" ? event.detail : {};
}

function reportCanvasMetrics() {
  const rect = canvas.getBoundingClientRect();
  const devicePixelRatio =
    Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
      ? window.devicePixelRatio
      : 1;
  const cssWidth = Number(rect.width) || 0;
  const cssHeight = Number(rect.height) || 0;
  const deviceWidth = cssWidth * devicePixelRatio;
  const deviceHeight = cssHeight * devicePixelRatio;

  post("metrics", {
    metrics: {
      backingWidth: DISPLAY_WIDTH,
      backingHeight: DISPLAY_HEIGHT,
      cssWidth,
      cssHeight,
      deviceWidth,
      deviceHeight,
      devicePixelRatio,
      pixelPerfect:
        Math.abs(deviceWidth - DISPLAY_WIDTH) < 1 &&
        Math.abs(deviceHeight - DISPLAY_HEIGHT) < 1,
      aspectMatches:
        cssWidth > 0 &&
        cssHeight > 0 &&
        Math.abs(cssWidth / cssHeight - DISPLAY_WIDTH / DISPLAY_HEIGHT) < 0.002,
    },
  });
}

function bindRuntime(runtime) {
  runtime.addEventListener("phasechange", (event) => {
    const detail = eventDetail(event);
    post("phase", {
      phase: text(detail.phase, "unknown"),
      ...(detail.reason === undefined
        ? {}
        : { reason: text(detail.reason, "The emulator reported a failure.") }),
    });
  });

  runtime.addEventListener("serial", (event) => {
    const detail = eventDetail(event);
    const line = typeof detail.line === "string" ? detail.line : "";
    if (!line) return;
    post("serial", {
      stream: detail.stream === "stderr" ? "stderr" : "stdout",
      line,
    });
  });

  runtime.addEventListener("guestreport", (event) => {
    if (!isRecord(event?.detail)) {
      postError(
        "The runtime emitted a non-object guest report.",
        "The guest authenticity report was malformed.",
      );
      return;
    }
    post("guestreport", { report: event.detail });
  });

  runtime.addEventListener("guestreporterror", (event) => {
    const detail = eventDetail(event);
    postError(
      detail.error,
      "The guest authenticity report could not be parsed.",
    );
  });

  runtime.addEventListener("guestframe", (event) => {
    const detail = eventDetail(event);
    if (
      detail.source !== "qemu-guest" ||
      !Number.isInteger(detail.sequence) ||
      detail.sequence <= 0
    ) {
      return;
    }
    post("guestframe", {
      frame: {
        sequence: detail.sequence,
        source: "qemu-guest",
        ...(Number.isInteger(detail.guestWidth) && detail.guestWidth > 0
          ? { guestWidth: detail.guestWidth }
          : {}),
        ...(Number.isInteger(detail.guestHeight) && detail.guestHeight > 0
          ? { guestHeight: detail.guestHeight }
          : {}),
      },
    });
  });

  runtime.addEventListener("reloadrequired", (event) => {
    const detail = eventDetail(event);
    post("reload", {
      reason: text(
        detail.reason,
        "The emulator asked for a fresh isolated document.",
      ),
    });
  });
}

async function startRuntime() {
  if (started) return;
  started = true;
  post("phase", { phase: "loading-runtime" });

  try {
    const imported = await import(RUNTIME_MODULE_URL);
    if (typeof imported.OmarchyWasmRuntime !== "function") {
      throw new Error(
        "The module at /omarchy/runtime.mjs does not export OmarchyWasmRuntime.",
      );
    }

    const runtime = new imported.OmarchyWasmRuntime({
      baseUrl: new URL(RUNTIME_BASE_URL, window.location.href).href,
      canvas,
    });
    bindRuntime(runtime);
    await runtime.start();
  } catch (error) {
    postError(error);
  }
}

function isParentCommand(event) {
  const value = event.data;
  return (
    hostBoundaryValid &&
    event.source === window.parent &&
    event.origin === window.location.origin &&
    isRecord(value) &&
    hasOnlyKeys(
      value,
      new Set(["channel", "version", "runNonce", "type"]),
    ) &&
    value.channel === PROTOCOL_CHANNEL &&
    value.version === PROTOCOL_VERSION &&
    value.runNonce === runNonce &&
    (value.type === "start" || value.type === "focus")
  );
}

if (!hostBoundaryValid) {
  if (window.parent !== window) {
    postError(
      "The iframe URL did not contain a valid run boundary.",
      "The disposable VM host was opened with an invalid session token.",
    );
  }
} else {
  canvas.addEventListener("pointerdown", () => {
    canvas.focus({ preventScroll: true });
  });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  window.addEventListener("message", (event) => {
    if (!isParentCommand(event)) return;
    if (event.data.type === "start") {
      void startRuntime();
    } else {
      canvas.focus({ preventScroll: true });
    }
  });

  if (typeof ResizeObserver === "function") {
    const resizeObserver = new ResizeObserver(reportCanvasMetrics);
    resizeObserver.observe(canvas);
  }
  window.addEventListener("resize", reportCanvasMetrics);
  reportCanvasMetrics();
  post("ready");
}
