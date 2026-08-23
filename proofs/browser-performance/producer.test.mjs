import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { evaluateBrowserPerformanceTrace } from "./gate.mjs";
import {
  BrowserPerformanceProducerError,
  createBrowserPerformanceTraceProducer,
  ExposedRuntimeTelemetryAudit,
  PERFORMANCE_CAPTURE_SCHEMA_VERSION,
  PERFORMANCE_SAMPLE_PIXELS,
} from "./producer.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function identity() {
  return {
    artifactManifestSha256: sha256("artifact-manifest"),
    runtimeManifestSha256: sha256("runtime-manifest"),
    guestDescriptorSha256: sha256("guest-descriptor"),
  };
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

class FakeScanoutSource {
  handlers = null;
  sourceSequence = 0;
  closeOverride = null;

  openWindow(binding, handlers) {
    assert.equal(Object.isFrozen(binding), true);
    this.handlers = handlers;
    return {
      close: async () => this.closeOverride ?? ({
        sourceEvents: this.sourceSequence,
        droppedEvents: 0,
      }),
    };
  }

  candidate(candidateId, sample) {
    this.handlers.candidate({
      sourceSequence: ++this.sourceSequence,
      candidateId,
      sample,
    });
  }

  candidateAtSequence(sourceSequence, candidateId, sample) {
    this.sourceSequence = sourceSequence;
    this.handlers.candidate({ sourceSequence, candidateId, sample });
  }

  present(candidateId) {
    this.handlers.present({
      sourceSequence: ++this.sourceSequence,
      candidateId,
    });
  }
}

class FakeInputDeliverySource {
  handlers = null;
  sourceSequence = 0;
  closeOverride = null;

  openWindow(binding, handlers) {
    assert.equal(Object.isFrozen(binding), true);
    this.handlers = handlers;
    return {
      close: async () => this.closeOverride ?? ({
        sourceEvents: this.sourceSequence,
        droppedEvents: 0,
      }),
    };
  }

  deliver(receipt, deliverySource = "qemu-virtio-input-ring") {
    const value = {
      sourceSequence: ++this.sourceSequence,
      receiptToken: receipt.receiptToken,
    };
    if (deliverySource === "qemu-virtio-input-ring") {
      this.handlers.virtioDelivered(value);
    } else {
      this.handlers.guestAcknowledged(value);
    }
  }
}

function sample(frameIndex, { staticContent = false } = {}) {
  const pixels = new Uint32Array(PERFORMANCE_SAMPLE_PIXELS);
  if (!staticContent) pixels.fill(frameIndex & 0xffffff);
  return pixels;
}

function producerFixture(overrides = {}) {
  const clock = new FakeClock();
  const scanout = new FakeScanoutSource();
  const input = new FakeInputDeliverySource();
  let receipt = 0;
  const expectedIdentity = identity();
  const producer = createBrowserPerformanceTraceProducer({
    runId: "browser_performance_run_0001",
    identity: expectedIdentity,
    clock,
    cryptoScope: globalThis.crypto,
    scanoutSource: scanout,
    inputDeliverySource: input,
    receiptTokenFactory: () => (++receipt).toString(16).padStart(48, "0"),
    ...overrides,
  });
  producer.beginWindow({
    windowId: "animation_window_0001",
    challengeSha256: sha256("animation-challenge"),
  });
  return { clock, scanout, input, producer, expectedIdentity };
}

function failureCodes(evidence) {
  return new Set(evidence.failures.map(({ code }) => code));
}

async function passingCapture() {
  const fixture = producerFixture();
  const { clock, scanout, input, producer } = fixture;
  const receipts = new Map();
  const inputTimes = [200, 650, 1_150, 1_600];
  const schedule = [];
  for (let frameIndex = 0; frameIndex <= 48; frameIndex += 1) {
    schedule.push({
      timestampMs: frameIndex === 48 ? 2_000 : frameIndex * (1_000 / 24),
      order: 2,
      run() {
        scanout.candidate(frameIndex + 1, sample(frameIndex));
        scanout.present(frameIndex + 1);
      },
    });
  }
  for (const [index, timestampMs] of inputTimes.entries()) {
    const inputId = `input_${index + 1}`;
    schedule.push({
      timestampMs,
      order: 0,
      run() {
        const receipt = producer.sendInput({
          inputId,
          actionDigest: sha256(`action-${index + 1}`),
          kind: index % 2 === 0 ? "pointer" : "key",
          deliverySource: "qemu-virtio-input-ring",
        }, () => {});
        receipts.set(inputId, receipt);
      },
    });
    schedule.push({
      timestampMs: timestampMs + 4,
      order: 1,
      run() {
        input.deliver(receipts.get(inputId));
      },
    });
  }
  schedule.sort((left, right) =>
    left.timestampMs - right.timestampMs || left.order - right.order);
  for (const entry of schedule) {
    clock.set(entry.timestampMs);
    entry.run();
  }
  clock.set(2_000);
  await producer.endWindow();
  return { ...fixture, capture: await producer.exportCapture() };
}

