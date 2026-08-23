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

export async function verifyRuntimeArtifacts(
  outputDirectory,
  { writeReport = true } = {},
) {
  const manifest = JSON.parse(await readFile(join(outputDirectory, "runtime-manifest.json"), "utf8"));
  if (manifest.schemaVersion === 2) validateProductionManifest(manifest);
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
  assert.equal(
    wasm.includes(Buffer.from("OMARCHY_RUNTIME_DIAGNOSTIC wasm32-tcg-experiment")),
    false,
    "linked QEMU binary contains a retired TCG experiment marker",
  );

  const moduleSource = await readFile(join(outputDirectory, modulePath), "utf8");
  const workerSource = await readFile(join(outputDirectory, pthreadPath), "utf8");
  const sourceChecks = {
    esModuleFactory: /export\s+default/.test(moduleSource),
    filesystemExport: /["']FS["']/.test(moduleSource),
    framebufferProxy: moduleSource.includes("blitOffscreenFramebuffer"),
    canvasTransferDisabled: !moduleSource.includes("transferredCanvasNames==4294967295"),
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
  };
  if (manifest.schemaVersion === 2) {
    const productionWorker = await readFile(join(outputDirectory, manifest.assets.hostWorker), "utf8");
    assert.equal(
      productionWorker.includes("OMARCHY_EXPERIMENT"),
      false,
      "experiment-stamped Workers are not valid canonical runtime artifacts",
    );
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
    sourceChecks.canonicalWorkerIdentity = !productionWorker.includes("OMARCHY_EXPERIMENT") &&
      productionWorker.includes(
        `browserQemuWasmSha256: "${CANONICAL_CHECKPOINT_IDENTITY.browserQemuWasmSha256}"`,
      );
    sourceChecks.softwareGraphicsProfile =
      productionWorker.split('"sdl,gl=').length - 1 === 1 &&
      productionWorker.split('"sdl,gl=off,show-cursor=on"').length - 1 === 1 &&
      productionWorker.split('"virtio-vga').length - 1 === 1 &&
      productionWorker.split('"virtio-vga,max_outputs=1,xres=1600,yres=900"').length - 1 === 1;
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
    },
    javascript: sourceChecks,
  };
  if (writeReport) {
    await writeFile(
      join(outputDirectory, "runtime-verification.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
  }
  return report;
}

const runtimeDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function parseRuntimeVerificationCli(arguments_) {
  let outputDirectory = join(runtimeDirectory, "dist");
  let outputDirectorySeen = false;
  let writeReport = false;
  for (const argument of arguments_) {
    if (argument === "--write-report") {
      assert.equal(writeReport, false, "--write-report may only be supplied once");
      writeReport = true;
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown argument: ${argument}`);
    } else {
      assert.equal(outputDirectorySeen, false, "runtime output directory may only be supplied once");
      outputDirectory = resolve(argument);
      outputDirectorySeen = true;
    }
  }
  return Object.freeze({ outputDirectory, writeReport });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { outputDirectory, writeReport } = parseRuntimeVerificationCli(process.argv.slice(2));
  const report = await verifyRuntimeArtifacts(outputDirectory, { writeReport });
  process.stdout.write(
    `runtime artifacts: wasm32 shared memory ${report.wasm.sharedMemoryImport.initialMiB} MiB; ` +
      `pthread/main-thread-framebuffer/FS/frame/qcow2 gates passed (${writeReport ? "report written" : "read-only"})\n`,
  );
}
