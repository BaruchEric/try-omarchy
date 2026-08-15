const LEGACY_ASSET_KEYS = ["module", "preload", "data", "locate"];
const PAGED_WORKER_ASSET_KEYS = ["module", "hostWorker", "workerInput", "pagedDisk", "locate", "firmware"];
const SHA256 = /^[a-f0-9]{64}$/;
export const GUEST_REPORT_PREFIX = "OMARCHY_GUEST_REPORT ";
export const RUNTIME_DIAGNOSTIC_PREFIX = "OMARCHY_RUNTIME_DIAGNOSTIC ";

export class RuntimeConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "RuntimeConfigurationError";
  }
}

export function isSafeRelativeAssetPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/")) {
    return false;
  }

  const segments = value.split("/");
  return !segments.includes("..") && !segments.includes("") && !value.includes("\\");
}

function isSafeGuestMountPath(value) {
  return typeof value === "string" && value.startsWith("/pack/") &&
    !value.includes("\\") && !value.includes("\0") && !value.split("/").includes("..");
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new RuntimeConfigurationError("Runtime manifest must be an object.");
  }
  if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) {
    throw new RuntimeConfigurationError(`Unsupported runtime schema: ${manifest.schemaVersion}`);
  }
  if (!manifest.assets || typeof manifest.assets !== "object") {
    throw new RuntimeConfigurationError("Runtime manifest is missing assets.");
  }
  const pagedWorker = manifest.schemaVersion === 2;
  if (pagedWorker && manifest.runtimeMode !== "worker-paged") {
    throw new RuntimeConfigurationError("Schema 2 requires runtimeMode worker-paged.");
  }
  const assetKeys = pagedWorker ? PAGED_WORKER_ASSET_KEYS : LEGACY_ASSET_KEYS;
  for (const key of assetKeys) {
    if (!(key in manifest.assets)) {
      throw new RuntimeConfigurationError(`Runtime manifest is missing assets.${key}.`);
    }
  }
  const pathKeys = pagedWorker
    ? ["module", "hostWorker", "workerInput", "pagedDisk"]
    : ["module", "preload", "data"];
  for (const key of pathKeys) {
    if (!isSafeRelativeAssetPath(manifest.assets[key])) {
      throw new RuntimeConfigurationError(`assets.${key} must be a safe relative path.`);
    }
  }
  if (!manifest.assets.locate || typeof manifest.assets.locate !== "object") {
    throw new RuntimeConfigurationError("assets.locate must be a filename map.");
  }
  for (const [generatedName, deployedName] of Object.entries(manifest.assets.locate)) {
    if (!isSafeRelativeAssetPath(generatedName) || !isSafeRelativeAssetPath(deployedName)) {
      throw new RuntimeConfigurationError("assets.locate contains an unsafe path.");
    }
  }
  if (pagedWorker) {
    if ("preload" in manifest.assets || "data" in manifest.assets) {
      throw new RuntimeConfigurationError("Paged-worker manifests cannot preload a monolithic data bundle.");
    }
    if (!manifest.assets.firmware || typeof manifest.assets.firmware !== "object" || Array.isArray(manifest.assets.firmware)) {
      throw new RuntimeConfigurationError("assets.firmware must be a filename map.");
    }
    for (const required of ["bios-256k.bin", "vgabios-virtio.bin"]) {
      if (!(required in manifest.assets.firmware)) {
        throw new RuntimeConfigurationError(`assets.firmware is missing ${required}.`);
      }
    }
    for (const [guestName, deployedName] of Object.entries(manifest.assets.firmware)) {
      if (!isSafeRelativeAssetPath(guestName) || guestName.includes("/") || !isSafeRelativeAssetPath(deployedName)) {
        throw new RuntimeConfigurationError("assets.firmware contains an unsafe path.");
      }
    }
    for (const key of ["rootfs", "kernel", "initramfs"]) {
      const asset = manifest.guest?.[key];
      if (!asset || !isSafeRelativeAssetPath(asset.artifactPath) || !isSafeGuestMountPath(asset.mountPath)) {
        throw new RuntimeConfigurationError(`guest.${key} must declare safe artifactPath and /pack mountPath values.`);
      }
    }
    if (manifest.checkpoint !== undefined) {
      if (!manifest.checkpoint || typeof manifest.checkpoint !== "object" ||
          manifest.checkpoint.schemaVersion !== 1 || manifest.checkpoint.mode !== "preboot-resume") {
        throw new RuntimeConfigurationError("checkpoint must use schema 1 preboot-resume mode.");
      }
      for (const key of ["vmstate", "bootDelta"]) {
        const artifact = manifest.checkpoint[key];
        if (!artifact || !isSafeRelativeAssetPath(artifact.artifactPath) ||
            !isSafeGuestMountPath(artifact.mountPath) ||
            !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 ||
            !SHA256.test(artifact.sha256 ?? "")) {
          throw new RuntimeConfigurationError(
            `checkpoint.${key} must declare an immutable safe artifact path, mount path, size, and SHA-256.`,
          );
        }
      }
    }
    if (manifest.qemu?.arguments?.includes("-drive") || manifest.qemu?.arguments?.includes("-snapshot")) {
      throw new RuntimeConfigurationError("The paged-disk adapter owns the root drive and snapshot arguments.");
    }
  }
  if (!manifest.qemu || !Array.isArray(manifest.qemu.arguments)) {
    throw new RuntimeConfigurationError("Runtime manifest is missing qemu.arguments.");
  }
  if (manifest.qemu.arguments.length === 0 || !manifest.qemu.arguments.every((value) => typeof value === "string")) {
    throw new RuntimeConfigurationError("qemu.arguments must be a non-empty string array.");
  }
  if (manifest.qemu.arguments.includes("-nographic")) {
    throw new RuntimeConfigurationError("The Omarchy demo cannot use QEMU's headless mode.");
  }

  const displayIndex = manifest.qemu.arguments.indexOf("-display");
  if (displayIndex < 0 || !manifest.qemu.arguments[displayIndex + 1]?.startsWith("sdl")) {
    throw new RuntimeConfigurationError("The browser spike requires QEMU's SDL display frontend.");
  }
  const deviceValues = manifest.qemu.arguments
    .map((value, index, values) => value === "-device" ? values[index + 1] : undefined)
    .filter(Boolean);
  const vgaIndex = manifest.qemu.arguments.indexOf("-vga");
  const hasGraphicalAdapter = deviceValues.some((value) =>
    value.startsWith("virtio-vga") || value === "VGA" || value.startsWith("bochs-display"),
  ) || (vgaIndex >= 0 && manifest.qemu.arguments[vgaIndex + 1] === "std");
  if (!hasGraphicalAdapter) {
    throw new RuntimeConfigurationError("The browser spike requires a supported graphical display adapter.");
  }
  if (!Number.isInteger(manifest.qemu.memoryMiB) || manifest.qemu.memoryMiB < 512 || manifest.qemu.memoryMiB > 1792) {
    throw new RuntimeConfigurationError("qemu.memoryMiB must be an integer between 512 and 1792.");
  }
  if (!Number.isInteger(manifest.qemu.cores) || manifest.qemu.cores < 1 || manifest.qemu.cores > 4) {
    throw new RuntimeConfigurationError("qemu.cores must be an integer between 1 and 4.");
  }

  return manifest;
}

