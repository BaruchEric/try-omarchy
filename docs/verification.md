# Verification architecture

The checks are split because no single layer can prove the demo. Static checks establish provenance and completeness, an in-guest probe establishes authenticity, and a browser runner establishes that real guest frames and input remain usable for the intended five-minute visit.

## Evidence flow

```text
pinned sources + build container
              |
              v
     artifact-manifest.json -----> static digest/size/license verification
              |
              v
       browser loads QEMU-Wasm + guest artifacts
              |                         |
              | framebuffer/input       | diagnostics channel
              v                         v
       Playwright-style runner <--- guest-report.json
              |
              v
       runtime-report.json + trace + video + screenshots + logs
```

Reports are untrusted inputs to the validators. CI must also retain their raw evidence. A valid JSON report alone does not prove the measurements happened.

## Local commands

These tools use only Node's standard library and work with the repository's Node 22 prerequisite.

```bash
node scripts/verification/verify-static.mjs

node scripts/verification/verify-artifact-manifest.mjs \
  public/omarchy/artifact-manifest.json \
  --artifact-root public/omarchy

node scripts/verification/verify-guest-report.mjs \
  artifacts/evidence/guest-report.json \
  --manifest public/omarchy/artifact-manifest.json

node scripts/verification/verify-runtime-report.mjs \
  artifacts/evidence/runtime-report.json

node scripts/verification/check-deployment.mjs \
  https://demo.example/ \
  --manifest /omarchy/artifact-manifest.json
```

Use `--json` on any validator for a machine-readable check report. `check-deployment.mjs` reads a single byte from each artifact rather than downloading disk images. Local development may pass `--allow-local-http`; release CI may not.

The validators use semantic exit codes:

- `0`: every check passed.
- `1`: valid input was checked and one or more gates failed.
- `2`: invocation, I/O, or JSON parsing failed, so no acceptance decision is possible.

## Artifact manifest producer contract

The image build writes `artifact-manifest.json` next to its versioned artifacts. Validate it against [`artifact-manifest.schema.json`](../scripts/verification/artifact-manifest.schema.json) and the stricter executable validator.

The manifest must include:

- official Omarchy repository, full immutable commit, displayed version, normalized tree SHA-256, and `MIT`;
- QEMU-Wasm fork repository/commit, its effective license, whether modified, and a URL for the exact corresponding source;
- reproducible-build inputs: UTC time, `SOURCE_DATE_EPOCH`, immutable builder image digest, and ideally CI workflow URL;
- x86_64 Arch guest and the fixed 1600×900 display;
- relative path, role, byte length, SHA-256, and media type for every released file;
- license records with component name, SPDX expression, notice path, and source URL.

Required artifact roles are `emulator-wasm`, `emulator-worker`, `guest-kernel`, `guest-rootfs`, `guest-metadata`, and `license-bundle`. Add firmware and snapshot roles when shipped. Paths are relative to the manifest directory and may not escape it.

Never publish a manifest before copying all files into their content-addressed final names. Generate it in a staging directory, verify it, then atomically promote the whole version directory.

## Guest report producer contract

The guest image includes a small read-only probe that runs after Hyprland and the selected Omarchy shell are ready. It emits [`guest-report.schema.json`](../scripts/verification/guest-report.schema.json) over the diagnostics channel. The build pipeline also runs the same probe before snapshot capture.

The probe collects facts rather than accepting browser-supplied claims:

- `/etc/os-release`, `uname`, kernel command line, and session type;
- Omarchy origin URL, commit, version, normalized source-tree digest, and base-image digest;
- compositor and shell binary paths/versions plus live PIDs and `/proc/<pid>/exe` targets;
- results of `uname -m`, `hyprctl version`, `hyprctl monitors -j`, and `omarchy-version`;
- SHA-256 and `omarchy-upstream` origin for the desktop configuration files copied from the pinned tree;
- renderer, virtual display, and relevant package versions as useful diagnostics.

Normalize the Omarchy tree digest deterministically: sort UTF-8 relative paths; reject symlinks outside the tree; hash each regular file's path, mode, length, and contents; exclude `.git`, caches, and the explicit web-patch directory. Store the exact algorithm/version in guest metadata.

The shell process name is not hardcoded in the validator because different pinned Omarchy releases may use different upstream shells. The report must name a `role: shell` component and prove a matching live process.

## Runtime report producer contract

The browser runner emits [`runtime-report.schema.json`](../scripts/verification/runtime-report.schema.json). Use browser automation with Chrome DevTools Protocol metrics when available, plus application instrumentation for frame sequence and input acknowledgement. The required journey step IDs and thresholds come from `acceptance-contract.json`.

Important measurements:

- Cold start begins at top-level navigation with a clean browser profile, service workers/caches cleared, and shaped network enabled.
- Cached start uses the same artifact version after one completed load, in a fresh page but retained HTTP cache.
- Desktop-ready requires guest event + non-black later frame + input round trip.
- Input latency begins at the browser's trusted/synthetic test input timestamp and ends on the first guest frame tagged after its guest acknowledgement.
- FPS counts changed guest framebuffer presentations during registered active-interaction intervals.
- Memory is peak private footprint for the page and worker processes where CDP exposes it; document the platform-specific collector.
- Black-frame detection samples the raw guest framebuffer before CSS overlays.

Each journey item is `{ "id": "...", "passed": true, "guestAck": true }` with timestamps and optional diagnostic details. `authenticity.framebufferSource` must be `qemu-guest`, never inferred from a canvas element merely existing.

## Visual tests

Capture raw guest-resolution PNGs at these checkpoints: desktop, menu open, terminal with identity output, two tiled clients, second workspace, and changed theme. Compare perceptually and with pixel diff after masking only registered dynamic rectangles.

Store baselines under a directory keyed by Omarchy commit, artifact-manifest digest, renderer, and resolution. A test cannot automatically update its own baseline in the same CI job. Baseline approval requires a side-by-side diff and guest provenance.

Add structural assertions alongside screenshots:

- `hyprctl monitors -j` reports exactly one 1600×900 monitor;
- `hyprctl clients -j` reports expected classes/PIDs and tiling geometry;
- active workspace changes as expected;
- theme identifier/config digest changes to the selected bundled theme;
- framebuffer sequence advances after each visible interaction.

## CI staging

### Stage 0 — every pull request, under two minutes

Run formatting/lint/type tests plus `verify-static.mjs` and the validator unit tests. Validate any checked-in metadata fixture. This stage has no VM artifacts or network dependency.

### Stage 1 — web shell, every pull request

Build the site, start it with production headers, and run browser tests for capability detection, accessible Start/Retry/Reset controls, focus capture/recovery, loading milestones, unsupported-browser error, asset failure, worker failure, and guest panic. Use a tiny deterministic emulator fixture; do not call it Omarchy.

### Stage 2 — image/runtime changes

Build from pinned sources in an immutable container. Generate SBOM, notices, source bundle, guest artifacts, and manifest. Run `verify-artifact-manifest.mjs`, boot natively under QEMU if possible, collect the guest report, and run `verify-guest-report.mjs`. Scan the artifacts before promotion.

### Stage 3 — release candidate browser gate

Serve the exact candidate with production compression/cache/header behavior. Run three cold and three cached trials on the reference host, the canonical journey, failure injections, reset test, and visual comparisons. Validate reports and deployment. Upload all raw evidence even on failure.

### Stage 4 — nightly matrix and soak

Run current/previous Chromium across macOS, Windows, and Linux reference workers. Perform a 30-minute soak, ten resets, repeated fullscreen/focus transitions, DPR 1/2 checks, memory growth analysis, and a throttled 25 Mbps diagnostic run. Experimental browsers report separately and do not weaken the Chromium release gate.

### Stage 5 — manual promotion

Require approvals from runtime, guest-image, product/visual, security, and license/brand owners. Confirm the candidate manifest digest, review synchronized video/serial log, verify corresponding-source download, then promote the immutable version and update the small channel pointer.

## Failure injection matrix

Automate at least these cases before release:

| Fault | Expected result |
| --- | --- |
| No WebAssembly threads or SharedArrayBuffer | Unsupported-browser explanation before artifact download |
| Insufficient memory/allocation failure | Named memory error, Retry and help, no desktop surface |
| Wasm 404 or digest mismatch | Asset-integrity error, retry uses the same pinned version |
| Rootfs range returns 200 | Delivery/configuration error detected before or during boot |
| Worker exception | Worker error and clean termination of remaining workers |
| Guest kernel panic | Panic state with Reset; serial log retained |
| Guest desktop process exits | Desktop failure with Reset; no HTML desktop substitution |
| Page blur/fullscreen exit | Keys released, pointer unlocked, focus can be reacquired |
| Network disappears after assets load | Running offline demo continues; no retry loop |
| Reset during boot | Workers terminate and the next start uses a pristine overlay |

## Release evidence bundle

Keep the following under one run ID:

```text
evidence/
  artifact-manifest.json
  guest-report.json
  runtime-report.json
  validation-results/
  browser-trace.zip
  browser-video.webm
  console.jsonl
  network.har
  guest-serial.log
  screenshots/
  visual-diffs/
  sbom.spdx.json
  notices/
  evidence.sha256
```

The release summary should distinguish “implemented,” “measured pass,” and “not yet measured.” A web shell or emulator terminal spike is useful progress but cannot be described as a working Omarchy browser demo until the blocking gates pass.
