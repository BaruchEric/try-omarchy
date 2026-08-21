import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  ACTIVE_UPSTREAM,
  advanceDesktopEvidence,
  createDesktopEvidence,
} from "../../app/components/vm-ui-state.mjs";
import {
  acceptVmHostMessage,
  advanceAcceptance,
  checkAcceptanceTimeout,
  createAcceptanceState,
} from "./contract.mjs";
import { inspectScreenshotPng } from "./png.mjs";
import { assertFinalAcceptancePass, parseArguments } from "./run.mjs";
import {
  close,
  createAcceptanceProxy,
  inspectArtifactManifest,
  listen,
  normalizeLocalReleaseBase,
  waitForRequestIdle,
} from "./server.mjs";

const RELEASE_ID = "a".repeat(64);
const RUN_NONCE = "browser_acceptance_nonce_123456";
const COLD_GUEST_REPORT_PROVENANCE = Object.freeze({
  origin: "live-guest-serial",
});

function checkpointSourceEvidence(overrides = {}) {
  return {
    normalizedGuestReportSha256: "1".repeat(64),
    reportValidationSha256: "2".repeat(64),
    checkpointFrameSha256: "3".repeat(64),
    checkpointFrameHealthSha256: "4".repeat(64),
    ...overrides,
  };
}

function checkpointGuestReportProvenance(overrides = {}) {
  return {
    origin: "checkpoint-source-evidence",
    sourceEvidence: checkpointSourceEvidence(overrides),
  };
}

function hibernationResumeBinding(overrides = {}) {
  return {
    descriptorSha256: "5".repeat(64),
    markerSha256: "6".repeat(64),
    sourceBootId: "8d8ea31b-3c52-4cc5-a876-f9e1fc0b68a7",
    swapUuid: "4c9a13d2-7c3a-4f2c-b6e1-5a3048610e8f",
    ...overrides,
  };
}

function hibernationGuestReportProvenance(overrides = {}) {
  return {
    origin: "live-hibernation-serial",
    resume: hibernationResumeBinding(overrides),
  };
}

function hibernationResumeMessage(overrides = {}) {
  const binding = hibernationResumeBinding();
  return {
    type: "hibernationresume",
    evidence: {
      schemaVersion: 1,
      checkpointMode: "guest-hibernation-resume",
      ...binding,
      rendererReportSha256: "7".repeat(64),
      renderer: "virgl",
      kernelEvidence: [
        "PM: Image signature found, resuming",
        "PM: Image loading done",
        "PM: Image successfully loaded",
        "PM: hibernation: hibernation exit",
      ],
      runtimeDisplay: "sdl,gl=es,show-cursor=on",
      derivedInitramfsSha256: "8".repeat(64),
      ...overrides,
    },
  };
}

function report() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-15T00:11:44.933Z",
    provenance: { ...ACTIVE_UPSTREAM },
    system: {
      architecture: "x86_64",
      distribution: "Arch Linux",
      kernel: "7.1.8-arch1-3",
      sessionType: "wayland",
    },
    components: [
      { role: "compositor", name: "Hyprland", version: "0.56.2", executable: "/usr/bin/Hyprland" },
      { role: "shell", name: "quickshell", version: "0.3.0", executable: "/usr/bin/quickshell" },
    ],
    processes: [
      { name: "Hyprland", pid: 434 },
      { name: "quickshell", pid: 484 },
    ],
    commands: [
      { argv: ["uname", "-m"], exitCode: 0, stdout: "x86_64\n" },
      { argv: ["hyprctl", "version"], exitCode: 0, stdout: "Hyprland 0.56.2\n" },
      {
        argv: ["hyprctl", "monitors", "-j"],
        exitCode: 0,
        stdout: JSON.stringify([{ width: 1600, height: 900, disabled: false, dpmsStatus: true }]),
      },
      { argv: ["omarchy-version"], exitCode: 0, stdout: "4.0.0.alpha-1\n" },
    ],
    configs: [
      { path: "/usr/share/omarchy/default/hypr/omarchy.lua", sha256: "b".repeat(64), origin: "omarchy-upstream" },
    ],
  };
}

