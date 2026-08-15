import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_PERFORMANCE_TARGETS,
  evaluateBrowserPerformanceTrace as evaluateRawTrace,
  MINIMUM_ALLOWED_UNIQUE_FPS,
  resolvePerformanceTargets,
} from "./gate.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function makeTrace({
  fps = 24,
  durationMs = 2_000,
  duplicateCopies = 1,
  staticEpochs = false,
  acceptanceDelayMs = 4,
} = {}) {
  const challengeSha256 = sha256("browser-performance-animation-challenge");
  const windowId = "animation_window_0001";
  const inputTimes = [200, 650, 1_150, 1_600];
  const inputs = inputTimes.map((timestampMs, index) => ({
    inputId: `input_${index + 1}`,
    actionDigest: sha256(`input-action-${index + 1}`),
    kind: index % 2 === 0 ? "pointer" : "key",
    timestampMs,
    acceptedAtMs: timestampMs + acceptanceDelayMs,
    guestInputSequence: index + 1,
  }));
  const events = [{
    type: "window-start",
    timestampMs: 0,
    windowId,
    challengeSha256,
    activity: "guest-animation",
  }];

  for (const input of inputs) {
    events.push({
      type: "input-sent",
      timestampMs: input.timestampMs,
      inputId: input.inputId,
      challengeSha256,
      actionDigest: input.actionDigest,
      kind: input.kind,
    });
    events.push({
      type: "input-accepted",
      timestampMs: input.acceptedAtMs,
      inputId: input.inputId,
      challengeSha256,
      actionDigest: input.actionDigest,
      guestInputSequence: input.guestInputSequence,
      deliverySource: "qemu-virtio-input-ring",
    });
  }

  const intervalMs = 1_000 / fps;
  const frameCount = Math.round(durationMs / intervalMs) + 1;
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const timestampMs = frameIndex === frameCount - 1
      ? durationMs
      : frameIndex * intervalMs;
    const latestGuestInputSequence = inputs.filter(
      ({ acceptedAtMs }) => acceptedAtMs <= timestampMs,
    ).length;
    const frame = {
      type: "frame-presented",
      timestampMs,
      presentSequence: 0,
      scanoutEpoch: frameIndex + 1,
      source: "qemu-virtio-gpu-scanout",
      contentDigest: sha256(staticEpochs ? "static-frame" : `frame-${frameIndex}`),
      sampledPixels: 576,
      changedPixels: frameIndex === 0 || staticEpochs ? 0 : 64,
      latestGuestInputSequence,
    };
    events.push(frame);
    if (frameIndex > 0 && frameIndex < frameCount - 1) {
      for (let copy = 0; copy < duplicateCopies; copy += 1) {
        events.push({ ...frame, timestampMs: timestampMs + (copy + 1) / 100 });
      }
    }
  }
  events.push({
    type: "window-end",
    timestampMs: durationMs,
    windowId,
    challengeSha256,
    completion: "guest-animation-complete",
  });

  const order = new Map([
    ["window-start", 0],
    ["input-sent", 1],
    ["input-accepted", 2],
    ["frame-presented", 3],
    ["window-end", 4],
  ]);
  events.sort((left, right) =>
    left.timestampMs - right.timestampMs || order.get(left.type) - order.get(right.type));
  let presentSequence = 0;
  for (const event of events) {
    if (event.type === "frame-presented") event.presentSequence = ++presentSequence;
  }
  return {
    schemaVersion: 1,
    runId: "browser_performance_run_0001",
    identity: {
      artifactManifestSha256: sha256("artifact-manifest"),
      runtimeManifestSha256: sha256("runtime-manifest"),
      guestDescriptorSha256: sha256("guest-descriptor"),
      hibernateDescriptorSha256: sha256("hibernate-descriptor"),
    },
    clock: "performance.now",
    telemetry: {
      source: "qemu-virtio-gpu-scanout",
      cadence: "uncapped-internal",
      exportMode: "post-window-hashed",
    },
    events,
  };
}

function evaluateBrowserPerformanceTrace(trace, overrides = {}, expectedIdentity = trace?.identity) {
  return evaluateRawTrace(trace, overrides, expectedIdentity);
}

function failureCodes(evidence) {
  return new Set(evidence.failures.map(({ code }) => code));
}

