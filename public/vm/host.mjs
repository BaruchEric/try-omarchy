import {
  fetchVerifiedWorkerBootstrap,
  normalizedPointerForCanvas,
  normalizeRuntimeDesktopProof,
  normalizeRuntimeGuestFrame,
  normalizeRuntimeGuestReport,
  normalizeRuntimeHibernationResume,
  normalizeRuntimeInputAccepted,
  validateRuntimeRelease,
} from "/vm/host-utils.mjs";

const PROTOCOL_CHANNEL = "omarchy-vm-host";
const PROTOCOL_VERSION = 1;
const DISPLAY_WIDTH = 1600;
const DISPLAY_HEIGHT = 900;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
const RELEASE_ID_PATTERN = /^[a-f0-9]{64}$/;
const UNPUBLISHED_RELEASE_ID = "0".repeat(64);

const query = new URLSearchParams(window.location.search);
const runNonce = query.get("run") ?? "";
const releaseId = (query.get("release") ?? "").toLowerCase();
const requestedProtocol = Number(query.get("protocol"));
const canvas = document.getElementById("canvas");
const hostBoundaryValid =
  canvas instanceof HTMLCanvasElement &&
  NONCE_PATTERN.test(runNonce) &&
  RELEASE_ID_PATTERN.test(releaseId) &&
  releaseId !== UNPUBLISHED_RELEASE_ID &&
  requestedProtocol === PROTOCOL_VERSION &&
  window.parent !== window;
let started = false;
let runtimeWorker = null;
let runtimeWorkerBlobUrl = null;
let verifiedBootstrap = null;
let verifiedRuntimeRelease = null;
let guestReportSeen = false;
let hibernationResumeSeen = false;
let runtimeRunning = false;
let runtimeTerminal = false;
let desktopProofSeen = false;
let desktopProofResponseSequence = null;
let desktopInteractionReady = false;
let lastGuestFrameSequence = 0;
const preProofGuestFrameSequences = new Set();
let pendingPointer = null;
let pointerFrame = 0;
let pointerButtonsActive = false;
let lastPointer = { x: 0.5, y: 0.5 };
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

function revokeWorkerBlobUrl() {
  if (!runtimeWorkerBlobUrl) return;
  URL.revokeObjectURL(runtimeWorkerBlobUrl);
  runtimeWorkerBlobUrl = null;
}

function stopRuntime() {
  runtimeWorker?.terminate();
  runtimeWorker = null;
  runtimeRunning = false;
  desktopInteractionReady = false;
  revokeWorkerBlobUrl();
}

function latchRuntimeTerminal() {
  if (runtimeTerminal) return;
  runtimeTerminal = true;
  runtimeRunning = false;
  desktopInteractionReady = false;
  preProofGuestFrameSequences.clear();
  releaseAllInput();
  stopRuntime();
}

