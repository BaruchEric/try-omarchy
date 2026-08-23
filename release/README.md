# Release assembly and R2 promotion

The release assembler is the fail-closed boundary between independently built
guest/runtime artifacts and files that may be served by the website. It does
not build QEMU or Omarchy. It verifies every fragment size and SHA-256, refuses
path traversal and missing runtime assets, requires an SPDX SBOM, notice
bundle, and exact modified QEMU source bundle, then promotes one staging
directory atomically.

The production runtime contract is exact. A schema-2 `worker-paged`
`runtime-manifest.json` must identify these four distinct JavaScript assets,
and each path and role must appear exactly once in the artifact manifest:

- `production-worker.mjs` as `host-worker`;
- `worker-input.mjs` as `host-input-bridge`;
- `paged-disk.mjs` as `paged-disk-adapter`; and
- `bounded-overlay.mjs` as `snapshot-overlay-guard`.

Every record must have `text/javascript` media type, a positive byte length,
and a canonical SHA-256 that matches the copied file. Assembly and promotion
both enforce this relationship. Removing, aliasing, relabelling, changing the
media type of, or tampering with the bounded overlay therefore fails before a
release can be published.

`runtime/config/demo.json` is the single checked-in production VM profile.
Assembly and promotion deep-compare the packaged runtime manifest with that
source: object keys and values must be exact, and arrays (especially QEMU
arguments) must have the exact reviewed order and length. This pins the 1 GiB,
two-vCPU, multi-threaded TCG profile with a 128 MiB translation buffer;
graphical display and input devices; kernel, initramfs, and command line; paged
rootfs descriptor; diagnostic channels; and disabled network. QEMU's
last-option-wins parsing means even an otherwise valid duplicate or appended
`-m`, `-smp`, `-nic`, or `-display` option is rejected as profile drift.

The checked-in profile is always the exact cold-boot fallback. A packaged
runtime may add one optional schema-1 `checkpoint` block, but only as the exact
`preboot-resume` contract produced by `runtime/scripts/prepare-runtime-manifest.mjs`.
No individual checkpoint field or artifact is optional once that block exists.
Assembly adds these three files from the guest artifact directory, and both
assembly and promotion require their exact path, role, media type, positive
length, and lowercase SHA-256:

- `omarchy-preboot.vmstate` as `preboot-vmstate` with
  `application/vnd.qemu.vmstate`;
- `checkpoint-overlay.qcow2` as `preboot-disk-delta` with
  `application/vnd.qemu.qcow2`; and
- `checkpoint-manifest.json` as `preboot-checkpoint-metadata` with
  `application/json`.

The producer document is parsed rather than trusted as opaque metadata. It
must bind the raw QEMU 8.2 migration stream, qcow2 delta, native producer
binary, exact QEMU source/version and two-vCPU MTTCG machine profile, and an
immediately auto-running restore that requires no QMP `cont`. The qcow2 backing
filename must be the relative `rootfs.ext4` with raw backing format. Assembly
and promotion confirm both values from a bounded parse of the actual qcow2 v3
header and backing-format extension, and require its virtual size to equal the
verified rootfs byte length. These checks do not trust descriptor metadata. The
producer must also contain the authenticated source guest report and its recursively
key-sorted compact-JSON digest, plus the source report-validation and healthy
checkpoint-frame evidence digests. Release validation applies the same
official-Omarchy provenance, Arch/Wayland, live Hyprland/shell, successful
command, 1600×900 monitor, and upstream-config gates as the browser Worker.
The normalized checkpoint block additionally pins the exact base
`guest-manifest.json`, rootfs, guest provenance, and browser `qemu.wasm`
digests. Those five release records are independently checked by assembly and
promotion; the two JSON metadata files are capped at the browser's 4 MiB
verification limit.

Absence of the complete three-file set produces the explicit cold manifest at
runtime packaging. In release handling, a partial block, a declared-but-missing
file, an undeclared checkpoint artifact/role, a mismatched producer document,
or any backing/provenance/QEMU identity drift fails closed. It never silently
falls back to cold boot.

Copy `release-input.example.json` outside the repository's tracked files,
replace the example source URL with the immutable deployed corresponding-source
URL, and run:

```sh
node release/assemble.mjs --config /absolute/path/release-input.json
node scripts/verification/verify-artifact-manifest.mjs \
  artifacts/release-candidate/artifact-manifest.json \
  --artifact-root artifacts/release-candidate
```

Existing output directories are never replaced. A failed staging directory is
left beside the requested output for inspection and is never promoted. This
tool validates packaging mechanics; it does not replace the manual license,
corresponding-source, trademark, security, or browser acceptance gates in
`docs/`.

## Immutable R2 promotion

`promote.mjs` validates the assembled directory again and derives the release
ID as the lowercase SHA-256 of the **exact bytes** in
`artifact-manifest.json`. Whitespace and the trailing newline are part of the
identity. The same bytes are uploaded as
`omarchy/versions/<64-hex-release-id>/artifact-manifest.json`, so a browser can
verify the URL identity without implementing a second JSON canonicalization
scheme.

