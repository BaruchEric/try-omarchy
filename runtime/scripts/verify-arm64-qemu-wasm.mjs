#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? "runtime/experiments/arm64-browser/dist");
const [moduleSource, wasm, pthreadSource, manifestSource] = await Promise.all([
  readFile(resolve(root, "qemu.mjs"), "utf8"),
  readFile(resolve(root, "qemu.wasm")),
  readFile(resolve(root, "qemu.worker.js"), "utf8"),
  readFile(resolve(root, "runtime-manifest.json"), "utf8"),
]);
const manifest = JSON.parse(manifestSource);

assert.equal(manifest.qemu?.architecture, "aarch64");
assert.equal(manifest.qemu?.cores, 4);
assert.deepEqual(manifest.qemu?.arguments?.slice(0, 4), [
  "-machine", "virt,gic-version=3", "-cpu", "cortex-a72",
]);
assert.equal(
  manifest.assets?.locate?.["qemu-system-aarch64.wasm"],
  "qemu.wasm",
);
assert.equal(
  manifest.assets?.locate?.["qemu-system-aarch64.worker.js"],
  "qemu.worker.js",
);
assert.match(
  moduleSource,
  /if\(ENVIRONMENT_IS_PTHREAD\)\{wasmBinaryFile="qemu-system-aarch64\.wasm"\}/,
);
assert.match(moduleSource, /pthreadPoolSize=8/);
assert.ok(wasm.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d])));
assert.ok(WebAssembly.validate(wasm));
assert.ok(wasm.includes(Buffer.from("virtio-gpu-pci")));
assert.ok(wasm.includes(Buffer.from("cortex-a72")));
assert.match(pthreadSource, /WebAssembly/);

const imports = WebAssembly.Module.imports(new WebAssembly.Module(wasm));
const memoryImport = imports.find((entry) => entry.kind === "memory");
assert.ok(memoryImport, "ARM64 QEMU-Wasm must import shared linear memory");

process.stdout.write(
  "ARM64 QEMU-Wasm experiment passed module/pthread/virt-machine/device gates\n",
);
