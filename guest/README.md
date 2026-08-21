# Real Omarchy guest image

This directory builds two disposable Arch guests: the proven x86_64 image for
the no-install browser runtime and an ARM64 image for the native macOS helper.
It is not an HTML recreation of Omarchy. The installed compositor,
desktop shell, commands, configuration, themes, and applications come from the
pinned Basecamp Omarchy source and Arch/Omarchy packages.

Both products pin Omarchy Quattro `4.0.0.alpha` at commit
`7488eaded43de68ff9d2d7e4bf50cd48e112eb0f`, the same git tree, and the same
normalized source digest. Each architecture keeps its own complete package
transaction, virtual hardware contract, filesystem identity, and artifact set.

`spec.aarch64.json` is the separate native-virtualization product. It also pins
the official Omarchy ARM package-builder commit, the Arch Linux ARM packaging
commit, and a 573-package ARM transaction. Updating one architecture never
silently changes the other architecture's already-attested artifact bundle.

## What changes for the web demo

The upstream runtime stays under `/usr/share/omarchy` byte-for-byte. The web
profile uses the same supported customization layers as an Omarchy user:

- user Hyprland overrides force scale 1 on the virtual monitor and show a real
  Omarchy welcome notification;
- a user menu extension adds a small demo guide and hides install, update,
  physical-hardware, suspend, and shutdown workflows;
- unsupported system and user services are masked;
- tty1 autologin launches Omarchy's upstream UWSM/Hyprland session;
- Mesa llvmpipe is the portable graphics baseline;
- logs, changes, and browser state are disposable;
- six original themes remain available for real theme switching.

`provenance.json` records normalized upstream and installed-tree digests. Once
Hyprland and Quickshell are live, `omarchy-web-guest-probe` emits a
`guest-report.json` and a single `OMARCHY_GUEST_REPORT` JSON line over the named
`omarchy.web.diagnostics` virtio-serial port (falling back to ttyS0). Before
that final evidence exists, the same observer emits strict
`OMARCHY_GUEST_STAGE` JSON Lines for tty1 autologin, UWSM, Hyprland,
Quickshell, and report generation. Each line has a locked, strictly increasing
sequence and guest-monotonic timestamp. A separate stable lock protects an
atomically replaced, fsynced state file in the user's private runtime
directory, so an interrupted write fails closed instead of resetting the
sequence. These stages are diagnostics only; they never substitute for the
authenticated final report.

## Slow WebAssembly startup diagnostics

The native passing proof and browser guest execute the same command from the
tty1 login profile:

```sh
exec uwsm start -g -1 -e -D Hyprland hyprland.desktop
```

UWSM starts Hyprland through its upstream `wayland-wm@.service`, a
`Type=notify` user unit, and waits for the compositor's environment through
`wayland-session-waitenv.service`. UWSM normally gives both units 30 seconds.
That is reasonable on a native installation, but can terminate an authentic
compositor which is still paging binaries and llvmpipe into a single-vCPU
QEMU-Wasm guest. The web profile therefore adds matching
`TimeoutStartSec=15min` drop-ins for both units and sets UWSM's supported
`UWSM_WAIT_VARNAMES_TIMEOUT=900` generator input to the same bound. This keeps
UWSM's runtime-generated drop-ins consistent with the static fallback; it does
not replace the UWSM command, either unit's `ExecStart`, Hyprland, or
Quickshell. The tty1 getty retains normal restart behavior with a five-second
backoff, avoiding a hot autologin/UWSM failure loop.

Three concrete failure modes explained the otherwise silent tty1 state:

- UWSM could time out the real Hyprland process after 30 seconds of slow TCG
  paging, then tty1 autologin could immediately repeat the same attempt;
- the evidence service was ordered after `graphical-session.target`, so it
  could not report the UWSM/Hyprland failure that prevented that target; and
- once started, the old probe abandoned report generation after one 45-second
  readiness window instead of retaining diagnostic state and retrying.

The tty1 profile asks systemd's user manager to own the observer immediately
before it `exec`s UWSM. The observer does not wait for
`graphical-session.target`, because that would hide the failure that prevented
the target. It runs at idle I/O priority and the lowest CPU scheduling
priority, polls `/proc` cheaply, invokes `hyprctl` only after the real Hyprland
executable appears, records the exact UWSM unit failure state, and continues
after the 15-minute diagnostic threshold. Once both authentic
desktop processes are live, report generation and delivery retry with bounded
backoff until a diagnostics device accepts the one final report line. A
malformed or partial identity report is never emitted as success.

