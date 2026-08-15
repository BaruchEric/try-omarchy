import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runtime = dirname(dirname(fileURLToPath(import.meta.url)));

class ClockCacheModel {
  constructor({ activeCap, replacementCredit, pressureInterval }) {
    this.activeCap = activeCap;
    this.replacementCredit = replacementCredit;
    this.pressureInterval = pressureInterval;
    this.slots = Array.from({ length: activeCap }, () => null);
    this.clockHand = 0;
    this.insertHand = 0;
    this.active = 0;
    this.retained = 0;
    this.pending = 0;
    this.retirements = 0;
    this.pressureRequests = 0;
    this.peakActive = 0;
    this.peakRetained = 0;
    this.peakPending = 0;
  }

  install(id) {
    if (this.active >= this.activeCap ||
        this.retained >= this.activeCap + this.replacementCredit) {
      return false;
    }
    for (let scanned = 0; scanned < this.slots.length; scanned += 1) {
      const index = this.insertHand;
      this.insertHand = (this.insertHand + 1) % this.slots.length;
      if (this.slots[index] === null) {
        this.slots[index] = { id, referenced: true };
        this.active += 1;
        this.retained += 1;
        this.#recordPeaks();
        return true;
      }
    }
    throw new Error("active-slot accounting overflow");
  }

  touch(id) {
    const slot = this.slots.find((candidate) => candidate?.id === id);
    if (slot) {
      slot.referenced = true;
      return true;
    }
    return false;
  }

  retireOne() {
    if (this.active === 0 || this.pending >= this.replacementCredit) {
      return null;
    }
    this.pending += 1;
    for (let scanned = 0; scanned < this.slots.length * 2; scanned += 1) {
      const index = this.clockHand;
      const candidate = this.slots[index];
      this.clockHand = (this.clockHand + 1) % this.slots.length;
      if (candidate === null) {
        continue;
      }
      if (candidate.referenced) {
        candidate.referenced = false;
        continue;
      }
      this.slots[index] = null;
      this.active -= 1;
      this.retirements += 1;
      if (this.retirements === 1 ||
          this.retirements % this.pressureInterval === 0) {
        this.pressureRequests += 1;
      }
      this.#recordPeaks();
      return candidate.id;
    }
    this.pending -= 1;
    return null;
  }

  collect(count) {
    const collected = Math.min(count, this.pending);
    this.pending -= collected;
    this.retained -= collected;
    return collected;
  }

  has(id) {
    return this.slots.some((candidate) => candidate?.id === id);
  }

  #recordPeaks() {
    this.peakActive = Math.max(this.peakActive, this.active);
    this.peakRetained = Math.max(this.peakRetained, this.retained);
    this.peakPending = Math.max(this.peakPending, this.pending);
  }
}

