import {
  createBrowserPerformanceTraceProducer,
  PERFORMANCE_SAMPLE_PIXELS,
} from "../../proofs/browser-performance/producer.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PENDING_RECEIPTS = 1_024;
const MAX_RECEIPT_HANDLE = 0x7fffffff;
const NATIVE_EXPORTS = Object.freeze([
  "_omarchy_performance_capture_begin",
  "_omarchy_performance_capture_end",
  "_omarchy_performance_scanout_events",
  "_omarchy_performance_input_events",
  "_omarchy_performance_dropped_events",
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function nativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_RECEIPT_HANDLE;
}

function positiveNativeInteger(value) {
  return nativeInteger(value) && value > 0;
}

function nonZeroSha256(value) {
  return SHA256.test(value ?? "") && !/^0{64}$/.test(value);
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("Canonical performance input must contain only JSON values.");
}

function validSanitizedInput(event) {
  if (event?.kind === "key") {
    return exactKeys(event, ["kind", "scancode", "down"]) &&
      Number.isSafeInteger(event.scancode) && event.scancode > 0 &&
      event.scancode < 512 && typeof event.down === "boolean";
  }
  if (event?.kind === "pointer") {
    return exactKeys(event, ["kind", "x", "y", "buttons"]) &&
      Number.isSafeInteger(event.x) && event.x >= 0 && event.x <= 32767 &&
      Number.isSafeInteger(event.y) && event.y >= 0 && event.y <= 32767 &&
      Number.isSafeInteger(event.buttons) && event.buttons >= 0 && event.buttons <= 31;
  }
  if (event?.kind === "wheel") {
    return exactKeys(event, ["kind", "x", "y"]) &&
      Number.isSafeInteger(event.x) && event.x >= -1 && event.x <= 1 &&
      Number.isSafeInteger(event.y) && event.y >= -1 && event.y <= 1 &&
      (event.x !== 0 || event.y !== 0);
  }
  return false;
}

async function sha256Hex(bytes, cryptoScope) {
  if (!cryptoScope?.subtle || typeof cryptoScope.subtle.digest !== "function") {
    throw new TypeError("Browser performance input hashing requires Web Crypto.");
  }
  const digest = await cryptoScope.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

export class BrowserPerformanceRuntimeError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "BrowserPerformanceRuntimeError";
    this.code = code;
    if (details !== undefined) this.details = structuredClone(details);
  }
}

function invalidCommand(message = "Browser performance command is invalid.") {
  throw new BrowserPerformanceRuntimeError("INVALID_PERFORMANCE_COMMAND", message);
}

export function normalizeBrowserPerformanceCommand(value) {
  if (!isRecord(value) || value.type !== "browserperformance") invalidCommand();
  if (value.action === "begin") {
    if (!exactKeys(value, ["type", "action", "windowId", "challengeSha256"]) ||
        typeof value.windowId !== "string" || !IDENTIFIER.test(value.windowId) ||
        !nonZeroSha256(value.challengeSha256)) {
      invalidCommand("Browser performance begin command is invalid.");
    }
    return deepFreeze({
      action: "begin",
      windowId: value.windowId,
      challengeSha256: value.challengeSha256,
    });
  }
  if (value.action === "input") {
    if (!exactKeys(value, ["type", "action", "inputId", "actionDigest", "event"]) ||
        typeof value.inputId !== "string" || !IDENTIFIER.test(value.inputId) ||
        !nonZeroSha256(value.actionDigest) || !isRecord(value.event)) {
      invalidCommand("Browser performance input command is invalid.");
    }
    return deepFreeze({
      action: "input",
      inputId: value.inputId,
      actionDigest: value.actionDigest,
      event: structuredClone(value.event),
    });
  }
  if (value.action === "end" && exactKeys(value, ["type", "action"])) {
    return Object.freeze({ action: "end" });
  }
  invalidCommand();
}

export async function browserPerformanceActionDigest(
  sanitizedEvent,
  cryptoScope = globalThis.crypto,
) {
  if (!validSanitizedInput(sanitizedEvent)) {
    throw new TypeError("Browser performance action must be an exact sanitized input event.");
  }
  return sha256Hex(
    new TextEncoder().encode(canonicalJson(sanitizedEvent)),
    cryptoScope,
  );
}

class NativeBrowserPerformanceSourceBridge {
  #getInstance;
  #state = "idle";
  #scanoutHandlers = null;
  #inputHandlers = null;
  #scanoutSequence = 0;
  #inputSequence = 0;
  #receiptHandle = 0;
  #receipts = new Map();
  #consumedReceiptHandles = new Set();
  #closeRequests = new Set();
  #closePromise = null;
  #resolveClose = null;
  #failure = null;
  #callbacks;
  #scanoutSource;
  #inputDeliverySource;

