# VirGL/WebGL2 bounded-CLOCK-v2 TCG experiment

This profile is isolated and **not promotion eligible**. It combines the
threshold-1500 metrics baseline with
`runtime/patches/qemu-wasm-tcg-bounded-clock-cache.patch`; it does not modify
`runtime/dist` unless someone deliberately promotes rebuilt artifacts later.

Source build target (not run as part of this change):

```sh
make -C runtime build-virgl-webgl2-tcg-bounded-clock
```

Its isolated output is
`runtime/experiments/virgl-webgl2-tcg-bounded-clock/dist`. Packaging, after a
successful build, is similarly explicit:

```sh
make -C runtime package-virgl-webgl2-tcg-bounded-clock GUEST_DIR=/absolute/path/to/guest/dist
make -C runtime serve-full-virgl-webgl2-tcg-bounded-clock
```

The isolated server listens on `127.0.0.1:8099`; it never replaces the working
software baseline on port 8094.

The original FIFO policy retired half of each vCPU's cache when the global
15,000-module limit was reached. Bounded-CLOCK-v1 preserved that cache, but a
live hibernation trace exposed a liveness trap: 566 retirements produced 310
finalizers, leaving the retained and pending counts pinned at 15,256 and 256.
Because v1 requested pressure only after a successful retirement, exhausting
the retirement credits also stopped the pressure needed to recover them.
Schema-4 bounded-CLOCK-v2 instead:

- gives referenced TBs a second chance and retires only one TB per capacity
  miss;
- caps callable modules at 15,000, pending replacements at 256, and retained
  wrappers at 15,256 with atomic reservation and rollback;
- clears and verifies both Emscripten table roots synchronously;
- requests best-effort GC pressure with a touched 4 MiB allocation at
  retirement 1 and every 64 retirements, with all requests limited to one per
  worker per second;
- while all 256 credits are pending, retries that pressure independently in
  each worker from the existing amortized yield path, holds the allocation
  until the next task, yields, and checks finalizer callbacks;
- stops retiring when all 256 credits are pending. Without any finalization,
  unseen TBs fall back to TCI but the remaining 15,000-entry active cache is
  preserved instead of being halved; pressure retries do not spend another
  retirement credit.

The wall-clock limiter plus the mandatory yield keeps at most one 4 MiB
pressure allocation live per worker: 8 MiB for the two-vCPU hibernation profile
and 16 MiB at four vCPUs. The 256 replacements add about 0.247 MiB of measured
raw TB source.
Shrinking the per-vCPU removal queue from 50,000 entries to one offsets the
reference-bit expansion and saves about 0.534 MiB of C/TLS storage at four
vCPUs. That leaves more than 116 MiB of the measured 132 MiB non-Wasm headroom
for browser-specific compiled-code and wrapper overhead, but browser process
memory remains a required acceptance gate.

Promotion requires a fresh exact VirGL-compatible checkpoint and a browser run
showing all of the following: active/retained caps hold; no table-root
assertion; after the first 256-pending saturation, finalizer and replacement
counters resume increasing while pending drops; fallback-TCI slope falls;
post-cap nested-Wasm coverage does not collapse; process memory stays inside
the existing headroom; and unique-frame/input latency materially improves. A
higher hot threshold alone is not a lifetime solution.