function supportsSharedWasmMemory(webAssembly, SharedArrayBufferConstructor) {
  try {
    if (!webAssembly?.Memory) return false;
    const memory = new webAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    return memory.buffer instanceof SharedArrayBufferConstructor;
  } catch {
    return false;
  }
}

export function inspectBrowserCapabilities(scope = globalThis) {
  const checks = {
    webAssembly: typeof scope.WebAssembly === "object",
    workers: typeof scope.Worker === "function",
    sharedArrayBuffer: typeof scope.SharedArrayBuffer === "function",
    atomics: typeof scope.Atomics === "object",
    crossOriginIsolated: scope.crossOriginIsolated === true,
    offscreenCanvas: typeof scope.OffscreenCanvas === "function" ||
      typeof scope.HTMLCanvasElement?.prototype?.transferControlToOffscreen === "function",
  };

  checks.wasmThreads = checks.sharedArrayBuffer && supportsSharedWasmMemory(scope.WebAssembly, scope.SharedArrayBuffer);
  const missing = Object.entries(checks)
    .filter(([, supported]) => !supported)
    .map(([name]) => name);

  return { supported: missing.length === 0, checks, missing };
}

export function formatCapabilityError(report) {
  const explanations = {
    webAssembly: "WebAssembly is unavailable",
    workers: "Web Workers are unavailable",
    sharedArrayBuffer: "SharedArrayBuffer is unavailable",
    atomics: "Atomics are unavailable",
    crossOriginIsolated: "the page is missing COOP/COEP isolation headers",
    offscreenCanvas: "OffscreenCanvas is unavailable",
    wasmThreads: "shared WebAssembly memory is unavailable",
  };
  return report.missing.map((key) => explanations[key] ?? key).join("; ");
}

