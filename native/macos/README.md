# Native Mac VM

This is Try Omarchy's downloadable Apple Silicon app. It boots the real
unprovisioned ARM64 Quattro guest in a self-contained QEMU runtime with:

- HVF hardware virtualization and the host ARM CPU;
- Virtio GPU rendering through VirGL, ANGLE, and Metal;
- a patched Cocoa window that publishes live Retina backing size, screen, and
  refresh rate to the guest;
- an unprivileged SLIRP network behind a Virtio Ethernet adapter;
- SDL speaker and microphone I/O behind a duplex virtual HDA device;
- live host audio-device mirroring in Omarchy's own PipeWire panel;
- a compressed signed factory image and manifest-keyed persistent APFS clone;
- a normal drag-to-Applications DMG with a native startup state; and
- a signed app that owns microphone permission and maps focused Mac Command to
  guest Super.

This runtime is distinct from the fully client-side x86_64 QEMU/WebAssembly
Browser VM. It is a local Mac app, optimized for the closest practical native
Omarchy experience.

## End-user requirements

- Apple Silicon (`arm64`)
- macOS 15 or newer
- enough free space for the 1.1 GiB download and roughly 6 GiB initial guest
  data; the 24 GiB virtual disk is sparse and grows as Omarchy uses it

The installed app has no Homebrew, Python, QEMU, Docker, or command-line-tools
dependency. QEMU, VirGL/ANGLE/Metal, SDL, SLIRP, GLib, Pixman, Zstandard, and
their non-system dynamic-library closure are signed inside the app.

## Install and first launch

Open the DMG, drag **Try Omarchy** to Applications, and open it. On the first
launch, a short setup window explains Accessibility and Microphone access one
at a time. Each permission is optional and macOS only asks for it after the
person clicks its Allow button. After the person clicks **Launch Omarchy**, that
button shows launch progress while the signed compressed factory image is
expanded and verified. The setup window closes when the VM is ready. Omarchy
then presents its own owner setup for keyboard, account, hostname, timezone, and
the rest of the normal setup flow.

Closing the QEMU window ends the current cold-boot session. Opening the app
again boots the same disk: the owner account, settings, files, installed
packages, and completed setup all remain.

## Developer requirements

- Homebrew with the exact `libslirp` 4.9.2 and SDL2 2.32.10 development files,
  plus GLib, Pixman, and Zstandard
- a complete verified `guest/dist-aarch64-unprovisioned` bundle

The preparation script sets `HOMEBREW_NO_AUTO_UPDATE=1`. It checks dependencies
but does not tap, install, link, upgrade, or auto-update Homebrew formulae.

## Prepare and run

Build the pinned QEMU/VirGL stack, apply the patches, bundle every non-system
runtime dependency and the compressed factory guest, build the Swift launcher,
and ad-hoc sign the local app:

```sh
npm run omarchy:native:prepare
```

Launch it:

```sh
npm run omarchy:native
```

The first-launch setup offers two macOS permissions:

- **Accessibility** lets **Try Omarchy** capture Command only while its QEMU
  window is focused and translate it to guest Super.
- **Microphone** lets software inside the guest record host audio input. If it
  is denied, speaker playback still works and only guest recording is disabled.

Accessibility is optional and never blocks the VM from starting. If macOS does
not recognize the grant until the app is relaunched, Omarchy continues without
Command-to-Super mapping for that session. Enable **Try Omarchy** in
Accessibility settings and the mapping becomes available on a later launch.
Microphone access is not requested during startup or when the permission is
skipped.

The launcher starts fullscreen. Press Control-Option-F to toggle into a freely
resizable window and back. Closing QEMU powers off that session cleanly.

While the VM is running, open Omarchy's Audio panel from its top bar or with
Super-Control-A. Its output and input lists include **Mac System Default** and
every currently connected Mac speaker or microphone. The list updates when
CoreAudio hardware appears, disappears, or changes, and choosing a route takes
effect without restarting Omarchy. Selections retain stable CoreAudio identities
and survive app relaunches and guest-storage resets.

Create a compressed DMG with a minimal, pre-arranged drag-to-Applications
installer window:

```sh
npm run omarchy:native:package
```

For a public build, pass a Developer ID Application identity and a configured
`notarytool` keychain profile directly to `build-app.sh`:

```sh
native/macos/build-app.sh \
  --sign-identity 'Developer ID Application: Example (TEAMID)' \
  --notarize-profile omarchy-release
```

The script signs nested libraries and executables inside-out with the hardened
runtime, notarizes and staples the app, then notarizes and staples the DMG.

The repo-local developer launcher still supports an intentionally throwaway
disk or reset:

```sh
npm run omarchy:native:ephemeral
npm run omarchy:native:reset
```

`omarchy:native:reset` replaces only the persistent disk selected by the
current guest manifest. It does not delete other guest versions.

For the separate factory-state comparison image:

```sh
npm run omarchy:native:factory
```

That comparison command remains ephemeral. The distributed app uses the same
factory artifact persistently: it stores the completed owner setup and all
later work. Its 6 GiB verified source is APFS-cloned and sparsely extended to
24 GiB before the first boot, so setup and the updater have working room without
making the download or initial physical allocation 24 GiB.

## Boot and persistence model

Every launch is an ordinary guest cold boot. The runtime does not distribute or
restore a memory snapshot, so it must not be described as sub-second resume.
Performance after boot comes from executing ARM code through HVF and rendering
through Metal rather than emulating x86 instructions.

The app ships `rootfs.ext4.zst`, not the 6 GiB raw disk. On first use it expands
and SHA-256-verifies one private immutable source, APFS-clones that source into
a 24 GiB sparse workspace, and reopens the workspace on later runs. Guest
files, settings, packages, and user work therefore survive close/reopen.
Persistent data lives under:

```text
~/Library/Application Support/Omarchy/QEMU/v1/disks/<manifest-sha256>
```

The immutable source is 6 GiB logically. Its APFS clone normally shares those
blocks until the guest changes them; sparse expansion does not allocate 24 GiB
up front. The directory identity binds the
exact `guest-manifest.json` digest, source-disk digest and size, and storage
schema. A changed guest bundle receives a separate disk instead of silently
migrating an older one.

An advisory lock prevents two QEMU processes from writing the same disk. The
lock file descriptor is inherited by QEMU itself, so killing only the launcher
cannot release protection while the VM remains alive.

Each launch also owns a private `omarchy-qemu-gpu.*` control directory. Normal
shutdown removes it without touching persistent guest data. A later launch
reclaims only an exact current-format marker owned by the current user, mode
`0700`, after proving neither its recorded launcher nor QEMU process is alive.
Unknown and legacy directories are deliberately left alone.

## Dynamic display

The repo patch preserves the VirGL/ANGLE/Metal renderer and extends QEMU Cocoa's
UI information path. It reports:

- the window's actual backing pixels rather than logical Cocoa points;
- the active screen's refresh period, with a maximum-frames-per-second fallback;
- screen and backing-scale changes when moving between monitors; and
- mode changes after window resize and fullscreen transitions.

QEMU sends this information through Virtio GPU EDID so Omarchy can select a
matching guest mode. The initial fullscreen mode uses the current display's
usable Retina dimensions and refresh rate. The window remains zoom-to-fit while
the guest applies a newly advertised mode, avoiding a stale fixed-resolution
surface during transitions.

## Network and audio

The VM uses QEMU's `-netdev user` SLIRP backend. Inside Omarchy it appears as a
normal Virtio Ethernet device and NetworkManager can obtain DHCP, a default
route, DNS, and outbound internet access. This is host-backed networking, not a
passthrough Wi-Fi radio; it needs no root privileges, TAP device, or host
network extension.

QEMU's SDL audio backend connects an Intel HDA controller and `hda-micro` codec
to macOS. PipeWire/WirePlumber inside the guest receives an analog stereo sink
for playback and a source for recording. The stable
`dev.tryomarchy.native` app bundle is the macOS-responsible process for the
microphone request and contains `NSMicrophoneUsageDescription` plus the signed
audio-input entitlement.

The app preflights microphone access before starting QEMU. A denied or
restricted decision is reported clearly but does not block the VM, networking,
or playback.

