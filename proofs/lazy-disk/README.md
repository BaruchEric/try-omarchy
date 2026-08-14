# Lazy HTTP disk copy-on-write proof

This is a bounded browser proof for the production disk strategy. It uses the
same pinned Emscripten builder as QEMU-Wasm and verifies that:

- a file is read through 1 MiB HTTP byte ranges inside a Worker;
- QEMU-style in-range writes mutate fetched chunks in memory;
- later reads observe the writes without changing the server image; and
- unrelated source chunks remain intact.

Build with `./build.sh`, serve the repository with the runtime server, and open
`/proofs/lazy-disk/index.html`. The generated `dist/` directory is intentionally
ignored.

The first Chromium run against Emscripten 3.1.50 passed with one HEAD request,
two non-overlapping 1 MiB range requests, eight bytes written to chunk 3, and
no whole-file request. The C program observed its write and re-read the original
marker from chunk 1. There were no page or worker console errors.

