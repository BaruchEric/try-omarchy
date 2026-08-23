import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildRuntimeManifest } from "../scripts/prepare-runtime-manifest.mjs";

const runtime = new URL("../", import.meta.url);
const scripts = [
  "scripts/audit-upstreams.sh",
  "scripts/build-inside-container.sh",
  "scripts/build-qemu-wasm.sh",
  "scripts/bundle-production-worker.mjs",
  "scripts/package-guest.sh",
  "scripts/package-smoke.sh",
  "scripts/patch-generated-qemu.mjs",
  "scripts/prepare-runtime-manifest.mjs",
  "scripts/run-browser-qemu.mjs",
  "scripts/serve.mjs",
  "scripts/serve-full-guest.mjs",
  "scripts/verify-runtime-artifacts.mjs",
  "scripts/write-build-metadata.mjs",
];

test("canonical runtime entry points are executable and parse", async () => {
  for (const relativePath of scripts) {
    const url = new URL(relativePath, runtime);
    await access(url, constants.X_OK);
    const command = relativePath.endsWith(".mjs") ? process.execPath : "bash";
    const args = relativePath.endsWith(".mjs") ? ["--check", url.pathname] : ["-n", url.pathname];
    const result = spawnSync(command, args, { encoding: "utf8" });
    assert.equal(result.status, 0, `${relativePath}: ${result.stderr}`);
  }
});

test("Makefile exposes one canonical lifecycle plus compatibility aliases", async () => {
  const source = await readFile(new URL("Makefile", runtime), "utf8");
  const targets = [...source.matchAll(/^([a-z][a-z-]*):(?:\s|$)/gm)].map((match) => match[1]);
  assert.deepEqual(targets, [
    "audit", "build", "package", "serve", "smoke", "test", "verify",
    "browser-qemu", "verify-dist",
  ]);
  assert.match(source, /^\.DEFAULT_GOAL := test$/m);
  assert.match(source, /serve:\n\t\.\/scripts\/run-browser-qemu\.mjs/);
  assert.match(source, /verify:\n\tnode \.\/scripts\/verify-runtime-artifacts\.mjs \.\/dist/);
  assert.match(source, /browser-qemu: serve/);
  assert.match(source, /verify-dist: verify/);
});

test("the one production profile is x86_64 software-display QEMU/Wasm", async () => {
  const manifest = JSON.parse(await readFile(new URL("config/demo.json", runtime)));
  assert.equal(manifest.runtimeMode, "worker-paged");
  assert.equal(manifest.assets.locate["qemu-system-x86_64.wasm"], "qemu.wasm");
  assert.deepEqual(manifest.qemu.arguments.slice(0, 10), [
    "-machine", "pc-q35-8.2",
    "-m", "1024M",
    "-accel", "tcg,tb-size=128,thread=multi",
    "-smp", "2,sockets=1,cores=2,threads=1",
    "-L", "/pack",
  ]);
  assert.ok(manifest.qemu.arguments.includes("sdl,gl=off,show-cursor=on"));
  assert.ok(manifest.qemu.arguments.includes("virtio-vga,max_outputs=1,xres=1600,yres=900"));
  assert.equal("checkpoint" in manifest, false);
});

test("canonical build applies only production patches", async () => {
  const source = await readFile(new URL("scripts/build-qemu-wasm.sh", runtime), "utf8");
  for (const patch of [
    "qemu-sdl-frame-hook.patch",
    "qemu-sdl-frame-sampling.patch",
    "qemu-wasm-input-bridge.patch",
    "qemu-wasm-runstate-guard.patch",
    "qemu-wasm-sdl-texture-reuse.patch",
    "qemu-wasm-sdl-pageflip-coalesce.patch",
    "qemu-wasm-worker-dom.patch",
    "qemu-wasm-tcg-rr-init.patch",
    "qemu-wasm-tcg-vcpu-layout.patch",
  ]) {
    assert.match(source, new RegExp(patch.replaceAll(".", "\\.")));
  }
  assert.doesNotMatch(source, /OMARCHY_(?:TCG|GRAPHICS|VCPU)_EXPERIMENT/);
  assert.doesNotMatch(source, /virglrenderer|webgl-epoxy|graphics_experiment|tcg_experiment|vcpu_experiment/i);
});

