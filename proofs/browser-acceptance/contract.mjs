import {
  acceptVmHostMessage,
  createVmHostCommand,
} from "../../app/components/vm-host-protocol.mjs";
import {
  ACTIVE_UPSTREAM,
  guestReportEvidenceMatchesRelease,
  isActiveReleaseIdentity,
  isGuestDisplayFrame,
} from "../../app/components/vm-ui-state.mjs";
import {
  DESKTOP_PROOF_SAMPLE_PIXELS,
  isDesktopProof,
} from "../../public/vm/desktop-proof.mjs";
import { normalizeGuestReportProvenance } from "../../public/vm/host-utils.mjs";

export { acceptVmHostMessage, createVmHostCommand };

export const ACCEPTANCE_SCHEMA_VERSION = 3;
export const FRAME_SAMPLE_PIXELS = DESKTOP_PROOF_SAMPLE_PIXELS;

const SHA256 = /^[a-f0-9]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{20,128}$/;
const TERMINAL_STAGES = new Set(["passed", "failed"]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  return (
    isRecord(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
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
  if (state.stage === "failed") return state;
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
  if (!state.desktopProof) return "waiting-desktop-proof";
  return "waiting-later-frame";
}

function checkPass(state, now) {
  if (!state.metrics || !state.desktopProof || !state.laterFrame) {
    return withStage(state, nextWaitingStage(state), now);
  }
  const passed = withStage(state, "passed", now);
  return { ...passed, completedAt: now };
}

export function createAcceptanceState({ releaseId, runNonce, now = 0 } = {}) {
  if (
    typeof releaseId !== "string" ||
    !SHA256.test(releaseId) ||
    /^0{64}$/.test(releaseId)
  ) {
    throw new TypeError(
      "Acceptance requires a non-zero lowercase 64-hex release ID.",
    );
  }
  if (typeof runNonce !== "string" || !NONCE.test(runNonce)) {
    throw new TypeError(
      "Acceptance requires a valid production-host run nonce.",
    );
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
    guestReportProvenance: null,
    report: null,
    metrics: null,
    desktopProof: null,
    baselineFrame: null,
    responseFrame: null,
    laterFrame: null,
    preProofFrames: [],
    lastFrameSequence: 0,
    frameCount: 0,
    nonQualifyingFrameCount: 0,
    inputDiagnostics: [],
    phases: [],
    serialTail: [],
    transitions: [
      Object.freeze({ ordinal: 0, monotonicMs: now, stage: "waiting-host" }),
    ],
    failure: null,
  };
}

export function advanceAcceptance(state, message, now) {
  if (state.stage === "failed") return state;
  if (!isRecord(message) || typeof message.type !== "string") {
    return failAcceptance(
      state,
      "The production host emitted a non-object event.",
      now,
    );
  }

  if (state.stage === "passed") {
    const terminalPhase =
      message.type === "phase" &&
      ["failed", "exited"].includes(message.phase);
    if (
      terminalPhase ||
      [
        "error",
        "reload",
        "ready",
        "release",
        "guestreport",
        "desktopproof",
      ].includes(message.type)
    ) {
      return failAcceptance(
        { ...state, eventOrdinal: state.eventOrdinal + 1 },
        `Production host emitted ${message.type} after the acceptance contract had completed.`,
        now,
      );
    }
    return state;
  }

  const ordinal = state.eventOrdinal + 1;
  let next = { ...state, eventOrdinal: ordinal };

  if (message.type === "error" || message.type === "reload") {
    const detail =
      message.technical ?? message.message ?? message.reason ?? message.type;
    return failAcceptance(
      next,
      `Production host ${message.type}: ${String(detail)}`,
      now,
    );
  }

  if (message.type === "ready") {
    if (state.hostReady) {
      return failAcceptance(
        next,
        "Production host emitted ready more than once.",
        now,
      );
    }
    next.hostReady = milestone(
      ordinal,
      now,
      Object.freeze({ type: "ready" }),
    );
    return withStage(next, "waiting-release", now);
  }

  if (message.type === "phase") {
    next.phases = [
      ...state.phases,
      Object.freeze({ ordinal, monotonicMs: now, phase: message.phase }),
    ].slice(-64);
    if (["failed", "exited"].includes(message.phase)) {
      return failAcceptance(
        next,
        `Runtime entered terminal phase ${message.phase}.`,
        now,
      );
    }
    return next;
  }

  if (message.type === "serial") {
    next.serialTail = [
      ...state.serialTail,
      Object.freeze({
        ordinal,
        monotonicMs: now,
        stream: message.stream,
        line: message.line,
      }),
    ].slice(-400);
    return next;
  }

  if (message.type === "metrics") {
    if (!validMetrics(message.metrics)) {
      return failAcceptance(
        next,
        "The production canvas was not pixel-perfect 1600x900 at DPR 1.",
        now,
      );
    }
    next.metrics = milestone(
      ordinal,
      now,
      Object.freeze({ ...message.metrics }),
    );
    return checkPass(next, now);
  }

  if (message.type === "release") {
    if (!state.hostReady) {
      return failAcceptance(
        next,
        "Release identity preceded the active production host boundary.",
        now,
      );
    }
    if (state.release) {
      return failAcceptance(
        next,
        "Production host emitted release identity more than once.",
        now,
      );
    }
    const release = {
      upstream: message.upstream,
      artifactManifestSha256: message.artifactManifestSha256,
    };
    const guestReportProvenance = normalizeGuestReportProvenance(
      message.guestReportProvenance,
    );
    if (
      !hasExactKeys(message, [
        "type",
        "upstream",
        "artifactManifestSha256",
        "guestReportProvenance",
      ])
    ) {
      return failAcceptance(
        next,
        "Release identity had an unexpected or incomplete shape.",
        now,
      );
    }
    if (!isActiveReleaseIdentity(release, state.releaseId)) {
      return failAcceptance(
        next,
        "Release identity did not exactly match the supplied manifest digest and pinned Omarchy source.",
        now,
      );
    }
    if (!guestReportProvenance) {
      return failAcceptance(
        next,
        "Release identity omitted or malformed its guest-report provenance contract.",
        now,
      );
    }
    next.release = milestone(
      ordinal,
      now,
      Object.freeze({
        upstream: Object.freeze({ ...message.upstream }),
        artifactManifestSha256: message.artifactManifestSha256,
      }),
    );
    next.guestReportProvenance = guestReportProvenance;
    return withStage(next, "waiting-report", now);
  }

  if (message.type === "guestreport") {
    if (!state.release) {
      return failAcceptance(
        next,
        "Guest report preceded verified release identity.",
        now,
      );
    }
    if (state.report) {
      return failAcceptance(
        next,
        "Production host emitted guest report more than once.",
        now,
      );
    }
    if (
      !guestReportEvidenceMatchesRelease(
        message,
        state.release.value,
        state.releaseId,
        state.guestReportProvenance,
      )
    ) {
      return failAcceptance(
        next,
        "Guest report did not authentically prove the exact verified Omarchy release.",
        now,
      );
    }
    next.report = milestone(
      ordinal,
      now,
      Object.freeze({
        report: Object.freeze(message.report),
        origin: message.origin,
        ...(message.sourceEvidence === undefined
          ? {}
          : { sourceEvidence: Object.freeze({ ...message.sourceEvidence }) }),
      }),
    );
    return withStage(next, "waiting-desktop-proof", now);
  }

  if (message.type === "desktopproof") {
    if (!state.report) {
      return failAcceptance(
        next,
        "Desktop proof preceded the exact guest report.",
        now,
      );
    }
    if (state.desktopProof) {
      return failAcceptance(
        next,
        "Production host emitted desktop proof more than once.",
        now,
      );
    }
    if (!isDesktopProof(message.proof, state.releaseId)) {
      return failAcceptance(
        next,
        "Desktop proof was malformed or bound to another release.",
        now,
      );
    }
    const baselineFrame = state.preProofFrames.find(
      (frame) => frame.value.sequence === message.proof.baselineSequence,
    );
    const responseFrame = state.preProofFrames.find(
      (frame) => frame.value.sequence === message.proof.responseSequence,
    );
    if (
      !baselineFrame ||
      !responseFrame ||
      state.report.ordinal >= baselineFrame.ordinal ||
      baselineFrame.ordinal >= responseFrame.ordinal ||
      responseFrame.ordinal >= ordinal
    ) {
      return failAcceptance(
        next,
        "Desktop proof did not reference ordered guest frames observed after the exact report.",
        now,
      );
    }
    next.desktopProof = milestone(
      ordinal,
      now,
      Object.freeze({ ...message.proof }),
    );
    next.baselineFrame = baselineFrame;
    next.responseFrame = responseFrame;
    next.preProofFrames = [];
    return withStage(next, "waiting-later-frame", now);
  }

  if (message.type === "inputaccepted") {
    next.inputDiagnostics = [
      ...state.inputDiagnostics,
      milestone(ordinal, now, Object.freeze({ ...message.event })),
    ].slice(-128);
    return next;
  }

  if (message.type === "guestframe") {
    if (!state.release) {
      return failAcceptance(
        next,
        "Guest frame preceded verified release identity.",
        now,
      );
    }
    if (message.frame.sequence <= state.lastFrameSequence) {
      return failAcceptance(
        next,
        "Guest frame sequence was duplicated or moved backwards.",
        now,
      );
    }
    next.lastFrameSequence = message.frame.sequence;
    next.frameCount = state.frameCount + 1;
    const frameMilestone = milestone(
      ordinal,
      now,
      Object.freeze({ ...message.frame }),
    );
    if (!state.desktopProof) {
      next.preProofFrames = [...state.preProofFrames, frameMilestone];
    }
    if (!validAcceptanceFrame(message.frame)) {
      next.nonQualifyingFrameCount = state.nonQualifyingFrameCount + 1;
      return next;
    }
    if (
      state.desktopProof &&
      ordinal > state.desktopProof.ordinal &&
      message.frame.sequence > state.desktopProof.value.responseSequence
    ) {
      next.laterFrame = frameMilestone;
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
  desktopProofMs: 3 * 60 * 1000,
  laterFrameMs: 2 * 60 * 1000,
});

export function timeoutForStage(stage, timeouts = DEFAULT_TIMEOUTS) {
  const byStage = {
    "waiting-host": timeouts.hostMs,
    "waiting-release": timeouts.releaseMs,
    "waiting-report": timeouts.reportMs,
    "waiting-desktop-proof": timeouts.desktopProofMs,
    "waiting-later-frame": timeouts.laterFrameMs,
  };
  return byStage[stage] ?? 0;
}

export function checkAcceptanceTimeout(
  state,
  now,
  timeouts = DEFAULT_TIMEOUTS,
) {
  if (TERMINAL_STAGES.has(state.stage)) return state;
  if (now - state.createdAt > timeouts.totalMs) {
    return failAcceptance(
      state,
      `Acceptance exceeded its ${timeouts.totalMs}ms total timeout.`,
      now,
    );
  }
  const stageTimeout = timeoutForStage(state.stage, timeouts);
  if (stageTimeout > 0 && now - state.stageStartedAt > stageTimeout) {
    return failAcceptance(
      state,
      `Acceptance stage ${state.stage} exceeded ${stageTimeout}ms.`,
      now,
    );
  }
  return state;
}

export function publicAcceptanceSnapshot(state) {
  return structuredClone(state);
}
