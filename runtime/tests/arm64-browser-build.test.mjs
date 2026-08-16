import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeArm64PthreadPool } from "../scripts/patch-arm64-pthread-pool.mjs";

const root = new URL("../", import.meta.url);

test("ARM64 browser experiment is isolated and uses the QEMU virt machine", async () => {
  const [manifestSource, makefile, buildSource, containerSource, patcherSource] =
    await Promise.all([
      readFile(new URL("config/arm64-browser.json", root), "utf8"),
      readFile(new URL("Makefile", root), "utf8"),
      readFile(new URL("scripts/build-qemu-wasm.sh", root), "utf8"),
      readFile(new URL("scripts/build-inside-container.sh", root), "utf8"),
      readFile(new URL("scripts/patch-generated-qemu.mjs", root), "utf8"),
    ]);
  const manifest = JSON.parse(manifestSource);

  assert.equal(manifest.qemu.architecture, "aarch64");
  assert.equal(manifest.qemu.cores, 4);
  assert.deepEqual(manifest.qemu.arguments.slice(0, 4), [
    "-machine", "virt,gic-version=3", "-cpu", "cortex-a72",
  ]);
  assert.ok(manifest.qemu.arguments.includes("virtio-gpu-pci,max_outputs=1,xres=1600,yres=900"));
  assert.equal(Object.keys(manifest.assets.firmware).length, 0);
  assert.match(makefile, /build-arm64-browser-experiment:/);
  assert.match(makefile, /package-arm64-browser-experiment:/);
  assert.match(makefile, /serve-full-arm64-browser-experiment:/);
  assert.match(makefile, /--port 8100/);
  const packageSource = await readFile(new URL("../scripts/package-arm64-browser.sh", import.meta.url), "utf8");
  assert.match(packageSource, /value\?\.guest\?\.architecture !== "aarch64"/);
  assert.match(makefile, /experiments\/arm64-browser\/dist/);
  assert.match(buildSource, /experiments must use an isolated output directory/);
  assert.match(buildSource, /OMARCHY_QEMU_ARCHITECTURE=\$qemu_architecture/);
  assert.match(containerSource, /qemu_target=aarch64-softmmu/);
  assert.match(containerSource, /qemu_executable=qemu-system-aarch64/);
  assert.match(containerSource, /-sPTHREAD_POOL_SIZE=8/);
  assert.match(containerSource, /extra_ldflags\+=" -sPTHREAD_POOL_SIZE=8"/);
  assert.match(containerSource, /patch-arm64-pthread-pool\.mjs/);
  assert.ok(
    patcherSource.includes('/wasmBinaryFile="(qemu-system-[a-z0-9_]+\\.wasm)"/'),
  );
});

test("ARM64 build graph cannot be downgraded by dependency link flags", () => {
  const graph = [
    "LINK_ARGS = -sPTHREAD_POOL_SIZE=8 libqemu.a -sPTHREAD_POOL_SIZE=4 libglib.a",
    "LINK_ARGS = -sPTHREAD_POOL_SIZE=4 libpcre2.a",
  ].join("\n");
  const normalized = normalizeArm64PthreadPool(graph);
  assert.doesNotMatch(normalized, /PTHREAD_POOL_SIZE=4/);
  assert.equal((normalized.match(/PTHREAD_POOL_SIZE=8/g) ?? []).length, 3);
  assert.throws(() => normalizeArm64PthreadPool("LINK_ARGS = -pthread"), /no pinned four-worker/);
});

test("x86_64 remains the default QEMU-Wasm build architecture", async () => {
  const [buildSource, containerSource] = await Promise.all([
    readFile(new URL("scripts/build-qemu-wasm.sh", root), "utf8"),
    readFile(new URL("scripts/build-inside-container.sh", root), "utf8"),
  ]);
  assert.match(buildSource, /OMARCHY_QEMU_ARCHITECTURE:-x86_64/);
  assert.match(containerSource, /OMARCHY_QEMU_ARCHITECTURE:-x86_64/);
  assert.match(containerSource, /qemu_target=x86_64-softmmu/);
  assert.match(containerSource, /qemu_executable=qemu-system-x86_64/);
});