test("SDL2 config shim exposes the Emscripten system port", () => {
  const shim = new URL("toolchain/sdl2-config", runtime).pathname;
  const version = spawnSync(shim, ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^2\./);
  const flags = spawnSync(shim, ["--cflags"], { encoding: "utf8" });
  assert.equal(flags.status, 0);
  assert.equal(flags.stdout.trim(), "-sUSE_SDL=2");
});

test("packaged production Worker is self-contained and embeds exact modules", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "omarchy-production-worker-bundle-"));
  context.after(() => rm(output, { recursive: true, force: true }));
  const destination = join(output, "production-worker.mjs");
  const bundler = new URL("scripts/bundle-production-worker.mjs", runtime).pathname;
  const result = spawnSync(process.execPath, [bundler, destination], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const bundle = await readFile(destination, "utf8");
  assert.doesNotMatch(bundle, /^\s*import\s/m);
  assert.match(bundle, /Generated self-contained production Worker/);
  for (const relativePath of [
    "web/worker-input.mjs",
    "../storage/paged-disk.mjs",
    "../storage/bounded-overlay.mjs",
    "web/browser-performance-runtime.mjs",
  ]) {
    const source = await readFile(new URL(relativePath, runtime));
    const digest = createHash("sha256").update(source).digest("hex");
    assert.match(bundle, new RegExp(`${relativePath.split("/").at(-1).replace(".", "\\.")} sha256=${digest}`));
  }
  assert.match(bundle, /async function preparePagedDisk\(/);
  assert.match(bundle, /function validateCheckpointArtifacts\(/);
  assert.match(bundle, /file:\/pack\/omarchy-preboot\.vmstate/);
});

test("packaging cold-boots unless the complete generic checkpoint set exists", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-runtime-cold-package-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const baseManifestPath = join(root, "demo.json");
  const guestDirectory = join(root, "guest");
  await mkdir(guestDirectory);
  const base = { schemaVersion: 2, runtimeMode: "worker-paged", marker: "cold" };
  await writeFile(baseManifestPath, JSON.stringify(base));
  await writeFile(
    join(guestDirectory, "guest-manifest.json"),
    JSON.stringify({ schemaVersion: 1, artifacts: [] }),
  );
  const args = {
    baseManifestPath,
    guestDirectory,
    qemuWasmPath: join(root, "missing-qemu.wasm"),
  };
  const result = await buildRuntimeManifest(args);
  assert.equal(result.mode, "cold");
  assert.deepEqual(result.manifest, base);

  await writeFile(join(guestDirectory, "omarchy-preboot.vmstate"), "partial");
  await assert.rejects(
    buildRuntimeManifest(args),
    /refuses a partial descriptor\/vmstate\/boot-delta set/,
  );
});

test("runtime source tree contains no alternate browser runtime profiles", async () => {
  const [makefile, builder, packager, manifestBuilder, worker] = await Promise.all([
    readFile(new URL("Makefile", runtime), "utf8"),
    readFile(new URL("scripts/build-qemu-wasm.sh", runtime), "utf8"),
    readFile(new URL("scripts/package-guest.sh", runtime), "utf8"),
    readFile(new URL("scripts/prepare-runtime-manifest.mjs", runtime), "utf8"),
    readFile(new URL("web/production-worker.mjs", runtime), "utf8"),
  ]);
  const joined = [makefile, builder, packager, manifestBuilder].join("\n");
  assert.doesNotMatch(joined, /virgl|webgl2|hibernate|tcg[_-](?:threshold|experiment)|vcpu[_-]experiment/i);
  assert.match(worker, /hibernateDescriptorSha256: null/);
  assert.doesNotMatch(worker, /hibernate-manifest|hibernate-root-overlay|omarchy-hibernate/i);
});
