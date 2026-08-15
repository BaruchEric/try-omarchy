import {
  acceptVmHostMessage,
  createVmHostCommand,
} from "../../app/components/vm-host-protocol.mjs";
import {
  ACTIVE_UPSTREAM,
  guestReportMatchesRelease,
  isActiveReleaseIdentity,
  isGuestDisplayFrame,
} from "../../app/components/vm-ui-state.mjs";

export { acceptVmHostMessage, createVmHostCommand };

export const ACCEPTANCE_SCHEMA_VERSION = 1;
export const FRAME_SAMPLE_PIXELS = 32 * 18;
export const TERMINAL_INPUT_SEQUENCE = Object.freeze([
  Object.freeze({ kind: "key", scancode: 227, down: true }),
  Object.freeze({ kind: "key", scancode: 40, down: true }),
  Object.freeze({ kind: "key", scancode: 40, down: false }),
  Object.freeze({ kind: "key", scancode: 227, down: false }),
]);
export const READINESS_INPUT = Object.freeze({
  kind: "pointer",
  x: 16384,
  y: 16384,
  buttons: 0,
});

const SHA256 = /^[a-f0-9]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{20,128}$/;
const TERMINAL_STAGES = new Set(["passed", "failed"]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameRecord(actual, expected) {
  return (
    isRecord(actual) &&
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => actual[key] === value)
  );
}

function validMetrics(metrics) {
  return (
    isRecord(metrics) &&
    metrics.backingWidth === 1600 &&
    metrics.backingHeight === 900 &&
    metrics.cssWidth === 1600 &&
    metrics.cssHeight === 900 &&
    metrics.deviceWidth === 1600 &&
    metrics.deviceHeight === 900 &&
    metrics.devicePixelRatio === 1 &&
    metrics.pixelPerfect === true &&
    metrics.aspectMatches === true
  );
}

function validAcceptanceFrame(frame) {
  return (
    isGuestDisplayFrame(frame) &&
    frame.sampledPixels === FRAME_SAMPLE_PIXELS &&
    frame.nonBlackPixels > 0
  );
}

function milestone(ordinal, monotonicMs, value) {
  return Object.freeze({ ordinal, monotonicMs, value });
}

function withStage(state, stage, now) {
  if (state.stage === stage) return state;
  return {
    ...state,
    stage,
    stageStartedAt: now,
    transitions: [
      ...state.transitions,
      Object.freeze({ ordinal: state.eventOrdinal, monotonicMs: now, stage }),
    ],
  };
}

export function failAcceptance(state, reason, now) {
  if (TERMINAL_STAGES.has(state.stage)) return state;
  const failed = withStage(state, "failed", now);
  return {
    ...failed,
    failure: Object.freeze({ reason: String(reason), monotonicMs: now }),
    completedAt: now,
  };
}

function nextWaitingStage(state) {
  if (!state.hostReady) return "waiting-host";
  if (!state.release) return "waiting-release";
  if (!state.report) return "waiting-report";
  if (!state.readinessInput || !state.firstFrame) return "waiting-first-frame-and-input";
  if (!state.terminalCommand) return "ready-to-send-terminal";
  if (state.terminalInputs.length !== TERMINAL_INPUT_SEQUENCE.length) {
    return "waiting-terminal-input";
  }
  return "waiting-later-frame";
}

function checkPass(state, now) {
  if (
    !state.metrics ||
    !state.firstFrame ||
    !state.terminalInputComplete ||
    !state.laterFrame
  ) {
    return withStage(state, nextWaitingStage(state), now);
  }
  const passed = withStage(state, "passed", now);
  return { ...passed, completedAt: now };
}

export function createAcceptanceState({ releaseId, runNonce, now = 0 } = {}) {
  if (typeof releaseId !== "string" || !SHA256.test(releaseId) || /^0{64}$/.test(releaseId)) {
    throw new TypeError("Acceptance requires a non-zero lowercase 64-hex release ID.");
  }
  if (typeof runNonce !== "string" || !NONCE.test(runNonce)) {
    throw new TypeError("Acceptance requires a valid production-host run nonce.");
  }
  return {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    releaseId,
    runNonce,
    expectedUpstream: { ...ACTIVE_UPSTREAM },
    stage: "waiting-host",
    stageStartedAt: now,
    createdAt: now,
    completedAt: null,
    eventOrdinal: 0,
    hostReady: null,
    release: null,
    report: null,
    metrics: null,
    readinessInput: null,
    firstFrame: null,
    terminalCommand: null,
    terminalInputs: [],
    terminalInputComplete: null,
    laterFrame: null,
    lastFrameSequence: 0,
    frameCount: 0,
    nonQualifyingFrameCount: 0,
    phases: [],
    serialTail: [],
    transitions: [Object.freeze({ ordinal: 0, monotonicMs: now, stage: "waiting-host" })],
    failure: null,
  };
}