function rejectWorkerMessage(message) {
  latchRuntimeTerminal();
  postError(message, "The emulator Worker violated its verified protocol.");
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
    if (runtimeTerminal) return;
    revokeWorkerBlobUrl();
    const detail = event.data;
    if (!isRecord(detail) || typeof detail.type !== "string") return;

    switch (detail.type) {
      case "phase": {
        const phase = text(detail.phase, "unknown");
        const reason = detail.error === undefined
          ? undefined
          : text(detail.error, "The emulator reported a failure.");
        post("phase", { phase, ...(reason === undefined ? {} : { reason }) });
        if (phase === "running") {
          runtimeRunning = true;
        } else if (phase === "failed" || phase === "exited") {
          latchRuntimeTerminal();
        }
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
      case "release": {
        if (verifiedRuntimeRelease) {
          rejectWorkerMessage("The Worker emitted more than one release identity.");
          break;
        }
        const release = validateRuntimeRelease(detail, verifiedBootstrap);
        if (!release) {
          rejectWorkerMessage(
            "The Worker release identity did not match its verified bootstrap manifest.",
          );
          break;
        }
        verifiedRuntimeRelease = release;
        post("release", {
          ...release,
          guestReportProvenance: verifiedBootstrap.guestReportProvenance,
        });
        break;
      }
      case "guestreport": {
        if (!verifiedRuntimeRelease) {
          rejectWorkerMessage(
            "The Worker emitted guest evidence before its release identity.",
          );
        } else if (
          verifiedBootstrap.hibernationResume &&
          !hibernationResumeSeen
        ) {
          rejectWorkerMessage(
            "The Worker emitted a live hibernation guest report before its authenticated resume evidence.",
          );
        } else if (guestReportSeen) {
          rejectWorkerMessage("The Worker emitted more than one guest report.");
        } else {
          const guestReport = normalizeRuntimeGuestReport(
            detail,
            verifiedBootstrap,
          );
          if (!guestReport) {
            rejectWorkerMessage(
              "The Worker emitted guest evidence with missing, mismatched, or downgraded provenance.",
            );
            break;
          }
          guestReportSeen = true;
          post("guestreport", guestReport);
        }
        break;
      }
      case "hibernationresume": {
        if (!verifiedRuntimeRelease) {
          rejectWorkerMessage(
            "The Worker emitted hibernation resume evidence before its release identity.",
          );
        } else if (hibernationResumeSeen) {
          rejectWorkerMessage(
            "The Worker emitted hibernation resume evidence more than once.",
          );
        } else if (guestReportSeen) {
          rejectWorkerMessage(
            "The Worker emitted hibernation resume evidence after its live guest report.",
          );
        } else {
          const evidence = normalizeRuntimeHibernationResume(
            detail,
            verifiedBootstrap,
          );
          if (!evidence) {
            rejectWorkerMessage(
              "The Worker emitted missing, mismatched, or downgraded hibernation resume evidence.",
            );
            break;
          }
          hibernationResumeSeen = true;
          post("hibernationresume", { evidence });
        }
        break;
      }
      case "guestreporterror":
        latchRuntimeTerminal();
        postError(detail.error, "The guest authenticity report could not be parsed.");
        break;
      case "guestframe": {
        const frame = normalizeRuntimeGuestFrame(detail);
        if (!frame) {
          rejectWorkerMessage("The Worker emitted malformed guest-frame evidence.");
        } else if (!verifiedRuntimeRelease) {
          rejectWorkerMessage(
            "The Worker emitted guest pixels before its release identity.",
          );
        } else if (frame.sequence <= lastGuestFrameSequence) {
          rejectWorkerMessage(
            "The Worker duplicated or moved its guest-frame sequence backwards.",
          );
        } else {
          lastGuestFrameSequence = frame.sequence;
          if (guestReportSeen && !desktopProofSeen) {
            preProofGuestFrameSequences.add(frame.sequence);
          }
          if (
            runtimeRunning &&
            !runtimeTerminal &&
            desktopProofSeen &&
            frame.sequence > desktopProofResponseSequence &&
            frame.nonBlackPixels > 0
          ) {
            desktopInteractionReady = true;
          }
          post("guestframe", { frame });
        }
        break;
      }
      case "desktopproof": {
        if (
          runtimeTerminal ||
          !verifiedRuntimeRelease ||
          !guestReportSeen ||
          !runtimeRunning
        ) {
          rejectWorkerMessage(
            "The Worker emitted desktop proof before the current release, guest report, and running phase.",
          );
          break;
        }
        if (desktopProofSeen) {
          rejectWorkerMessage("The Worker emitted more than one desktop proof.");
          break;
        }
        const proof = normalizeRuntimeDesktopProof(
          detail,
          verifiedRuntimeRelease.artifactManifestSha256,
        );
        if (!proof) {
          rejectWorkerMessage(
            "The Worker emitted malformed or release-mismatched desktop proof.",
          );
          break;
        }
        if (
          !preProofGuestFrameSequences.has(proof.baselineSequence) ||
          !preProofGuestFrameSequences.has(proof.responseSequence)
        ) {
          rejectWorkerMessage(
            "The Worker desktop proof referenced frames that were not forwarded by the current run.",
          );
          break;
        }
        desktopProofSeen = true;
        desktopProofResponseSequence = proof.responseSequence;
        preProofGuestFrameSequences.clear();
        post("desktopproof", { proof });
        break;
      }
      case "display":
        if (detail.width !== DISPLAY_WIDTH || detail.height !== DISPLAY_HEIGHT) {
          rejectWorkerMessage(
            `Runtime requested ${String(detail.width)}x${String(detail.height)}.`,
          );
        }
        break;
      case "inputerror":
        post("serial", {
          stream: "stderr",
          line: `[input] ${text(detail.error, "The QEMU input bridge rejected an input event.")}`,
        });
        break;
      case "inputaccepted": {
        const acceptedInput = normalizeRuntimeInputAccepted(detail);
        if (!acceptedInput) {
          rejectWorkerMessage("The Worker emitted malformed accepted-input evidence.");
          break;
        }
        post("inputaccepted", {
          event: acceptedInput,
          readinessProbe: false,
        });
        break;
      }
      case "error":
        latchRuntimeTerminal();
        postError(detail.error);
        break;
    }
  });

  worker.addEventListener("error", (event) => {
    if (runtimeTerminal) return;
    event.preventDefault();
    latchRuntimeTerminal();
    postError(event.error ?? event.message, "The isolated emulator Worker failed.");
  });

  worker.addEventListener("messageerror", () => {
    if (runtimeTerminal) return;
    latchRuntimeTerminal();
    postError("The Worker returned an unreadable message.", "The isolated emulator Worker failed.");
  });
}