export function parseGuestReportLine(line) {
  if (typeof line !== "string") return null;
  const marker = line.indexOf(GUEST_REPORT_PREFIX);
  if (marker < 0) return null;
  if (line.indexOf(GUEST_REPORT_PREFIX, marker + GUEST_REPORT_PREFIX.length) >= 0) {
    throw new SyntaxError("Guest report line contains more than one evidence marker.");
  }

  const payloadStart = marker + GUEST_REPORT_PREFIX.length;
  const lineEnd = line.slice(payloadStart).search(/[\r\n]/);
  const payloadEnd = lineEnd < 0 ? line.length : payloadStart + lineEnd;
  const trailing = line.slice(payloadEnd);
  if (/[^\r\n]/.test(trailing)) {
    throw new SyntaxError("Guest report line contains data after its line ending.");
  }

  const payload = JSON.parse(line.slice(payloadStart, payloadEnd));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("Guest report payload must be a JSON object.");
  }
  return payload;
}

export function parseRuntimeDiagnosticLine(line) {
  if (typeof line !== "string" || !line.startsWith(RUNTIME_DIAGNOSTIC_PREFIX)) {
    return null;
  }
  const message = line.slice(RUNTIME_DIAGNOSTIC_PREFIX.length).trim();
  const separator = message.indexOf(" ");
  return {
    stage: separator < 0 ? message : message.slice(0, separator),
    message: separator < 0 ? "" : message.slice(separator + 1),
  };
}

function loadClassicScript(documentObject, url) {
  return new Promise((resolve, reject) => {
    const script = documentObject.createElement("script");
    script.src = url;
    script.async = true;
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", () => reject(new Error(`Failed to load ${url}`)), { once: true });
    documentObject.head.append(script);
  });
}

function assetUrl(baseUrl, path) {
  return new URL(path, baseUrl).href;
}

export class OmarchyWasmRuntime extends EventTarget {
  #baseUrl;
  #canvas;
  #fetch;
  #document;
  #scope;
  #instance;
  #phase = "idle";
  #frameSequence = 0;

  constructor({ baseUrl, canvas, fetch, document = globalThis.document, scope = globalThis } = {}) {
    super();
    if (!(canvas instanceof scope.HTMLCanvasElement)) {
      throw new TypeError("canvas must be an HTMLCanvasElement.");
    }
    this.#baseUrl = new URL(baseUrl ?? "./", document.baseURI);
    this.#canvas = canvas;
    const fetchFunction = fetch ?? scope.fetch ?? globalThis.fetch;
    if (typeof fetchFunction !== "function") {
      throw new TypeError("fetch must be a function.");
    }
    this.#fetch = fetchFunction.bind(scope);
    this.#document = document;
    this.#scope = scope;
  }

  get phase() {
    return this.#phase;
  }

  get instance() {
    return this.#instance;
  }