  constructor(getInstance) {
    if (typeof getInstance !== "function") {
      throw new TypeError("Native performance bridge requires a QEMU instance provider.");
    }
    this.#getInstance = getInstance;
    this.#callbacks = Object.freeze({
      onBrowserPerformanceScanoutCandidate: (candidateId, sample) =>
        this.#candidate(candidateId, sample),
      onBrowserPerformanceScanoutPresent: (candidateId) =>
        this.#present(candidateId),
      onBrowserPerformanceInputDelivered: (receiptHandle) =>
        this.#inputDelivered(receiptHandle),
    });
    this.#scanoutSource = Object.freeze({
      openWindow: (binding, handlers) => this.#open("scanout", binding, handlers),
    });
    this.#inputDeliverySource = Object.freeze({
      openWindow: (binding, handlers) => this.#open("input", binding, handlers),
    });
  }

  get scanoutSource() {
    return this.#scanoutSource;
  }

  get inputDeliverySource() {
    return this.#inputDeliverySource;
  }

  get failure() {
    return this.#failure === null ? null : deepFreeze(structuredClone(this.#failure));
  }

  moduleCallbacks() {
    return this.#callbacks;
  }

  #fatal(code, message, kind, details = undefined) {
    if (this.#failure === null) {
      this.#failure = { code, message, ...(details === undefined ? {} : { details }) };
    }
    const error = new BrowserPerformanceRuntimeError(code, message, details);
    const handlers = kind === "scanout" ? this.#scanoutHandlers : this.#inputHandlers;
    handlers?.fatal?.(error);
    return false;
  }

  #validBinding(binding) {
    return Object.isFrozen(binding) && binding.samplePixels === PERFORMANCE_SAMPLE_PIXELS &&
      binding.sampleColumns === 32 && binding.sampleRows === 18 &&
      binding.sampleOrder === "gl-readpixels-rgb24" &&
      binding.clock === "performance.now";
  }

  #open(kind, binding, handlers) {
    if (this.#state !== "idle" && this.#state !== "opening") {
      throw new BrowserPerformanceRuntimeError(
        "NATIVE_SOURCE_WINDOW_STATE",
        "Native performance sources support exactly one capture window.",
      );
    }
    if (!this.#validBinding(binding) || !Object.isFrozen(handlers)) {
      throw new BrowserPerformanceRuntimeError(
        "NATIVE_SOURCE_BINDING_INVALID",
        "Native performance source received an invalid producer binding.",
      );
    }
    if (kind === "scanout") {
      if (this.#scanoutHandlers !== null ||
          typeof handlers.candidate !== "function" ||
          typeof handlers.present !== "function" ||
          typeof handlers.fatal !== "function") {
        throw new BrowserPerformanceRuntimeError(
          "NATIVE_SOURCE_BINDING_INVALID",
          "Native scanout source handlers are invalid.",
        );
      }
      this.#scanoutHandlers = handlers;
    } else {
      if (this.#inputHandlers !== null ||
          typeof handlers.virtioDelivered !== "function" ||
          typeof handlers.guestAcknowledged !== "function" ||
          typeof handlers.fatal !== "function") {
        throw new BrowserPerformanceRuntimeError(
          "NATIVE_SOURCE_BINDING_INVALID",
          "Native input source handlers are invalid.",
        );
      }
      this.#inputHandlers = handlers;
    }
    this.#state = "opening";
    if (this.#scanoutHandlers !== null && this.#inputHandlers !== null) {
      this.#beginNative();
    }
    return Object.freeze({ close: () => this.#close(kind) });
  }

  #nativeInstance() {
    const instance = this.#getInstance();
    if (!instance || NATIVE_EXPORTS.some((name) => typeof instance[name] !== "function")) {
      throw new BrowserPerformanceRuntimeError(
        "NATIVE_PERFORMANCE_HOOKS_UNAVAILABLE",
        "QEMU module does not expose the complete native performance hook set.",
        { requiredExports: NATIVE_EXPORTS },
      );
    }
    return instance;
  }

  #beginNative() {
    const instance = this.#nativeInstance();
    if (instance._omarchy_performance_capture_begin() !== 0) {
      throw new BrowserPerformanceRuntimeError(
        "NATIVE_SOURCE_BEGIN_FAILED",
        "QEMU rejected the native performance capture window.",
      );
    }
    this.#state = "active";
  }

  #callbackAllowed(kind) {
    if (this.#state === "active" || this.#state === "closing") return true;
    return this.#fatal(
      `${kind.toUpperCase()}_NATIVE_CALLBACK_OUTSIDE_WINDOW`,
      `Native ${kind} callback arrived outside the active capture window.`,
      kind,
      { state: this.#state },
    );
  }

  #candidate(candidateId, sample) {
    if (!this.#callbackAllowed("scanout")) return false;
    if (!positiveNativeInteger(candidateId) ||
        Object.prototype.toString.call(sample) !== "[object Uint32Array]" ||
        sample.length !== PERFORMANCE_SAMPLE_PIXELS) {
      return this.#fatal(
        "NATIVE_SCANOUT_CANDIDATE_INVALID",
        "Native scanout candidate callback was malformed.",
        "scanout",
      );
    }
    this.#scanoutHandlers.candidate({
      sourceSequence: ++this.#scanoutSequence,
      candidateId,
      sample,
    });
    return true;
  }

  #present(candidateId) {
    if (!this.#callbackAllowed("scanout")) return false;
    if (!positiveNativeInteger(candidateId)) {
      return this.#fatal(
        "NATIVE_SCANOUT_PRESENT_INVALID",
        "Native scanout present callback was malformed.",
        "scanout",
      );
    }
    this.#scanoutHandlers.present({
      sourceSequence: ++this.#scanoutSequence,
      candidateId,
    });
    return true;
  }

  bindReceipt(receiptToken) {
    if (this.#state !== "active" || typeof receiptToken !== "string" ||
        !/^[a-f0-9]{48}$/.test(receiptToken)) {
      throw new BrowserPerformanceRuntimeError(
        "INPUT_RECEIPT_BINDING_INVALID",
        "A native receipt can only be bound inside the active capture window.",
      );
    }
    if (this.#receipts.size >= MAX_PENDING_RECEIPTS ||
        this.#receiptHandle >= MAX_RECEIPT_HANDLE) {
      throw new BrowserPerformanceRuntimeError(
        "INPUT_RECEIPT_HANDLE_EXHAUSTED",
        "Native input receipt handles exceeded their hard bound.",
      );
    }
    const handle = ++this.#receiptHandle;
    this.#receipts.set(handle, receiptToken);
    return handle;
  }

  cancelReceipt(receiptHandle) {
    this.#receipts.delete(receiptHandle);
  }

  #inputDelivered(receiptHandle) {
    if (!this.#callbackAllowed("input")) return false;
    if (!positiveNativeInteger(receiptHandle)) {
      return this.#fatal(
        "INPUT_RECEIPT_HANDLE_INVALID",
        "Native input delivery callback carried an invalid receipt handle.",
        "input",
      );
    }
    const receiptToken = this.#receipts.get(receiptHandle);
    if (receiptToken === undefined) {
      return this.#fatal(
        this.#consumedReceiptHandles.has(receiptHandle)
          ? "INPUT_RECEIPT_HANDLE_REPLAY"
          : "INPUT_RECEIPT_HANDLE_UNKNOWN",
        "Native input delivery callback replayed or forged a receipt handle.",
        "input",
        { receiptHandle },
      );
    }
    this.#receipts.delete(receiptHandle);
    this.#consumedReceiptHandles.add(receiptHandle);
    this.#inputHandlers.virtioDelivered({
      sourceSequence: ++this.#inputSequence,
      receiptToken,
    });
    return true;
  }

  #close(kind) {
    if (this.#state !== "active" && this.#state !== "closing") {
      return Promise.reject(new BrowserPerformanceRuntimeError(
        "NATIVE_SOURCE_CLOSE_STATE",
        "Native performance source closed outside the active window.",
      ));
    }
    if (this.#closeRequests.has(kind)) {
      return Promise.reject(new BrowserPerformanceRuntimeError(
        "NATIVE_SOURCE_CLOSE_REPLAY",
        "Native performance source close was replayed.",
      ));
    }
    this.#state = "closing";
    this.#closeRequests.add(kind);
    if (this.#closePromise === null) {
      this.#closePromise = new Promise((resolve) => {
        this.#resolveClose = resolve;
      });
    }
    if (this.#closeRequests.size === 2) this.#finishClose();
    return this.#closePromise.then((reports) => reports[kind]);
  }

  #finishClose() {
    const instance = this.#nativeInstance();
    const endStatus = instance._omarchy_performance_capture_end();
    const nativeScanoutEvents = instance._omarchy_performance_scanout_events();
    const nativeInputEvents = instance._omarchy_performance_input_events();
    const nativeDroppedEvents = instance._omarchy_performance_dropped_events();
    const countersValid = [nativeScanoutEvents, nativeInputEvents, nativeDroppedEvents]
      .every(nativeInteger);
    const droppedEvents = countersValid
      ? nativeDroppedEvents + (endStatus === 0 ? 0 : 1)
      : 1;
    this.#state = "closed";
    this.#resolveClose(Object.freeze({
      scanout: Object.freeze({
        sourceEvents: countersValid ? nativeScanoutEvents : this.#scanoutSequence + 1,
        droppedEvents,
      }),
      input: Object.freeze({
        sourceEvents: countersValid ? nativeInputEvents : this.#inputSequence + 1,
        droppedEvents,
      }),
    }));
  }
}

