#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CANONICAL_CHECKPOINT_IDENTITY } from "../web/production-worker.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const EXPERIMENTS = Object.freeze({
  "250": Object.freeze({ threshold: 250, metricsSchemaVersion: 1 }),
  "750": Object.freeze({ threshold: 750, metricsSchemaVersion: 2 }),
  "1500-metrics": Object.freeze({ threshold: 1500, metricsSchemaVersion: 2 }),
  "1500-clock": Object.freeze({ threshold: 1500, metricsSchemaVersion: 4 }),
  "6000-fill": Object.freeze({ threshold: 6000, metricsSchemaVersion: 5 }),
  "6000-batch32": Object.freeze({ threshold: 6000, metricsSchemaVersion: 6 }),
});

function experimentProfile(value) {
  if (value === 250 || value === "250") return EXPERIMENTS["250"];
  if (value === 750 || value === "750") return EXPERIMENTS["750"];
  if (value === 1500 || value === "1500-metrics") return EXPERIMENTS["1500-metrics"];
  if (value === "1500-clock") return EXPERIMENTS["1500-clock"];
  if (value === "6000-fill") return EXPERIMENTS["6000-fill"];
  if (value === "6000-batch32") return EXPERIMENTS["6000-batch32"];
  throw new Error(`unsupported QEMU-Wasm TCG threshold experiment: ${value}`);
}

export function stampTcgThresholdExperiment(workerSource, wasmSha256, experiment) {
  const profile = experimentProfile(experiment);
  if (!SHA256.test(wasmSha256)) throw new Error("experimental QEMU Wasm SHA-256 is invalid");
  const canonicalSha256 = CANONICAL_CHECKPOINT_IDENTITY.browserQemuWasmSha256;
  const occurrences = workerSource.split(canonicalSha256).length - 1;
  if (occurrences !== 1) {
    throw new Error(`bundled Worker must contain one canonical QEMU Wasm identity; found ${occurrences}`);
  }
  if (workerSource.includes("OMARCHY_EXPERIMENT qemu-wasm-tcg-hot-threshold")) {
    throw new Error("bundled Worker is already stamped as a TCG threshold experiment");
  }
  const marker =
    `// OMARCHY_EXPERIMENT qemu-wasm-tcg-hot-threshold threshold=${profile.threshold} ` +
    `promotion-eligible=false qemu-wasm-sha256=${wasmSha256}`;
  return `${marker}\n${workerSource.replace(canonicalSha256, wasmSha256)}`;
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

const scriptPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (scriptPath && scriptPath === fileURLToPath(import.meta.url)) {
  const workerPath = resolve(process.argv[2] ?? "");
  const wasmPath = resolve(process.argv[3] ?? "");
  const experiment = process.argv[4];
  if (!process.argv[2] || !process.argv[3] || !process.argv[4]) {
    throw new Error(
      "usage: stamp-tcg-threshold-experiment.mjs WORKER_PATH QEMU_WASM_PATH THRESHOLD",
    );
  }
  const wasmSha256 = await sha256File(wasmPath);
  const stamped = stampTcgThresholdExperiment(
    await readFile(workerPath, "utf8"),
    wasmSha256,
    experiment,
  );
  await writeFile(workerPath, stamped, "utf8");
  process.stdout.write(
    `production-worker.mjs: stamped threshold=${experimentProfile(experiment).threshold} ` +
    `qemu-wasm-sha256=${wasmSha256}\n`,
  );
}
