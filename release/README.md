# Release assembly and R2 promotion

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
   symlink. Every byte length and SHA-256 is checked before any storage request.
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
   must pass `HEAD`; the rootfs must also pass `Range: bytes=0-0` with its
   synthetic strong SHA-256 `If-Match` validator.

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