export class BrowserPerformanceRuntimeController {
  #identity;
  #clock;
  #crypto;
  #getInstance;
  #dispatchInput;
  #onCapture;
  #onState;
  #bridge;
  #producer = null;
  #state = "idle";
  #capture = null;

  constructor({
    identity,
    clock = globalThis.performance,
    cryptoScope = globalThis.crypto,
    getInstance,
    dispatchInput,
    onCapture = () => {},
    onState = () => {},
  } = {}) {
    if (!isRecord(identity) || typeof getInstance !== "function" ||
        typeof dispatchInput !== "function" || typeof onCapture !== "function" ||
        typeof onState !== "function") {
      throw new TypeError("Browser performance runtime controller configuration is invalid.");
    }
    this.#identity = deepFreeze(structuredClone(identity));
    this.#clock = clock;
    this.#crypto = cryptoScope;
    this.#getInstance = getInstance;
    this.#dispatchInput = dispatchInput;
    this.#onCapture = onCapture;
    this.#onState = onState;
    this.#bridge = new NativeBrowserPerformanceSourceBridge(getInstance);
  }

  get state() {
    return this.#state;
  }

  get failure() {
    return this.#bridge.failure ?? this.#producer?.failure ?? null;
  }

  moduleCallbacks() {
    return this.#bridge.moduleCallbacks();
  }

