import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  graphicsExperimentWorkerIdentityMatches,
  inspectWebgl2ArtifactPlumbing,
  parseImportedMemories,
  verifyCheckpointWasmIdentity,
} from "../scripts/verify-runtime-artifacts.mjs";
import {
  buildRuntimeManifest,
  validateCheckpointProducerManifest,
} from "../scripts/prepare-runtime-manifest.mjs";
import { stampTcgThresholdExperiment } from "../scripts/stamp-tcg-threshold-experiment.mjs";
import { stampGraphicsExperiment } from "../scripts/stamp-graphics-experiment.mjs";
import { stampVcpuExperiment } from "../scripts/stamp-vcpu-experiment.mjs";
import { normalizedJsonBytes } from "../web/production-worker.mjs";

const runtime = new URL("../", import.meta.url);
const scripts = [
  "scripts/audit-upstreams.sh",
  "scripts/build-inside-container.sh",
  "scripts/build-qemu-wasm.sh",
  "scripts/bundle-production-worker.mjs",
  "scripts/package-guest.sh",
  "scripts/package-smoke.sh",
  "scripts/patch-generated-qemu.mjs",
  "scripts/prepare-runtime-manifest.mjs",
  "scripts/serve.mjs",
  "scripts/serve-full-guest.mjs",
  "scripts/stamp-tcg-threshold-experiment.mjs",
  "scripts/stamp-graphics-experiment.mjs",
  "scripts/stamp-vcpu-experiment.mjs",
  "scripts/verify-runtime-artifacts.mjs",
  "scripts/write-build-metadata.mjs",
];

test("build entry points are executable and parse with their declared runtime", async () => {
  for (const relativePath of scripts) {
    const url = new URL(relativePath, runtime);
    await access(url, constants.X_OK);
    const command = relativePath.endsWith(".mjs") ? process.execPath : "bash";
    const args = relativePath.endsWith(".mjs") ? ["--check", url.pathname] : ["-n", url.pathname];
    const result = spawnSync(command, args, { encoding: "utf8" });
    assert.equal(result.status, 0, `${relativePath}: ${result.stderr}`);
  }
});

test("SDL2 config shim exposes the Emscripten system port", () => {
  const shim = new URL("toolchain/sdl2-config", runtime).pathname;
  const version = spawnSync(shim, ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^2\./);

  const flags = spawnSync(shim, ["--cflags"], { encoding: "utf8" });
  assert.equal(flags.status, 0);
  assert.equal(flags.stdout.trim(), "-sUSE_SDL=2");
});

