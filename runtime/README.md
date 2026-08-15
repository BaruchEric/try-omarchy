# Omarchy browser runtime spike

This directory is a buildable, deliberately narrow proof for running an
x86_64 Linux guest in a browser with **real guest-rendered pixels**. It builds
the pinned QEMU-Wasm fork with QEMU's existing SDL2 display frontend; Emscripten
maps that frontend to the page's canvas and forwards browser input back to QEMU.

It is not a desktop reproduction. It also is not yet proof that Hyprland can
render acceptably: the gates below must be passed in order, and the harness
reports missing browser/runtime requirements instead of substituting a mock UI.

## What is implemented

- pinned upstream provenance and an automated source audit;
- an x86_64 QEMU-Wasm builder using Emscripten 3.1.50, pthreads, MTTCG, SDL2,
  Proxy-to-Pthread, and Emscripten's main-thread offscreen framebuffer proxy;
- a minimal build-context-only patch for the pinned Dockerfile's stale zlib
  1.3.1 URL (the source checkout itself remains untouched);
- a graphical QEMU profile with `virtio-vga`, virtio keyboard/tablet, a
  1600×900 target, two virtual cores, 1 GiB guest RAM, and no competing
  parallel-port virtual console;
- the Linux kernel fragment needed for DRM/KMS and virtio input;
- aggregate-bounded firmware/kernel/initramfs mounting plus an immutable HTTP-range guest
  disk, with QEMU `-snapshot` providing disposable writes;
- an optional provenance-bound preboot checkpoint whose QEMU vmstate and qcow2
  boot delta are mounted through bounded ranges;
- a self-contained, digest-verified outer Worker that embeds the canonical input/storage modules,
  owns the OffscreenCanvas, paged filesystem, QEMU factory, serial evidence,
  frame evidence, and sanitized input bridge;
- an Emscripten-only SDL host-decoration patch that skips document-title and
  native-cursor hooks unavailable in that DOM-free Worker;
- a small browser loader with capability and manifest validation;
- a release identity computed from the exact artifact-manifest bytes and guest
  authenticity accepted only when all provenance fields match that identity;
- guest authenticity from either one live `OMARCHY_GUEST_REPORT ` serial record
  on cold boot or the exact authenticated source report bound into a checkpoint,
  plus monotonic `guestframe` events with bounded RGB/non-black samples emitted
  by QEMU's SDL presenter;
- local isolated static and no-copy full-guest servers with strict byte ranges;
- Node tests for the manifest, capability gates, range server, path isolation,
  shell entry points, SDL shim, and kernel fragment.

## Gate 1: audit and test without building QEMU

The checked-in lock currently expects the already-inspected sources at
`/private/tmp/qemu-wasm-source` and `/private/tmp/container2wasm-source`.

```sh
make -C runtime audit
make -C runtime test
```

The audit intentionally confirms that container2wasm is only a reference: its
current x86_64 arguments contain `-nographic`, and its kernel config explicitly
disables DRM. Neither file is reused for the graphical runtime.

## Gate 2: compile graphical QEMU-Wasm

Docker must be running and able to download the pinned Emscripten base image and
upstream build dependencies. The first build is intentionally slow.

```sh
QEMU_WASM_SOURCE=/private/tmp/qemu-wasm-source \
  BUILD_JOBS=4 \
  runtime/scripts/build-qemu-wasm.sh
```

The build must finish with a `CONFIG_SDL` define in QEMU's Meson-generated
`config-host.h`; otherwise the script stops. Outputs are placed in
`runtime/dist/`:

```text
qemu.mjs
qemu.wasm
qemu.worker.js
runtime.mjs
production-worker.mjs
worker-input.mjs
paged-disk.mjs
bounded-overlay.mjs
firmware/{bios-256k.bin,vgabios-stdvga.bin,vgabios-virtio.bin,kvmvapic.bin,linuxboot_dma.bin}
runtime-manifest.json
runtime-build.json
```

