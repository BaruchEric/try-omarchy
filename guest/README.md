# Real Omarchy guest image

This directory builds the disposable x86_64 Arch guest consumed by the browser
runtime. It is not an HTML recreation of Omarchy. The installed compositor,
desktop shell, commands, configuration, themes, and applications come from the
pinned Basecamp Omarchy source and Arch/Omarchy packages.

The current pin is Omarchy `4.0.0.alpha` at commit
`f0020448ca87329199de7cb12f2015ebc4a3e5e7`. `spec.json` also pins its git tree,
the normalized 1,615-file SHA-256, the complete 579-package transaction, the
virtual hardware contract, and the selected authentic themes.

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
`omarchy.web.diagnostics` virtio-serial port (falling back to ttyS0).

## Fast verification on any development machine

No Docker, Arch installation, root access, or network is needed:

```bash
./guest/test
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

For release reproduction, retain the exact builder image digest and package
archive/cache alongside the manifest. The lock prevents silent mirror drift;
the retained cache protects against an old package disappearing from a rolling
repository.