test("packaged production Worker embeds exact input and storage modules without static imports", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "omarchy-production-worker-bundle-"));
  context.after(() => rm(output, { recursive: true, force: true }));
  const destination = join(output, "production-worker.mjs");
  const bundler = new URL("scripts/bundle-production-worker.mjs", runtime).pathname;
  const result = spawnSync(process.execPath, [bundler, destination], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const [
    bundle,
    inputSource,
    pagedDiskSource,
    boundedOverlaySource,
    performanceGateSource,
    performanceProducerSource,
    browserPerformanceRuntimeSource,
  ] = await Promise.all([
    readFile(destination, "utf8"),
    readFile(new URL("web/worker-input.mjs", runtime), "utf8"),
    readFile(new URL("../storage/paged-disk.mjs", runtime), "utf8"),
    readFile(new URL("../storage/bounded-overlay.mjs", runtime), "utf8"),
    readFile(new URL("../proofs/browser-performance/gate.mjs", runtime), "utf8"),
    readFile(new URL("../proofs/browser-performance/producer.mjs", runtime), "utf8"),
    readFile(new URL("web/browser-performance-runtime.mjs", runtime), "utf8"),
  ]);
  assert.doesNotMatch(bundle, /^\s*import\s/m);
  assert.match(bundle, /Generated self-contained production Worker/);
  for (const [name, source] of [
    ["worker-input.mjs", inputSource],
    ["paged-disk.mjs", pagedDiskSource],
    ["bounded-overlay.mjs", boundedOverlaySource],
    ["browser-performance/gate.mjs", performanceGateSource],
    ["browser-performance/producer.mjs", performanceProducerSource],
    ["browser-performance-runtime.mjs", browserPerformanceRuntimeSource],
  ]) {
    const digest = createHash("sha256").update(source).digest("hex");
    assert.match(bundle, new RegExp(`${name.replace(".", "\\.")} sha256=${digest}`));
  }
  assert.match(bundle, /dispatchSanitizedWorkerInput\(this\.#instance, event\)/);
  assert.match(bundle, /class DesktopProofProtocol/);
  assert.match(bundle, /this\.#post\("desktopproof", \{ proof \}\)/);
  assert.match(bundle, /class BrowserPerformanceTraceProducer/);
  assert.match(bundle, /class BrowserPerformanceRuntimeController/);
  assert.match(bundle, /onBrowserPerformanceScanoutCandidate/);
  assert.match(bundle, /browserperformancecapture/);
  assert.match(bundle, /PERFORMANCE_INPUT_DIGEST_MISMATCH/);
  assert.doesNotMatch(bundle, /action === "candidate"/);
  assert.doesNotMatch(bundle, /action === "inputdelivered"/);
  assert.match(bundle, /async function preparePagedDisk\(/);
  assert.match(bundle, /async function preflightPagedDisk\(/);
  assert.match(bundle, /function createPagedDiskPreRun\(/);
  assert.match(bundle, /function validateCheckpointArtifacts\(/);
  assert.match(bundle, /function validateCheckpointSourceEvidence\(/);
  assert.match(bundle, /checkpoint-source-evidence/);
  assert.match(bundle, /CHECKPOINT_REPORT_REPLAY/);
  assert.match(bundle, /function createCheckpointVmstateRangeLedger\(/);
  assert.match(bundle, /file:\/pack\/omarchy-preboot\.vmstate/);
  assert.match(bundle, /function createBoundedOverlayPreRun\(/);
  assert.doesNotMatch(bundle, /import\(pagedDiskUrl\)/);
});

test("runtime packaging keeps cold boot only when no checkpoint artifact is present", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-runtime-cold-package-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const baseManifestPath = join(root, "demo.json");
  const guestDirectory = join(root, "guest");
  await mkdir(guestDirectory);
  const base = { schemaVersion: 2, runtimeMode: "worker-paged", marker: "cold" };
  await writeFile(baseManifestPath, JSON.stringify(base));
  await writeFile(join(guestDirectory, "guest-manifest.json"), JSON.stringify({ schemaVersion: 1, artifacts: [] }));
  const result = await buildRuntimeManifest({
    baseManifestPath,
    guestDirectory,
    qemuWasmPath: join(root, "missing-qemu.wasm"),
  });
  assert.equal(result.mode, "cold");
  assert.deepEqual(result.manifest, base);

  await writeFile(join(guestDirectory, "omarchy-preboot.vmstate"), "partial");
  await assert.rejects(
    buildRuntimeManifest({ baseManifestPath, guestDirectory, qemuWasmPath: join(root, "missing-qemu.wasm") }),
    /refuses a partial descriptor\/vmstate\/boot-delta set/,
  );
});

test("graphics experiment packaging deliberately cold boots despite checkpoint files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-runtime-graphics-cold-package-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const baseManifestPath = join(root, "virgl-webgl2.json");
  const guestDirectory = join(root, "guest");
  await mkdir(guestDirectory);
  const base = { schemaVersion: 2, runtimeMode: "worker-paged", marker: "virgl-webgl2" };
  await writeFile(baseManifestPath, JSON.stringify(base));
  await writeFile(join(guestDirectory, "guest-manifest.json"), JSON.stringify({ schemaVersion: 1 }));
  await writeFile(join(guestDirectory, "omarchy-preboot.vmstate"), "incompatible-software-gpu-state");
  const result = await buildRuntimeManifest({
    baseManifestPath,
    guestDirectory,
    qemuWasmPath: join(root, "missing-qemu.wasm"),
    forceCold: true,
  });
  assert.equal(result.mode, "cold");
  assert.deepEqual(result.manifest, base);
});

test("runtime packaging binds a complete checkpoint to exact files, guest, QEMU, and profile", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-runtime-checkpoint-package-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const guestDirectory = join(root, "guest");
  await mkdir(guestDirectory);
  const baseManifestPath = join(root, "demo.json");
  const qemuWasmPath = join(root, "qemu.wasm");
  await writeFile(baseManifestPath, JSON.stringify({ schemaVersion: 2, runtimeMode: "worker-paged" }));
  const vmstate = Buffer.from("bounded migration stream");
  const bootDelta = Buffer.from("immutable qcow2 delta");
  const wasm = Buffer.from("canonical browser qemu wasm fixture");
  await Promise.all([
    writeFile(join(guestDirectory, "omarchy-preboot.vmstate"), vmstate),
    writeFile(join(guestDirectory, "checkpoint-overlay.qcow2"), bootDelta),
    writeFile(qemuWasmPath, wasm),
  ]);
  const rootfsSha256 = "a".repeat(64);
  const guestProvenanceSha256 = "b".repeat(64);
  const upstream = {
    repository: "https://github.com/basecamp/omarchy",
    commit: "e".repeat(40),
    version: "test",
    treeSha256: "f".repeat(64),
  };
  const guestManifestBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    upstream,
    artifacts: [
      { path: "rootfs.ext4", bytes: 4096, sha256: rootfsSha256 },
      { path: "provenance.json", bytes: 256, sha256: guestProvenanceSha256 },
    ],
  }));
  await writeFile(join(guestDirectory, "guest-manifest.json"), guestManifestBytes);
  const expected = {
    baseGuestManifestSha256: createHash("sha256").update(guestManifestBytes).digest("hex"),
    rootfsSha256,
    guestProvenanceSha256,
    browserQemuWasmSha256: createHash("sha256").update(wasm).digest("hex"),
    qemuRepository: "https://github.com/ktock/qemu-wasm.git",
    qemuSourceCommit: "c".repeat(40),
    qemuVersion: "8.2.0",
    machineType: "pc-q35-8.2",
    memoryMiB: 1024,
    smp: "2,sockets=1,cores=2,threads=1",
    accel: "tcg,tb-size=128,thread=multi",
  };
  const producer = {
    schemaVersion: 1,
    kind: "omarchy-web-preboot-checkpoint",
    vmstate: {
      path: "omarchy-preboot.vmstate",
      bytes: vmstate.byteLength,
      sha256: createHash("sha256").update(vmstate).digest("hex"),
      format: "qemu-8.2-migration",
      compression: "none",
      incomingMode: "file",
    },
    bootDelta: {
      path: "checkpoint-overlay.qcow2",
      bytes: bootDelta.byteLength,
      sha256: createHash("sha256").update(bootDelta).digest("hex"),
      format: "qcow2",
      backingFilename: "rootfs.ext4",
      backingFormat: "raw",
    },
    producer: { qemuBinarySha256: "d".repeat(64) },
    identity: {
      baseGuestManifestSha256: expected.baseGuestManifestSha256,
      rootfsSha256,
      guestProvenanceSha256,
    },
    qemu: {
      repository: expected.qemuRepository,
      sourceCommit: expected.qemuSourceCommit,
      version: expected.qemuVersion,
    },
    machine: {
      type: expected.machineType,
      memoryMiB: expected.memoryMiB,
      smp: expected.smp,
      accel: expected.accel,
    },
    restoreContract: {
      sourceRunstate: "running",
      immediateIncomingAutoRuns: true,
      qmpContRequired: false,
      disposableWrites: "target -snapshot layer over immutable boot delta",
    },
  };
  const guestReport = {
    schemaVersion: 1,
    generatedAt: "2026-08-15T09:00:00.000Z",
    provenance: { ...upstream },
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
      { argv: ["omarchy-version"], exitCode: 0, stdout: "test\n", stderr: "" },
    ],
    configs: [{
      path: "/usr/share/omarchy/shell/shell.qml",
      sha256: "9".repeat(64),
      origin: "omarchy-upstream",
    }],
  };
  producer.sourceEvidence = {
    guestReport,
    normalizedGuestReportSha256: createHash("sha256")
      .update(normalizedJsonBytes(guestReport)).digest("hex"),
    reportValidationSha256: "5".repeat(64),
    checkpointFrameSha256: "6".repeat(64),
    checkpointFrameHealthSha256: "7".repeat(64),
  };
  validateCheckpointProducerManifest(producer, expected);
  const producerBytes = Buffer.from(`${JSON.stringify(producer)}\n`);
  await writeFile(join(guestDirectory, "checkpoint-manifest.json"), producerBytes);

  const result = await buildRuntimeManifest({ baseManifestPath, guestDirectory, qemuWasmPath, expected });
  assert.equal(result.mode, "checkpoint");
  assert.equal(result.manifest.checkpoint.vmstate.bytes, vmstate.byteLength);
  assert.equal(result.manifest.checkpoint.bootDelta.backingFilename, "rootfs.ext4");
  assert.equal(
    result.manifest.checkpoint.producer.manifestSha256,
    createHash("sha256").update(producerBytes).digest("hex"),
  );
  assert.equal(result.manifest.checkpoint.identity.browserQemuWasmSha256, expected.browserQemuWasmSha256);

  await writeFile(join(guestDirectory, "omarchy-preboot.vmstate"), "mutated migration stream");
  await assert.rejects(
    buildRuntimeManifest({ baseManifestPath, guestDirectory, qemuWasmPath, expected }),
    /vmstate differs from checkpoint-manifest\.json/,
  );
});

test("the pthread build keeps canvas ownership on the browser main thread", async () => {
  const buildScript = await readFile(new URL("scripts/build-inside-container.sh", runtime), "utf8");
  assert.match(buildScript, /-sOFFSCREEN_FRAMEBUFFER=1/);
  assert.match(buildScript, /'-sOFFSCREENCANVASES_TO_PTHREAD=""'/);
  assert.doesNotMatch(buildScript, /OFFSCREENCANVASES_TO_PTHREAD=#canvas/);

  const framePatch = await readFile(new URL("patches/qemu-sdl-frame-hook.patch", runtime), "utf8");
  assert.match(framePatch, /SDL_SetHint\(SDL_HINT_RENDER_DRIVER, "software"\)/);
  assert.match(framePatch, /SDL_RENDERER_SOFTWARE/);
  assert.match(framePatch, /SDL_GetRendererInfo/);
});

test("SDL obtains Worker display dimensions from the transferred canvas instead of screen", async () => {
  const buildScript = await readFile(new URL("scripts/build-inside-container.sh", runtime), "utf8");
  const screenLibrary = await readFile(new URL("toolchain/worker-screen-library.js", runtime), "utf8");

  assert.match(buildScript, /--js-library=\$runtime_dir\/toolchain\/worker-screen-library\.js/);
  assert.match(screenLibrary, /emscripten_get_screen_size__proxy:\s*"sync"/);
  assert.match(screenLibrary, /Module\["canvas"\]/);
  assert.match(screenLibrary, /omarchyWorkerScreenDimension\("width", 1600\)/);
  assert.match(screenLibrary, /omarchyWorkerScreenDimension\("height", 900\)/);
  assert.match(screenLibrary, /emscripten_set_canvas_element_size__proxy:\s*"sync"/);
  assert.match(screenLibrary, /emscripten_get_element_css_size__proxy:\s*"sync"/);
  assert.match(screenLibrary, /HEAPF64\[width >> 3\] = 1/);
  assert.match(screenLibrary, /worker-canvas-css-size width=1 height=1/);
  assert.doesNotMatch(screenLibrary, /\bscreen\s*\./);
  assert.match(screenLibrary, /emscripten_set_pointerlockchange_callback_on_thread:/);
  assert.match(screenLibrary, /emscripten_set_fullscreenchange_callback_on_thread:/);
  assert.match(screenLibrary, /emscripten_set_window_title__proxy:\s*"sync"/);
  assert.match(screenLibrary, /if \(typeof document !== "undefined"\) document\.title/);
  assert.doesNotMatch(screenLibrary, /if \(canvas\)\s*document\./);
});

test("Worker SDL CSS probing preserves a nonzero canvas window size", async () => {
  const source = await readFile(new URL("toolchain/worker-screen-library.js", runtime), "utf8");
  const canvas = { width: 1600, height: 900 };
  const diagnostics = [];
  const heap = new Float64Array(4);
  let library;
  runInNewContext(source, {
    Module: { canvas, printErr: (line) => diagnostics.push(line) },
    HEAP32: new Int32Array(8),
    HEAPF64: heap,
    UTF8ToString: () => "",
    addToLibrary(value) { library = value; },
  });

  assert.equal(library.emscripten_set_canvas_element_size(0, 1, 1), 0);
  assert.equal(library.emscripten_get_element_css_size(0, 0, 8), 0);
  assert.deepEqual([...heap.slice(0, 2)], [1, 1]);
  assert.equal(library.emscripten_set_canvas_element_size(0, 640, 480), 0);
  assert.deepEqual(canvas, { width: 640, height: 480 });
  assert.deepEqual(diagnostics, [
    "OMARCHY_RUNTIME_DIAGNOSTIC worker-canvas-css-size width=1 height=1",
  ]);

  let noCanvasLibrary;
  runInNewContext(source, {
    Module: {},
    HEAP32: new Int32Array(8),
    HEAPF64: new Float64Array(4),
    UTF8ToString: () => "",
    addToLibrary(value) { noCanvasLibrary = value; },
  });
  assert.equal(noCanvasLibrary.emscripten_get_element_css_size(0, 0, 8), -4);
});

test("generated Browser.init installs pointer-lock DOM hooks only when document exists", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-runtime-browser-init-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const generated = join(root, "qemu.mjs");
  await writeFile(
    generated,
    [
      'var Module={ENVIRONMENT_IS_PTHREAD:true};var ENVIRONMENT_IS_PTHREAD=true;',
      'var canvas=Module["canvas"];if(canvas){canvas.requestPointerLock=()=>{}};',
      'var wasmBinaryFile;if(Module["locateFile"]){wasmBinaryFile="qemu-system-x86_64.wasm";',
      'if(!wasmBinaryFile.startsWith("data:")){wasmBinaryFile=Module["locateFile"](wasmBinaryFile)}}',
      'else{wasmBinaryFile=new URL("qemu-system-x86_64.wasm",import.meta.url).href}',
      'function _glUnavailable(){throw new Error("unavailable")};asyncifyStubs["glUnavailable"]=undefined;',
      'function transferCanvas(){var offscreenCanvases={};var moduleCanvasId=Module["canvas"]?Module["canvas"].id:"";',
      'if(GL.offscreenCanvases[name]){offscreenCanvasInfo=GL.offscreenCanvases[name];GL.offscreenCanvases[name]=null;',
      'if(Module["canvas"]instanceof OffscreenCanvas&&name===Module["canvas"].id)Module["canvas"]=null}',
      'else if(!ENVIRONMENT_IS_PTHREAD){}}',
      'export default wasmBinaryFile;',
    ].join(""),
  );
  const patcher = new URL("scripts/patch-generated-qemu.mjs", runtime).pathname;
  const result = spawnSync(process.execPath, [patcher, generated], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const patched = await readFile(generated, "utf8");
  assert.match(patched, /if\(canvas&&typeof document!="undefined"\)/);
  assert.doesNotMatch(patched, /if\(canvas\)\{canvas\.requestPointerLock/);
  assert.match(
    patched,
    /if\(ENVIRONMENT_IS_PTHREAD\)\{wasmBinaryFile="qemu-system-x86_64\.wasm"\}else if\(Module\["locateFile"\]\)/,
  );
  assert.doesNotMatch(patched, /var wasmBinaryFile;if\(Module\["locateFile"\]\)/);
  assert.equal(patched.split("var asyncifyStubs={};").length - 1, 1);
  assert.match(
    patched,
    /Module\["canvas"\]instanceof OffscreenCanvas&&!Module\["canvas"\]\.id/,
  );
  assert.match(
    patched,
    /offscreenCanvasInfo=\{offscreenCanvas:Module\["canvas"\]/,
  );

  const nonHierarchicalModuleUrl = `data:text/javascript,${encodeURIComponent(patched)}`;
  const evaluated = await import(nonHierarchicalModuleUrl);
  assert.equal(
    evaluated.default,
    "qemu-system-x86_64.wasm",
    "pthread bootstrap must not resolve a relative Wasm URL against its verified Blob module",
  );

  const second = spawnSync(process.execPath, [patcher, generated], { encoding: "utf8" });
  assert.notEqual(second.status, 0, "the transform must fail instead of double-patching an artifact");

  const cachedGenerated = join(root, "cached-qemu.mjs");
  const cachedSource = (await readFile(generated, "utf8"))
    .replace(
      'if(ENVIRONMENT_IS_PTHREAD){wasmBinaryFile="qemu-system-x86_64.wasm"}else if(Module["locateFile"]){',
      'if(Module["locateFile"]){',
    );
  await writeFile(cachedGenerated, cachedSource);
  const cachedResult = spawnSync(process.execPath, [patcher, cachedGenerated], { encoding: "utf8" });
  assert.equal(cachedResult.status, 0, cachedResult.stderr);
  assert.match(
    await readFile(cachedGenerated, "utf8"),
    /if\(ENVIRONMENT_IS_PTHREAD\)\{wasmBinaryFile="qemu-system-x86_64\.wasm"\}/,
    "a cached module with the prior Browser.init fix must receive the new pthread fix",
  );
});

test("the native pointer bridge queues both motion and button transitions", async () => {
  const inputPatch = await readFile(new URL("patches/qemu-wasm-input-bridge.patch", runtime), "utf8");
  const runstatePatch = await readFile(new URL("patches/qemu-wasm-runstate-guard.patch", runtime), "utf8");
  assert.match(inputPatch, /SDL_MOUSEMOTION/);
  assert.match(inputPatch, /SDL_MOUSEBUTTONDOWN/);
  assert.match(inputPatch, /SDL_MOUSEBUTTONUP/);
  assert.match(inputPatch, /previous_buttons = buttons/);
  assert.match(runstatePatch, /int omarchy_runtime_is_running\(void\)/);
  assert.match(runstatePatch, /qatomic_read\(&omarchy_runtime_running\)/);
  assert.match(runstatePatch, /OMARCHY_RELEASE_MODIFIERS_EVENT/);
  assert.match(runstatePatch, /input-key-processed sequence=/);
});

test("the outer Worker build does not call DOM-only SDL window decoration hooks", async () => {
  const workerPatch = await readFile(new URL("patches/qemu-wasm-worker-dom.patch", runtime), "utf8");
  assert.match(workerPatch, /SDL_SetWindowTitle/);
  assert.match(workerPatch, /worker-dom-cursor-hooks-disabled/);
  assert.match(workerPatch, /dpy_cursor_define/);
  assert.match(workerPatch, /#ifndef __EMSCRIPTEN__/);
});

test("artifact verifier decodes shared WebAssembly memory limits", () => {
  const wasm = Buffer.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x02, 0x10, 0x01,
    0x03, 0x65, 0x6e, 0x76,
    0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79,
    0x02, 0x03, 0x02, 0x04,
  ]);
  assert.deepEqual(parseImportedMemories(wasm), [{
    module: "env",
    name: "memory",
    flags: 3,
    initial: 2,
    maximum: 4,
    shared: true,
    memory64: false,
    offset: undefined,
  }]);
});

test("artifact verifier binds checkpoint metadata to the exact browser QEMU Wasm bytes", () => {
  const wasm = Buffer.from("checkpoint-compatible-wasm");
  const digest = createHash("sha256").update(wasm).digest("hex");
  assert.equal(verifyCheckpointWasmIdentity({}, wasm), null);
  assert.equal(verifyCheckpointWasmIdentity({
    checkpoint: { identity: { browserQemuWasmSha256: digest } },
  }, wasm), digest);
  assert.throws(
    () => verifyCheckpointWasmIdentity({
      checkpoint: { identity: { browserQemuWasmSha256: "f".repeat(64) } },
    }, wasm),
    /different browser QEMU Wasm binary/,
  );
});

test("artifact verifier binds WebGL2 loader calls to the Wasm cadence marker", () => {
  const moduleSource = [
    'canvas.getContext("webgl2",webGLContextAttributes)',
    "GLctx.blitFramebuffer(0,0,1,1,0,0,1,1,0,0)",
    "GLctx.drawBuffers(bufArray)",
  ].join(";");
  const wasm = Buffer.from("wasm fixture webgl2-present-cadence");
  assert.deepEqual(inspectWebgl2ArtifactPlumbing(moduleSource, wasm), {
    webgl2Context: true,
    framebufferBlit: true,
    drawBuffers: true,
    presentCadence: true,
  });

  for (const missing of [
    'canvas.getContext("webgl2",webGLContextAttributes)',
    "GLctx.blitFramebuffer(",
    "GLctx.drawBuffers(",
  ]) {
    assert.equal(
      Object.values(
        inspectWebgl2ArtifactPlumbing(moduleSource.replace(missing, "missing("), wasm),
      ).every(Boolean),
      false,
      missing,
    );
  }
  assert.equal(
    Object.values(inspectWebgl2ArtifactPlumbing(
      `${moduleSource};webgl2-present-cadence`,
      Buffer.from("wasm fixture without cadence"),
    )).every(Boolean),
    false,
    "the C cadence marker must be present in Wasm bytes, not merely JavaScript",
  );
});

test("the runtime patches still apply to the pinned upstream", () => {
  const source = process.env.QEMU_WASM_SOURCE ?? "/private/tmp/qemu-wasm-source";
  for (const relativePath of [
    "patches/qemu-wasm-builder-zlib-url.patch",
    "patches/qemu-sdl-frame-hook.patch",
    "patches/qemu-wasm-input-bridge.patch",
    "patches/qemu-wasm-worker-dom.patch",
    "patches/qemu-wasm-tcg-rr-init.patch",
    "patches/qemu-wasm-tcg-vcpu-layout.patch",
    "patches/qemu-wasm-tcg-hot-threshold-250.patch",
    "patches/qemu-wasm-tcg-baseline-threshold-1500-metrics.patch",
  ]) {
    const patch = new URL(relativePath, runtime).pathname;
    const result = spawnSync("git", ["-C", source, "apply", "--check", patch], { encoding: "utf8" });
    assert.equal(result.status, 0, `${relativePath}: ${result.stderr}`);
  }
  const buildScript = readFileSync(new URL("scripts/build-qemu-wasm.sh", runtime), "utf8");
  assert.match(buildScript, /qemu-wasm-runstate-guard\.patch/);
  assert.match(buildScript, /qemu-wasm-sdl-texture-reuse\.patch/);
  assert.match(buildScript, /qemu-wasm-tcg-vcpu-layout\.patch/);
  assert.match(buildScript, /qemu-wasm-tcg-hot-threshold-250\.patch/);
  assert.match(buildScript, /qemu-wasm-tcg-baseline-threshold-1500-metrics\.patch/);
});

test("threshold-250 TCG experiment is bounded, observable, and source-overlaid", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-runtime-tcg-threshold-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "tcg"));
  const upstream = process.env.QEMU_WASM_SOURCE ?? "/private/tmp/qemu-wasm-source";
  for (const relativePath of ["tcg/wasm32.c", "tcg/wasm32.h"]) {
    await writeFile(join(root, relativePath), await readFile(join(upstream, relativePath)));
  }
  const patch = new URL("patches/qemu-wasm-tcg-hot-threshold-250.patch", runtime).pathname;
  const applied = spawnSync(
    "patch",
    ["--quiet", "--directory", root, "--strip=1", "--input", patch],
    { encoding: "utf8" },
  );
  assert.equal(applied.status, 0, applied.stderr);

  const [source, header, buildScript, verifier] = await Promise.all([
    readFile(join(root, "tcg/wasm32.c"), "utf8"),
    readFile(join(root, "tcg/wasm32.h"), "utf8"),
    readFile(new URL("scripts/build-qemu-wasm.sh", runtime), "utf8"),
    readFile(new URL("scripts/verify-runtime-artifacts.mjs", runtime), "utf8"),
  ]);
  assert.match(header, /OMARCHY_WASM_TCG_HOT_THRESHOLD 250/);
  assert.match(header, /OMARCHY_WASM_TCG_METRICS_SCHEMA 1/);
  for (const marker of [
    "tci-entries=%", "wasm-entries=%", "cross-50=%", "cross-100=%",
    "cross-250=%", "cross-1500=%", "modules=%", "live-local=%",
    "peak-live-global=%", "evictions=%", "gc-collected=%", "fallback-tci=%",
    "source-bytes=%", "compile-us-total=%", "compile-us-max=%",
    "compile-us-ge64000=%", "wasm-table-length=%",
  ]) {
    assert.ok(source.includes(marker), `missing bounded metric ${marker}`);
  }
  assert.match(source, /OMARCHY_WASM_TCG_METRICS_CHECK_EXECUTIONS 16384/);
  assert.match(source, /OMARCHY_WASM_TCG_METRICS_REPORT_MS 5000\.0/);
  assert.match(source, /wasm32-tcg-experiment[\s\S]+threshold=250 metrics-schema=1/);
  assert.match(source, /wasmTable\.length/);
  assert.match(buildScript, /source_overlay\/tcg\/wasm32\.c:\/qemu-src\/tcg\/wasm32\.c:ro/);
  assert.match(buildScript, /source_overlay\/tcg\/wasm32\.h:\/qemu-src\/tcg\/wasm32\.h:ro/);
  assert.match(verifier, /linked QEMU binary is not the requested TCG experiment/);
});

test("bounded TCG GC recovery keeps active, retired, and retained capacity distinct", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-runtime-tcg-gc-recovery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "tcg"));
  const upstream = process.env.QEMU_WASM_SOURCE ?? "/private/tmp/qemu-wasm-source";
  for (const relativePath of ["tcg/wasm32.c", "tcg/wasm32.h"]) {
    await writeFile(join(root, relativePath), await readFile(join(upstream, relativePath)));
  }

  for (const relativePatch of [
    "patches/qemu-wasm-tcg-hot-threshold-250.patch",
    "patches/qemu-wasm-tcg-bounded-gc-recovery.patch",
  ]) {
    const patch = new URL(relativePatch, runtime).pathname;
    const applied = spawnSync(
      "patch",
      ["--batch", "--quiet", "--directory", root, "--strip=1", "--input", patch],
      { encoding: "utf8" },
    );
    assert.equal(applied.status, 0, `${relativePatch}: ${applied.stderr}`);
  }

  const [source, header] = await Promise.all([
    readFile(join(root, "tcg/wasm32.c"), "utf8"),
    readFile(join(root, "tcg/wasm32.h"), "utf8"),
  ]);
  assert.match(header, /OMARCHY_WASM_TCG_METRICS_SCHEMA 2/);
  assert.match(source, /MAX_INSTANCE_ACTIVE 15000/);
  assert.match(source, /MAX_INSTANCE_REPLACEMENT_CREDIT 1024/);
  assert.match(
    source,
    /MAX_INSTANCE_RETAINED \(MAX_INSTANCE_ACTIVE \+ MAX_INSTANCE_REPLACEMENT_CREDIT\)/,
  );
  assert.match(source, /qatomic_fetch_inc\(&instance_running_global\)/);
  assert.match(source, /qatomic_fetch_inc\(&instance_alive_global\)/);
  assert.match(source, /qatomic_cmpxchg\(&instance_pending_gc_global,/);
  assert.match(source, /qatomic_sub\(&instance_pending_gc_global,/);
  assert.match(source, /wasmTable\.get\(fidx\) !== null \|\| wasmTableMirror\[fidx\] !== null/);
  assert.match(source, /capacity_block == OMARCHY_WASM_TCG_ACTIVE_CAPACITY_BLOCKED/);
  assert.match(
    source,
    /threshold=250 metrics-schema=2 gc-recovery=bounded-credit-v1/,
  );
  for (const marker of [
    "retained-global=%d", "active-global=%d", "pending-gc-global=%d",
    "peak-retained-global=%u", "peak-active-global=%u", "peak-pending-gc-global=%u",
    "replacement-reservations=%", "active-capacity-denials=%",
    "retained-capacity-denials=%", "gc-yields=%", "gc-yield-us-total=%",
    "gc-yield-us-max=%", "table-slots-cleared=%",
  ]) {
    assert.ok(source.includes(marker), `missing GC-recovery metric ${marker}`);
  }
});

