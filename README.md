# Try Omarchy in your browser

This project runs a pinned build of the real
[Basecamp Omarchy](https://github.com/basecamp/omarchy) desktop inside a
client-side x86_64 virtual machine. It is a short, disposable product demo: the
browser renders QEMU's guest framebuffer, forwards keyboard and pointer input
to the VM, and discards all changes when the session is reset or closed.

The desktop is not recreated with HTML or streamed from a server. The guest is
Arch Linux booting Hyprland, Quickshell, Omarchy's commands, configuration, and
themes from upstream commit
`f0020448ca87329199de7cb12f2015ebc4a3e5e7`.

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
```

Then boot the exact local guest through the production paged Worker without
copying the 6 GiB raw disk:

```sh
make -C runtime serve-full
```

Open `http://127.0.0.1:8094/` in a current Chromium browser. The local server
supplies COOP/COEP isolation, synthesizes a verified combined manifest, refuses
full rootfs reads, and records range requests at `/__requests`.

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
