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
  constructor({
    activeCap,
    replacementCredit,
    pressureInterval,
    pressureRetryMilliseconds,
  }) {
    this.activeCap = activeCap;
    this.replacementCredit = replacementCredit;
    this.pressureInterval = pressureInterval;
    this.pressureRetryMilliseconds = pressureRetryMilliseconds;
    this.slots = Array.from({ length: activeCap }, () => null);
    this.clockHand = 0;
    this.insertHand = 0;
    this.active = 0;
    this.retained = 0;
    this.pending = 0;
    this.retirements = 0;
    this.pressureRequests = 0;
    this.saturationPressureRetries = 0;
    this.nextPressureAt = 0;
    this.pressureHeld = false;
    this.pressureTaskPending = false;
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

  retireOne(now = 0) {
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
        this.#requestPressure(now, false);
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

  retrySaturatedPressure(now) {
    if (this.pending < this.replacementCredit) return false;
    return this.#requestPressure(now, true);
  }

  runMicrotaskCheckpoint() {
    return this.pressureHeld;
  }

  runPressureTask(finalizedCount) {
    if (!this.pressureTaskPending) throw new Error("no pressure task is pending");
    this.pressureTaskPending = false;
    this.pressureHeld = false;
    return this.collect(finalizedCount);
  }

  has(id) {
    return this.slots.some((candidate) => candidate?.id === id);
  }

  #recordPeaks() {
    this.peakActive = Math.max(this.peakActive, this.active);
    this.peakRetained = Math.max(this.peakRetained, this.retained);
    this.peakPending = Math.max(this.peakPending, this.pending);
  }

  #requestPressure(now, saturationRetry) {
    if (now < this.nextPressureAt) return false;
    if (this.pressureTaskPending) throw new Error("pressure task overlap");
    this.nextPressureAt = now + this.pressureRetryMilliseconds;
    this.pressureRequests += 1;
    this.saturationPressureRetries += Number(saturationRetry);
    this.pressureHeld = true;
    this.pressureTaskPending = true;
    return true;
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
  assert.match(header, /OMARCHY_WASM_TCG_METRICS_SCHEMA 4/);
  assert.match(source, /MAX_INSTANCE_ACTIVE 60000/);
  assert.match(source, /MAX_INSTANCE_REPLACEMENT_CREDIT 4096/);
  assert.match(source, /MAX_INSTANCE_RETAINED \\\n+\s+\(MAX_INSTANCE_ACTIVE \+ MAX_INSTANCE_REPLACEMENT_CREDIT\)/);
  assert.match(source, /CLOCK_GC_PRESSURE_INTERVAL 64/);
  assert.match(source, /CLOCK_GC_PRESSURE_BYTES \(4 \* 1024 \* 1024\)/);
  assert.match(source, /CLOCK_GC_PRESSURE_RETRY_MS 1000/);
  assert.match(source, /TO_REMOVE_INSTANCE_SIZE 1/);
  assert.match(source, /candidate->referenced = 0/);
  assert.match(source, /elm->referenced = 1/);
  assert.match(source, /scanned < INSTANCE_RUNNING_LEN \* 2/);
  assert.match(source, /qatomic_cmpxchg\(&instance_pending_gc_global,/);
  assert.match(source, /qatomic_fetch_inc\(&instance_running_global\)/);
  assert.match(source, /qatomic_sub\(&instance_pending_gc_global,/);
  assert.match(source, /wasmTable\.get\(fidx\) !== null \|\| wasmTableMirror\[fidx\] !== null/);
  assert.match(source, /new Uint8Array\(bytes\)/);
  assert.match(source, /setTimeout\(\(\) => \{/);
  assert.doesNotMatch(source, /queueMicrotask/);
  assert.match(source, /_Static_assert\(MAX_INSTANCE_ACTIVE == 60000/);
  assert.match(source, /_Static_assert\(CLOCK_GC_PRESSURE_INTERVAL == 64/);
  assert.match(source, /__thread double instance_gc_pressure_retry_after_ms/);
  assert.match(source, /now < instance_gc_pressure_retry_after_ms/);
  assert.match(source, /instance_pending_gc_global\) >=\s+MAX_INSTANCE_REPLACEMENT_CREDIT/);
  assert.match(source, /omarchy_wasm_tcg_request_gc_pressure\(true\)/);
  assert.match(source, /cache=bounded-clock-v2 active-cap=60000 replacement-credit=4096/);
  assert.match(source, /gc-pressure-interval=64 gc-pressure-retry-ms=1000/);
  assert.match(source, /gc-pressure-hold=next-task/);
  for (const metric of [
    "running-global=%d", "pending-gc-global=%d", "replacement-reservations=%",
    "active-capacity-denials=%", "retained-capacity-denials=%", "clock-scans=%",
    "clock-second-chances=%", "gc-pressure-requests=%", "gc-pressure-bytes=%",
    "gc-pressure-saturation-retries=%", "table-slots-cleared=%",
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
  assert.match(buildScript, /default_build_volume\+=-tcg-bounded-clock-v2/);
  assert.match(buildScript, /qemu-wasm-tcg-bounded-clock-cache\.patch/);
  assert.match(packageScript, /"1500-clock"/);
  assert.match(manifestScript, /experimentValue === "1500-clock"/);
  assert.match(stampScript, /"1500-clock": Object\.freeze\(\{ threshold: 1500, metricsSchemaVersion: 4 \}\)/);
  assert.match(verifier, /kind: "qemu-wasm-tcg-bounded-clock"/);
  assert.match(verifier, /kind: "bounded-clock-v2"/);
  assert.match(verifier, /metricsSchemaVersion: 4/);
  assert.match(verifier, /gcPressureRetryMilliseconds: 1000/);
  assert.match(verifier, /gcPressureHold: "next-task"/);
  assert.match(verifier, /gc_pressure=pressure;setTimeout/);
  assert.match(verifier, /cachePolicyMarker/);
  assert.match(metadataScript, /patches\/qemu-wasm-tcg-bounded-clock-cache\.patch/);
  assert.match(metadataScript, /gcPressureInterval: 64/);
  assert.match(metadataScript, /gcPressureRetryMilliseconds: 1000/);
  assert.match(metadataScript, /gcPressureHold: "next-task"/);
});

test("bounded CLOCK preserves hard caps and recovers turnover after saturation GC", () => {
  const model = new ClockCacheModel({
    activeCap: 64,
    replacementCredit: 8,
    pressureInterval: 4,
    pressureRetryMilliseconds: 1000,
  });
  for (let id = 0; id < 64; id += 1) {
    assert.equal(model.install(id), true);
  }

  const hot = [0, 1, 2, 3];
  for (let replacement = 0; replacement < 8; replacement += 1) {
    for (const id of hot) {
      model.touch(id);
    }
    assert.notEqual(model.retireOne(replacement * 1000), null);
    if (model.pressureTaskPending) {
      assert.equal(model.pressureHeld, true);
      assert.equal(model.runPressureTask(0), 0);
    }
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
  assert.equal(model.saturationPressureRetries, 0);

  const before = model.slots.map((slot) => slot?.id ?? null);
  assert.equal(model.retireOne(), null);
  assert.deepEqual(model.slots.map((slot) => slot?.id ?? null), before);
  assert.equal(model.active, 64, "credit exhaustion must not evict another hot TB");
  assert.equal(model.retrySaturatedPressure(7999), false);
  assert.equal(model.retrySaturatedPressure(8000), true);
  assert.equal(model.runMicrotaskCheckpoint(), true,
    "pressure must survive the current microtask checkpoint");
  assert.equal(model.runPressureTask(0), 0);
  assert.equal(model.pressureHeld, false);
  assert.equal(model.retrySaturatedPressure(8000), false);
  assert.equal(model.retrySaturatedPressure(9000), true);
  assert.equal(model.pressureHeld, true);
  assert.equal(model.runPressureTask(4), 4,
    "the yielded pressure task must deliver finalizers before turnover resumes");
  assert.equal(model.pressureRequests, 5);
  assert.equal(model.saturationPressureRetries, 2);
  assert.equal(model.active, 64, "pressure retries must not spend retirement credit");
  assert.equal(model.retained, 68);
  assert.equal(model.pending, 4);
  assert.equal(model.retrySaturatedPressure(10_000), false);
  for (let replacement = 0; replacement < 4; replacement += 1) {
    assert.notEqual(model.retireOne(10_000 + replacement * 1000), null);
    assert.equal(model.install(72 + replacement), true);
    if (model.pressureTaskPending) assert.equal(model.runPressureTask(0), 0);
  }
  assert.equal(model.active, 64);
  assert.equal(model.retained, 72);
  assert.equal(model.pending, 8);
});

test("CLOCK pressure leaves a bounded retained-wrapper budget", () => {
  const activeCap = 60_000;
  const replacementCredit = 4_096;
  const vcpus = 4;
  const pressureBytes = vcpus * 4 * 1024 * 1024;
  const rawSourceBytes = replacementCredit * 1011.9017333333334;
  const cBytesSaved = vcpus * (
    ((8 - 12) * activeCap) + ((50_000 - 1) * 4)
  );
  const measuredHeadroom = 132 * 1024 * 1024;
  const wrapperBudget = measuredHeadroom - pressureBytes - rawSourceBytes + cBytesSaved;

  assert.equal(cBytesSaved, -160_016);
  assert.equal(pressureBytes, 16 * 1024 * 1024);
  assert.ok(rawSourceBytes < 4 * 1024 * 1024);
  assert.ok(wrapperBudget > 111 * 1024 * 1024);
  assert.ok(wrapperBudget / replacementCredit > 27 * 1024);
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
        metricsSchemaVersion: 4,
        cachePolicy: {
          kind: "bounded-clock-v2",
          activeCap: 60000,
          replacementCredit: 4096,
          retainedCap: 64096,
          gcPressureBytes: 4 * 1024 * 1024,
          gcPressureInterval: 64,
          gcPressureRetryMilliseconds: 1000,
          gcPressureHold: "next-task",
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
    kind: "bounded-clock-v2",
    activeCap: 60000,
    replacementCredit: 4096,
    retainedCap: 64096,
    gcPressureBytes: 4 * 1024 * 1024,
    gcPressureInterval: 64,
    gcPressureRetryMilliseconds: 1000,
    gcPressureHold: "next-task",
  });
  assert.equal(clock.instantiateThreshold, 1500);
  assert.equal(clock.metricsSchemaVersion, 4);
  assert.equal(clock.promotionEligible, false);
  assert.ok(metadata.component.patches.includes(
    "patches/qemu-wasm-tcg-bounded-clock-cache.patch",
  ));
});