function release(guestReportProvenance = COLD_GUEST_REPORT_PROVENANCE) {
  return {
    type: "release",
    upstream: { ...ACTIVE_UPSTREAM },
    artifactManifestSha256: RELEASE_ID,
    guestReportProvenance,
  };
}

function guestReportMessage(
  provenance = COLD_GUEST_REPORT_PROVENANCE,
  guestReport = report(),
) {
  return { type: "guestreport", report: guestReport, ...provenance };
}

function frame(sequence, overrides = {}) {
  return {
    type: "guestframe",
    frame: {
      sequence,
      source: "qemu-guest",
      guestWidth: 1600,
      guestHeight: 900,
      sampledPixels: 576,
      nonBlackPixels: 200,
      ...overrides,
    },
  };
}

function desktopProof(overrides = {}) {
  return {
    type: "desktopproof",
    proof: {
      schemaVersion: 1,
      artifactManifestSha256: RELEASE_ID,
      challengeSha256: "c".repeat(64),
      baselineSequence: 10,
      responseSequence: 11,
      sampledPixels: 576,
      changedPixels: 304,
      dominantPixels: 272,
      ...overrides,
    },
  };
}

function metrics() {
  return {
    type: "metrics",
    metrics: {
      backingWidth: 1600,
      backingHeight: 900,
      cssWidth: 1600,
      cssHeight: 900,
      deviceWidth: 1600,
      deviceHeight: 900,
      devicePixelRatio: 1,
      pixelPerfect: true,
      aspectMatches: true,
    },
  };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, body) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(body.byteLength + 12);
  chunk.writeUInt32BE(body.byteLength, 0);
  typeBytes.copy(chunk, 4);
  body.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + body.byteLength)), 8 + body.byteLength);
  return chunk;
}

function rgbPng(width, height, colorAt) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = colorAt(y * width + x);
      const offset = row + 1 + x * 3;
      raw[offset] = red;
      raw[offset + 1] = green;
      raw[offset + 2] = blue;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function stateThroughProof() {
  let state = createAcceptanceState({ releaseId: RELEASE_ID, runNonce: RUN_NONCE });
  state = advanceAcceptance(state, { type: "ready" }, 1);
  state = advanceAcceptance(state, release(), 2);
  state = advanceAcceptance(state, guestReportMessage(), 3);
  state = advanceAcceptance(state, frame(10), 4);
  state = advanceAcceptance(state, frame(11), 5);
  return advanceAcceptance(state, desktopProof(), 6);
}

test("acceptance requires release, exact report, causal desktop proof, and a later frame", () => {
  let state = createAcceptanceState({ releaseId: RELEASE_ID, runNonce: RUN_NONCE });
  state = advanceAcceptance(state, metrics(), 0.5);
  state = advanceAcceptance(state, { type: "ready" }, 1);
  state = advanceAcceptance(state, release(), 2);
  state = advanceAcceptance(state, guestReportMessage(), 3);
  state = advanceAcceptance(state, {
    type: "inputaccepted",
    readinessProbe: false,
    event: { kind: "key", scancode: 40, down: true },
  }, 4);
  assert.equal(state.stage, "waiting-desktop-proof");
  assert.equal(state.inputDiagnostics.length, 1);
  state = advanceAcceptance(state, frame(10), 5);
  state = advanceAcceptance(state, frame(11), 6);
  state = advanceAcceptance(state, desktopProof(), 7);
  assert.equal(state.stage, "waiting-later-frame");
  state = advanceAcceptance(state, frame(12), 8);
  assert.equal(state.stage, "passed");
  assert.ok(state.report.ordinal < state.baselineFrame.ordinal);
  assert.ok(state.baselineFrame.ordinal < state.responseFrame.ordinal);
  assert.ok(state.responseFrame.ordinal < state.desktopProof.ordinal);
  assert.ok(state.desktopProof.ordinal < state.laterFrame.ordinal);
  const revoked = advanceAcceptance(state, desktopProof(), 9);
  assert.equal(revoked.stage, "failed");
  assert.match(revoked.failure.reason, /after.*completed/);
});

