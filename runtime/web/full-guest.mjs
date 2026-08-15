import { inspectBrowserCapabilities, formatCapabilityError } from "./runtime.mjs";
import { KEY_CODE_TO_SDL_SCANCODE } from "./worker-input.mjs";
import {
  fullGuestReportMatchesRelease,
  normalizeFullGuestDesktopProof,
  normalizeFullGuestFrame,
  normalizeFullGuestRelease,
} from "./full-guest-evidence.mjs";

const canvas = document.querySelector("#desktop");
const status = document.querySelector("#status");
const phase = document.querySelector("#phase");
const frames = document.querySelector("#frames");
const reportState = document.querySelector("#report-state");
const serial = document.querySelector("#serial");
const reset = document.querySelector("#reset");

const releaseBase = new URL(new URLSearchParams(location.search).get("release") ?? "/release/", location.href);
if (releaseBase.origin !== location.origin) throw new Error("The full-guest release must be same-origin.");
if (!releaseBase.pathname.endsWith("/")) releaseBase.pathname += "/";
const MAX_PRE_PROOF_FRAME_SEQUENCES = 8192;

const state = {
  phase: "idle",
  frame: null,
  lastFrameSequence: 0,
  releaseIdentity: null,
  guestReport: null,
  guestReportOrigin: null,
  desktopProof: null,
  postProofFrame: null,
  ready: false,
  errors: [],
  stopped: false,
};
let worker;
const pressedKeys = new Set();
const preProofGuestFrameSequences = new Set();

function appendSerial(line) {
  serial.textContent = `${serial.textContent}${line}\n`.slice(-64000);
  serial.scrollTop = serial.scrollHeight;
}

function fail(error) {
  if (state.stopped) return;
  const message = error instanceof Error ? error.message : String(error);
  state.errors.push(message);
  state.phase = "failed";
  state.ready = false;
  state.stopped = true;
  worker?.terminate();
  worker = undefined;
  phase.textContent = "failed";
  status.textContent = message;
  canvas.dataset.runtimePhase = "failed";
  canvas.dataset.guestReady = "false";
  appendSerial(`[host:error] ${message}`);
}

function sendInput(event) {
  if (!worker || state.stopped || !state.ready) return false;
  worker.postMessage({ type: "input", event });
  return true;
}

function updateReady() {
  if (state.stopped || state.phase !== "running") return;
  const frame = state.frame;
  if (!state.releaseIdentity || !state.guestReport || !state.desktopProof || !frame ||
      frame.sequence <= state.desktopProof.responseSequence || frame.nonBlackPixels <= 0) return;
  state.postProofFrame = frame;
  state.ready = true;
  canvas.dataset.guestReady = "true";
  status.textContent = `Guest-acknowledged Omarchy desktop frame ${frame.sequence} at 1600×900.`;
}

function onWorkerMessage({ data }) {
  if (state.stopped) return;
  if (!data || typeof data !== "object") return;
  if (data.type === "phase") {
    state.phase = data.phase;
    phase.textContent = data.phase;
    canvas.dataset.runtimePhase = data.phase;
    if (data.phase === "running" && !state.ready) {
      status.textContent = "QEMU is running; waiting for release-bound guest and desktop proof…";
    }
    if (data.phase === "failed" || data.phase === "exited") {
      if (data.error?.stack) appendSerial(`[worker:stack] ${data.error.stack}`);
      fail(data.error?.message ?? `The runtime Worker ${data.phase}.`);
    }
  } else if (data.type === "display") {
    canvas.dataset.configuredWidth = String(data.width);
    canvas.dataset.configuredHeight = String(data.height);
  } else if (data.type === "serial") {
    appendSerial(`[${data.stream}] ${data.line}`);
  } else if (data.type === "release") {
    if (state.releaseIdentity) {
      fail("The runtime Worker emitted more than one release identity.");
      return;
    }
    const release = normalizeFullGuestRelease(data);
    if (!release) {
      fail("The runtime Worker emitted an invalid release identity.");
      return;
    }
    state.releaseIdentity = release;
    appendSerial(`[release] Verified artifact manifest ${release.artifactManifestSha256}.`);
  } else if (data.type === "guestreport") {
    const origin = data.origin;
    const checkpointDigests = data.sourceEvidence;
    const validCheckpointEvidence = origin === "checkpoint-source-evidence" &&
      checkpointDigests && typeof checkpointDigests === "object" &&
      [
        "normalizedGuestReportSha256", "reportValidationSha256",
        "checkpointFrameSha256", "checkpointFrameHealthSha256",
      ].every((key) => /^[a-f0-9]{64}$/.test(checkpointDigests[key] ?? ""));
    if (!state.releaseIdentity || state.guestReport ||
        !fullGuestReportMatchesRelease(data.report, state.releaseIdentity) ||
        (origin !== "live-guest-serial" && !validCheckpointEvidence)) {
      fail("The guest report was duplicated, out of order, or release-mismatched.");
      return;
    }
    state.guestReport = data.report;
    state.guestReportOrigin = origin;
    reportState.textContent = origin === "checkpoint-source-evidence"
      ? "authenticated checkpoint source"
      : "authenticated live serial";
    canvas.dataset.guestReport = "true";
    canvas.dataset.guestReportOrigin = origin;
    appendSerial(`[guestreport] Authenticated origin ${origin}.`);
    status.textContent = "Guest report authenticated; waiting for a guest-acknowledged desktop transition…";
  } else if (data.type === "guestreporterror") {
    fail(`Guest report rejected: ${data.error?.message ?? "invalid evidence"}`);
  } else if (data.type === "guestframe") {
    const frame = normalizeFullGuestFrame(data);
    if (!frame || !state.releaseIdentity || frame.sequence <= state.lastFrameSequence) {
      fail("The runtime emitted malformed, unbound, or out-of-order guest pixel evidence.");
      return;
    }
    state.lastFrameSequence = frame.sequence;
    state.frame = frame;
    if (state.guestReport && !state.desktopProof) {
      if (preProofGuestFrameSequences.size >= MAX_PRE_PROOF_FRAME_SEQUENCES) {
        fail("Desktop proof exceeded its bounded pre-proof frame window.");
        return;
      }
      preProofGuestFrameSequences.add(frame.sequence);
    }
    frames.textContent = String(frame.sequence);
    canvas.dataset.guestFrameSequence = String(frame.sequence);
    canvas.dataset.guestFrameSource = frame.source;
    canvas.dataset.guestWidth = String(frame.guestWidth);
    canvas.dataset.guestHeight = String(frame.guestHeight);
    canvas.dataset.sampledPixels = String(frame.sampledPixels);
    canvas.dataset.nonBlackPixels = String(frame.nonBlackPixels);
    updateReady();
  } else if (data.type === "desktopproof") {
    const proof = normalizeFullGuestDesktopProof(
      data,
      state.releaseIdentity?.artifactManifestSha256,
    );
    if (!state.releaseIdentity || !state.guestReport || state.phase !== "running" ||
        state.desktopProof || !proof ||
        !preProofGuestFrameSequences.has(proof.baselineSequence) ||
        !preProofGuestFrameSequences.has(proof.responseSequence)) {
      fail("The runtime emitted duplicated, out-of-order, or invalid desktop proof.");
      return;
    }
    state.desktopProof = proof;
    preProofGuestFrameSequences.clear();
    canvas.dataset.desktopProof = "true";
    status.textContent = "Desktop transition and guest input acknowledged; waiting for a later live frame…";
  } else if (data.type === "runtimediagnostic") {
    appendSerial(`[runtime] ${data.line}`);
  } else if (data.type === "inputaccepted") {
    appendSerial("[input] QEMU accepted an input event (diagnostic only).");
  } else if (data.type === "inputerror") {
    appendSerial(`[input:error] ${data.error?.message ?? "input rejected"}`);
  } else if (data.type === "error") {
    if (data.error?.stack) appendSerial(`[worker:stack] ${data.error.stack}`);
    fail(data.error?.message ?? "Unhandled Worker error.");
  }
}

