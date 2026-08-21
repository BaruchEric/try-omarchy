# VirGL guest-hibernation proof

This is an isolated, non-promotable producer/proof harness for the
`guest-hibernation-resume` path. It exists because QEMU 8.2 rejects migration
of an active VirGL device: instead of serializing QEMU device state, a fresh
QEMU boots the pinned kernel and derived initramfs, Linux restores userspace
from a dedicated swap disk, and `virtio_gpu` plus `virtio_input` are initialized
only after resume.

No script in this directory changes `guest/dist`, `runtime/dist`, a release
manifest, or a running server. Generated builds and evidence remain under the
ignored `.build/` and `evidence/` directories.

## Safety and topology contract

The producer and target both use QEMU 8.2.0 at source commit
`0ef7b4e2814b231705d8371dd7997f5b72e70baf`, `pc-q35-8.2,i8042=off`, `qemu64`, 1024 MiB,
two vCPUs, and `tcg,tb-size=128,thread=multi`. Their ordered block devices are:

1. `omarchy-hibernate-root` → `virtio-blk-pci` serial `omarchy-root`, backed by
   `hibernate-root-overlay.qcow2` over canonical `rootfs.ext4`.
2. `omarchy-hibernate-swap` → `virtio-blk-pci` serial `omarchy-resume`, backed
   by standalone `omarchy-hibernate.qcow2` with fixed UUID
   `4c9a13d2-7c3a-4f2c-b6e1-5a3048610e8f`.

The native producer uses `sdl,gl=on,show-cursor=on,full-screen=on`; the browser runtime uses
`sdl,gl=es,show-cursor=on`. The manifest binds these separately as
`producerMachine` and `runtimeMachine`. Every other machine field and both
ordered block records must match. Native evidence additionally pins
`SDL_VIDEO_X11_WINDOW_VISUALID=0x3b7`, the image's 24-bit double-buffered
TrueColor GLX visual that supports QEMU's shared OpenGL 4.5 core context. This
keeps fullscreen Xvfb capture self-contained without DirectColor colormaps.

The derived initramfs omits `kms`, removes `virtio_gpu` and `virtio_input` from
early modules, and blacklists both during the new-kernel resume phase. This
prevents a fresh target from inheriting stale input virtqueues from the saved
kernel image. A pre-desktop oneshot
formats the blank swap device and enters swsusp directly with
`printf disk > /sys/power/state`; it does not rely on a systemd sleep-target
transaction. `TimeoutStartSec=infinity` prevents systemd from killing a slow
TCG producer. A failed fresh target emits `OMARCHY_HIBERNATION_COLD_BOOT` and
powers off instead of silently continuing as a cold boot.

After an authentic restore, the suspended oneshot explicitly loads
`virtio_input`, requires both QEMU input devices to bind, settles udev, and only
then loads `virtio_gpu`. It requires kernel `+virgl` evidence, creates a fresh
EGL/GLES context on `/dev/dri/renderD128`, and emits the renderer report
immediately before the nonce-bound hibernation report. A native software host may report
`virgl (llvmpipe ...)`; this still proves that the guest selected VirGL rather
than direct guest llvmpipe. Browser acceptance separately proves WebGL2 host
presentation.

The producer metadata never publishes the 256-bit nonce. It contains only its
SHA-256, a SHA-256 of the actual source command line, and a redacted source
command line. The target command line is public and contains no nonce.

## Artifacts and limits

The canonical inputs are currently:

- `vmlinuz-linux`: 17,101,312 bytes
- `initramfs-linux.img`: 51,827,771 bytes
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

Native VirGL does not expose a software QEMU display surface, so QMP
`screendump` cannot capture it. The proof instead starts Xvfb with `-fbdir`,
waits for Xvfb to reach the kernel stopped state, copies `Xvfb_screen0`, and
immediately resumes Xvfb. It accepts a frame only after two independent
STOP→copy→CONT samples are byte-identical. A strict Node converter validates
the big-endian XWD header, exact 1600×900×32-bit layout and RGB masks before
writing P6 PPM. Each capture metadata record binds the capture mode plus both
stable-sample, retained XWD, and PPM SHA-256 values; all three files are also
covered by `SHA256SUMS`. QMP remains in use for bounded input, status, and quit.
The input gate requires the resumed VM to be running, both Virtio input devices
to be started and `DRIVER_OK`, exactly one keyboard queue to consume the
modifier-reset probe, and the same queue to consume exact Super+Return press and
release reports. QMP acknowledgement without matching avail/used ring progress
does not pass. A proof-only root observer opens the identified `QEMU Virtio
Keyboard` event node read-only and without `EVIOCGRAB`; PASS also requires its
udev keyboard classification and the exact Linux `KEY_LEFTMETA`/`KEY_ENTER`
press-release sequence. The authenticated guest report records read-only
`hyprctl` device, bind, config-error, workspace, window, submap, layer, and
client state so a session failure remains distinguishable from an emulator or
evdev delivery failure. The observer is diagnostic scaffolding for this
non-promotable proof and must be removed before a release artifact is promoted.

## Static checks (safe and fast)

These checks do not invoke Docker or QEMU:

```sh
node --test proofs/virgl-hibernate/*.test.mjs
```

## Bounded native proof

First build the isolated browser candidate that the hibernation manifest will
bind. The proof intentionally rejects `runtime/dist/qemu.wasm`, plain VirGL,
the 750-threshold/4-vCPU experiment, and arbitrary Wasm. The selected directory
must include hash-consistent `runtime-verification.json`, `runtime-build.json`,
and `runtime-manifest.json` proving the exact non-promotable VirGL/WebGL2 plus
bounded-CLOCK-v2/schema-4 profile and the two-vCPU hibernation topology.

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
healthy 1600×900 frames, queue-audited Virtio Super+Return delivery, and visible
Foot input while QEMU is still running.
It deliberately records `browserAcceptance: false`; the artifacts remain
non-promotable until the separate browser acceptance gate proves the same
resume marker, browser WebGL2 presentation, live report, frames, and input.