test("checkpoint acceptance preserves exact provenance and rejects downgrade or replay", () => {
  const provenance = checkpointGuestReportProvenance();
  const begin = () => {
    let state = createAcceptanceState({
      releaseId: RELEASE_ID,
      runNonce: RUN_NONCE,
    });
    state = advanceAcceptance(state, { type: "ready" }, 1);
    return advanceAcceptance(state, release(provenance), 2);
  };

  let missing = begin();
  missing = advanceAcceptance(missing, {
    type: "guestreport",
    report: report(),
    origin: "checkpoint-source-evidence",
  }, 3);
  assert.equal(missing.stage, "failed");
  assert.match(missing.failure.reason, /authentically prove/);

  let downgraded = begin();
  downgraded = advanceAcceptance(downgraded, guestReportMessage(), 3);
  assert.equal(downgraded.stage, "failed");
  assert.match(downgraded.failure.reason, /authentically prove/);

  let mismatched = begin();
  mismatched = advanceAcceptance(
    mismatched,
    guestReportMessage(
      checkpointGuestReportProvenance({
        reportValidationSha256: "9".repeat(64),
      }),
    ),
    3,
  );
  assert.equal(mismatched.stage, "failed");

  let state = begin();
  state = advanceAcceptance(state, guestReportMessage(provenance), 3);
  assert.equal(state.stage, "waiting-desktop-proof");
  assert.equal(state.report.value.origin, "checkpoint-source-evidence");
  assert.deepEqual(state.report.value.sourceEvidence, provenance.sourceEvidence);
  const replayed = advanceAcceptance(
    state,
    guestReportMessage(provenance),
    4,
  );
  assert.equal(replayed.stage, "failed");
  assert.match(replayed.failure.reason, /more than once/);

  state = advanceAcceptance(state, frame(10), 4);
  state = advanceAcceptance(state, frame(11), 5);
  state = advanceAcceptance(state, desktopProof(), 6);
  state = advanceAcceptance(state, metrics(), 7);
  state = advanceAcceptance(state, frame(12), 8);
  assert.equal(state.stage, "passed");
});

test("hibernation acceptance requires ordered authenticated resume before a fresh live report", () => {
  const provenance = hibernationGuestReportProvenance();
  const begin = () => {
    let state = createAcceptanceState({ releaseId: RELEASE_ID, runNonce: RUN_NONCE });
    state = advanceAcceptance(state, { type: "ready" }, 1);
    return advanceAcceptance(state, release(provenance), 2);
  };

  let earlyReport = begin();
  assert.equal(earlyReport.stage, "waiting-hibernation-resume");
  earlyReport = advanceAcceptance(
    earlyReport,
    guestReportMessage(provenance),
    3,
  );
  assert.equal(earlyReport.stage, "failed");
  assert.match(earlyReport.failure.reason, /resume/i);

  const timedOut = checkAcceptanceTimeout(begin(), 180_003);
  assert.equal(timedOut.stage, "failed");
  assert.match(timedOut.failure.reason, /waiting-hibernation-resume/);

  let downgraded = begin();
  downgraded = advanceAcceptance(downgraded, hibernationResumeMessage(), 3);
  downgraded = advanceAcceptance(downgraded, guestReportMessage(), 4);
  assert.equal(downgraded.stage, "failed");
  assert.match(downgraded.failure.reason, /exact verified Omarchy release/i);

  for (const [name, mutation] of [
    ["descriptor", { descriptorSha256: "9".repeat(64) }],
    ["marker", { markerSha256: "9".repeat(64) }],
    ["source boot", { sourceBootId: "11111111-2222-4333-8444-555555555555" }],
    ["swap", { swapUuid: "11111111-2222-4333-8444-555555555555" }],
    ["renderer", { renderer: "llvmpipe" }],
    ["renderer report", { rendererReportSha256: "not-a-digest" }],
    ["derived initramfs", { derivedInitramfsSha256: "not-a-digest" }],
    ["kernel order", { kernelEvidence: [
      "PM: Image loading done",
      "PM: Image signature found, resuming",
      "PM: Image successfully loaded",
      "PM: hibernation: hibernation exit",
    ] }],
  ]) {
    let hostile = begin();
    hostile = advanceAcceptance(
      hostile,
      hibernationResumeMessage(mutation),
      3,
    );
    assert.equal(hostile.stage, "failed", name);
  }

  let state = begin();
  state = advanceAcceptance(state, hibernationResumeMessage(), 3);
  assert.equal(state.stage, "waiting-report");
  assert.equal(state.hibernationResume.value.descriptorSha256, "5".repeat(64));
  assert.equal(state.hibernationResume.value.rendererReportSha256, "7".repeat(64));
  state = advanceAcceptance(state, guestReportMessage(provenance), 4);
  assert.equal(state.stage, "waiting-desktop-proof");
  assert.equal(state.report.value.origin, "live-hibernation-serial");
  assert.deepEqual(state.report.value.resume, provenance.resume);
  state = advanceAcceptance(state, frame(10), 5);
  state = advanceAcceptance(state, frame(11), 6);
  state = advanceAcceptance(state, desktopProof(), 7);
  state = advanceAcceptance(state, metrics(), 8);
  state = advanceAcceptance(state, frame(12), 9);
  assert.equal(state.stage, "passed");

  let replay = begin();
  replay = advanceAcceptance(replay, hibernationResumeMessage(), 3);
  replay = advanceAcceptance(replay, hibernationResumeMessage(), 4);
  assert.equal(replay.stage, "failed");
  assert.match(replay.failure.reason, /more than once|replay/i);
});

