# Omarchy preboot-resume proof

This proof tests a cold-boot bypass without rebuilding or modifying the finished
guest. It compiles native QEMU 8.2.0 from the exact `qemu-wasm` commit pinned by
`runtime/upstream.lock.json`, boots the exact files in `guest/dist`, waits for
the authentic `OMARCHY_GUEST_REPORT`, and saves a QEMU migration stream only
after Hyprland and Quickshell report one live 1600×900 output.

The source QEMU then exits. A fresh process with the same QEMU binary, machine
version, RAM, vCPU topology, virtio devices, kernel, initramfs, command line,
and root filesystem consumes the stream through `-incoming file:`. The proof
does not pass merely because QEMU reports `running`: it captures resumed
1600×900 pixels, invokes Omarchy's real Super+Return binding, opens Foot, and
types a command that must return `uid=1000(omarchy)` through the guest's named
virtio diagnostics port.

The browser-relevant default deliberately disables QEMU's internal migration
compression. A fresh target can therefore consume the raw stream immediately
with CLI `-incoming file:` and needs no pre-main QMP control channel—which the
current production Worker does not expose. The proof also measures an external
gzip copy for storage comparison, but QEMU consumes the raw, range-pageable
file.

`PREBOOT_MIGRATION_COMPRESSION=legacy` retains a native diagnostic mode. It
starts the destination with `-incoming defer`, configures matching compression
over QMP, then calls `migrate-incoming` with the `file:` URI. That mode proves
QEMU's compressed stream mechanism only and is explicitly not compatible with
the current browser startup contract.

## Why the checkpoint has two artifacts

A migration stream contains RAM and device state, but ordinary migration
assumes storage is shared. Omarchy writes to its root filesystem during boot.
Discarding QEMU's source `-snapshot` layer and loading only RAM against a fresh
rootfs overlay can therefore create a subtly inconsistent guest even if its
cached desktop initially renders.

The reproducible proof instead creates a qcow2 delta over the exact immutable
`rootfs.ext4`. Source boot writes land in that delta. Once the paused migration
stream is complete and the source process has exited, the delta becomes the
immutable `checkpoint-overlay.qcow2` artifact. The fresh target adds
`-snapshot` over it, so resumed interaction remains disposable. A production
browser path must likewise bind the vmstate and this disk delta to the exact
QEMU build, machine arguments, and guest manifest as one release.

## Run

Docker is used only to provide a reproducible x86_64 native build/run
environment on the arm64 development host. The first build derives a local
image from the existing pinned Wasm builder by adding Ubuntu's native Pixman
development package.

```sh
BUILD_JOBS=8 proofs/preboot-resume/build-pinned-qemu.sh
proofs/preboot-resume/run.sh
```

Before freezing RAM, the source must produce two consecutive clean 1600×900
framebuffers. The health gate rejects blank/wrong-size surfaces and Hyprland's
red configuration-error banner. Because Omarchy's valid idle framebuffer can
itself be almost uniformly dark, the source must also open Foot through the
real Super+Return binding, visibly change the framebuffer, and execute `id` as
uid 1000 through the named guest diagnostics port. The proof closes Foot,
requires the desktop to settle cleanly again, and only then pauses it for the
checkpoint. The resumed target repeats the pixel/input gate after all keyboard
modifiers are explicitly released.

The default uses the planned one-vCPU browser topology. To isolate and test the
migration mechanism with the older guest whose 30-second UWSM timeout is too
short under one-vCPU TCG, run the explicitly labeled topology-divergent mode:

```sh
PREBOOT_VCPUS=2 \
PREBOOT_PROOF_SCOPE=migration-mechanism-only \
proofs/preboot-resume/run.sh
```

That mode can prove checkpoint creation, fresh-process restore, rendering, and
post-resume interaction. It is deliberately rejected as browser-topology or
browser acceptance evidence.

## Bounded old-guest attempts are not acceptance

Two development runs on 2026-08-15 used the old guest artifact whose upstream
UWSM unit retained its 30-second compositor-start timeout:

- The planned one-vCPU shape was stopped fail-closed after roughly six minutes.
- The explicitly labeled two-vCPU mechanism shape was stopped fail-closed at
  its six-minute bound.

Both mounted the real root and reached a clean `ttyS0` login prompt, with no
QEMU stderr or kernel blocked-task report, but neither emitted the authenticated
`OMARCHY_GUEST_REPORT`. Consequently neither run created a vmstate, attempted
an incoming restore, or counts as migration, desktop, or browser acceptance.
Their ignored local evidence directories are diagnostic failure records only.
Those runs motivated the bounded 15-minute slow-TCG UWSM override. The later
corrected-guest results below supersede them, but remain negative.