test("trusted scanout and virtio delivery hooks produce a hashed trace that passes at 24 FPS", async () => {
  const { capture, producer, expectedIdentity } = await passingCapture();
  const evidence = evaluateBrowserPerformanceTrace(
    capture.trace,
    {},
    expectedIdentity,
  );

  assert.equal(capture.schemaVersion, PERFORMANCE_CAPTURE_SCHEMA_VERSION);
  assert.match(capture.traceSha256, /^[a-f0-9]{64}$/);
  assert.equal(capture.trace, await producer.exportTrace());
  assert.equal(evidence.verdict, "PASS", JSON.stringify(evidence.failures));
  assert.equal(evidence.metrics.uniqueGuestFps, 24);
  assert.equal(evidence.metrics.dynamicGuestFps, 24);
  assert.equal(evidence.metrics.inputAcceptanceLatency.count, 4);
  assert.deepEqual(capture.trace.telemetry, {
    source: "qemu-virtio-gpu-scanout",
    cadence: "uncapped-internal",
    exportMode: "post-window-hashed",
  });
});

test("host presents cannot inflate a 12 Hz internal scanout candidate rate", async () => {
  const { clock, scanout, producer, expectedIdentity } = producerFixture();
  const intervalMs = 1_000 / 12;
  for (let frameIndex = 0; frameIndex <= 24; frameIndex += 1) {
    const timestampMs = frameIndex === 24 ? 2_000 : frameIndex * intervalMs;
    clock.set(timestampMs);
    scanout.candidate(frameIndex + 1, sample(frameIndex));
    for (let present = 0; present < 12; present += 1) {
      scanout.present(frameIndex + 1);
    }
  }
  clock.set(2_000);
  await producer.endWindow();
  const trace = await producer.exportTrace();
  const evidence = evaluateBrowserPerformanceTrace(trace, {}, expectedIdentity);

  assert.equal(evidence.metrics.presents, 300);
  assert.equal(evidence.metrics.uniqueScanoutEpochs, 25);
  assert.equal(evidence.metrics.uniqueGuestFps, 12);
  assert.equal(evidence.metrics.duplicatePresents, 275);
  assert.ok(failureCodes(evidence).has("UNIQUE_FPS"));
  assert.ok(failureCodes(evidence).has("DYNAMIC_FPS"));
});

test("candidate metadata is frozen before a later acknowledgement and duplicate present", async () => {
  const { clock, scanout, input, producer } = producerFixture();
  clock.set(0);
  scanout.candidate(1, sample(0));
  scanout.present(1);
  clock.set(100);
  const mutableSample = sample(1);
  scanout.candidate(2, mutableSample);
  mutableSample.fill(0xabcdef);
  scanout.present(2);
  clock.set(110);
  const receipt = producer.sendInput({
    inputId: "input_1",
    actionDigest: sha256("action-1"),
    kind: "key",
    deliverySource: "guest-input-ack",
  }, () => {});
  clock.set(114);
  input.deliver(receipt, "guest-input-ack");
  clock.set(120);
  scanout.present(2);
  clock.set(130);
  scanout.candidate(3, sample(2));
  scanout.present(3);
  clock.set(1_500);
  await producer.endWindow();
  const frames = (await producer.exportTrace()).events.filter(
    ({ type }) => type === "frame-presented",
  );

  assert.equal(frames.length, 4);
  assert.deepEqual(
    frames.map(({ scanoutEpoch, latestGuestInputSequence }) =>
      [scanoutEpoch, latestGuestInputSequence]),
    [[1, 0], [2, 0], [2, 0], [3, 1]],
  );
  assert.equal(frames[1].contentDigest, frames[2].contentDigest);
  assert.equal(frames[1].changedPixels, frames[2].changedPixels);
  assert.equal(frames[1].changedPixels, PERFORMANCE_SAMPLE_PIXELS);
});

