#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputDirectory = resolve(process.argv[2] ?? join(runtimeDirectory, "dist"));
const lock = JSON.parse(await readFile(join(runtimeDirectory, "upstream.lock.json"), "utf8"));
const tcgExperiment = process.env.OMARCHY_TCG_HOT_THRESHOLD_EXPERIMENT;
const graphicsExperiment = process.env.OMARCHY_GRAPHICS_EXPERIMENT;
const vcpuExperiment = process.env.OMARCHY_VCPU_EXPERIMENT;
const tcgExperimentProfiles = Object.freeze({
  "250": Object.freeze({
    kind: "qemu-wasm-tcg-hot-threshold",
    instantiateThreshold: 250,
    metricsSchemaVersion: 1,
    patches: ["patches/qemu-wasm-tcg-hot-threshold-250.patch"],
  }),
  "750": Object.freeze({
    kind: "qemu-wasm-tcg-hot-threshold",
    instantiateThreshold: 750,
    metricsSchemaVersion: 2,
    patches: [
      "patches/qemu-wasm-tcg-baseline-threshold-1500-metrics.patch",
      "patches/qemu-wasm-tcg-hot-threshold-750.patch",
    ],
  }),
  "1500-metrics": Object.freeze({
    kind: "qemu-wasm-tcg-baseline-metrics",
    instantiateThreshold: 1500,
    metricsSchemaVersion: 2,
    patches: ["patches/qemu-wasm-tcg-baseline-threshold-1500-metrics.patch"],
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
    patches: [
      "patches/qemu-wasm-tcg-baseline-threshold-1500-metrics.patch",
      "patches/qemu-wasm-tcg-bounded-clock-cache.patch",
    ],
    cachePolicyMarker:
      "cache=bounded-clock-v2 active-cap=60000 replacement-credit=4096 retained-cap=64096 " +
      "gc-pressure-bytes=4194304 gc-pressure-interval=64 gc-pressure-retry-ms=1000 " +
      "gc-pressure-hold=next-task",
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
    patches: [
      "patches/qemu-wasm-tcg-baseline-threshold-1500-metrics.patch",
      "patches/qemu-wasm-tcg-fill-only-120k.patch",
    ],
    cachePolicyMarker:
      "cache=fill-only-v1 active-cap=120000 retained-cap=120000 " +
      "eviction=disabled gc-pressure=disabled",
  }),
});
const tcgExperimentProfile = tcgExperimentProfiles[tcgExperiment] ?? null;
if (tcgExperiment !== undefined && tcgExperiment !== "" && tcgExperimentProfile === null) {
  throw new Error(`unsupported QEMU-Wasm TCG threshold experiment: ${tcgExperiment}`);
}
if (graphicsExperiment !== undefined && graphicsExperiment !== "" &&
    graphicsExperiment !== "virgl-webgl2" && graphicsExperiment !== "webgl2-present") {
  throw new Error(`unsupported QEMU-Wasm graphics experiment: ${graphicsExperiment}`);
}
if (tcgExperimentProfile !== null && graphicsExperiment === "virgl-webgl2" &&
    ![750, 1500, 6000].includes(tcgExperimentProfile.instantiateThreshold)) {
  throw new Error("only an instrumented VirGL-compatible TCG profile may be combined with VirGL/WebGL2");
}
if (vcpuExperiment !== undefined && vcpuExperiment !== "" && vcpuExperiment !== "4") {
  throw new Error(`unsupported browser vCPU experiment: ${vcpuExperiment}`);
}
if (vcpuExperiment === "4" &&
    !([750, 6000].includes(tcgExperimentProfile?.instantiateThreshold) &&
      graphicsExperiment === "virgl-webgl2")) {
  throw new Error("the four-vCPU experiment requires VirGL/WebGL2 plus a compatible instrumented TCG profile");
}

