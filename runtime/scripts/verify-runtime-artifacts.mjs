#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_CHECKPOINT_IDENTITY,
  validateProductionManifest,
} from "../web/production-worker.mjs";

const WASM_PAGE_BYTES = 64 * 1024;
const EXPECTED_INITIAL_MEMORY_MIB = 2300;
const EXPECTED_TCG_EXPERIMENTS = Object.freeze({
  "250": Object.freeze({
    kind: "qemu-wasm-tcg-hot-threshold",
    instantiateThreshold: 250,
    metricsSchemaVersion: 1,
  }),
  "750": Object.freeze({
    kind: "qemu-wasm-tcg-hot-threshold",
    instantiateThreshold: 750,
    metricsSchemaVersion: 2,
  }),
  "1500-metrics": Object.freeze({
    kind: "qemu-wasm-tcg-baseline-metrics",
    instantiateThreshold: 1500,
    metricsSchemaVersion: 2,
  }),
  "1500-clock": Object.freeze({
    kind: "qemu-wasm-tcg-bounded-clock",
    instantiateThreshold: 1500,
    metricsSchemaVersion: 4,
    cachePolicy: Object.freeze({
      kind: "bounded-clock-v2",
      activeCap: 60000,
      replacementCredit: 4096,
      retainedCap: 64096,
      gcPressureBytes: 4 * 1024 * 1024,
      gcPressureInterval: 64,
      gcPressureRetryMilliseconds: 1000,
      gcPressureHold: "next-task",
    }),
    cachePolicyMarker:
      "cache=bounded-clock-v2 active-cap=60000 replacement-credit=4096 " +
      "retained-cap=64096 gc-pressure-bytes=4194304 gc-pressure-interval=64 " +
      "gc-pressure-retry-ms=1000 gc-pressure-hold=next-task",
  }),
  "6000-fill": Object.freeze({
    kind: "qemu-wasm-tcg-fill-only",
    instantiateThreshold: 6000,
    metricsSchemaVersion: 5,
    cachePolicy: Object.freeze({
      kind: "fill-only-v1",
      activeCap: 120000,
      retainedCap: 120000,
      eviction: "disabled",
      gcPressure: "disabled",
    }),
    cachePolicyMarker:
      "cache=fill-only-v1 active-cap=120000 retained-cap=120000 " +
      "eviction=disabled gc-pressure=disabled",
  }),
});
const TCG_EXPERIMENT_MARKER_PREFIX =
  "OMARCHY_RUNTIME_DIAGNOSTIC wasm32-tcg-experiment threshold=";
const TCG_METRICS_MARKER = "OMARCHY_RUNTIME_DIAGNOSTIC wasm32-tcg-metrics ";
const VIRGL_GRAPHICS_EXPERIMENT = "virgl-webgl2";
const WEBGL2_PRESENT_EXPERIMENT = "webgl2-present";
const HIBERNATION_MODE = "guest-hibernation-resume";
const HIBERNATION_REPORT_PREFIX = "OMARCHY_HIBERNATION_REPORT ";
const HIBERNATION_ROOT_DELTA_NAME = "hibernate-root-overlay.qcow2";
const HIBERNATION_SWAP_NAME = "omarchy-hibernate.qcow2";
const GRAPHICS_EXPERIMENTS = new Set([
  VIRGL_GRAPHICS_EXPERIMENT,
  WEBGL2_PRESENT_EXPERIMENT,
]);

function experimentalTcgProfile() {
  const value = process.env.OMARCHY_TCG_HOT_THRESHOLD_EXPERIMENT;
  if (value === undefined || value === "") return null;
  const profile = EXPECTED_TCG_EXPERIMENTS[value];
  assert.ok(profile, "unsupported QEMU-Wasm TCG threshold experiment");
  return profile;
}

function graphicsExperiment() {
  const value = process.env.OMARCHY_GRAPHICS_EXPERIMENT;
  if (value === undefined || value === "") return null;
  assert.ok(GRAPHICS_EXPERIMENTS.has(value), "unsupported QEMU-Wasm graphics experiment");
  return value;
}

function vcpuExperiment() {
  const value = process.env.OMARCHY_VCPU_EXPERIMENT;
  if (value === undefined || value === "") return null;
  assert.ok(value === "1" || value === "4", "unsupported browser vCPU experiment");
  return Number(value);
}