test("new internal epochs with unchanged samples stay static and fail the dynamic gate", async () => {
  const { clock, scanout, producer, expectedIdentity } = producerFixture();
  for (let frameIndex = 0; frameIndex <= 50; frameIndex += 1) {
    clock.set(frameIndex === 50 ? 2_000 : frameIndex * 40);
    scanout.candidate(frameIndex + 1, sample(frameIndex, { staticContent: true }));
    scanout.present(frameIndex + 1);
  }
  clock.set(2_000);
  await producer.endWindow();
  const evidence = evaluateBrowserPerformanceTrace(
    await producer.exportTrace(),
    {},
    expectedIdentity,
  );

  assert.equal(evidence.metrics.uniqueGuestFps, 25);
  assert.equal(evidence.metrics.dynamicGuestFps, 0);
  assert.ok(failureCodes(evidence).has("STATIC_EPOCHS"));
  assert.ok(failureCodes(evidence).has("DYNAMIC_FPS"));
});

test("public guestframes, present diagnostics, and Worker queue acknowledgements fail closed", () => {
  const audit = new ExposedRuntimeTelemetryAudit();
  const producer = createBrowserPerformanceTraceProducer({
    runId: "browser_performance_run_0001",
    identity: identity(),
    clock: new FakeClock(),
    cryptoScope: globalThis.crypto,
    audit,
  });
  producer.observeExposedRuntimeMessage({
    type: "guestframe",
    sequence: 1,
    source: "qemu-guest",
    guestWidth: 1600,
    guestHeight: 900,
    timestamp: 250,
    sampledPixels: 576,
    nonBlackPixels: 576,
  });
  producer.observeExposedRuntimeMessage({
    type: "guestframe",
    frame: {
      sequence: 2,
      source: "qemu-guest",
      guestWidth: 1600,
      guestHeight: 900,
      sampledPixels: 576,
      nonBlackPixels: 576,
    },
  });
  producer.observeExposedRuntimeMessage({
    type: "serial",
    stream: "stderr",
    line: "OMARCHY_RUNTIME_DIAGNOSTIC sdl-frame-presented sequence=1 monotonic-ms=1.000 width=1600 height=900 running=1",
  });
  producer.observeExposedRuntimeMessage({
    type: "runtimediagnostic",
    line: "OMARCHY_RUNTIME_DIAGNOSTIC input-key-processed sequence=1 monotonic-ms=2.000 scancode=40 down=1 routed=1 running=1",
  });
  producer.observeExposedRuntimeMessage({
    type: "inputaccepted",
    event: { kind: "key", scancode: 40, down: true },
  });

  assert.throws(
    () => producer.beginWindow({
      windowId: "animation_window_0001",
      challengeSha256: sha256("animation-challenge"),
    }),
    (error) => {
      assert.ok(error instanceof BrowserPerformanceProducerError);
      assert.equal(error.code, "REQUIRED_INTERNAL_TELEMETRY_UNAVAILABLE");
      assert.deepEqual(error.details.exposedRuntime, {
        publicGuestFrames: 2,
        publicInputAcceptances: 1,
        runtimeDiagnostics: 2,
        sdlPresentDiagnostics: 1,
        sdlInputProcessedDiagnostics: 1,
        internalScanoutAvailable: false,
        inputDeliveryAcknowledgementAvailable: false,
        reasons: error.details.exposedRuntime.reasons,
      });
      return true;
    },
  );
});

test("a host-queued input without a trusted delivery receipt prevents export", async () => {
  const { clock, scanout, producer } = producerFixture();
  clock.set(0);
  scanout.candidate(1, sample(0));
  scanout.present(1);
  clock.set(200);
  producer.sendInput({
    inputId: "input_1",
    actionDigest: sha256("action-1"),
    kind: "pointer",
    deliverySource: "qemu-virtio-input-ring",
  }, () => {
    // This corresponds to current Worker/SDL queueing only. No trusted source
    // callback is emitted, so it can never become input-accepted evidence.
  });
  clock.set(1_500);

  await assert.rejects(
    producer.endWindow(),
    (error) => error instanceof BrowserPerformanceProducerError &&
      error.code === "INPUT_DELIVERY_UNACKNOWLEDGED",
  );
});

