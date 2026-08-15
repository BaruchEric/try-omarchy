import {
  DEFAULT_PERFORMANCE_TARGETS,
  PERFORMANCE_TRACE_SCHEMA_VERSION,
} from "./gate.mjs";

export const PERFORMANCE_CAPTURE_SCHEMA_VERSION = 1;
export const PERFORMANCE_SAMPLE_COLUMNS = 32;
export const PERFORMANCE_SAMPLE_ROWS = 18;
export const PERFORMANCE_SAMPLE_PIXELS =
  PERFORMANCE_SAMPLE_COLUMNS * PERFORMANCE_SAMPLE_ROWS;

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const RECEIPT_TOKEN = /^[a-f0-9]{48}$/;
const INPUT_KINDS = new Set(["key", "pointer", "wheel"]);
const INPUT_DELIVERY_SOURCES = new Set([
  "qemu-virtio-input-ring",
  "guest-input-ack",
]);
const TELEMETRY = Object.freeze({
  source: "qemu-virtio-gpu-scanout",
  cadence: "uncapped-internal",
  exportMode: "post-window-hashed",
});

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonZeroSha256(value) {
  return SHA256.test(value ?? "") && !/^0{64}$/.test(value);
}

function validIdentity(identity) {
  return hasExactKeys(identity, [
    "artifactManifestSha256",
    "runtimeManifestSha256",
    "guestDescriptorSha256",
    "hibernateDescriptorSha256",
  ]) &&
    nonZeroSha256(identity.artifactManifestSha256) &&
    nonZeroSha256(identity.runtimeManifestSha256) &&
    [identity.guestDescriptorSha256, identity.hibernateDescriptorSha256].every(
      (value) => value === null || nonZeroSha256(value),
    );
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function clone(value) {
  return structuredClone(value);
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("Canonical JSON accepts only JSON values.");
}

function sampleBytes(sample) {
  const bytes = new Uint8Array(sample.length * 3);
  for (let index = 0; index < sample.length; index += 1) {
    const rgb = sample[index];
    bytes[index * 3] = rgb >>> 16;
    bytes[index * 3 + 1] = rgb >>> 8;
    bytes[index * 3 + 2] = rgb;
  }
  return bytes;
}

async function sha256Hex(bytes, cryptoScope) {
  const digest = await cryptoScope.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

function createReceiptToken(cryptoScope) {
  const bytes = cryptoScope.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function errorDetails(value) {
  try {
    return clone(value);
  } catch {
    return null;
  }
}

export class BrowserPerformanceProducerError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "BrowserPerformanceProducerError";
    this.code = code;
    this.details = errorDetails(details);
  }
}

function sourceSession(value) {
  return isRecord(value) && typeof value.close === "function" ? value : null;
}

function sourceCloseReport(value, observedEvents) {
  return hasExactKeys(value, ["sourceEvents", "droppedEvents"]) &&
    Number.isSafeInteger(value.sourceEvents) &&
    value.sourceEvents >= 0 &&
    value.sourceEvents === observedEvents &&
    value.droppedEvents === 0;
}

function diagnosticLine(message) {
  if (message?.type === "runtimediagnostic" && typeof message.line === "string") {
    return message.line;
  }
  if (message?.type === "serial" && message.stream === "stderr" &&
      typeof message.line === "string" &&
      message.line.startsWith("OMARCHY_RUNTIME_DIAGNOSTIC ")) {
    return message.line;
  }
  return null;
}

function isPublicGuestFrame(message) {
  const frame = message?.type === "guestframe"
    ? (isRecord(message.frame) ? message.frame : message)
    : null;
  return isRecord(frame) && positiveInteger(frame.sequence) &&
    frame.source === "qemu-guest" &&
    positiveInteger(frame.sampledPixels) &&
    Number.isSafeInteger(frame.nonBlackPixels) &&
    frame.nonBlackPixels >= 0 && frame.nonBlackPixels <= frame.sampledPixels;
}

/**
 * Records what the current full-guest/browser-acceptance surface exposes.
 * None of these observations enter the performance trace: guestframe is
 * sampled, present diagnostics are host-side, and inputaccepted is emitted
 * when the Worker/SDL queue accepts an event.
 */
export class ExposedRuntimeTelemetryAudit {
  #counts = {
    publicGuestFrames: 0,
    publicInputAcceptances: 0,
    runtimeDiagnostics: 0,
    webglPresentDiagnostics: 0,
    sdlPresentDiagnostics: 0,
    sdlInputProcessedDiagnostics: 0,
  };

  observe(message) {
    if (!isRecord(message)) return false;
    let observed = false;
    if (isPublicGuestFrame(message)) {
      this.#counts.publicGuestFrames += 1;
      observed = true;
    }
    if (message.type === "inputaccepted") {
      this.#counts.publicInputAcceptances += 1;
      observed = true;
    }
    const line = diagnosticLine(message);
    if (line !== null) {
      this.#counts.runtimeDiagnostics += 1;
      if (/\bwebgl2-frame-presented\b/.test(line)) {
        this.#counts.webglPresentDiagnostics += 1;
      }
      if (/\bsdl-frame-presented\b/.test(line)) {
        this.#counts.sdlPresentDiagnostics += 1;
      }
      if (/\binput-(?:key|modifiers-release)-processed\b/.test(line)) {
        this.#counts.sdlInputProcessedDiagnostics += 1;
      }
      observed = true;
    }
    return observed;
  }

  report() {
    return deepFreeze({
      ...this.#counts,
      internalScanoutAvailable: false,
      inputDeliveryAcknowledgementAvailable: false,
      reasons: [
        "Public guestframe and SDL/WebGL present diagnostics expose no uncapped virtio-gpu scanout epoch or fixed content sample.",
        "Public inputaccepted and SDL processed diagnostics stop before the virtio-input ring or an authenticated guest acknowledgement.",
      ],
    });
  }
}