  #setPhase(phase, detail = {}) {
    this.#phase = phase;
    this.dispatchEvent(new CustomEvent("phasechange", { detail: { phase, ...detail } }));
  }

  #emitDiagnostic(stage, detail = {}) {
    this.dispatchEvent(new CustomEvent("runtimediagnostic", { detail: { stage, ...detail } }));
  }

  async start() {
    if (this.#phase !== "idle") {
      throw new Error(`Runtime cannot start from phase ${this.#phase}.`);
    }

    const capabilities = inspectBrowserCapabilities(this.#scope);
    if (!capabilities.supported) {
      this.#setPhase("unsupported", { capabilities });
      throw new Error(`This browser cannot run the threaded VM: ${formatCapabilityError(capabilities)}.`);
    }

    this.#setPhase("loading-manifest");
    const manifestUrl = assetUrl(this.#baseUrl, "runtime-manifest.json");
    const response = await this.#fetch(manifestUrl, { credentials: "same-origin" });
    if (!response.ok) {
      throw new Error(`Runtime manifest request failed with HTTP ${response.status}.`);
    }
    const manifest = validateManifest(await response.json());

    this.#canvas.width = manifest.display.width;
    this.#canvas.height = manifest.display.height;

    const locate = manifest.assets.locate;
    const emitSerial = (stream, line) => {
      this.dispatchEvent(new CustomEvent("serial", { detail: { stream, line } }));
      const diagnostic = parseRuntimeDiagnosticLine(line);
      if (diagnostic) {
        this.#emitDiagnostic(diagnostic.stage, { ...diagnostic, stream, line });
      }
      try {
        const report = parseGuestReportLine(line);
        if (report) {
          this.dispatchEvent(new CustomEvent("guestreport", { detail: report }));
        }
      } catch (error) {
        this.dispatchEvent(new CustomEvent("guestreporterror", {
          detail: { line, error: error instanceof Error ? error.message : String(error) },
        }));
      }
    };
    const moduleOptions = {
      arguments: [...manifest.qemu.arguments],
      canvas: this.#canvas,
      preRun: [],
      locateFile: (generatedName) => assetUrl(this.#baseUrl, locate[generatedName] ?? generatedName),
      mainScriptUrlOrBlob: assetUrl(this.#baseUrl, manifest.assets.module),
      print: (line) => emitSerial("stdout", line),
      printErr: (line) => emitSerial("stderr", line),
      onGuestFrame: (guestWidth, guestHeight) => {
        this.#frameSequence += 1;
        this.dispatchEvent(new CustomEvent("guestframe", {
          detail: {
            sequence: this.#frameSequence,
            source: "qemu-guest",
            guestWidth,
            guestHeight,
            timestamp: this.#scope.performance?.now?.() ?? Date.now(),
          },
        }));
      },
      onRuntimeInitialized: () => this.#emitDiagnostic("emscripten-runtime-initialized"),
      monitorRunDependencies: (remaining) => this.#emitDiagnostic("run-dependencies", { remaining }),
      onExit: (status) => {
        this.#emitDiagnostic("process-exit", { status });
        this.#setPhase("exited", { status });
      },
      onAbort: (reason) => {
        this.#emitDiagnostic("process-abort", { reason: String(reason) });
        this.#setPhase("failed", { reason: String(reason) });
      },
    };

    const emitHostError = (kind) => (event) => {
      const reason = event?.error ?? event?.reason ?? event?.message ?? "unknown browser error";
      const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
      this.#emitDiagnostic(kind, {
        reason: message,
      });
      if (this.#phase === "starting-emulator" || this.#phase === "running") {
        this.#setPhase("failed", { reason: message, source: kind });
      }
    };
    this.#scope.addEventListener?.("error", emitHostError("browser-error"));
    this.#scope.addEventListener?.("unhandledrejection", emitHostError("unhandled-rejection"));

    // Emscripten's generated file packager is a classic script and discovers
    // this object through the global Module binding.
    this.#scope.Module = moduleOptions;
    this.#setPhase("loading-guest");
    await loadClassicScript(this.#document, assetUrl(this.#baseUrl, manifest.assets.preload));
    this.#emitDiagnostic("preload-registered", {
      preRunHooks: moduleOptions.preRun.length,
      expectedDownloads: moduleOptions.expectedDataFileDownloads ?? 0,
    });

    this.#setPhase("starting-emulator");
    const { default: createQemu } = await import(assetUrl(this.#baseUrl, manifest.assets.module));
    if (typeof createQemu !== "function") {
      throw new Error("The QEMU module does not export an Emscripten factory.");
    }
    this.#instance = await createQemu(moduleOptions);
    this.#emitDiagnostic("factory-resolved", {
      canvasTransferred: this.#canvas.controlTransferredOffscreen === true,
    });
    if (this.#phase !== "failed") {
      this.#setPhase("running");
    }
    this.#canvas.focus({ preventScroll: true });
    return this.#instance;
  }

  requestReset() {
    this.dispatchEvent(new CustomEvent("reloadrequired", {
      detail: { reason: "The QEMU-Wasm fork does not expose safe worker termination; reload the page to reset." },
    }));
    return false;
  }
}