test("wrong delivery mode, source gaps, and lossy close reports latch fatal evidence", async (context) => {
  await context.test("delivery downgrade", async () => {
    const { clock, scanout, input, producer } = producerFixture();
    clock.set(0);
    scanout.candidate(1, sample(0));
    scanout.present(1);
    clock.set(10);
    const receipt = producer.sendInput({
      inputId: "input_1",
      actionDigest: sha256("action-1"),
      kind: "key",
      deliverySource: "guest-input-ack",
    }, () => {});
    clock.set(14);
    input.deliver(receipt, "qemu-virtio-input-ring");
    clock.set(1_500);
    await assert.rejects(
      producer.endWindow(),
      (error) => error.code === "INPUT_DELIVERY_DOWNGRADE",
    );
  });

  await context.test("scanout source sequence gap", async () => {
    const { scanout, producer } = producerFixture();
    scanout.candidateAtSequence(2, 1, sample(0));
    assert.equal(producer.failure.code, "SCANOUT_SOURCE_GAP");
    await assert.rejects(
      producer.exportTrace(),
      (error) => error.code === "SCANOUT_SOURCE_GAP",
    );
  });

  await context.test("lossy end barrier", async () => {
    const { clock, scanout, producer } = producerFixture();
    clock.set(0);
    scanout.candidate(1, sample(0));
    scanout.present(1);
    scanout.closeOverride = {
      sourceEvents: scanout.sourceSequence,
      droppedEvents: 1,
    };
    clock.set(1_500);
    await assert.rejects(
      producer.endWindow(),
      (error) => error.code === "SCANOUT_SOURCE_INCOMPLETE",
    );
  });

  await context.test("callback after the end barrier", async () => {
    const { clock, scanout, producer } = producerFixture();
    clock.set(0);
    scanout.candidate(1, sample(0));
    scanout.present(1);
    clock.set(1_500);
    await producer.endWindow();
    scanout.present(1);
    await assert.rejects(
      producer.exportTrace(),
      (error) => error.code === "SCANOUT_OUTSIDE_WINDOW",
    );
  });
});

test("clock regression and bounded-buffer overflow prevent a post-window hash", async (context) => {
  await context.test("clock regression", () => {
    const { clock, scanout, producer } = producerFixture();
    clock.set(10);
    scanout.candidate(1, sample(0));
    clock.set(9);
    scanout.present(1);
    assert.equal(producer.failure.code, "CLOCK_REGRESSION");
  });

  await context.test("event buffer overflow", async () => {
    const { clock, scanout, producer } = producerFixture({ maximumRawEvents: 2 });
    clock.set(0);
    scanout.candidate(1, sample(0));
    scanout.present(1);
    clock.set(1_500);
    await assert.rejects(
      producer.endWindow(),
      (error) => error.code === "EVENT_BUFFER_OVERFLOW",
    );
    await assert.rejects(
      producer.exportCapture(),
      (error) => error.code === "EVENT_BUFFER_OVERFLOW",
    );
  });

  await context.test("synchronous source burst", () => {
    const { scanout, producer } = producerFixture({ maximumRawEvents: 2 });
    for (let candidateId = 1; candidateId <= 5; candidateId += 1) {
      scanout.candidate(candidateId, sample(candidateId));
    }
    assert.equal(producer.failure.code, "SCANOUT_SOURCE_OVERFLOW");
  });

  await context.test("late callback while the sealed trace hash is pending", async () => {
    let digestCalls = 0;
    let finishDigest = null;
    const cryptoScope = {
      getRandomValues(value) {
        return globalThis.crypto.getRandomValues(value);
      },
      subtle: {
        digest(algorithm, bytes) {
          digestCalls += 1;
          if (digestCalls !== 2) {
            return globalThis.crypto.subtle.digest(algorithm, bytes);
          }
          return new Promise((resolvePromise, reject) => {
            finishDigest = () => {
              globalThis.crypto.subtle.digest(algorithm, bytes).then(
                resolvePromise,
                reject,
              );
            };
          });
        },
      },
    };
    const { clock, scanout, producer } = producerFixture({ cryptoScope });
    clock.set(0);
    scanout.candidate(1, sample(0));
    scanout.present(1);
    clock.set(1_500);
    await producer.endWindow();
    const pendingCapture = producer.exportCapture();
    assert.equal(typeof finishDigest, "function");
    scanout.present(1);
    finishDigest();
    await assert.rejects(
      pendingCapture,
      (error) => error.code === "SCANOUT_OUTSIDE_WINDOW",
    );
  });
});