test("launcher state preserves hibernation provenance and latches ordering failures", () => {
  const provenance = hibernationGuestReportProvenance();
  const releaseEvent = {
    type: "release",
    release: {
      upstream: { ...ACTIVE_UPSTREAM },
      artifactManifestSha256: RELEASE_ID,
    },
    guestReportProvenance: provenance,
  };
  const reportEvent = {
    type: "guestreport",
    report: report(),
    ...provenance,
  };

  let rejected = advanceDesktopEvidence(
    createDesktopEvidence(RELEASE_ID),
    releaseEvent,
  );
  rejected = advanceDesktopEvidence(rejected, reportEvent);
  assert.equal(rejected.invalid, true);
  rejected = advanceDesktopEvidence(rejected, hibernationResumeMessage());
  assert.equal(rejected.invalid, true);
  assert.equal(rejected.hibernationResume, null);

  let state = advanceDesktopEvidence(
    createDesktopEvidence(RELEASE_ID),
    releaseEvent,
  );
  state = advanceDesktopEvidence(state, hibernationResumeMessage());
  assert.equal(state.invalid, false);
  assert.equal(state.hibernationResume.descriptorSha256, "5".repeat(64));
  assert.equal(state.hibernationResume.rendererReportSha256, "7".repeat(64));
  state = advanceDesktopEvidence(state, reportEvent);
  assert.equal(state.invalid, false);
  assert.deepEqual(state.reportProvenance, provenance);

  state = advanceDesktopEvidence(state, hibernationResumeMessage());
  assert.equal(state.invalid, true);
  assert.equal(state.ready, false);
});

test("final evidence recheck rejects a terminal event after provisional PASS", () => {
  let provisional = stateThroughProof();
  provisional = advanceAcceptance(provisional, metrics(), 7);
  provisional = advanceAcceptance(provisional, frame(12), 8);
  assert.equal(provisional.stage, "passed");

  const revoked = advanceAcceptance(
    provisional,
    { type: "phase", phase: "failed", reason: "late runtime failure" },
    9,
  );
  assert.equal(revoked.stage, "failed");
  assert.throws(
    () => assertFinalAcceptancePass(revoked),
    /revoked.*Production host emitted phase/,
  );
});

test("final evidence recheck rejects late exceptions and console errors", () => {
  const passing = { stage: "passed", failure: null };
  assert.equal(assertFinalAcceptancePass(passing), passing);
  assert.throws(
    () => assertFinalAcceptancePass(passing, {
      exceptions: [{ text: "late uncaught exception" }],
    }),
    /uncaught page exception/,
  );
  assert.throws(
    () => assertFinalAcceptancePass(passing, {
      consoleMessages: [{ type: "error", values: ["late console error"] }],
    }),
    /console error/,
  );
  assert.equal(
    assertFinalAcceptancePass(passing, {
      consoleMessages: [{ type: "log", values: ["non-fatal diagnostic"] }],
    }),
    passing,
  );
});

