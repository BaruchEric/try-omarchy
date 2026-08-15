# VirGL guest-hibernation proof

This is an isolated, non-promotable producer/proof harness for the
`guest-hibernation-resume` path. It exists because QEMU 8.2 rejects migration
of an active VirGL device: instead of serializing QEMU device state, a fresh
QEMU boots the pinned kernel and derived initramfs, Linux restores userspace
from a dedicated swap disk, and `virtio_gpu` is initialized only after resume.

No script in this directory changes `guest/dist`, `runtime/dist`, a release
manifest, or a running server. Generated builds and evidence remain under the
ignored `.build/` and `evidence/` directories.

## Safety and topology contract

The producer and target both use QEMU 8.2.0 at source commit
`0ef7b4e2814b231705d8371dd7997f5b72e70baf`, `pc-q35-8.2`, `qemu64`, 1024 MiB,
two vCPUs, and `tcg,tb-size=128,thread=multi`. Their ordered block devices are:

1. `omarchy-hibernate-root` → `virtio-blk-pci` serial `omarchy-root`, backed by
   `hibernate-root-overlay.qcow2` over canonical `rootfs.ext4`.
2. `omarchy-hibernate-swap` → `virtio-blk-pci` serial `omarchy-resume`, backed
   by standalone `omarchy-hibernate.qcow2` with fixed UUID
   `4c9a13d2-7c3a-4f2c-b6e1-5a3048610e8f`.

The native producer uses `sdl,gl=on,show-cursor=on`; the browser runtime uses
`sdl,gl=es,show-cursor=on`. The manifest binds these separately as
`producerMachine` and `runtimeMachine`. Every other machine field and both
ordered block records must match.

The derived initramfs omits `kms`, removes `virtio_gpu` from early modules,
and blacklists it during the new-kernel resume phase. A pre-desktop oneshot
formats the blank swap device and enters swsusp directly with
`printf disk > /sys/power/state`; it does not rely on a systemd sleep-target
transaction. `TimeoutStartSec=infinity` prevents systemd from killing a slow
TCG producer. A failed fresh target emits `OMARCHY_HIBERNATION_COLD_BOOT` and
powers off instead of silently continuing as a cold boot.

After an authentic restore, the suspended oneshot explicitly loads
`virtio_gpu`, requires kernel `+virgl` evidence, creates a fresh EGL/GLES
context on `/dev/dri/renderD128`, and emits the renderer report immediately
before the nonce-bound hibernation report. A native software host may report
`virgl (llvmpipe ...)`; this still proves that the guest selected VirGL rather
than direct guest llvmpipe. Browser acceptance separately proves WebGL2 host
presentation.

The producer metadata never publishes the 256-bit nonce. It contains only its
SHA-256, a SHA-256 of the actual source command line, and a redacted source
command line. The target command line is public and contains no nonce.

## Artifacts and limits

The canonical inputs are currently:

- `vmlinuz-linux`: 17,101,312 bytes
- `initramfs-linux.img`: 51,831,735 bytes
- `rootfs.ext4`: 6,442,450,944 bytes

The successful proof emits the four release candidates below plus evidence:

- `initramfs-virgl-hibernate.img` (maximum 64 MiB)
- `hibernate-root-overlay.qcow2` (maximum 256 MiB physical)
- `omarchy-hibernate.qcow2` (1,610,612,736 virtual bytes; maximum 1 GiB physical)
- `hibernate-manifest.json`

The target always uses `-snapshot`. Before/after hashes prove that target
resume, desktop startup, and interaction did not mutate the frozen artifacts.
`SHA256SUMS` deterministically covers every regular evidence file after both
QEMUs and Xvfb have stopped.

## Static checks (safe and fast)

These checks do not invoke Docker or QEMU:

```sh
node --test proofs/virgl-hibernate/static.test.mjs
```

## Bounded native proof

First build the isolated browser candidate that the hibernation manifest will
bind. The proof intentionally rejects `runtime/dist/qemu.wasm`, plain VirGL,
the 750-threshold/4-vCPU experiment, and arbitrary Wasm. The selected directory
must include hash-consistent `runtime-verification.json`, `runtime-build.json`,
and `runtime-manifest.json` proving the exact non-promotable VirGL/WebGL2 plus
bounded-CLOCK-v1 profile and the two-vCPU hibernation topology.

```sh
make -C runtime build-virgl-webgl2-tcg-bounded-clock
```

Build the pinned native QEMU and renderer probe:

```sh
BUILD_JOBS=8 proofs/virgl-hibernate/build-pinned-qemu.sh
```

Then run the producer and fresh target:

```sh
VIRGL_HIBERNATE_BROWSER_QEMU_WASM="$PWD/runtime/experiments/virgl-webgl2-tcg-bounded-clock/dist/qemu.wasm" \
VIRGL_HIBERNATE_SOURCE_TIMEOUT_SECONDS=1200 \
VIRGL_HIBERNATE_TARGET_TIMEOUT_SECONDS=600 \
VIRGL_HIBERNATE_DESKTOP_TIMEOUT_SECONDS=900 \
proofs/virgl-hibernate/run.sh
```

Expected wall time on the current Docker-on-Apple-Silicon setup is roughly
15–25 minutes after the native QEMU build. The explicit worst-case phase
budget is 54 minutes: 20 minutes to produce the image, 10 minutes to resume,
15 minutes for the authentic desktop report, 6 minutes for two healthy
1600×900 frames, and 3 minutes for visible Super+Return/Foot input.

A PASS requires ordered kernel resume evidence, one exact nonce/source-boot-ID
marker, a fresh VirGL renderer report, a new authentic guest report, two
healthy 1600×900 frames, and visible Foot input while QEMU is still running.
It deliberately records `browserAcceptance: false`; the artifacts remain
non-promotable until the separate browser acceptance gate proves the same
resume marker, browser WebGL2 presentation, live report, frames, and input.
