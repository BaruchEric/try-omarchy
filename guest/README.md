# Real Omarchy guest images

This directory builds two architecture targets across three guest profiles
used by Try Omarchy:

- `guest/dist`: x86_64 Arch Linux for the fully client-side QEMU/WebAssembly
  Browser VM.
- `guest/dist-aarch64`: ARM64 Arch Linux for the hardware-accelerated QEMU/HVF
  Native Mac VM.
- `guest/dist-aarch64-unprovisioned`: a separate ARM64 factory image which
  enters Quattro's real first-boot owner setup with no pre-created user.

These are real Omarchy guests, not a desktop recreated in HTML. Both contain
Hyprland, Quickshell, Omarchy commands, configuration, themes, and applications
from Basecamp Omarchy Quattro `4.0.0.alpha`, pinned at commit
`7488eaded43de68ff9d2d7e4bf50cd48e112eb0f`. The two builds attest the same
normalized upstream source tree but retain separate package transactions,
virtual hardware contracts, filesystem identities, and artifact manifests.

`spec.json` is the x86_64 Browser VM contract. `spec.aarch64.json` is the ARM64
Native Mac VM contract and additionally pins the Omarchy ARM package-builder
and Arch Linux ARM packaging revisions. Updating one architecture never
silently changes the other architecture's released bundle.

`spec.aarch64-unprovisioned.json` is an evaluation-only factory contract with a
different filesystem identity and an ephemeral storage mode. It is not a RAM
snapshot or checkpoint: the kernel, initramfs, and installed root disk cold
boot normally. The speedup over browser emulation comes from native ARM code,
HVF CPU virtualization, and VirGL/Metal graphics acceleration.

## Supported VM profile

The upstream tree installed under `/usr/share/omarchy` remains byte-for-byte
verifiable. VM-specific behavior is applied through normal system and user
configuration layers:

- tty1 autologin starts the upstream UWSM/Hyprland session;
- the virtual monitor has a deterministic initial 1600×900 scale-1 mode;
- a small demo menu hides install, update, suspend, shutdown, and
  physical-hardware workflows that do not make sense in the demo;
- unsupported host-hardware services are masked;
- six original themes remain available for real theme switching;
- the x86_64 WebAssembly profile uses llvmpipe and a bounded Hyprland profile to
  avoid spending emulated CPU on absent hardware and unnecessary animations;
- the ARM64 native profile retains the full Quattro configuration and receives
  dynamically reported Retina/window/fullscreen modes from QEMU's Virtio GPU.

The x86 profile is a constrained distribution of Omarchy for an emulated
browser CPU, not a different UI implementation. The ARM profile belongs only
to the Native Mac VM.

The separate ARM factory profile keeps the pinned upstream `/usr/share/omarchy`
payload and `/etc/skel` defaults, but does not create an account, choose a
theme, enable tty autologin, install demo menu/welcome/browser overrides, write
first-run completion markers, or apply demo service masks. It arms the pinned
upstream `omarchy-provision-owner` service, which asks the owner for keyboard,
account, hostname, and timezone on tty1 before SDDM starts. Its VM integration
is limited to Virtio/initramfs support, the ARM QEMU host-cursor fragment, the
ARM `xdg-terminal-exec` compatibility command, update-safe local package
metadata/storage growth, and a no-op `ttfx` compatibility command that leaves
the upstream wizard's already-painted static splash intact because no reviewed
ARM64 `ttfx` package exists.

The reviewed ARM repositories do not currently publish `tzupdate`. The
upstream timezone form already falls back to its manual picker when it is
absent. For the required developer-tool setup, the factory spec pins the
official ARM64 `mise` release URL, archive digest, extracted binary digest, and
reported version. The builder installs that asset as an owned local Arch
package, so the real upstream setup flow can complete instead of warning that
`mise` is missing. Toolchains that `mise` installs for the owner, including
Node.js, still require outbound guest networking on first setup.

## Guest identity and readiness evidence

`provenance.json` records normalized upstream and installed-tree digests. Once
Hyprland and Quickshell are live, `omarchy-web-guest-probe` creates
`guest-report.json` and emits one `OMARCHY_GUEST_REPORT` JSON line on the
diagnostics console. Until then it emits monotonic `OMARCHY_GUEST_STAGE` JSON
Lines for autologin, UWSM, Hyprland, Quickshell, and report generation.

The observer uses a UID-private state directory, a stable lock, atomic file
replacement, fsync, and a reserved report digest. A zero-byte console failure
may retry; a partial write is never repeated as a second success. Identity
commands use absolute packaged paths and report success only when the expected
monitor and real desktop processes are present. Runtime readiness still
requires a newer framebuffer event after the final authenticated report.

