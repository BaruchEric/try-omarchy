import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  RuntimeConfigurationError,
  OmarchyWasmRuntime,
  formatCapabilityError,
  inspectBrowserCapabilities,
  parseGuestReportLine,
  parseRuntimeDiagnosticLine,
  validateManifest,
} from "../web/runtime.mjs";
import {
  FULL_GUEST_MAX_DOMINANT_PIXELS,
  FULL_GUEST_MIN_CHANGED_PIXELS,
  FULL_GUEST_SAMPLE_PIXELS,
  fullGuestReportMatchesRelease,
  normalizeFullGuestDesktopProof,
  normalizeFullGuestFrame,
  normalizeFullGuestRelease,
} from "../web/full-guest-evidence.mjs";
import {
  DESKTOP_PROOF_MAX_DOMINANT_PIXELS,
  DESKTOP_PROOF_MIN_CHANGED_PIXELS,
  DESKTOP_PROOF_SAMPLE_PIXELS,
  isDesktopProof,
} from "../../public/vm/desktop-proof.mjs";
import {
  normalizeRuntimeDesktopProof as normalizePublicDesktopProof,
  normalizeRuntimeGuestFrame as normalizePublicGuestFrame,
} from "../../public/vm/host-utils.mjs";

const manifestUrl = new URL("../config/demo.json", import.meta.url);
const smokeManifestUrl = new URL("../config/smoke.json", import.meta.url);

async function manifest() {
  return JSON.parse(await readFile(manifestUrl, "utf8"));
}

test("the checked-in manifest selects a graphical x86_64 runtime", async () => {
  const value = validateManifest(await manifest());
  assert.equal(value.qemu.memoryMiB, 1024);
  assert.equal(value.qemu.arguments[value.qemu.arguments.indexOf("-m") + 1], "1024M");
  assert.equal(value.qemu.cores, 2);
  assert.equal(
    value.qemu.arguments[value.qemu.arguments.indexOf("-accel") + 1],
    "tcg,tb-size=128,thread=multi",
  );
  assert.equal(
    value.qemu.arguments[value.qemu.arguments.indexOf("-smp") + 1],
    "2,sockets=1,cores=2,threads=1",
  );
  assert.deepEqual(value.qemu.arguments.slice(0, 2), ["-machine", "pc-q35-8.2"]);
  assert.equal(value.qemu.arguments.includes("-nographic"), false);
  assert.match(value.qemu.arguments[value.qemu.arguments.indexOf("-display") + 1], /^sdl/);
  assert.ok(value.qemu.arguments.some((argument) => argument.startsWith("virtio-vga")));
  assert.ok(value.qemu.arguments.includes("virtio-vga,max_outputs=1,xres=1600,yres=900"));
  assert.ok(value.qemu.arguments.includes("stdio,id=omarchy-diag,mux=on"));
  assert.ok(value.qemu.arguments.includes("chardev:omarchy-diag"));
  assert.ok(value.qemu.arguments.includes(
    "virtserialport,chardev=omarchy-diag,name=omarchy.web.diagnostics",
  ));
  assert.equal(value.qemu.arguments[value.qemu.arguments.indexOf("-parallel") + 1], "none");
  assert.equal(value.schemaVersion, 2);
  assert.equal(value.runtimeMode, "worker-paged");
  assert.equal(value.qemu.arguments.includes("-snapshot"), false);
  assert.equal(value.qemu.arguments.includes("-drive"), false);
  assert.equal("preload" in value.assets, false);
  assert.equal("data" in value.assets, false);
  assert.equal(value.assets.hostWorker, "production-worker.mjs");
  assert.equal(value.assets.pagedDisk, "paged-disk.mjs");
  assert.equal(value.assets.boundedOverlay, "bounded-overlay.mjs");
  assert.equal(value.guest.rootfs.mountPath, "/pack/rootfs.ext4");
});

