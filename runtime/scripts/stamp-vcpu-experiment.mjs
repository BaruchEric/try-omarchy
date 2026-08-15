#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA256 = /^[a-f0-9]{64}$/;
const EXPERIMENTAL_VCPUS = 4;
const CANONICAL_SMP = "2,sockets=1,cores=2,threads=1";
const EXPERIMENTAL_SMP = "4,sockets=1,cores=4,threads=1";

function replaceExactly(source, from, to, expected, label) {
  const count = source.split(from).length - 1;
  if (count !== expected) throw new Error(`${label} must occur ${expected} times; found ${count}`);
  return source.split(from).join(to);
}

export function stampVcpuExperiment(workerSource, wasmSha256, vcpus = EXPERIMENTAL_VCPUS) {
  if (vcpus !== EXPERIMENTAL_VCPUS && vcpus !== String(EXPERIMENTAL_VCPUS)) {
    throw new Error(`unsupported browser vCPU experiment: ${vcpus}`);
  }
  if (!SHA256.test(wasmSha256)) throw new Error("experimental QEMU Wasm SHA-256 is invalid");
  if (workerSource.includes("OMARCHY_EXPERIMENT browser-vcpus")) {
    throw new Error("bundled Worker is already stamped as a vCPU experiment");
  }
  let stamped = replaceExactly(workerSource, "cores: 2,", "cores: 4,", 1, "canonical core count");
  stamped = replaceExactly(stamped, CANONICAL_SMP, EXPERIMENTAL_SMP, 2, "canonical SMP profile");
  return `// OMARCHY_EXPERIMENT browser-vcpus count=4 promotion-eligible=false ` +
    `qemu-wasm-sha256=${wasmSha256}\n${stamped}`;
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

const scriptPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (scriptPath && scriptPath === fileURLToPath(import.meta.url)) {
  const workerPath = resolve(process.argv[2] ?? "");
  const wasmPath = resolve(process.argv[3] ?? "");
  const vcpus = process.argv[4];
  if (!process.argv[2] || !process.argv[3] || !process.argv[4]) {
    throw new Error("usage: stamp-vcpu-experiment.mjs WORKER_PATH QEMU_WASM_PATH VCPUS");
  }
  const wasmSha256 = await sha256File(wasmPath);
  await writeFile(
    workerPath,
    stampVcpuExperiment(await readFile(workerPath, "utf8"), wasmSha256, vcpus),
    "utf8",
  );
  process.stdout.write(`production-worker.mjs: stamped browser-vcpus=${vcpus} ` +
    `qemu-wasm-sha256=${wasmSha256}\n`);
}
