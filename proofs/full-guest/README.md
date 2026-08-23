# Exact full-guest native boot gate

This gate boots the finished files in `guest/dist` directly. It does not
rebuild the image, mount or modify the ext4 filesystem, or substitute a mock
desktop.

The runner first streams and verifies every artifact against both
`guest-manifest.json` and `SHA256SUMS`. Native QEMU then launches the exact
`vmlinuz-linux`, `initramfs-linux.img`, and `rootfs.ext4` with `-snapshot`, the
reviewed 1536 MiB/two-vCPU native profile (the guest's recommended memory), a
named read-only diagnostics channel, and a QMP control socket. It waits for the
guest-authored `OMARCHY_GUEST_REPORT`, captures the live 1600×900 framebuffer,
uses the real Super+Return binding to open Foot, sends auditable explicit
key-down/key-up transitions for terminal-originated `id` commands, requires
the resulting `uid=1000(omarchy)` identity both in Foot's visible output and
independently on the named diagnostics port, captures the opened and typed-in
terminal framebuffers, and quits through QMP.

`validate.mjs` fails closed unless all of the following agree:

- every input remains a regular file with its declared size and SHA-256 before
  and after the run;
- the strictly parsed recorded launch command independently proves the QEMU
  machine, 1536 MiB/two-vCPU shape, exact kernel/initramfs/rootfs, `-snapshot`,
  reviewed kernel line, and absence of any NIC or network backend;
- the kernel serial log shows x86_64 Linux and systemd reaching the booted Arch
  system without a panic or emergency target;
- the authentic report matches the pinned Basecamp Omarchy repository, commit,
  version, normalized tree, x86_64 Arch/Wayland identity, live Hyprland and
  Quickshell processes, successful guest commands, and a single active
  1600×900 monitor;
- QMP records the exact `id` input sequence after invoking Omarchy's Foot
  binding, and the resulting desktop-user identity output is captured;
- all four required QEMU screendumps are
  real, nonblank 1600×900 P6 images, and opening Foot changes visible pixels;
- the synchronized pre-submit and completed Foot frames differ by at least
  0.0005 of the whole framebuffer using only Foot's interior terminal region;
- QMP records the exact ordered sequence status → base frame → Super+Return →
  opened frame → command → typed baseline → one or two Enter attempts → final
  frame → graceful `quit`, with no unreviewed actions; and
- QEMU exits cleanly and no launched process survives teardown.

Run on macOS with Homebrew QEMU:

```sh
SMOKE_TIMEOUT_SECONDS=1800 proofs/full-guest/run.sh
```

Evidence is placed in a fresh timestamped directory below
`proofs/full-guest/evidence/`; `latest.txt` names the newest completed run. The
large screendumps and machine logs are intentionally ignored by Git.

This proves the exact finished guest can boot and render natively through
QEMU's virtio devices. It does not prove the Emscripten SDL/OffscreenCanvas
bridge, browser performance, or client-side ranged disk adapter; those remain
separate browser gates.
