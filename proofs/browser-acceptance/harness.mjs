import {
  acceptVmHostMessage,
  advanceAcceptance,
  checkAcceptanceTimeout,
  createAcceptanceState,
  createVmHostCommand,
  DEFAULT_TIMEOUTS,
  failAcceptance,
  markTerminalCommandSent,
  publicAcceptanceSnapshot,
} from "./contract.mjs";

const RELEASE_ID = /^[a-f0-9]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{20,128}$/;
const query = new URLSearchParams(location.search);
const releaseId = query.get("release") ?? "";
const runNonce = query.get("run") ?? "";
const iframe = document.querySelector("#guest");
const status = document.querySelector("#status");
const startedAtEpochMs = Date.now();
const monotonicOrigin = performance.now();

let state;
let startCommandSent = false;
let terminalCommandSent = false;

function now() {
  return performance.now() - monotonicOrigin;
}

function render() {
  status.value = state.stage === "failed"
    ? `FAILED · ${state.failure?.reason ?? "unknown failure"}`
    : `${state.stage} · frames ${state.frameCount} · serial ${state.serialTail.length}`;
  document.documentElement.dataset.acceptanceStage = state.stage;
}

function fail(reason) {
  state = failAcceptance(state, reason, now());
  render();
}

function send(type) {
  iframe.contentWindow.postMessage(
    createVmHostCommand(type, runNonce),
    location.origin,
  );
}

function maybeSendTerminal() {
  if (state.stage !== "ready-to-send-terminal" || terminalCommandSent) return;
  state = markTerminalCommandSent(state, now());
  if (state.stage === "failed") {
    render();
    return;
  }
  terminalCommandSent = true;
  send("terminal");
  render();
}

if (!RELEASE_ID.test(releaseId) || /^0{64}$/.test(releaseId) || !NONCE.test(runNonce)) {
  document.documentElement.dataset.acceptanceStage = "failed";
  status.value = "FAILED · invalid acceptance run boundary";
  throw new Error("Acceptance URL requires a non-zero release digest and valid run nonce.");
}

state = createAcceptanceState({ releaseId, runNonce, now: now() });

window.addEventListener("message", (event) => {
  if (event.source !== iframe.contentWindow) return;
  const message = acceptVmHostMessage(event, {
    expectedOrigin: location.origin,
    expectedSource: iframe.contentWindow,
    expectedNonce: runNonce,
  });
  if (!message) {
    fail("The active production iframe emitted a malformed or misbound protocol event.");
    return;
  }

  state = advanceAcceptance(state, message, now());
  if (message.type === "ready" && state.hostReady && !startCommandSent) {
    startCommandSent = true;
    send("start");
  }
  maybeSendTerminal();
  render();
});

window.addEventListener("error", (event) => {
  fail(`Acceptance page error: ${event.error?.message ?? event.message}`);
});
window.addEventListener("unhandledrejection", (event) => {
  fail(`Acceptance page rejection: ${event.reason?.message ?? String(event.reason)}`);
});

const timer = setInterval(() => {
  state = checkAcceptanceTimeout(state, now(), DEFAULT_TIMEOUTS);
  maybeSendTerminal();
  render();
  if (state.stage === "passed" || state.stage === "failed") clearInterval(timer);
}, 250);

const hostQuery = new URLSearchParams({
  run: runNonce,
  protocol: "1",
  release: releaseId,
});
iframe.src = `/vm/index.html?${hostQuery}`;
render();

window.__omarchyBrowserAcceptance = Object.freeze({
  snapshot() {
    return {
      ...publicAcceptanceSnapshot(state),
      startedAt: new Date(startedAtEpochMs).toISOString(),
      completedAt:
        state.completedAt === null
          ? null
          : new Date(startedAtEpochMs + state.completedAt).toISOString(),
      page: {
        href: location.href,
        origin: location.origin,
        crossOriginIsolated: globalThis.crossOriginIsolated,
        devicePixelRatio: globalThis.devicePixelRatio,
        viewport: { width: innerWidth, height: innerHeight },
      },
    };
  },
});