Host audio choices are stored by stable CoreAudio UID in the app's versioned
`UserDefaults` record, independently of guest disks. They therefore survive app
relaunches, guest storage resets, and guest-image updates. If a saved device is
temporarily disconnected, routing falls back to System Default until it returns.

The signed helper watches CoreAudio and exchanges a strict JSON-lines catalog
with a guest user service over a private named Virtio serial port. That service
mirrors endpoints as PipeWire sinks and sources, so the stock Quattro audio
panel remains the only chooser. Route selections are atomically published in
the run's private control directory; the patched SDL backend reopens only the
affected stream while QEMU and the guest keep running. The transport HDA nodes
stay hidden from the panel and continue carrying the selected virtual route.

## Focused Command-to-Super bridge

QEMU Cocoa normally reserves ungrabbed macOS Command shortcuts. The launcher
creates a private QMP socket, then starts the signed bridge against the exact
QEMU PID. While that process is the frontmost app with a focused window, the
bridge:

- suppresses the host Command chord;
- injects left or right guest Meta through QMP;
- forwards the rest of the chord only to QEMU; and
- releases captured keys on focus loss or termination.

It does nothing when any other application is focused. Physical Option remains
guest Alt. The QMP socket's parent must be current-user-owned mode `0700`, the
socket must have the same owner, and the bridge validates both before sending
input. If the bridge exits unexpectedly, the launcher terminates QEMU rather
than leaving an unmodified Command path behind.

## Reproducible runtime and signing

`build-qemu-gpu-runtime.sh` builds QEMU 10.2.50 from pinned commit
`cf3e71d8fc8ba681266759bb6cb2e45a45983e3e`, applies checksum-pinned upstream
VirGL/ANGLE patches plus this repo's Cocoa dynamic-display and direction-aware
SDL audio patches, and validates the resulting capabilities. QEMU is
ARM64/HVF-only and includes Cocoa/VirGL, SLIRP, and SDL audio. VirGL, ANGLE, and
libepoxy dylibs are isolated in the staged developer runtime. The app packaging
step copies and relocates the complete non-system dependency closure, so the
installed app has no Homebrew paths.

All downloaded archives and build wheels are immutable and SHA-256 pinned.
They are copied into private scratch space and verified before extraction.
Scratch sources are removed on success, failure, or interruption, and staging
is atomic. An optional local archive cache can be passed directly to the build
script for an offline replay; cache contents are still re-verified.

`build-app.sh` compiles the Swift launcher, creates
`native/macos/.build/Try Omarchy.app`, embeds the launch contract, icon,
factory guest, QEMU runtime, decoder, scripts, and full non-system dylib closure,
then signs nested code inside-out. Local builds use ad-hoc signing. Release
builds support a stable Developer ID, hardened runtime, notarization, stapling,
and a compressed DMG.

## Verification

Fast Swift and storage lifecycle tests:

```sh
cd native/macos
swift test
./Tests/qemu-persistent-storage.test.sh
```

The normal preparation command performs the runtime build, capability checks,
relocation checks, signature verification, and app build:

```sh
npm run omarchy:native:prepare
```

The launcher then fail-closes on an unsafe path, wrong architecture, missing or
unexpected manifest role, digest/size mismatch, unsupported QEMU feature,
invalid signature, unsafe persistent state, or concurrent writer. It verifies
the guest and runtime before creating the QEMU process.

## Troubleshooting

- If a developer build reports a missing staged runtime or app, run
  `npm run omarchy:native:prepare`.
- If Command shortcuts reach macOS, grant Accessibility access to **Try
  Omarchy**, quit the VM, and run `npm run omarchy:native` again.
- If guest recording is unavailable after denying the prompt, enable Microphone
  access for **Try Omarchy** in System Settings and relaunch.
- If a persistent guest change is unwanted, use
  `npm run omarchy:native:reset`. Use `omarchy:native:ephemeral` when testing
  without modifying saved guest state.
- If a guest update should coexist with existing work, leave the older
  manifest-keyed directory intact; the new verified manifest automatically
  selects a separate disk.
