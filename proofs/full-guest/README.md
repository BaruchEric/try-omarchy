# Exact full-guest native boot gate

This gate boots the finished files in `guest/dist` directly. It does not use
the smaller guest assembled by `graphics/`, rebuild the image, mount or modify
the ext4 filesystem, or substitute a mock desktop.

The runner first streams and verifies every artifact against both
`guest-manifest.json` and `SHA256SUMS`. Native QEMU then launches the exact
`vmlinuz-linux`, `initramfs-linux.img`, and `rootfs.ext4` with `-snapshot`, the
same 1536 MiB/two-vCPU/virtio guest-facing shape planned for the browser, a
named read-only diagnostics channel, and a QMP control socket. It waits for the
guest-authored `OMARCHY_GUEST_REPORT`, captures the live 1600×900 framebuffer,
uses the real Super+Return binding to open Foot, types a terminal-originated
command, captures the opened and typed-in terminal framebuffers, and quits
through QMP.

`validate.mjs` fails closed unless all of the following agree:

- every input remains a regular file with its declared size and SHA-256 before
  and after the run;
- the kernel serial log shows x86_64 Linux and systemd reaching the booted Arch
  system without a panic or emergency target;
- the authentic report matches the pinned Basecamp Omarchy repository, commit,
  version, normalized tree, x86_64 Arch/Wayland identity, live Hyprland and
  Quickshell processes, successful guest commands, and a single active
  1600×900 monitor;
- QMP records the exact `id` input sequence after invoking Omarchy's Foot
  binding, and the resulting desktop-user identity output is captured;
- all three QEMU screendumps are real, nonblank 1600×900 P6 images, and opening Foot
  changes visible pixels;
- QMP records capabilities, status, keyboard events, both screendumps, and a
  graceful `quit`; and
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
