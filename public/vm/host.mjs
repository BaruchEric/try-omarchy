const PROTOCOL_CHANNEL = "omarchy-vm-host";
const PROTOCOL_VERSION = 1;
const DISPLAY_WIDTH = 1600;
const DISPLAY_HEIGHT = 900;
const RELEASE_BASE_PATH = "/omarchy/versions/f0020448/";
const PRODUCTION_WORKER_ASSET = "production-worker.mjs";
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
let runtimeWorker = null;
let pendingPointer = null;
let pointerFrame = 0;
const pressedKeys = new Set();

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function text(value, fallback) {
  if (typeof value === "string" && value.length > 0) return value;
  if (value instanceof Error && value.message) return value.message;
  if (isRecord(value) && typeof value.message === "string" && value.message) {
    return value.message;
  }
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

function bindWorker(worker) {
  worker.addEventListener("message", (event) => {
    const detail = event.data;
    if (!isRecord(detail) || typeof detail.type !== "string") return;

    switch (detail.type) {
      case "phase": {
        const phase = text(detail.phase, "unknown");
        const reason = detail.error === undefined
          ? undefined
          : text(detail.error, "The emulator reported a failure.");
        post("phase", { phase, ...(reason === undefined ? {} : { reason }) });
        break;
      }
      case "serial": {
        if (typeof detail.line !== "string" || !detail.line) return;
        post("serial", {
          stream: detail.stream === "stderr" ? "stderr" : "stdout",
          line: detail.line,
        });
        break;
      }
      case "guestreport":
        if (isRecord(detail.report)) post("guestreport", { report: detail.report });
        else postError("The Worker emitted a non-object guest report.", "The guest authenticity report was malformed.");
        break;
      case "guestreporterror":
        postError(detail.error, "The guest authenticity report could not be parsed.");
        break;
      case "guestframe":
        if (
          detail.source === "qemu-guest" &&
          Number.isInteger(detail.sequence) &&
          detail.sequence > 0
        ) {
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
        }
        break;
      case "display":
        if (detail.width !== DISPLAY_WIDTH || detail.height !== DISPLAY_HEIGHT) {
          postError(
            `Runtime requested ${String(detail.width)}x${String(detail.height)}.`,
            "The guest display did not match the verified 1600×900 profile.",
          );
        }
        break;
      case "inputerror":
        post("serial", {
          stream: "stderr",
          line: `[input] ${text(detail.error, "The guest rejected an input event.")}`,
        });
        break;
      case "error":
        postError(detail.error);
        break;
    }
  });

  worker.addEventListener("error", (event) => {
    event.preventDefault();
    postError(event.error ?? event.message, "The isolated emulator Worker failed.");
  });

  worker.addEventListener("messageerror", () => {
    postError("The Worker returned an unreadable message.", "The isolated emulator Worker failed.");
  });
}

async function startRuntime() {
  if (started) return;
  started = true;
  post("phase", { phase: "loading-runtime" });

  try {
    const releaseBaseUrl = new URL(RELEASE_BASE_PATH, window.location.href);
    if (releaseBaseUrl.origin !== window.location.origin) {
      throw new Error("The immutable release must be served from this site.");
    }
    const workerUrl = new URL(PRODUCTION_WORKER_ASSET, releaseBaseUrl);
    const workerResponse = await fetch(workerUrl, {
      method: "HEAD",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    if (!workerResponse.ok) {
      throw new Error(
        `Production Worker request failed with HTTP ${workerResponse.status}: ${workerUrl.pathname}`,
      );
    }
    const workerType = workerResponse.headers.get("content-type") ?? "";
    if (!/^(?:text|application)\/javascript\b/i.test(workerType)) {
      throw new Error(`Production Worker has an unsafe Content-Type: ${workerType || "missing"}`);
    }
    runtimeWorker = new Worker(workerUrl, {
      type: "module",
      name: `omarchy-vm-${runNonce.slice(0, 12)}`,
    });
    bindWorker(runtimeWorker);

    // The canvas is transferred exactly once. Reset destroys this iframe and
    // its Worker, giving the replacement session a fresh canvas and VM heap.
    const offscreen = canvas.transferControlToOffscreen();
    runtimeWorker.postMessage(
      {
        type: "start",
        canvas: offscreen,
        releaseBaseUrl: releaseBaseUrl.href,
      },
      [offscreen],
    );
  } catch (error) {
    runtimeWorker?.terminate();
    runtimeWorker = null;
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
    hasOnlyKeys(value, new Set(["channel", "version", "runNonce", "type"])) &&
    value.channel === PROTOCOL_CHANNEL &&
    value.version === PROTOCOL_VERSION &&
    value.runNonce === runNonce &&
    (value.type === "start" || value.type === "focus")
  );
}

function normalizedPointer(event) {
  const rect = canvas.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) return null;
  const scale = Math.min(rect.width / DISPLAY_WIDTH, rect.height / DISPLAY_HEIGHT);
  const contentWidth = DISPLAY_WIDTH * scale;
  const contentHeight = DISPLAY_HEIGHT * scale;
  const left = rect.left + (rect.width - contentWidth) / 2;
  const top = rect.top + (rect.height - contentHeight) / 2;
  const x = (event.clientX - left) / contentWidth;
  const y = (event.clientY - top) / contentHeight;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y, buttons: event.buttons & 31 };
}

function sendInput(event) {
  if (!runtimeWorker) return;
  runtimeWorker.postMessage({ type: "input", event });
}

function flushPointer() {
  pointerFrame = 0;
  if (!pendingPointer) return;
  sendInput({ kind: "pointer", ...pendingPointer });
  pendingPointer = null;
}

function queuePointer(event, immediate = false) {
  const point = normalizedPointer(event);
  if (!point) return;
  pendingPointer = point;
  if (immediate) {
    if (pointerFrame) cancelAnimationFrame(pointerFrame);
    flushPointer();
  } else if (!pointerFrame) {
    pointerFrame = requestAnimationFrame(flushPointer);
  }
}

function releasePressedKeys() {
  for (const code of pressedKeys) sendInput({ kind: "key", code, down: false });
  pressedKeys.clear();
}

if (!hostBoundaryValid) {
  if (window.parent !== window) {
    postError(
      "The iframe URL did not contain a valid run boundary.",
      "The disposable VM host was opened with an invalid session token.",
    );
  }
} else {
  canvas.addEventListener("keydown", (event) => {
    if (event.repeat || !event.code) {
      event.preventDefault();
      return;
    }
    pressedKeys.add(event.code);
    sendInput({ kind: "key", code: event.code, down: true });
    event.preventDefault();
  });
  canvas.addEventListener("keyup", (event) => {
    if (!event.code) return;
    pressedKeys.delete(event.code);
    sendInput({ kind: "key", code: event.code, down: false });
    event.preventDefault();
  });
  canvas.addEventListener("pointerdown", (event) => {
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture?.(event.pointerId);
    queuePointer(event, true);
    event.preventDefault();
  });
  canvas.addEventListener("pointermove", (event) => queuePointer(event));
  canvas.addEventListener("pointerup", (event) => {
    queuePointer(event, true);
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    event.preventDefault();
  });
  canvas.addEventListener("pointercancel", (event) => {
    const point = normalizedPointer(event);
    if (point) sendInput({ kind: "pointer", ...point, buttons: 0 });
  });
  canvas.addEventListener("wheel", (event) => {
    if (!runtimeWorker || (event.deltaX === 0 && event.deltaY === 0)) return;
    sendInput({ kind: "wheel", deltaX: event.deltaX, deltaY: event.deltaY });
    event.preventDefault();
  }, { passive: false });
  canvas.addEventListener("blur", releasePressedKeys);
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  window.addEventListener("message", (event) => {
    if (!isParentCommand(event)) return;
    if (event.data.type === "start") void startRuntime();
    else canvas.focus({ preventScroll: true });
  });

  window.addEventListener("beforeunload", () => {
    releasePressedKeys();
    runtimeWorker?.terminate();
  });

  if (typeof ResizeObserver === "function") {
    const resizeObserver = new ResizeObserver(reportCanvasMetrics);
    resizeObserver.observe(canvas);
  }
  window.addEventListener("resize", reportCanvasMetrics);
  reportCanvasMetrics();
  post("ready");
}
