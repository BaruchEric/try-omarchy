# Immutable release artifact route

The Worker maps canonical URLs of the form
`/omarchy/versions/<release>/<artifact>` to the same R2 key without the leading
slash. `release` is an 8–64 character lowercase hexadecimal content address;
artifact path segments use a deliberately narrow ASCII grammar. Upload objects
to the logical `OMARCHY_ARTIFACTS` binding with:

- `customMetadata.sha256`: the lowercase, 64-character SHA-256 of the identity
  representation;
- optional `customMetadata.bytes`: its exact decimal byte length (validated
  against R2 when present);
- no `httpMetadata.contentEncoding`, or `identity`; and
- an accurate `httpMetadata.contentType` when known.

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
