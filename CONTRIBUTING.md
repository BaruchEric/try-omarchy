# Contributing

Thanks for helping improve Try Omarchy. The project has one product target: a
native Apple Silicon macOS app that runs the authentic Omarchy desktop in an
ARM64 virtual machine.

## Before opening a pull request

1. Open an issue for large behavioral or architecture changes.
2. Keep changes native-only. Browser runtimes, web launchers, x86 guests, and
   Node-based build tooling are intentionally outside this repository's scope.
3. Run `make test`.
4. If build inputs changed, run the relevant component build and explain how
   its pinned versions or checksums were reviewed.
5. Update documentation when commands, requirements, output paths, or security
   boundaries change.

The guest and QEMU supply chains are deliberately pinned. Do not update a URL,
commit, package lock, archive, or checksum independently of its associated
validation code.

Generated files in `dist/` and build caches in `macos/.build/` are not committed.

By contributing, you agree that your contribution is licensed under the MIT
License in this repository.
