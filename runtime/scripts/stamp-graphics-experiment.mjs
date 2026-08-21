#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CANONICAL_CHECKPOINT_IDENTITY } from "../web/production-worker.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const EXPERIMENTS = new Set(["virgl-webgl2", "webgl2-present"]);
const COLD_DISPLAY = "sdl,gl=off,show-cursor=on";
const WEBGL_DISPLAY = "sdl,gl=es,show-cursor=on";
const COLD_DEVICE = "virtio-vga,max_outputs=1,xres=1600,yres=900";
const VIRGL_DEVICE = "virtio-vga-gl,max_outputs=1,xres=1600,yres=900";

function replaceExactlyOnce(source, from, to, label) {
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`${label} must occur exactly once; found ${count}`);
  return source.replace(from, to);
}

function assertExactlyOnce(source, value, label) {
  const count = source.split(value).length - 1;
  if (count !== 1) throw new Error(`${label} must occur exactly once; found ${count}`);
}

function replaceNearestBeforeUniqueAnchor(source, from, to, anchor, label) {
  assertExactlyOnce(source, anchor, `${label} anchor`);
  const anchorIndex = source.indexOf(anchor);
  const fromIndex = source.lastIndexOf(from, anchorIndex);
  if (fromIndex < 0) throw new Error(`${label} must occur before its anchor`);
  return source.slice(0, fromIndex) + to + source.slice(fromIndex + from.length);
}

export function stampGraphicsExperiment(workerSource, wasmSha256, experiment = "virgl-webgl2") {
  if (!EXPERIMENTS.has(experiment)) throw new Error(`unsupported graphics experiment: ${experiment}`);
  if (!SHA256.test(wasmSha256)) throw new Error("experimental QEMU Wasm SHA-256 is invalid");
  if (workerSource.includes("OMARCHY_EXPERIMENT qemu-wasm-graphics")) {
    throw new Error("bundled Worker is already stamped as a graphics experiment");
  }
  let stamped = replaceNearestBeforeUniqueAnchor(
    workerSource,
    COLD_DISPLAY,
    WEBGL_DISPLAY,
    COLD_DEVICE,
    "canonical x86 software display profile",
  );
  if (experiment === "virgl-webgl2") {
    stamped = replaceExactlyOnce(
      stamped,
      COLD_DEVICE,
      VIRGL_DEVICE,
      "canonical software GPU profile",
    );
  } else {
    assertExactlyOnce(stamped, COLD_DEVICE, "checkpoint-compatible virtio-vga profile");
    stamped = replaceExactlyOnce(
      stamped,
      CANONICAL_CHECKPOINT_IDENTITY.browserQemuWasmSha256,
      wasmSha256,
      "canonical checkpoint QEMU Wasm identity",
    );
  }
  const marker = `// OMARCHY_EXPERIMENT qemu-wasm-graphics kind=${experiment} ` +
    `promotion-eligible=false qemu-wasm-sha256=${wasmSha256}`;
  return `${marker}\n${stamped}`;
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
      "usage: stamp-graphics-experiment.mjs WORKER_PATH QEMU_WASM_PATH EXPERIMENT",
    );
  }
  const wasmSha256 = await sha256File(wasmPath);
  const stamped = stampGraphicsExperiment(
    await readFile(workerPath, "utf8"),
    wasmSha256,
    experiment,
  );
  await writeFile(workerPath, stamped, "utf8");
  process.stdout.write(
    `production-worker.mjs: stamped graphics=${experiment} qemu-wasm-sha256=${wasmSha256}\n`,
  );
}
