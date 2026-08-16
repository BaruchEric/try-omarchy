# Omarchy preboot checkpoint proof

This proof creates and independently restores the canonical Omarchy guest's
preboot checkpoint without modifying `guest/` or `runtime/`.

The producer and fresh restore target use one exact profile:

- pinned QEMU 8.2.0 source commit
  `0ef7b4e2814b231705d8371dd7997f5b72e70baf`;
- `pc-q35-8.2`, 1024 MiB RAM;
- `2,sockets=1,cores=2,threads=1`;
- `tcg,tb-size=128,thread=multi` (MTTCG);
- one virtio VGA output at 1600×900, virtio keyboard/tablet, no network;
- canonical Quattro guest manifest SHA-256
  `3acfd08df3e4f4e8338788c304822b1f255b62a81893ab0381e0e15636e826f0`;
- canonical Quattro rootfs SHA-256
  `e1733e3f4f5120cd8a5ce792d115ffbe371468d79712c729efaec81266f793cc`.

The proof rejects CPU-count, accelerator, machine, RAM, guest-identity, or
migration-compression overrides. This profile is intentionally different from
the abandoned one-vCPU experiment: two MTTCG vCPUs are part of the current
checkpoint compatibility identity.

## Acceptance gates

The source must emit exactly one authentic `OMARCHY_GUEST_REPORT`, and that
report must verify against the canonical manifest and describe one live
1600×900 Hyprland monitor. It must then produce two consecutive structurally
healthy 1600×900 frames. The structural frame gate rejects blank/dominant-color
placeholders and Hyprland's red configuration-error banner while recognizing
the real Quickshell bar and wallpaper.

The source receives paced, explicit Super+Return key-down/key-up transitions.
The proof requires a healthy Foot frame and a material framebuffer delta. It
then closes Foot through Omarchy's real Super+W binding and requires the clean
desktop to return before checkpointing.

Native QMP terminal text is deliberately not an acceptance gate. QMP command
acknowledgement did not reliably imply delivery to a focused Foot prompt under
TCG. Browser acceptance instead consumes the manifest-bound authenticated
source report and must produce a fresh randomized, causal post-resume desktop
text acknowledgement.

## Checkpoint artifacts

The package contains:

- `omarchy-preboot.vmstate`: raw, uncompressed QEMU 8.2 file migration state;
- `checkpoint-overlay.qcow2`: boot-time disk delta with relative backing
  filename `rootfs.ext4` and backing format `raw`;
- `checkpoint-manifest.json`: artifact hashes/sizes, exact machine and QEMU
  identity, auto-run restore contract, and digests binding the authenticated
  source report plus the clean checkpoint framebuffer evidence;
- `SHA256SUMS`: the two artifacts and manifest.

The source starts migration while its runstate is `running`. QEMU performs its
stop-and-copy phase, enters `postmigrate`, and exits before the disk delta is
frozen. A distinct fresh target attaches the frozen delta with `-snapshot` and
uses immediate CLI `-incoming file:...`. It must become `running` without QMP
`cont`, `migrate-incoming`, deferred incoming, or compression setup. Those
properties are necessary because the browser Worker has no pre-main/post-load
QMP control path.

The fresh target must then produce two healthy 1600×900 frames and visibly open
Foot through paced Super+Return input. Artifact hashes are checked before and
after this disposable restore smoke.

## Run

```sh
BUILD_JOBS=8 proofs/preboot-resume/build-pinned-qemu.sh
proofs/preboot-resume/run.sh
```

Static checks do not boot the guest:

```sh
node --test proofs/preboot-resume/static.test.mjs
```

Each run writes ignored evidence beneath `proofs/preboot-resume/evidence/`.
`evidence/latest.txt` is updated only after the independent validator passes.

## Canonical result (2026-08-15)

Run `20260815T090344Z-qemu8-2vcpu-mttcg-raw-auto-2941` passed the full native
source → checkpoint → distinct fresh immediate-incoming target chain:

- authentic guest report: 335,254 ms;
- cold source to clean checkpoint-ready state: 795,314 ms;
- raw checkpoint creation: 8,230 ms;
- fresh target launch to automatically running: 1,632 ms;
- fresh target launch to two healthy restored frames: 16,424 ms;
- restored healthy-desktop speedup: 48.42×;
- post-resume Foot appearance proof: another 52,677 ms;
- raw vmstate: 1,058,433,626 bytes,
  SHA-256 `9efc7d07f0565c2ab1e10c2b28c8acb72d664a75ed51e69e4074e86b9c387fa3`;
- qcow2 boot delta: 27,721,728 bytes,
  SHA-256 `1d3c0f02c8e126ebd79ef30a42a0eac1388ded1e91ec7c010e0e8ae81d9476a1`;
- checkpoint manifest SHA-256
  `92b7e46eb55021c55d1314808de4309fd31f997a5d2c96ebee92521f27fefae3`.

The target diagnostics file is empty, confirming that the source guest's
already-consumed unique report is not replayed by migration. Therefore the
browser integration must authenticate the report from the manifest's bound
`sourceEvidence`, label its origin as checkpoint source evidence, and then arm
the live post-resume randomized desktop proof. Waiting for a second serial
report would deadlock.

This result is a trustworthy native checkpoint artifact handoff, not browser
acceptance. Browser acceptance still has to range-deliver the raw vmstate,
paired qcow2 delta, and exact rootfs; verify the release/manifest identity;
measure actual Worker load latency and memory; and pass the fresh live pixel and
randomized text challenge.
