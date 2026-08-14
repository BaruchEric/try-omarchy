# Five-minute demo acceptance plan

## Release definition

A release is acceptable only when a visitor can start a disposable, client-side x86_64 virtual machine and interact for five minutes with a pinned build of the real Omarchy desktop. The browser may draw loading, help, fullscreen, restart, and error controls. The desktop surface itself must be the guest framebuffer produced by Hyprland and the Omarchy desktop processes inside the VM.

An HTML/CSS screenshot, video, remote desktop, or reimplementation is never a passing fallback. If WebAssembly, threads, memory, or assets are unavailable, the page must say that the demo cannot run on that browser.

The numeric source of truth is [`acceptance-contract.json`](../scripts/verification/acceptance-contract.json). This document explains how to gather the evidence.

## What “real Omarchy” means

All of the following must be true in the same recorded run:

1. The guest is x86_64 Arch Linux booted with a Linux kernel in the browser-side emulator.
2. The image contains an unambiguous Omarchy source pin: official repository, full commit SHA, version, and normalized tree digest.
3. Hyprland, the desktop shell selected by that pinned Omarchy revision, and Omarchy scripts execute as guest processes. The build must not mix UI or configuration from different Omarchy revisions.
4. The installed desktop configuration files are copied from the pinned upstream tree. Every web-hardware patch is separately listed and reviewable.
5. Browser input becomes virtual keyboard/pointer input. Visible desktop pixels return from QEMU's guest display device.
6. Menu actions, window tiling, workspace changes, theme changes, and identity commands receive evidence from inside the guest—not inferred solely from DOM state or screenshots.

Permitted web-edition changes include a virtual-monitor profile, software-renderer settings, disabled hardware services, offline demo content, a disposable user, and reduced animation settings. Replacing Hyprland, replacing Omarchy's menu/theme code, or drawing the desktop in the web app is not permitted.

## Reference test profile

Release measurements use current stable Chromium with hardware acceleration, four modern performance CPU cores, 8 GiB available RAM, a 1600×900 DPR-1 viewport, and a shaped 100 Mbps/20 ms network. Run three cold-cache and three warm-cache trials. Use the median except where a named percentile is required. Record the exact browser, host OS, CPU, RAM, and throttling configuration in every report.

The release also receives a functional browser matrix on current and previous stable Chromium on macOS, Windows, and Linux. Firefox and Safari may be listed as experimental until their complete run passes the same blocking gates; they must not silently receive a reproduction.

## Canonical five-minute journey

The automation runner timestamps browser events, framebuffer sequence numbers, and guest acknowledgements using a shared run ID. It saves the browser trace, video, screenshots, console, network log, serial log, guest report, and runtime report.

1. Navigate with an empty cache, verify capability detection, and click **Start demo**. Do not start download timing before navigation.
2. `desktop-visible`: wait for the guest agent's desktop-ready event and for a non-black framebuffer from the matching sequence.
3. `menu-open`: send the pinned Omarchy menu shortcut. Verify the expected menu process/window through the guest agent and save a framebuffer screenshot.
4. `terminal-open`: choose Terminal through the actual menu or shortcut. Confirm the terminal client through `hyprctl clients -j`.
5. `identity-command`: type the release's identity command sequence. Capture successful output from `uname -m`, `omarchy-version`, and `hyprctl version`; compare it with the manifest.
6. `second-app-open`: launch the lightweight second app declared in guest metadata. Verify its guest PID and Hyprland client.
7. `windows-tiled`: verify both clients have non-overlapping geometry inside the 1600×900 monitor and are not floating.
8. `workspace-switch`: switch away and back using Omarchy's binding. Confirm `hyprctl activeworkspace -j` changes twice.
9. `theme-change`: invoke Omarchy's real theme UI, select a different bundled theme, and confirm its guest-side theme/config digest and a later framebuffer sequence change.
10. Keep interacting until at least four minutes have elapsed, then `terminal-close` through the real Omarchy binding. The whole measured journey must be 240–360 seconds.
11. `demo-reset`: create a marker in the writable overlay, reset the demo, and prove after restart that the marker is absent while the base image digest is unchanged.

On hosts where the browser or operating system reserves the Super key, the browser's shortcut palette may send the equivalent virtual scancodes. The step passes only if the guest acknowledges the binding's result.

## Blocking gates

### Authenticity