export function graphicsExperimentWorkerIdentityMatches(
  productionWorker,
  graphics,
  wasmSha256,
) {
  const graphicsMarker =
    `// OMARCHY_EXPERIMENT qemu-wasm-graphics kind=${graphics} ` +
    `promotion-eligible=false qemu-wasm-sha256=${wasmSha256}\n`;
  const expectedDevice = graphics === VIRGL_GRAPHICS_EXPERIMENT
    ? "virtio-vga-gl,max_outputs=1,xres=1600,yres=900"
    : "virtio-vga,max_outputs=1,xres=1600,yres=900";
  const rejectedDevice = graphics === VIRGL_GRAPHICS_EXPERIMENT
    ? "virtio-vga,max_outputs=1,xres=1600,yres=900"
    : "virtio-vga-gl,max_outputs=1,xres=1600,yres=900";
  const webglDisplay = '"sdl,gl=es,show-cursor=on"';
  const softwareDisplay = '"sdl,gl=off,show-cursor=on"';
  const armDevice = '"virtio-gpu-pci,max_outputs=1,xres=1600,yres=900"';
  return productionWorker.split(graphicsMarker).length - 1 === 1 &&
    productionWorker.includes(webglDisplay) &&
    productionWorker.split(softwareDisplay).length - 1 === 1 &&
    productionWorker.split(armDevice).length - 1 === 1 &&
    productionWorker.includes(`"${expectedDevice}"`) &&
    !productionWorker.includes(`"${rejectedDevice}"`) &&
    (graphics !== WEBGL2_PRESENT_EXPERIMENT ||
      productionWorker.includes(`browserQemuWasmSha256: "${wasmSha256}"`));
}

function replaceArgumentExactlyOnce(arguments_, from, to, label) {
  const indexes = arguments_.flatMap((value, index) => value === from ? [index] : []);
  assert.equal(indexes.length, 1, `${label} must occur exactly once`);
  arguments_[indexes[0]] = to;
}

function validateRuntimeManifest(manifest, threshold, graphics, vcpus) {
  if (manifest.schemaVersion !== 2) return;
  const canonicalShape = structuredClone(manifest);
  const hibernation = canonicalShape.checkpoint?.mode === HIBERNATION_MODE;
  if (vcpus !== null) {
    assert.equal(canonicalShape.qemu.cores, vcpus, "experimental vCPU manifest metadata is missing");
    canonicalShape.qemu.cores = 2;
    replaceArgumentExactlyOnce(
      canonicalShape.qemu.arguments,
      `${vcpus},sockets=1,cores=${vcpus},threads=1`,
      "2,sockets=1,cores=2,threads=1",
      "experimental SMP profile",
    );
  }
  if (graphics === VIRGL_GRAPHICS_EXPERIMENT) {
    if (hibernation) {
      assert.equal(
        canonicalShape.checkpoint.rootDelta.artifactPath,
        HIBERNATION_ROOT_DELTA_NAME,
        "hibernation root delta name is invalid",
      );
      assert.equal(
        canonicalShape.checkpoint.swapImage.artifactPath,
        HIBERNATION_SWAP_NAME,
        "hibernation swap image name is invalid",
      );
      validateProductionManifest(canonicalShape);
      return;
    }
    assert.equal(manifest.checkpoint, undefined, "VirGL/WebGL2 requires cold boot or authenticated guest hibernation");
    replaceArgumentExactlyOnce(
      canonicalShape.qemu.arguments,
      "sdl,gl=es,show-cursor=on",
      "sdl,gl=off,show-cursor=on",
      "VirGL display profile",
    );
    replaceArgumentExactlyOnce(
      canonicalShape.qemu.arguments,
      "virtio-vga-gl,max_outputs=1,xres=1600,yres=900",
      "virtio-vga,max_outputs=1,xres=1600,yres=900",
      "VirGL device profile",
    );
    validateProductionManifest(canonicalShape);
    return;
  }
  if (graphics === WEBGL2_PRESENT_EXPERIMENT) {
    replaceArgumentExactlyOnce(
      canonicalShape.qemu.arguments,
      "sdl,gl=es,show-cursor=on",
      "sdl,gl=off,show-cursor=on",
      "WebGL2 presentation profile",
    );
    if (canonicalShape.checkpoint !== undefined) {
      canonicalShape.checkpoint.identity.browserQemuWasmSha256 =
        CANONICAL_CHECKPOINT_IDENTITY.browserQemuWasmSha256;
    }
    validateProductionManifest(canonicalShape);
    return;
  }
  if (threshold === null || manifest.checkpoint === undefined) {
    validateProductionManifest(canonicalShape);
    return;
  }
  canonicalShape.checkpoint.identity.browserQemuWasmSha256 =
    CANONICAL_CHECKPOINT_IDENTITY.browserQemuWasmSha256;
  validateProductionManifest(canonicalShape);
}