First perform a read-only validation and record the resulting full release ID:

```sh
cp release/promotion-input.example.json /absolute/path/promotion-input.json
node release/promote.mjs --config /absolute/path/promotion-input.json
```

An upload additionally needs:

- an R2 S3 API token limited to this bucket and the `omarchy/` prefix;
- four Ed25519-signed approvals bound to the exact release ID, manifest digest,
  and manifest byte length;
- a separately provisioned SHA-256 pin for the exact approval-policy bytes;
- the deployed clearance-gated artifact route; and
- a local immutable snapshot location on the same reflink-capable filesystem,
  or an explicit full-copy snapshot mode with enough free space.

Provide secrets and the independently managed policy pin only through the
environment, then opt in to writes explicitly:

```sh
export CLOUDFLARE_R2_ACCESS_KEY_ID='...'
export CLOUDFLARE_R2_SECRET_ACCESS_KEY='...'
export OMARCHY_APPROVAL_POLICY_SHA256='<64-hex digest provisioned by CI>'
node release/promote.mjs \
  --config /absolute/path/promotion-input.json \
  --upload
```

The upload path is fail-closed:

1. Every manifest path component must be a real directory/file rather than a
   symlink. Every byte length and SHA-256 is checked before any storage request,
   and the verified runtime manifest is bound again to the exact four
   production bootstrap/storage records and canonical VM profile above.
2. Four exact gate records are verified with Ed25519 keys from a policy whose
   file digest must match `OMARCHY_APPROVAL_POLICY_SHA256`. The all-zero example
   sentinel is always rejected.
3. Before any R2 write, the deployed route must deny every candidate URL with
   `404` and `X-Omarchy-Artifact-Error: RELEASE_NOT_CLEARED`. A generic 404 is
   insufficient evidence of the serving contract.
4. Every staging claim, canonical artifact key, and `clearance.json` key must
   be absent. Existing objects are never overwritten or treated as resumable.
5. A conditional small object at
   `omarchy/staging/<release-id>/claim.json` exclusively claims the release.
6. Every artifact is first frozen into a verified copy-on-write snapshot (or
   an explicitly requested full copy). Uploads read only that snapshot, closing
   the multipart whole-file time-of-check/time-of-use gap. Files stream with a
   global concurrency bound; the 6.4 GB rootfs is never buffered in memory.
7. Storage `HEAD` verifies byte length, generation, content type, identity
   content encoding, and exact `sha256`/`bytes` custom metadata for every
   canonical key. The immutable snapshot is hashed again after upload.
8. The deployed route must still deny all now-existing canonical artifacts as
   uncleared. Only then is `omarchy/versions/<release-id>/clearance.json`
   conditionally created. Its strict schema binds the release ID to the exact
   approval evidence and approval-policy digests.
9. Immediately after clearance, every deployed object (including clearance)
   must pass `HEAD`; the rootfs and, when declared, migration vmstate/delta
   must also pass `Range: bytes=0-0` with their synthetic strong SHA-256
   `If-Match` validators.

R2 does not provide a transaction spanning multiple objects, and its S3 API
does not provide a conditional `CompleteMultipartUpload` operation. The
retained conditional claim serializes this workflow; `clearance.json` is the
single-object publication boundary. The Worker route must validate clearance
before performing the target artifact `HEAD`/`GET`, and must return the exact
uncleared denial above when clearance is absent, malformed, or mismatched. A
failed run may leave partial canonical objects in R2, but those objects remain
unretrievable. The failed release must be inspected and cleaned up manually
before a deliberate retry—this tool refuses to resume or overwrite it.

The R2 adapter uses signed S3 requests, exact custom metadata, conditional
single-object writes, 64 MiB multipart parts by default, at most three parallel
artifact/part uploads by default, and best-effort multipart abort on failure.
No real external writes occur in the fixture tests.

## Signed approval contract

The approval file has exactly four records. Each record signs its gate,
decision, canonical millisecond UTC timestamp, signer identity, HTTPS evidence
URLs, key ID, release ID, and artifact-manifest identity. The policy has one
Ed25519 public key per gate:

- `licensing`: package licensing plus Omarchy name/logo/trademark approval;
- `runtime`: corresponding source plus firmware redistribution review;
- `security`: release security review; and
- `product`: browser acceptance evidence for this exact release.

See the intentionally non-authorizing `approvals.example.json`,
`approval-policy.example.json`, and `promotion.env.example`. Placeholder,
pending, unsigned, unpinned, wrong-release, extra-field, or missing-gate input
is rejected. The trusted policy SHA comes from a separately controlled CI
secret/variable, never from the same promotion config that selects the policy.

Successful assembly alone remains **not public-release authorization**. Until
all four real signatures and evidence exist, `--upload` cannot create a claim,
artifact, or clearance. The manual requirements in
`docs/legal-distribution.md` remain the source of the licensing gate decision.