test("default gate passes 24 unique dynamic FPS and ignores duplicate presents", () => {
  const trace = makeTrace({ duplicateCopies: 2 });
  const evidence = evaluateBrowserPerformanceTrace(trace);

  assert.equal(DEFAULT_PERFORMANCE_TARGETS.minimumUniqueFps, 24);
  assert.equal(MINIMUM_ALLOWED_UNIQUE_FPS, 24);
  assert.equal(evidence.verdict, "PASS", JSON.stringify(evidence.failures));
  assert.equal(evidence.metrics.uniqueScanoutEpochs, 49);
  assert.equal(evidence.metrics.uniqueEpochIntervals, 48);
  assert.equal(evidence.metrics.dynamicEpochIntervals, 48);
  assert.equal(evidence.metrics.uniqueGuestFps, 24);
  assert.equal(evidence.metrics.dynamicGuestFps, 24);
  assert.equal(evidence.metrics.duplicatePresents, 94);
  assert.equal(evidence.metrics.presents, 143);
  assert.equal(evidence.metrics.inputToDynamicFrameLatency.count, 4);
  assert.ok(evidence.metrics.inputToDynamicFrameLatency.p95Ms < 100);
  assert.deepEqual(evidence.rawTrace, trace);
  assert.deepEqual(evidence.identity, trace.identity);
  assert.notEqual(evidence.rawTrace, trace);
  assert.equal(evidence.metrics.uniqueEpochTimeline[0].timestampMs, 0);
  assert.equal(evidence.metrics.uniqueEpochTimeline.at(-1).timestampMs, 2_000);
});

test("trace identity is mandatory, preserved, and bound to the expected artifact set", () => {
  const trace = makeTrace();
  const expectedIdentity = structuredClone(trace.identity);
  const replayedTrace = structuredClone(trace);
  replayedTrace.identity.artifactManifestSha256 = sha256("different-artifact-manifest");

  const replayEvidence = evaluateRawTrace(replayedTrace, {}, expectedIdentity);
  assert.equal(replayEvidence.verdict, "FAIL");
  assert.ok(failureCodes(replayEvidence).has("IDENTITY_MISMATCH"));
  assert.deepEqual(replayEvidence.identity, replayedTrace.identity);

  const noExpectedIdentity = evaluateRawTrace(trace);
  assert.ok(failureCodes(noExpectedIdentity).has("EXPECTED_IDENTITY"));

  const incompleteIdentity = structuredClone(trace);
  delete incompleteIdentity.identity.runtimeManifestSha256;
  const incompleteEvidence = evaluateRawTrace(incompleteIdentity, {}, expectedIdentity);
  assert.ok(failureCodes(incompleteEvidence).has("TRACE_IDENTITY"));
  assert.ok(failureCodes(incompleteEvidence).has("IDENTITY_MISMATCH"));
});

test("duplicate presents cannot inflate a sub-target unique scanout rate", () => {
  const evidence = evaluateBrowserPerformanceTrace(makeTrace({
    fps: 12,
    duplicateCopies: 12,
  }));
  const codes = failureCodes(evidence);

  assert.equal(evidence.verdict, "FAIL");
  assert.ok(evidence.metrics.presents > 250);
  assert.equal(evidence.metrics.uniqueGuestFps, 12);
  assert.ok(codes.has("UNIQUE_FPS"));
  assert.ok(codes.has("DYNAMIC_FPS"));
});

test("new epochs with static content are rejected as idle misuse", () => {
  const evidence = evaluateBrowserPerformanceTrace(makeTrace({
    fps: 30,
    staticEpochs: true,
  }));
  const codes = failureCodes(evidence);

  assert.equal(evidence.metrics.uniqueGuestFps, 30);
  assert.equal(evidence.metrics.dynamicGuestFps, 0);
  assert.equal(evidence.metrics.dynamicEpochRatio, 0);
  assert.ok(codes.has("DYNAMIC_FPS"));
  assert.ok(codes.has("STATIC_EPOCHS"));
  assert.ok(codes.has("DYNAMIC_FRAME_GAP"));
});

test("an unarmed idle window cannot masquerade as an animation proof", () => {
  const trace = makeTrace();
  trace.events[0].activity = "idle-desktop";
  const evidence = evaluateBrowserPerformanceTrace(trace);

  assert.equal(evidence.verdict, "FAIL");
  assert.ok(failureCodes(evidence).has("WINDOW_BOUNDARY"));
});

