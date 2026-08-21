import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runtime = dirname(dirname(fileURLToPath(import.meta.url)));

test("exact-signature batch32 applies in production patch order", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-runtime-tcg-batch32-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "tcg"));
  const upstream = process.env.QEMU_WASM_SOURCE ?? "/private/tmp/qemu-wasm-source";
  for (const relativePath of ["tcg/wasm32.c", "tcg/wasm32.h"]) {
    await writeFile(join(root, relativePath), await readFile(join(upstream, relativePath)));
  }

  for (const relativePatch of [
    "patches/qemu-wasm-tcg-vcpu-layout.patch",
    "patches/qemu-wasm-tcg-baseline-threshold-1500-metrics.patch",
    "patches/qemu-wasm-tcg-fill-only-120k.patch",
    "patches/qemu-wasm-tcg-exact-batch32.patch",
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
  assert.match(header, /OMARCHY_WASM_TCG_METRICS_SCHEMA 6/);
  assert.match(source, /EM_JS\(int, instantiate_wasm_batch/);
  assert.match(source, /BATCH_SIZE = 32/);
  assert.match(source, /PARTIAL_FLUSH_AFTER = 128/);
  assert.match(source, /OMARCHY_WASM_TCG_BATCH_WAIT_EXECUTIONS 256/);
  assert.match(source, /OMARCHY_WASM_TCG_BATCH_FLUSH_COUNTER/);
  assert.match(source, /queued Wasm batch candidate is missing/);
  assert.match(source, /generated exact-signature Wasm batch is invalid/);
  assert.match(source, /dispatchers=one-per-module/);
  assert.match(source, /OMARCHY_TCG_MODULE_LAYOUT_INVALID/);
  assert.match(source, /OMARCHY_TCG_MODULE_MAGIC_INVALID/);
  assert.match(source, /queued-tbs=%/);
  assert.match(source, /compiled-tbs=%/);
  assert.match(source, /full-batches=%/);
  assert.match(source, /partial-batches=%/);
  assert.match(source, /batch-wait-tci=%/);
  assert.match(source, /OMARCHY_WASM_TCG_BATCH_QUEUED_COUNTER/);
});

test("batch32 build and verification plumbing is isolated", async () => {
  const [makefile, build, packageScript, manifest, stamp, verifier, metadata] =
    await Promise.all([
      readFile(join(runtime, "Makefile"), "utf8"),
      readFile(join(runtime, "scripts/build-qemu-wasm.sh"), "utf8"),
      readFile(join(runtime, "scripts/package-guest.sh"), "utf8"),
      readFile(join(runtime, "scripts/prepare-runtime-manifest.mjs"), "utf8"),
      readFile(join(runtime, "scripts/stamp-tcg-threshold-experiment.mjs"), "utf8"),
      readFile(join(runtime, "scripts/verify-runtime-artifacts.mjs"), "utf8"),
      readFile(join(runtime, "scripts/write-build-metadata.mjs"), "utf8"),
    ]);

  for (const target of [
    "build-virgl-webgl2-tcg-batch32:",
    "package-virgl-webgl2-tcg-batch32:",
    "serve-full-virgl-webgl2-tcg-batch32:",
  ]) assert.ok(makefile.includes(target), `missing Make target ${target}`);
  assert.match(makefile, /VIRGL_WEBGL2_TCG_BATCH32_OUTPUT/);
  assert.match(makefile, /--port 8102/);
  assert.match(build, /tcg_experiment" == "6000-batch32"/);
  assert.match(build, /qemu-wasm-tcg-exact-batch32\.patch/);
  assert.match(packageScript, /"6000-batch32"/);
  assert.match(manifest, /experimentValue === "6000-batch32"/);
  assert.match(stamp, /"6000-batch32": Object\.freeze\(\{ threshold: 6000, metricsSchemaVersion: 6 \}\)/);
  for (const source of [verifier, metadata]) {
    assert.match(source, /kind: "qemu-wasm-tcg-exact-batch32"/);
    assert.match(source, /kind: "exact-signature-v1"/);
    assert.match(source, /batchSize: 32/);
    assert.match(source, /partialFlushPromotions: 128/);
    assert.match(source, /partialFlushWaits: 256/);
    assert.match(source, /tableEntriesPerBatch: 1/);
  }
});