Stage objects have exactly `schemaVersion`, `sequence`, `monotonicMs`, `stage`,
`status`, `attempt`, and `message`. Stages are `autologin`, `uwsm`, `hyprland`,
`quickshell`, or `report`; statuses are `started`, `waiting`, `ready`, or
`failed`. Diagnostics never substitute for the final identity report.

## WebAssembly startup allowance

Both guests start the desktop with the upstream command:

```sh
exec uwsm start -g -1 -e -D Hyprland hyprland.desktop
```

UWSM normally allows 30 seconds for Hyprland and the session environment. A
single-vCPU QEMU-Wasm guest can still be demand-paging binaries and compiling
llvmpipe work at that point. The x86 VM profile therefore gives the relevant
user units and `UWSM_WAIT_VARNAMES_TIMEOUT` a matching 15-minute ceiling. It
does not replace UWSM, either unit's `ExecStart`, Hyprland, or Quickshell.

The observer starts before UWSM, runs at idle I/O and minimum CPU priority,
polls `/proc` cheaply, and invokes `hyprctl` only after the real Hyprland process
appears. It records unit failure state and keeps retrying report generation with
bounded backoff. The tty1 getty retains a five-second restart backoff, avoiding
a hot failure loop on a slow emulated CPU.

The verified upstream payload is registered as a local `omarchy-web-runtime`
Arch package providing `omarchy`. The factory profile also registers its pinned
official binary as `omarchy-web-mise` providing `mise`. Both immutable package
archives are published through the guest-local `[omarchy-web]` sync repository,
so pacman does not misclassify them as foreign/AUR software. This preserves the
upstream command bytes while making the official `omarchy-version` path report
the pinned package version normally. The build rejects missing owned files and
unexpected foreign packages before packing the image.

## Fast verification

The contract, shell, and dual-architecture tests need no Docker, Arch install,
root access, or network:

```sh
./guest/test
node --test guest/tests/architecture.test.mjs
```

Deep mode stages a clean checkout of the pinned source and compares every
upstream command plus critical Hyprland/Quickshell files:

```sh
./guest/test --source /path/to/basecamp-omarchy
```

## Build the x86_64 Browser VM image

The direct release host is x86_64 Arch Linux with
`arch-install-scripts`, `e2fsprogs`, `git`, `python`, and `zstd`:

```sh
sudo ./guest/build.sh \
  --source /path/to/clean-pinned-omarchy \
  --work /var/tmp/omarchy-web-build \
  --output "$PWD/guest/dist"
```

The container wrapper is convenient on Linux and can run through x86
container emulation on Apple Silicon:

```sh
./guest/build-container.sh --output "$PWD/guest/dist"
```

It uses `--privileged` because `pacstrap` and `arch-chroot` need Linux mount
namespaces. On Docker Desktop it selects a workspace-specific managed Linux
volume for the staging tree and package cache; the explicit output remains a
host bind mount. This avoids relying on incomplete Linux ownership semantics in
a macOS bind mount. Inspect the selection without building:

```sh
./guest/build-container.sh --dry-run --output "$PWD/guest/dist"
```

`--work-volume NAME` selects an explicit persistent Docker volume. Direct
`--work DIR` is available on Linux and rejected on non-Linux hosts. Package
archives are retained in `pacman-cache/` so a failed staging root does not also
discard verified downloads; repository databases, signatures, and the reviewed
version lock are still checked on every build.

## Build the ARM64 Native Mac image

On Apple Silicon, the ARM transaction builds natively in Docker's ARM Linux VM:

```sh
./guest/build-arm64-container.sh --output "$PWD/guest/dist-aarch64"
```

The builder normalizes `/boot/Image`, its initramfs, and the ext4 root disk to
the shared artifact names `vmlinuz-linux`, `initramfs-linux.img`, and
`rootfs.ext4`. The native launcher boots those files directly with QEMU's
`virt` machine, HVF, host ARM CPU, Virtio block/GPU/input/console/RNG/balloon,
Virtio Ethernet over SLIRP, and a duplex HDA device backed by SDL.

ARM serial evidence uses the connected `hvc0` console. A narrow udev rule grants
the guest `users` group write access only to that console. The x86 guest retains
its named virtio-serial diagnostics port with serial fallback.

The complete image build is intentionally outside the fast test suite. Build
it only when the guest spec or package transaction changes; native runtime
iterations can reuse the verified `guest/dist-aarch64` bundle and its separate
persistent user disk.

### Build the unprovisioned ARM64 comparison image

The factory transaction adds SDDM and therefore has its own reviewed lock.
Resolve it first without assembling a root filesystem:

```sh
./guest/build-arm64-container.sh \
  --spec "$PWD/guest/spec.aarch64-unprovisioned.json" \
  --refresh-package-lock /tmp/packages.aarch64-unprovisioned.lock.json
```

Inspect that file, then install it as
`guest/packages.aarch64-unprovisioned.lock.json`. Build the separate artifact:

```sh
./guest/build-arm64-container.sh \
  --spec "$PWD/guest/spec.aarch64-unprovisioned.json"
```

With no explicit output, the factory spec writes only to
`guest/dist-aarch64-unprovisioned`; it never overwrites the configured native
bundle. Launch it ephemerally so every evaluation starts at the owner wizard.
Completing that wizard is a real first boot, not preconfiguration performed by
the image builder. The distributed root disk remains 6 GiB; at launch, only the
disposable APFS clone is sparsely extended to 24 GiB and the guest grows ext4
online before setup. This keeps the artifact compact while satisfying
Omarchy's 10 GiB free-space safety check for system updates.

The factory image also contains `pacman-contrib`, pins `linux-aarch64` until the
launcher can atomically update its externally booted kernel/initramfs, and
publishes the source-built Omarchy runtime plus pinned `mise` package through
an immutable local sync repository. That prevents the upstream updater from
misclassifying either package as AUR software. Factory launches remain
ephemeral: an update can be exercised during the session, but closing the VM
intentionally discards it.

## Build gates and output contract

Each architecture build:

1. verifies the source commit, git tree, clean checkout, and normalized digest;
2. refreshes an isolated repository database and enforces the checked-in
   complete package-version lock;
3. installs the trimmed transaction into a new staging root;
4. recreates Omarchy's package layout and seeds its real user configuration;
5. applies the isolated VM profile;
6. generates the default theme through the real `omarchy-theme-set` command;
7. builds a Virtio-capable initramfs and fixed-identity ext4 image; and
8. validates ext4, compresses it, hashes outputs, and writes guest metadata.

Both output directories contain the same artifact roles:

| Path | Purpose |
| --- | --- |
| `vmlinuz-linux` | Architecture-specific Arch kernel |
| `initramfs-linux.img` | Initramfs with required Virtio modules |
| `rootfs.ext4` | Verified writable base disk |
| `rootfs.ext4.zst` | Transport-compressed disk |
| `build-spec.json` | Immutable guest/runtime contract |
| `provenance.json` | Upstream and installed-content digests |
| `packages.lock.txt` | Package versions actually installed |
| `guest-manifest.json` | Typed guest-stage artifact records |
| `LICENSE.omarchy` | Upstream MIT license text |
| `SHA256SUMS` | Output integrity hashes |

The Browser VM release packager merges the x86 `guest-manifest.json` with its
QEMU-Wasm, Worker, corresponding-source, and license artifacts. The Native Mac
launcher independently verifies the complete ARM bundle and keys its persistent
disk directory by the SHA-256 of `guest-manifest.json`.

## Native x86 boot gate

A Linux host with QEMU/KVM can boot the exact Browser VM disk without modifying
it:

```sh
qemu-system-x86_64 \
  -enable-kvm -cpu host -smp 4 -m 2048 \
  -kernel guest/dist/vmlinuz-linux \
  -initrd guest/dist/initramfs-linux.img \
  -append 'root=/dev/vda rw rootfstype=ext4 console=tty0 console=ttyS0,115200n8' \
  -drive file=guest/dist/rootfs.ext4,format=raw,if=virtio \
  -device virtio-vga -device virtio-keyboard-pci -device virtio-mouse-pci \
  -device virtio-serial-pci \
  -chardev file,id=diag,path=guest-report.jsonl \
  -device virtserialport,chardev=diag,name=omarchy.web.diagnostics \
  -nic user,model=virtio-net-pci -snapshot
```

Blocking assertions include the real Hyprland and Quickshell processes,
identity commands, a live monitor, guest-originated frames, keyboard/pointer
input, tiling, workspace switching, and theme switching.

## Updating package versions

Package locks fail closed. Resolve an intentional update to a separate file,
inspect it, then replace the lock in its own reviewed commit:

```sh
sudo ./guest/scripts/refresh-package-lock.sh \
  --source /path/to/clean-pinned-omarchy \
  --output /tmp/packages.x86_64.lock.json

diff -u guest/packages.x86_64.lock.json /tmp/packages.x86_64.lock.json
```

For ARM64, run the same architecture-aware resolver inside the supplied ARM
builder with `--spec /workspace/guest/spec.aarch64.json`. Preserve the exact
builder digest and package cache with release evidence: the lock prevents
silent mirror drift, while the retained cache protects reproduction if an old
rolling package disappears.