const artifactDefinitions = [
  ["runtime.mjs", "host-runtime", "text/javascript"],
  ["production-worker.mjs", "host-worker", "text/javascript"],
  ["worker-input.mjs", "host-input-bridge", "text/javascript"],
  ["paged-disk.mjs", "paged-disk-adapter", "text/javascript"],
  ["bounded-overlay.mjs", "snapshot-overlay-guard", "text/javascript"],
  ["runtime-verification.json", "runtime-verification", "application/json"],
  ["qemu.mjs", "emulator-loader", "text/javascript"],
  ["qemu.wasm", "emulator-wasm", "application/wasm"],
  ["qemu.worker.js", "emulator-worker", "text/javascript"],
  ["firmware/bios-256k.bin", "firmware", "application/octet-stream"],
  ["firmware/vgabios-stdvga.bin", "firmware", "application/octet-stream"],
  ["firmware/vgabios-virtio.bin", "firmware", "application/octet-stream"],
  ["firmware/kvmvapic.bin", "firmware", "application/octet-stream"],
  ["firmware/linuxboot_dma.bin", "firmware", "application/octet-stream"],
];
const optionalArtifactDefinitions = [
  ["load.js", "preload-loader", "text/javascript"],
  ["qemu.data", "preload-data", "application/octet-stream"],
];

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const artifacts = [];
for (const [relativePath, role, mediaType] of [...artifactDefinitions, ...optionalArtifactDefinitions]) {
  const path = join(outputDirectory, relativePath);
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (optionalArtifactDefinitions.some(([candidate]) => candidate === relativePath) && error?.code === "ENOENT") {
      continue;
    }
    throw error;
  }
  artifacts.push({
    path: relativePath,
    role,
    mediaType,
    bytes: info.size,
    sha256: await sha256(path),
  });
}

if (tcgExperimentProfile !== null) {
  const verification = JSON.parse(
    await readFile(join(outputDirectory, "runtime-verification.json"), "utf8"),
  );
  const wasmArtifact = artifacts.find(({ path }) => path === "qemu.wasm");
  if (verification?.wasm?.tcgExperiment?.instantiateThreshold !==
        tcgExperimentProfile.instantiateThreshold ||
      verification?.wasm?.tcgExperiment?.metricsSchemaVersion !==
        tcgExperimentProfile.metricsSchemaVersion ||
      (tcgExperimentProfile.cachePolicy !== undefined &&
        (verification?.wasm?.tcgExperiment?.kind !== tcgExperimentProfile.kind ||
          JSON.stringify(verification?.wasm?.tcgExperiment?.cachePolicy) !==
            JSON.stringify(tcgExperimentProfile.cachePolicy))) ||
      verification?.wasm?.tcgExperimentArtifactSha256 !== wasmArtifact?.sha256) {
    throw new Error("TCG experiment build metadata is not backed by verified QEMU Wasm bytes");
  }
}
if (graphicsExperiment === "virgl-webgl2" || graphicsExperiment === "webgl2-present") {
  const verification = JSON.parse(
    await readFile(join(outputDirectory, "runtime-verification.json"), "utf8"),
  );
  const wasmArtifact = artifacts.find(({ path }) => path === "qemu.wasm");
  if (verification?.wasm?.graphicsExperiment?.kind !== graphicsExperiment ||
      verification?.wasm?.graphicsExperiment?.promotionEligible !== false ||
      verification?.wasm?.graphicsExperiment?.qemuWasmSha256 !== wasmArtifact?.sha256) {
    throw new Error("graphics experiment build metadata is not backed by verified QEMU Wasm bytes");
  }
}
if (vcpuExperiment === "4") {
  const verification = JSON.parse(
    await readFile(join(outputDirectory, "runtime-verification.json"), "utf8"),
  );
  const wasmArtifact = artifacts.find(({ path }) => path === "qemu.wasm");
  if (verification?.wasm?.vcpuExperiment?.count !== 4 ||
      verification?.wasm?.vcpuExperiment?.promotionEligible !== false ||
      verification?.wasm?.vcpuExperiment?.qemuWasmSha256 !== wasmArtifact?.sha256) {
    throw new Error("vCPU experiment build metadata is not backed by verified QEMU Wasm bytes");
  }
}

