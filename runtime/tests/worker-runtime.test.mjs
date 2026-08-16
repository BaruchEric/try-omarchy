import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  EXPECTED_UPSTREAM,
  normalizeRuntimeDesktopProof,
  normalizeRuntimeGuestFrame,
  normalizeRuntimeInputAccepted,
  validateRuntimeRelease,
} from "../../public/vm/host-utils.mjs";
import {
  KEY_CODE_TO_SDL_SCANCODE,
  WorkerInputError,
  dispatchSanitizedWorkerInput,
  dispatchSanitizedWorkerInputWithReceipt,
  dispatchWorkerInput,
  sanitizeWorkerInput,
} from "../web/worker-input.mjs";
import {
  CheckpointDesktopSettleGate,
  DesktopProofProtocol,
  ProductionWorkerError,
  CANONICAL_CHECKPOINT_ARGUMENTS,
  CANONICAL_CHECKPOINT_IDENTITY,
  CANONICAL_ARM64_PRODUCTION_MANIFEST,
  CANONICAL_PAGED_DISK_ARGUMENTS,
  CANONICAL_PRODUCTION_MANIFEST,
  OmarchyProductionWorkerHost,
  assertBootstrapArtifactsWithinLimit,
  assertGuestReportProvenance,
  authenticateRuntimeGuestReport,
  checkpointArgumentsForManifest,
  checkpointCachePlan,
  createMountPreRun,
  createCheckpointVmstateRangeLedger,
  createDesktopProofChallenge,
  desktopProofCommand,
  desktopProofTextInputEvents,
  nextPublicNativeGuestFrame,
  normalizeNativeGuestFrame,
  normalizedJsonBytes,
  prepareVerifiedExecutables,
  parseDesktopProofAcknowledgementLine,
  parseGuestReportLine,
  parseGuestStageLine,
  qemuGeneratedAssetNames,
  qemuStartupFailureForLine,
  readBoundedResponseBody,
  releaseIdentityFromArtifactManifest,
  serializeError,
  validateGuestStage,
  validateArtifactManifest,
  validateCheckpointArtifacts,
  validateCheckpointGuestManifestDocument,
  validateCheckpointProducerDocument,
  validateCheckpointProfile,
  validateCheckpointSourceEvidence,
  validateCheckpointSourceEvidenceShape,
  validatePagedDiskArguments,
  validateProductionManifest,
  waitForQemuRunning,
} from "../web/production-worker.mjs";

const manifestUrl = new URL("../config/demo.json", import.meta.url);
const arm64ManifestUrl = new URL("../config/arm64-browser.json", import.meta.url);

function checkpointProfile() {
  return {
    schemaVersion: 1,
    mode: "preboot-resume",
    vmstate: {
      artifactPath: "omarchy-preboot.vmstate",
      mountPath: "/pack/omarchy-preboot.vmstate",
      bytes: 380_000_000,
      sha256: "1".repeat(64),
      format: "qemu-8.2-migration",
      compression: "none",
      incomingMode: "file",
    },
    bootDelta: {
      artifactPath: "checkpoint-overlay.qcow2",
      mountPath: "/pack/checkpoint-overlay.qcow2",
      bytes: 24_000_000,
      sha256: "2".repeat(64),
      format: "qcow2",
      backingFilename: "rootfs.ext4",
      backingFormat: "raw",
    },
    producer: {
      manifestArtifactPath: "checkpoint-manifest.json",
      manifestBytes: 2048,
      manifestSha256: "3".repeat(64),
      qemuBinarySha256: "4".repeat(64),
    },
    identity: structuredClone(CANONICAL_CHECKPOINT_IDENTITY),
  };
}

function checkpointManifest() {
  return { ...structuredClone(CANONICAL_PRODUCTION_MANIFEST), checkpoint: checkpointProfile() };
}

function checkpointSourceGuestReport() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-15T09:00:00.000Z",
    provenance: { ...EXPECTED_UPSTREAM },
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
      { name: "Hyprland", pid: 436, executable: "/usr/bin/Hyprland", command: "Hyprland" },
      { name: "quickshell", pid: 481, executable: "/usr/bin/quickshell", command: "quickshell" },
    ],
    commands: [
      { argv: ["uname", "-m"], exitCode: 0, stdout: "x86_64\n", stderr: "" },
      { argv: ["hyprctl", "version"], exitCode: 0, stdout: "Hyprland 0.56.2\n", stderr: "" },
      {
        argv: ["hyprctl", "monitors", "-j"],
        exitCode: 0,
        stdout: JSON.stringify([{ width: 1600, height: 900, disabled: false }]),
        stderr: "",
      },
      { argv: ["omarchy-version"], exitCode: 0, stdout: "4.0.0.alpha-1\n", stderr: "" },
    ],
    configs: [{
      path: "/usr/share/omarchy/shell/shell.qml",
      sha256: "a".repeat(64),
      origin: "omarchy-upstream",
    }],
  };
}

function checkpointProducerDocument(checkpoint) {
  const guestReport = checkpointSourceGuestReport();
  return {
    schemaVersion: 1,
    kind: "omarchy-web-preboot-checkpoint",
    vmstate: {
      path: checkpoint.vmstate.artifactPath,
      bytes: checkpoint.vmstate.bytes,
      sha256: checkpoint.vmstate.sha256,
      format: checkpoint.vmstate.format,
      compression: checkpoint.vmstate.compression,
      incomingMode: checkpoint.vmstate.incomingMode,
    },
    bootDelta: {
      path: checkpoint.bootDelta.artifactPath,
      bytes: checkpoint.bootDelta.bytes,
      sha256: checkpoint.bootDelta.sha256,
      format: checkpoint.bootDelta.format,
      backingFilename: checkpoint.bootDelta.backingFilename,
      backingFormat: checkpoint.bootDelta.backingFormat,
    },
    producer: { qemuBinarySha256: checkpoint.producer.qemuBinarySha256 },
    identity: {
      baseGuestManifestSha256: checkpoint.identity.baseGuestManifestSha256,
      rootfsSha256: checkpoint.identity.rootfsSha256,
      guestProvenanceSha256: checkpoint.identity.guestProvenanceSha256,
    },
    qemu: { ...checkpoint.identity.qemu },
    machine: { ...checkpoint.identity.machine },
    restoreContract: {
      sourceRunstate: "running",
      immediateIncomingAutoRuns: true,
      qmpContRequired: false,
      disposableWrites: "target -snapshot layer over immutable boot delta",
    },
    sourceEvidence: {
      guestReport,
      normalizedGuestReportSha256: createHash("sha256").update(normalizedJsonBytes(guestReport)).digest("hex"),
      reportValidationSha256: "5".repeat(64),
      checkpointFrameSha256: "6".repeat(64),
      checkpointFrameHealthSha256: "7".repeat(64),
    },
  };
}

