#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputDirectory = resolve(process.argv[2] ?? join(runtimeDirectory, "experiments/arm64-browser/dist"));
const lock = JSON.parse(await readFile(join(runtimeDirectory, "upstream.lock.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(outputDirectory, "runtime-manifest.json"), "utf8"));
const verification = JSON.parse(await readFile(join(outputDirectory, "runtime-verification.json"), "utf8"));

if (manifest?.qemu?.architecture !== "aarch64" || verification?.architecture !== "aarch64" ||
    verification?.wasm?.valid !== true || verification?.pthreadPoolSize !== 8) {
  throw new Error("ARM64 runtime build metadata requires the exact verified ARM64 profile");
}

const definitions = [
  ["runtime.mjs", "host-runtime", "text/javascript"],
  ["production-worker.mjs", "host-worker", "text/javascript"],
  ["worker-input.mjs", "host-input-bridge", "text/javascript"],
  ["paged-disk.mjs", "paged-disk-adapter", "text/javascript"],
  ["bounded-overlay.mjs", "snapshot-overlay-guard", "text/javascript"],
  ["runtime-verification.json", "runtime-verification", "application/json"],
  ["qemu.mjs", "emulator-loader", "text/javascript"],
  ["qemu.wasm", "emulator-wasm", "application/wasm"],
  ["qemu.worker.js", "emulator-worker", "text/javascript"],
];

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const artifacts = [];
for (const [relativePath, role, mediaType] of definitions) {
  const path = join(outputDirectory, relativePath);
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0) throw new Error(`invalid ARM64 runtime artifact: ${relativePath}`);
  artifacts.push({ path: relativePath, role, mediaType, bytes: info.size, sha256: await sha256(path) });
}

const wasmArtifact = artifacts.find(({ path }) => path === "qemu.wasm");
if (wasmArtifact.sha256 !== verification.wasm.sha256 || wasmArtifact.bytes !== verification.wasm.bytes) {
  throw new Error("ARM64 QEMU Wasm changed after verification");
}

const metadata = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  component: {
    name: "QEMU-Wasm ARM64 browser experiment",
    repository: lock.qemuWasm.repository,
    commit: lock.qemuWasm.commit,
    modified: true,
    architecture: "aarch64",
    promotionEligible: false,
    machine: "virt,gic-version=3",
    cpu: "cortex-a72",
    vcpus: 4,
    pthreadPoolSize: 8,
  },
  toolchain: lock.toolchain,
  artifacts,
};

const outputPath = join(outputDirectory, "runtime-build.json");
await writeFile(outputPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
process.stdout.write(`${basename(outputPath)}: recorded ${artifacts.length} ARM64 runtime artifacts\n`);