## Current empirical result: no browser-ready checkpoint

The corrected canonical guest was tested from scratch on 2026-08-15. Every
attempt failed closed at a required quality or integration boundary:

- `20260815T035059Z-browser-1vcpu-raw-incoming-46541` used the exact planned
  QEMU 8.2 one-vCPU topology and the raw immediate-file design. It emitted the
  authentic report at guest monotonic 510,729 ms, but Hyprland's red Lua
  config-reload-timeout banner persisted throughout the 300-second clean-frame
  bound. Checkpoint and migration never started. The final 1600×900 frame had
  a 0.062832 top-alert-red ratio.
- `20260815T040545Z-qemu8-2vcpu-mttcg-ab` isolated a two-vCPU MTTCG candidate.
  It emitted the authentic report at 382,209 ms, 25.16% faster than the
  one-vCPU run, and had no red banner. However, 99.986% of its framebuffer was
  the same dark RGB(17,17,17), and acknowledged Super+Return input changed only
  0.0001028 of the Foot test region—below the 0.0005 gate—with no Foot window.
  This is a guest-quality/input failure, not a usable desktop or migration
  proof. Its `SHA256SUMS` verifies all 36 evidence files.
- `20260815T032947Z-browser-1vcpu-42678` is an earlier native compressed-stream
  diagnostic, captured before the source health gate was tightened. QEMU
  produced a 378,193,895-byte vmstate in 17,486 ms and a paired
  17,104,896-byte qcow2 delta. External gzip sizes were 352,654,688 and
  1,210,470 bytes, respectively. A fresh pinned-QEMU process subsequently
  loaded that stream through defer/QMP in 6,469 ms and reported both migration
  `completed` and VM `running`. This proves only that the paired compressed
  state is natively loadable: the checkpoint source already had the red
  banner, the restored framebuffer was 1600×960 rather than 1600×900, and
  post-restore Super+Return did not produce a working Foot session. The current
  Worker also has no pre-main QMP channel to configure decompression.

All directories above live under ignored `proofs/preboot-resume/evidence/` and
are diagnostic records, not browser acceptance artifacts. No run has yet
satisfied the complete source-health → checkpoint → exact fresh-process raw
restore → resumed-pixel/input chain, so there is no preboot bundle to ship.
Linux hibernation is not a useful fallback for the observed blocker: it would
freeze the same red-banner or noninteractive guest state, while adding a second
resume mechanism that still needs exact kernel, disk, and memory compatibility.
The next valid run starts only after an exact-QEMU source passes both clean
frame and real Foot/input gates.

`build-pinned-qemu.sh` fails closed unless the source is clean, is QEMU 8.2.0,
and matches commit `0ef7b4e2814b231705d8371dd7997f5b72e70baf`. It also assembles
the four locked QEMU subprojects from their already-audited checkouts. Native
QEMU uses its host-appropriate `ucontext` coroutine backend; guest-visible
devices and their QEMU 8.2 vmstate schemas come from the exact pinned source.

Each run writes an isolated directory under `evidence/`. Large generated
vmstate, disk-delta, framebuffer, and log files are ignored by Git. The final
validator checks artifact identity before and after, exact upstream Omarchy
provenance, source and target process separation, completed raw immediate-file
migration by default, clean 1600×900 framebuffers, resumed keyboard input,
artifact hashes, and the relative cold-boot/resume timing.

Static checks can be run without booting a guest:

```sh
node --test proofs/preboot-resume/static.test.mjs
node proofs/preboot-resume/inspect-wasm-support.mjs .
```

## Wasm support boundary

`inspect-wasm-support.mjs` verifies both source and the exact linked
`runtime/dist/qemu.wasm`. At the pinned QEMU 8.2 commit, file migration is a
QAPI transport, `-incoming file:filename[,offset=offset]` dispatches to the
read-only file migration channel, and the linked Wasm contains the incoming,
savevm, and loadvm implementation markers.

That is strong presence evidence, not a browser resume pass. Browser work still
has to authenticate and range-deliver both checkpoint artifacts, expose their
paired backing-file layout to QEMU's virtual filesystem, keep resumed writes
bounded, measure memory and load latency in the real Worker, and repeat the
pixel/input acceptance gate in the browser. Until those checks pass, the
native proof is an implementation direction rather than a production claim.
