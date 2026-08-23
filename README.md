# Try Omarchy: browser VM and native Apple Silicon

This project retains two runnable builds of the real
[Basecamp Omarchy](https://github.com/basecamp/omarchy) Quattro desktop:

1. A fully client-side x86_64 QEMU/WebAssembly virtual machine. The browser
   renders the guest framebuffer, forwards keyboard and pointer input, and
   discards temporary writes when the tab closes. It works on ARM and x86 hosts,
   but all guest CPU execution is still emulated and can be slow.
2. A native Apple Silicon window backed by Apple's Virtualization.framework.
   Its ARM64 guest runs with hardware virtualization and uses a host-bound
   resume state for the fast local experience.

The original browser-VM path is not recreated with HTML or streamed from a
server. The guest is Arch Linux booting Hyprland, Quickshell, Omarchy's
commands, configuration, and themes from upstream commit
`7488eaded43de68ff9d2d7e4bf50cd48e112eb0f`.

The separate `/browser` route is the browser-native Browser Edition recreation;
it is not either of the two full-system runtimes above.

An isolated WebRTC proof now provides the performance-oriented alternative: a
real, architecture-native Omarchy VM stays on a hardware-virtualized host while
the browser receives its video and sends keyboard, pointer, and wheel input over
an encrypted peer connection. This POC deliberately does not replace or weaken
the browser-VM authenticity path.

## How it works

```text
Launcher page
  └─ disposable same-origin iframe
       └─ module Worker + transferred OffscreenCanvas
            └─ QEMU 8.2 compiled with Emscripten/SDL2
                 ├─ verified kernel + initramfs
                 ├─ demand-paged read-only ext4 base from HTTP ranges
                 ├─ temporary QEMU snapshot writes
                 └─ real Omarchy/Hyprland/Quickshell guest
```

The fixed guest display is 1600×900. A session is shown as ready only after a
guest-originated authenticity report is followed by a newer framebuffer event
from QEMU. Merely starting WebAssembly never satisfies readiness.

Large immutable artifacts live behind the versioned
`/omarchy/versions/<release>/...` route. `rootfs.ext4` can only be read through
bounded, identity-pinned byte ranges; a full root filesystem response is
rejected. QEMU uses `-snapshot`, so the base disk never changes.

## Repository map

- `app/` and `public/vm/`: launcher, disposable iframe, display, input, reset,
  fullscreen, diagnostics, and honest capability/error states.
- `runtime/`: pinned QEMU-Wasm build, SDL framebuffer instrumentation,
  production Worker, input bridge, local browser harness, and artifact checks.
- `storage/`: fail-closed synchronous paged-disk adapter for Emscripten Workers.
- `guest/`: reproducible trimmed Arch image containing the authentic pinned
  Omarchy payload and supported VM-only overlays.
- `graphics/` and `proofs/`: native guest graphics and end-to-end evidence
  harnesses; proof pixels always originate in the guest.
- `worker/`: isolated R2 artifact delivery with strict range and identity rules.
- `distribution/` and `release/`: SPDX/notices/source evidence and atomic,
  digest-verified release assembly.
- `scripts/verification/` and `docs/`: schemas, stop-ship gates, and the
  canonical five-minute acceptance journey.

## Develop the site

Node.js 22.13 or newer is required.

```sh
npm ci
npm test
npm run dev
```

The launcher intentionally reports missing VM files until an immutable release
exists at its pinned artifact path. It never substitutes a screenshot or fake
desktop.

## Run the two full-system builds locally

Start the complete client-side x86_64 VM:

```sh
npm run omarchy:browser
```

Then open `http://127.0.0.1:8094/web/full-guest.html`. The loopback server
verifies the canonical runtime and guest, serves the 6 GiB disk through bounded
byte ranges without copying it, and keeps execution, display, input, and
temporary writes in the browser.

On an Apple Silicon Mac, build, ad-hoc sign, validate, and open the native ARM64
window with host-bound resume enabled:

```sh
npm run omarchy:native
```

This is a repo-local developer launcher, not yet a notarized downloadable
`.app`. It keeps the real guest and native VM window, and it does not involve
the WebRTC streaming proof.

For the experimental QEMU GPU path, prepare the pinned ARM64 QEMU,
VirGL, and ANGLE/Metal runtime once, then launch the same real Quattro ARM64
guest with HVF CPU virtualization:

```sh
npm run omarchy:native:gpu:prepare
npm run omarchy:native:gpu
```

This launcher requires Apple Silicon and one-time Accessibility permission for
the signed **Omarchy Quattro** helper. The permission is used only to turn
Command into guest Super while the QEMU window is focused; physical Option
remains guest Alt. Its verified root disk persists by default, so guest files
and settings survive close/reopen. Use `npm run omarchy:native:gpu:ephemeral`
for a clean throwaway session or `npm run omarchy:native:gpu:reset` to replace
the current bundle's persistent disk with a fresh verified clone.

## Run the WebRTC performance proof

The WebRTC proof is dependency-free and loopback-only by default:

```sh
npm run stream:poc
```

Open `http://127.0.0.1:8110/`, create a room, open its capture-host link, and
start the built-in 60 FPS pattern. Open the viewer link to verify WebRTC video,
decoded FPS, bitrate, packet loss, and acknowledged keyboard/pointer input.

To stream real Omarchy on Apple Silicon, first build and sign the native helper
and ARM64 guest, then run the helper for the exact POC origin:

```sh
native/macos/.build/release/omarchy-vm-helper --serve guest/dist-aarch64 \
  --allowed-origin http://127.0.0.1:8110 --stream-window
```

Use **Launch native Omarchy** in the capture host, then **Share Omarchy window**.
The browser requires a deliberate window-selection click. See
`native/macos/README.md` for build and macOS permission details.

## Build and verify the VM

Build the real guest in the supplied privileged Arch container. Docker Desktop
uses a persistent Linux volume for the work tree and package cache.

```sh
./guest/test
./guest/build-container.sh --output "$PWD/guest/dist"
(cd guest/dist && shasum -a 256 -c SHA256SUMS)
```

Build and validate the graphical QEMU-Wasm runtime:

```sh
make -C runtime audit
make -C runtime test
QEMU_WASM_SOURCE=/private/tmp/qemu-wasm-source BUILD_JOBS=4 \
  runtime/scripts/build-qemu-wasm.sh
make -C runtime verify-dist
make -C runtime package GUEST_DIR=../guest/dist
```

Then boot the exact local guest through the production paged Worker without
copying the 6 GiB raw disk:

```sh
make -C runtime browser-qemu
```

Open `http://127.0.0.1:8094/web/full-guest.html` in a current Chromium browser.
The local server supplies COOP/COEP isolation, synthesizes a verified combined
manifest, refuses full rootfs reads, and records range requests at
`/__requests`.

## Release discipline

The blocking criteria are in [docs/acceptance.md](docs/acceptance.md). A public
release needs the same-run authenticated desktop/frame/input journey, display
and performance evidence, immutable artifacts, package-level notices and SBOM,
corresponding source for the modified emulator, and human approval for Omarchy
name/logo use. Engineering checks never imply legal or trademark clearance.

See these focused guides for details:

- [guest/README.md](guest/README.md)
- [runtime/README.md](runtime/README.md)
- [storage/README.md](storage/README.md)
- [distribution/README.md](distribution/README.md)
- [release/README.md](release/README.md)
- [docs/verification.md](docs/verification.md)