function readUnsignedLeb128(bytes, start) {
  let offset = start;
  let value = 0;
  let multiplier = 1;
  for (let index = 0; index < 5; index += 1) {
    assert.ok(offset < bytes.length, "truncated unsigned LEB128 value");
    const byte = bytes[offset++];
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return { value, offset };
    multiplier *= 128;
  }
  throw new Error("unsigned LEB128 value exceeds the wasm32 range");
}

function readName(bytes, start) {
  const length = readUnsignedLeb128(bytes, start);
  const end = length.offset + length.value;
  assert.ok(end <= bytes.length, "truncated WebAssembly name");
  return { value: bytes.subarray(length.offset, end).toString("utf8"), offset: end };
}

function readLimits(bytes, start) {
  const flags = readUnsignedLeb128(bytes, start);
  const initial = readUnsignedLeb128(bytes, flags.offset);
  let offset = initial.offset;
  let maximum = null;
  if ((flags.value & 1) !== 0) {
    const decodedMaximum = readUnsignedLeb128(bytes, offset);
    maximum = decodedMaximum.value;
    offset = decodedMaximum.offset;
  }
  return {
    flags: flags.value,
    initial: initial.value,
    maximum,
    shared: (flags.value & 2) !== 0,
    memory64: (flags.value & 4) !== 0,
    offset,
  };
}

export function parseImportedMemories(bytes) {
  assert.ok(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, "WebAssembly input must be bytes");
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.deepEqual([...buffer.subarray(0, 8)], [0, 97, 115, 109, 1, 0, 0, 0], "invalid WebAssembly header");

  let offset = 8;
  const memories = [];
  while (offset < buffer.length) {
    const sectionId = buffer[offset++];
    const sectionLength = readUnsignedLeb128(buffer, offset);
    offset = sectionLength.offset;
    const sectionEnd = offset + sectionLength.value;
    assert.ok(sectionEnd <= buffer.length, "truncated WebAssembly section");
    if (sectionId !== 2) {
      offset = sectionEnd;
      continue;
    }

    const count = readUnsignedLeb128(buffer, offset);
    offset = count.offset;
    for (let index = 0; index < count.value; index += 1) {
      const moduleName = readName(buffer, offset);
      const fieldName = readName(buffer, moduleName.offset);
      offset = fieldName.offset;
      const kind = buffer[offset++];
      if (kind === 0) {
        offset = readUnsignedLeb128(buffer, offset).offset;
      } else if (kind === 1) {
        offset += 1;
        offset = readLimits(buffer, offset).offset;
      } else if (kind === 2) {
        const limits = readLimits(buffer, offset);
        offset = limits.offset;
        memories.push({ module: moduleName.value, name: fieldName.value, ...limits, offset: undefined });
      } else if (kind === 3) {
        offset += 2;
      } else if (kind === 4) {
        offset += 1;
        offset = readUnsignedLeb128(buffer, offset).offset;
      } else {
        throw new Error(`unsupported WebAssembly import kind ${kind}`);
      }
    }
    assert.equal(offset, sectionEnd, "WebAssembly import section length mismatch");
  }
  return memories;
}

export function verifyCheckpointWasmIdentity(manifest, wasm) {
  if (manifest?.checkpoint === undefined) return null;
  const actual = createHash("sha256").update(wasm).digest("hex");
  assert.equal(
    actual,
    manifest.checkpoint?.identity?.browserQemuWasmSha256,
    "checkpoint profile is bound to a different browser QEMU Wasm binary",
  );
  return actual;
}

export function inspectWebgl2ArtifactPlumbing(moduleSource, wasm) {
  assert.equal(typeof moduleSource, "string", "generated QEMU module source must be text");
  assert.ok(
    Buffer.isBuffer(wasm) || wasm instanceof Uint8Array,
    "generated QEMU WebAssembly must be bytes",
  );
  const wasmBytes = Buffer.from(wasm.buffer, wasm.byteOffset, wasm.byteLength);
  return Object.freeze({
    webgl2Context: moduleSource.includes(
      'canvas.getContext("webgl2",webGLContextAttributes)',
    ),
    framebufferBlit: moduleSource.includes("GLctx.blitFramebuffer("),
    drawBuffers: moduleSource.includes("GLctx.drawBuffers("),
    presentCadence: wasmBytes.includes(Buffer.from("webgl2-present-cadence")),
  });
}