test("input queue acknowledgements and frames cannot replace desktop proof", () => {
  let state = createAcceptanceState({ releaseId: RELEASE_ID, runNonce: RUN_NONCE });
  state = advanceAcceptance(state, { type: "ready" }, 1);
  state = advanceAcceptance(state, release(), 2);
  state = advanceAcceptance(state, guestReportMessage(), 3);
  state = advanceAcceptance(state, {
    type: "inputaccepted",
    readinessProbe: false,
    event: { kind: "key", scancode: 227, down: true },
  }, 4);
  state = advanceAcceptance(state, frame(10), 5);
  state = advanceAcceptance(state, frame(11), 6);
  state = advanceAcceptance(state, frame(12), 7);
  state = advanceAcceptance(state, metrics(), 8);
  assert.equal(state.stage, "waiting-desktop-proof");
  assert.equal(state.desktopProof, null);
  assert.equal(state.laterFrame, null);
});

test("acceptance rejects wrong, duplicate, unobserved, and unchanged proof evidence", () => {
  let wrongRelease = createAcceptanceState({ releaseId: RELEASE_ID, runNonce: RUN_NONCE });
  wrongRelease = advanceAcceptance(wrongRelease, { type: "ready" }, 1);
  wrongRelease = advanceAcceptance(wrongRelease, release(), 2);
  wrongRelease = advanceAcceptance(wrongRelease, guestReportMessage(), 3);
  wrongRelease = advanceAcceptance(wrongRelease, frame(10), 4);
  wrongRelease = advanceAcceptance(wrongRelease, frame(11), 5);
  wrongRelease = advanceAcceptance(
    wrongRelease,
    desktopProof({ artifactManifestSha256: "d".repeat(64) }),
    6,
  );
  assert.equal(wrongRelease.stage, "failed");
  assert.match(wrongRelease.failure.reason, /another release/);

  let unchangedVisual = createAcceptanceState({ releaseId: RELEASE_ID, runNonce: RUN_NONCE });
  unchangedVisual = advanceAcceptance(unchangedVisual, { type: "ready" }, 1);
  unchangedVisual = advanceAcceptance(unchangedVisual, release(), 2);
  unchangedVisual = advanceAcceptance(unchangedVisual, guestReportMessage(), 3);
  unchangedVisual = advanceAcceptance(unchangedVisual, frame(10), 4);
  unchangedVisual = advanceAcceptance(unchangedVisual, frame(11), 5);
  unchangedVisual = advanceAcceptance(
    unchangedVisual,
    desktopProof({ changedPixels: 0, dominantPixels: 576 }),
    6,
  );
  assert.equal(unchangedVisual.stage, "failed");
  assert.match(unchangedVisual.failure.reason, /malformed/);

  let impossibleDominant = createAcceptanceState({ releaseId: RELEASE_ID, runNonce: RUN_NONCE });
  impossibleDominant = advanceAcceptance(impossibleDominant, { type: "ready" }, 1);
  impossibleDominant = advanceAcceptance(impossibleDominant, release(), 2);
  impossibleDominant = advanceAcceptance(impossibleDominant, guestReportMessage(), 3);
  impossibleDominant = advanceAcceptance(impossibleDominant, frame(10), 4);
  impossibleDominant = advanceAcceptance(impossibleDominant, frame(11), 5);
  impossibleDominant = advanceAcceptance(
    impossibleDominant,
    desktopProof({ dominantPixels: 0 }),
    6,
  );
  assert.equal(impossibleDominant.stage, "failed");
  assert.match(impossibleDominant.failure.reason, /malformed/);

  let duplicate = stateThroughProof();
  duplicate = advanceAcceptance(duplicate, desktopProof(), 7);
  assert.equal(duplicate.stage, "failed");
  assert.match(duplicate.failure.reason, /more than once/);

  let unobserved = createAcceptanceState({ releaseId: RELEASE_ID, runNonce: RUN_NONCE });
  unobserved = advanceAcceptance(unobserved, { type: "ready" }, 1);
  unobserved = advanceAcceptance(unobserved, release(), 2);
  unobserved = advanceAcceptance(unobserved, guestReportMessage(), 3);
  unobserved = advanceAcceptance(unobserved, desktopProof(), 4);
  assert.equal(unobserved.stage, "failed");
  assert.match(unobserved.failure.reason, /observed after/);

  let staleFrame = stateThroughProof();
  staleFrame = advanceAcceptance(staleFrame, frame(11), 7);
  assert.equal(staleFrame.stage, "failed");
  assert.match(staleFrame.failure.reason, /duplicated|backwards/);
});