test("bounded CLOCK patch applies after the 1500 baseline and has hard caps", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-runtime-tcg-clock-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "tcg"));
  const upstream = process.env.QEMU_WASM_SOURCE ?? "/private/tmp/qemu-wasm-source";
  for (const relativePath of ["tcg/wasm32.c", "tcg/wasm32.h"]) {
    await writeFile(join(root, relativePath), await readFile(join(upstream, relativePath)));
  }

  for (const relativePatch of [
    "patches/qemu-wasm-tcg-vcpu-layout.patch",
    "patches/qemu-wasm-tcg-baseline-threshold-1500-metrics.patch",
    "patches/qemu-wasm-tcg-bounded-clock-cache.patch",
  ]) {
    const applied = spawnSync(
      "patch",
      ["--batch", "--quiet", "--directory", root, "--strip=1", "--input",
        join(runtime, relativePatch)],
      { encoding: "utf8" },
    );
    assert.equal(applied.status, 0, `${relativePatch}: ${applied.stderr}`);
  }

  const [source, header] = await Promise.all([
    readFile(join(root, "tcg/wasm32.c"), "utf8"),
    readFile(join(root, "tcg/wasm32.h"), "utf8"),
  ]);
  assert.match(header, /OMARCHY_WASM_TCG_HOT_THRESHOLD 1500/);
  assert.match(header, /OMARCHY_WASM_TCG_METRICS_SCHEMA 3/);
  assert.match(source, /MAX_INSTANCE_ACTIVE 15000/);
  assert.match(source, /MAX_INSTANCE_REPLACEMENT_CREDIT 256/);
  assert.match(source, /MAX_INSTANCE_RETAINED \\\n+\s+\(MAX_INSTANCE_ACTIVE \+ MAX_INSTANCE_REPLACEMENT_CREDIT\)/);
  assert.match(source, /CLOCK_GC_PRESSURE_INTERVAL 64/);
  assert.match(source, /CLOCK_GC_PRESSURE_BYTES \(4 \* 1024 \* 1024\)/);
  assert.match(source, /TO_REMOVE_INSTANCE_SIZE 1/);
  assert.match(source, /candidate->referenced = 0/);
  assert.match(source, /elm->referenced = 1/);
  assert.match(source, /scanned < INSTANCE_RUNNING_LEN \* 2/);
  assert.match(source, /qatomic_cmpxchg\(&instance_pending_gc_global,/);
  assert.match(source, /qatomic_fetch_inc\(&instance_running_global\)/);
  assert.match(source, /qatomic_sub\(&instance_pending_gc_global,/);
  assert.match(source, /wasmTable\.get\(fidx\) !== null \|\| wasmTableMirror\[fidx\] !== null/);
  assert.match(source, /new Uint8Array\(bytes\)/);
  assert.match(source, /queueMicrotask/);
  assert.match(source, /cache=bounded-clock-v1 active-cap=%d/);
  for (const metric of [
    "running-global=%d", "pending-gc-global=%d", "replacement-reservations=%",
    "active-capacity-denials=%", "retained-capacity-denials=%", "clock-scans=%",
    "clock-second-chances=%", "gc-pressure-requests=%", "gc-pressure-bytes=%",
    "table-slots-cleared=%",
  ]) {
    assert.ok(source.includes(metric), `missing CLOCK metric ${metric}`);
  }

  const [makefile, buildScript, packageScript, manifestScript, stampScript,
    verifier, metadataScript] = await Promise.all([
    readFile(join(runtime, "Makefile"), "utf8"),
    readFile(join(runtime, "scripts/build-qemu-wasm.sh"), "utf8"),
    readFile(join(runtime, "scripts/package-guest.sh"), "utf8"),
    readFile(join(runtime, "scripts/prepare-runtime-manifest.mjs"), "utf8"),
    readFile(join(runtime, "scripts/stamp-tcg-threshold-experiment.mjs"), "utf8"),
    readFile(join(runtime, "scripts/verify-runtime-artifacts.mjs"), "utf8"),
    readFile(join(runtime, "scripts/write-build-metadata.mjs"), "utf8"),
  ]);
  assert.match(makefile, /build-virgl-webgl2-tcg-bounded-clock:/);
  assert.match(makefile, /package-virgl-webgl2-tcg-bounded-clock:/);
  assert.match(makefile, /serve-full-virgl-webgl2-tcg-bounded-clock:/);
  assert.match(makefile, /VIRGL_WEBGL2_TCG_CLOCK_OUTPUT/);
  assert.match(buildScript, /tcg_experiment" == "1500-clock"/);
  assert.match(buildScript, /qemu-wasm-tcg-bounded-clock-cache\.patch/);
  assert.match(packageScript, /"1500-clock"/);
  assert.match(manifestScript, /experimentValue === "1500-clock"/);
  assert.match(stampScript, /"1500-clock": Object\.freeze\(\{ threshold: 1500, metricsSchemaVersion: 3 \}\)/);
  assert.match(verifier, /kind: "qemu-wasm-tcg-bounded-clock"/);
  assert.match(verifier, /TCG_BOUNDED_CLOCK_MARKER/);
  assert.match(metadataScript, /patches\/qemu-wasm-tcg-bounded-clock-cache\.patch/);
  assert.match(metadataScript, /gcPressureInterval: 64/);
});

test("bounded CLOCK preserves the hot cache and fails closed without finalization", () => {
  const model = new ClockCacheModel({
    activeCap: 64,
    replacementCredit: 8,
    pressureInterval: 4,
  });
  for (let id = 0; id < 64; id += 1) {
    assert.equal(model.install(id), true);
  }

  const hot = [0, 1, 2, 3];
  for (let replacement = 0; replacement < 8; replacement += 1) {
    for (const id of hot) {
      model.touch(id);
    }
    assert.notEqual(model.retireOne(), null);
    assert.equal(model.install(64 + replacement), true);
  }

  assert.equal(hot.filter((id) => model.has(id)).length, 3);
  assert.equal(model.active, 64);
  assert.equal(model.retained, 72);
  assert.equal(model.pending, 8);
  assert.equal(model.peakActive, 64);
  assert.equal(model.peakRetained, 72);
  assert.equal(model.peakPending, 8);
  assert.equal(model.pressureRequests, 3);

  const before = model.slots.map((slot) => slot?.id ?? null);
  assert.equal(model.retireOne(), null);
  assert.deepEqual(model.slots.map((slot) => slot?.id ?? null), before);
  assert.equal(model.active, 64, "credit exhaustion must not evict another hot TB");

  assert.equal(model.collect(4), 4);
  assert.equal(model.retained, 68);
  assert.equal(model.pending, 4);
  for (let replacement = 0; replacement < 4; replacement += 1) {
    assert.notEqual(model.retireOne(), null);
    assert.equal(model.install(72 + replacement), true);
  }
  assert.equal(model.active, 64);
  assert.equal(model.retained, 72);
  assert.equal(model.pending, 8);
});

test("CLOCK candidate stays inside the measured 132 MiB headroom envelope", () => {
  const activeCap = 15_000;
  const replacementCredit = 256;
  const vcpus = 4;
  const pressureRequestsWithoutGc = 5; // retirements 1, 64, 128, 192, 256
  const pressureBytes = pressureRequestsWithoutGc * 4 * 1024 * 1024;
  const rawSourceBytes = replacementCredit * 1011.9017333333334;
  const cBytesSaved = vcpus * (
    ((8 - 12) * activeCap) + ((50_000 - 1) * 4)
  );
  const measuredHeadroom = 132 * 1024 * 1024;
  const wrapperBudget = measuredHeadroom - pressureBytes - rawSourceBytes + cBytesSaved;

  assert.equal(cBytesSaved, 559_984);
  assert.equal(pressureBytes, 20 * 1024 * 1024);
  assert.ok(rawSourceBytes < 0.25 * 1024 * 1024);
  assert.ok(wrapperBudget > 112 * 1024 * 1024);
  assert.ok(wrapperBudget / replacementCredit > 449 * 1024);
});

test("bounded CLOCK build metadata is exact and non-promotable", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "omarchy-runtime-tcg-clock-metadata-"));
  context.after(() => rm(output, { recursive: true, force: true }));
  await mkdir(join(output, "firmware"));
  for (const relativePath of [
    "runtime.mjs",
    "production-worker.mjs",
    "worker-input.mjs",
    "paged-disk.mjs",
    "bounded-overlay.mjs",
    "qemu.mjs",
    "qemu.wasm",
    "qemu.worker.js",
    "firmware/bios-256k.bin",
    "firmware/vgabios-stdvga.bin",
    "firmware/vgabios-virtio.bin",
    "firmware/kvmvapic.bin",
    "firmware/linuxboot_dma.bin",
  ]) {
    await writeFile(join(output, relativePath), relativePath);
  }
  const wasmSha256 = createHash("sha256").update("qemu.wasm").digest("hex");
  await writeFile(join(output, "runtime-verification.json"), JSON.stringify({
    wasm: {
      tcgExperiment: {
        kind: "qemu-wasm-tcg-bounded-clock",
        instantiateThreshold: 1500,
        metricsSchemaVersion: 3,
        cachePolicy: {
          kind: "bounded-clock-v1",
          activeCap: 15000,
          replacementCredit: 256,
          retainedCap: 15256,
          gcPressureBytes: 4 * 1024 * 1024,
        },
      },
      tcgExperimentArtifactSha256: wasmSha256,
      graphicsExperiment: {
        kind: "virgl-webgl2",
        promotionEligible: false,
        qemuWasmSha256: wasmSha256,
      },
    },
  }));

  const producer = join(runtime, "scripts/write-build-metadata.mjs");
  const result = spawnSync(process.execPath, [producer, output], {
    encoding: "utf8",
    env: {
      ...process.env,
      OMARCHY_TCG_HOT_THRESHOLD_EXPERIMENT: "1500-clock",
      OMARCHY_GRAPHICS_EXPERIMENT: "virgl-webgl2",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(await readFile(join(output, "runtime-build.json"), "utf8"));
  const clock = metadata.component.experiments.find(
    ({ kind }) => kind === "qemu-wasm-tcg-bounded-clock",
  );
  assert.deepEqual(clock.cachePolicy, {
    kind: "bounded-clock-v1",
    activeCap: 15000,
    replacementCredit: 256,
    retainedCap: 15256,
    gcPressureBytes: 4 * 1024 * 1024,
    gcPressureInterval: 64,
  });
  assert.equal(clock.instantiateThreshold, 1500);
  assert.equal(clock.metricsSchemaVersion, 3);
  assert.equal(clock.promotionEligible, false);
  assert.ok(metadata.component.patches.includes(
    "patches/qemu-wasm-tcg-bounded-clock-cache.patch",
  ));
});