function nextTask() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createProofHarness({
  stageTimeoutMs = 1_000,
  responseTimeoutMs = stageTimeoutMs,
  digest = (...arguments_) => globalThis.crypto.subtle.digest(...arguments_),
  onDispatch = () => {},
} = {}) {
  const messages = [];
  const failures = [];
  const inputEvents = [];
  let completed = 0;
  let modifierReleases = 0;
  const instance = {
    _omarchy_desktop_proof_arm: () => 0,
    _omarchy_desktop_proof_expect_response: () => 0,
    _omarchy_input_release_modifiers: () => { modifierReleases += 1; return 0; },
  };
  let protocol;
  const scope = {
    crypto: {
      subtle: { digest },
      getRandomValues(bytes) {
        bytes.fill(0xab);
        return bytes;
      },
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  protocol = new DesktopProofProtocol({
    scope,
    post: (type, detail) => messages.push({ type, ...detail }),
    onFailure: (error) => failures.push(error),
    getInstance: () => instance,
    getArtifactManifestSha256: () => "c".repeat(64),
    dispatchInput: (_instance, event) => {
      inputEvents.push(event);
      onDispatch(protocol, event);
      return event;
    },
    onComplete: () => { completed += 1; },
    stageTimeoutMs,
    responseTimeoutMs,
    inputPacingMs: 0,
  });
  return {
    protocol,
    messages,
    failures,
    inputEvents,
    get completed() { return completed; },
    get modifierReleases() { return modifierReleases; },
  };
}

test("boot scanouts do not consume a public guest-frame sequence", () => {
  const bootFrame = nextPublicNativeGuestFrame(0, {
    guestWidth: 640,
    guestHeight: 480,
    sampledPixels: 192,
    nonBlackPixels: 120,
    proofFrame: 0,
    changedPixels: 0,
    dominantPixels: 0,
  });
  assert.equal(bootFrame, null, "firmware scanout must stay private to the QEMU runtime");

  const desktopFrame = nextPublicNativeGuestFrame(0, {
    guestWidth: 1600,
    guestHeight: 900,
    sampledPixels: 576,
    nonBlackPixels: 211,
    proofFrame: 0,
    changedPixels: 0,
    dominantPixels: 0,
  });
  assert.deepEqual(desktopFrame, {
    sequence: 1,
    guestWidth: 1600,
    guestHeight: 900,
    sampledPixels: 576,
    nonBlackPixels: 211,
    proofFrame: 0,
    changedPixels: 0,
    dominantPixels: 0,
  });
});

async function progressProofToAcknowledgement(harness) {
  assert.equal(harness.protocol.beginAfterAuthenticatedReport(), true);
  const baseline = normalizeNativeGuestFrame({
    guestWidth: 1600,
    guestHeight: 900,
    sampledPixels: 576,
    nonBlackPixels: 0,
    proofFrame: 1,
    changedPixels: 0,
    dominantPixels: 0,
  });
  harness.protocol.handleFrame({ sequence: 10, ...baseline });
  await nextTask();
  assert.equal(harness.protocol.state, "awaiting-response");
  const response = normalizeNativeGuestFrame({
    guestWidth: 1600,
    guestHeight: 900,
    sampledPixels: 576,
    nonBlackPixels: 211,
    proofFrame: 2,
    changedPixels: 29,
    dominantPixels: 547,
  });
  harness.protocol.handleFrame({ sequence: 12, ...response });
  await nextTask();
  assert.equal(harness.protocol.state, "awaiting-ack");
}

test("worker input maps physical keyboard codes to USB/SDL scancodes", () => {
  assert.equal(KEY_CODE_TO_SDL_SCANCODE.KeyA, 4);
  assert.equal(KEY_CODE_TO_SDL_SCANCODE.Enter, 40);
  assert.equal(KEY_CODE_TO_SDL_SCANCODE.ControlRight, 228);
  assert.deepEqual(sanitizeWorkerInput({ kind: "key", code: "KeyA", down: true }), {
    kind: "key", scancode: 4, down: true,
  });
  assert.throws(
    () => sanitizeWorkerInput({ kind: "key", code: "Unidentified", down: true }),
    WorkerInputError,
  );
});

test("worker input bounds pointer and wheel values before calling Wasm", () => {
  assert.deepEqual(sanitizeWorkerInput({ kind: "pointer", x: 0.5, y: 1, buttons: 6 }), {
    kind: "pointer", x: 16384, y: 32767, buttons: 6,
  });
  assert.deepEqual(sanitizeWorkerInput({ kind: "wheel", deltaX: 20, deltaY: -4 }), {
    kind: "wheel", x: -1, y: 1,
  });
  assert.throws(() => sanitizeWorkerInput({ kind: "pointer", x: -0.1, y: 0, buttons: 0 }), WorkerInputError);
  assert.throws(() => sanitizeWorkerInput({ kind: "wheel", deltaX: 0, deltaY: 0 }), WorkerInputError);

  const calls = [];
  const instance = {
    _omarchy_input_key: (...args) => { calls.push(["key", ...args]); return 0; },
    _omarchy_input_pointer: (...args) => { calls.push(["pointer", ...args]); return 0; },
    _omarchy_input_wheel: (...args) => { calls.push(["wheel", ...args]); return 0; },
  };
  dispatchWorkerInput(instance, { kind: "key", code: "Escape", down: false });
  dispatchWorkerInput(instance, { kind: "pointer", x: 0, y: 1, buttons: 3 });
  dispatchWorkerInput(instance, { kind: "wheel", deltaX: 0, deltaY: 1 });
  dispatchSanitizedWorkerInput(instance, { kind: "key", scancode: 40, down: true });
  assert.deepEqual(calls, [
    ["key", 41, 0, 0],
    ["pointer", 0, 32767, 5, 0],
    ["wheel", 0, -1, 0],
    ["key", 40, 1, 0],
  ]);
});

test("trusted performance receipts reach only the private native input argument", () => {
  const calls = [];
  const instance = {
    _omarchy_input_key(...arguments_) {
      calls.push(arguments_);
      return 0;
    },
  };
  const event = Object.freeze({ kind: "key", scancode: 40, down: true });

  dispatchSanitizedWorkerInput(instance, event);
  dispatchSanitizedWorkerInputWithReceipt(instance, event, 27);

  assert.deepEqual(calls, [[40, 1, 0], [40, 1, 27]]);
  assert.throws(
    () => dispatchSanitizedWorkerInputWithReceipt(instance, event, -1),
    WorkerInputError,
  );
  assert.throws(
    () => dispatchSanitizedWorkerInputWithReceipt(instance, event, 0x80000000),
    WorkerInputError,
  );
});

test("checkpoint proof waits for the QEMU-thread running latch", async () => {
  let now = 0;
  const statuses = [0, 0, 1];
  const instance = {
    _omarchy_runtime_is_running: () => statuses.shift() ?? 1,
  };
  const scope = {
    performance: { now: () => now },
    setTimeout(callback, milliseconds) {
      now += milliseconds;
      queueMicrotask(callback);
    },
  };
  assert.deepEqual(
    await waitForQemuRunning(instance, { scope, timeoutMs: 100, pollMs: 25 }),
    { checks: 3, elapsedMs: 50 },
  );

  await assert.rejects(
    waitForQemuRunning({ _omarchy_runtime_is_running: () => 0 }, {
      scope,
      timeoutMs: 50,
      pollMs: 25,
    }),
    (error) => error instanceof ProductionWorkerError && error.code === "QEMU_RUNNING_TIMEOUT",
  );
  await assert.rejects(
    waitForQemuRunning({}, { scope, timeoutMs: 50, pollMs: 25 }),
    (error) => error instanceof ProductionWorkerError && error.code === "QEMU_RUNSTATE_BRIDGE_MISSING",
  );
});

test("checkpoint proof waits for two settled desktop frames after the running latch", () => {
  let now = 1_000;
  let timerCallback = null;
  let clearedTimer = null;
  let nextTimer = 0;
  const progress = [];
  const failures = [];
  const ready = [];
  const scope = {
    performance: { now: () => now },
    setTimeout(callback) {
      timerCallback = callback;
      nextTimer += 1;
      return nextTimer;
    },
    clearTimeout(timer) { clearedTimer = timer; },
  };
  const gate = new CheckpointDesktopSettleGate({
    scope,
    onReady: (evidence) => ready.push(evidence),
    onFailure: (error) => failures.push(error),
    onProgress: (event) => progress.push(event),
  });
  const frame = (sequence, nonBlackPixels = 211) => ({
    sequence,
    guestWidth: 1600,
    guestHeight: 900,
    sampledPixels: 576,
    nonBlackPixels,
    proofFrame: 0,
    changedPixels: 0,
    dominantPixels: 0,
  });

  assert.equal(gate.beginAfterRunning(), true);
  assert.equal(gate.blocksHostInput, true);
  now = 1_001;
  assert.equal(gate.handleFrame(frame(1)), false, "the first healthy frame cannot arm proof");
  now = 6_000;
  assert.equal(gate.handleFrame(frame(2)), false, "a second frame inside the 5s gap cannot arm proof");
  now = 6_001;
  assert.equal(gate.handleFrame(frame(3, 0)), false, "a black frame cannot satisfy settling");
  now = 15_999;
  assert.equal(gate.handleFrame(frame(4)), false, "a separated frame before 15s cannot arm proof");
  assert.equal(ready.length, 0, "proof must remain unarmed before the full settle bound");
  now = 16_000;
  assert.equal(gate.handleFrame(frame(5)), true, "the second separated frame arms proof");
  assert.equal(gate.state, "ready");
  assert.equal(gate.blocksHostInput, false);
  assert.equal(clearedTimer, 1);
  assert.deepEqual(ready, [{
    firstFrameSequence: 1,
    secondFrameSequence: 5,
    runningElapsedMs: 15_000,
    frameGapMs: 14_999,
  }]);
  assert.deepEqual(progress.map(({ stage }) => stage), ["start", "first-frame", "ready"]);
  assert.deepEqual(failures, []);
  timerCallback();
  assert.deepEqual(failures, [], "a cleared timeout cannot fail a ready gate");
});

test("checkpoint desktop settle timeout fails closed before proof is armed", () => {
  let timerCallback;
  const failures = [];
  let ready = 0;
  const gate = new CheckpointDesktopSettleGate({
    scope: {
      performance: { now: () => 0 },
      setTimeout(callback) { timerCallback = callback; return 1; },
      clearTimeout() {},
    },
    onReady: () => { ready += 1; },
    onFailure: (error) => failures.push(error),
  });
  gate.beginAfterRunning();
  timerCallback();
  assert.equal(gate.state, "failed");
  assert.equal(ready, 0);
  assert.equal(failures[0]?.code, "CHECKPOINT_DESKTOP_SETTLE_TIMEOUT");
});

test("desktop proof challenge and acknowledgement protocol is exact and bounded", async () => {
  const scope = {
    crypto: {
      subtle: globalThis.crypto.subtle,
      getRandomValues(bytes) {
        bytes.fill(0xab);
        return bytes;
      },
    },
  };
  const challenge = createDesktopProofChallenge(scope);
  const acknowledgement = `omarchy-input-ack-${"ab".repeat(16)}`;
  assert.equal(challenge.acknowledgement, acknowledgement);
  assert.equal(
    await challenge.challengeSha256,
    createHash("sha256").update(acknowledgement).digest("hex"),
  );
  assert.equal(
    desktopProofCommand(acknowledgement),
    `echo ${acknowledgement} > /dev/virtio-ports/omarchy.web.diagnostics`,
  );
  assert.equal(parseDesktopProofAcknowledgementLine(`${acknowledgement}\r\n`), acknowledgement);
  assert.equal(parseDesktopProofAcknowledgementLine("ordinary serial output"), null);
  assert.throws(
    () => parseDesktopProofAcknowledgementLine(`prompt: ${acknowledgement}`),
    /unique complete line payload/,
  );
  assert.throws(
    () => parseDesktopProofAcknowledgementLine("omarchy-input-ack-ABCDEF"),
    /invalid challenge token/,
  );
  assert.throws(
    () => parseDesktopProofAcknowledgementLine(`${acknowledgement}\r\n\n`),
    /more than one line/,
  );
  assert.throws(
    () => parseDesktopProofAcknowledgementLine(`omarchy-input-ack-${"a".repeat(32)}${"x".repeat(32)}`),
    /bounded line size/,
  );

  const events = desktopProofTextInputEvents("a0-./ >");
  assert.deepEqual(events.slice(-4), [
    { kind: "key", scancode: 225, down: true },
    { kind: "key", scancode: 55, down: true },
    { kind: "key", scancode: 55, down: false },
    { kind: "key", scancode: 225, down: false },
  ]);
  assert.throws(() => desktopProofTextInputEvents("echo $HOME"), /unsupported key/);
});

test("desktop proof emits only after a causal frame delta and exact guest acknowledgement", async () => {
  const harness = createProofHarness();
  await progressProofToAcknowledgement(harness);
  assert.deepEqual(harness.inputEvents.slice(0, 4), [
    { kind: "key", scancode: 227, down: true },
    { kind: "key", scancode: 40, down: true },
    { kind: "key", scancode: 40, down: false },
    { kind: "key", scancode: 227, down: false },
  ]);
  assert.equal(harness.modifierReleases, 1);
  assert.equal(harness.messages.length, 0, "visual change alone must not authenticate the desktop");

  const acknowledgement = `omarchy-input-ack-${"ab".repeat(16)}`;
  assert.equal(harness.protocol.handleSerialLine(`${acknowledgement}\r\n`), true);
  await nextTask();
  assert.equal(harness.protocol.state, "awaiting-post-proof-frame");
  assert.equal(harness.completed, 0, "host input remains deferred until a later real presentation");
  harness.protocol.handleFrame({
    sequence: 13,
    ...normalizeNativeGuestFrame({
      guestWidth: 1600,
      guestHeight: 900,
      sampledPixels: 576,
      nonBlackPixels: 211,
      proofFrame: 0,
      changedPixels: 0,
      dominantPixels: 0,
    }),
  });
  assert.equal(harness.protocol.state, "complete");
  assert.equal(harness.completed, 1);
  assert.deepEqual(harness.inputEvents.slice(-4), [
    { kind: "key", scancode: 44, down: true },
    { kind: "key", scancode: 44, down: false },
    { kind: "key", scancode: 42, down: true },
    { kind: "key", scancode: 42, down: false },
  ]);
  assert.deepEqual(harness.failures, []);
  assert.deepEqual(harness.messages, [{
    type: "desktopproof",
    proof: {
      schemaVersion: 1,
      artifactManifestSha256: "c".repeat(64),
      challengeSha256: createHash("sha256").update(acknowledgement).digest("hex"),
      baselineSequence: 10,
      responseSequence: 12,
      sampledPixels: 576,
      changedPixels: 29,
      dominantPixels: 547,
    },
  }]);
  assert.doesNotMatch(JSON.stringify(harness.messages), /omarchy-input-ack-/);
});

test("desktop proof acknowledgement secret is consumed before public serial forwarding", async () => {
  const source = await readFile(new URL("../web/production-worker.mjs", import.meta.url), "utf8");
  assert.match(source, /const DESKTOP_PROOF_INPUT_PACING_MS = 40;/,
    "the browser chord must meet or exceed the paced native QMP transition interval");
  assert.match(source, /const DESKTOP_PROOF_STAGE_TIMEOUT_MS = 90_000;/,
    "the fail-closed timeout must cover the measured 66.4s slow-TCG terminal launch");
  assert.match(source, /const DESKTOP_PROOF_RESPONSE_TIMEOUT_MS = 180_000;/,
    "the response-only bound must cover browser slow-TCG after a settled resume");
  assert.match(source, /const CHECKPOINT_DESKTOP_SETTLE_MIN_RUNNING_MS = 15_000;/);
  assert.match(source, /const CHECKPOINT_DESKTOP_SETTLE_MIN_FRAME_GAP_MS = 5_000;/);
  const parser = source.indexOf("if (this.#desktopProof.handleSerialLine(line)) return");
  const forwardingCall = source.indexOf("processSerial(stream, line)", parser);
  const forwardingImplementation = source.indexOf('this.#post("serial", { stream, line })');
  assert.ok(parser >= 0 && forwardingCall > parser && forwardingImplementation >= 0);
  assert.match(
    source.slice(parser, forwardingCall),
    /if \(this\.#desktopProof\.handleSerialLine\(line\)\) return/,
  );
  const publicFrame = source.indexOf('this.#post("guestframe"');
  const proofFrame = source.indexOf("this.#desktopProof.handleFrame", publicFrame);
  assert.ok(publicFrame >= 0 && proofFrame > publicFrame,
    "the response guestframe must be public before desktop proof consumes its sequence");
});

test("desktop proof accepts a reentrant acknowledgement on Enter-down and still releases Enter", async () => {
  const acknowledgement = `omarchy-input-ack-${"ab".repeat(16)}`;
  let acknowledgementInjected = false;
  const harness = createProofHarness({
    onDispatch(protocol, event) {
      if (!acknowledgementInjected && protocol.state === "awaiting-ack" &&
          event.scancode === 40 && event.down) {
        acknowledgementInjected = true;
        protocol.handleSerialLine(acknowledgement);
      }
    },
  });

  assert.equal(harness.protocol.beginAfterAuthenticatedReport(), true);
  harness.protocol.handleFrame({
    sequence: 10,
    ...normalizeNativeGuestFrame({
      guestWidth: 1600,
      guestHeight: 900,
      sampledPixels: 576,
      nonBlackPixels: 0,
      proofFrame: 1,
      changedPixels: 0,
      dominantPixels: 0,
    }),
  });
  await nextTask();
  harness.protocol.handleFrame({
    sequence: 12,
    ...normalizeNativeGuestFrame({
      guestWidth: 1600,
      guestHeight: 900,
      sampledPixels: 576,
      nonBlackPixels: 211,
      proofFrame: 2,
      changedPixels: 29,
      dominantPixels: 547,
    }),
  });
  await nextTask();

  assert.equal(acknowledgementInjected, true);
  assert.deepEqual(harness.failures, []);
  assert.equal(harness.messages[0]?.type, "desktopproof");
  const finalEnterDown = harness.inputEvents.findLastIndex(
    (event) => event.scancode === 40 && event.down,
  );
  assert.deepEqual(harness.inputEvents[finalEnterDown + 1], {
    kind: "key", scancode: 40, down: false,
  });
});

test("desktop proof challenge digest verification has a fail-closed timeout", async () => {
  const harness = createProofHarness({
    stageTimeoutMs: 30,
    digest: () => new Promise(() => {}),
  });
  await progressProofToAcknowledgement(harness);
  harness.protocol.handleSerialLine(`omarchy-input-ack-${"ab".repeat(16)}`);
  assert.equal(harness.protocol.state, "verifying-ack");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(harness.protocol.state, "failed");
  assert.equal(harness.failures[0]?.code, "DESKTOP_PROOF_DIGEST_TIMEOUT");
  assert.equal(harness.messages.length, 0);
});

test("the actual uniform-dark QEMU8 failure fixture cannot satisfy desktop proof", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("fixtures/qemu8-uniform-dark-frame.json", import.meta.url),
    "utf8",
  ));
  assert.equal(fixture.fullFrameDominantFraction, 0.99986);
  assert.match(fixture.description, /no Foot window/);
  const actualBadFrame = {
    guestWidth: fixture.guestWidth,
    guestHeight: fixture.guestHeight,
    sampledPixels: fixture.sampledPixels,
    nonBlackPixels: fixture.nonBlackPixels,
    proofFrame: fixture.proofFrame,
    changedPixels: fixture.changedPixels,
    dominantPixels: fixture.dominantPixels,
  };
  assert.throws(
    () => normalizeNativeGuestFrame(actualBadFrame),
    (error) => error instanceof ProductionWorkerError &&
      error.code === "INVALID_DESKTOP_PROOF_FRAME",
  );
  assert.throws(
    () => normalizeNativeGuestFrame({
      ...actualBadFrame,
      changedPixels: 29,
      dominantPixels: 0,
    }),
    (error) => error instanceof ProductionWorkerError &&
      error.code === "INVALID_DESKTOP_PROOF_FRAME",
    "a response histogram cannot have zero dominant pixels",
  );

  const harness = createProofHarness({ stageTimeoutMs: 30 });
  assert.equal(harness.protocol.beginAfterAuthenticatedReport(), true);
  harness.protocol.handleFrame({
    sequence: 1,
    ...normalizeNativeGuestFrame({
      guestWidth: 1600,
      guestHeight: 900,
      sampledPixels: 576,
      nonBlackPixels: 0,
      proofFrame: 1,
      changedPixels: 0,
      dominantPixels: 0,
    }),
  });
  await nextTask();
  harness.protocol.handleFrame({
    sequence: 2,
    ...normalizeNativeGuestFrame({
      guestWidth: 1600,
      guestHeight: 900,
      sampledPixels: 576,
      nonBlackPixels: 576,
      proofFrame: 0,
      changedPixels: 0,
      dominantPixels: 576,
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(harness.protocol.state, "failed");
  assert.equal(harness.messages.length, 0);
  assert.equal(harness.failures[0]?.code, "DESKTOP_PROOF_RESPONSE_TIMEOUT");
});

test("desktop proof rejects pre-report, wrong, duplicate, and malformed acknowledgements", async () => {
  const acknowledgement = `omarchy-input-ack-${"ab".repeat(16)}`;
  const preReport = createProofHarness();
  preReport.protocol.handleSerialLine(acknowledgement);
  assert.equal(preReport.failures[0]?.code, "DESKTOP_PROOF_ACK_BEFORE_REPORT");

  const malformed = createProofHarness();
  malformed.protocol.handleSerialLine("omarchy-input-ack-not-hex");
  assert.equal(malformed.failures[0]?.code, "DESKTOP_PROOF_ACK_MALFORMED");

  const wrong = createProofHarness();
  await progressProofToAcknowledgement(wrong);
  wrong.protocol.handleSerialLine(`omarchy-input-ack-${"cd".repeat(16)}`);
  assert.equal(wrong.failures[0]?.code, "DESKTOP_PROOF_ACK_MISMATCH");
  assert.equal(wrong.messages.length, 0);

  const replay = createProofHarness();
  await progressProofToAcknowledgement(replay);
  replay.protocol.handleSerialLine(acknowledgement);
  await nextTask();
  replay.protocol.handleSerialLine(acknowledgement);
  assert.equal(replay.failures[0]?.code, "DESKTOP_PROOF_ACK_REPLAY");
});

test("desktop proof fails closed without a real post-proof QEMU presentation", async () => {
  const harness = createProofHarness({ stageTimeoutMs: 30 });
  await progressProofToAcknowledgement(harness);
  harness.protocol.handleSerialLine(`omarchy-input-ack-${"ab".repeat(16)}`);
  await nextTask();
  assert.equal(harness.messages[0]?.type, "desktopproof");
  assert.equal(harness.protocol.state, "awaiting-post-proof-frame");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(harness.protocol.state, "failed");
  assert.equal(harness.failures[0]?.code, "DESKTOP_PROOF_LIVENESS_TIMEOUT");
  assert.equal(harness.completed, 0);
});

test("production manifest is paged-worker-only and declares bounded assets", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  const workerSource = await readFile(new URL("../web/production-worker.mjs", import.meta.url), "utf8");
  assert.equal(validateProductionManifest(manifest), manifest);
  assert.deepEqual(CANONICAL_PRODUCTION_MANIFEST, manifest);
  assert.equal(manifest.assets.preload, undefined);
  assert.equal(manifest.assets.data, undefined);
  assert.deepEqual(manifest.qemu.arguments.slice(0, 2), ["-machine", "pc-q35-8.2"]);
  assert.equal(manifest.qemu.memoryMiB, 1024);
  assert.equal(manifest.qemu.arguments[manifest.qemu.arguments.indexOf("-m") + 1], "1024M");
  assert.equal(
    manifest.qemu.arguments[manifest.qemu.arguments.indexOf("-accel") + 1],
    "tcg,tb-size=128,thread=multi",
  );
  assert.equal(manifest.qemu.cores, 2);
  assert.equal(
    manifest.qemu.arguments[manifest.qemu.arguments.indexOf("-smp") + 1],
    "2,sockets=1,cores=2,threads=1",
  );
  assert.ok(manifest.qemu.arguments.includes("virtio-vga,max_outputs=1,xres=1600,yres=900"));
  assert.ok(manifest.qemu.arguments.includes(
    "virtserialport,chardev=omarchy-diag,name=omarchy.web.diagnostics",
  ));
  assert.equal(manifest.qemu.arguments[manifest.qemu.arguments.indexOf("-parallel") + 1], "none");
  assert.deepEqual(Object.keys(manifest.assets.firmware).sort(), [
    "bios-256k.bin", "kvmvapic.bin", "linuxboot_dma.bin", "vgabios-virtio.bin",
  ]);
  assert.match(workerSource, /MAX_INITRAMFS_BYTES = 512 \* 1024 \* 1024/);
  assert.doesNotMatch(workerSource, /MAX_INITRAMFS_BYTES = 768/);
  assert.equal(manifest.assets.boundedOverlay, "bounded-overlay.mjs");
  assert.match(workerSource, /disk\.overlayPreRun/);
  assert.match(workerSource, /OVERLAY_QUOTA_EXCEEDED/);

  const hostileProfiles = [
    ["appended override", (value) => value.qemu.arguments.push("-m", "2048M")],
    ["duplicate flag", (value) => value.qemu.arguments.push("-no-reboot")],
    ["machine alias", (value) => { value.qemu.arguments[1] = "q35"; }],
    ["memory metadata", (value) => { value.qemu.memoryMiB = 1536; }],
    ["vCPU metadata", (value) => { value.qemu.cores = 1; }],
    ["single-thread TCG", (value) => { value.qemu.arguments[5] = "tcg,tb-size=128,thread=single"; }],
    ["single-vCPU topology", (value) => {
      value.qemu.arguments[value.qemu.arguments.indexOf("-smp") + 1] =
        "1,sockets=1,cores=1,threads=1";
    }],
    ["network", (value) => { value.qemu.arguments[value.qemu.arguments.indexOf("-nic") + 1] = "user"; }],
    ["display", (value) => { value.display.width = 1280; }],
    ["kernel command line", (value) => {
      value.qemu.arguments[value.qemu.arguments.indexOf("-append") + 1] += " init=/bin/sh";
    }],
    ["guest storage", (value) => { value.guest.rootfs.mountPath = "/pack/other.ext4"; }],
    ["extra profile key", (value) => { value.debug = true; }],
  ];
  for (const [label, mutate] of hostileProfiles) {
    const hostile = structuredClone(manifest);
    mutate(hostile);
    assert.throws(
      () => validateProductionManifest(hostile),
      (error) => error instanceof ProductionWorkerError && error.code === "INVALID_RUNTIME_MANIFEST",
      label,
    );
  }
  assert.equal(validatePagedDiskArguments([...CANONICAL_PAGED_DISK_ARGUMENTS]).length, 3);
  assert.throws(
    () => validatePagedDiskArguments([...CANONICAL_PAGED_DISK_ARGUMENTS, "-drive", "file=evil"]),
    (error) => error instanceof ProductionWorkerError && error.code === "INVALID_PAGED_DISK_PROFILE",
  );
});

test("ARM64 browser manifest is exact, isolated, and cannot be mixed with x86 assets", async () => {
  const manifest = JSON.parse(await readFile(arm64ManifestUrl, "utf8"));
  assert.equal(validateProductionManifest(manifest), manifest);
  assert.deepEqual(CANONICAL_ARM64_PRODUCTION_MANIFEST, manifest);
  assert.deepEqual(qemuGeneratedAssetNames(manifest), {
    architecture: "aarch64",
    wasm: "qemu-system-aarch64.wasm",
    pthread: "qemu-system-aarch64.worker.js",
  });
  assert.deepEqual(manifest.qemu.arguments.slice(0, 4), [
    "-machine", "virt,gic-version=3", "-cpu", "cortex-a72",
  ]);
  assert.equal(manifest.qemu.cores, 4);
  assert.equal(manifest.qemu.arguments[manifest.qemu.arguments.indexOf("-smp") + 1],
    "4,sockets=1,cores=4,threads=1");

  const mixed = structuredClone(manifest);
  mixed.assets.locate = {
    "qemu-system-x86_64.wasm": "qemu.wasm",
    "qemu-system-x86_64.worker.js": "qemu.worker.js",
  };
  assert.throws(
    () => validateProductionManifest(mixed),
    (error) => error instanceof ProductionWorkerError && error.code === "INVALID_RUNTIME_MANIFEST",
  );

  const unprovenCheckpoint = { ...structuredClone(manifest), checkpoint: checkpointProfile() };
  assert.throws(
    () => validateProductionManifest(unprovenCheckpoint),
    (error) => error instanceof ProductionWorkerError && error.code === "INVALID_RUNTIME_MANIFEST",
  );
});

test("checkpoint profile replaces the cold drive and is bound to exact immutable artifacts", async () => {
  const manifest = checkpointManifest();
  assert.equal(validateProductionManifest(manifest), manifest);
  assert.equal(validateCheckpointProfile(manifest.checkpoint), manifest.checkpoint);
  const producerDocument = checkpointProducerDocument(manifest.checkpoint);
  assert.equal(
    validateCheckpointProducerDocument(producerDocument, manifest.checkpoint),
    producerDocument,
  );
  assert.equal(
    validateCheckpointSourceEvidenceShape(producerDocument.sourceEvidence),
    producerDocument.sourceEvidence,
  );
  assert.equal(
    await validateCheckpointSourceEvidence(
      producerDocument.sourceEvidence,
      EXPECTED_UPSTREAM,
      globalThis,
    ),
    producerDocument.sourceEvidence,
  );
  await assert.rejects(
    validateCheckpointSourceEvidence({
      ...producerDocument.sourceEvidence,
      normalizedGuestReportSha256: "f".repeat(64),
    }, EXPECTED_UPSTREAM, globalThis),
    (error) => error instanceof ProductionWorkerError &&
      error.code === "CHECKPOINT_SOURCE_EVIDENCE_INVALID",
  );
  assert.throws(
    () => authenticateRuntimeGuestReport(producerDocument.sourceEvidence.guestReport, {
      checkpoint: true,
      alreadySeen: true,
      expectedUpstream: EXPECTED_UPSTREAM,
    }),
    (error) => error instanceof ProductionWorkerError && error.code === "CHECKPOINT_REPORT_REPLAY",
    "a restored serial report must not duplicate the authenticated checkpoint source evidence",
  );
  assert.throws(
    () => validateCheckpointProducerDocument({
      ...producerDocument,
      producer: { qemuBinarySha256: "f".repeat(64) },
    }, manifest.checkpoint),
    (error) => error instanceof ProductionWorkerError && error.code === "CHECKPOINT_PROVENANCE_MISMATCH",
  );
  assert.throws(
    () => validateCheckpointProducerDocument({
      ...producerDocument,
      restoreContract: { ...producerDocument.restoreContract, qmpContRequired: true },
    }, manifest.checkpoint),
    (error) => error instanceof ProductionWorkerError && error.code === "CHECKPOINT_PROVENANCE_MISMATCH",
    "a target that requires monitor cont cannot be packaged for the Worker",
  );
  assert.deepEqual(checkpointArgumentsForManifest(manifest), CANONICAL_CHECKPOINT_ARGUMENTS);
  assert.deepEqual(CANONICAL_CHECKPOINT_ARGUMENTS, [
    "-snapshot",
    "-drive",
    "file=/pack/checkpoint-overlay.qcow2,if=virtio,format=qcow2,media=disk,cache=unsafe",
    "-incoming",
    "file:/pack/omarchy-preboot.vmstate",
  ]);
  assert.equal(
    checkpointArgumentsForManifest(manifest).some((value) => value.includes("file=/pack/rootfs.ext4")),
    false,
    "the checkpoint qcow2 must replace, not supplement, the cold rootfs drive",
  );
  const plan = checkpointCachePlan(manifest);
  assert.equal(plan.rootfs.maxCachedBytes + plan.bootDelta.maxCachedBytes + plan.vmstate.maxCachedBytes,
    128 * 1024 * 1024);
  assert.equal(plan.vmstate.chunkBytes, 8 * 1024 * 1024);
  assert.equal(plan.rootfs.maxCachedBytes, 88 * 1024 * 1024);
  assert.equal(plan.bootDelta.maxCachedBytes, 32 * 1024 * 1024);
  assert.equal(plan.vmstate.maxCachedBytes, 8 * 1024 * 1024);

  const artifacts = validateArtifactManifest({
    schemaVersion: 1,
    artifacts: [
      { path: "omarchy-preboot.vmstate", bytes: 380_000_000, sha256: "1".repeat(64) },
      { path: "checkpoint-overlay.qcow2", bytes: 24_000_000, sha256: "2".repeat(64) },
      { path: "checkpoint-manifest.json", bytes: 2048, sha256: "3".repeat(64) },
      {
        path: "guest-manifest.json", bytes: 4096,
        sha256: CANONICAL_CHECKPOINT_IDENTITY.baseGuestManifestSha256,
      },
      {
        path: "rootfs.ext4", bytes: 6_442_450_944,
        sha256: CANONICAL_CHECKPOINT_IDENTITY.rootfsSha256,
      },
      {
        path: "provenance.json", bytes: 1507,
        sha256: CANONICAL_CHECKPOINT_IDENTITY.guestProvenanceSha256,
      },
      {
        path: "qemu.wasm", bytes: 13_077_183,
        sha256: CANONICAL_CHECKPOINT_IDENTITY.browserQemuWasmSha256,
      },
    ],
  });
  const bound = validateCheckpointArtifacts(manifest, artifacts);
  assert.equal(bound.vmstate.path, "omarchy-preboot.vmstate");
  assert.equal(bound.bootDelta.path, "checkpoint-overlay.qcow2");

  const upstream = {
    repository: "https://github.com/basecamp/omarchy",
    commit: "a".repeat(40),
    version: "4.0.0.alpha",
    treeSha256: "b".repeat(64),
  };
  const guestManifest = {
    schemaVersion: 1,
    upstream,
    artifacts: [
      {
        path: "rootfs.ext4", bytes: 6_442_450_944,
        sha256: CANONICAL_CHECKPOINT_IDENTITY.rootfsSha256,
      },
      {
        path: "provenance.json", bytes: 1507,
        sha256: CANONICAL_CHECKPOINT_IDENTITY.guestProvenanceSha256,
      },
    ],
  };
  assert.equal(
    validateCheckpointGuestManifestDocument(guestManifest, manifest.checkpoint, upstream),
    guestManifest,
  );

  const wrongVmstate = new Map(artifacts);
  wrongVmstate.set("omarchy-preboot.vmstate", {
    ...wrongVmstate.get("omarchy-preboot.vmstate"),
    sha256: "9".repeat(64),
  });
  assert.throws(
    () => validateCheckpointArtifacts(manifest, wrongVmstate),
    (error) => error instanceof ProductionWorkerError && error.code === "CHECKPOINT_ARTIFACT_MISMATCH",
  );
});

test("checkpoint profile fails closed on machine, QEMU, backing, size, or provenance drift", () => {
  const mutations = [
    ["machine", (value) => { value.identity.machine.memoryMiB = 1536; }],
    ["source commit", (value) => { value.identity.qemu.sourceCommit = "f".repeat(40); }],
    ["browser Wasm", (value) => { value.identity.browserQemuWasmSha256 = "f".repeat(64); }],
    ["guest manifest", (value) => { value.identity.baseGuestManifestSha256 = "f".repeat(64); }],
    ["rootfs", (value) => { value.identity.rootfsSha256 = "f".repeat(64); }],
    ["backing filename", (value) => { value.bootDelta.backingFilename = "hostile.ext4"; }],
    ["backing format", (value) => { value.bootDelta.backingFormat = "qcow2"; }],
    ["vmstate incoming mode", (value) => { value.vmstate.incomingMode = "defer"; }],
    ["vmstate unbounded size", (value) => { value.vmstate.bytes = Number.MAX_SAFE_INTEGER + 1; }],
    ["extra key", (value) => { value.allowFallback = true; }],
  ];
  for (const [label, mutate] of mutations) {
    const manifest = checkpointManifest();
    mutate(manifest.checkpoint);
    assert.throws(
      () => validateProductionManifest(manifest),
      (error) => error instanceof ProductionWorkerError && error.code === "INVALID_RUNTIME_MANIFEST",
      label,
    );
  }
});

test("checkpoint vmstate ledger permits one bounded forward stream and rejects refetches", () => {
  const ledger = createCheckpointVmstateRangeLedger();
  ledger.record({ range: "bytes=0-8388607", status: 206, responseBytes: 8 * 1024 * 1024 });
  ledger.record({ range: "bytes=8388608-16777215", status: 206, responseBytes: 8 * 1024 * 1024 });
  assert.deepEqual(ledger.snapshot(), {
    rangeRequests: 2,
    requestedBytes: 16 * 1024 * 1024,
    uniqueRanges: 2,
    refetches: 0,
    previousStart: 8 * 1024 * 1024,
    previousEnd: 16 * 1024 * 1024 - 1,
    maxRangeBytes: 8 * 1024 * 1024,
    maxCachedBytes: 8 * 1024 * 1024,
  });
  assert.throws(
    () => ledger.record({ range: "bytes=0-8388607", status: 206, responseBytes: 8 * 1024 * 1024 }),
    (error) => error instanceof ProductionWorkerError && error.code === "CHECKPOINT_VMSTATE_REFETCH",
  );
  assert.throws(
    () => createCheckpointVmstateRangeLedger(16 * 1024 * 1024),
    (error) => error instanceof ProductionWorkerError && error.code === "INVALID_CHECKPOINT_RANGE_BOUND",
  );
});

test("artifact manifest validation rejects unsafe, duplicate, or mutable records", () => {
  const artifact = { path: "qemu.wasm", role: "emulator-wasm", bytes: 10, sha256: "a".repeat(64) };
  const byPath = validateArtifactManifest({ schemaVersion: 1, artifacts: [artifact] });
  assert.equal(byPath.get("qemu.wasm").bytes, 10);
  assert.throws(
    () => validateArtifactManifest({ schemaVersion: 1, artifacts: [artifact, artifact] }),
    /Duplicate artifact path/,
  );
  assert.throws(
    () => validateArtifactManifest({ schemaVersion: 1, artifacts: [{ ...artifact, path: "../qemu.wasm" }] }),
    /safe relative path/,
  );
});

test("bounded artifact reads abort streams without Content-Length before exceeding their cap", async () => {
  let readIndex = 0;
  let cancellations = 0;
  let releases = 0;
  const response = {
    body: {
      getReader() {
        return {
          async read() {
            const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
            return readIndex < chunks.length
              ? { done: false, value: chunks[readIndex++] }
              : { done: true, value: undefined };
          },
          async cancel() { cancellations += 1; },
          releaseLock() { releases += 1; },
        };
      },
    },
  };
  await assert.rejects(
    readBoundedResponseBody(response, 3),
    (error) => error instanceof ProductionWorkerError && error.code === "ASSET_TOO_LARGE",
  );
  assert.equal(cancellations, 1);
  assert.equal(releases, 1);

  const exact = await readBoundedResponseBody({
    body: new Blob([new Uint8Array([5, 6, 7])]).stream(),
  }, 3);
  assert.deepEqual([...exact], [5, 6, 7]);
});

test("bootstrap artifacts have one aggregate memory bound", () => {
  assert.equal(assertBootstrapArtifactsWithinLimit([
    { bytes: 32 * 1024 * 1024 },
    { bytes: 64 * 1024 * 1024 },
  ]), 96 * 1024 * 1024);
  assert.throws(
    () => assertBootstrapArtifactsWithinLimit([
      { bytes: 64 * 1024 * 1024 },
      { bytes: 65 * 1024 * 1024 },
    ]),
    (error) => error instanceof ProductionWorkerError && error.code === "BOOTSTRAP_TOO_LARGE",
  );
});

test("verified QEMU executable bytes are consumed through Blob URLs without a network refetch", async () => {
  const authentic = new Map([
    ["qemu.mjs", new TextEncoder().encode("export default () => ({ authentic: true });")],
    ["qemu.wasm", new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])],
    ["qemu.worker.js", new TextEncoder().encode("self.onmessage = () => {};")],
  ]);
  const artifacts = Object.fromEntries([...authentic].map(([path, bytes]) => {
    const key = path === "qemu.mjs" ? "module" : path === "qemu.wasm" ? "wasm" : "pthread";
    return [key, {
      path,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }];
  }));
  const fetchCounts = new Map();
  const blobs = [];
  const scope = {
    Blob,
    crypto: globalThis.crypto,
    URL: {
      createObjectURL(blob) {
        blobs.push(blob);
        return `blob:https://release.invalid/verified-${blobs.length}`;
      },
    },
    async fetch(url) {
      const path = new URL(url).pathname.split("/").at(-1);
      const count = (fetchCounts.get(path) ?? 0) + 1;
      fetchCounts.set(path, count);
      const original = authentic.get(path);
      const bytes = count === 1 ? original : new Uint8Array(original.byteLength).fill(0x78);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": String(bytes.byteLength) }),
        body: new Blob([bytes]).stream(),
      };
    },
  };
  const verified = await prepareVerifiedExecutables(
    artifacts,
    new URL("https://release.invalid/release/"),
    scope,
  );
  assert.deepEqual(Object.fromEntries(fetchCounts), {
    "qemu.mjs": 1,
    "qemu.wasm": 1,
    "qemu.worker.js": 1,
  });
  assert.equal(verified.urls.module.startsWith("blob:"), true);
  assert.equal(verified.urls.locate["qemu-system-x86_64.wasm"].startsWith("blob:"), true);
  assert.equal(verified.urls.locate["qemu-system-x86_64.worker.js"].startsWith("blob:"), true);
  assert.ok(Object.values(verified.urls.locate).every((url) => !url.startsWith("https:")));
  assert.deepEqual(
    [...new Uint8Array(await blobs[0].arrayBuffer())],
    [...authentic.get("qemu.mjs")],
  );

  const source = await readFile(new URL("../web/production-worker.mjs", import.meta.url), "utf8");
  assert.match(source, /import\(executables\.urls\.module\)/);
  assert.match(source, /mainScriptUrlOrBlob: executables\.urls\.module/);
  assert.match(source, /return executables\.urls\.locate\[generatedName\]/);
  assert.doesNotMatch(source, /import\(moduleUrl\)|import\(pagedDiskUrl\)/);
  assert.doesNotMatch(source, /return releaseUrl\(base, locate\[generatedName\]\)/);
});