  #setState(state, detail = {}) {
    this.#state = state;
    this.#onState(deepFreeze({ state, ...detail }));
  }

  begin({ windowId, challengeSha256 } = {}) {
    if (this.#state !== "idle") {
      throw new BrowserPerformanceRuntimeError(
        "PERFORMANCE_WINDOW_STATE",
        "Browser performance capture supports exactly one window per VM run.",
      );
    }
    const runId = `browser_performance_${String(challengeSha256).slice(0, 32)}`;
    this.#producer = createBrowserPerformanceTraceProducer({
      runId,
      identity: this.#identity,
      clock: this.#clock,
      cryptoScope: this.#crypto,
      scanoutSource: this.#bridge.scanoutSource,
      inputDeliverySource: this.#bridge.inputDeliverySource,
    });
    this.#producer.beginWindow({ windowId, challengeSha256 });
    this.#setState("active", { windowId, challengeSha256 });
    return Object.freeze({ windowId, challengeSha256 });
  }

  async input({ inputId, actionDigest, event } = {}) {
    if (this.#state !== "active" || !validSanitizedInput(event)) {
      throw new BrowserPerformanceRuntimeError(
        "PERFORMANCE_INPUT_STATE",
        "Browser performance input requires an exact sanitized event in an active window.",
      );
    }
    const derivedDigest = await browserPerformanceActionDigest(event, this.#crypto);
    if (derivedDigest !== actionDigest) {
      throw new BrowserPerformanceRuntimeError(
        "PERFORMANCE_INPUT_DIGEST_MISMATCH",
        "Browser performance input digest does not match the exact sanitized event.",
      );
    }
    return this.#producer.sendInput({
      inputId,
      actionDigest,
      kind: event.kind,
      deliverySource: "qemu-virtio-input-ring",
    }, ({ receiptToken }) => {
      const receiptHandle = this.#bridge.bindReceipt(receiptToken);
      try {
        this.#dispatchInput(this.#getInstance(), event, receiptHandle);
      } catch (error) {
        this.#bridge.cancelReceipt(receiptHandle);
        throw error;
      }
    });
  }

  async end() {
    if (this.#state !== "active") {
      throw new BrowserPerformanceRuntimeError(
        "PERFORMANCE_WINDOW_STATE",
        "Only an active browser performance window can end.",
      );
    }
    try {
      await this.#producer.endWindow();
      this.#capture = await this.#producer.exportCapture();
      this.#setState("sealed", { traceSha256: this.#capture.traceSha256 });
      this.#onCapture(this.#capture);
      return this.#capture;
    } catch (error) {
      this.#state = "failed";
      throw error;
    }
  }
}

export function createBrowserPerformanceRuntimeController(options) {
  return new BrowserPerformanceRuntimeController(options);
}
