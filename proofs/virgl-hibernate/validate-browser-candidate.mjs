#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_QEMU_COMMIT = "0ef7b4e2814b231705d8371dd7997f5b72e70baf";
const CLOCK_POLICY = Object.freeze({
  kind: "bounded-clock-v2",
  activeCap: 60000,
  replacementCredit: 4096,
  retainedCap: 64096,
  gcPressureBytes: 4 * 1024 * 1024,
  gcPressureInterval: 64,
  gcPressureRetryMilliseconds: 1000,
  gcPressureHold: "next-task",
});
const REQUIRED_WASM_MARKERS = Object.freeze([
  "virtio-vga-gl",
  "virgl",
  "OMARCHY_RUNTIME_DIAGNOSTIC wasm32-tcg-experiment threshold=1500 metrics-schema=4",
  "cache=bounded-clock-v2 active-cap=60000 replacement-credit=4096 retained-cap=64096 gc-pressure-bytes=4194304 gc-pressure-interval=64 gc-pressure-retry-ms=1000 gc-pressure-hold=next-task",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function one(values, predicate, label) {
  const matches = values.filter(predicate);
  invariant(matches.length === 1, `candidate must contain exactly one ${label}`);
  return matches[0];
}

function exactArgument(arguments_, flag, expected) {
  const indexes = arguments_.flatMap((value, index) => value === flag ? [index] : []);
  invariant(indexes.length === 1 && arguments_[indexes[0] + 1] === expected,
    `candidate runtime must use ${flag} ${expected}`);
}

export async function validateBrowserCandidate(wasmPath) {
  invariant(path.basename(wasmPath ?? "") === "qemu.wasm",
    "VIRGL_HIBERNATE_BROWSER_QEMU_WASM must name qemu.wasm");
  const directory = path.dirname(path.resolve(wasmPath));
  const verificationPath = path.join(directory, "runtime-verification.json");
  const buildPath = path.join(directory, "runtime-build.json");
  const runtimeManifestPath = path.join(directory, "runtime-manifest.json");
  const [wasm, verification, build, runtimeManifest] = await Promise.all([
    readFile(wasmPath),
    readFile(verificationPath, "utf8").then(JSON.parse),
    readFile(buildPath, "utf8").then(JSON.parse),
    readFile(runtimeManifestPath, "utf8").then(JSON.parse),
  ]);
  const wasmSha256 = sha256(wasm);
  invariant(WebAssembly.validate(wasm), "candidate qemu.wasm is not valid WebAssembly");
  for (const marker of REQUIRED_WASM_MARKERS) {
    invariant(wasm.includes(Buffer.from(marker)), `candidate qemu.wasm is missing marker: ${marker}`);
  }

  invariant(verification.schemaVersion === 1 && verification.wasm?.valid === true,
    "candidate runtime verification did not pass Wasm validation");
  const verifiedGraphics = verification.wasm.graphicsExperiment;
  invariant(verifiedGraphics?.kind === "virgl-webgl2" &&
    verifiedGraphics.promotionEligible === false &&
    verifiedGraphics.browserApi === "WebGL2" &&
    verifiedGraphics.renderer === "virglrenderer-0.10.4" &&
    verifiedGraphics.qemuWasmSha256 === wasmSha256,
  "candidate verification does not bind the exact non-promotable VirGL/WebGL2 Wasm");
  const verifiedClock = verification.wasm.tcgExperiment;
  assert.deepEqual(verifiedClock, {
    kind: "qemu-wasm-tcg-bounded-clock",
    instantiateThreshold: 1500,
    metricsSchemaVersion: 4,
    cachePolicy: CLOCK_POLICY,
  }, "candidate verification does not prove the exact bounded CLOCK policy");
  invariant(verification.wasm.tcgExperimentArtifactSha256 === wasmSha256,
    "candidate bounded CLOCK verification is bound to different Wasm bytes");
  invariant(verification.javascript?.webgl2Loader === true &&
    verification.javascript?.graphicsExperimentWorkerIdentity === true &&
    verification.javascript?.tcgExperimentWorkerIdentity === true &&
    verification.javascript?.tcgGcPressureNextTask === true,
  "candidate JavaScript verification lacks VirGL/bounded-CLOCK worker identity");

  invariant(build.schemaVersion === 1 && build.component?.name === "QEMU-Wasm" &&
    build.component.repository === "https://github.com/ktock/qemu-wasm.git" &&
    build.component.commit === EXPECTED_QEMU_COMMIT && build.component.modified === true,
  "candidate build metadata has the wrong QEMU source identity");
  const experiments = build.component.experiments ?? [];
  const buildGraphics = one(experiments, ({ kind }) => kind === "virgl-webgl2", "VirGL build experiment");
  const buildClock = one(experiments, ({ kind }) => kind === "qemu-wasm-tcg-bounded-clock",
    "bounded CLOCK build experiment");
  invariant(buildGraphics.promotionEligible === false && buildGraphics.browserApi === "WebGL2" &&
    buildGraphics.renderer?.version === "0.10.4",
  "candidate build metadata does not describe non-promotable VirGL/WebGL2");
  assert.deepEqual(buildClock.cachePolicy, CLOCK_POLICY,
    "candidate build metadata has the wrong bounded CLOCK limits");
  invariant(buildClock.instantiateThreshold === 1500 && buildClock.metricsSchemaVersion === 4 &&
    buildClock.promotionEligible === false,
  "candidate build metadata has the wrong bounded CLOCK profile");
  for (const patch of [
    "patches/qemu-wasm-tcg-bounded-clock-cache.patch",
    "patches/qemu-wasm-virgl-webgl-link.patch",
    "patches/qemu-wasm-sdl-webgl-context.patch",
    "patches/qemu-wasm-sdl-webgl-frame-proof.patch",
  ]) invariant(build.component.patches?.includes(patch), `candidate build is missing ${patch}`);
  const artifact = one(build.artifacts ?? [], ({ path: artifactPath }) => artifactPath === "qemu.wasm",
    "qemu.wasm build artifact");
  invariant(artifact.role === "emulator-wasm" && artifact.mediaType === "application/wasm" &&
    artifact.bytes === wasm.byteLength && artifact.sha256 === wasmSha256,
  "candidate build artifact record does not bind qemu.wasm bytes");

  invariant(runtimeManifest.schemaVersion === 2 && runtimeManifest.qemu?.memoryMiB === 1024 &&
    runtimeManifest.qemu?.cores === 2 && Array.isArray(runtimeManifest.qemu?.arguments),
  "candidate runtime manifest has an incompatible machine envelope");
  const hibernationCandidate = runtimeManifest.checkpoint?.mode === "guest-hibernation-resume";
  invariant(runtimeManifest.checkpoint === undefined || hibernationCandidate,
    "candidate runtime manifest has an unsupported checkpoint mode");
  exactArgument(
    runtimeManifest.qemu.arguments,
    "-machine",
    hibernationCandidate ? "pc-q35-8.2,i8042=off" : "pc-q35-8.2",
  );
  exactArgument(runtimeManifest.qemu.arguments, "-m", "1024M");
  exactArgument(runtimeManifest.qemu.arguments, "-accel", "tcg,tb-size=128,thread=multi");
  exactArgument(runtimeManifest.qemu.arguments, "-smp", "2,sockets=1,cores=2,threads=1");
  exactArgument(runtimeManifest.qemu.arguments, "-display", "sdl,gl=es,show-cursor=on");
  invariant(runtimeManifest.qemu.arguments.filter((value) =>
    value === "virtio-vga-gl,max_outputs=1,xres=1600,yres=900").length === 1,
  "candidate runtime manifest lacks the exact VirGL display device");

  return Object.freeze({
    schemaVersion: 1,
    status: "PASS",
    profile: "virgl-webgl2-tcg-bounded-clock",
    qemuWasmPath: path.resolve(wasmPath),
    qemuWasmBytes: wasm.byteLength,
    qemuWasmSha256: wasmSha256,
    runtimeVerificationSha256: sha256(await readFile(verificationPath)),
    runtimeBuildSha256: sha256(await readFile(buildPath)),
    runtimeManifestSha256: sha256(await readFile(runtimeManifestPath)),
  });
}

async function main() {
  const [wasmPath] = process.argv.slice(2);
  if (!wasmPath) throw new Error("usage: validate-browser-candidate.mjs /absolute/path/to/qemu.wasm");
  process.stdout.write(`${JSON.stringify(await validateBrowserCandidate(wasmPath), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`VIRGL_HIBERNATE_BROWSER_CANDIDATE_FAIL ${error.message}\n`);
    process.exitCode = 1;
  });
}