test("release identity binds guest provenance before evidence is forwarded", () => {
  const upstream = {
    repository: "https://github.com/basecamp/omarchy",
    commit: "a".repeat(40),
    version: "4.0.0.alpha",
    treeSha256: "b".repeat(64),
  };
  assert.deepEqual(
    releaseIdentityFromArtifactManifest({ upstream }),
    upstream,
  );
  const report = { provenance: { ...upstream }, system: { architecture: "x86_64" } };
  assert.equal(assertGuestReportProvenance(report, upstream), report);
  assert.throws(
    () => assertGuestReportProvenance({ provenance: { ...upstream, commit: "c".repeat(40) } }, upstream),
    (error) => error instanceof ProductionWorkerError && error.code === "GUEST_PROVENANCE_MISMATCH",
  );
  assert.throws(
    () => releaseIdentityFromArtifactManifest({ upstream: { ...upstream, repository: "https://evil.invalid" } }),
    (error) => error instanceof ProductionWorkerError && error.code === "INVALID_RELEASE_IDENTITY",
  );
});

test("production Worker outbound evidence matches the committed app protocol", () => {
  const artifactManifestSha256 = "c".repeat(64);
  assert.deepEqual(
    validateRuntimeRelease(
      { type: "release", upstream: EXPECTED_UPSTREAM, artifactManifestSha256 },
      { upstream: EXPECTED_UPSTREAM, artifactManifestSha256 },
    ),
    { upstream: { ...EXPECTED_UPSTREAM }, artifactManifestSha256 },
  );
  assert.deepEqual(normalizeRuntimeGuestFrame({
    type: "guestframe",
    sequence: 42,
    source: "qemu-guest",
    guestWidth: 1600,
    guestHeight: 900,
    timestamp: 12.5,
    sampledPixels: 576,
    nonBlackPixels: 211,
  }), {
    sequence: 42,
    source: "qemu-guest",
    guestWidth: 1600,
    guestHeight: 900,
    sampledPixels: 576,
    nonBlackPixels: 211,
  });
  assert.deepEqual(normalizeRuntimeInputAccepted({
    type: "inputaccepted",
    event: { kind: "pointer", x: 16384, y: 16384, buttons: 0 },
  }), { kind: "pointer", x: 16384, y: 16384, buttons: 0 });
  const proof = {
    schemaVersion: 1,
    artifactManifestSha256,
    challengeSha256: "d".repeat(64),
    baselineSequence: 43,
    responseSequence: 44,
    sampledPixels: 576,
    changedPixels: 29,
    dominantPixels: 547,
  };
  assert.deepEqual(
    normalizeRuntimeDesktopProof({ type: "desktopproof", proof }, artifactManifestSha256),
    proof,
  );
  assert.equal(normalizeRuntimeDesktopProof({
    type: "desktopproof",
    proof: { ...proof, dominantPixels: 576 },
  }, artifactManifestSha256), null, "the actual uniform QEMU8 frame must fail consumer validation");
  assert.equal(normalizeRuntimeDesktopProof({
    type: "desktopproof",
    proof: { ...proof, dominantPixels: 0 },
  }, artifactManifestSha256), null, "a response histogram cannot have zero dominant pixels");
});