The `sdl2-config` shim exists because Emscripten exposes SDL2 as a system port,
not as the `sdl2.pc` package that QEMU's Meson build normally detects.
The post-link transform also makes pthread startup safe when the verified QEMU
ES module executes from a `blob:` URL: pthreads use the already-compiled,
transferred `WebAssembly.Module` and never resolve or refetch a relative Wasm
URL against the non-hierarchical Blob base.
QEMU 8.2 marks FDT as required even for `x86_64-softmmu`. The build script reads
the exact `dtc`, `keycodemapdb`, and Berkeley floating-point test-library
revisions from QEMU's pinned wrap files, caches those commits under
`runtime/build/upstreams/`, and mounts a populated subproject overlay so Meson
never tries to write into the read-only QEMU source checkout. (QEMU configures
the floating-point test targets even when only the system binary is requested.)
A named Docker volume caches Emscripten system libraries between builder runs.
Another named volume preserves QEMU's out-of-tree build between diagnostic
iterations.
Pixman is explicitly enabled for QEMU's 2D display surfaces.

### Threshold-250 interactive-performance experiment

The first post-resume TCG A/B is isolated from the canonical build cache and
`runtime/dist`. It compiles hot translation blocks after 250 interpreted
entries, emits bounded five-second per-vCPU metrics, and is explicitly marked
`promotionEligible: false` in its build metadata.

```sh
make -C runtime build-tcg-threshold-250
make -C runtime package-tcg-threshold-250 GUEST_DIR=../guest/dist
```

Artifacts are written under `runtime/experiments/tcg-threshold-250/dist`. The
experiment packages the unchanged verified checkpoint but stamps only its
generated local Worker with the candidate Wasm SHA-256. Checked-in canonical
Worker and release identities remain unchanged, so the experiment cannot be
mistaken for the current promotion candidate. To inspect it later without
changing the canonical server target, run:

```sh
make -C runtime serve-full-tcg-threshold-250
```

### Instrumented threshold-1500 baseline

The control run keeps the upstream `INSTANTIATE_NUM=1500` behavior while
measuring how many translation blocks cross 50, 100, 250, 500, 750, 1000, and
1500 interpreted entries. It emits the same bounded per-vCPU module, live-table,
eviction/finalized-GC, generated-byte, and compile-latency metrics as the hot-250
candidate. Its patch, build cache, packaged artifacts, and server target are
isolated from both `runtime/dist` and the threshold-250 experiment:

```sh
make -C runtime build-tcg-baseline-metrics
make -C runtime package-tcg-baseline-metrics GUEST_DIR=../guest/dist
make -C runtime serve-full-tcg-baseline-metrics
```

Artifacts are written under
`runtime/experiments/tcg-baseline-1500-metrics/dist`. Both experiment build paths
fail closed if their output resolves to canonical `runtime/dist`.

### Checkpoint-compatible WebGL2 presentation experiment

The lowest-risk browser-GPU discriminator keeps the checkpoint's exact
`virtio-vga` guest device and changes only QEMU SDL presentation from
`sdl,gl=off` to `sdl,gl=es`. QEMU uploads the software scanout into a WebGL2
texture and performs the final scale/blit/commit on the browser GPU. Because the
guest-visible PCI device and negotiated virtio features do not change, the
existing software-GPU vmstate remains structurally compatible. The generated
Worker and checkpoint identity are rebound only to the isolated experimental
Wasm and remain `promotionEligible: false`.

```sh
make -C runtime build-webgl2-present
make -C runtime package-webgl2-present GUEST_DIR=../guest/dist
make -C runtime serve-full-webgl2-present
```

Artifacts are written under
`runtime/experiments/webgl2-present-checkpoint/dist`. This A/B can remove the
Canvas2D full-frame copy and distinguish host presentation cost, but it cannot
create frames the guest has not rendered. A 1600x900 XRGB upload is 5.76 MB;
30 full uploads per second would be about 173 MB/s. Current traces place the
software guest's page flips seconds apart while switch-to-SDL presentation is
only milliseconds, so this experiment is not itself a credible 24-30 FPS fix.
Benchmark the bounded `webgl2-present-cadence` diagnostic; ordinary
`guestframe` evidence is intentionally sampled no faster than every 250 ms and
therefore cannot report a visible cadence above 4 FPS.

Actual guest 3D acceleration requires `virtio-vga-gl`/VirGL and fresh feature
negotiation. QEMU 8.2 installs an unconditional migration blocker with the
message `virgl is not yet migratable`, so a live VirGL desktop cannot produce or
consume the current migration checkpoint safely. The isolated VirGL/WebGL2 cold
boot remains the architecture candidate; a checkpoint-like fast path would
need a guest-level pre-compositor resume mechanism or real VirGL migration,
not a device substitution in the existing vmstate.

