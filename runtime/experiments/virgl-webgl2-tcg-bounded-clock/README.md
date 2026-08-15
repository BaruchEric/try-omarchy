# VirGL/WebGL2 bounded-CLOCK TCG experiment

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

The old policy retired half of each vCPU's FIFO when the global 15,000-module
limit was reached. With no observed `FinalizationRegistry` callback, that
destroyed the useful cache and then denied every replacement. The bounded
CLOCK policy instead:

- gives referenced TBs a second chance and retires only one TB per capacity
  miss;
- caps callable modules at 15,000, pending replacements at 256, and retained
  wrappers at 15,256 with atomic reservation and rollback;
- clears and verifies both Emscripten table roots synchronously;
- requests best-effort GC pressure with a touched 4 MiB allocation at
  retirement 1 and every 64 retirements, then yields;
- stops retiring when all 256 credits are pending. Without any finalization,
  unseen TBs fall back to TCI but the remaining 15,000-entry active cache is
  preserved instead of being halved.

The conservative no-GC allocation envelope is five 4 MiB pressure allocations
(20 MiB) plus about 0.247 MiB of measured raw TB source for 256 replacements.
Shrinking the per-vCPU removal queue from 50,000 entries to one offsets the
reference-bit expansion and saves about 0.534 MiB of C/TLS storage at four
vCPUs. That leaves more than 112 MiB of the measured 132 MiB non-Wasm headroom
for browser-specific compiled-code and wrapper overhead, but browser process
memory remains a required acceptance gate.

Promotion requires a fresh exact VirGL-compatible checkpoint and a browser run
showing all of the following: active/retained caps hold; no table-root
assertion; post-cap nested-Wasm coverage does not collapse; process memory
stays inside the existing headroom; and unique-frame/input latency materially
improves. A higher hot threshold alone is not a lifetime solution.