test("production worker accepts one prompt-prefixed guest report and rejects ambiguity", () => {
  assert.deepEqual(
    parseGuestReportLine('omarchy-web login: OMARCHY_GUEST_REPORT {"schemaVersion":1}\r\n'),
    { schemaVersion: 1 },
  );
  assert.throws(
    () => parseGuestReportLine(
      'OMARCHY_GUEST_REPORT {"schemaVersion":1} OMARCHY_GUEST_REPORT {"schemaVersion":1}',
    ),
    /more than one evidence marker/,
  );
});

test("guest stage diagnostics are bounded, exact, and strictly monotonic", () => {
  const first = {
    schemaVersion: 1,
    sequence: 1,
    monotonicMs: 10,
    stage: "autologin",
    status: "started",
    attempt: 1,
    message: "tty1 profile entered",
  };
  const parsed = parseGuestStageLine(
    `login prompt: OMARCHY_GUEST_STAGE ${JSON.stringify(first)}\r\n`,
  );
  assert.deepEqual(parsed, first);
  const second = validateGuestStage({
    ...first,
    sequence: 3,
    monotonicMs: 11,
    stage: "uwsm",
    status: "waiting",
    message: "waiting for compositor readiness",
  }, parsed);
  assert.equal(second.sequence, 3, "strictly increasing sequences may contain gaps");
  assert.throws(() => validateGuestStage({ ...second, sequence: 3, monotonicMs: 12 }, second), /sequence/);
  assert.throws(() => validateGuestStage({ ...second, sequence: 4, monotonicMs: 11 }, second), /monotonicMs/);
  assert.throws(() => validateGuestStage({ ...second, sequence: 4, monotonicMs: 12, extra: true }), /exactly/);
  assert.throws(() => validateGuestStage({
    ...second, sequence: 4, monotonicMs: 12, message: "x".repeat(513),
  }), /512 UTF-8 bytes/);
  assert.throws(() => validateGuestStage({
    ...second, sequence: 4, monotonicMs: 12, message: "two\nlines",
  }), /single line/);
  assert.throws(
    () => parseGuestStageLine(
      `OMARCHY_GUEST_STAGE ${JSON.stringify(first)} OMARCHY_GUEST_STAGE ${JSON.stringify(first)}`,
    ),
    /more than one diagnostic marker/,
  );
});

