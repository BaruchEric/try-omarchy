import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evaluateBrowserPerformanceTrace } from "../../proofs/browser-performance/gate.mjs";
import { PERFORMANCE_SAMPLE_PIXELS } from "../../proofs/browser-performance/producer.mjs";
import { verifyFullGuestBrowserPerformanceCapture } from "../web/full-guest-evidence.mjs";
import {
  BrowserPerformanceRuntimeError,
  browserPerformanceActionDigest,
  createBrowserPerformanceRuntimeController,
  normalizeBrowserPerformanceCommand,
} from "../web/browser-performance-runtime.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function identity() {
  return Object.freeze({
    artifactManifestSha256: sha256("artifact-manifest"),
    runtimeManifestSha256: sha256("runtime-manifest"),
    guestDescriptorSha256: sha256("guest-manifest"),
    hibernateDescriptorSha256: sha256("hibernate-manifest"),
  });
}

class FakeClock {
  value = 0;

  now() {
    return this.value;
  }

  set(value) {
    this.value = value;
  }
}

class FakeNativeModule {
  callbacks;
  captureActive = false;
  scanoutEvents = 0;
  inputEvents = 0;
  droppedEvents = 0;
  beginCalls = 0;
  endCalls = 0;
  autoAcknowledge = true;
  dispatched = [];

  constructor(callbacks) {
    this.callbacks = callbacks;
  }

  _omarchy_performance_capture_begin() {
    assert.equal(this.captureActive, false);
    this.captureActive = true;
    this.scanoutEvents = 0;
    this.inputEvents = 0;
    this.droppedEvents = 0;
    this.beginCalls += 1;
    return 0;
  }

  _omarchy_performance_capture_end() {
    assert.equal(this.captureActive, true);
    this.captureActive = false;
    this.endCalls += 1;
    return this.droppedEvents === 0 ? 0 : -1;
  }

  _omarchy_performance_scanout_events() {
    return this.scanoutEvents;
  }

  _omarchy_performance_input_events() {
    return this.inputEvents;
  }

  _omarchy_performance_dropped_events() {
    return this.droppedEvents;
  }

  candidate(candidateId, sample) {
    assert.equal(this.captureActive, true);
    this.scanoutEvents += 1;
    this.callbacks.onBrowserPerformanceScanoutCandidate(candidateId, sample);
  }

  present(candidateId) {
    assert.equal(this.captureActive, true);
    this.scanoutEvents += 1;
    this.callbacks.onBrowserPerformanceScanoutPresent(candidateId);
  }

  dispatch(event, receiptHandle) {
    assert.ok(Number.isSafeInteger(receiptHandle) && receiptHandle > 0);
    this.dispatched.push(Object.freeze({ event, receiptHandle }));
    if (this.autoAcknowledge) {
      this.inputEvents += 1;
      this.callbacks.onBrowserPerformanceInputDelivered(receiptHandle);
    }
  }
}

function sample(frameIndex) {
  const value = new Uint32Array(PERFORMANCE_SAMPLE_PIXELS);
  value.fill(frameIndex & 0xffffff);
  return value;
}

function fixture() {
  const clock = new FakeClock();
  let qemuModule = null;
  const captures = [];
  const states = [];
  const controller = createBrowserPerformanceRuntimeController({
    identity: identity(),
    clock,
    cryptoScope: globalThis.crypto,
    getInstance: () => qemuModule,
    dispatchInput: (instance, event, receiptHandle) =>
      instance.dispatch(event, receiptHandle),
    onCapture: (capture) => captures.push(capture),
    onState: (state) => states.push(state),
  });
  qemuModule = new FakeNativeModule(controller.moduleCallbacks());
  return { captures, clock, controller, module: qemuModule, states };
}

async function inputCommand(controller, event, inputId) {
  return controller.input({
    inputId,
    actionDigest: await browserPerformanceActionDigest(event, globalThis.crypto),
    event,
  });
}

