# Native Mac VM

This is Try Omarchy's accelerated Apple Silicon runtime. It boots the real
ARM64 Quattro guest from `guest/dist-aarch64` in QEMU with:

- HVF hardware virtualization and the host ARM CPU;
- Virtio GPU rendering through VirGL, ANGLE, and Metal;
- a patched Cocoa window that publishes live Retina backing size, screen, and
  refresh rate to the guest;
- an unprivileged SLIRP network behind a Virtio Ethernet adapter;
- SDL speaker and microphone I/O behind a duplex virtual HDA device;
- a manifest-keyed persistent APFS disk clone; and
- a signed app that owns microphone permission and maps focused Mac Command to
  guest Super.

This runtime is distinct from the fully client-side x86_64 QEMU/WebAssembly
Browser VM. It is a local Mac app, optimized for the closest practical native
Omarchy experience.

## Requirements

- Apple Silicon (`arm64`)
- macOS 15 or newer
- Homebrew with the exact `libslirp` 4.9.2 and SDL2 2.32.10 development files,
  plus GLib and Pixman
- a complete verified `guest/dist-aarch64` bundle

The preparation script sets `HOMEBREW_NO_AUTO_UPDATE=1`. It checks dependencies
but does not tap, install, link, upgrade, or auto-update Homebrew formulae.

## Prepare and run

Build the pinned QEMU/VirGL stack, apply the dynamic-display patch, stage its
runtime, build the Swift launcher, and ad-hoc sign both pieces:

```sh
npm run omarchy:native:prepare
```

Launch the normal persistent VM:

```sh
npm run omarchy:native
```

The first launch may ask for two macOS permissions:

- **Accessibility** lets **Omarchy Quattro** capture Command only while its QEMU
  window is focused and translate it to guest Super.
- **Microphone** lets software inside the guest record host audio input. If it
  is denied, speaker playback still works and only guest recording is disabled.

The launcher starts fullscreen. Press Control-Option-F to toggle into a freely
resizable window and back. Closing QEMU powers off that session cleanly.

For an intentionally throwaway disk or a clean clone of the current verified
ARM image:

```sh
npm run omarchy:native:ephemeral
npm run omarchy:native:reset
```

`omarchy:native:reset` replaces only the persistent disk selected by the
current guest manifest. It does not delete other guest versions.

## Boot and persistence model

Every launch is an ordinary guest cold boot. The runtime does not distribute or
restore a memory snapshot, so it must not be described as sub-second resume.
Performance after boot comes from executing ARM code through HVF and rendering
through Metal rather than emulating x86 instructions.

By default, the launcher APFS-clones the verified `rootfs.ext4` on first use and
then reopens that clone on later runs. Guest files, settings, packages, and user
work therefore survive close/reopen. Persistent data lives under:

```text
~/Library/Application Support/OmarchyVMHelper/QEMU/v1/disks/<manifest-sha256>
```

The source image is 6 GiB logically, but an APFS clone normally consumes little
additional physical space until blocks change. The directory identity binds the
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
VirGL/ANGLE patches and this repo's Cocoa dynamic-display patch, and validates
the resulting capabilities. QEMU is ARM64/HVF-only and includes Cocoa/VirGL,
SLIRP, and SDL audio. VirGL, ANGLE, and libepoxy dylibs are isolated in the
staged runtime; the checked Homebrew core dependencies remain locally linked.

All downloaded archives and build wheels are immutable and SHA-256 pinned.
They are copied into private scratch space and verified before extraction.
Scratch sources are removed on success, failure, or interruption, and staging
is atomic. An optional local archive cache can be passed directly to the build
script for an offline replay; cache contents are still re-verified.

`build-app.sh` compiles the Swift launcher, creates
`native/macos/.build/Omarchy Quattro.app`, installs its Info.plist, and ad-hoc
signs it with the microphone entitlement. Runtime preparation separately signs
QEMU with the Hypervisor and audio-input entitlements. Both signatures are
strictly verified before launch.

These are repo-local developer artifacts, not a notarized downloadable app.
Ad-hoc signing is appropriate for this local experiment but a distributed build
should use a stable Developer ID, hardened runtime, dependency bundling, and
notarization.

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

- If the launcher reports a missing staged runtime or app, run
  `npm run omarchy:native:prepare`.
- If Command shortcuts reach macOS, grant Accessibility access to **Omarchy
  Quattro**, quit the VM, and run `npm run omarchy:native` again.
- If guest recording is unavailable after denying the prompt, enable Microphone
  access for **Omarchy Quattro** in System Settings and relaunch.
- If a persistent guest change is unwanted, use
  `npm run omarchy:native:reset`. Use `omarchy:native:ephemeral` when testing
  without modifying saved guest state.
- If a guest update should coexist with existing work, leave the older
  manifest-keyed directory intact; the new verified manifest automatically
  selects a separate disk.