test("production preRun creates QEMU snapshot temporary directories before mounted files", () => {
  const calls = [];
  const existing = new Set();
  const files = [
    { mountPath: "/pack/vmlinuz-linux", bytes: new Uint8Array([1, 2, 3]) },
  ];
  const preRun = createMountPreRun(files);
  preRun({
    FS: {
      mkdirTree(path) {
        calls.push(["mkdirTree", path]);
        existing.add(path);
      },
      analyzePath(path) {
        return { exists: existing.has(path) };
      },
      writeFile(path, bytes, options) {
        calls.push(["writeFile", path, [...bytes], options]);
        existing.add(path);
      },
    },
  });

  assert.deepEqual(calls.slice(0, 3), [
    ["mkdirTree", "/tmp"],
    ["mkdirTree", "/var/tmp"],
    ["mkdirTree", "/pack"],
  ]);
  assert.deepEqual(calls[3], [
    "writeFile", "/pack/vmlinuz-linux", [1, 2, 3], { canOwn: false },
  ]);
  assert.equal(files[0].bytes, null, "the outer Worker must release copied artifact bytes");
});

test("snapshot temporary-file failures are fatal and cannot qualify as a running startup", () => {
  const error = qemuStartupFailureForLine(
    "Could not open temporary file '/var/tmp/vl.NQZST3': No such file or directory",
  );
  assert.equal(error?.code, "QEMU_STARTUP_FAILED");
  assert.match(error?.message, /\/var\/tmp/);
  assert.equal(qemuStartupFailureForLine("OMARCHY_RUNTIME_DIAGNOSTIC main-entered argc=28"), null);
});

test("production Worker error messages preserve a diagnostic stack", () => {
  const error = new Error("worker failed");
  const serialized = serializeError(error);
  assert.equal(serialized.message, "worker failed");
  assert.match(serialized.stack, /worker failed/);
});

test("a terminal Worker failure closes the owning Worker exactly once", () => {
  const messages = [];
  const microtasks = [];
  let closes = 0;
  const host = new OmarchyProductionWorkerHost({
    postMessage(message) { messages.push(message); },
    queueMicrotask(callback) { microtasks.push(callback); },
    close() { closes += 1; },
  });
  host.fail(new ProductionWorkerError("HOSTILE_RUNTIME", "stop now"));
  host.fail(new ProductionWorkerError("SECOND_FAILURE", "must be ignored"));
  assert.equal(host.phase, "failed");
  assert.equal(microtasks.length, 1);
  assert.equal(closes, 0, "the failed phase message must be posted before close");
  microtasks[0]();
  assert.equal(closes, 1);
  assert.deepEqual(messages.map(({ type, phase }) => [type, phase]), [["phase", "failed"]]);
});
