# Releasing

Releases are Apple Silicon-only and require macOS 15 or newer.

## Build and verify

```sh
make doctor
make test
make build
make package
```

Outputs are written to:

- `dist/Try Omarchy.app`
- `dist/Try Omarchy.dmg`
- `dist/guest/`

Local builds are ad-hoc signed. For distribution, pass a Developer ID identity
and a configured notarytool keychain profile directly to the app builder:

```sh
macos/build-app.sh \
  --dmg \
  --guest-dir dist/guest \
  --sign-identity "Developer ID Application: Example (TEAMID)" \
  --notarize-profile try-omarchy
```

## Release checklist

1. Confirm `main` is clean and all pinned inputs have reviewable provenance.
2. Run all tests and perform a first-boot provisioning test on a clean Mac user.
3. Verify networking, display scaling, keyboard/mouse, microphone permission,
   audio-device changes, persistence, reset, and ephemeral mode.
4. Verify the app and DMG signatures with Apple's tools and confirm notarization.
5. Audit `THIRD_PARTY_NOTICES.md`, the bundle's license material, the guest
   package lock, and QEMU corresponding-source obligations.
6. Record SHA-256 digests for the final app archive/DMG and publish them with the
   release notes.

Never publish generated artifacts from an unreviewed or locally modified build
input.
