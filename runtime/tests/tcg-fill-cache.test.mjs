import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runtime = dirname(dirname(fileURLToPath(import.meta.url)));

test("threshold-6000 fill-only diagnostic applies after measured baseline", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-runtime-tcg-fill-"));
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
  assert.match(header, /OMARCHY_WASM_TCG_HOT_THRESHOLD 6000/);
  assert.match(header, /OMARCHY_WASM_TCG_METRICS_SCHEMA 5/);
  assert.match(source, /MAX_INSTANCE_ALIVE 120000/);
  assert.match(source, /_Static_assert\(MAX_INSTANCE_ALIVE == 120000/);
  assert.match(
    source,
    /cache=fill-only-v1 active-cap=120000 retained-cap=120000/,
  );
  assert.match(source, /eviction=disabled gc-pressure=disabled/);
  for (const metric of ["cross-3000=%", "cross-6000=%"]) {
    assert.ok(source.includes(metric), `missing fill-only metric ${metric}`);
  }
  assert.match(source, /m->cross_3000 \+= value == 3000/);
  assert.match(source, /m->cross_6000 \+= value == 6000/);

  const trySleep = source.slice(
    source.indexOf("static inline void trysleep"),
    source.indexOf("__thread struct wasmContext"),
  );
  assert.doesNotMatch(trySleep, /emscripten_sleep|check_instance_garbage_collected/);
  const capFallback = source.slice(
    source.lastIndexOf("} else if (!can_add_instance())"),
    source.lastIndexOf("} else {") + "} else {".length,
  );
  assert.match(capFallback, /omarchy_wasm_tcg_record_fallback_tci/);
  assert.doesNotMatch(
    capFallback,
    /remove_instance_running_local|check_instance_garbage_collected|emscripten_sleep/,
  );
});

test("fill-only build, package, identity, and verifier plumbing stays isolated", async () => {
  const [makefile, build, packageScript, manifest, stamp, verifier, metadata, readme] =
    await Promise.all([
      readFile(join(runtime, "Makefile"), "utf8"),
      readFile(join(runtime, "scripts/build-qemu-wasm.sh"), "utf8"),
      readFile(join(runtime, "scripts/package-guest.sh"), "utf8"),
      readFile(join(runtime, "scripts/prepare-runtime-manifest.mjs"), "utf8"),
      readFile(join(runtime, "scripts/stamp-tcg-threshold-experiment.mjs"), "utf8"),
      readFile(join(runtime, "scripts/verify-runtime-artifacts.mjs"), "utf8"),
      readFile(join(runtime, "scripts/write-build-metadata.mjs"), "utf8"),
      readFile(join(
        runtime,
        "experiments/virgl-webgl2-tcg-fill-120k/README.md",
      ), "utf8"),
    ]);

  for (const target of [
    "build-virgl-webgl2-tcg-fill-120k:",
    "package-virgl-webgl2-tcg-fill-120k:",
    "serve-full-virgl-webgl2-tcg-fill-120k:",
  ]) assert.ok(makefile.includes(target), `missing Make target ${target}`);
  assert.match(makefile, /VIRGL_WEBGL2_TCG_FILL_120K_OUTPUT/);
  assert.match(makefile, /--port 8101/);
  assert.match(build, /tcg_experiment" == "6000-fill"/);
  assert.match(build, /qemu-wasm-tcg-fill-only-120k\.patch/);
  assert.match(packageScript, /"6000-fill"/);
  assert.match(
    packageScript,
    /"750" \|\| "\$tcg_experiment" == "6000-fill"/,
  );
  assert.match(packageScript, /"1" \|\|[\s\S]+"4"/);
  assert.match(manifest, /experimentValue === "6000-fill"/);
  assert.match(
    manifest,
    /experimentValue === "750" \|\| experimentValue === "6000-fill"/,
  );
  assert.match(stamp, /"6000-fill": Object\.freeze\(\{ threshold: 6000, metricsSchemaVersion: 5 \}\)/);
  for (const source of [verifier, metadata]) {
    assert.match(source, /kind: "qemu-wasm-tcg-fill-only"/);
    assert.match(source, /kind: "fill-only-v1"/);
    assert.match(source, /activeCap: 120000/);
    assert.match(source, /\[750, 6000\]/);
    assert.match(source, /retainedCap: 120000/);
    assert.match(source, /eviction: "disabled"/);
    assert.match(source, /gcPressure: "disabled"/);
  }
  assert.match(metadata, /patches\/qemu-wasm-tcg-fill-only-120k\.patch/);
  assert.match(readme, /diagnostic bridge/);
  assert.doesNotMatch(readme, /promotion eligible/i);
});
