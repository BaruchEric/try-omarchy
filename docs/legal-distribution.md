# Legal and distribution checklist

This is an engineering release checklist, not legal advice. A public demo distributes emulator binaries, a Linux kernel, firmware, a guest filesystem, fonts, icons, themes, wallpapers, and applications to each visitor. “It only runs in the browser” does not remove normal redistribution obligations.

## Known top-level licenses

- Omarchy's repository states that Omarchy is MIT-licensed. Preserve its copyright and license text in the guest and downloadable notice bundle. Pin and link the exact release file, for example the [Omarchy license on its current branch](https://github.com/basecamp/omarchy/blob/quattro/LICENSE), rather than relying only on the repository landing page.
- [QEMU-Wasm](https://github.com/ktock/qemu-wasm) is a QEMU fork. Its [license summary](https://github.com/ktock/qemu-wasm/blob/master/LICENSE) says the emulator as a whole is GNU GPL version 2 and that bundled firmware has separate licenses. Treat the linked WebAssembly/worker output as GPL-2.0-covered unless a source-file-level audit establishes a different expression.
- The Linux kernel records `GPL-2.0 WITH Linux-syscall-note` and explains that other licenses may apply in its [COPYING file](https://github.com/torvalds/linux/blob/master/COPYING). Ship the exact kernel notices and corresponding source for the released binary/config/patch set.
- QEMU firmware and ROM files are separate programs with separate terms. Inventory each shipped blob by filename, origin commit/package, license, notice, and source URL; do not assign the QEMU executable's license to all firmware.
- Every Arch package has its own license metadata. Copying `/usr/share/licenses` is useful but insufficient: generate an SBOM from the final rootfs and resolve custom/unknown licenses before release.

## Corresponding source

Serving a compiled QEMU-Wasm module to visitors is object-code distribution. For GPL-covered output, publish complete corresponding source for the exact deployed commit from the same release page. Include local patches, submodules, interface definitions, Emscripten/QEMU configuration, and scripts used to control compilation and installation. The artifact manifest's `runtime.correspondingSourceUrl` must be permanent for that release, not a moving branch.

Apply the same analysis to the kernel and every copyleft guest package. Prefer downloadable source archives alongside the binary artifacts; retain them for the applicable license period and organizational policy. A link to upstream alone is not enough for modified components and may disappear.

Do not assume that aggregating the guest rootfs makes the independent website source GPL. Do not assume the reverse either: have counsel review how runtime JS is linked/generated with QEMU-Wasm, which Emscripten libraries are included, and whether local glue is part of the covered work. Record that decision.

## Omarchy authenticity and branding

The MIT license grants rights in the licensed code but does not automatically grant trademark or endorsement rights. Before public launch, obtain written permission or a reviewed basis for use of the Omarchy name, logo, and trade dress. Record the approved product wording and logo assets.

Unless explicitly authorized as official, state clearly that this is an unofficial browser demo, identify who operates it, link the upstream project, and avoid implying Basecamp or DHH endorsement. Authenticity claims should name the pinned upstream commit and disclosed web-hardware patches.

## Asset and package audit

The release SBOM must cover both host-side/runtime artifacts and the final guest filesystem. SPDX JSON is preferred for license review; CycloneDX may be emitted in addition. At minimum, record component/version, package URL or source URL, checksums, concluded and declared license expressions, copyright notice location, modification status, and corresponding-source location.

Review these categories individually:

- Omarchy source/config/scripts and each web-edition patch;
- QEMU-Wasm, generated JS/worker/Wasm, Emscripten runtime, and linked libraries;
- Linux kernel, initramfs contents, modules, microcode, BIOS/VGA/UEFI ROMs;
- Arch packages and AUR-built packages in the trimmed rootfs;
- fonts, icon packs, cursors, themes, wallpapers, sounds, and demo documents;
- browser app/offline page content and any screenshots of third-party services.

Remove any artifact whose redistribution rights are unclear. Do not rely on an upstream repository-level license to cover assets that carry their own notice.

## Required public surface

The production page must link a release-specific **Open source & licenses** view containing:

- Omarchy attribution, source pin, MIT text, upstream link, and patch list;
- QEMU-Wasm/QEMU attribution, GPL text, modification notice, and exact corresponding-source archive;
- kernel license/notices/config/patches and exact source archive;
- firmware notices and source locations;
- guest package/font/theme/wallpaper notices generated from the SBOM;
- website/runtime third-party notices;
- no-warranty language required by applicable licenses.

Place copies inside the downloadable `license-bundle` artifact as well. The artifact manifest lists the bundle's digest and one license record per core component.

## Release sign-off

- [ ] Omarchy repository, commit, version, tree digest, license, and patch series recorded.
- [ ] QEMU-Wasm repository/commit and all modifications recorded with complete corresponding source.
- [ ] Kernel config, patches, binary digest, license, and corresponding source recorded.
- [ ] Firmware/ROM inventory reviewed one file at a time.
- [ ] Final-rootfs and web-runtime SBOM generated; no unknown or forbidden license remains.
- [ ] All notices and source archives are reachable without authentication from the release page.
- [ ] Omarchy name/logo/trade-dress use and official/unofficial wording reviewed for trademark and endorsement risk.
- [ ] Privacy disclosure matches telemetry; guest networking is disabled or its destinations and data flow are disclosed.
- [ ] Export/sanctions and public-download policies reviewed by the responsible organization.
- [ ] A named release owner signs `LIC-001` automated evidence and `LIC-002` manual clearance.

Re-run this checklist whenever the Omarchy pin, emulator, kernel, rootfs package set, firmware, themes, fonts, or wallpapers change.
