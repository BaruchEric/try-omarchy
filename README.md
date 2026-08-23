# Try Omarchy

Try Omarchy exposes the real
[Basecamp Omarchy](https://github.com/basecamp/omarchy) Quattro desktop in two
deliberately separate products:

1. **Browser VM** — a fully client-side x86_64 QEMU/WebAssembly VM. The web
   page runs the guest CPU, renders its framebuffer, forwards input, and keeps
   temporary disk writes in the browser. It requires no installed VM or remote
   streaming service, but x86 emulation is inherently slower than native code.
2. **Native Mac VM** — an ARM64 QEMU VM for Apple Silicon. HVF executes guest
   ARM instructions with hardware virtualization; VirGL renders through
   ANGLE/Metal. It adds a dynamic Retina display, persistent storage, host
   networking, duplex audio, and focused Mac Command-to-guest-Super input.

The landing page and `/browser` route are the web entry points. Neither runtime
is an HTML imitation of the desktop: both boot Arch Linux, Hyprland,
Quickshell, and the upstream Omarchy commands, configuration, and themes pinned
at commit `7488eaded43de68ff9d2d7e4bf50cd48e112eb0f` (Quattro
`4.0.0.alpha`).

## Browser VM

```text
Browser page
  └─ isolated iframe
       └─ module Worker + OffscreenCanvas
            └─ x86_64 QEMU 8.2 compiled with Emscripten/SDL2
                 ├─ verified kernel and initramfs
                 ├─ demand-paged read-only ext4 base over HTTP ranges
                 ├─ temporary QEMU snapshot writes
                 └─ real Omarchy/Hyprland/Quickshell guest
```

The fixed guest display is 1600×900. Readiness requires a guest-originated
authenticity report followed by a newer QEMU framebuffer event; merely loading
WebAssembly or drawing a placeholder cannot satisfy it.

Large immutable artifacts use versioned release paths. The paged-disk adapter
accepts only bounded, identity-pinned byte ranges and rejects a full root disk
response. QEMU runs with snapshot writes, so closing or resetting the browser
session leaves the verified base image unchanged.

Start the local browser runtime:

```sh
npm run omarchy:browser
```

Open `http://127.0.0.1:8094/web/full-guest.html` in a current Chromium browser.
The loopback process only verifies and serves local artifacts with the required
COOP/COEP headers; VM execution, display, input, and temporary writes remain on
the client.

## Native Mac app

The downloadable **Omarchy Quattro** app is a self-contained Apple Silicon
virtual Mac for macOS 15 or newer. Open its DMG, drag the app to Applications,
and launch it like any other Mac app. It does not require Homebrew, Python,
QEMU, a container runtime, or an existing Omarchy installation.

The first launch expands the signed factory image, then boots directly into
Quattro's real owner setup. Keyboard, account, hostname, timezone, packages,
files, and every later setting persist across app relaunches. A small native
startup window remains visible while the first image is prepared.

Developers need the exact Homebrew build dependencies checked by the
preparation script. Build the pinned runtime and self-contained app:

```sh
npm run omarchy:native:prepare
```

Launch the built app:

```sh
npm run omarchy:native
```

Create the standard drag-to-Applications DMG:

```sh
npm run omarchy:native:package
```

The guest cold-boots on every launch. Its manifest-keyed, sparse 24 GiB root
disk persists, so files, installed software, and settings survive closing and
reopening the app; there is no claim of instant memory-snapshot resume. The
repo-local developer launcher also supports a throwaway boot or reset:

```sh
npm run omarchy:native:ephemeral
npm run omarchy:native:reset
```

The distributed app uses `guest/dist-aarch64-unprovisioned` by default. The
repo-local comparison command remains available and intentionally disposable:

```sh
npm run omarchy:native:factory
```

The app's copy starts Quattro's own first-boot owner setup with no preset
account, theme, demo menu, welcome notification, or completed setup markers.
Unlike the comparison command, the app keeps the completed setup and all later
changes.

The Cocoa window starts fullscreen and can switch to a freely resizable window
with Control-Option-F. The patched display path reports backing-pixel size,
Retina scale changes, the active screen, and its refresh rate to the Virtio GPU
when the window is resized, moved, or toggled fullscreen.

Networking uses QEMU's unprivileged SLIRP backend and appears as a Virtio
Ethernet adapter inside Omarchy. SDL provides speaker playback and microphone
capture through the virtual HDA device. Omarchy's own Audio panel lists every
Mac speaker and microphone, refreshes when host hardware changes, and switches
routes without restarting the VM. **Mac System Default** follows macOS, and
explicit device choices persist across relaunches and guest resets. macOS
asks for Microphone permission for the signed launcher app; denying it leaves
playback available but disables guest recording. Accessibility permission is
used only by the focused input bridge so Mac Command acts as Omarchy Super
without leaking the shortcut to macOS. Physical Option remains guest Alt.

See [native/macos/README.md](native/macos/README.md) for the native runtime's
architecture, persistence rules, permissions, and security boundaries.

## Landing page development

Node.js 22.13 or newer is required.

```sh
npm ci
npm test
npm run dev
```

The launcher reports missing VM artifacts honestly. It never substitutes a
screenshot, prerecorded session, streamed VM, or recreated desktop.

## Repository map

- `app/`: landing page and browser launcher UI.
- `public/vm/`: isolated Browser VM host page and client assets.
- `runtime/`: pinned x86_64 QEMU-Wasm build, Worker, display/input bridge,
  browser harness, and artifact verification.
- `storage/`: fail-closed synchronous paged-disk adapter for Emscripten Workers.
- `guest/`: reproducible x86_64 Browser VM and ARM64 Native Mac VM images.
- `native/macos/`: pinned QEMU/HVF/VirGL runtime, signed launcher, persistent
  disk lifecycle, dynamic display patch, audio/network setup, and input bridge.
- `worker/`: strict immutable range delivery for published Browser VM artifacts.
- `distribution/` and `release/`: notices, corresponding-source evidence, SBOM,
  and digest-verified release assembly.
- `scripts/verification/`, `proofs/`, and `docs/`: schemas, stop-ship gates, and
  end-to-end evidence.

## Build and verify the Browser VM

Build the x86_64 guest in the supplied privileged Arch container and verify its
artifacts:

```sh
./guest/test
./guest/build-container.sh --output "$PWD/guest/dist"
(cd guest/dist && shasum -a 256 -c SHA256SUMS)
```

Build and validate the QEMU-Wasm runtime:

```sh
make -C runtime audit
make -C runtime test
QEMU_WASM_SOURCE=/private/tmp/qemu-wasm-source BUILD_JOBS=4 \
  runtime/scripts/build-qemu-wasm.sh
make -C runtime verify-dist
make -C runtime package GUEST_DIR=../guest/dist
```

The browser server then uses the same production paged Worker without copying
the 6 GiB logical root disk:

```sh
npm run omarchy:browser
```

## Authenticity and release discipline

The guest build pins the upstream commit, normalized source tree digest,
package transaction, virtual hardware contract, and output hashes separately
for x86_64 and ARM64. `provenance.json`, `guest-manifest.json`, and
`SHA256SUMS` bind the installed payload to the artifacts consumed by each
runtime. Runtime preparation checksum-verifies pinned sources and patches
before building or staging them.

Public Browser VM artifacts are immutable and identity-addressed. The release
gates require same-run guest identity, framebuffer, input, desktop behavior,
display/performance evidence, package notices, SBOM, and corresponding modified
emulator source. Engineering checks do not imply trademark clearance; public
use of the Omarchy name or logo still requires human approval.

Focused documentation:

- [guest/README.md](guest/README.md)
- [native/macos/README.md](native/macos/README.md)
- [runtime/README.md](runtime/README.md)
- [storage/README.md](storage/README.md)
- [distribution/README.md](distribution/README.md)
- [release/README.md](release/README.md)
- [docs/verification.md](docs/verification.md)
