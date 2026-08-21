# VirGL/WebGL2 exact-signature batch32 diagnostic

This isolated, non-promotable A/B profile tests whether nested Wasm module and
instance churn is the dominant QEMU-Wasm cost. It keeps the authentic Quattro
guest, two vCPUs, VirGL/WebGL2 graphics, the 6,000-execution promotion threshold,
and the measured 120,000-block fill-only cap unchanged.

The only structural change is hot-block batching:

- group translation blocks only when their Wasm type/import/global sections and
  concrete helper-function vectors match exactly;
- compile up to 32 original block bodies into one nested Wasm module;
- expose one dispatcher, consuming one Emscripten table entry per batch;
- flush the oldest partial group after 128 new promotions so uncommon signatures
  cannot wait forever;
- flush a currently executing queued group after 256 interpreted executions so
  a hot partial group cannot starve while waiting for unrelated promotions;
- retain unmatched or waiting blocks on the existing TCI path;
- emit batch occupancy, pending-block, compile, and execution telemetry.

This first diagnostic intentionally uses fill-only lifetime accounting and is
not production-safe across long-running code-cache flushes. A measured win must
be followed by batch-level eviction and flush-generation handling before it can
be promoted.

```sh
make -C runtime build-virgl-webgl2-tcg-batch32
make -C runtime package-virgl-webgl2-tcg-batch32 GUEST_DIR=../guest/dist
make -C runtime serve-full-virgl-webgl2-tcg-batch32
```

The local server listens on `127.0.0.1:8102`. Compare it against the unchanged
fill-only profile on port 8101 using the same browser, guest assets, two-vCPU
topology, elapsed windows, and trusted `webgl2-present-cadence` telemetry.

## Measured rejection

The 2026-08-21 browser A/B rejected this design:

- the original 128-promotion partial flush stranded hot blocks in TCI and
  exceeded 150 million batch-wait entries;
- a bounded 256-execution flush removed that starvation, but exact signatures
  averaged only about 1.8 compiled blocks per module and produced no full batch;
- cadence fell to 0.895 FPS and the guest panicked around guest time 26 seconds.

The generated 14 MB runtime was removed after the run. This source remains only
as reproducible negative evidence; it must not be used as a runtime candidate.