async function startRuntime() {
  if (started) return;
  started = true;
  post("phase", { phase: "loading-runtime" });

  try {
    const releaseBaseUrl = new URL(
      `/omarchy/versions/${releaseId}/`,
      window.location.href,
    );
    if (releaseBaseUrl.origin !== window.location.origin) {
      throw new Error("The immutable release must be served from this site.");
    }
    post("phase", { phase: "loading-artifact-manifest" });
    verifiedBootstrap = await fetchVerifiedWorkerBootstrap({
      releaseBaseUrl,
      expectedReleaseId: releaseId,
    });
    runtimeWorkerBlobUrl = URL.createObjectURL(
      new Blob([verifiedBootstrap.workerBytes], {
        type: "text/javascript",
      }),
    );
    runtimeWorker = new Worker(runtimeWorkerBlobUrl, {
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
    latchRuntimeTerminal();
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
    ["start", "focus", "menu", "terminal"].includes(value.type)
  );
}

function normalizedPointer(event, clamp = false) {
  const rect = canvas.getBoundingClientRect();
  const point = normalizedPointerForCanvas(
    event.clientX,
    event.clientY,
    rect,
    { clamp },
  );
  if (!point) return null;
  lastPointer = point;
  return { ...point, buttons: event.buttons & 31 };
}

function sendInput(event) {
  if (
    !runtimeWorker ||
    runtimeTerminal ||
    !runtimeRunning ||
    !desktopInteractionReady
  ) {
    return false;
  }
  runtimeWorker.postMessage({ type: "input", event });
  return true;
}

function flushPointer() {
  pointerFrame = 0;
  if (!pendingPointer) return;
  sendInput({ kind: "pointer", ...pendingPointer });
  pendingPointer = null;
}

function queuePointer(event, immediate = false) {
  if (!desktopInteractionReady) return false;
  const point = normalizedPointer(event, event.buttons !== 0);
  if (!point) return false;
  pendingPointer = point;
  pointerButtonsActive = point.buttons !== 0;
  if (immediate) {
    if (pointerFrame) cancelAnimationFrame(pointerFrame);
    flushPointer();
  } else if (!pointerFrame) {
    pointerFrame = requestAnimationFrame(flushPointer);
  }
  return true;
}

function releasePressedKeys() {
  for (const code of pressedKeys) sendInput({ kind: "key", code, down: false });
  pressedKeys.clear();
}

function releasePointerButtons(event) {
  const point = event
    ? normalizedPointer(event, true)
    : { ...lastPointer, buttons: 0 };
  if (pointerFrame) cancelAnimationFrame(pointerFrame);
  pointerFrame = 0;
  pendingPointer = null;
  sendInput({
    kind: "pointer",
    x: point?.x ?? lastPointer.x,
    y: point?.y ?? lastPointer.y,
    buttons: 0,
  });
  pointerButtonsActive = false;
}

function releaseAllInput() {
  releasePressedKeys();
  if (pointerButtonsActive) releasePointerButtons();
}

function sendShortcut(type) {
  const trigger = type === "menu" ? "Space" : "Enter";
  canvas.focus({ preventScroll: true });
  sendInput({ kind: "key", code: "MetaLeft", down: true });
  sendInput({ kind: "key", code: trigger, down: true });
  sendInput({ kind: "key", code: trigger, down: false });
  sendInput({ kind: "key", code: "MetaLeft", down: false });
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
    if (sendInput({ kind: "key", code: event.code, down: true })) {
      pressedKeys.add(event.code);
    }
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
    if (queuePointer(event, true)) canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  canvas.addEventListener("pointermove", (event) => queuePointer(event));
  canvas.addEventListener("pointerup", (event) => {
    releasePointerButtons(event);
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    event.preventDefault();
  });
  canvas.addEventListener("pointercancel", releasePointerButtons);
  canvas.addEventListener("lostpointercapture", (event) => {
    if (pointerButtonsActive) releasePointerButtons(event);
  });
  canvas.addEventListener("wheel", (event) => {
    if (!runtimeWorker || (event.deltaX === 0 && event.deltaY === 0)) return;
    sendInput({ kind: "wheel", deltaX: event.deltaX, deltaY: event.deltaY });
    event.preventDefault();
  }, { passive: false });
  canvas.addEventListener("blur", releaseAllInput);
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  window.addEventListener("message", (event) => {
    if (!isParentCommand(event)) return;
    if (event.data.type === "start") void startRuntime();
    else if (event.data.type === "focus") canvas.focus({ preventScroll: true });
    else sendShortcut(event.data.type);
  });

  window.addEventListener("beforeunload", () => {
    releaseAllInput();
    stopRuntime();
  });
  window.addEventListener("blur", releaseAllInput);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") releaseAllInput();
  });

  if (typeof ResizeObserver === "function") {
    const resizeObserver = new ResizeObserver(reportCanvasMetrics);
    resizeObserver.observe(canvas);
  }
  window.addEventListener("resize", reportCanvasMetrics);
  reportCanvasMetrics();
  post("ready");
}