function stop() {
  if (state.stopped) return;
  state.stopped = true;
  worker?.terminate();
  worker = undefined;
  state.phase = "stopped";
  state.ready = false;
  phase.textContent = "stopped";
  canvas.dataset.runtimePhase = "stopped";
  canvas.dataset.guestReady = "false";
  status.textContent = "VM stopped. Reload the page to create a fresh canvas and VM.";
}

function installInput() {
  canvas.addEventListener("keydown", (event) => {
    if (!(event.code in KEY_CODE_TO_SDL_SCANCODE) || event.repeat) return;
    event.preventDefault();
    if (sendInput({ kind: "key", code: event.code, down: true })) pressedKeys.add(event.code);
  });
  canvas.addEventListener("keyup", (event) => {
    if (!(event.code in KEY_CODE_TO_SDL_SCANCODE)) return;
    event.preventDefault();
    pressedKeys.delete(event.code);
    sendInput({ kind: "key", code: event.code, down: false });
  });
  canvas.addEventListener("blur", () => {
    for (const code of pressedKeys) sendInput({ kind: "key", code, down: false });
    pressedKeys.clear();
  });
  const pointer = (event) => {
    const bounds = canvas.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    const y = Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height));
    sendInput({ kind: "pointer", x, y, buttons: event.buttons & 31 });
  };
  canvas.addEventListener("pointerdown", (event) => {
    canvas.focus();
    canvas.setPointerCapture(event.pointerId);
    pointer(event);
  });
  canvas.addEventListener("pointermove", pointer);
  canvas.addEventListener("pointerup", pointer);
  canvas.addEventListener("pointercancel", pointer);
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    sendInput({ kind: "wheel", deltaX: event.deltaX, deltaY: event.deltaY });
  }, { passive: false });
}

async function start() {
  const capabilities = inspectBrowserCapabilities(globalThis);
  if (!capabilities.supported) {
    fail(`Unsupported browser: ${formatCapabilityError(capabilities)}.`);
    return;
  }
  status.textContent = "Starting the authenticated outer runtime Worker…";
  state.phase = "starting-worker";
  phase.textContent = state.phase;
  canvas.dataset.runtimePhase = state.phase;
  const offscreen = canvas.transferControlToOffscreen();
  worker = new Worker(new URL("production-worker.mjs", releaseBase), {
    type: "module",
    name: "omarchy-production-runtime",
  });
  worker.addEventListener("message", onWorkerMessage);
  worker.addEventListener("error", (event) => fail(event.error ?? event.message));
  worker.addEventListener("messageerror", () => fail("The runtime Worker sent an invalid message."));
  worker.postMessage({ type: "start", canvas: offscreen, releaseBaseUrl: releaseBase.href }, [offscreen]);
}

reset.addEventListener("click", () => location.reload());
installInput();
window.__omarchyFullGuest = Object.freeze({ state, stop, releaseBaseUrl: releaseBase.href });
start().catch(fail);
