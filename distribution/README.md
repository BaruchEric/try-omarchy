# Distribution evidence builder

This directory turns a completed guest build and the exact local QEMU-Wasm
sources used by `runtime/` into the three legal/distribution inputs consumed by
`release/assemble.mjs`:

- `sbom.spdx.json` — deterministic SPDX 2.3 JSON for Omarchy, QEMU-Wasm, and
  every package installed in the guest;
- `THIRD_PARTY_NOTICES.tar.zst` — all files from the final guest's
  `/usr/share/licenses`, QEMU's exact license files, a human-readable package
  table, and a content-addressed JSON index;
- `qemu-wasm-corresponding-source.tar.zst` — the clean pinned QEMU-Wasm git
  tree, every locked Meson wrap checkout used by the build, and the exact local
  patches, configuration, toolchain shim, loader, and build scripts.

`distribution-manifest.json` records every output digest plus release-assembler
hints. It always records `legalStatus: "NOT_CLEARED"`; this is engineering
evidence and cannot approve a release.

## Build

Requirements are Node 22+, Git, `zstd`, and (when an extracted root directory
is not supplied) `debugfs` from e2fsprogs. Copy and edit the example:

```sh
cp distribution/distribution-input.example.json /tmp/omarchy-distribution.json
node distribution/build.mjs --config /tmp/omarchy-distribution.json
```

All relative paths are resolved from the config file's directory. After
copying the example elsewhere, replace its repository-relative examples with
absolute paths (or paths relative to the new location).

The configured `sourceDateEpoch` must equal the epoch in
`guest-manifest.json`. Archive member timestamps, the SPDX creation time, IDs,
ordering, owners, permissions, and compression settings are derived from that
value. Running the same inputs twice produces byte-identical three release
artifacts. Existing output directories are never replaced.

By default the tool reads `rootfs.ext4` and `packages.lock.txt` from the guest
artifact directory. It extracts ext4 read-only with `debugfs`, which binds the
audit to the already-hashed release image. Only the two trees consumed by the
audit—`/var/lib/pacman/local` and the complete `/usr/share/licenses` corpus—are
materialized on the host, along with the exact `/usr/share/doc` files reached
by package-license symlinks. A fixture or retained build root may
set `guest.rootfsDirectory` only together with
`guest.allowUnverifiedRootfsDirectory: true`; the manifest then marks the audit
as **not cryptographically bound** and it must not be used as release evidence.
The builder performs all of the following before writing any promoted output:

1. re-hashes every file in `guest-manifest.json`;
2. requires an exact name/version match between the package lock and every
   `/var/lib/pacman/local/*/desc` record in the final rootfs;
3. requires non-empty license metadata for every package;
4. rejects unknown, ambiguous, `custom`, and multi-license declarations unless
   a reviewed override resolves them to a valid SPDX expression;
5. copies and hashes the complete `/usr/share/licenses` tree while rejecting
   escaping symlinks, special files, traversal, duplicates, and unsafe archive
   members;
6. requires the clean QEMU checkout HEAD and origin to match
   `runtime/upstream.lock.json`, verifies each wrap URL/revision, and archives
   the exact locked subproject commits rather than mutable working trees;
7. hashes every runtime build input and refuses `runtime/build`, `runtime/dist`,
   missing patches, symlinks, or paths outside `runtime/`.

Exact SPDX identifiers such as `MIT`, `GPL-2.0-only`, `Apache-2.0`, and
`OFL-1.1` are accepted from pacman metadata. Ambiguous legacy values such as
`GPL`, `LGPL`, `BSD`, multiple values, or project-specific terms require an
explicit review entry:

```json
{
  "licenses": {
    "licenseMappings": {
      "GPL2": "GPL-2.0-only"
    },
    "packageLicenseOverrides": {
      "some-custom-package": {
        "concluded": "LicenseRef-Some-Custom-Terms",
        "name": "Some custom package terms",
        "licenseFiles": [
          "usr/share/licenses/some-custom-package/LICENSE"
        ]
      },
      "dual-licensed-package": {
        "concluded": "MIT OR Apache-2.0"
      }
    },
    "additionalSpdxLicenseIds": []
  }
}
```

Mappings and overrides are deliberately not guessed. A `LicenseRef-*` must
name installed license text; that exact text is emitted as SPDX extracted
licensing information. `additionalSpdxLicenseIds` is an explicit audit escape
hatch for a valid SPDX identifier not in the builder's conservative embedded
set, not a way to accept arbitrary terms. A failed audit reports every
unresolved installed package in one run so the review file can be completed
without repeatedly rebuilding the guest.

## Release assembler handoff

Point the existing release input at these outputs:

```json
{
  "licenseBundle": "../distribution/dist/THIRD_PARTY_NOTICES.tar.zst",
  "sbom": "../distribution/dist/sbom.spdx.json",
  "runtimeSource": "../distribution/dist/qemu-wasm-corresponding-source.tar.zst"
}
```

Copy `releaseAssembler.licenses` from `distribution-manifest.json` and replace
the release config's `runtime.correspondingSourceUrl` with the immutable public
URL where the exact generated source archive will be retained.

## Scope and hard limits

The corresponding-source archive is exact for the modified QEMU-Wasm
executable and its build-only subprojects. It inventories QEMU gitlinks but
does not pretend that unrelated, uninitialized platform submodules were build
inputs. It is **not** the kernel/package source offer and is **not** sufficient
for precompiled firmware or ROMs: those need separate filename-by-filename
source and license records. Emscripten/SDL generated-runtime linkage and notice
requirements also remain a manual review gate.

SPDX package records intentionally use `copyrightText: "NOASSERTION"` because
pacman metadata does not provide complete copyright statements; their exact
notice locations are in the bundle index. Trademark/endorsement, export,
privacy, security, source-retention, and organizational approval checks in
`docs/legal-distribution.md` remain mandatory. Passing this builder never
means legal clearance.

## Test

The fixture suite initializes real pinned Git repositories and uses realistic
pacman database/license trees without large disk images:

```sh
make -C distribution test
make -C distribution check
```

It proves byte-for-byte reproducibility, SPDX contents, notice/source archive
contents, custom extracted licenses, exact lock matching, and fail-closed
behavior for missing/unknown licenses, escaping symlinks, dirty QEMU sources,
and unsafe runtime paths.
