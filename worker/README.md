# Immutable release artifact route

The Worker maps canonical URLs of the form
`/omarchy/versions/<release>/<artifact>` to the same R2 key without the leading
slash. `release` is the full 64-character lowercase SHA-256 of the exact
`artifact-manifest.json` bytes;
artifact path segments use a deliberately narrow ASCII grammar. Upload objects
to the logical `OMARCHY_ARTIFACTS` binding with:

- `customMetadata.sha256`: the lowercase, 64-character SHA-256 of the identity
  representation;
- optional `customMetadata.bytes`: its exact decimal byte length (validated
  against R2 when present);
- no `httpMetadata.contentEncoding`, or `identity`; and
- an accurate `httpMetadata.contentType` when known.

## Fail-closed publication clearance

Canonical artifact objects are intentionally allowed to exist while an upload
is incomplete, but none of them is public until the release pipeline
conditionally creates this immutable object last:

```text
omarchy/versions/<release>/clearance.json
```

The clearance object must use `Content-Type: application/json`, identity
encoding, exact `sha256` and `bytes` custom metadata, be no larger than 64 KiB,
and contain exactly this schema (objects with missing or additional members are
rejected):

```json
{
  "schemaVersion": 1,
  "releaseId": "<64 lowercase hex>",
  "artifactManifestSha256": "<same release ID>",
  "approvalEvidenceSha256": "<64 lowercase hex>",
  "approvalPolicySha256": "<64 lowercase hex>",
  "approvals": {
    "licensing": { "approved": true, "approvedAt": "2026-08-15T00:00:00.000Z", "approvedBy": "license-owner" },
    "runtime": { "approved": true, "approvedAt": "2026-08-15T00:00:00.000Z", "approvedBy": "runtime-owner" },
    "security": { "approved": true, "approvedAt": "2026-08-15T00:00:00.000Z", "approvedBy": "security-owner" },
    "product": { "approved": true, "approvedAt": "2026-08-15T00:00:00.000Z", "approvedBy": "product-owner" }
  }
}
```

The Worker verifies the clearance body and its stored digest before performing
even an R2 `head` for the requested artifact. This applies equally to `GET`,
`HEAD`, and ranged rootfs reads. An absent, malformed, or release-mismatched
clearance returns HTTP 404 with
`X-Omarchy-Artifact-Error: RELEASE_NOT_CLEARED`; a `HEAD` denial has no body.
Consequently a failed or partial upload cannot be discovered or downloaded
through this route.

Only a valid positive clearance is cached, scoped to the R2 binding and release
for the lifetime of the Worker isolate. Negative results are not cached, so a
newly cleared immutable release can become visible immediately. The clearance
object itself is served only after passing the same internal verification.

Every successful response synthesizes a strong SHA-256 ETag and RFC 9530
`Repr-Digest`, advertises byte ranges, disables representation transforms,
uses immutable caching, and carries the site's COOP/COEP/CORP isolation
headers.

`rootfs.ext4` has a stricter contract. A GET requires exactly one range of at
most 8 MiB and the synthetic ETag from a preceding HEAD in `If-Match`. The
Worker resolves metadata with `head`, pins the subsequent R2 request to the
underlying R2 ETag with `onlyIf.etagMatches`, and always supplies an explicit
R2 `{ offset, length }` range. A full rootfs GET—or a range selecting the whole
object—is rejected before R2 `get` is called.

Other release artifacts can be fetched whole up to 512 MiB or by one bounded
range. Larger artifacts must use byte ranges. R2 resources are provisioned and
wired by Sites from `.openai/hosting.json`; do not replace the logical binding
with a physical bucket name in source.

Run the focused contract tests with:

```sh
node --test worker/*.test.mjs
```