test("active iframe nonce/source binding rejects replayed desktop proof", () => {
  const source = {};
  const data = {
    channel: "omarchy-vm-host",
    version: 1,
    runNonce: RUN_NONCE,
    ...desktopProof(),
  };
  const expected = {
    expectedOrigin: "https://try.example",
    expectedSource: source,
    expectedNonce: RUN_NONCE,
  };
  assert.deepEqual(
    acceptVmHostMessage(
      { origin: "https://try.example", source, data },
      expected,
    ),
    data,
  );
  assert.equal(
    acceptVmHostMessage(
      {
        origin: "https://try.example",
        source,
        data: { ...data, runNonce: "replayed_run_nonce_123456789" },
      },
      expected,
    ),
    null,
  );
  assert.equal(
    acceptVmHostMessage(
      { origin: "https://try.example", source: {}, data },
      expected,
    ),
    null,
  );
  const resumeData = {
    channel: "omarchy-vm-host",
    version: 1,
    runNonce: RUN_NONCE,
    ...hibernationResumeMessage(),
  };
  assert.deepEqual(
    acceptVmHostMessage(
      { origin: "https://try.example", source, data: resumeData },
      expected,
    ),
    resumeData,
  );
  assert.equal(
    acceptVmHostMessage(
      {
        origin: "https://try.example",
        source,
        data: {
          ...resumeData,
          evidence: { ...resumeData.evidence, renderer: "llvmpipe" },
        },
      },
      expected,
    ),
    null,
  );
});

test("acceptance times out while waiting for causal desktop proof", () => {

  const timedOut = checkAcceptanceTimeout(
    createAcceptanceState({ releaseId: RELEASE_ID, runNonce: RUN_NONCE }),
    31,
    {
      totalMs: 100,
      hostMs: 30,
      releaseMs: 30,
      reportMs: 30,
      desktopProofMs: 30,
      laterFrameMs: 30,
    },
  );
  assert.equal(timedOut.stage, "failed");
});

test("final PNG rejects the 99.986%-uniform QEMU8 failure shape", () => {
  const total = 1600 * 900;
  const varied = 202;
  const qemu8Failure = rgbPng(1600, 900, (index) => {
    if (index < total - varied) return [17, 17, 17];
    const cursorPixel = index - (total - varied) + 1;
    return [cursorPixel & 255, (cursorPixel * 17) & 255, (cursorPixel * 29) & 255];
  });
  assert.throws(
    () => inspectScreenshotPng(qemu8Failure),
    /visually degenerate.*99\.986%/,
  );

  const threshold = rgbPng(100, 100, (index) =>
    index < 9_500
      ? [17, 17, 17]
      : [index & 255, (index * 3) & 255, (index * 5) & 255],
  );
  assert.equal(
    inspectScreenshotPng(threshold, 100, 100).dominantColorFraction,
    0.95,
  );
});

test("CLI and release URL parsing reject ambiguous or remote inputs", () => {
  assert.equal(parseArguments(["--release-base", "http://127.0.0.1:8094/release/"]).timeoutMs, 1_860_000);
  assert.throws(() => parseArguments([]), /required/);
  assert.throws(() => parseArguments(["--release-base", "http://127.0.0.1/release/", "--wat"]), /Unknown/);
  assert.equal(normalizeLocalReleaseBase("http://localhost:8094/release").href, "http://localhost:8094/release/");
  assert.throws(() => normalizeLocalReleaseBase("https://example.com/release/"), /localhost/);
  assert.throws(() => normalizeLocalReleaseBase("http://localhost/release/?mutable=1"), /no query/);
});