The pinned QEMU-Wasm fork initializes its thread-local Wasm translator in the
MTTCG vCPU entry point. The two-vCPU, 1 GiB, 128 MiB-TB profile is a promotion
candidate because the corrected guest reached an authentic, settled Omarchy
desktop and opened Foot under the equivalent native QEMU 8.2 topology. It is
not a browser pass: real SharedArrayBuffer/MTTCG execution and the causal
`desktopproof` protocol remain the promotion authority. The prior fail-closed
single-vCPU browser profiles and their unusable desktop-readiness results remain
recorded under `runtime/evidence/full-guest-1024m-usability-2026-08-15.json` and
`runtime/evidence/full-guest-acceptance-a8ddf394-2026-08-15.json`.

`patches/qemu-wasm-tcg-rr-init.patch` still preserves a diagnostically safe
round-robin single-thread fallback by mirroring the translator initialization
before the first translated instruction. A controlled browser A/B also proved
that 1.5 GiB guest RAM plus a 256 MiB translation buffer exhausts the fixed
2300 MiB Wasm heap when translated code first runs; both candidate and fallback
therefore retain 1 GiB RAM and a 128 MiB TCG buffer.

`runtime-build.json` is a digest/size/provenance fragment for the runtime
artifacts. It is not the release `artifact-manifest.json`; the release pipeline
must merge this fragment with the guest image's manifest, guest metadata, and
license bundle, then validate the combined contract before publication. The
release assembler records `runtime-manifest.json` itself as release metadata;
it is intentionally not duplicated inside `runtime-build.json`.

The pinned upstream Dockerfile still requests zlib 1.3.1 from zlib.net's former
top-level download URL. The build script copies only that Dockerfile to a
temporary context and applies `patches/qemu-wasm-builder-zlib-url.patch`, which
uses zlib's official historical-release path. The source checkout is mounted
read-only for compilation.

## Gate 2.5: prove the SDL canvas with firmware only

Before transferring a multi-gigabyte guest, package the built SeaBIOS and
standard VGA firmware as a tiny preload:

```sh
make -C runtime smoke
node runtime/scripts/serve.mjs --root runtime --port 8088
```

Open
`http://127.0.0.1:8088/web/harness.html?assets=../smoke-dist/` and start the VM.
SeaBIOS's visible
no-bootable-device screen is the acceptance signal: it proves the compiled Wasm
binary presented real firmware pixels through QEMU's standard VGA → SDL → browser
canvas path without involving a kernel or root filesystem. It does not prove
the later virtio-gpu guest path, Omarchy, or Hyprland yet.

The exact passing build and observed frame evidence are recorded in
`evidence/browser-smoke.json`. The record intentionally distinguishes this
firmware pixel gate from the later full-guest acceptance report and notes when
no screenshot artifact was persisted.

The development bundle uses stable filenames, so the local server sends
`no-store` for its binary assets. Immutable one-year caching is enabled only
when a binary URL contains a content digest. Release assembly must copy every
large artifact to its content-addressed final path before publishing the
manifest; overwriting a stable `qemu.wasm` under `immutable` caching can pair a
new loader with an old Wasm module and corrupt Emscripten's minified exports.

## Gate 3: package a bootable graphical guest

Provide a directory with exactly these files:

- `rootfs.ext4`: raw ext4 base image; QEMU `-snapshot` keeps the base immutable
  and writes a disposable temporary overlay that is destroyed with the tab;
- `vmlinuz-linux`: x86_64 kernel with the checked-in config fragment applied;
- `initramfs-linux.img`: initramfs containing virtio GPU, block, and input modules if
  those drivers are not built into the kernel.

Then refresh the production runtime metadata against that guest layout:

```sh
runtime/scripts/package-guest.sh /absolute/path/to/guest-assets
```

The following checkpoint files are optional only as a complete set:

```text
checkpoint-manifest.json
omarchy-preboot.vmstate
checkpoint-overlay.qcow2
```

