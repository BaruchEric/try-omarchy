#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputDirectory = resolve(process.argv[2] ?? join(runtimeDirectory, "dist"));
const lock = JSON.parse(await readFile(join(runtimeDirectory, "upstream.lock.json"), "utf8"));

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

const patches = [
  "patches/qemu-wasm-builder-zlib-url.patch",
  "patches/qemu-sdl-frame-hook.patch",
  "patches/qemu-sdl-frame-sampling.patch",
  "patches/qemu-wasm-input-bridge.patch",
  "patches/qemu-wasm-runstate-guard.patch",
  "patches/qemu-wasm-sdl-texture-reuse.patch",
  "patches/qemu-wasm-sdl-pageflip-coalesce.patch",
  "patches/qemu-wasm-worker-dom.patch",
  "patches/qemu-wasm-tcg-rr-init.patch",
  "patches/qemu-wasm-tcg-vcpu-layout.patch",
];

const metadata = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  component: {
    name: "QEMU-Wasm",
    repository: lock.qemuWasm.repository,
    commit: lock.qemuWasm.commit,
    modified: true,
    patches,
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