The observer persists the completed report atomically, then reserves its
SHA-256 digest under the same stable lock before writing any serial bytes. A
zero-byte device failure can retry safely; a partial or interrupted delivery
keeps the reservation and refuses a duplicate. After a complete write, the
digest is marked delivered and the systemd service remains active-exited, so a
later tty1 login cannot emit the evidence again. Report files and state use
private UID-scoped directories, no-follow file opens, random exclusive
temporaries, and directory fsyncs. Identity commands use absolute packaged
paths with only the required Wayland/session environment, and report success
requires the exact one-monitor 1600x900 scale-1 DPMS-on contract.

The stage payload contract is one compact JSON object with exactly these keys:
`schemaVersion`, `sequence`, `monotonicMs`, `stage`, `status`, `attempt`, and
`message`. Stage names are `autologin`, `uwsm`, `hyprland`, `quickshell`, or
`report`; statuses are `started`, `waiting`, `ready`, or `failed`; messages are
single-line and at most 512 UTF-8 bytes.

The trimmed image materializes the verified upstream payload, then registers
that exact staged tree as a local `omarchy-web-runtime` Arch package providing
`omarchy`. This leaves every upstream command byte-identical while making the
official `omarchy-version` command report the pinned `4.0.0.alpha-1` package
version through its normal `pacman -Q omarchy` lookup. The package database
also owns the staged runtime paths, and the build rejects missing files with
`pacman -Qk` before packing the image.

## Fast verification on any development machine

No Docker, Arch installation, root access, or network is needed for the x86
pipeline tests and dual-architecture contract tests:

```bash
./guest/test
node --test guest/tests/architecture.test.mjs
```

If a clean checkout of the pinned source is available, deep mode also stages
the real 52 MB trimmed payload and compares every upstream command plus critical
Hyprland/Quickshell files:

```bash
./guest/test --source /path/to/basecamp-omarchy
```

## Release build on Linux

The supported release host is x86_64 Arch Linux. It needs
`arch-install-scripts`, `e2fsprogs`, `git`, `python`, and `zstd`, then:

```bash
sudo ./guest/build.sh \
  --source /path/to/clean-pinned-omarchy \
  --work /var/tmp/omarchy-web-build \
  --output "$PWD/guest/dist"
```

The build proceeds through explicit gates:

1. verify the source commit, git tree, clean checkout, and normalized digest;
2. refresh an isolated repository database and require the checked-in complete
   package-version lock before downloading the desktop transaction;
3. `pacstrap` only the trimmed package set into a new staging root;
4. reproduce Omarchy's package layout and seed its real user configuration;
5. apply the isolated virtual-hardware/demo profile;
6. generate the default theme through the real `omarchy-theme-set` command;
7. build a virtio-capable initramfs and a fixed-UUID ext4 image;
8. validate ext4, compress it, hash every output, and write guest metadata.

The container wrapper is convenient on Linux and can run slowly through x86
emulation on Apple Silicon:

```bash
./guest/build-container.sh --output "$PWD/guest/dist"
```

It uses `--privileged` because `pacstrap`/`arch-chroot` need mount namespaces.
The container disables pacman's downloader sandbox only because seccomp is not
implemented correctly by common x86-on-ARM container emulators. Native builds
keep the sandbox enabled.

## ARM64 Quattro build

On Apple Silicon the ARM transaction resolves and builds natively inside the
Linux ARM Docker VM; no x86 emulation is involved. Its rootfs and cache are
isolated from `guest/dist` and the x86 builder:

```bash
./guest/build-arm64-container.sh --output "$PWD/guest/dist-aarch64"
```

The ARM image boots through Apple's Virtualization.framework using the raw
`/boot/Image` kernel, an explicit Virtio initramfs, a disposable APFS clone of
the ext4 disk, Virtio GPU, and native USB keyboard/pointer devices. The build
normalizes its output names to `vmlinuz-linux`, `initramfs-linux.img`, and
`rootfs.ext4`, so the helper consumes the same manifest roles without confusing
the architectures. ARM serial evidence prioritizes Apple's connected `hvc0`
console ahead of any disconnected `ttyS0` node; a narrow udev rule grants the
guest's `users` group write access only to that evidence console. x86 retains
its named virtio-serial/`ttyS0` route.

On Linux, the wrapper keeps its source checkout and temporary rootfs in the host
directory `guest/.work-container`, preserving the original native build path.
On macOS and other Docker Desktop hosts it instead selects a stable, persistent
Docker volume named `omarchy-web-guest-work-<workspace-checksum>`. A staged Arch
root contains read-only and root-owned paths (including the extracted CA store
and `/etc/machine-id`); Docker Desktop host bind mounts do not provide all Linux
permission semantics needed to replace and clean those paths. A managed volume
lives on Docker's Linux filesystem and does. The explicit `--output` directory
remains a host bind, so successful artifacts appear at the requested path.

