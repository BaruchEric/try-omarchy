# Omarchy native ARM64 helper

This helper is the fast Apple Silicon path. It boots `guest/dist-aarch64` with
Apple's Virtualization.framework: ARM instructions execute directly on Apple
Silicon, while storage, graphics, keyboard, pointer, entropy, serial, and memory
balloon devices use Apple's Virtio implementations. It does not contain QEMU or
an x86 translator.

The first launch is a native cold boot. After the guest emits the exact pinned
Quattro authenticity report, the helper pauses it, APFS-clones its disk, saves a
host-bound encrypted VM state, and resumes it. Later launches restore that pair.
The cache identity is the SHA-256 of `guest-manifest.json`; any guest update gets
a new state and cannot consume an old disk/memory pair.

Build, test, and ad-hoc sign with the required entitlement:

```bash
cd native/macos
swift test
swift build -c release
codesign --force --sign - \
  --entitlements omarchy-vm-helper.entitlements \
  .build/release/omarchy-vm-helper
```

Inspect capabilities and verify the complete guest bundle before launching:

```bash
.build/release/omarchy-vm-helper --capabilities
.build/release/omarchy-vm-helper --validate ../../guest/dist-aarch64
.build/release/omarchy-vm-helper --run ../../guest/dist-aarch64
```

Use `--no-resume` only for a deliberate cold-boot proof. Save states are tied by
Virtualization.framework to the Mac that created them and are never distributable
release artifacts.
