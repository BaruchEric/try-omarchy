# Omarchy native ARM64 helper

This helper is the fast Apple Silicon path. It boots `guest/dist-aarch64` with
Apple's Virtualization.framework: ARM instructions execute directly on Apple
Silicon, while storage, graphics, keyboard, pointer, entropy, serial, and memory
balloon devices use Apple's Virtio implementations. It does not contain QEMU or
an x86 translator.

The first launch is a native cold boot. After the guest emits the exact pinned
Quattro authenticity report, the helper pauses it, APFS-clones its disk, saves a
host-bound encrypted VM state, and resumes it. Later launches restore that pair.
The cache identity is the SHA-256 of `guest-manifest.json`; any guest update gets
a new state and cannot consume an old disk/memory pair.

Build, test, and ad-hoc sign with the required entitlement:

```bash
cd native/macos
swift test
swift build -c release
codesign --force --sign - \
  --entitlements omarchy-vm-helper.entitlements \
  .build/release/omarchy-vm-helper
```

For a local developer run, the repo-local wrapper performs the release build,
ad-hoc signing, complete guest validation, and direct launch in one command:

```bash
./native/macos/build-sign-run.sh
```

It is intentionally a development script, not a distributable or notarized
macOS application bundle.

Inspect capabilities and verify the complete guest bundle before launching:

```bash
.build/release/omarchy-vm-helper --capabilities
.build/release/omarchy-vm-helper --validate ../../guest/dist-aarch64
.build/release/omarchy-vm-helper --run ../../guest/dist-aarch64
```

To let the local demo page select the native runtime automatically, keep the
signed helper running with the exact page origin. The service binds only IPv4
loopback, rejects every other `Origin`, echoes a fresh 256-bit browser
challenge, and launches at most one native VM child at a time:

```bash
.build/release/omarchy-vm-helper --serve ../../guest/dist-aarch64 \
  --allowed-origin http://localhost:3000
```

Use `--no-resume` only for a deliberate cold-boot proof. Save states are tied by
Virtualization.framework to the Mac that created them and are never distributable
release artifacts.

Each launch owns its disposable `omarchy-native-*` disk directory with an
advisory lock. Normal window close, Command-Q, SIGINT, and SIGTERM remove it;
after a crash or SIGKILL, a later launch removes only directories carrying the
new exact marker whose lock is no longer held. Legacy directories without a
lock are deliberately left untouched because another older helper could still
be using them.

## WebRTC capture mode

The local WebRTC proof uses the same hardware-virtualized guest and host-bound
resume state. Run the helper with the exact loopback POC origin and a borderless
1600×900 window:

```bash
.build/release/omarchy-vm-helper --serve ../../guest/dist-aarch64 \
  --allowed-origin http://127.0.0.1:8110 \
  --stream-window
```

Then run `npm run stream:poc` from the repository root and open
`http://127.0.0.1:8110/`. The capture-host page launches the VM, asks the browser
to share the Omarchy window, sends the resulting track over WebRTC, and relays
the viewer's ordered data-channel input to `/v1/input`.

Every input request must contain the unpredictable token from the accepted
launch. The loopback helper additionally binds one exact browser origin, accepts
only bounded keyboard/pointer/wheel schemas, and posts events only to that VM
child process. It refuses input unless macOS Accessibility trust is active.
Restarting or closing the VM invalidates the token.

The capture host sends a token-bound `/v1/stop` when sharing ends or the page is
closed. The helper also terminates its VM child on `SIGINT`/`SIGTERM` and applies
a 30-minute hard session lease, so an abandoned POC cannot consume host compute
indefinitely.

macOS may require:

- Screen Recording permission for the browser that captures the Omarchy window.
- Accessibility permission for `omarchy-vm-helper` to relay remote input.

The browser's manual window-selection prompt is intentional and cannot be
bypassed by a web page. A production service replaces the capture-host tab with
an authenticated server-side encoder and adds TURN; the viewer and input
protocol remain applicable.
