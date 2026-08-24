# Architecture

Try Omarchy is a native macOS launcher around an ARM64 Linux virtual machine.
There is no web server, browser runtime, JavaScript application, or x86 guest.

```text
Try Omarchy.app
├── Swift/AppKit launcher
├── signed QEMU ARM64 runtime
│   ├── HVF acceleration
│   ├── Cocoa + VirGL display
│   ├── SLIRP networking
│   └── SDL audio
└── compressed ARM64 factory guest
    ├── Arch Linux ARM
    ├── pinned Omarchy source tree
    └── first-boot owner provisioning
```

## Build boundaries

- `guest/` reproducibly assembles the unprovisioned ARM64 image in a privileged
  ARM64 Docker container. Inputs are commit-, version-, and checksum-pinned.
- `macos/` builds the Swift launcher and a patched QEMU runtime. The runtime is
  isolated, relocated, and signed before it enters the app bundle.
- `dist/` is the only public output directory. It is generated and ignored by
  Git.

## Runtime boundaries

The Swift helper owns app lifecycle, permissions, host audio-device discovery,
and focused Command-key handling. QEMU owns virtualization, networking, graphics,
and the emulated audio transport. The guest audio bridge mirrors only the host
audio catalog and selection over a dedicated virtio serial port.

The shipped image has no baked-in user. Omarchy's upstream owner-provisioning
flow creates the account on first boot. The app clones and expands the source
disk into the user's Application Support directory; the packaged source remains
immutable. An explicit ephemeral mode bypasses persistence.

## Trust model

The app validates the exact guest file set, JSON schemas, hashes, sizes, pinned
upstream identity, runtime contract, kernel command line, architecture, and
factory profile before QEMU starts. It also verifies the app signature and
required QEMU features. Updates to a pinned dependency should update its digest,
contract tests, notices, and review evidence together.