test("Emscripten table and mirror are the only strong nested-Wasm roots", () => {
  const fixture = new URL("fixtures/wasm-table-lifetime-child.mjs", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--expose-gc", fixture], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), {
    finalizationCount: 1,
    tableEntry: null,
    mirrorEntry: null,
  });
});

test("threshold-1500 baseline experiment preserves behavior and measures hotness", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-runtime-tcg-baseline-metrics-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "tcg"));
  const upstream = process.env.QEMU_WASM_SOURCE ?? "/private/tmp/qemu-wasm-source";
  for (const relativePath of ["tcg/wasm32.c", "tcg/wasm32.h"]) {
    await writeFile(join(root, relativePath), await readFile(join(upstream, relativePath)));
  }
  const patch = new URL(
    "patches/qemu-wasm-tcg-baseline-threshold-1500-metrics.patch",
    runtime,
  ).pathname;
  const applied = spawnSync(
    "patch",
    ["--quiet", "--directory", root, "--strip=1", "--input", patch],
    { encoding: "utf8" },
  );
  assert.equal(applied.status, 0, applied.stderr);

  const [source, header, buildScript, makefile] = await Promise.all([
    readFile(join(root, "tcg/wasm32.c"), "utf8"),
    readFile(join(root, "tcg/wasm32.h"), "utf8"),
    readFile(new URL("scripts/build-qemu-wasm.sh", runtime), "utf8"),
    readFile(new URL("Makefile", runtime), "utf8"),
  ]);
  assert.match(header, /OMARCHY_WASM_TCG_HOT_THRESHOLD 1500/);
  assert.match(header, /OMARCHY_WASM_TCG_METRICS_SCHEMA 2/);
  assert.match(header, /#define INSTANTIATE_NUM OMARCHY_WASM_TCG_HOT_THRESHOLD/);
  for (const marker of [
    "cross-50=%", "cross-100=%", "cross-250=%", "cross-500=%",
    "cross-750=%", "cross-1000=%", "cross-1500=%", "modules=%",
    "evictions=%", "gc-collected=%", "source-bytes=%", "compile-us-total=%",
    "compile-us-max=%", "compile-us-ge64000=%", "wasm-table-length=%",
    "wasm-table-length-peak=%",
  ]) {
    assert.ok(source.includes(marker), `missing baseline metric ${marker}`);
  }
  assert.match(source, /threshold=1500 metrics-schema=2/);
  assert.match(source, /double compile_start_ms = emscripten_get_now\(\)/);
  assert.match(source, /wasmTable\.length/);
  assert.match(buildScript, /tcg_experiment" == "1500-metrics"/);
  assert.match(buildScript, /tcg-baseline-1500-metrics/);
  assert.match(buildScript, /experiments must use an isolated output directory/);
  assert.match(makefile, /build-tcg-baseline-metrics:/);
  assert.match(makefile, /TCG_BASELINE_METRICS_OUTPUT/);
});

