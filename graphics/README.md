# Native graphics compatibility gate

This directory answers one narrow question before browser integration: can the
pinned Omarchy desktop run on the same guest-facing display stack planned for
QEMU-Wasm?

It builds an x86_64 Arch guest with the real pinned Omarchy source tree, exact
resolved Hyprland and Quickshell packages, the stock Arch kernel, virtio-gpu
DRM/KMS, and Mesa llvmpipe. Native QEMU boots it at 1600x900, starts the real
Omarchy Hyprland Lua configuration and Omarchy Quickshell QML, opens a real Foot
client, records guest evidence over the serial port, and captures QEMU's guest
framebuffer. No HTML desktop or screenshot substitute is involved.

## Reproducible inputs

`versions.lock.json` pins:

- Omarchy `f0020448ca87329199de7cb12f2015ebc4a3e5e7` (`4.0.0.alpha`);
- the amd64 Arch builder image digest;
- Linux, Hyprland, Aquamarine, Mesa, llvmpipe, Qt, and `quickshell-git`;
- QEMU's `pc-q35-8.2` machine, matching the QEMU 8.2 base of the pinned
  QEMU-Wasm fork.

The pinned Omarchy commit names packages but does not freeze Arch package
versions. The lock records the concrete versions resolved from Omarchy's stable
repositories on 2026-08-14, and the build fails if those repositories resolve a
different primary graphics package.

## Run the gates

Requirements: Docker, `jq`, native `qemu-system-x86_64`, and the inspected
Omarchy checkout at `/private/tmp/omarchy-source-inspected`.

```sh
make -C graphics test
make -C graphics build
make -C graphics run
```

The first build downloads about a desktop guest's worth of Arch packages. On
an Apple Silicon host the x86_64 VM uses TCG, so the native smoke can take many
minutes. Override the wait with `SMOKE_TIMEOUT_SECONDS=1800` when necessary.

A pass requires all of these facts from one guest run:

- `uname -m` is `x86_64`;
- `/dev/dri/card0` is bound to `virtio_gpu`;
- Hyprland reports a 1600x900 enabled monitor;
- Mesa reports `llvmpipe` or its `swrast` EGL driver;
- the locked Hyprland process is live;
- the locked Quickshell process answers the real Omarchy shell IPC `ping`;
- Foot is a real Hyprland client;
- QEMU exports a 1600x900 PPM framebuffer.

Evidence is written under `graphics/out/evidence/`: `command.txt`, kernel
`serial.log`, dedicated `guest-evidence.log`, `qemu.log`, `desktop.ppm`,
optional `desktop.png`, build metadata, and SHA-256 files. Kernel/system output
uses ttyS0; the unprivileged compositor probe uses a named virtio-serial port at
`/dev/virtio-ports/org.omarchy.evidence`, with an explicit guest udev rule, so a
serial getty cannot consume or change ownership of the evidence channel.

## Reviewable guest changes

The guest copies the pinned `config/`, `default/`, `shell/`, themes, and scripts
verbatim. It applies only one desktop configuration override:

1. `overrides/monitors.lua` fixes the virtual output to 1600x900 at scale 1.

The login wrapper starts a read-only probe after discovering Hyprland's live
control and Wayland sockets. This instrumentation does not alter Omarchy's
autostart configuration. The compositor itself starts through Omarchy's exact
upstream UWSM command and environment fragment, so its D-Bus and systemd user
session match the installed desktop rather than an ad-hoc compositor launch.

The session additionally forces `LIBGL_ALWAYS_SOFTWARE=1` and
`GALLIUM_DRIVER=llvmpipe`. Hardware services are not needed for this gate.

## What a pass does and does not prove

A pass proves the Arch kernel, virtio-gpu 2D DRM/KMS, Mesa software EGL,
Hyprland/Aquamarine, and the pinned Omarchy Quickshell can work together at the
target resolution. Those guest-facing devices and command-line arguments exist
in the pinned QEMU-Wasm source.

It does **not** prove that the Emscripten QEMU build succeeds, that SDL copies
dirty scanout regions correctly into an OffscreenCanvas, or that browser input
and performance pass. The browser run remains a separate gate; native success
removes guest graphics compatibility as the first unknown, not the browser
display bridge itself.
