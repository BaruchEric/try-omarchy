# Browser performance acceptance gate

This directory contains an independent, fail-closed performance contract. It
does not start QEMU or a browser and does not read or modify `runtime/dist`.
The eventual browser runner supplies one bounded JSON trace; `evaluate.mjs`
turns it into self-contained evidence.

```sh
node proofs/browser-performance/evaluate.mjs TRACE.json EXPECTED_IDENTITY.json
node proofs/browser-performance/evaluate.mjs TRACE.json EXPECTED_IDENTITY.json TARGETS.json
node --test proofs/browser-performance/gate.test.mjs
```

`EXPECTED_IDENTITY.json` comes from the candidate artifact set selected for the
run; it must not come from the trace producer. The evaluator requires an exact
match before a trace can pass.

`TARGETS.json` is a partial object using the keys exported in
`DEFAULT_PERFORMANCE_TARGETS`. Targets may be strengthened, but the unique-FPS
target cannot be lowered below 24.

## What counts as a frame

`scanoutEpoch` is an uncapped internal QEMU virtio-gpu scanout/damage epoch. It
must advance only when a guest SET_SCANOUT/resource-flush/damage operation
produces a new framebuffer-content candidate. It is not an SDL present count,
WebGL swap count, animation-frame callback, or public `guestframe.sequence`.

Several host presents may carry the same `scanoutEpoch`. They are retained in
the raw trace and reported as `duplicatePresents`, but count zero toward FPS.
Changing content metadata while reusing one epoch is a contract failure.

The current public frame-proof callback may be sampled at roughly one event per
250 ms, capping it near 4 Hz. Such telemetry cannot prove 24 FPS. A conforming
trace therefore declares:

```json
{
  "source": "qemu-virtio-gpu-scanout",
  "cadence": "uncapped-internal",
  "exportMode": "post-window-hashed"
}
```

Every unique epoch includes a fixed-size sampled-content digest and the exact
number of sampled pixels changed from the prior unique epoch. The first epoch
is a zero-delta baseline. Digest/delta disagreement fails the proof. The gate
reports both:

- `uniqueGuestFps = (uniqueScanoutEpochs - 1) / fullWindowSeconds`;
- `dynamicGuestFps = qualifyingContentChanges / fullWindowSeconds`.

Both must meet the target, at least 90% of unique intervals must be dynamic,
and no dynamic-frame gap may exceed 125 ms by default. Using the complete
challenge window as the denominator prevents a short burst from hiding a long
stall.

## What counts as accepted input

`input-accepted` means delivery at the QEMU virtio-input ring boundary, or a
stronger explicit guest acknowledgement. Its `deliverySource` must be either
`qemu-virtio-input-ring` or `guest-input-ack`. `SDL_PushEvent`, Worker queueing,
host dispatch, and similar telemetry do not demonstrate guest delivery and are
rejected.

Each input is bound to the animation challenge and a unique action digest. The
accepted event assigns a strictly increasing `guestInputSequence`. A frame is
causal only when it is a new, content-changing scanout epoch whose
`latestGuestInputSequence` includes that accepted sequence. Input latency is
measured from the raw send timestamp to both guest delivery and the first such
causal frame. Four complete interactions must span the active window by
default; queued-only input or one cherry-picked response cannot pass.

## Active-window and idle protections

The first and last raw events must be one matching, non-zero challenge pair:

- `window-start.activity = "guest-animation"`;
- `window-end.completion = "guest-animation-complete"`.

The default window is bounded to 1.5–5 seconds. Static desktops, fabricated
epoch increments with identical content, repeated presents, missing causal
input frames, late/bunched input, clock regressions, and incomplete windows all
fail closed. Raw events outside the window are not accepted.

## Evidence handling

Each trace carries this exact artifact identity:

```json
{
  "artifactManifestSha256": "<64 lowercase hex characters>",
  "runtimeManifestSha256": "<64 lowercase hex characters>",
  "guestDescriptorSha256": "<64 lowercase hex characters or null>",
  "hibernateDescriptorSha256": "<64 lowercase hex characters or null>"
}
```

The first two digests are mandatory and non-zero. Guest and hibernate
descriptor digests are mandatory when the runner knows them; otherwise their
fields remain explicitly `null`. The gate compares all four fields with the
independently supplied expected identity. Missing, malformed, or mismatched
identity fails closed, preventing a passing trace from another build from
being replayed against the candidate. Evidence preserves the trace identity at
top level and inside the raw trace.

The evidence object preserves a structured clone of every raw event and
timestamp, plus the unique-epoch timeline, duplicate count, frame gaps,
per-input causal timestamps, and minimum/median/p95/maximum latencies. Failed
runs preserve the same data alongside stable failure codes.

The eventual browser runner should keep uncapped counters, fixed-size sample
digests, and timestamps in a bounded internal buffer. It should export only
after `window-end`, hash the canonical raw trace, and bind or sign that digest
with the release identity and animation challenge. Streaming the currently
sampled public `guestframe` callback into this gate is explicitly invalid.

## Default acceptance targets

| Target | Default |
| --- | ---: |
| Unique and dynamic guest FPS | 24 |
| Window duration | 1,500–5,000 ms |
| Complete interaction samples | 4 |
| Input send → virtio/guest delivery | ≤50 ms |
| Input send → causal dynamic scanout | ≤100 ms |
| Maximum dynamic-frame gap | 125 ms |
| Sample size | ≥256 pixels |
| Qualifying change | ≥4 pixels and ≥1% |
| Dynamic unique-epoch ratio | ≥90% |

The deterministic hostile tests prove that duplicate presents cannot inflate
FPS, static epochs cannot pass, public sampled telemetry is rejected, and
host-queued input cannot satisfy guest-delivery acceptance.