test("threshold experiment Worker stamping is exact and cannot alter the canonical source", () => {
  const canonical = "c49072051ba41f5edc9c5044ff3623563aa9088314b0e63207f53d36b3a7dae8";
  const candidate = "a".repeat(64);
  const source = `const identity = { browserQemuWasmSha256: "${canonical}" };\n`;
  const stamped = stampTcgThresholdExperiment(source, candidate, 250);
  assert.match(
    stamped,
    new RegExp(
      `^// OMARCHY_EXPERIMENT qemu-wasm-tcg-hot-threshold threshold=250 ` +
      `promotion-eligible=false qemu-wasm-sha256=${candidate}`,
    ),
  );
  assert.equal(stamped.includes(canonical), false);
  assert.equal(stamped.includes(candidate), true);
  const baseline = stampTcgThresholdExperiment(source, candidate, "1500-metrics");
  assert.match(
    baseline,
    new RegExp(
      `^// OMARCHY_EXPERIMENT qemu-wasm-tcg-hot-threshold threshold=1500 ` +
      `promotion-eligible=false qemu-wasm-sha256=${candidate}`,
    ),
  );
  const threshold750 = stampTcgThresholdExperiment(source, candidate, "750");
  assert.match(
    threshold750,
    new RegExp(
      `^// OMARCHY_EXPERIMENT qemu-wasm-tcg-hot-threshold threshold=750 ` +
      `promotion-eligible=false qemu-wasm-sha256=${candidate}`,
    ),
  );
  assert.throws(() => stampTcgThresholdExperiment(stamped, candidate, 250), /canonical QEMU Wasm identity/);
  assert.throws(() => stampTcgThresholdExperiment(source, candidate, 100), /unsupported/);
});