test("active interaction latency and causal dynamic frames are mandatory", () => {
  const slow = evaluateBrowserPerformanceTrace(makeTrace({ acceptanceDelayMs: 120 }));
  assert.ok(failureCodes(slow).has("INPUT_ACCEPT_LATENCY"));
  assert.ok(failureCodes(slow).has("INPUT_FRAME_LATENCY"));

  const noCausalFrame = makeTrace();
  for (const event of noCausalFrame.events) {
    if (event.type === "frame-presented") event.latestGuestInputSequence = 0;
  }
  const noCausalEvidence = evaluateBrowserPerformanceTrace(noCausalFrame);
  assert.ok(failureCodes(noCausalEvidence).has("INPUT_NO_DYNAMIC_FRAME"));
  assert.ok(failureCodes(noCausalEvidence).has("INTERACTION_SAMPLES"));
});

test("host-queued input and sampled public frame telemetry cannot satisfy the gate", () => {
  const queuedOnly = makeTrace();
  const acceptance = queuedOnly.events.find(({ type }) => type === "input-accepted");
  acceptance.deliverySource = "sdl-push-event";
  const queuedEvidence = evaluateBrowserPerformanceTrace(queuedOnly);
  assert.ok(failureCodes(queuedEvidence).has("EVENT_CONTRACT"));
  assert.ok(failureCodes(queuedEvidence).has("INPUT_UNACKNOWLEDGED"));

  const sampled = makeTrace();
  sampled.telemetry.cadence = "public-guestframe-sampled";
  assert.ok(failureCodes(evaluateBrowserPerformanceTrace(sampled)).has("TELEMETRY"));
});

test("the active window is bounded and interactions must span it", () => {
  const trace = makeTrace();
  const end = trace.events.at(-1);
  end.timestampMs = 6_000;
  const evidence = evaluateBrowserPerformanceTrace(trace);

  assert.equal(evidence.verdict, "FAIL");
  assert.ok(failureCodes(evidence).has("WINDOW_DURATION"));
  assert.ok(failureCodes(evidence).has("DYNAMIC_FRAME_GAP"));
});

test("scanout regressions and mutable duplicate epochs fail closed", () => {
  const regression = makeTrace();
  const uniqueFrames = regression.events.filter(({ type }) => type === "frame-presented");
  uniqueFrames.at(-1).scanoutEpoch = 1;
  assert.ok(failureCodes(evaluateBrowserPerformanceTrace(regression)).has(
    "SCANOUT_EPOCH_REGRESSION",
  ));

  const mutation = makeTrace();
  const frameEvents = mutation.events.filter(({ type }) => type === "frame-presented");
  const duplicate = frameEvents.find((frame, index) =>
    index > 0 && frame.scanoutEpoch === frameEvents[index - 1].scanoutEpoch);
  duplicate.contentDigest = sha256("mutated-duplicate");
  assert.ok(failureCodes(evaluateBrowserPerformanceTrace(mutation)).has(
    "DUPLICATE_EPOCH_MUTATION",
  ));
});

test("targets may be strengthened but never weakened below 24 unique FPS", () => {
  assert.throws(
    () => resolvePerformanceTargets({ minimumUniqueFps: 23.99 }),
    /cannot be lower than 24/,
  );
  assert.throws(
    () => resolvePerformanceTargets({ inventedTarget: 1 }),
    /Unknown performance target/,
  );
  const evidence = evaluateBrowserPerformanceTrace(makeTrace(), {
    minimumUniqueFps: 30,
  });
  assert.ok(failureCodes(evidence).has("UNIQUE_FPS"));
});

test("CLI preserves raw timestamps and exits nonzero for a failed trace", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "omarchy-browser-performance-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const tracePath = join(directory, "trace.json");
  const identityPath = join(directory, "identity.json");
  const trace = makeTrace({ fps: 12, duplicateCopies: 4 });
  await writeFile(tracePath, `${JSON.stringify(trace)}\n`);
  await writeFile(identityPath, `${JSON.stringify(trace.identity)}\n`);
  const cli = new URL("evaluate.mjs", import.meta.url).pathname;
  const result = spawnSync(process.execPath, [cli, tracePath, identityPath], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.verdict, "FAIL");
  assert.deepEqual(evidence.identity, trace.identity);
  assert.deepEqual(
    evidence.rawTrace.events.map(({ timestampMs }) => timestampMs),
    trace.events.map(({ timestampMs }) => timestampMs),
  );
  assert.equal(evidence.metrics.uniqueGuestFps, 12);
  assert.equal((await readFile(tracePath, "utf8")).trim(), JSON.stringify(trace));
});