Inspect the selection without building or creating any directories/volumes:

```bash
./guest/build-container.sh --dry-run --output "$PWD/guest/dist"
```

Use `--work-volume NAME` to select a particular persistent Docker volume. An
explicit `--work DIR` remains available on Linux, but is rejected on non-Linux
hosts to avoid recreating the permission failure. The wrapper never removes an
old host work directory. After a failed Docker Desktop bind-based build, leave
`guest/.work-container` in place for inspection and rerun the command above;
the new build uses the managed volume and reuses it on subsequent attempts.

Downloaded package archives are kept in `pacman-cache/` under that same work
directory or managed volume. The builder uses pacstrap's supported host-cache
mode, so a failed staging root can be discarded without discarding its verified
downloads. Repository databases are still refreshed and the reviewed version
lock plus package signatures are still enforced on every attempt. Pacstrap's
temporary builder configuration is replaced with Omarchy's pinned, unmodified
pacman configuration before the guest image is packed. The build never prunes
the persistent package cache automatically.

The full package/image build is deliberately not part of the fast test. Do not
spend that bandwidth until the runtime's virtio-gpu canvas path has passed its
graphics gate.

For the x86 browser fallback, a bounded user-level Hyprland profile starts the
real Quattro shell, commands, menu, theme, terminal, tiling, and primary
shortcuts without loading physical-hardware rules or hundreds of bindings for
apps absent from the disposable image. The authentic upstream configs remain
installed byte-for-byte. This prevents Hyprland's Lua reload budget from
expiring under TCG and avoids spending emulated CPU on animations. The
ARM/native profile retains Quattro's full configuration and look-and-feel.

## Output contract

`guest/dist/` contains:

| Path | Purpose |
| --- | --- |
| `vmlinuz-linux` | x86_64 Arch kernel (`guest-kernel`) |
| `initramfs-linux.img` | initramfs with explicit virtio block/GPU/input modules |
| `rootfs.ext4` | writable ephemeral guest disk (`guest-rootfs`) |
| `rootfs.ext4.zst` | transport-compressed disk |
| `build-spec.json` | immutable guest/runtime contract |
| `provenance.json` | upstream and installed content digests (`guest-metadata`) |
| `packages.lock.txt` | package versions actually installed |
| `guest-manifest.json` | mergeable guest-stage artifact records |
| `LICENSE.omarchy` | upstream MIT text |
| `SHA256SUMS` | output integrity hashes |

The release packager—not this guest-only build—merges `guest-manifest.json`
with QEMU-Wasm, worker, corresponding-source, and license artifacts into the
strict public `artifact-manifest.json`.

## Native boot gate

After producing the artifacts, a Linux host with QEMU can boot the exact disk
without modifying it:

```bash
qemu-system-x86_64 \
  -enable-kvm -cpu host -smp 4 -m 2048 \
  -kernel guest/dist/vmlinuz-linux \
  -initrd guest/dist/initramfs-linux.img \
  -append 'root=/dev/vda rw rootfstype=ext4 console=tty0 console=ttyS0,115200n8 loglevel=3 systemd.show_status=auto vt.global_cursor_default=0' \
  -drive file=guest/dist/rootfs.ext4,format=raw,if=virtio \
  -device virtio-vga -device virtio-keyboard-pci -device virtio-mouse-pci \
  -device virtio-serial-pci \
  -chardev file,id=diag,path=guest-report.jsonl \
  -device virtserialport,chardev=diag,name=omarchy.web.diagnostics \
  -nic user,model=virtio-net-pci -snapshot
```

The blocking assertions are a live 1600×900 monitor, real `Hyprland` and
`quickshell` processes, successful identity commands, visible desktop frames,
keyboard/pointer input, tiling, workspace switching, and real theme switching.

## Updating package versions

The checked-in transaction lock is fail-closed. If a reviewed image update is
intentional, resolve into a separate file, inspect the diff, then replace the
lock in its own commit:

```bash
sudo ./guest/scripts/refresh-package-lock.sh \
  --source /path/to/clean-pinned-omarchy \
  --output /tmp/packages.x86_64.lock.json

diff -u guest/packages.x86_64.lock.json /tmp/packages.x86_64.lock.json
```

The same resolver is architecture-aware. For ARM64, run it inside the supplied
ARM builder and pass `--spec /workspace/guest/spec.aarch64.json`; always write
to a separate review file before editing `packages.aarch64.lock.json`.

For release reproduction, retain the exact builder image digest and package
archive/cache alongside the manifest. The lock prevents silent mirror drift;
the retained cache protects against an old package disappearing from a rolling
repository.