test("VirGL/WebGL2 Worker stamping changes only the exact display profile", () => {
  const wasmSha256 = "b".repeat(64);
  const source = [
    'const display = "sdl,gl=off,show-cursor=on";',
    'const device = "virtio-vga,max_outputs=1,xres=1600,yres=900";',
  ].join("\n");
  const stamped = stampGraphicsExperiment(source, wasmSha256, "virgl-webgl2");
  assert.match(
    stamped,
    new RegExp(
      `^// OMARCHY_EXPERIMENT qemu-wasm-graphics kind=virgl-webgl2 ` +
      `promotion-eligible=false qemu-wasm-sha256=${wasmSha256}`,
    ),
  );
  assert.match(stamped, /sdl,gl=es,show-cursor=on/);
  assert.match(stamped, /virtio-vga-gl,max_outputs=1,xres=1600,yres=900/);
  assert.doesNotMatch(stamped, /sdl,gl=off/);
  assert.throws(
    () => stampGraphicsExperiment(stamped, wasmSha256, "virgl-webgl2"),
    /already stamped/,
  );
  assert.throws(() => stampGraphicsExperiment(source, wasmSha256, "other"), /unsupported/);
});

test("VirGL/WebGL2 Worker stamping leaves the ARM software display profile unchanged", () => {
  const wasmSha256 = "e".repeat(64);
  const source = [
    'const x86Display = "sdl,gl=off,show-cursor=on";',
    'const x86Device = "virtio-vga,max_outputs=1,xres=1600,yres=900";',
    'const armDisplay = "sdl,gl=off,show-cursor=on";',
    'const armDevice = "virtio-gpu-pci,max_outputs=1,xres=1600,yres=900";',
  ].join("\n");
  const stamped = stampGraphicsExperiment(source, wasmSha256, "virgl-webgl2");
  assert.equal(stamped.split("sdl,gl=es,show-cursor=on").length - 1, 1);
  assert.equal(stamped.split("sdl,gl=off,show-cursor=on").length - 1, 1);
  assert.match(stamped, /virtio-vga-gl,max_outputs=1,xres=1600,yres=900/);
  assert.match(stamped, /virtio-gpu-pci,max_outputs=1,xres=1600,yres=900/);
});

test("graphics verification accepts exactly one untouched ARM software profile", () => {
  const wasmSha256 = "f".repeat(64);
  const marker =
    `// OMARCHY_EXPERIMENT qemu-wasm-graphics kind=virgl-webgl2 ` +
    `promotion-eligible=false qemu-wasm-sha256=${wasmSha256}\n`;
  const source = marker + [
    '"sdl,gl=es,show-cursor=on"',
    '"virtio-vga-gl,max_outputs=1,xres=1600,yres=900"',
    '"sdl,gl=off,show-cursor=on"',
    '"virtio-gpu-pci,max_outputs=1,xres=1600,yres=900"',
  ].join("\n");
  assert.equal(
    graphicsExperimentWorkerIdentityMatches(source, "virgl-webgl2", wasmSha256),
    true,
  );
  assert.equal(
    graphicsExperimentWorkerIdentityMatches(
      source.replace('"virtio-gpu-pci,max_outputs=1,xres=1600,yres=900"', ""),
      "virgl-webgl2",
      wasmSha256,
    ),
    false,
  );
  assert.equal(
    graphicsExperimentWorkerIdentityMatches(
      `${source}\n"sdl,gl=off,show-cursor=on"`,
      "virgl-webgl2",
      wasmSha256,
    ),
    false,
  );
});