If all three are absent, packaging emits the checked-in cold-boot
`config/demo.json`. If any is present, packaging requires all three and verifies
their declared sizes and SHA-256 digests. It never silently falls back after a
partial, malformed, or mismatched checkpoint is discovered. Thus cold boot is
an explicit development/recovery profile, while a declared checkpoint fails
closed.

The schema-1 `checkpoint-manifest.json` binds the files to the canonical guest
manifest, rootfs, guest provenance, QEMU-Wasm source commit and QEMU 8.2.0,
native producer binary, and exact `pc-q35-8.2`/1024 MiB/two-vCPU MTTCG profile.
Packaging independently binds it to the current browser `qemu.wasm`. The delta
must be immutable qcow2 with a raw, relative `rootfs.ext4` backing filename;
both are co-located under `/pack` in Emscripten FS.

The production bundle deliberately creates neither `qemu.data` nor `load.js`.
The guest remains a separate release artifact. The packaged
`production-worker.mjs` embeds the canonical input bridge, paged-disk adapter,
and bounded-overlay guard and contains no static imports, allowing the host to
verify its bytes before starting it from a Blob module URL. Response bodies are
streamed under hard per-artifact and aggregate bootstrap caps even when
`Content-Length` is absent. It fetches each QEMU module/Wasm/pthread artifact
once, verifies those exact bytes, imports the QEMU glue from an in-memory Blob
URL, passes that Blob URL to pthreads, and maps Emscripten's worker locator to
the verified pthread Blob. There is no post-verification executable network
fetch. The embedded `paged-disk.mjs` adapter exposes
`rootfs.ext4` through 1 MiB synchronous ranges from inside the outer Worker.
The base disk is read-only. The canonical `bounded-overlay.mjs` guard caps
QEMU's temporary MEMFS qcow2 backing capacity at 64 MiB (with a 128 MiB hard
configuration ceiling), returns ENOSPC before over-allocation, and fails the
Worker visibly. Any terminal failure closes the owning outer Worker, destroying
its pthreads, Blob URLs, overlay, and Wasm heap instead of leaving the emulator
consuming CPU. The overlay is also destroyed with the tab.

Checkpoint boot keeps one aggregate 128 MiB immutable-range cache: 88 MiB for
rootfs, 32 MiB for the boot delta, and 8 MiB for vmstate. The 32 MiB allocation
fits the validated 27,721,728-byte boot delta. Vmstate uses 8 MiB
chunks, so the validated 1,058,433,626-byte stream requires at most 127 bounded
range responses rather than one unbounded response and is consumed without
retaining it wholesale. The Worker also rejects duplicate or backwards
vmstate range fetches and exposes a per-request ledger; a successful restore
therefore records monotonically increasing ranges, zero refetches, and an
8 MiB cache/range ceiling. The existing bounded QEMU `-snapshot` overlay and fixed
2300 MiB Wasm heap remain unchanged. QEMU receives exactly one disk drive.
Checkpoint mode replaces the cold raw-rootfs drive with this exact suffix:

```text
-snapshot
-drive file=/pack/checkpoint-overlay.qcow2,if=virtio,format=qcow2,media=disk,cache=unsafe
-incoming file:/pack/omarchy-preboot.vmstate
```

There is no monitor, deferred incoming mode, or host `cont` escape hatch. The
producer gate must prove that immediate file incoming resumes automatically.
The validated producer did so from a running-state migration: native QEMU wrote
the raw stream in about 7.9 seconds and an exact fresh target auto-ran in 951 ms.
Those numbers establish artifact correctness, not browser speed; the Wasm
restore and post-resume proof still require Chromium acceptance.

The checkpoint is captured after the producer has authenticated the unique
guest report and healthy 1600x900 source frame. QEMU does not replay that serial
record on restore. Consequently `checkpoint-manifest.json` embeds the full
parsed report plus its recursively key-sorted compact-JSON SHA-256 and digests
of the producer's report validation, checkpoint frame, and frame-health
evidence. Packaging and the Worker revalidate this binding before QEMU starts.
After a successful exact restore the Worker emits `guestreport` with
`origin: "checkpoint-source-evidence"` and those four evidence digests. Cold
boot emits `origin: "live-guest-serial"`. Consumers must distinguish the two;
a serial report replay from a resumed checkpoint is a terminal error. Neither
origin alone qualifies readiness: both paths still require a fresh randomized,
causal `desktopproof` and a later live 1600x900 frame from the current QEMU.

