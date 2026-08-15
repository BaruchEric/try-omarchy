# Paged immutable Omarchy guest disk

`paged-disk.mjs` registers a multi-gigabyte, same-origin `rootfs.ext4` at
`/pack/rootfs.ext4` without first copying the image into JavaScript or Wasm
memory. It is the production successor to `proofs/lazy-disk`.

The adapter has two deliberately separate phases:

1. `preflightPagedDisk` asynchronously performs one `HEAD` and one
   `Range: bytes=0-0` request. It verifies the release byte length, identity,
   identity encoding, `Accept-Ranges`, HTTP 206, `Content-Range`, response
   length, and same-origin URL.
2. `createPagedDiskPreRun` returns a synchronous Emscripten `preRun` hook. Each
   read fetches only the required aligned range with a strict `If-Match`
   validator. A server that ignores a range is aborted as soon as response
   headers arrive. The immutable clean-chunk cache is LRU-bounded and may evict
   and re-fetch data. The adapter replaces Emscripten 3.1.50's byte-at-a-time
   lazy `stream_ops.read` with chunk-granular typed-array copies, so a bulk QEMU
   disk read performs cache work once per chunk rather than once per byte.

The base node has no write permission, and its write/allocate stream operations
throw `EROFS`. QEMU must use `-snapshot`; QEMU's temporary overlay provides
guest-visible writes while the HTTP base remains immutable.

## Exact runtime integration

The generated QEMU module must be instantiated in a dedicated **outer Worker**.
Emscripten 3.1.50 intentionally refuses synchronous lazy XHR on `Window`, and
`PROXY_TO_PTHREAD` does not change where `preRun` runs. Perform the preflight in
that Worker, then pass the returned hook to the QEMU factory:

```js
// qemu-host.worker.mjs
import { preparePagedDisk } from "/storage/paged-disk.mjs";
import createQemu from "/omarchy/qemu.mjs";

const release = await fetch("/omarchy/versions/f0020448/artifact-manifest.json")
  .then((response) => response.json());
const rootfs = release.artifacts.find((item) => item.role === "guest-rootfs");

const disk = await preparePagedDisk({
  url: new URL(`/omarchy/versions/f0020448/${rootfs.path}`, self.location.href).href,
  path: "/pack/rootfs.ext4",
  byteLength: rootfs.bytes,
  sha256: rootfs.sha256,
}, {
  scope: self,
  origin: self.location.origin,
  onRequest: (request) => postMessage({ type: "disk-request", request }),
});

const moduleOptions = {
  // The HTML canvas is transferred exactly once to this outer Worker.
  canvas: offscreenCanvasFromWindow,
  arguments: [...baseQemuArguments, ...disk.qemuArguments],
  preRun: [disk.preRun],
  // locateFile/print/printErr/onGuestFrame are omitted here for brevity.
};

await createQemu(moduleOptions);
```

`disk.qemuArguments` is exactly:

```text
-snapshot
-drive
file=/pack/rootfs.ext4,if=virtio,format=raw,media=disk,cache=unsafe
```

Do not add another writable Emscripten wrapper around the base. Do not preload
`rootfs.ext4` through Emscripten's file packager. The kernel, initramfs,
firmware, and QEMU executable are still ordinary bounded assets.

For the graphics path, transfer the browser `HTMLCanvasElement` to one
`OffscreenCanvas` exactly once, into this outer runtime Worker. Keep
`OFFSCREEN_FRAMEBUFFER=1`; do not enable `OFFSCREENCANVASES_TO_PTHREAD`. SDL/EGL
calls from QEMU's pthread must proxy to the outer Worker, while serial, guest
report, frame, and error events are posted back to the iframe/window.

## Required HTTP contract

The immutable rootfs route must return all of the following for both `HEAD` and
range responses:

- `Content-Length` for the selected representation (the complete length on
  `HEAD`, the selected length on HTTP 206);
- `Accept-Ranges: bytes`;
- an exact strong `ETag`, preferably `"sha256-<artifact sha256>"`, or an RFC
  9530 `Repr-Digest: sha-256=:<base64>:` matching the release SHA-256;
- no `Content-Encoding` (or explicitly `identity`);
- `Content-Range: bytes START-END/TOTAL` and HTTP 206 for every range request;
- `Cross-Origin-Resource-Policy: same-origin`, alongside the site's COOP/COEP
  isolation headers; and
- immutable caching for the content-addressed release URL.

The release route should synthesize the SHA-256 ETag from the verified artifact
manifest instead of trusting a multipart-object-store ETag. It must honor
`If-Match` and reject stale validators. A `GET` without `Range` should not be
used by the app; rejecting it at the rootfs route is a useful deployment guard.

## Integrity and compatibility boundaries

- A release SHA-256 in JSON does not, by itself, prove each fetched chunk.
  This adapter binds each request to a strong server representation validator.
  End-to-end untrusted-CDN verification would require a signed Merkle/chunk
  manifest and synchronous per-chunk hashing, which is outside this adapter.
- The adapter intentionally relies on the `LazyUint8Array` shape emitted by
  pinned Emscripten 3.1.50. Its tests must run again before any Emscripten
  upgrade.
- In the deterministic 1 MiB bulk-read regression (64 KiB test chunks), the
  pinned reader's 1,048,576 lazy getter calls are replaced by 16 chunk copies
  and 16 LRU touches. There are zero byte-wise lazy getter calls on the stream
  read path. Production's default 1 MiB chunks reduce an aligned 1 MiB read to
  one chunk copy and one LRU touch.
- Synchronous XHR is valid in a dedicated Worker but unavailable in service
  workers and rejected here on `Window`.
- The clean cache defaults to and is capped at 128 MiB. The production QEMU
  build reserves a fixed 2,300 MiB Wasm heap, so heap plus the maximum clean
  cache is 2,428 MiB and leaves 132 MiB inside the 2,560 MiB process budget for
  Worker, graphics, and browser overhead. Lower cache values can increase
  repeated range traffic. The cache never grows to the full image merely
  because the image is large.
- The browser proof uses a small real Emscripten binary. A release acceptance
  run must additionally inspect production request logs while the authentic
  guest boots and confirm zero un-ranged `rootfs.ext4` GETs.

## Verification

Run the deterministic tests:

```sh
node --test storage/*.test.mjs storage/proof/*.test.mjs
```

Build and run the browser fixture:

```sh
storage/proof/build.sh
node storage/proof/server.mjs --port 8091
```

Open the printed URL. The page reports PASS only after the real Emscripten
program completes a 1 MiB `pread` plus separated disk reads through the bulk
stream path, the server request log contains bounded range requests, and the
rootfs request log contains zero full-file GETs.