- `AUTH-001`: the artifact manifest pins `https://github.com/basecamp/omarchy` to a full 40-character commit and records version, tree digest, and MIT notice.
- `AUTH-002`: a guest-generated report proves x86_64 Arch Linux and matches the manifest's Omarchy commit/version/tree digest.
- `AUTH-003`: the report contains the Hyprland executable/version and a live Hyprland PID; `hyprctl version` succeeds in that process's session.
- `AUTH-004`: runtime instrumentation identifies frames as `qemu-guest`, identity evidence as `guest-agent`, and every journey step has a guest acknowledgement.
- `AUTH-005`: a human reviews the synchronized video and serial log. The app must have no DOM-rendered element that can be mistaken for a successfully running desktop.

### Boot and failure behavior

- `BOOT-001`: median cold-cache navigation-to-interactive-desktop time is no more than 45 seconds.
- `BOOT-002`: median warm-cache navigation-to-interactive-desktop time is no more than 15 seconds.
- `BOOT-003`: tests corrupt each critical asset once, remove thread support once, and force a guest panic once. Each case ends in a named error with Retry/Reset; none reveals a fake desktop or infinite loader.

“Interactive desktop” means the desktop-ready guest event, a later non-black frame, and a successful input round trip. A progress bar reaching 100% is not desktop-ready.

### Display quality

- `DISP-001`: the guest monitor is exactly 1600×900. Canvas backing width/height equal CSS size multiplied by device pixel ratio, and the captured pixel format is `xrgb8888`.
- `DISP-002`: desktop, open menu, terminal, two tiled windows, and changed theme pass visual regression. Mask only clocks, cursors, process counters, and explicitly registered animation rectangles. Keep separate references for each pinned Omarchy update.
- `DISP-003`: a reviewer checks fitted and fullscreen rendering at DPR 1 and 2 for crisp text, correct aspect ratio/letterboxing, no crop, no double cursor, and correct pointer mapping at all four corners.

Visual regression is supporting evidence, not authenticity evidence. Reference images must themselves come from the pinned guest and be linked to its artifact-manifest digest.

### Input

- `INP-001`: automation exercises printable keys, Enter, Escape, arrows, Super/Control/Alt/Shift chords, pointer movement, both buttons, wheel, blur/refocus, pointer lock, and at least one browser shortcut alternative.
- `INP-002`: input-event-to-first-changed-guest-frame latency is at most 150 ms at p95 over at least 100 samples distributed across the five-minute run. Do not substitute DOM handler latency.

### Journey and reset

- `RUN-001`: all ten machine-readable journey steps pass within 240–360 seconds, with browser evidence and guest acknowledgements sharing the run ID.
- `RUN-002`: reset removes files and settings written to the overlay, restores the pristine base image, and does not require a page hard refresh. Repeat reset ten times in the nightly soak.

### Performance and stability

- `PERF-001`: changed-frame sampling during active interaction is at least 20 FPS p50 and 12 FPS p05. Loading screens and idle seconds are excluded, but excluded intervals are recorded.
- `PERF-002`: peak browser-process memory is at most 2560 MiB on the reference profile, the five-minute run has zero emulator/worker/guest crash, and the browser remains responsive.
- `PERF-003`: after desktop-ready, no all-black framebuffer interval lasts more than 2000 ms except an explicitly initiated guest transition. A transition must be guest-logged and is still shown in the report.

### Web delivery

- `WEB-001`: production HTML returns `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` or `credentialless`; the browser reports both `crossOriginIsolated` and `SharedArrayBuffer` as available.
- `WEB-002`: every large, content-addressed runtime/guest artifact honors `Range: bytes=0-0` with HTTP 206 and a correct `Content-Range`; assets use immutable caching; WebAssembly uses `application/wasm`.
- `WEB-003`: a five-minute run has no uncaught page exception, console error, failed required request, or unexpected guest-originated external request. An explicit allowlist is empty by default.

### Distribution clearance

- `LIC-001`: the artifact manifest and downloadable notice bundle cover Omarchy, QEMU-Wasm, Linux, firmware, each shipped Arch package, fonts, icons, themes, and wallpapers; the release includes an SBOM.
- `LIC-002`: a release owner signs off corresponding-source delivery and permission to use the Omarchy name/logo for the public demo. See [legal distribution](legal-distribution.md).

## Evidence integrity

Every report includes the artifact-manifest SHA-256, release commit, CI run URL, browser version, and a random run ID. Retain reports, trace, screenshots, video, serial output, and network log together. The release job hashes the evidence bundle and publishes the digest with the release candidate.

Guest evidence travels over a read-only diagnostics channel isolated from ordinary demo UI messages. Each request has a nonce; the browser test rejects stale acknowledgements. The guest agent should emit JSON Lines so partial boot logs remain useful after a crash.

## Stop-ship rules

Any failed blocking gate stops public promotion. Performance waivers must change the numeric contract in review; they cannot be hidden in an individual report. An Omarchy update invalidates visual baselines and requires a new image, manifest, SBOM, guest report, five-minute run, and license review.