/**
 * Produce a strict trace in the same execution realm as private QEMU hooks.
 * `scanoutSource` and `inputDeliverySource` are trusted capabilities installed
 * by the runtime composition root; public browser messages must never be
 * adapted into either source.
 */
export class BrowserPerformanceTraceProducer {
  #runId;
  #identity;
  #clock;
  #crypto;
  #scanoutSource;
  #inputDeliverySource;
  #receiptTokenFactory;
  #samplePixels;
  #maximumRawEvents;
  #audit;
  #state = "idle";
  #failure = null;
  #events = [];
  #reservedEvents = 0;
  #window = null;
  #lastTimestamp = -1;
  #chain = Promise.resolve();
  #scanoutSession = null;
  #inputSession = null;
  #scanoutSourceSequence = 0;
  #inputSourceSequence = 0;
  #lastObservedCandidateId = 0;
  #currentCandidate = null;
  #lastPresentedSample = null;
  #scanoutEpoch = 0;
  #presentSequence = 0;
  #guestInputSequence = 0;
  #pendingInputs = new Map();
  #consumedReceipts = new Set();
  #capture = null;

  constructor({
    runId,
    identity,
    clock = globalThis.performance,
    cryptoScope = globalThis.crypto,
    scanoutSource = null,
    inputDeliverySource = null,
    receiptTokenFactory = null,
    samplePixels = PERFORMANCE_SAMPLE_PIXELS,
    maximumRawEvents = DEFAULT_PERFORMANCE_TARGETS.maximumRawEvents,
    audit = new ExposedRuntimeTelemetryAudit(),
  } = {}) {
    if (typeof runId !== "string" || !IDENTIFIER.test(runId)) {
      throw new TypeError("Browser performance producer requires a valid runId.");
    }
    if (!validIdentity(identity)) {
      throw new TypeError("Browser performance producer requires an exact artifact identity.");
    }
    if (!clock || typeof clock.now !== "function") {
      throw new TypeError("Browser performance producer requires a monotonic clock.");
    }
    if (!cryptoScope?.subtle || typeof cryptoScope.subtle.digest !== "function" ||
        typeof cryptoScope.getRandomValues !== "function") {
      throw new TypeError("Browser performance producer requires Web Crypto.");
    }
    if (samplePixels !== PERFORMANCE_SAMPLE_PIXELS) {
      throw new TypeError(
        `Browser performance sampling must remain ${PERFORMANCE_SAMPLE_COLUMNS}x${PERFORMANCE_SAMPLE_ROWS}.`,
      );
    }
    if (!positiveInteger(maximumRawEvents)) {
      throw new TypeError("Browser performance event bound must be a positive integer.");
    }
    if (!(audit instanceof ExposedRuntimeTelemetryAudit)) {
      throw new TypeError("Browser performance audit must be an ExposedRuntimeTelemetryAudit.");
    }
    if (receiptTokenFactory !== null && typeof receiptTokenFactory !== "function") {
      throw new TypeError("Receipt token factory must be a function.");
    }
    this.#runId = runId;
    this.#identity = deepFreeze(clone(identity));
    this.#clock = clock;
    this.#crypto = cryptoScope;
    this.#scanoutSource = scanoutSource;
    this.#inputDeliverySource = inputDeliverySource;
    this.#receiptTokenFactory = receiptTokenFactory ?? (() => createReceiptToken(this.#crypto));
    this.#samplePixels = samplePixels;
    this.#maximumRawEvents = maximumRawEvents;
    this.#audit = audit;
  }