test("WebGL2 presenter preserves the checkpoint GPU device and rebinds only the experimental Wasm", () => {
  const canonical = "c49072051ba41f5edc9c5044ff3623563aa9088314b0e63207f53d36b3a7dae8";
  const wasmSha256 = "d".repeat(64);
  const source = [
    `const identity = { browserQemuWasmSha256: "${canonical}" };`,
    'const display = "sdl,gl=off,show-cursor=on";',
    'const device = "virtio-vga,max_outputs=1,xres=1600,yres=900";',
  ].join("\n");
  const stamped = stampGraphicsExperiment(source, wasmSha256, "webgl2-present");
  assert.match(stamped, /^\/\/ OMARCHY_EXPERIMENT qemu-wasm-graphics kind=webgl2-present /);
  assert.match(stamped, /sdl,gl=es,show-cursor=on/);
  assert.match(stamped, /virtio-vga,max_outputs=1,xres=1600,yres=900/);
  assert.doesNotMatch(stamped, /virtio-vga-gl/);
  assert.doesNotMatch(stamped, new RegExp(canonical));
  assert.match(stamped, new RegExp(wasmSha256));
});

test("WebGL2 presenter is device-compatible while QEMU 8.2 VirGL remains non-migratable", async () => {
  const [profileBytes, makefile] = await Promise.all([
    readFile(new URL("config/webgl2-present.json", runtime)),
    readFile(new URL("Makefile", runtime), "utf8"),
  ]);
  const profile = JSON.parse(profileBytes);
  const args = profile.qemu.arguments;
  assert.equal(args[args.indexOf("-display") + 1], "sdl,gl=es,show-cursor=on");
  assert.equal(args[args.indexOf("-device") + 1], "virtio-vga,max_outputs=1,xres=1600,yres=900");
  assert.equal(args.includes("virtio-vga-gl,max_outputs=1,xres=1600,yres=900"), false);
  assert.match(makefile, /build-webgl2-present:/);
  assert.match(makefile, /package-webgl2-present:/);
  assert.match(makefile, /serve-full-webgl2-present:/);

  const upstream = process.env.QEMU_WASM_SOURCE ?? "/private/tmp/qemu-wasm-source";
  const virtioGpuBase = await readFile(join(upstream, "hw/display/virtio-gpu-base.c"), "utf8");
  assert.match(virtioGpuBase, /virtio_gpu_virgl_enabled\(g->conf\)/);
  assert.match(virtioGpuBase, /"virgl is not yet migratable"/);
  assert.match(virtioGpuBase, /migrate_add_blocker/);
});

test("VirGL/WebGL2, threshold-750, and four vCPUs combine only in isolation", async () => {
  const canonical = "c49072051ba41f5edc9c5044ff3623563aa9088314b0e63207f53d36b3a7dae8";
  const candidate = "c".repeat(64);
  const source = [
    `const identity = { browserQemuWasmSha256: "${canonical}" };`,
    "const qemu = { cores: 2, arguments: [",
    '  "2,sockets=1,cores=2,threads=1",',
    '], smp: "2,sockets=1,cores=2,threads=1",',
    'restoreSmp: "2,sockets=1,cores=2,threads=1" };',
    'const display = "sdl,gl=off,show-cursor=on";',
    'const device = "virtio-vga,max_outputs=1,xres=1600,yres=900";',
  ].join("\n");
  const tcgStamped = stampTcgThresholdExperiment(source, candidate, "750");
  const combined = stampGraphicsExperiment(tcgStamped, candidate, "virgl-webgl2");
  const fourVcpu = stampVcpuExperiment(combined, candidate, 4);
  assert.match(combined, /^\/\/ OMARCHY_EXPERIMENT qemu-wasm-graphics kind=virgl-webgl2 /);
  assert.match(combined, /OMARCHY_EXPERIMENT qemu-wasm-tcg-hot-threshold threshold=750 /);
  assert.match(combined, /browserQemuWasmSha256: "c{64}"/);
  assert.match(combined, /sdl,gl=es,show-cursor=on/);
  assert.match(combined, /virtio-vga-gl,max_outputs=1,xres=1600,yres=900/);
  assert.match(fourVcpu, /^\/\/ OMARCHY_EXPERIMENT browser-vcpus count=4 /);
  assert.match(fourVcpu, /cores: 4,/);
  assert.equal(fourVcpu.split("4,sockets=1,cores=4,threads=1").length - 1, 3);
  assert.throws(() => stampVcpuExperiment(fourVcpu, candidate, 4), /already stamped/);

  const [makefile, buildScript, packageScript, verifier] = await Promise.all([
    readFile(new URL("Makefile", runtime), "utf8"),
    readFile(new URL("scripts/build-qemu-wasm.sh", runtime), "utf8"),
    readFile(new URL("scripts/package-guest.sh", runtime), "utf8"),
    readFile(new URL("scripts/verify-runtime-artifacts.mjs", runtime), "utf8"),
  ]);
  assert.match(makefile, /build-virgl-webgl2-tcg-baseline-metrics:/);
  assert.match(makefile, /build-virgl-webgl2-tcg-threshold-750-4vcpu:/);
  assert.match(makefile, /VIRGL_WEBGL2_TCG_BASELINE_OUTPUT/);
  assert.match(makefile, /VIRGL_WEBGL2_TCG_750_4VCPU_OUTPUT/);
  assert.match(buildScript, /"1500-metrics" \|\| "\$tcg_experiment" == "750"/);
  assert.match(packageScript, /"1500-metrics" \|\| "\$tcg_experiment" == "750"/);
  assert.match(
    verifier,
    /only an instrumented VirGL-compatible TCG profile may be combined/,
  );
});