## Gate 4: run in an isolated browser context

The release host protocol is intentionally small. Create a module Worker from
`production-worker.mjs`, transfer one `OffscreenCanvas` exactly once, then send:

```js
worker.postMessage({
  type: "start",
  canvas: offscreen,
  releaseBaseUrl: new URL("/omarchy/release/", location.href).href,
}, [offscreen]);
```

The same-origin release base must contain `artifact-manifest.json`. Its artifact
records must include every path named by the schema-2 `runtime-manifest.json`:
`qemu.mjs`, `qemu.wasm`, `qemu.worker.js`, `production-worker.mjs`,
`worker-input.mjs`, `paged-disk.mjs`, `bounded-overlay.mjs`, firmware,
`vmlinuz-linux`, `initramfs-linux.img`, and `rootfs.ext4`. A checkpoint release
must also contain the exact producer descriptor, vmstate, delta, provenance,
and QEMU identities declared by the verified runtime manifest. The Worker posts a `release` event
containing the exact manifest SHA-256 and canonical upstream identity before
any guest evidence. It then posts `phase`, `display`,
`serial`, `runtimediagnostic`, `gueststage`, `gueststageerror`, `diskrequest`,
`overlaylimit`, `checkpoint`, `guestreport`, `guestreporterror`, `guestframe`,
`desktopproof`, `inputaccepted`, `inputerror`, and `error` messages. `OMARCHY_GUEST_STAGE`
records are bounded, strictly ordered guest startup diagnostics only. They
cannot qualify readiness or substitute for the provenance-bound final report.
A `running` phase is not desktop readiness.

Input uses the same Worker channel and is accepted only after `running`:

```js
worker.postMessage({ type: "input", event: { kind: "key", code: "KeyA", down: true } });
worker.postMessage({ type: "input", event: { kind: "pointer", x: 0.5, y: 0.5, buttons: 1 } });
worker.postMessage({ type: "input", event: { kind: "wheel", deltaX: 0, deltaY: 1 } });
```

Keyboard `code` values are allowlisted physical USB/SDL scancodes; pointer
coordinates must be finite normalized values and browser button masks are
translated to SDL masks. The native bridge queues SDL motion, button, key, and
wheel events for QEMU's real input handlers. Unknown or out-of-range input is
reported as `inputerror` and never reaches Wasm. `inputaccepted` acknowledges
only the bounded runtime queue; it is never proof that the guest handled an
event. Once the authenticated desktop self-test starts, host input is held in a
128-event queue until the self-test completes so it cannot interleave with the
causal shortcut and command sequence.

To boot the exact local `guest/dist` without copying its 6 GiB disk into
`runtime/` or `public/`, run:

```sh
make -C runtime serve-full
```

Open `http://127.0.0.1:8094/`. The server synthesizes an in-memory combined
artifact manifest from `runtime/dist/runtime-build.json` and
`guest/dist/guest-manifest.json`. Before opening its listening socket it
stream-hashes every declared runtime and guest artifact, including the 6 GiB
rootfs, and refuses any size or SHA-256 mismatch. The verified artifact-set
identity is exposed at `/__verification`, in release response headers, and in
each release request record. It rejects a full `GET` of `rootfs.ext4` and any
checkpoint vmstate or boot delta, requires the manifest-derived strong
`If-Match` for every bounded range, and
exposes request evidence at `/__requests`. Do not open the HTML directly from
disk: QEMU threads require the COOP/COEP isolation headers supplied by the
server.