const patches = [
  "patches/qemu-wasm-builder-zlib-url.patch",
  "patches/qemu-sdl-frame-hook.patch",
  "patches/qemu-sdl-frame-sampling.patch",
  "patches/qemu-wasm-input-bridge.patch",
  "patches/qemu-wasm-runstate-guard.patch",
  "patches/qemu-wasm-sdl-texture-reuse.patch",
  "patches/qemu-wasm-worker-dom.patch",
  "patches/qemu-wasm-tcg-rr-init.patch",
  "patches/qemu-wasm-tcg-vcpu-layout.patch",
];
if (tcgExperimentProfile !== null) {
  patches.push(...tcgExperimentProfile.patches);
}
if (graphicsExperiment === "virgl-webgl2" || graphicsExperiment === "webgl2-present") {
  patches.push(
    "patches/qemu-wasm-virgl-webgl-link.patch",
    "patches/qemu-wasm-sdl-webgl-context.patch",
    "patches/qemu-wasm-sdl-webgl-frame-proof.patch",
    "patches/qemu-wasm-browser-performance-hooks.patch",
    "patches/virglrenderer-webgl-platform.patch",
    "patches/virglrenderer-webgl-winsys.patch",
    "patches/virglrenderer-webgl-no-vtest.patch",
    "patches/virglrenderer-webgl-capabilities.patch",
  );
}

const tcgExperimentMetadata = tcgExperimentProfile === null ? null : {
  kind: tcgExperimentProfile.kind,
  instantiateThreshold: tcgExperimentProfile.instantiateThreshold,
  metricsSchemaVersion: tcgExperimentProfile.metricsSchemaVersion,
  promotionEligible: false,
  ...(tcgExperimentProfile.cachePolicy !== undefined
    ? { cachePolicy: tcgExperimentProfile.cachePolicy }
    : {}),
  diagnosticMarkers: [
    `OMARCHY_RUNTIME_DIAGNOSTIC wasm32-tcg-experiment threshold=${tcgExperimentProfile.instantiateThreshold} metrics-schema=${tcgExperimentProfile.metricsSchemaVersion}`,
    `OMARCHY_RUNTIME_DIAGNOSTIC wasm32-tcg-metrics schema=${tcgExperimentProfile.metricsSchemaVersion} threshold=${tcgExperimentProfile.instantiateThreshold}`,
    ...(tcgExperimentProfile.cachePolicyMarker !== undefined
      ? [tcgExperimentProfile.cachePolicyMarker]
      : []),
  ],
};
const graphicsExperimentMetadata = graphicsExperiment === "virgl-webgl2" ? {
  kind: graphicsExperiment,
  promotionEligible: false,
  browserApi: "WebGL2",
  renderer: {
    repository: "https://gitlab.freedesktop.org/virgl/virglrenderer.git",
    version: "0.10.4",
    commit: "88b9fe3bfc64b23a701e4875006dbc0e769f14f6",
  },
  capabilityPolicy: "WebGL2-core-only",
} : graphicsExperiment === "webgl2-present" ? {
  kind: graphicsExperiment,
  promotionEligible: false,
  browserApi: "WebGL2",
  guestDevice: "virtio-vga",
  checkpointCompatible: true,
  presentationPath: "SDL2 surface texture upload and WebGL2 framebuffer blit",
} : null;
const vcpuExperimentMetadata = vcpuExperiment === "4" ? {
  kind: "browser-vcpus",
  count: 4,
  promotionEligible: false,
} : null;
const experimentMetadata = [
  tcgExperimentMetadata,
  graphicsExperimentMetadata,
  vcpuExperimentMetadata,
].filter((value) => value !== null);

const metadata = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  component: {
    name: "QEMU-Wasm",
    repository: lock.qemuWasm.repository,
    commit: lock.qemuWasm.commit,
    modified: true,
    patches,
    ...(experimentMetadata.length > 1
      ? { experiments: experimentMetadata }
      : experimentMetadata.length === 1
        ? { experiment: experimentMetadata[0] }
        : {}),
  },
  subprojects: Object.entries(lock.qemuSubprojects).map(([name, component]) => ({ name, ...component })),
  toolchain: lock.toolchain,
  builderImage: process.env.QEMU_WASM_BUILDER_IMAGE ?? null,
  builderImageId: process.env.QEMU_WASM_BUILDER_ID ?? null,
  artifacts,
};

const outputPath = join(outputDirectory, "runtime-build.json");
await writeFile(outputPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
process.stdout.write(`${basename(outputPath)}: recorded ${artifacts.length} runtime artifacts\n`);