test("threshold-750 applies on top of measured baseline and retains bounded metrics", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-runtime-tcg-750-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "tcg"));
  const upstream = process.env.QEMU_WASM_SOURCE ?? "/private/tmp/qemu-wasm-source";
  for (const relativePath of ["tcg/wasm32.c", "tcg/wasm32.h"]) {
    await writeFile(join(root, relativePath), await readFile(join(upstream, relativePath)));
  }
  for (const relativePatch of [
    "patches/qemu-wasm-tcg-vcpu-layout.patch",
    "patches/qemu-wasm-tcg-baseline-threshold-1500-metrics.patch",
    "patches/qemu-wasm-tcg-hot-threshold-750.patch",
  ]) {
    const result = spawnSync(
      "patch",
      ["--quiet", "--directory", root, "--strip=1", "--input", new URL(relativePatch, runtime).pathname],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${relativePatch}: ${result.stderr}`);
  }
  const [source, header] = await Promise.all([
    readFile(join(root, "tcg/wasm32.c"), "utf8"),
    readFile(join(root, "tcg/wasm32.h"), "utf8"),
  ]);
  assert.match(header, /OMARCHY_WASM_TCG_HOT_THRESHOLD 750/);
  assert.match(source, /current_machine->smp\.cpus/);
  assert.match(source, /return MAX\(browser_cores, guest_cores\)/);
  assert.match(source, /cur_core_num >= all_cores_num/);
  assert.match(source, /OMARCHY_TCG_MODULE_MAGIC_INVALID/);
  assert.match(header, /OMARCHY_WASM_TCG_METRICS_SCHEMA 2/);
  assert.match(source, /threshold=750 metrics-schema=2/);
  for (const marker of ["cross-500=%", "cross-750=%", "cross-1000=%", "cross-1500=%"]) {
    assert.ok(source.includes(marker), `missing threshold distribution metric ${marker}`);
  }
});

test("VirGL/WebGL2 final link transfers the canvas only for the isolated renderer", async () => {
  const patch = await readFile(new URL("patches/qemu-wasm-virgl-webgl-link.patch", runtime), "utf8");
  assert.match(patch, /OFFSCREENCANVASES_TO_PTHREAD=#canvas/);
  assert.match(patch, /host_arch == 'wasm32' and virgl\.found\(\) and opengl\.found\(\)/);
  const buildScript = await readFile(new URL("scripts/build-inside-container.sh", runtime), "utf8");
  assert.match(buildScript, /'-sOFFSCREENCANVASES_TO_PTHREAD=""'/);
  assert.doesNotMatch(buildScript, /OFFSCREENCANVASES_TO_PTHREAD=#canvas/);
});

test("VirGL/WebGL2 owns one non-proxied context on the QEMU pthread", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-webgl-context-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "include/ui"), { recursive: true });
  await mkdir(join(root, "ui"), { recursive: true });
  const upstream = process.env.QEMU_WASM_SOURCE ?? "/private/tmp/qemu-wasm-source";
  for (const relativePath of ["include/ui/sdl2.h", "ui/sdl2.c", "ui/sdl2-gl.c"]) {
    await writeFile(join(root, relativePath), await readFile(join(upstream, relativePath)));
  }
  await mkdir(join(root, "system"), { recursive: true });
  await writeFile(join(root, "system/main.c"), await readFile(join(upstream, "system/main.c")));
  await writeFile(join(root, "ui/sdl2-2d.c"), await readFile(join(upstream, "ui/sdl2-2d.c")));
  for (const relativePatch of [
    "patches/qemu-sdl-frame-hook.patch",
    "patches/qemu-sdl-frame-sampling.patch",
    "patches/qemu-wasm-input-bridge.patch",
    "patches/qemu-wasm-runstate-guard.patch",
    "patches/qemu-wasm-sdl-texture-reuse.patch",
    "patches/qemu-wasm-sdl-pageflip-coalesce.patch",
    "patches/qemu-wasm-worker-dom.patch",
  ]) {
    const prerequisite = new URL(relativePatch, runtime).pathname;
    const applied = spawnSync(
      "patch",
      ["--quiet", "--directory", root, "--strip=1", "--input", prerequisite],
      { encoding: "utf8" },
    );
    assert.equal(applied.status, 0, `${relativePatch}: ${applied.stderr}`);
  }
  const patch = new URL("patches/qemu-wasm-sdl-webgl-context.patch", runtime).pathname;
  const result = spawnSync(
    "git",
    ["apply", "--recount", "--unidiff-zero", "--unsafe-paths", patch],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const frameProofPatch = new URL(
    "patches/qemu-wasm-sdl-webgl-frame-proof.patch",
    runtime,
  ).pathname;
  const frameProofResult = spawnSync(
    "git",
    ["apply", "--recount", "--unsafe-paths", frameProofPatch],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(frameProofResult.status, 0, frameProofResult.stderr);

  const [header, sdl, softwareGlProof, gl] = await Promise.all([
    readFile(join(root, "include/ui/sdl2.h"), "utf8"),
    readFile(join(root, "ui/sdl2.c"), "utf8"),
    readFile(join(root, "ui/sdl2-2d.c"), "utf8"),
    readFile(join(root, "ui/sdl2-gl.c"), "utf8"),
  ]);
  assert.match(header, /sdl2_gl_window_context_create/);
  assert.match(sdl, /sdl2_gl_window_context_create\(scon\)/);
  assert.match(gl, /majorVersion = 2/);
  assert.match(gl, /proxyContextToMainThread = EMSCRIPTEN_WEBGL_CONTEXT_PROXY_DISALLOW/);
  assert.match(gl, /explicitSwapControl = EM_TRUE/);
  assert.match(gl, /emscripten_webgl_commit_frame/);
  assert.match(gl, /return \(QEMUGLContext\)scon->winctx/);
  assert.match(gl, /webgl2-frame-presented sequence=/);
  assert.match(gl, /webgl2-present-cadence frames=/);
  assert.match(gl, /OMARCHY_GL_SAMPLE_INTERVAL_MS 250\.0/);
  assert.match(gl, /glReadPixels\(0, 0, OMARCHY_GL_FRAME_SAMPLE_COLUMNS/);
  assert.match(gl, /Module\['onGuestFrame'\]\(\$0, \$1, \$2, \$3, \$4, \$5, \$6\)/);
  assert.match(softwareGlProof, /int omarchy_desktop_proof_state;/);
  assert.match(header, /egl_fb proof_fb/);
  assert.doesNotMatch(sdl, /SDL_GL_CreateContext/);
});

test("single-thread TCG initializes the per-thread Wasm translator before execution", async () => {
  const patch = await readFile(new URL("patches/qemu-wasm-tcg-rr-init.patch", runtime), "utf8");
  const buildScript = await readFile(new URL("scripts/build-qemu-wasm.sh", runtime), "utf8");

  assert.match(patch, /static void \*rr_cpu_thread_fn/);
  assert.match(patch, /init_wasm32\(\);/);
  assert.match(patch, /wasm32-tcg-thread-initialized mode=rr/);
  assert.ok(
    patch.indexOf("init_wasm32();") < patch.indexOf("assert(tcg_enabled());"),
    "the thread-local bridge must exist before the first TCG execution path",
  );
  assert.match(buildScript, /tcg-accel-ops-rr\.c:\/qemu-src\/accel\/tcg\/tcg-accel-ops-rr\.c:ro/);
});

test("guest frame evidence stores and compares a bounded normalized RGB desktop baseline", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-runtime-frame-sampling-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "system"));
  await mkdir(join(root, "ui"));
  for (const relativePath of ["system/main.c", "ui/sdl2.c", "ui/sdl2-2d.c"]) {
    const source = join(process.env.QEMU_WASM_SOURCE ?? "/private/tmp/qemu-wasm-source", relativePath);
    const destination = join(root, relativePath);
    await writeFile(destination, await readFile(source));
  }
  for (const relativePatch of [
    "patches/qemu-sdl-frame-hook.patch",
    "patches/qemu-sdl-frame-sampling.patch",
    "patches/qemu-wasm-input-bridge.patch",
    "patches/qemu-wasm-runstate-guard.patch",
    "patches/qemu-wasm-sdl-texture-reuse.patch",
    "patches/qemu-wasm-sdl-pageflip-coalesce.patch",
  ]) {
    const patch = new URL(relativePatch, runtime).pathname;
    const result = spawnSync("patch", ["--quiet", "--directory", root, "--strip=1", "--input", patch], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${relativePatch}: ${result.stderr}`);
  }
  const patched = await readFile(join(root, "ui/sdl2-2d.c"), "utf8");
  assert.match(patched, /OMARCHY_FRAME_SAMPLE_COLUMNS 32/);
  assert.match(patched, /OMARCHY_FRAME_SAMPLE_ROWS 18/);
  assert.match(patched, /uint32_t omarchy_desktop_baseline\[OMARCHY_FRAME_SAMPLE_COUNT\]/);
  assert.match(patched, /omarchy_scale_component/);
  assert.match(patched, /OMARCHY_DESKTOP_MIN_CHANGED_PIXELS 29/);
  assert.match(patched, /OMARCHY_DESKTOP_MAX_DOMINANT_PIXELS 547/);
  assert.match(patched, /dominant_pixels >= 1/);
  assert.match(patched, /int omarchy_desktop_proof_arm\(void\)/);
  assert.match(patched, /int omarchy_desktop_proof_expect_response\(void\)/);
  assert.match(patched, /qatomic_cmpxchg/);
  assert.match(patched, /proof_state == OMARCHY_DESKTOP_PROOF_AWAITING_BASELINE &&\s+runstate_is_running\(\)/);
  assert.match(patched, /SDL_QueryTexture/);
  assert.match(patched, /sdl-texture-reused monotonic-ms=/);
  assert.match(patched, /page-flip SET_SCANOUT/);
  assert.match(patched, /if \(!reuse_texture\) \{\s+sdl2_2d_redraw\(scon\);\s+\}/);
  assert.match(patched, /sdl-frame-presented sequence=/);
  const patchedInput = await readFile(join(root, "ui/sdl2.c"), "utf8");
  assert.match(patchedInput, /int omarchy_runtime_is_running\(void\)/);
  assert.match(patchedInput, /qatomic_set\(&omarchy_runtime_running/);
  assert.match(patchedInput, /input-modifiers-release-processed/);
  assert.match(
    patched,
    /Module\['onGuestFrame'\]\(\$0, \$1, \$2, \$3, \$4, \$5, \$6\)/,
  );
});

test("kernel fragment enables the browser VM display and input path", async () => {
  const config = await readFile(new URL("config/linux-x86_64.config", runtime), "utf8");
  for (const symbol of [
    "CONFIG_DRM=y",
    "CONFIG_DRM_VIRTIO_GPU=y",
    "CONFIG_VIRTIO_INPUT=y",
    "CONFIG_FRAMEBUFFER_CONSOLE=y",
  ]) {
    assert.match(config, new RegExp(`^${symbol}$`, "m"));
  }
});

