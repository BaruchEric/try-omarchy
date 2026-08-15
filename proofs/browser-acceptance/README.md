# Exact browser acceptance gate

This gate drives the real production `/vm/index.html` iframe and its verified
module Worker against a supplied **local** release. It does not load the looser
development `full-guest.html` page, inject a simulated Worker, or accept a
phase named `running` as proof of a desktop.

The runner creates an isolated same-origin proxy so the unmodified production
host can enforce its immutable `/omarchy/versions/<artifact-manifest-sha256>/`
URL. The upstream URL must be HTTP(S) on `localhost`, `127.0.0.1`, or `::1` and
must expose `artifact-manifest.json` plus the declared artifacts.

## Pass contract

A run passes only after this exact order is observed through the production
parent/iframe protocol:

1. The SHA-256 of the fetched artifact manifest equals the release ID used by
   the iframe, and its repository, commit, version, and tree hash equal the
   pinned Basecamp Omarchy source.
2. Guest-report provenance is preserved across the Worker, isolated host, and
   acceptance contract. Cold boot requires `live-guest-serial`. Migration
   resume requires `checkpoint-source-evidence` plus all four release-bound
   source-evidence SHA-256 digests. Guest hibernation instead requires one
   ordered `hibernationresume` event bound to the exact
   `hibernate-manifest.json` SHA-256, source boot, swap UUID, marker, renderer
   report, derived initramfs, and three ordered kernel-resume milestones. Only
   then may a fresh report with `live-hibernation-serial` be accepted; the
   producer's pre-hibernate report is never replayed.
3. The guest-authored report proves Arch Linux x86_64, Wayland, live Hyprland
   and Quickshell processes, the required successful commands, one active
   1600×900 monitor, the installed Omarchy version, and upstream config hashes.
4. After that exact report, the production Worker emits one strict
   `desktopproof`. It binds the release digest and hashed internal guest
   challenge to two already-observed 32×18 framebuffer samples. At least 29 of
   576 samples must change after Super+Return, and no color may dominate more
   than 547 samples. The Worker emits this only after the guest returns the
   exact challenge through its diagnostics device.
5. A still-later qualifying QEMU guest frame arrives with a sequence greater
   than the proof response frame. The production canvas must also report
   pixel-perfect 1600×900 at DPR 1. `inputaccepted` queue acknowledgements are
   retained as diagnostics and never contribute to PASS.
6. The final 1600×900 PNG contains at least 16 RGB colors and no single exact
   RGB color occupies more than 95% of its pixels.

Duplicate identities/reports/proofs, malformed or replayed active-iframe
messages, failed or exited phases, non-monotonic frames, unobserved proof frame
references, stage/total timeouts, an uncaught page exception, weak or visually
degenerate screenshots, console errors, and unsafe disk access all fail the
run. After the PNG and request ledger are complete, the runner re-reads the
live contract and error streams so a late failure cannot be persisted as a
stale PASS. Rootfs, migration-state/delta, and hibernation root-delta/swap GETs
must be exact ranges no larger than 8 MiB, carry the artifact digest in
`If-Match`, return 206, and return exactly the requested byte count.

## Run

First start a local release server. For the repository's no-copy full guest
server this is typically:

```sh
node runtime/scripts/serve-full-guest.mjs \
  --runtime-root runtime/dist \
  --guest-root guest/dist \
  --web-root runtime/web \
  --host 127.0.0.1 \
  --port 8094
```

In a second terminal run the acceptance gate (it does not stop or reconfigure
the supplied server):

```sh
node proofs/browser-acceptance/run.mjs \
  --release-base http://127.0.0.1:8094/release/
```

Use `--browser-executable` to select a Chromium-family binary and `--output`
to require a particular new evidence directory. Defaults are a detected local
Brave/Chrome/Chromium and a timestamped directory below `evidence/`.

Every completed attempt persists `evidence.json`, `requests.json`, the exact
`artifact-manifest.json`, and `hashes.json`; a run with a capturable browser
target also persists `desktop.png` (an accepted run requires it to be an exact,
credible 1600×900 render). `SHA256SUMS` binds all persisted files. Failed
attempts exit non-zero and carry `verdict: "failed"`; no partial or timed-out
result can be promoted to PASS.

The proxy snapshots the production host, shared validators, browser harness,
and evidence tooling before it listens. Their byte counts and SHA-256 digests
are recorded under `acceptanceSources` in `hashes.json`, so files changed during
a run cannot produce an unbound hybrid result.

Run the deterministic contract, proxy, and parser checks without booting a VM:

```sh
node --test proofs/browser-acceptance/acceptance.test.mjs
node --test proofs/browser-acceptance/hibernation-bootstrap.test.mjs
npx eslint proofs/browser-acceptance
git diff --check -- proofs/browser-acceptance
```

An opt-in synthetic browser smoke verifies the automation and evidence plumbing
without claiming to prove a real guest:

```sh
OMARCHY_SYNTHETIC_BROWSER_SMOKE=1 \
  node --test proofs/browser-acceptance/synthetic-browser.test.mjs
```