export function markTerminalCommandSent(state, now) {
  if (state.stage !== "ready-to-send-terminal" || state.terminalCommand) {
    return failAcceptance(state, "Terminal command was sent outside its authenticated acceptance window.", now);
  }
  const eventOrdinal = state.eventOrdinal + 1;
  const terminalCommand = milestone(eventOrdinal, now, Object.freeze({ type: "terminal" }));
  return withStage({ ...state, eventOrdinal, terminalCommand }, "waiting-terminal-input", now);
}

export function advanceAcceptance(state, message, now) {
  if (TERMINAL_STAGES.has(state.stage)) return state;
  if (!isRecord(message) || typeof message.type !== "string") {
    return failAcceptance(state, "The production host emitted a non-object event.", now);
  }

  const ordinal = state.eventOrdinal + 1;
  let next = { ...state, eventOrdinal: ordinal };

  if (message.type === "error" || message.type === "reload") {
    const detail = message.technical ?? message.message ?? message.reason ?? message.type;
    return failAcceptance(next, `Production host ${message.type}: ${String(detail)}`, now);
  }

  if (message.type === "ready") {
    if (state.hostReady) return failAcceptance(next, "Production host emitted ready more than once.", now);
    next.hostReady = milestone(ordinal, now, Object.freeze({ type: "ready" }));
    return withStage(next, "waiting-release", now);
  }

  if (message.type === "phase") {
    next.phases = [
      ...state.phases,
      Object.freeze({ ordinal, monotonicMs: now, phase: message.phase }),
    ].slice(-64);
    if (["failed", "exited"].includes(message.phase)) {
      return failAcceptance(next, `Runtime entered terminal phase ${message.phase}.`, now);
    }
    return next;
  }

  if (message.type === "serial") {
    const serialTail = [
      ...state.serialTail,
      Object.freeze({ ordinal, monotonicMs: now, stream: message.stream, line: message.line }),
    ];
    next.serialTail = serialTail.slice(-400);
    return next;
  }

  if (message.type === "metrics") {
    if (!validMetrics(message.metrics)) {
      return failAcceptance(next, "The production canvas was not pixel-perfect 1600x900 at DPR 1.", now);
    }
    next.metrics = milestone(ordinal, now, Object.freeze({ ...message.metrics }));
    return checkPass(next, now);
  }

  if (message.type === "release") {
    if (state.release) return failAcceptance(next, "Production host emitted release identity more than once.", now);
    const release = {
      upstream: message.upstream,
      artifactManifestSha256: message.artifactManifestSha256,
    };
    if (!isActiveReleaseIdentity(release, state.releaseId)) {
      return failAcceptance(next, "Release identity did not exactly match the supplied manifest digest and pinned Omarchy source.", now);
    }
    next.release = milestone(ordinal, now, Object.freeze({
      upstream: Object.freeze({ ...message.upstream }),
      artifactManifestSha256: message.artifactManifestSha256,
    }));
    return withStage(next, "waiting-report", now);
  }

  if (message.type === "guestreport") {
    if (!state.release) return failAcceptance(next, "Guest report preceded verified release identity.", now);
    if (state.report) return failAcceptance(next, "Production host emitted guest report more than once.", now);
    if (!guestReportMatchesRelease(message.report, state.release.value, state.releaseId)) {
      return failAcceptance(next, "Guest report did not authentically prove the exact verified Omarchy release.", now);
    }
    next.report = milestone(ordinal, now, Object.freeze(message.report));
    return withStage(next, "waiting-first-frame-and-input", now);
  }

  if (message.type === "inputaccepted") {
    if (!state.report) return failAcceptance(next, "Input acceptance preceded the authentic guest report.", now);
    if (message.readinessProbe === true) {
      if (state.readinessInput) return failAcceptance(next, "Readiness input was accepted more than once.", now);
      if (!sameRecord(message.event, READINESS_INPUT)) {
        return failAcceptance(next, "Readiness input did not match the exact harmless pointer probe.", now);
      }
      next.readinessInput = milestone(ordinal, now, Object.freeze({ ...message.event }));
      return withStage(next, nextWaitingStage(next), now);
    }

    if (!state.terminalCommand) {
      return failAcceptance(next, "Uncorrelated guest input was accepted before the terminal command.", now);
    }
    const expected = TERMINAL_INPUT_SEQUENCE[state.terminalInputs.length];
    if (!expected || !sameRecord(message.event, expected)) {
      return failAcceptance(next, "Terminal input acceptance did not match the exact commanded scancode sequence.", now);
    }
    const accepted = milestone(ordinal, now, Object.freeze({ ...message.event }));
    next.terminalInputs = [...state.terminalInputs, accepted];
    if (next.terminalInputs.length === TERMINAL_INPUT_SEQUENCE.length) {
      next.terminalInputComplete = milestone(ordinal, now, Object.freeze({
        frameSequenceBeforeCompletion: state.lastFrameSequence,
      }));
      return withStage(next, "waiting-later-frame", now);
    }
    return next;
  }

  if (message.type === "guestframe") {
    if (!state.release) return failAcceptance(next, "Guest frame preceded verified release identity.", now);
    if (message.frame.sequence <= state.lastFrameSequence) {
      return failAcceptance(next, "Guest frame sequence was duplicated or moved backwards.", now);
    }
    next.lastFrameSequence = message.frame.sequence;
    next.frameCount = state.frameCount + 1;
    if (!validAcceptanceFrame(message.frame)) {
      next.nonQualifyingFrameCount = state.nonQualifyingFrameCount + 1;
      return next;
    }
    if (!state.report) return next;
    if (!state.firstFrame) {
      next.firstFrame = milestone(ordinal, now, Object.freeze({ ...message.frame }));
      return withStage(next, nextWaitingStage(next), now);
    }
    if (
      state.terminalInputComplete &&
      ordinal > state.terminalInputComplete.ordinal &&
      message.frame.sequence > state.terminalInputComplete.value.frameSequenceBeforeCompletion &&
      message.frame.sequence > state.firstFrame.value.sequence
    ) {
      next.laterFrame = milestone(ordinal, now, Object.freeze({ ...message.frame }));
      return checkPass(next, now);
    }
    return next;
  }

  return next;
}