  get state() {
    return this.#state;
  }

  get failure() {
    return this.#failure === null ? null : deepFreeze(clone(this.#failure));
  }

  observeExposedRuntimeMessage(message) {
    return this.#audit.observe(message);
  }

  capabilityReport() {
    return deepFreeze({
      scanoutHook: typeof this.#scanoutSource?.openWindow === "function",
      inputDeliveryHook: typeof this.#inputDeliverySource?.openWindow === "function",
      exposedRuntime: this.#audit.report(),
    });
  }

  #error() {
    if (this.#failure === null) {
      return new BrowserPerformanceProducerError(
        "PRODUCER_FAILED",
        "Browser performance producer failed without a diagnostic.",
      );
    }
    return new BrowserPerformanceProducerError(
      this.#failure.code,
      this.#failure.message,
      this.#failure.details,
    );
  }

  #latch(code, message, details = null) {
    if (this.#failure === null) {
      this.#failure = deepFreeze({ code, message, details: errorDetails(details) });
      this.#state = "failed";
    }
    return this.#error();
  }

  #assertHealthy() {
    if (this.#failure !== null) throw this.#error();
  }

  #timestamp() {
    let timestamp;
    try {
      timestamp = this.#clock.now();
    } catch (error) {
      this.#latch("CLOCK_FAILED", "The monotonic producer clock threw an exception.", {
        cause: String(error),
      });
      return null;
    }
    if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp < this.#lastTimestamp) {
      this.#latch("CLOCK_REGRESSION", "The monotonic producer clock was invalid or regressed.", {
        previousTimestampMs: this.#lastTimestamp,
        timestampMs: timestamp,
      });
      return null;
    }
    this.#lastTimestamp = timestamp;
    return timestamp;
  }

  #reserveEvent() {
    if (this.#failure !== null) return;
    if (this.#reservedEvents >= this.#maximumRawEvents) {
      this.#latch("EVENT_BUFFER_OVERFLOW", "The bounded performance event buffer overflowed.", {
        maximumRawEvents: this.#maximumRawEvents,
      });
      return false;
    }
    this.#reservedEvents += 1;
    return true;
  }

  #appendEvent(event) {
    if (this.#failure !== null) return;
    this.#events.push(deepFreeze(event));
  }

  #enqueue(operation) {
    this.#chain = this.#chain.then(async () => {
      if (this.#failure !== null) return;
      await operation();
    }).catch((error) => {
      this.#latch(
        error instanceof BrowserPerformanceProducerError
          ? error.code
          : "PRODUCER_OPERATION_FAILED",
        error instanceof Error ? error.message : "A producer operation failed.",
        error instanceof BrowserPerformanceProducerError ? error.details : {
          cause: String(error),
        },
      );
    });
  }

  #acceptSourceSequence(kind, sourceSequence) {
    if (!positiveInteger(sourceSequence)) {
      this.#latch(`${kind}_SOURCE_SEQUENCE`, `${kind} source emitted an invalid sequence.`);
      return false;
    }
    const previous = kind === "SCANOUT"
      ? this.#scanoutSourceSequence
      : this.#inputSourceSequence;
    if (sourceSequence !== previous + 1) {
      this.#latch(`${kind}_SOURCE_GAP`, `${kind} source events were dropped, duplicated, or reordered.`, {
        expectedSourceSequence: previous + 1,
        sourceSequence,
      });
      return false;
    }
    const sourceLimit = kind === "SCANOUT"
      ? Math.min(Number.MAX_SAFE_INTEGER, this.#maximumRawEvents * 2)
      : this.#maximumRawEvents;
    if (sourceSequence > sourceLimit) {
      this.#latch(`${kind}_SOURCE_OVERFLOW`, `${kind} source exceeded its bounded callback limit.`, {
        sourceLimit,
        sourceSequence,
      });
      return false;
    }
    if (kind === "SCANOUT") this.#scanoutSourceSequence = sourceSequence;
    else this.#inputSourceSequence = sourceSequence;
    return true;
  }

  #callbackAllowed(kind) {
    if (this.#state === "active" || this.#state === "ending") return true;
    this.#latch(`${kind}_OUTSIDE_WINDOW`, `${kind} source emitted outside the active window.`, {
      state: this.#state,
    });
    return false;
  }

  #scanoutCandidate(value) {
    if (!this.#callbackAllowed("SCANOUT") || !hasExactKeys(value, [
      "sourceSequence", "candidateId", "sample",
    ]) || !this.#acceptSourceSequence("SCANOUT", value.sourceSequence) ||
        !positiveInteger(value.candidateId) ||
        value.candidateId <= this.#lastObservedCandidateId ||
        Object.prototype.toString.call(value.sample) !== "[object Uint32Array]" ||
        value.sample.length !== this.#samplePixels) {
      if (this.#failure === null) {
        this.#latch("SCANOUT_CANDIDATE_CONTRACT", "Internal scanout candidate was malformed or replayed.");
      }
      return;
    }
    const sample = new Uint32Array(value.sample);
    for (const rgb of sample) {
      if (!Number.isSafeInteger(rgb) || rgb < 0 || rgb > 0xffffff) {
        this.#latch("SCANOUT_SAMPLE_CONTRACT", "Internal scanout sample contained a non-RGB pixel.");
        return;
      }
    }
    const timestampMs = this.#timestamp();
    if (timestampMs === null) return;
    this.#lastObservedCandidateId = value.candidateId;
    this.#enqueue(async () => {
      const contentDigest = await sha256Hex(sampleBytes(sample), this.#crypto);
      let changedPixels = 0;
      if (this.#lastPresentedSample !== null) {
        for (let index = 0; index < sample.length; index += 1) {
          if (sample[index] !== this.#lastPresentedSample[index]) changedPixels += 1;
        }
      }
      this.#scanoutEpoch += 1;
      this.#currentCandidate = {
        candidateId: value.candidateId,
        candidateTimestampMs: timestampMs,
        scanoutEpoch: this.#scanoutEpoch,
        contentDigest,
        sampledPixels: sample.length,
        changedPixels,
        latestGuestInputSequence: this.#guestInputSequence,
        sample,
        presented: false,
      };
    });
  }

  #scanoutPresent(value) {
    if (!this.#callbackAllowed("SCANOUT") || !hasExactKeys(value, [
      "sourceSequence", "candidateId",
    ]) || !this.#acceptSourceSequence("SCANOUT", value.sourceSequence) ||
        !positiveInteger(value.candidateId)) {
      if (this.#failure === null) {
        this.#latch("SCANOUT_PRESENT_CONTRACT", "Internal scanout present was malformed.");
      }
      return;
    }
    const timestampMs = this.#timestamp();
    if (timestampMs === null) return;
    if (!this.#reserveEvent()) return;
    this.#enqueue(() => {
      const candidate = this.#currentCandidate;
      if (candidate === null || candidate.candidateId !== value.candidateId) {
        throw new BrowserPerformanceProducerError(
          "UNKNOWN_SCANOUT_CANDIDATE",
          "A present did not resolve to the current internal scanout candidate.",
          { candidateId: value.candidateId, currentCandidateId: candidate?.candidateId ?? null },
        );
      }
      this.#presentSequence += 1;
      this.#appendEvent({
        type: "frame-presented",
        timestampMs,
        presentSequence: this.#presentSequence,
        scanoutEpoch: candidate.scanoutEpoch,
        source: "qemu-virtio-gpu-scanout",
        contentDigest: candidate.contentDigest,
        sampledPixels: candidate.sampledPixels,
        changedPixels: candidate.changedPixels,
        latestGuestInputSequence: candidate.latestGuestInputSequence,
      });
      if (!candidate.presented) {
        candidate.presented = true;
        this.#lastPresentedSample = new Uint32Array(candidate.sample);
      }
    });
  }

  #inputDelivered(deliverySource, value) {
    if (!this.#callbackAllowed("INPUT") ||
        !hasExactKeys(value, ["sourceSequence", "receiptToken"]) ||
        !this.#acceptSourceSequence("INPUT", value.sourceSequence) ||
        !RECEIPT_TOKEN.test(value.receiptToken ?? "")) {
      if (this.#failure === null) {
        this.#latch("INPUT_DELIVERY_CONTRACT", "Internal input delivery acknowledgement was malformed.");
      }
      return;
    }
    const timestampMs = this.#timestamp();
    if (timestampMs === null) return;
    if (!this.#reserveEvent()) return;
    this.#enqueue(() => {
      const pending = this.#pendingInputs.get(value.receiptToken);
      if (!pending) {
        throw new BrowserPerformanceProducerError(
          this.#consumedReceipts.has(value.receiptToken)
            ? "INPUT_RECEIPT_REPLAY"
            : "INPUT_RECEIPT_UNKNOWN",
          "Input delivery used a stale, replayed, or unknown receipt.",
        );
      }
      if (pending.deliverySource !== deliverySource) {
        throw new BrowserPerformanceProducerError(
          "INPUT_DELIVERY_DOWNGRADE",
          "Input delivery did not use the source selected before dispatch.",
          { expected: pending.deliverySource, actual: deliverySource },
        );
      }
      this.#guestInputSequence += 1;
      this.#appendEvent({
        type: "input-accepted",
        timestampMs,
        inputId: pending.inputId,
        challengeSha256: this.#window.challengeSha256,
        actionDigest: pending.actionDigest,
        guestInputSequence: this.#guestInputSequence,
        deliverySource,
      });
      this.#pendingInputs.delete(value.receiptToken);
      this.#consumedReceipts.add(value.receiptToken);
    });
  }

  #sourceFatal(kind, value) {
    this.#latch(`${kind}_SOURCE_FATAL`, `${kind} source reported an internal capture failure.`, {
      reason: value instanceof Error ? value.message : String(value),
    });
  }

  beginWindow({ windowId, challengeSha256 } = {}) {
    if (this.#state !== "idle") {
      throw new BrowserPerformanceProducerError(
        "WINDOW_STATE",
        "Browser performance producer supports exactly one window.",
        { state: this.#state },
      );
    }
    if (typeof windowId !== "string" || !IDENTIFIER.test(windowId) ||
        !nonZeroSha256(challengeSha256)) {
      throw new TypeError("Performance window requires a valid ID and non-zero challenge digest.");
    }
    const missing = [];
    if (typeof this.#scanoutSource?.openWindow !== "function") {
      missing.push("uncapped qemu-virtio-gpu scanout candidate/present hook");
    }
    if (typeof this.#inputDeliverySource?.openWindow !== "function") {
      missing.push("virtio-input ring or authenticated guest acknowledgement hook");
    }
    if (missing.length > 0) {
      throw this.#latch(
        "REQUIRED_INTERNAL_TELEMETRY_UNAVAILABLE",
        "The exposed browser runtime cannot produce the strict performance trace.",
        { missing, exposedRuntime: this.#audit.report() },
      );
    }
    const timestampMs = this.#timestamp();
    this.#assertHealthy();
    this.#window = deepFreeze({ windowId, challengeSha256 });
    this.#state = "active";
    if (!this.#reserveEvent()) throw this.#error();
    this.#appendEvent({
      type: "window-start",
      timestampMs,
      windowId,
      challengeSha256,
      activity: "guest-animation",
    });
    const binding = deepFreeze({
      runId: this.#runId,
      identity: clone(this.#identity),
      windowId,
      challengeSha256,
      clock: "performance.now",
      samplePixels: this.#samplePixels,
      sampleColumns: PERFORMANCE_SAMPLE_COLUMNS,
      sampleRows: PERFORMANCE_SAMPLE_ROWS,
      sampleOrder: "gl-readpixels-rgb24",
    });
    try {
      this.#scanoutSession = sourceSession(this.#scanoutSource.openWindow(binding, deepFreeze({
        candidate: (value) => this.#scanoutCandidate(value),
        present: (value) => this.#scanoutPresent(value),
        fatal: (value) => this.#sourceFatal("SCANOUT", value),
      })));
      this.#inputSession = sourceSession(this.#inputDeliverySource.openWindow(binding, deepFreeze({
        virtioDelivered: (value) => this.#inputDelivered("qemu-virtio-input-ring", value),
        guestAcknowledged: (value) => this.#inputDelivered("guest-input-ack", value),
        fatal: (value) => this.#sourceFatal("INPUT", value),
      })));
    } catch (error) {
      throw this.#latch("SOURCE_OPEN_FAILED", "A trusted performance source failed to open.", {
        cause: String(error),
      });
    }
    if (this.#scanoutSession === null || this.#inputSession === null) {
      throw this.#latch(
        "SOURCE_SESSION_CONTRACT",
        "A trusted performance source did not return a closeable session.",
      );
    }
    this.#assertHealthy();
    return binding;
  }

  sendInput({ inputId, actionDigest, kind, deliverySource } = {}, dispatch) {
    this.#assertHealthy();
    if (this.#state !== "active") {
      throw new BrowserPerformanceProducerError(
        "INPUT_WINDOW_STATE",
        "Input can only be sent inside the active performance window.",
      );
    }
    if (typeof inputId !== "string" || !IDENTIFIER.test(inputId) ||
        !nonZeroSha256(actionDigest) || !INPUT_KINDS.has(kind) ||
        !INPUT_DELIVERY_SOURCES.has(deliverySource) || typeof dispatch !== "function") {
      throw new TypeError("Performance input metadata or dispatch callback is invalid.");
    }
    if ([...this.#pendingInputs.values()].some((input) => input.inputId === inputId) ||
        this.#events.some((event) => event.type === "input-sent" && event.inputId === inputId)) {
      throw this.#latch("INPUT_ID_REPLAY", "Performance input ID was reused.", { inputId });
    }
    let receiptToken;
    try {
      receiptToken = this.#receiptTokenFactory();
    } catch (error) {
      throw this.#latch("INPUT_RECEIPT_FAILED", "Could not create a secure input receipt.", {
        cause: String(error),
      });
    }
    if (!RECEIPT_TOKEN.test(receiptToken ?? "") ||
        this.#pendingInputs.has(receiptToken) || this.#consumedReceipts.has(receiptToken)) {
      throw this.#latch("INPUT_RECEIPT_INVALID", "Input receipt was malformed or reused.");
    }
    const timestampMs = this.#timestamp();
    this.#assertHealthy();
    if (!this.#reserveEvent()) throw this.#error();
    this.#pendingInputs.set(receiptToken, deepFreeze({
      inputId,
      actionDigest,
      kind,
      deliverySource,
    }));
    this.#enqueue(() => this.#appendEvent({
      type: "input-sent",
      timestampMs,
      inputId,
      challengeSha256: this.#window.challengeSha256,
      actionDigest,
      kind,
    }));
    const receipt = deepFreeze({ receiptToken });
    try {
      dispatch(receipt);
    } catch (error) {
      throw this.#latch("INPUT_DISPATCH_FAILED", "The input dispatch callback failed.", {
        cause: String(error),
        inputId,
      });
    }
    return receipt;
  }

  async endWindow() {
    this.#assertHealthy();
    if (this.#state !== "active") {
      throw new BrowserPerformanceProducerError(
        "WINDOW_STATE",
        "Only an active performance window can end.",
        { state: this.#state },
      );
    }
    this.#state = "ending";
    const settled = await Promise.allSettled([
      Promise.resolve().then(() => this.#scanoutSession.close()),
      Promise.resolve().then(() => this.#inputSession.close()),
    ]);
    if (this.#failure === null) this.#state = "draining";
    const [scanoutResult, inputResult] = settled;
    if (scanoutResult.status === "rejected" || inputResult.status === "rejected") {
      this.#latch("SOURCE_CLOSE_FAILED", "A trusted source failed its end-of-window barrier.", {
        scanout: scanoutResult.status === "rejected" ? String(scanoutResult.reason) : null,
        input: inputResult.status === "rejected" ? String(inputResult.reason) : null,
      });
    } else {
      if (!sourceCloseReport(scanoutResult.value, this.#scanoutSourceSequence)) {
        this.#latch("SCANOUT_SOURCE_INCOMPLETE", "Scanout source could not prove a lossless window.", {
          observedEvents: this.#scanoutSourceSequence,
          report: scanoutResult.value,
        });
      }
      if (!sourceCloseReport(inputResult.value, this.#inputSourceSequence)) {
        this.#latch("INPUT_SOURCE_INCOMPLETE", "Input source could not prove a lossless window.", {
          observedEvents: this.#inputSourceSequence,
          report: inputResult.value,
        });
      }
    }
    await this.#chain;
    if (this.#presentSequence === 0 && this.#failure === null) {
      this.#latch(
        "INTERNAL_SCANOUT_UNAVAILABLE",
        "The active window produced no internal scanout candidate/present evidence.",
      );
    }
    if (this.#pendingInputs.size > 0 && this.#failure === null) {
      this.#latch(
        "INPUT_DELIVERY_UNACKNOWLEDGED",
        "At least one input lacked a virtio-ring or authenticated guest acknowledgement.",
        { pendingInputIds: [...this.#pendingInputs.values()].map(({ inputId }) => inputId) },
      );
    }
    this.#assertHealthy();
    const timestampMs = this.#timestamp();
    this.#assertHealthy();
    if (!this.#reserveEvent()) throw this.#error();
    this.#appendEvent({
      type: "window-end",
      timestampMs,
      windowId: this.#window.windowId,
      challengeSha256: this.#window.challengeSha256,
      completion: "guest-animation-complete",
    });
    this.#assertHealthy();
    this.#state = "sealed";
  }

  async exportCapture() {
    this.#assertHealthy();
    if (this.#state !== "sealed") {
      throw new BrowserPerformanceProducerError(
        "EXPORT_WINDOW_STATE",
        "Performance trace can only be exported after the source barriers close.",
        { state: this.#state },
      );
    }
    if (this.#capture !== null) return this.#capture;
    const trace = deepFreeze({
      schemaVersion: PERFORMANCE_TRACE_SCHEMA_VERSION,
      runId: this.#runId,
      identity: clone(this.#identity),
      clock: "performance.now",
      telemetry: { ...TELEMETRY },
      events: clone(this.#events),
    });
    const canonicalTrace = canonicalJson(trace);
    let traceSha256;
    try {
      traceSha256 = await sha256Hex(
        new TextEncoder().encode(canonicalTrace),
        this.#crypto,
      );
    } catch (error) {
      throw this.#latch("TRACE_HASH_FAILED", "The sealed trace could not be hashed.", {
        cause: String(error),
      });
    }
    this.#assertHealthy();
    this.#capture = deepFreeze({
      schemaVersion: PERFORMANCE_CAPTURE_SCHEMA_VERSION,
      traceSha256,
      trace,
    });
    return this.#capture;
  }

  async exportTrace() {
    return (await this.exportCapture()).trace;
  }
}

export function createBrowserPerformanceTraceProducer(options) {
  return new BrowserPerformanceTraceProducer(options);
}