test("private native hooks seal a 24 FPS capture after exact source barriers", async () => {
  const { captures, clock, controller, module, states } = fixture();
  const challengeSha256 = sha256("animation-challenge");
  controller.begin({
    windowId: "animation_window_0001",
    challengeSha256,
  });

  const inputs = new Map([
    [200, { kind: "pointer", x: 16384, y: 8192, buttons: 0 }],
    [650, { kind: "key", scancode: 40, down: true }],
    [1_150, { kind: "key", scancode: 40, down: false }],
    [1_600, { kind: "wheel", x: 0, y: -1 }],
  ]);
  let inputIndex = 0;
  for (let frameIndex = 0; frameIndex <= 48; frameIndex += 1) {
    const timestampMs = frameIndex === 48 ? 2_000 : frameIndex * (1_000 / 24);
    for (const [inputTimestamp, event] of inputs) {
      if (inputTimestamp > timestampMs || inputTimestamp <= clock.value) continue;
      clock.set(inputTimestamp);
      inputIndex += 1;
      await inputCommand(controller, event, `input_${inputIndex}`);
    }
    clock.set(timestampMs);
    module.candidate(frameIndex + 1, sample(frameIndex));
    module.present(frameIndex + 1);
  }

  clock.set(2_000);
  const capture = await controller.end();
  const evidence = evaluateBrowserPerformanceTrace(capture.trace, {}, identity());

  assert.equal(evidence.verdict, "PASS", JSON.stringify(evidence.failures));
  assert.equal(evidence.metrics.uniqueGuestFps, 24);
  assert.equal(evidence.metrics.dynamicGuestFps, 24);
  assert.equal(evidence.metrics.inputAcceptanceLatency.count, 4);
  assert.equal(module.beginCalls, 1);
  assert.equal(module.endCalls, 1);
  assert.equal(captures.length, 1);
  assert.equal(captures[0], capture);
  assert.deepEqual(states.map(({ state }) => state), ["active", "sealed"]);
  assert.equal(Object.isFrozen(capture), true);
  assert.equal(Object.isFrozen(capture.trace), true);
  const hostCapture = await verifyFullGuestBrowserPerformanceCapture(
    { type: "browserperformancecapture", capture },
    identity().artifactManifestSha256,
    globalThis.crypto,
  );
  assert.equal(hostCapture.traceSha256, capture.traceSha256);
  assert.equal(Object.isFrozen(hostCapture), true);
  assert.equal(await verifyFullGuestBrowserPerformanceCapture(
    {
      type: "browserperformancecapture",
      capture: { ...capture, traceSha256: sha256("forged-trace") },
    },
    identity().artifactManifestSha256,
    globalThis.crypto,
  ), null);
});

test("performance input digest is derived from the exact sanitized event", async () => {
  const event = Object.freeze({ kind: "key", scancode: 40, down: true });
  const digest = await browserPerformanceActionDigest(event, globalThis.crypto);
  assert.equal(digest, sha256('{"down":true,"kind":"key","scancode":40}'));

  const { controller } = fixture();
  controller.begin({
    windowId: "animation_window_0001",
    challengeSha256: sha256("animation-challenge"),
  });
  await assert.rejects(
    controller.input({ inputId: "input_1", actionDigest: sha256("forged"), event }),
    (error) => error instanceof BrowserPerformanceRuntimeError &&
      error.code === "PERFORMANCE_INPUT_DIGEST_MISMATCH",
  );
});

test("public commands cannot inject native evidence or an exported capture", () => {
  assert.deepEqual(normalizeBrowserPerformanceCommand({
    type: "browserperformance",
    action: "begin",
    windowId: "animation_window_0001",
    challengeSha256: sha256("animation-challenge"),
  }), {
    action: "begin",
    windowId: "animation_window_0001",
    challengeSha256: sha256("animation-challenge"),
  });

  for (const forged of [
    {
      type: "browserperformance",
      action: "begin",
      windowId: "animation_window_0001",
      challengeSha256: sha256("animation-challenge"),
      candidate: { candidateId: 1, sample: [] },
    },
    { type: "browserperformance", action: "candidate", candidateId: 1 },
    { type: "browserperformance", action: "inputdelivered", receiptHandle: 1 },
    { type: "browserperformancecapture", capture: {} },
  ]) {
    assert.throws(
      () => normalizeBrowserPerformanceCommand(forged),
      (error) => error instanceof BrowserPerformanceRuntimeError &&
        error.code === "INVALID_PERFORMANCE_COMMAND",
    );
  }
});

test("missing or lossy native input acknowledgement prevents capture export", async (context) => {
  await context.test("unacknowledged receipt", async () => {
    const { clock, controller, module } = fixture();
    module.autoAcknowledge = false;
    controller.begin({
      windowId: "animation_window_0001",
      challengeSha256: sha256("animation-challenge"),
    });
    clock.set(0);
    module.candidate(1, sample(0));
    module.present(1);
    clock.set(200);
    await inputCommand(
      controller,
      { kind: "key", scancode: 40, down: true },
      "input_1",
    );
    clock.set(1_500);
    await assert.rejects(
      controller.end(),
      (error) => error.code === "INPUT_DELIVERY_UNACKNOWLEDGED",
    );
  });

  await context.test("native source count mismatch", async () => {
    const { clock, controller, module } = fixture();
    controller.begin({
      windowId: "animation_window_0001",
      challengeSha256: sha256("animation-challenge"),
    });
    clock.set(0);
    module.candidate(1, sample(0));
    module.present(1);
    module.scanoutEvents += 1;
    clock.set(1_500);
    await assert.rejects(
      controller.end(),
      (error) => error.code === "SCANOUT_SOURCE_INCOMPLETE",
    );
  });
});

