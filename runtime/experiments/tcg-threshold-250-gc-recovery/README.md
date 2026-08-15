# Bounded nested-Wasm GC recovery experiment

This is a noncanonical, non-promotion-eligible source experiment. Apply
`runtime/patches/qemu-wasm-tcg-hot-threshold-250.patch` to the pinned QEMU-Wasm
source first, then apply
`runtime/patches/qemu-wasm-tcg-bounded-gc-recovery.patch`.

The threshold-250 browser trace reached the existing 15,000-instance cap. Both
cores retired half of their callable entries, but `gc-collected` remained zero
and compilation stopped. The generated Emscripten glue does clear every known
strong reference: `removeFunction` clears the real `wasmTable`, clears the
strong `wasmTableMirror` entry, deletes the weak-map key, and recycles only the
integer table index. Yielding with `emscripten_sleep(0)` lets already-scheduled
finalizers run, but it cannot request a JavaScript GC. Once compilation stops,
there is almost no JavaScript allocation pressure to cause that GC.

The experiment separates callable capacity from retained/unfinalized capacity:

- callable entries remain hard-capped at 15,000;
- retirement uses an atomic, global pool of at most 1,024 entries;
- retained wrappers are hard-capped at 16,024;
- both reservations use atomic rollback, so concurrent vCPU workers cannot
  oversubscribe either cap;
- clearing a table slot is checked synchronously in both the real table and the
  Emscripten mirror;
- if finalization does not recover capacity, execution fails back to TCI.

At the measured average nested module source size (about 1 KiB), one full
replacement window adds about 1 MiB of source bytes. Compiled-code and engine
metadata overhead are browser-dependent, so a browser A/B must still reject the
experiment if process memory erodes the roughly 132 MiB non-Wasm headroom.

Schema 2 reports active, retained, and pending global counts and peaks; atomic
capacity denials; replacement reservations; cleared table slots; finalization
count; GC-yield count and duration; and the existing TCI fallback/compile/frame
metrics. Promotion requires `gc-collected > 0`, `pending-gc-global <= 1024`,
`retained-global <= 16024`, no table-root assertion, lower TCI fallback, better
unique-frame cadence, and acceptable browser memory. A moderate hot threshold
that never reaches the 15,000 cap is preferable to this recovery mechanism.
