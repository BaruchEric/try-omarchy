export const PERFORMANCE_EVIDENCE_SCHEMA_VERSION = 1;
export const PERFORMANCE_TRACE_SCHEMA_VERSION = 1;
export const MINIMUM_ALLOWED_UNIQUE_FPS = 24;

export const DEFAULT_PERFORMANCE_TARGETS = Object.freeze({
  minimumUniqueFps: 24,
  minimumWindowDurationMs: 1_500,
  maximumWindowDurationMs: 5_000,
  minimumInteractionSamples: 4,
  maximumInputAcceptanceLatencyMs: 50,
  maximumInputToFrameLatencyMs: 100,
  maximumDynamicFrameGapMs: 125,
  minimumSampledPixels: 256,
  minimumChangedPixels: 4,
  minimumChangedSampleRatio: 0.01,
  minimumDynamicEpochRatio: 0.9,
  maximumFirstInputFraction: 0.25,
  minimumLastInputFraction: 0.75,
  minimumInteractionSpanRatio: 0.5,
  maximumRawEvents: 20_000,
});

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const INPUT_KINDS = new Set(["key", "pointer", "wheel"]);
const INPUT_DELIVERY_SOURCES = new Set([
  "qemu-virtio-input-ring",
  "guest-input-ack",
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function cloneRaw(value) {
  try {
    return structuredClone(value);
  } catch {
    return null;
  }
}

function validIdentity(identity) {
  return hasExactKeys(identity, [
    "artifactManifestSha256",
    "runtimeManifestSha256",
    "guestDescriptorSha256",
    "hibernateDescriptorSha256",
  ]) &&
    SHA256.test(identity.artifactManifestSha256) &&
    !/^0{64}$/.test(identity.artifactManifestSha256) &&
    SHA256.test(identity.runtimeManifestSha256) &&
    !/^0{64}$/.test(identity.runtimeManifestSha256) &&
    [identity.guestDescriptorSha256, identity.hibernateDescriptorSha256].every(
      (value) => value === null || (SHA256.test(value) && !/^0{64}$/.test(value)),
    );
}

function identitiesMatch(actual, expected) {
  return validIdentity(actual) && validIdentity(expected) &&
    actual.artifactManifestSha256 === expected.artifactManifestSha256 &&
    actual.runtimeManifestSha256 === expected.runtimeManifestSha256 &&
    actual.guestDescriptorSha256 === expected.guestDescriptorSha256 &&
    actual.hibernateDescriptorSha256 === expected.hibernateDescriptorSha256;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function latencySummary(values) {
  if (values.length === 0) {
    return Object.freeze({ count: 0, minimumMs: null, medianMs: null, p95Ms: null, maximumMs: null });
  }
  return Object.freeze({
    count: values.length,
    minimumMs: Math.min(...values),
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maximumMs: Math.max(...values),
  });
}

function maximumCoveredGap(timestamps, startMs, endMs) {
  if (timestamps.length === 0) return null;
  let maximum = timestamps[0] - startMs;
  for (let index = 1; index < timestamps.length; index += 1) {
    maximum = Math.max(maximum, timestamps[index] - timestamps[index - 1]);
  }
  return Math.max(maximum, endMs - timestamps.at(-1));
}

function addFailure(failures, code, message, eventIndex = null) {
  failures.push(Object.freeze({ code, message, ...(eventIndex === null ? {} : { eventIndex }) }));
}

export function resolvePerformanceTargets(overrides = {}) {
  if (!isRecord(overrides)) throw new TypeError("Performance targets must be an object.");
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(DEFAULT_PERFORMANCE_TARGETS, key)) {
      throw new TypeError(`Unknown performance target: ${key}`);
    }
  }
  const targets = { ...DEFAULT_PERFORMANCE_TARGETS, ...overrides };
  const positiveNumbers = [
    "minimumWindowDurationMs",
    "maximumWindowDurationMs",
    "maximumInputAcceptanceLatencyMs",
    "maximumInputToFrameLatencyMs",
    "maximumDynamicFrameGapMs",
  ];
  for (const key of positiveNumbers) {
    if (!Number.isFinite(targets[key]) || targets[key] <= 0) {
      throw new TypeError(`${key} must be a positive finite number.`);
    }
  }
  if (!Number.isFinite(targets.minimumUniqueFps) ||
      targets.minimumUniqueFps < MINIMUM_ALLOWED_UNIQUE_FPS) {
    throw new TypeError(
      `minimumUniqueFps cannot be lower than ${MINIMUM_ALLOWED_UNIQUE_FPS}.`,
    );
  }
  if (targets.maximumWindowDurationMs < targets.minimumWindowDurationMs) {
    throw new TypeError("maximumWindowDurationMs must not be below the minimum.");
  }
  for (const key of [
    "minimumInteractionSamples",
    "minimumSampledPixels",
    "minimumChangedPixels",
    "maximumRawEvents",
  ]) {
    if (!positiveInteger(targets[key])) {
      throw new TypeError(`${key} must be a positive integer.`);
    }
  }
  for (const key of [
    "minimumChangedSampleRatio",
    "minimumDynamicEpochRatio",
    "maximumFirstInputFraction",
    "minimumLastInputFraction",
    "minimumInteractionSpanRatio",
  ]) {
    if (!Number.isFinite(targets[key]) || targets[key] < 0 || targets[key] > 1) {
      throw new TypeError(`${key} must be between zero and one.`);
    }
  }
  if (targets.minimumLastInputFraction <= targets.maximumFirstInputFraction) {
    throw new TypeError("The last-input fraction must be later than the first-input fraction.");
  }
  return Object.freeze(targets);
}

function finalize(rawTrace, identity, targets, failures, metrics) {
  return Object.freeze({
    schemaVersion: PERFORMANCE_EVIDENCE_SCHEMA_VERSION,
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    identity: cloneRaw(identity),
    targets,
    metrics: Object.freeze(metrics),
    failures: Object.freeze(failures),
    rawTrace,
  });
}

export function evaluateBrowserPerformanceTrace(
  trace,
  overrides = {},
  expectedIdentity = null,
) {
  const targets = resolvePerformanceTargets(overrides);
  const rawTrace = cloneRaw(trace);
  const failures = [];
  const emptyMetrics = {
    window: null,
    presents: 0,
    duplicatePresents: 0,
    uniqueScanoutEpochs: 0,
    uniqueEpochIntervals: 0,
    dynamicEpochIntervals: 0,
    staticEpochIntervals: 0,
    uniqueGuestFps: 0,
    dynamicGuestFps: 0,
    dynamicEpochRatio: 0,
    maximumUniqueFrameGapMs: null,
    maximumDynamicFrameGapMs: null,
    inputAcceptanceLatency: latencySummary([]),
    inputToDynamicFrameLatency: latencySummary([]),
    uniqueEpochTimeline: [],
    interactionTimeline: [],
  };

  if (!hasExactKeys(trace, [
    "schemaVersion", "runId", "identity", "clock", "telemetry", "events",
  ])) {
    addFailure(
      failures,
      "TRACE_SHAPE",
      "Trace must have exactly schemaVersion, runId, identity, clock, telemetry, and events.",
    );
    return finalize(rawTrace, trace?.identity ?? null, targets, failures, emptyMetrics);
  }
  if (trace.schemaVersion !== PERFORMANCE_TRACE_SCHEMA_VERSION) {
    addFailure(failures, "TRACE_SCHEMA", "Unsupported browser-performance trace schema.");
  }
  if (typeof trace.runId !== "string" || !IDENTIFIER.test(trace.runId)) {
    addFailure(failures, "RUN_ID", "Trace runId is invalid.");
  }
  if (!validIdentity(trace.identity)) {
    addFailure(failures, "TRACE_IDENTITY", "Trace artifact identity is invalid or incomplete.");
  }
  if (!validIdentity(expectedIdentity)) {
    addFailure(failures, "EXPECTED_IDENTITY", "Exact expected artifact identity is required.");
  } else if (!identitiesMatch(trace.identity, expectedIdentity)) {
    addFailure(failures, "IDENTITY_MISMATCH", "Trace was captured from a different artifact set.");
  }
  if (trace.clock !== "performance.now") {
    addFailure(failures, "CLOCK", "Trace timestamps must use the monotonic performance.now clock.");
  }
  if (!hasExactKeys(trace.telemetry, ["source", "cadence", "exportMode"]) ||
      trace.telemetry.source !== "qemu-virtio-gpu-scanout" ||
      trace.telemetry.cadence !== "uncapped-internal" ||
      trace.telemetry.exportMode !== "post-window-hashed") {
    addFailure(
      failures,
      "TELEMETRY",
      "Performance proof requires uncapped internal QEMU scanout telemetry and post-window hashing.",
    );
  }
  if (!Array.isArray(trace.events)) {
    addFailure(failures, "EVENTS", "Trace events must be an array.");
    return finalize(rawTrace, trace.identity, targets, failures, emptyMetrics);
  }
  if (trace.events.length > targets.maximumRawEvents) {
    addFailure(failures, "EVENT_LIMIT", "Trace exceeds the bounded raw-event limit.");
  }

  const starts = [];
  const ends = [];
  const frames = [];
  const sentInputs = [];
  const acceptedInputs = [];
  const parsedEvents = [];
  let previousTimestamp = -1;

  for (const [eventIndex, event] of trace.events.entries()) {
    if (!isRecord(event) || typeof event.type !== "string") {
      addFailure(failures, "EVENT_SHAPE", "Every event must be an object with a type.", eventIndex);
      continue;
    }
    if (!finiteNonNegative(event.timestampMs)) {
      addFailure(failures, "EVENT_TIMESTAMP", "Event timestamp must be finite and non-negative.", eventIndex);
      continue;
    }
    if (event.timestampMs < previousTimestamp) {
      addFailure(failures, "TIMESTAMP_REGRESSION", "Raw event timestamps regressed.", eventIndex);
    }
    previousTimestamp = Math.max(previousTimestamp, event.timestampMs);

    let valid = true;
    if (event.type === "window-start") {
      valid = hasExactKeys(event, [
        "type", "timestampMs", "windowId", "challengeSha256", "activity",
      ]) && typeof event.windowId === "string" && IDENTIFIER.test(event.windowId) &&
        SHA256.test(event.challengeSha256) && !/^0{64}$/.test(event.challengeSha256) &&
        event.activity === "guest-animation";
      if (valid) starts.push({ ...event, eventIndex });
    } else if (event.type === "window-end") {
      valid = hasExactKeys(event, [
        "type", "timestampMs", "windowId", "challengeSha256", "completion",
      ]) && typeof event.windowId === "string" && IDENTIFIER.test(event.windowId) &&
        SHA256.test(event.challengeSha256) &&
        event.completion === "guest-animation-complete";
      if (valid) ends.push({ ...event, eventIndex });
    } else if (event.type === "input-sent") {
      valid = hasExactKeys(event, [
        "type", "timestampMs", "inputId", "challengeSha256", "actionDigest", "kind",
      ]) && typeof event.inputId === "string" && IDENTIFIER.test(event.inputId) &&
        SHA256.test(event.challengeSha256) && SHA256.test(event.actionDigest) &&
        INPUT_KINDS.has(event.kind);
      if (valid) sentInputs.push({ ...event, eventIndex });
    } else if (event.type === "input-accepted") {
      valid = hasExactKeys(event, [
        "type", "timestampMs", "inputId", "challengeSha256", "actionDigest",
        "guestInputSequence", "deliverySource",
      ]) && typeof event.inputId === "string" && IDENTIFIER.test(event.inputId) &&
        SHA256.test(event.challengeSha256) && SHA256.test(event.actionDigest) &&
        positiveInteger(event.guestInputSequence) &&
        INPUT_DELIVERY_SOURCES.has(event.deliverySource);
      if (valid) acceptedInputs.push({ ...event, eventIndex });
    } else if (event.type === "frame-presented") {
      valid = hasExactKeys(event, [
        "type", "timestampMs", "presentSequence", "scanoutEpoch", "source",
        "contentDigest", "sampledPixels", "changedPixels", "latestGuestInputSequence",
      ]) && positiveInteger(event.presentSequence) && positiveInteger(event.scanoutEpoch) &&
        event.source === "qemu-virtio-gpu-scanout" && SHA256.test(event.contentDigest) &&
        positiveInteger(event.sampledPixels) && Number.isSafeInteger(event.changedPixels) &&
        event.changedPixels >= 0 && event.changedPixels <= event.sampledPixels &&
        Number.isSafeInteger(event.latestGuestInputSequence) &&
        event.latestGuestInputSequence >= 0;
      if (valid) frames.push({ ...event, eventIndex });
    } else {
      valid = false;
      addFailure(failures, "EVENT_TYPE", `Unsupported event type ${event.type}.`, eventIndex);
    }
    if (!valid && [
      "window-start", "window-end", "input-sent", "input-accepted", "frame-presented",
    ].includes(event.type)) {
      addFailure(failures, "EVENT_CONTRACT", `Invalid ${event.type} event contract.`, eventIndex);
    }
    if (valid) parsedEvents.push({ ...event, eventIndex });
  }

  if (starts.length !== 1 || ends.length !== 1) {
    addFailure(failures, "WINDOW_BOUNDARY", "Trace requires exactly one valid window-start and window-end.");
    return finalize(rawTrace, trace.identity, targets, failures, emptyMetrics);
  }
  const start = starts[0];
  const end = ends[0];
  if (start.eventIndex !== 0 || end.eventIndex !== trace.events.length - 1) {
    addFailure(failures, "WINDOW_ENCLOSURE", "The active window must enclose every raw event.");
  }
  if (start.windowId !== end.windowId || start.challengeSha256 !== end.challengeSha256) {
    addFailure(failures, "WINDOW_IDENTITY", "Window end does not match its animation challenge.");
  }
  const durationMs = end.timestampMs - start.timestampMs;
  if (!finiteNonNegative(durationMs) ||
      durationMs < targets.minimumWindowDurationMs ||
      durationMs > targets.maximumWindowDurationMs) {
    addFailure(
      failures,
      "WINDOW_DURATION",
      `Active window ${durationMs} ms is outside the configured bounded duration.`,
    );
  }
  for (const event of parsedEvents.slice(1, -1)) {
    if (event.timestampMs < start.timestampMs || event.timestampMs > end.timestampMs) {
      addFailure(failures, "EVENT_OUTSIDE_WINDOW", "Measurement event escaped the active window.", event.eventIndex);
    }
  }

  const sentById = new Map();
  const acceptedById = new Map();
  const actionDigests = new Set();
  for (const sent of sentInputs) {
    if (sent.challengeSha256 !== start.challengeSha256) {
      addFailure(failures, "INPUT_CHALLENGE", "Input was not bound to the animation challenge.", sent.eventIndex);
    }
    if (sentById.has(sent.inputId)) {
      addFailure(failures, "INPUT_DUPLICATE", "Input ID was sent more than once.", sent.eventIndex);
    } else {
      sentById.set(sent.inputId, sent);
    }
    if (actionDigests.has(sent.actionDigest)) {
      addFailure(failures, "INPUT_REPLAY", "Active interaction action was replayed.", sent.eventIndex);
    }
    actionDigests.add(sent.actionDigest);
  }
  let previousAcceptedSequence = 0;
  for (const accepted of acceptedInputs) {
    const sent = sentById.get(accepted.inputId);
    if (!sent || accepted.timestampMs < sent.timestampMs) {
      addFailure(failures, "INPUT_ACCEPT_ORDER", "Input acceptance preceded or lacked its send.", accepted.eventIndex);
      continue;
    }
    if (accepted.challengeSha256 !== start.challengeSha256 ||
        accepted.actionDigest !== sent.actionDigest) {
      addFailure(failures, "INPUT_ACCEPT_IDENTITY", "Input acceptance identity did not match.", accepted.eventIndex);
    }
    if (acceptedById.has(accepted.inputId)) {
      addFailure(failures, "INPUT_ACCEPT_DUPLICATE", "Input was accepted more than once.", accepted.eventIndex);
    } else {
      acceptedById.set(accepted.inputId, accepted);
    }
    if (accepted.guestInputSequence <= previousAcceptedSequence) {
      addFailure(failures, "INPUT_SEQUENCE", "Guest input sequence did not strictly increase.", accepted.eventIndex);
    }
    previousAcceptedSequence = Math.max(previousAcceptedSequence, accepted.guestInputSequence);
  }
  for (const sent of sentInputs) {
    if (!acceptedById.has(sent.inputId)) {
      addFailure(failures, "INPUT_UNACKNOWLEDGED", "Sent input was never accepted.", sent.eventIndex);
    }
  }

  const acceptedInTimeOrder = [...acceptedInputs].sort(
    (left, right) => left.timestampMs - right.timestampMs,
  );
  let acceptedCursor = 0;
  let highestAcceptedSequence = 0;
  let previousPresentSequence = 0;
  let previousUnique = null;
  let sampledPixels = null;
  let duplicatePresents = 0;
  const uniqueEpochTimeline = [];

  for (const frame of frames) {
    while (acceptedCursor < acceptedInTimeOrder.length &&
           acceptedInTimeOrder[acceptedCursor].timestampMs <= frame.timestampMs) {
      highestAcceptedSequence = Math.max(
        highestAcceptedSequence,
        acceptedInTimeOrder[acceptedCursor].guestInputSequence,
      );
      acceptedCursor += 1;
    }
    if (frame.latestGuestInputSequence > highestAcceptedSequence) {
      addFailure(failures, "FRAME_FUTURE_INPUT", "Frame claimed an input sequence not yet accepted.", frame.eventIndex);
    }
    if (frame.presentSequence <= previousPresentSequence) {
      addFailure(failures, "PRESENT_SEQUENCE", "Host present sequence did not strictly increase.", frame.eventIndex);
    }
    previousPresentSequence = Math.max(previousPresentSequence, frame.presentSequence);
    if (frame.sampledPixels < targets.minimumSampledPixels) {
      addFailure(failures, "FRAME_SAMPLE_SIZE", "Frame sample was too small.", frame.eventIndex);
    }
    if (sampledPixels === null) sampledPixels = frame.sampledPixels;
    if (frame.sampledPixels !== sampledPixels) {
      addFailure(failures, "FRAME_SAMPLE_DRIFT", "Frame sampling geometry changed within the window.", frame.eventIndex);
    }

    if (previousUnique && frame.scanoutEpoch < previousUnique.scanoutEpoch) {
      addFailure(failures, "SCANOUT_EPOCH_REGRESSION", "Guest scanout epoch regressed.", frame.eventIndex);
      continue;
    }
    if (previousUnique && frame.scanoutEpoch === previousUnique.scanoutEpoch) {
      duplicatePresents += 1;
      if (frame.contentDigest !== previousUnique.contentDigest ||
          frame.sampledPixels !== previousUnique.sampledPixels ||
          frame.changedPixels !== previousUnique.changedPixels ||
          frame.latestGuestInputSequence !== previousUnique.latestGuestInputSequence) {
        addFailure(failures, "DUPLICATE_EPOCH_MUTATION", "One scanout epoch changed across duplicate presents.", frame.eventIndex);
      }
      continue;
    }
    if (previousUnique && frame.timestampMs <= previousUnique.timestampMs) {
      addFailure(failures, "UNIQUE_TIMESTAMP", "Unique scanout epochs require increasing timestamps.", frame.eventIndex);
    }

    let dynamic = false;
    if (previousUnique === null) {
      if (frame.changedPixels !== 0) {
        addFailure(failures, "BASELINE_DELTA", "First scanout must be a zero-delta baseline.", frame.eventIndex);
      }
    } else {
      const digestChanged = frame.contentDigest !== previousUnique.contentDigest;
      if (digestChanged !== (frame.changedPixels > 0)) {
        addFailure(failures, "FRAME_DELTA_INCONSISTENT", "Frame digest and sampled delta disagree.", frame.eventIndex);
      }
      const minimumChanged = Math.max(
        targets.minimumChangedPixels,
        Math.ceil(frame.sampledPixels * targets.minimumChangedSampleRatio),
      );
      dynamic = digestChanged && frame.changedPixels >= minimumChanged;
    }
    const unique = Object.freeze({
      eventIndex: frame.eventIndex,
      timestampMs: frame.timestampMs,
      presentSequence: frame.presentSequence,
      scanoutEpoch: frame.scanoutEpoch,
      contentDigest: frame.contentDigest,
      sampledPixels: frame.sampledPixels,
      changedPixels: frame.changedPixels,
      latestGuestInputSequence: frame.latestGuestInputSequence,
      dynamic,
    });
    uniqueEpochTimeline.push(unique);
    previousUnique = unique;
  }

  const uniqueIntervals = Math.max(0, uniqueEpochTimeline.length - 1);
  const dynamicEpochs = uniqueEpochTimeline.slice(1).filter(({ dynamic }) => dynamic);
  const staticEpochIntervals = uniqueIntervals - dynamicEpochs.length;
  const seconds = durationMs > 0 ? durationMs / 1_000 : Infinity;
  const uniqueGuestFps = Number.isFinite(seconds) ? uniqueIntervals / seconds : 0;
  const dynamicGuestFps = Number.isFinite(seconds) ? dynamicEpochs.length / seconds : 0;
  const dynamicEpochRatio = uniqueIntervals > 0 ? dynamicEpochs.length / uniqueIntervals : 0;
  const uniqueTimestamps = uniqueEpochTimeline.map(({ timestampMs }) => timestampMs);
  const dynamicTimestamps = dynamicEpochs.map(({ timestampMs }) => timestampMs);
  const maximumUniqueFrameGapMs = maximumCoveredGap(
    uniqueTimestamps,
    start.timestampMs,
    end.timestampMs,
  );
  const maximumDynamicFrameGapMs = maximumCoveredGap(
    dynamicTimestamps,
    start.timestampMs,
    end.timestampMs,
  );

  if (uniqueGuestFps < targets.minimumUniqueFps) {
    addFailure(failures, "UNIQUE_FPS", `Unique guest scanout rate ${uniqueGuestFps} FPS is below target.`);
  }
  if (dynamicGuestFps < targets.minimumUniqueFps) {
    addFailure(failures, "DYNAMIC_FPS", `Content-changing guest scanout rate ${dynamicGuestFps} FPS is below target.`);
  }
  if (dynamicEpochRatio < targets.minimumDynamicEpochRatio) {
    addFailure(failures, "STATIC_EPOCHS", "Too many unique scanout epochs were visually static.");
  }
  if (maximumDynamicFrameGapMs === null ||
      maximumDynamicFrameGapMs > targets.maximumDynamicFrameGapMs) {
    addFailure(failures, "DYNAMIC_FRAME_GAP", "The active animation contained a disallowed dynamic-frame gap.");
  }

  const interactionTimeline = [];
  for (const sent of sentInputs) {
    const accepted = acceptedById.get(sent.inputId);
    if (!accepted) continue;
    const causalFrame = dynamicEpochs.find(
      (frame) => frame.timestampMs >= accepted.timestampMs &&
        frame.latestGuestInputSequence >= accepted.guestInputSequence,
    );
    if (!causalFrame) {
      addFailure(failures, "INPUT_NO_DYNAMIC_FRAME", "Accepted input caused no unique dynamic scanout.", sent.eventIndex);
      continue;
    }
    const sample = Object.freeze({
      inputId: sent.inputId,
      kind: sent.kind,
      actionDigest: sent.actionDigest,
      guestInputSequence: accepted.guestInputSequence,
      inputDeliverySource: accepted.deliverySource,
      sentAtMs: sent.timestampMs,
      acceptedAtMs: accepted.timestampMs,
      firstDynamicFrameAtMs: causalFrame.timestampMs,
      acceptanceLatencyMs: accepted.timestampMs - sent.timestampMs,
      inputToDynamicFrameLatencyMs: causalFrame.timestampMs - sent.timestampMs,
      causalScanoutEpoch: causalFrame.scanoutEpoch,
    });
    interactionTimeline.push(sample);
    if (sample.acceptanceLatencyMs > targets.maximumInputAcceptanceLatencyMs) {
      addFailure(failures, "INPUT_ACCEPT_LATENCY", "Input acceptance exceeded its latency target.", sent.eventIndex);
    }
    if (sample.inputToDynamicFrameLatencyMs > targets.maximumInputToFrameLatencyMs) {
      addFailure(failures, "INPUT_FRAME_LATENCY", "Input-to-dynamic-frame latency exceeded its target.", sent.eventIndex);
    }
  }
  if (interactionTimeline.length < targets.minimumInteractionSamples) {
    addFailure(failures, "INTERACTION_SAMPLES", "Too few complete active interaction samples were measured.");
  }
  if (sentInputs.length > 0 && durationMs > 0) {
    const firstSent = sentInputs[0].timestampMs;
    const lastSent = sentInputs.at(-1).timestampMs;
    if (firstSent > start.timestampMs + durationMs * targets.maximumFirstInputFraction) {
      addFailure(failures, "INPUT_WINDOW_START", "Active inputs began too late in the window.");
    }
    if (lastSent < start.timestampMs + durationMs * targets.minimumLastInputFraction) {
      addFailure(failures, "INPUT_WINDOW_END", "Active inputs ended too early in the window.");
    }
    if ((lastSent - firstSent) / durationMs < targets.minimumInteractionSpanRatio) {
      addFailure(failures, "INPUT_WINDOW_SPAN", "Active inputs did not span enough of the animation window.");
    }
  }

  const acceptanceLatencies = interactionTimeline.map(({ acceptanceLatencyMs }) => acceptanceLatencyMs);
  const frameLatencies = interactionTimeline.map(
    ({ inputToDynamicFrameLatencyMs }) => inputToDynamicFrameLatencyMs,
  );
  const metrics = {
    window: Object.freeze({
      windowId: start.windowId,
      challengeSha256: start.challengeSha256,
      activity: start.activity,
      completion: end.completion,
      startedAtMs: start.timestampMs,
      endedAtMs: end.timestampMs,
      durationMs,
    }),
    presents: frames.length,
    duplicatePresents,
    uniqueScanoutEpochs: uniqueEpochTimeline.length,
    uniqueEpochIntervals: uniqueIntervals,
    dynamicEpochIntervals: dynamicEpochs.length,
    staticEpochIntervals,
    uniqueGuestFps,
    dynamicGuestFps,
    dynamicEpochRatio,
    maximumUniqueFrameGapMs,
    maximumDynamicFrameGapMs,
    inputAcceptanceLatency: latencySummary(acceptanceLatencies),
    inputToDynamicFrameLatency: latencySummary(frameLatencies),
    uniqueEpochTimeline: Object.freeze(uniqueEpochTimeline),
    interactionTimeline: Object.freeze(interactionTimeline),
  };
  return finalize(rawTrace, trace.identity, targets, failures, metrics);
}