export async function verifyRuntimeArtifacts(outputDirectory) {
  const manifest = JSON.parse(await readFile(join(outputDirectory, "runtime-manifest.json"), "utf8"));
  const tcgExperiment = experimentalTcgProfile();
  const requestedGraphics = graphicsExperiment();
  const vcpus = vcpuExperiment();
  const hibernation = manifest.checkpoint?.mode === HIBERNATION_MODE;
  assert.ok(
    !hibernation || requestedGraphics === null || requestedGraphics === VIRGL_GRAPHICS_EXPERIMENT,
    "guest hibernation requires the VirGL/WebGL2 runtime profile",
  );
  assert.ok(!hibernation || vcpus === null, "guest hibernation requires its exact two-vCPU restore topology");
  const graphics = hibernation ? VIRGL_GRAPHICS_EXPERIMENT : requestedGraphics;
  assert.ok(
    tcgExperiment === null || graphics === null ||
      ([750, 1500, 6000].includes(tcgExperiment.instantiateThreshold) &&
        graphics === VIRGL_GRAPHICS_EXPERIMENT),
    "only an instrumented VirGL-compatible TCG profile may be combined with VirGL/WebGL2",
  );
  assert.ok(
    vcpus === null ||
      ([1, 4].includes(vcpus) && [750, 6000].includes(tcgExperiment?.instantiateThreshold) &&
        graphics === VIRGL_GRAPHICS_EXPERIMENT),
    "the browser vCPU experiment requires VirGL/WebGL2 plus a compatible instrumented TCG profile",
  );
  const tcgThreshold = tcgExperiment?.instantiateThreshold ?? null;
  validateRuntimeManifest(manifest, tcgThreshold, graphics, vcpus);
  const modulePath = manifest.assets?.module;
  const wasmPath = manifest.assets?.locate?.["qemu-system-x86_64.wasm"];
  const pthreadPath = manifest.assets?.locate?.["qemu-system-x86_64.worker.js"];
  const productionPaths = manifest.schemaVersion === 2
    ? [
        manifest.assets.hostWorker,
        manifest.assets.workerInput,
        manifest.assets.pagedDisk,
        manifest.assets.boundedOverlay,
      ]
    : [];
  const required = ["runtime.mjs", "runtime-manifest.json", modulePath, wasmPath, pthreadPath, ...productionPaths];
  const sizes = {};
  for (const relativePath of required) {
    const info = await stat(join(outputDirectory, relativePath));
    assert.ok(info.isFile() && info.size > 0, `${relativePath} is missing or empty`);
    sizes[relativePath] = info.size;
  }

  const wasm = await readFile(join(outputDirectory, wasmPath));
  const wasmSha256 = createHash("sha256").update(wasm).digest("hex");
  assert.equal(WebAssembly.validate(wasm), true, "qemu.wasm does not validate");
  const memory = parseImportedMemories(wasm).find(({ shared }) => shared);
  assert.ok(memory, "qemu.wasm does not import shared memory");
  assert.equal(memory.memory64, false, "the runtime requires wasm32 shared memory");
  assert.ok(memory.maximum !== null, "shared WebAssembly memory requires a maximum");
  const initialMiB = (memory.initial * WASM_PAGE_BYTES) / (1024 * 1024);
  assert.equal(initialMiB, EXPECTED_INITIAL_MEMORY_MIB, "unexpected initial WebAssembly memory");
  assert.ok(wasm.includes(Buffer.from("qcow2")), "linked QEMU binary has no qcow2 driver marker for -snapshot");
  assert.ok(
    wasm.includes(Buffer.from("worker-dom-cursor-hooks-disabled")),
    "linked QEMU binary does not disable DOM-only SDL cursor hooks in the outer Worker",
  );
  verifyCheckpointWasmIdentity(manifest, wasm);
  assert.ok(
    wasm.includes(Buffer.from("wasm32-tcg-thread-initialized mode=rr")),
    "linked QEMU binary does not initialize the Wasm translator on the single-thread TCG path",
  );
  assert.ok(
    wasm.includes(Buffer.from("wasm32-tcg-core-layout-invalid")),
    "linked QEMU binary does not guard browser/guest vCPU layout bounds",
  );
  if (tcgExperiment !== null) {
    const experimentMarker = `${TCG_EXPERIMENT_MARKER_PREFIX}${tcgThreshold} ` +
      `metrics-schema=${tcgExperiment.metricsSchemaVersion}`;
    assert.ok(
      wasm.includes(Buffer.from(experimentMarker)),
      "linked QEMU binary is not the requested TCG experiment",
    );
    assert.ok(
      wasm.includes(Buffer.from(TCG_METRICS_MARKER)),
      "linked QEMU binary does not include bounded TCG performance metrics",
    );
    if (tcgExperiment.cachePolicyMarker !== undefined) {
      assert.ok(
        wasm.includes(Buffer.from(tcgExperiment.cachePolicyMarker)),
        "linked QEMU binary does not include the requested TCG cache policy",
      );
    }
  } else {
    assert.equal(
      wasm.includes(Buffer.from(TCG_EXPERIMENT_MARKER_PREFIX)),
      false,
      "experimental TCG QEMU requires explicit experiment verification",
    );
  }
  if (graphics !== null) {
    assert.ok(wasm.includes(Buffer.from("virtio-vga-gl")), "linked QEMU has no virtio-vga-gl device");
    assert.ok(wasm.includes(Buffer.from("virgl")), "linked QEMU has no VirGL renderer marker");
  }

  const moduleSource = await readFile(join(outputDirectory, modulePath), "utf8");
  const workerSource = await readFile(join(outputDirectory, pthreadPath), "utf8");
  const sourceChecks = {
    esModuleFactory: /export\s+default/.test(moduleSource),
    filesystemExport: /["']FS["']/.test(moduleSource),
    framebufferProxy: moduleSource.includes("blitOffscreenFramebuffer"),
    ...(graphics !== null ? {
      webglCanvasTransferredToPthread: moduleSource.includes("transferredCanvasNames==4294967295") &&
        moduleSource.includes('Module["canvas"]instanceof OffscreenCanvas&&!Module["canvas"].id') &&
        moduleSource.includes('offscreenCanvasInfo={offscreenCanvas:Module["canvas"]'),
    } : {
      canvasTransferDisabled: !moduleSource.includes("transferredCanvasNames==4294967295"),
    }),
    workerScreenSize: moduleSource.includes("omarchyWorkerScreenDimension") &&
      !/function _emscripten_get_screen_size\([^)]*\)\{[^}]*=screen\.width/.test(moduleSource),
    workerDomEventRegistrations: /function _emscripten_set_pointerlockchange_callback_on_thread\([^)]*\)\{[^}]*return-1\}/
      .test(moduleSource) &&
      /function _emscripten_set_fullscreenchange_callback_on_thread\([^)]*\)\{[^}]*return-1\}/.test(moduleSource),
    workerBrowserInit: moduleSource.includes(
      'var canvas=Module["canvas"];if(canvas&&typeof document!="undefined"){canvas.requestPointerLock=',
    ),
    workerWindowTitle: /function _emscripten_set_window_title\([^)]*\)\{[^}]*typeof document!={1,2}"undefined"[^}]*document\.title/
      .test(moduleSource),
    workerCanvasSizing: moduleSource.includes(
      "OMARCHY_RUNTIME_DIAGNOSTIC worker-canvas-css-size width=1 height=1",
    ) && /function _emscripten_set_canvas_element_size\([^)]*\)\{[^}]*Module\["canvas"\]/
      .test(moduleSource),
    guestFrameHook: moduleSource.includes("onGuestFrame"),
    guestFrameSampling: /\(\$0,\$1,\$2,\$3,\$4,\$5,\$6\)=>\{[^}]*Module\["onGuestFrame"\]\(\$0,\$1,\$2,\$3,\$4,\$5,\$6\)/
      .test(moduleSource),
    offscreenCanvas: /OffscreenCanvas|offscreenCanvas/.test(moduleSource + workerSource),
    pthreadRuntime: /PThread|pthread/.test(moduleSource + workerSource),
    workerReference: /worker\.js/.test(moduleSource),
    verifiedBlobPthreadSupport: moduleSource.includes("new Worker(pthreadMainJs") &&
      moduleSource.includes('"urlOrBlob":Module["mainScriptUrlOrBlob"]') &&
      workerSource.includes("import(e.data.urlOrBlob)"),
    pthreadBlobSafeWasmResolution: moduleSource.includes(
      'if(ENVIRONMENT_IS_PTHREAD){wasmBinaryFile="qemu-system-x86_64.wasm"}else if(Module["locateFile"]){',
    ) && !moduleSource.includes('var wasmBinaryFile;if(Module["locateFile"]){') &&
      workerSource.includes('Module["instantiateWasm"]') &&
      moduleSource.includes('"wasmModule":wasmModule'),
    nestedTcgModuleLayoutGuard:
      moduleSource.includes("OMARCHY_TCG_MODULE_LAYOUT_INVALID") &&
      moduleSource.includes("OMARCHY_TCG_MODULE_MAGIC_INVALID"),
    ...(tcgExperiment?.cachePolicy?.kind === "bounded-clock-v2" ? {
      tcgGcPressureNextTask:
        moduleSource.includes("gc_pressure=pressure;setTimeout(") &&
        !moduleSource.includes("gc_pressure=pressure;queueMicrotask("),
    } : tcgExperiment?.cachePolicy?.kind === "fill-only-v1" ? {
      tcgFillOnlyNoGcPressure:
        !moduleSource.includes("gc_pressure=pressure;setTimeout(") &&
        !moduleSource.includes("gc_pressure=pressure;queueMicrotask("),
    } : {}),
  };
  if (manifest.schemaVersion === 2) {
    const productionWorker = await readFile(join(outputDirectory, manifest.assets.hostWorker), "utf8");
    const inputBridge = await readFile(join(outputDirectory, manifest.assets.workerInput), "utf8");
    const packagedPagedDisk = await readFile(join(outputDirectory, manifest.assets.pagedDisk));
    const canonicalPagedDisk = await readFile(join(runtimeDirectory, "..", "storage", "paged-disk.mjs"));
    assert.deepEqual(packagedPagedDisk, canonicalPagedDisk, "packaged paged disk differs from storage/paged-disk.mjs");
    const packagedBoundedOverlay = await readFile(join(outputDirectory, manifest.assets.boundedOverlay));
    const canonicalBoundedOverlay = await readFile(join(runtimeDirectory, "..", "storage", "bounded-overlay.mjs"));
    assert.deepEqual(
      packagedBoundedOverlay,
      canonicalBoundedOverlay,
      "packaged bounded overlay differs from storage/bounded-overlay.mjs",
    );
    sourceChecks.outerWorker = productionWorker.includes("preparePagedDisk") &&
      productionWorker.includes("loading-artifact-manifest") && productionWorker.includes("guestframe") &&
      productionWorker.includes("wasmBinary: executables.wasmFile.bytes") &&
      productionWorker.includes("mainScriptUrlOrBlob: executables.urls.module") &&
      productionWorker.includes("return executables.urls.locate[generatedName]") &&
      productionWorker.includes("readBoundedResponseBody") &&
      productionWorker.includes("MAX_BOOTSTRAP_BYTES") &&
      productionWorker.includes("Guest emitted more than one evidence report") &&
      productionWorker.includes("sampledPixels") && productionWorker.includes("nonBlackPixels") &&
      productionWorker.includes("desktopproof") && productionWorker.includes("challengeSha256") &&
      productionWorker.includes("baselineSequence") && productionWorker.includes("responseSequence") &&
      productionWorker.includes("DESKTOP_PROOF_MIN_CHANGED_PIXELS") &&
      productionWorker.includes("DESKTOP_PROOF_MAX_DOMINANT_PIXELS") &&
      productionWorker.includes("dominantPixels < 1") &&
      productionWorker.includes("DESKTOP_PROOF_STAGE_TIMEOUT_MS = 90_000") &&
      productionWorker.includes("DESKTOP_PROOF_RESPONSE_TIMEOUT_MS = 180_000") &&
      productionWorker.includes("CHECKPOINT_DESKTOP_SETTLE_MIN_RUNNING_MS = 15_000") &&
      productionWorker.includes("CHECKPOINT_DESKTOP_SETTLE_MIN_FRAME_GAP_MS = 5_000") &&
      productionWorker.includes("CHECKPOINT_DESKTOP_SETTLE_TIMEOUT") &&
      productionWorker.includes("HIBERNATION_RESUME_TIMEOUT_MS = 600_000") &&
      productionWorker.includes("HIBERNATION_GUEST_REPORT_TIMEOUT_MS = 900_000") &&
      productionWorker.includes("DESKTOP_PROOF_DIGEST_TIMEOUT") &&
      productionWorker.includes("#commandInputComplete") &&
      productionWorker.includes("DESKTOP_PROOF_LIVENESS_TIMEOUT") &&
      productionWorker.includes("_omarchy_desktop_proof_arm") &&
      productionWorker.includes("_omarchy_desktop_proof_expect_response") &&
      productionWorker.includes("_omarchy_runtime_is_running") &&
      productionWorker.includes("qemu-running-wait-start") &&
      productionWorker.includes("_omarchy_input_release_modifiers") &&
      productionWorker.includes("GUEST_PROVENANCE_MISMATCH") &&
      productionWorker.includes('this.#post("release", this.#releaseIdentity)') &&
      productionWorker.includes("disk.overlayPreRun") &&
      productionWorker.includes("checkpointPagedFiles") &&
      productionWorker.includes("CHECKPOINT_TOTAL_CACHE_BYTES") &&
      productionWorker.includes('"-incoming"') &&
      productionWorker.includes('"file:/pack/omarchy-preboot.vmstate"') &&
      productionWorker.includes("validateCheckpointArtifacts") &&
      productionWorker.includes("validateCheckpointSourceEvidence") &&
      productionWorker.includes("checkpoint-source-evidence") &&
      productionWorker.includes("CHECKPOINT_REPORT_REPLAY") &&
      productionWorker.includes(HIBERNATION_REPORT_PREFIX) &&
      productionWorker.includes(HIBERNATION_MODE) &&
      productionWorker.includes(HIBERNATION_ROOT_DELTA_NAME) &&
      productionWorker.includes(HIBERNATION_SWAP_NAME) &&
      productionWorker.includes("live-hibernation-serial") &&
      productionWorker.includes('this.#post("hibernationresume"') &&
      productionWorker.includes("createCheckpointVmstateRangeLedger") &&
      productionWorker.includes("OVERLAY_QUOTA_EXCEEDED");
    sourceChecks.selfContainedOuterWorker = !/^\s*import\s/m.test(productionWorker) &&
      productionWorker.includes("dispatchSanitizedWorkerInput") &&
      productionWorker.includes("async function preparePagedDisk") &&
      productionWorker.includes("function createBoundedOverlayPreRun") &&
      productionWorker.includes("Generated self-contained production Worker");
    sourceChecks.inputSanitizer = inputBridge.includes("sanitizeWorkerInput") &&
      inputBridge.includes("KEY_CODE_TO_SDL_SCANCODE") &&
      inputBridge.includes("dispatchSanitizedWorkerInputWithReceipt") &&
      inputBridge.includes("receiptHandle");
    sourceChecks.nativeInputExports = [
      "_omarchy_input_key",
      "_omarchy_input_pointer",
      "_omarchy_input_wheel",
      "_omarchy_runtime_is_running",
      "_omarchy_input_release_modifiers",
    ].every((name) => moduleSource.includes(name));
    sourceChecks.nativeDesktopProofExports = [
      "_omarchy_desktop_proof_arm",
      "_omarchy_desktop_proof_expect_response",
    ].every((name) => moduleSource.includes(name));
    if (tcgExperiment !== null) {
      sourceChecks.tcgExperimentWorkerIdentity = productionWorker.startsWith(
        `// OMARCHY_EXPERIMENT qemu-wasm-tcg-hot-threshold threshold=${tcgThreshold} ` +
        `promotion-eligible=false qemu-wasm-sha256=${wasmSha256}\n`,
      ) && productionWorker.includes(`browserQemuWasmSha256: "${wasmSha256}"`);
      if (graphics === VIRGL_GRAPHICS_EXPERIMENT) {
        sourceChecks.tcgExperimentWorkerIdentity = productionWorker.includes(
          `// OMARCHY_EXPERIMENT qemu-wasm-tcg-hot-threshold threshold=${tcgThreshold} ` +
          `promotion-eligible=false qemu-wasm-sha256=${wasmSha256}\n`,
        ) && productionWorker.includes(`browserQemuWasmSha256: "${wasmSha256}"`);
      }
    }
    if (graphics !== null) {
      sourceChecks.graphicsExperimentWorkerIdentity =
        graphicsExperimentWorkerIdentityMatches(productionWorker, graphics, wasmSha256);
      sourceChecks.webgl2Loader = Object.values(
        inspectWebgl2ArtifactPlumbing(moduleSource, wasm),
      ).every(Boolean);
      sourceChecks.nativeBrowserPerformanceHooks = [
        "_omarchy_performance_capture_begin",
        "_omarchy_performance_capture_end",
        "_omarchy_performance_scanout_events",
        "_omarchy_performance_input_events",
        "_omarchy_performance_dropped_events",
        "onBrowserPerformanceScanoutCandidate",
        "onBrowserPerformanceScanoutPresent",
        "onBrowserPerformanceInputDelivered",
      ].every((name) => moduleSource.includes(name));
      sourceChecks.privateBrowserPerformanceProducer =
        productionWorker.includes("class BrowserPerformanceTraceProducer") &&
        productionWorker.includes("class BrowserPerformanceRuntimeController") &&
        productionWorker.includes("NativeBrowserPerformanceSourceBridge") &&
        productionWorker.includes("browserperformancecapture") &&
        productionWorker.includes("normalizeBrowserPerformanceCommand") &&
        productionWorker.includes("PERFORMANCE_INPUT_DIGEST_MISMATCH") &&
        productionWorker.includes("qemu-virtio-input-ring") &&
        !productionWorker.includes('action === "candidate"') &&
        !productionWorker.includes('action === "inputdelivered"');
    }
    if (vcpus !== null) {
      sourceChecks.vcpuExperimentWorkerIdentity = productionWorker.startsWith(
        `// OMARCHY_EXPERIMENT browser-vcpus count=${vcpus} promotion-eligible=false ` +
        `qemu-wasm-sha256=${wasmSha256}\n`,
      ) && productionWorker.includes(`cores: ${vcpus},`) &&
        productionWorker.split(`${vcpus},sockets=1,cores=${vcpus},threads=1`).length - 1 === 3 &&
        !productionWorker.includes("cores: 2,") &&
        !productionWorker.includes("2,sockets=1,cores=2,threads=1");
    }
    if (tcgExperiment === null && graphics === null) {
      sourceChecks.canonicalWorkerIdentity =
        !productionWorker.includes("OMARCHY_EXPERIMENT qemu-wasm-tcg-hot-threshold") &&
        productionWorker.includes(
          `browserQemuWasmSha256: "${CANONICAL_CHECKPOINT_IDENTITY.browserQemuWasmSha256}"`,
        );
    }
  }
  for (const [name, passed] of Object.entries(sourceChecks)) {
    assert.equal(passed, true, `generated JavaScript is missing ${name} plumbing`);
  }

  const report = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    artifacts: sizes,
    wasm: {
      valid: true,
      sharedMemoryImport: {
        module: memory.module,
        name: memory.name,
        initialPages: memory.initial,
        maximumPages: memory.maximum,
        initialMiB,
      },
      qcow2DriverMarker: true,
      workerDomHooksDisabled: true,
      singleThreadTcgWasmInitialized: true,
      ...(tcgExperiment !== null ? {
        tcgExperiment,
        tcgExperimentArtifactSha256: wasmSha256,
        tcgMetricsMarker: TCG_METRICS_MARKER,
        ...(tcgExperiment.cachePolicy !== undefined
          ? { tcgCachePolicyMarker: tcgExperiment.cachePolicyMarker }
          : {}),
      } : {}),
      ...(graphics !== null ? {
        graphicsExperiment: {
          kind: graphics,
          promotionEligible: false,
          qemuWasmSha256: wasmSha256,
          ...(graphics === VIRGL_GRAPHICS_EXPERIMENT
            ? { renderer: "virglrenderer-0.10.4", guestDevice: "virtio-vga-gl" }
            : {
                renderer: "qemu-sdl2-surface-texture",
                guestDevice: "virtio-vga",
                checkpointCompatible: true,
              }),
          browserApi: "WebGL2",
        },
      } : {}),
      ...(vcpus !== null ? {
        vcpuExperiment: {
          count: vcpus,
          promotionEligible: false,
          qemuWasmSha256: wasmSha256,
        },
      } : {}),
    },
    javascript: sourceChecks,
  };
  await writeFile(
    join(outputDirectory, "runtime-verification.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  return report;
}

const runtimeDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDirectory = resolve(process.argv[2] ?? join(runtimeDirectory, "dist"));
  const report = await verifyRuntimeArtifacts(outputDirectory);
  process.stdout.write(
    `runtime artifacts: wasm32 shared memory ${report.wasm.sharedMemoryImport.initialMiB} MiB; ` +
      "pthread/main-thread-framebuffer/FS/frame/qcow2 gates passed\n",
  );
}