test("a native receipt handle is single-use and cannot be supplied by a public input", async () => {
  const { clock, controller, module } = fixture();
  module.autoAcknowledge = false;
  controller.begin({
    windowId: "animation_window_0001",
    challengeSha256: sha256("animation-challenge"),
  });
  clock.set(100);
  await inputCommand(
    controller,
    { kind: "key", scancode: 40, down: true },
    "input_1",
  );
  const [{ receiptHandle }] = module.dispatched;
  module.inputEvents += 1;
  controller.moduleCallbacks().onBrowserPerformanceInputDelivered(receiptHandle);
  module.inputEvents += 1;
  controller.moduleCallbacks().onBrowserPerformanceInputDelivered(receiptHandle);
  assert.equal(controller.failure.code, "INPUT_RECEIPT_HANDLE_REPLAY");
});

test("native hooks apply after the pinned display/input patches and preserve causal order", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-browser-performance-hooks-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const upstream = process.env.QEMU_WASM_SOURCE ?? "/private/tmp/qemu-wasm-source";
  const runtime = new URL("../", import.meta.url);
  const sources = [
    "include/ui/sdl2.h",
    "ui/sdl2.c",
    "ui/sdl2-2d.c",
    "ui/sdl2-gl.c",
    "system/main.c",
    "hw/display/virtio-gpu-virgl.c",
    "hw/input/virtio-input.c",
  ];
  for (const relativePath of sources) {
    await mkdir(join(root, relativePath, ".."), { recursive: true });
    await writeFile(join(root, relativePath), await readFile(join(upstream, relativePath)));
  }
  for (const relativePatch of [
    "patches/qemu-sdl-frame-hook.patch",
    "patches/qemu-sdl-frame-sampling.patch",
    "patches/qemu-wasm-input-bridge.patch",
    "patches/qemu-wasm-runstate-guard.patch",
    "patches/qemu-wasm-sdl-texture-reuse.patch",
    "patches/qemu-wasm-sdl-pageflip-coalesce.patch",
    "patches/qemu-wasm-worker-dom.patch",
  ]) {
    const result = spawnSync("patch", [
      "--quiet", "--directory", root, "--strip=1", "--input",
      new URL(relativePatch, runtime).pathname,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, `${relativePatch}: ${result.stderr}`);
  }
  for (const relativePatch of [
    "patches/qemu-wasm-sdl-webgl-context.patch",
    "patches/qemu-wasm-sdl-webgl-frame-proof.patch",
    "patches/qemu-wasm-browser-performance-hooks.patch",
  ]) {
    const arguments_ = ["apply", "--recount"];
    if (relativePatch.endsWith("qemu-wasm-sdl-webgl-context.patch")) {
      arguments_.push("--unidiff-zero");
    }
    arguments_.push("--unsafe-paths", new URL(relativePatch, runtime).pathname);
    const result = spawnSync("git", arguments_, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, `${relativePatch}: ${result.stderr}`);
  }

  const [virgl, input, sdl, gl, buildScript, metadataScript] = await Promise.all([
    readFile(join(root, "hw/display/virtio-gpu-virgl.c"), "utf8"),
    readFile(join(root, "hw/input/virtio-input.c"), "utf8"),
    readFile(join(root, "ui/sdl2.c"), "utf8"),
    readFile(join(root, "ui/sdl2-gl.c"), "utf8"),
    readFile(new URL("scripts/build-qemu-wasm.sh", runtime), "utf8"),
    readFile(new URL("scripts/write-build-metadata.mjs", runtime), "utf8"),
  ]);
  assert.match(
    virgl,
    /omarchy_gl_scanout_candidate_arm\(\+\+omarchy_candidate_id\);\s*}\s*#endif\s*dpy_gl_update/,
  );
  assert.ok(input.indexOf("virtqueue_push(vinput->evt") < input.indexOf("virtio_notify(VIRTIO_DEVICE(vinput)"));
  assert.ok(input.indexOf("virtio_notify(VIRTIO_DEVICE(vinput)") < input.indexOf("omarchy_performance_input_report(true)"));
  assert.match(input, /!omarchy_performance_receipt_report_seen \|\|\s*omarchy_performance_receipt_report_failed/);
  assert.match(input, /onBrowserPerformanceInputDelivered/);
  assert.match(sdl, /OMARCHY_PERFORMANCE_RECEIPT_BEGIN_EVENT/);
  assert.match(sdl, /OMARCHY_PERFORMANCE_RECEIPT_END_EVENT/);
  assert.match(gl, /HEAPU32\.slice/);
  assert.match(gl, /onBrowserPerformanceScanoutCandidate/);
  assert.match(gl, /onBrowserPerformanceScanoutPresent/);
  assert.match(
    gl,
    /sdl2_gl_publish_scanout\(scon\);\s*#endif\s*sdl2_gl_window_context_swap\(scon\);/,
  );
  assert.match(buildScript, /qemu-wasm-browser-performance-hooks\.patch/);
  assert.match(buildScript, /hw\/display\/virtio-gpu-virgl\.c:\/qemu-src\/hw\/display\/virtio-gpu-virgl\.c:ro/);
  assert.match(buildScript, /hw\/input\/virtio-input\.c:\/qemu-src\/hw\/input\/virtio-input\.c:ro/);
  assert.match(metadataScript, /patches\/qemu-wasm-browser-performance-hooks\.patch/);
});
