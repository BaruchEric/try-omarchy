# Release assembler

The release assembler is the fail-closed boundary between independently built
guest/runtime artifacts and files that may be served by the website. It does
not build QEMU or Omarchy. It verifies every fragment size and SHA-256, refuses
path traversal and missing runtime assets, requires an SPDX SBOM, notice
bundle, and exact modified QEMU source bundle, then promotes one staging
directory atomically.

Copy `release-input.example.json` outside the repository's tracked files,
replace the example source URL with the immutable deployed corresponding-source
URL, and run:

```sh
node release/assemble.mjs --config /absolute/path/release-input.json
node scripts/verification/verify-artifact-manifest.mjs \
  public/omarchy/versions/f0020448/artifact-manifest.json \
  --artifact-root public/omarchy/versions/f0020448
```

Existing output directories are never replaced. A failed staging directory is
left beside the requested output for inspection and is never promoted. This
tool validates packaging mechanics; it does not replace the manual license,
corresponding-source, trademark, security, or browser acceptance gates in
`docs/`.