test("full-guest harness requires the production desktop-proof contract before readiness", async () => {
  assert.equal(FULL_GUEST_SAMPLE_PIXELS, DESKTOP_PROOF_SAMPLE_PIXELS);
  assert.equal(FULL_GUEST_MIN_CHANGED_PIXELS, DESKTOP_PROOF_MIN_CHANGED_PIXELS);
  assert.equal(FULL_GUEST_MAX_DOMINANT_PIXELS, DESKTOP_PROOF_MAX_DOMINANT_PIXELS);

  const artifactManifestSha256 = "c".repeat(64);
  const upstream = {
    repository: "https://github.com/basecamp/omarchy",
    commit: "a".repeat(40),
    version: "4.0.0.alpha",
    treeSha256: "b".repeat(64),
  };
  const release = normalizeFullGuestRelease({
    type: "release",
    upstream,
    artifactManifestSha256,
  });
  assert.deepEqual(release, { upstream, artifactManifestSha256 });
  assert.equal(fullGuestReportMatchesRelease({ provenance: upstream }, release), true);
  assert.equal(fullGuestReportMatchesRelease({
    provenance: { ...upstream, commit: "d".repeat(40) },
  }, release), false);

  const frameMessage = {
    type: "guestframe",
    sequence: 13,
    source: "qemu-guest",
    guestWidth: 1600,
    guestHeight: 900,
    timestamp: 1.5,
    sampledPixels: FULL_GUEST_SAMPLE_PIXELS,
    nonBlackPixels: 211,
  };
  const frame = normalizeFullGuestFrame(frameMessage);
  assert.equal(frame.sequence, 13);
  assert.deepEqual(frame, normalizePublicGuestFrame(frameMessage));

  const proofMessage = {
    type: "desktopproof",
    proof: {
      schemaVersion: 1,
      artifactManifestSha256,
      challengeSha256: "d".repeat(64),
      baselineSequence: 10,
      responseSequence: 12,
      sampledPixels: FULL_GUEST_SAMPLE_PIXELS,
      changedPixels: FULL_GUEST_MIN_CHANGED_PIXELS,
      dominantPixels: FULL_GUEST_MAX_DOMINANT_PIXELS,
    },
  };
  const proof = normalizeFullGuestDesktopProof(proofMessage, artifactManifestSha256);
  assert.equal(isDesktopProof(proof, artifactManifestSha256), true);
  assert.deepEqual(
    proof,
    normalizePublicDesktopProof(proofMessage, artifactManifestSha256),
    "the dev harness and verified public host must consume the identical proof contract",
  );
  assert.equal(normalizeFullGuestDesktopProof({
    ...proofMessage,
    proof: { ...proofMessage.proof, dominantPixels: FULL_GUEST_SAMPLE_PIXELS },
  }, artifactManifestSha256), null, "the known uniform-dark response must not qualify");
  assert.equal(normalizeFullGuestDesktopProof(
    proofMessage,
    "e".repeat(64),
  ), null, "proof must be bound to the verified artifact manifest");

  const source = await readFile(new URL("../web/full-guest.mjs", import.meta.url), "utf8");
  assert.match(source, /normalizeFullGuestRelease\(data\)/);
  assert.match(source, /fullGuestReportMatchesRelease\(data\.report, state\.releaseIdentity\)/);
  assert.match(source, /normalizeFullGuestDesktopProof/);
  assert.match(source, /origin === "checkpoint-source-evidence"/);
  assert.match(source, /origin !== "live-guest-serial"/);
  assert.match(source, /state\.guestReportOrigin = origin/);
  assert.match(source, /canvas\.dataset\.guestReportOrigin = origin/);
  assert.match(source, /preProofGuestFrameSequences\.has\(proof\.baselineSequence\)/);
  assert.match(source, /frame\.sequence <= state\.desktopProof\.responseSequence/);
  assert.match(source, /frame\.nonBlackPixels <= 0/);
  assert.match(source, /function fail\(error\) \{\n {2}if \(state\.stopped\) return;/);
  assert.match(source, /function updateReady\(\) \{\n {2}if \(state\.stopped \|\| state\.phase !== "running"\) return;/);
  assert.match(source, /function onWorkerMessage\(\{ data \}\) \{\n {2}if \(state\.stopped\) return;/);
  assert.match(source, /input event \(diagnostic only\)/);
  assert.doesNotMatch(source, /frame\.sequence <= state\.frameSequenceAtReport/);
});

test("the firmware smoke proves SDL without loading a guest disk", async () => {
  const value = validateManifest(JSON.parse(await readFile(smokeManifestUrl, "utf8")));
  assert.equal(value.qemu.memoryMiB, 512);
  assert.equal(value.qemu.arguments.includes("-kernel"), false);
  assert.equal(value.qemu.arguments.includes("-drive"), false);
  assert.equal(value.qemu.arguments.includes("-display"), true);
  assert.equal(value.qemu.arguments.includes("-boot"), true);
  assert.deepEqual(
    value.qemu.arguments.slice(value.qemu.arguments.indexOf("-vga"), value.qemu.arguments.indexOf("-vga") + 2),
    ["-vga", "std"],
  );
  assert.equal(value.qemu.arguments[value.qemu.arguments.indexOf("-bios") + 1], "/pack/bios-256k.bin");
});

test("guest reports are accepted only from the serial evidence prefix", () => {
  assert.equal(parseGuestReportLine("ordinary serial output"), null);
  assert.deepEqual(
    parseGuestReportLine('OMARCHY_GUEST_REPORT {"schemaVersion":1,"guestArchitecture":"x86_64"}'),
    { schemaVersion: 1, guestArchitecture: "x86_64" },
  );
  assert.deepEqual(
    parseGuestReportLine('omarchy-web login: OMARCHY_GUEST_REPORT {"schemaVersion":1}\r\n'),
    { schemaVersion: 1 },
  );
  assert.throws(() => parseGuestReportLine("OMARCHY_GUEST_REPORT []"), /JSON object/);
  assert.throws(() => parseGuestReportLine("OMARCHY_GUEST_REPORT not-json"), SyntaxError);
  assert.throws(
    () => parseGuestReportLine(
      'OMARCHY_GUEST_REPORT {"schemaVersion":1} OMARCHY_GUEST_REPORT {"schemaVersion":1}',
    ),
    /more than one evidence marker/,
  );
  assert.throws(
    () => parseGuestReportLine('OMARCHY_GUEST_REPORT {"schemaVersion":1}\nnot-a-newline'),
    /data after its line ending/,
  );
});

test("runtime diagnostics preserve their source stage and message", () => {
  assert.equal(parseRuntimeDiagnosticLine("ordinary stderr"), null);
  assert.deepEqual(
    parseRuntimeDiagnosticLine("OMARCHY_RUNTIME_DIAGNOSTIC sdl-init-complete driver=emscripten"),
    { stage: "sdl-init-complete", message: "driver=emscripten" },
  );
});

test("headless configuration is rejected", async () => {
  const value = await manifest();
  value.qemu.arguments.push("-nographic");
  assert.throws(() => validateManifest(value), RuntimeConfigurationError);
});

test("unsafe asset paths are rejected", async () => {
  const value = await manifest();
  value.assets.module = "../outside.mjs";
  assert.throws(() => validateManifest(value), /safe relative path/);
});

test("capability report proves all prerequisites independently", () => {
  const supportedScope = {
    WebAssembly,
    Worker: class Worker {},
    SharedArrayBuffer,
    Atomics,
    crossOriginIsolated: true,
    OffscreenCanvas: class OffscreenCanvas {},
  };
  assert.deepEqual(inspectBrowserCapabilities(supportedScope).missing, []);

  const unsupportedScope = { ...supportedScope, crossOriginIsolated: false };
  const report = inspectBrowserCapabilities(unsupportedScope);
  assert.equal(report.supported, false);
  assert.ok(report.missing.includes("crossOriginIsolated"));
  assert.match(formatCapabilityError(report), /COOP\/COEP/);
});

test("runtime invokes native fetch with the browser global as its receiver", async () => {
  class Canvas {}
  let receiverMatchesScope = false;
  const scope = {
    WebAssembly,
    Worker: class Worker {},
    SharedArrayBuffer,
    Atomics,
    crossOriginIsolated: true,
    OffscreenCanvas: class OffscreenCanvas {},
    HTMLCanvasElement: Canvas,
    fetch() {
      receiverMatchesScope = this === scope;
      return Promise.resolve({ ok: false, status: 418 });
    },
  };
  const runtime = new OmarchyWasmRuntime({
    baseUrl: "https://runtime.invalid/",
    canvas: new Canvas(),
    document: { baseURI: "https://runtime.invalid/" },
    scope,
  });

  await assert.rejects(runtime.start(), /HTTP 418/);
  assert.equal(receiverMatchesScope, true);
});