export const DEFAULT_TIMEOUTS = Object.freeze({
  totalMs: 30 * 60 * 1000,
  hostMs: 30 * 1000,
  releaseMs: 3 * 60 * 1000,
  reportMs: 25 * 60 * 1000,
  firstFrameAndInputMs: 3 * 60 * 1000,
  terminalInputMs: 30 * 1000,
  laterFrameMs: 2 * 60 * 1000,
});

export function timeoutForStage(stage, timeouts = DEFAULT_TIMEOUTS) {
  const byStage = {
    "waiting-host": timeouts.hostMs,
    "waiting-release": timeouts.releaseMs,
    "waiting-report": timeouts.reportMs,
    "waiting-first-frame-and-input": timeouts.firstFrameAndInputMs,
    "ready-to-send-terminal": timeouts.terminalInputMs,
    "waiting-terminal-input": timeouts.terminalInputMs,
    "waiting-later-frame": timeouts.laterFrameMs,
  };
  return byStage[stage] ?? 0;
}

export function checkAcceptanceTimeout(state, now, timeouts = DEFAULT_TIMEOUTS) {
  if (TERMINAL_STAGES.has(state.stage)) return state;
  if (now - state.createdAt > timeouts.totalMs) {
    return failAcceptance(state, `Acceptance exceeded its ${timeouts.totalMs}ms total timeout.`, now);
  }
  const stageTimeout = timeoutForStage(state.stage, timeouts);
  if (stageTimeout > 0 && now - state.stageStartedAt > stageTimeout) {
    return failAcceptance(state, `Acceptance stage ${state.stage} exceeded ${stageTimeout}ms.`, now);
  }
  return state;
}

export function publicAcceptanceSnapshot(state) {
  return structuredClone(state);
}