test("browser smoke evidence is bound to the passing software-renderer build", async () => {
  const evidence = JSON.parse(await readFile(new URL("evidence/browser-smoke.json", runtime), "utf8"));
  assert.equal(evidence.result, "pass");
  assert.equal(evidence.observations.visibleGuestPixels, true);
  assert.equal(evidence.observations.framebufferSource, "qemu-guest");
  assert.equal(evidence.observations.frameSequenceContinuedIncreasing, true);
  assert.equal(evidence.observations.factoryCanvasTransferred, false);
  assert.equal(evidence.observations.sdlRenderer.name, "software");
  assert.equal(evidence.observations.consoleMessageCount, 0);
  assert.equal(evidence.evidence.screenshotPersisted, false);
  for (const artifact of Object.values(evidence.artifacts)) {
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isInteger(artifact.bytes) && artifact.bytes > 0);
  }
});

test("runtime metadata producer records immutable artifact evidence", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "omarchy-runtime-metadata-"));
  context.after(() => rm(output, { recursive: true, force: true }));
  await mkdir(join(output, "firmware"));
  for (const relativePath of [
    "runtime.mjs",
    "production-worker.mjs",
    "worker-input.mjs",
    "paged-disk.mjs",
    "bounded-overlay.mjs",
    "runtime-manifest.json",
    "runtime-verification.json",
    "qemu.mjs",
    "qemu.wasm",
    "qemu.worker.js",
    "firmware/bios-256k.bin",
    "firmware/vgabios-stdvga.bin",
    "firmware/vgabios-virtio.bin",
    "firmware/kvmvapic.bin",
    "firmware/linuxboot_dma.bin",
  ]) {
    await writeFile(join(output, relativePath), relativePath);
  }
  const fixtureWasmSha256 = createHash("sha256").update("qemu.wasm").digest("hex");
  await writeFile(join(output, "runtime-verification.json"), JSON.stringify({
    wasm: {
      tcgExperiment: { instantiateThreshold: 250, metricsSchemaVersion: 1 },
      tcgExperimentArtifactSha256: fixtureWasmSha256,
    },
  }));

  const producer = new URL("scripts/write-build-metadata.mjs", runtime).pathname;
  const result = spawnSync(process.execPath, [producer, output], {
    encoding: "utf8",
    env: { ...process.env, OMARCHY_TCG_HOT_THRESHOLD_EXPERIMENT: "250" },
  });
  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(await readFile(join(output, "runtime-build.json"), "utf8"));
  assert.equal(metadata.component.commit.length, 40);
  assert.equal(metadata.component.modified, true);
  assert.deepEqual(metadata.component.experiment, {
    kind: "qemu-wasm-tcg-hot-threshold",
    instantiateThreshold: 250,
    metricsSchemaVersion: 1,
    promotionEligible: false,
    diagnosticMarkers: [
      "OMARCHY_RUNTIME_DIAGNOSTIC wasm32-tcg-experiment threshold=250 metrics-schema=1",
      "OMARCHY_RUNTIME_DIAGNOSTIC wasm32-tcg-metrics schema=1 threshold=250",
    ],
  });
  assert.ok(metadata.component.patches.includes("patches/qemu-wasm-tcg-hot-threshold-250.patch"));
  assert.deepEqual(metadata.subprojects.map(({ name }) => name).sort(), [
    "berkeley-softfloat-3",
    "berkeley-testfloat-3",
    "dtc",
    "keycodemapdb",
  ]);
  assert.equal(metadata.artifacts.length, 14);
  assert.equal(
    metadata.artifacts.find(({ path }) => path === "bounded-overlay.mjs").role,
    "snapshot-overlay-guard",
  );
  assert.equal(metadata.artifacts.some(({ path }) => path === "runtime-manifest.json"), false);
  assert.equal(metadata.artifacts.find(({ path }) => path === "runtime.mjs").role, "host-runtime");
  assert.ok(metadata.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256)));

  await writeFile(join(output, "runtime-verification.json"), JSON.stringify({
    wasm: {
      tcgExperiment: { instantiateThreshold: 1500, metricsSchemaVersion: 2 },
      tcgExperimentArtifactSha256: fixtureWasmSha256,
    },
  }));
  const baselineResult = spawnSync(process.execPath, [producer, output], {
    encoding: "utf8",
    env: { ...process.env, OMARCHY_TCG_HOT_THRESHOLD_EXPERIMENT: "1500-metrics" },
  });
  assert.equal(baselineResult.status, 0, baselineResult.stderr);
  const baselineMetadata = JSON.parse(await readFile(join(output, "runtime-build.json"), "utf8"));
  assert.deepEqual(baselineMetadata.component.experiment, {
    kind: "qemu-wasm-tcg-baseline-metrics",
    instantiateThreshold: 1500,
    metricsSchemaVersion: 2,
    promotionEligible: false,
    diagnosticMarkers: [
      "OMARCHY_RUNTIME_DIAGNOSTIC wasm32-tcg-experiment threshold=1500 metrics-schema=2",
      "OMARCHY_RUNTIME_DIAGNOSTIC wasm32-tcg-metrics schema=2 threshold=1500",
    ],
  });
  assert.ok(baselineMetadata.component.patches.includes(
    "patches/qemu-wasm-tcg-baseline-threshold-1500-metrics.patch",
  ));

  await writeFile(join(output, "runtime-verification.json"), JSON.stringify({
    wasm: {
      tcgExperiment: { instantiateThreshold: 750, metricsSchemaVersion: 2 },
      tcgExperimentArtifactSha256: fixtureWasmSha256,
      graphicsExperiment: {
        kind: "virgl-webgl2",
        promotionEligible: false,
        qemuWasmSha256: fixtureWasmSha256,
      },
      vcpuExperiment: {
        count: 4,
        promotionEligible: false,
        qemuWasmSha256: fixtureWasmSha256,
      },
    },
  }));
  const combinedResult = spawnSync(process.execPath, [producer, output], {
    encoding: "utf8",
    env: {
      ...process.env,
      OMARCHY_TCG_HOT_THRESHOLD_EXPERIMENT: "750",
      OMARCHY_GRAPHICS_EXPERIMENT: "virgl-webgl2",
      OMARCHY_VCPU_EXPERIMENT: "4",
    },
  });
  assert.equal(combinedResult.status, 0, combinedResult.stderr);
  const combinedMetadata = JSON.parse(await readFile(join(output, "runtime-build.json"), "utf8"));
  assert.deepEqual(combinedMetadata.component.experiments.map(({ kind }) => kind), [
    "qemu-wasm-tcg-hot-threshold",
    "virgl-webgl2",
    "browser-vcpus",
  ]);
  assert.ok(combinedMetadata.component.patches.includes(
    "patches/qemu-wasm-tcg-baseline-threshold-1500-metrics.patch",
  ));
  assert.ok(combinedMetadata.component.patches.includes(
    "patches/qemu-wasm-sdl-webgl-frame-proof.patch",
  ));
  assert.ok(combinedMetadata.component.patches.includes(
    "patches/qemu-wasm-tcg-hot-threshold-750.patch",
  ));
});

test("runtime metadata records optional legacy preload assets for firmware smoke", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "omarchy-runtime-packaged-metadata-"));
  context.after(() => rm(output, { recursive: true, force: true }));
  await mkdir(join(output, "firmware"));
  for (const relativePath of [
    "runtime.mjs",
    "production-worker.mjs",
    "worker-input.mjs",
    "paged-disk.mjs",
    "bounded-overlay.mjs",
    "runtime-manifest.json",
    "runtime-verification.json",
    "qemu.mjs",
    "qemu.wasm",
    "qemu.worker.js",
    "load.js",
    "qemu.data",
    "firmware/bios-256k.bin",
    "firmware/vgabios-stdvga.bin",
    "firmware/vgabios-virtio.bin",
    "firmware/kvmvapic.bin",
    "firmware/linuxboot_dma.bin",
  ]) {
    await writeFile(join(output, relativePath), relativePath);
  }

  const producer = new URL("scripts/write-build-metadata.mjs", runtime).pathname;
  const result = spawnSync(process.execPath, [producer, output], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(await readFile(join(output, "runtime-build.json"), "utf8"));
  assert.equal(metadata.artifacts.length, 16);
  assert.equal(metadata.artifacts.find(({ path }) => path === "qemu.data").role, "preload-data");
});