`running` means only that the Emscripten/QEMU factory started. It never means
the desktop is ready. On cold boot the guest must emit a valid
`OMARCHY_GUEST_REPORT {...}` serial marker (a login prompt may precede the
unique marker on the same line), after which the loader dispatches
`guestreport`. On checkpoint restore it dispatches the separately identified,
descriptor-bound source report described above. The QEMU SDL
source overlay dispatches `guestframe` with `{ sequence, source: "qemu-guest",
guestWidth, guestHeight, timestamp, sampledPixels, nonBlackPixels }` after real
display presentations. A frame alone cannot qualify readiness. On checkpoint
restore the Emscripten factory may resolve while QEMU is still in
`RUN_STATE_INMIGRATE`, so the Worker first waits on a QEMU-thread-maintained
atomic running latch. It then waits at least 15 seconds and requires two exact,
non-black 1600×900/576-sample presentations at least 5 seconds apart before it
arms proof; host input remains deferred throughout that settle window. The
native SDL bridge stores the next 1600×900 frame as a normalized 32×18 RGB
baseline, then the Worker queues a real `Super+Return` through SDL and
virtio-input. Native
sampling independently refuses to capture a proof baseline until
`runstate_is_running()`, and every input export rejects calls before that latch.
The proof queues a native SDL user event that releases all modifiers on QEMU's
I/O thread before the paced shortcut. Only after that complete key
sequence does the native bridge accept a later 576-sample frame with at least 29
changed samples and between 1 and 547 samples sharing one dominant RGB value.
The response-only window is bounded at 180 seconds for browser slow-TCG; all
other proof stages retain their 90-second bound.

Runstate, queued and consumed key transitions, SDL presents, surface switches,
and texture decisions emit bounded monotonic diagnostics. A public
`guestframe` corresponds to an actual exact-size SDL presentation; proof state
does not suppress ordinary 1600×900 frames. Same-format, same-size scanout
surface replacements reuse the existing streaming SDL texture and leave the
old frame visible until virtio-gpu's immediately following explicit resource
flush updates the texture from the new surface. This avoids both texture
destruction/recreation and a duplicate full-frame upload/presentation.

After the visual response, the Worker types a shell command containing a fresh
128-bit lowercase-hex challenge and Enter, with serialized down/up transitions
and 40-millisecond pacing. The same pacing keeps the proof shortcut's Meta key
held for 120 milliseconds and Enter for 40 milliseconds, meeting the observed
successful native QMP transition interval. The command writes its acknowledgement to
`/dev/virtio-ports/omarchy.web.diagnostics`. Exactly one matching, bounded line
must return on the named QEMU virtserial channel. Pre-report, malformed, wrong,
out-of-order, duplicate, replayed, or timed-out acknowledgements fail the whole
Worker. Each causal stage has a fail-closed 90-second bound, covering the
measured 66.4-second slow-TCG terminal launch. Only both the visual delta and
guest acknowledgement produce:

```js
{
  type: "desktopproof",
  proof: {
    schemaVersion: 1,
    artifactManifestSha256,
    challengeSha256,
    baselineSequence,
    responseSequence,
    sampledPixels: 576,
    changedPixels,
    dominantPixels,
  },
}
```

The raw challenge and acknowledgement are deliberately not exposed to the host.
The response `guestframe` is posted before `desktopproof`, though later frames
may arrive while the command round-trip is in flight. Immediately after posting
the proof, the Worker queues a paced Space/Backspace pair at the live shell
prompt and keeps host input deferred until QEMU presents another sampled
1600×900 frame with a sequence greater than `responseSequence`. Absence of that
real post-proof presentation is a terminal liveness timeout.

The host may terminate the outer Worker to destroy the QEMU process and its
pthread children. Because an HTML canvas can transfer only once, reset reloads
the page to create a fresh canvas and disposable disk overlay.

## Unpassed engineering gates

1. The compiled x86_64 Wasm binary and real SeaBIOS pixel path have passed in
   Chromium with monotonically increasing `qemu-guest` frames. The full Omarchy
   guest must still pass the new causal `desktopproof` gate in Chromium; source
   fixtures alone do not prove terminal launch or virtserial acknowledgement.
2. The exact Hyprland/Aquamarine release used by Omarchy must accept the
   virtio-gpu KMS device with software rendering (`llvmpipe`). A successful KMS
   console or Weston boot does not prove this.
3. The demand-paged HTTP base uses a bounded in-memory LRU and may re-fetch
   chunks. Browser memory and cold-boot latency still need measurement on the
   authentic desktop workload.
4. The exact resume snapshot has passed native producer and target validation,
   but its 1,058,433,626-byte sequential range restore, cache ledger, fresh
   causal proof, and live post-proof frame still need Chromium acceptance.
5. Browser-reserved shortcuts cannot all be captured. The product shell will
   need explicit buttons for common Omarchy `Super` shortcuts even though the
   events that do arrive are sent to the real guest.

These are implementation boundaries, not reasons to replace Omarchy with a
visual imitation.