test("artifact manifest inspection and proxy preserve exact bounded rootfs requests", async (context) => {
  const rootfs = Buffer.from("0123456789abcdef");
  const rootfsSha = createHash("sha256").update(rootfs).digest("hex");
  const worker = Buffer.from("self.onmessage = () => {};\n");
  const workerSha = createHash("sha256").update(worker).digest("hex");
  const manifestBody = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    upstream: { ...ACTIVE_UPSTREAM },
    artifacts: [
      {
        path: "production-worker.mjs",
        role: "host-worker",
        mediaType: "text/javascript",
        bytes: worker.byteLength,
        sha256: workerSha,
      },
      {
        path: "rootfs.ext4",
        role: "guest-rootfs",
        mediaType: "application/vnd.omarchy.ext4",
        bytes: rootfs.byteLength,
        sha256: rootfsSha,
      },
    ],
  })}\n`);
  assert.equal(inspectArtifactManifest(manifestBody).rootfs.sha256, rootfsSha);

  const upstream = createServer((request, response) => {
    if (request.url === "/release/artifact-manifest.json") {
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": manifestBody.byteLength });
      response.end(manifestBody);
      return;
    }
    if (request.url === "/release/rootfs.ext4" && request.method === "HEAD") {
      response.writeHead(200, {
        "Content-Length": rootfs.byteLength,
        "Accept-Ranges": "bytes",
        ETag: `"sha256-${rootfsSha}"`,
      });
      response.end();
      return;
    }
    if (request.url === "/release/rootfs.ext4") {
      const match = /^bytes=([0-9]+)-([0-9]+)$/.exec(request.headers.range ?? "");
      if (!match || request.headers["if-match"] !== `"sha256-${rootfsSha}"`) {
        response.writeHead(412, { "Content-Length": 0 });
        response.end();
        return;
      }
      const start = Number(match[1]);
      const end = Number(match[2]);
      const body = rootfs.subarray(start, end + 1);
      response.writeHead(206, {
        "Content-Length": body.byteLength,
        "Content-Range": `bytes ${start}-${end}/${rootfs.byteLength}`,
        ETag: `"sha256-${rootfsSha}"`,
      });
      response.end(body);
      return;
    }
    response.writeHead(404).end();
  });
  const upstreamOrigin = await listen(upstream);
  context.after(() => close(upstream));
  const proxy = await createAcceptanceProxy({ releaseBaseUrl: `${upstreamOrigin}/release/` });
  const proxyOrigin = await listen(proxy.server);
  context.after(() => close(proxy.server));
  const base = `${proxyOrigin}/omarchy/versions/${proxy.releaseId}/`;
  const harness = await fetch(`${proxyOrigin}/proofs/browser-acceptance/harness.html`);
  assert.equal(harness.status, 200);
  assert.equal(harness.headers.get("cross-origin-embedder-policy"), "require-corp");
  const desktopProofModule = await fetch(`${proxyOrigin}/vm/desktop-proof.mjs`);
  assert.equal(desktopProofModule.status, 200);
  assert.match(await desktopProofModule.text(), /export function isDesktopProof/);
  assert.equal(
    (await fetch(`${proxyOrigin}/public/vm/desktop-proof.mjs`)).status,
    200,
  );
  const publicHostUtils = await fetch(`${proxyOrigin}/public/vm/host-utils.mjs`);
  assert.equal(publicHostUtils.status, 200);
  assert.match(await publicHostUtils.text(), /export const EXPECTED_UPSTREAM/);
  assert.equal(await fetch(`${base}artifact-manifest.json`).then((response) => response.text()), manifestBody.toString());
  assert.equal(await fetch(`${base}artifact-manifest.json`).then((response) => response.text()), manifestBody.toString());

  const head = await fetch(`${base}rootfs.ext4`, { method: "HEAD" });
  assert.equal(head.status, 200);
  const range = await fetch(`${base}rootfs.ext4`, {
    headers: { Range: "bytes=2-5", "If-Match": `"sha256-${rootfsSha}"` },
  });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), "2345");
  const full = await fetch(`${base}rootfs.ext4`);
  assert.equal(full.status, 412);
  await waitForRequestIdle(proxy);
  const summary = proxy.summarizeRequests();
  assert.equal(summary.rootfs.headRequests, 1);
  assert.equal(summary.rootfs.rangeRequests, 2);
  assert.equal(summary.rootfs.unboundedGetRequests, 1);
  assert.ok(
    summary.violations.some((violation) => /bounded range|HTTP 412/.test(violation)),
    "an attempted unbounded GET must make acceptance fail closed",
  );
});
