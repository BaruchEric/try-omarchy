# Browser VM runtime

This directory contains the one browser runtime kept by the project: a real
x86_64 Omarchy guest running fully client-side in QEMU compiled to WebAssembly.
The browser profile uses QEMU 8.2, pthreads/SharedArrayBuffer, MTTCG, SDL2,
`virtio-vga`, two guest vCPUs, 1 GiB RAM, and the software presentation path
`sdl,gl=off`.

There are no ARM-browser, remote-streaming, VirGL/WebGL2, TCG-threshold, or
alternate-vCPU runtime variants here. The separate Apple-native runtime is in
`native/macos/`.

## Requirements

- Docker for building and packaging the pinned QEMU-Wasm toolchain
- Node.js for verification, tests, packaging metadata, and the local server
- a browser with WebAssembly threads, `SharedArrayBuffer`, OffscreenCanvas,
  module Workers, and cross-origin isolation
- the pinned upstream checkouts recorded in `upstream.lock.json`

The VM executes locally in the browser. The local server only provides static
artifacts and strict byte-range reads; it does not run or stream the guest.

## Commands

The Makefile deliberately exposes only this lifecycle:

```sh
make -C runtime audit
make -C runtime build
make -C runtime package GUEST_DIR=../guest/dist
make -C runtime serve
make -C runtime smoke
make -C runtime test
make -C runtime verify
```

`build` writes the canonical QEMU-Wasm bundle to `runtime/dist/`.
`package` binds the x86_64 guest bundle into the runtime manifest without
copying the large guest artifacts. `serve` verifies both bundles and serves
`http://127.0.0.1:8094/web/full-guest.html`.

`smoke` builds the firmware-only SDL bundle in `runtime/smoke-dist/`.
`verify` validates the already-packaged canonical `runtime/dist/` and does
not rewrite its verification report.

`browser-qemu` is a compatibility alias for `serve` used by the repository's
`omarchy:browser` npm command. `verify-dist` is a compatibility alias for
`verify`. Neither selects a different runtime.

## Boot modes

Cold boot is the honest default. `config/demo.json` contains no checkpoint.

Packaging enables the single supported fast path only when `guest/dist`
contains the complete generic migration-checkpoint set:

- `checkpoint-manifest.json`
- `omarchy-preboot.vmstate`
- `checkpoint-overlay.qcow2`

The packager rejects a partial set. It verifies the exact guest, QEMU Wasm,
machine profile, immutable backing image, checkpoint source evidence, vmstate,
and overlay identities before emitting a checkpoint-enabled runtime manifest.
Disposable writes still go to QEMU's snapshot layer. Guest hibernation and
GPU-bound resume profiles are not supported.

## Runtime and security model

The production Worker owns the OffscreenCanvas, QEMU module, paged disk,
bounded overlay, serial diagnostics, frame evidence, and sanitized input
bridge. The Worker bundle is self-contained and records the digest of each
embedded source module.

The release manifest binds every runtime and guest artifact by size and
SHA-256. Large guest/checkpoint assets are read with bounded, immutable HTTP
ranges. The server rejects path traversal, mutable range behavior, malformed
manifests, oversized bootstrap assets, and incomplete checkpoint profiles.

A cold boot accepts guest authenticity only from one valid serial
`OMARCHY_GUEST_REPORT`. A checkpoint boot accepts only the authenticated
source report bound into the checkpoint evidence. Desktop proof and frame
evidence come from the actual QEMU SDL presentation path.

## Build notes

`scripts/build-qemu-wasm.sh` builds the pinned QEMU-Wasm source in a pinned
Emscripten 3.1.50 container. It applies only the production browser patches for
SDL frame/input integration, Worker-safe DOM behavior, texture/page-flip reuse,
runstate handling, TCG initialization, and the nested-Wasm vCPU layout guard.
The latter is a canonical correctness guard, not an alternate vCPU profile.

The builder keeps reusable Docker build caches. Generated artifacts live only in
`runtime/dist/`, `runtime/smoke-dist/`, and `runtime/build/`; none are
source runtime variants. The checked-in `config/linux-x86_64.config` provides
the guest kernel's DRM/KMS and virtio input requirements.

`runtime-build.json` is a digest/size/provenance fragment for release
assembly. It is not the complete release artifact manifest.
