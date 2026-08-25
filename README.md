# Try Omarchy

Run the upstream [Omarchy](https://github.com/basecamp/omarchy) desktop as a
native, hardware-accelerated app on an Apple Silicon Mac.

Try Omarchy is a community project that packages a prebuilt ARM64 Arch Linux image configured with Omarchy, a signed QEMU/HVF runtime, and a small Swift/AppKit launcher into one self-contained macOS app.  
The image is built from pinned Arch Linux ARM packages and a pinned revision of the upstream Omarchy source.

## Quick Start

Head over to [Releases](https://github.com/themartiano/try-omarchy/releases) and download the latest `.dmg` file.
Install it as any other app, launch it, and enjoy Omarchy.

## Requirements

- Apple Silicon Mac (`arm64`)
- macOS 15 or newer
- 6 GB free storage

## Dev Requirements

- Xcode command-line tools and Swift 6
- Homebrew
- Docker Desktop with ARM64 containers enabled
- `zstd`, `pkg-config`, GLib, Pixman, libslirp 4.9.2, and SDL2 2.32.10
- roughly 20 GB free for guest, runtime, caches, and the assembled app

The QEMU builder checks exact dependency versions and fails with a specific
message if the local Homebrew toolchain does not match.

## Build and run

```sh
make doctor
make build
make run
```

The first full build downloads pinned sources, assembles a multi-gigabyte guest,
and compiles QEMU, so it can take a while. Later app rebuilds reuse
`dist/guest/` and `macos/.build/qemu-gpu-runtime`:

```sh
make app
make run
```

All distributable output has one predictable home:

```text
dist/
├── Try Omarchy.app
├── Try Omarchy.dmg       # after make package
└── guest/                # verified guest artifacts
```

Run `make help` for component builds, tests, persistent-storage reset, ephemeral
mode, and cleanup commands.

## Repository layout

```text
.
├── Makefile                 public build interface
├── macos/                   Swift launcher and QEMU/HVF runtime builder
├── guest/                   reproducible ARM64 factory-image builder
├── docs/                    architecture and release documentation
├── dist/                    generated output (ignored)
├── CONTRIBUTING.md
├── SECURITY.md
├── THIRD_PARTY_NOTICES.md
└── LICENSE
```

The architecture and trust boundaries are documented in
[`docs/architecture.md`](docs/architecture.md). Contributors should start with
[`CONTRIBUTING.md`](CONTRIBUTING.md); maintainers should follow
[`docs/releasing.md`](docs/releasing.md).

## Project status

Try Omarchy is an independent open-source project and is not affiliated with or
endorsed by Basecamp. Omarchy and bundled dependencies retain their own licenses;
see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Try Omarchy's original code is licensed under the [MIT License](LICENSE).

by [@martiano](https://x.com/martiano)
