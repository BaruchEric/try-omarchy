# Browser performance acceptance gate

This directory contains an independent, fail-closed performance contract and
the browser-realm trace producer that supplies it. It does not start QEMU or a
browser and does not read or modify `runtime/dist`. `producer.mjs` turns
private, lossless QEMU callbacks into one bounded JSON trace; `evaluate.mjs`
turns that trace into self-contained evidence.

```sh
node proofs/browser-performance/evaluate.mjs TRACE.json EXPECTED_IDENTITY.json
node proofs/browser-performance/evaluate.mjs TRACE.json EXPECTED_IDENTITY.json TARGETS.json
node --test proofs/browser-performance/gate.test.mjs
node --test proofs/browser-performance/producer.test.mjs
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
browser canvas paint, animation-frame callback, or public `guestframe.sequence`.

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
  "guestDescriptorSha256": "<64 lowercase hex characters or null>"
}
```

The first two digests are mandatory and non-zero. The guest descriptor digest
is mandatory when the runner knows it; otherwise its field remains explicitly
`null`. The gate compares all three fields with the
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

`BrowserPerformanceTraceProducer` implements the buffering and post-window
SHA-256 step now. `exportCapture()` returns:

```json
{
  "schemaVersion": 1,
  "traceSha256": "<SHA-256 of canonical trace JSON>",
  "trace": "<the trace object accepted by gate.mjs>"
}
```

The current evidence schema evaluates `trace`; callers must retain
`traceSha256` beside it. A later release-evidence schema still needs to bind or
sign that digest. The producer never labels an unhashed, active-window buffer
as `post-window-hashed`.

## Producer source contract

The producer must be constructed in the same Worker execution realm as the
QEMU module. Its two source objects are capabilities held by that trusted
composition root, not adapters exposed to the page, parent iframe protocol,
or test RPC:

This provenance boundary is architectural: JavaScript cannot prove that an
arbitrary caller-supplied object is QEMU. Release integration is conforming
only when the digest-verified production Worker creates these source objects
as private lexical capabilities around its native callbacks. Accepting source
objects or source callbacks from page messages, CDP injection, diagnostics,
or public `guestframe` is invalid even if their shapes match.

```js
const producer = createBrowserPerformanceTraceProducer({
  runId,
  identity,
  scanoutSource,
  inputDeliverySource,
});

producer.beginWindow({ windowId, challengeSha256 });
const receipt = producer.sendInput({
  inputId,
  actionDigest,
  kind: "key",
  deliverySource: "qemu-virtio-input-ring",
}, ({ receiptToken }) => dispatchInputWithReceipt(receiptToken));

await producer.endWindow();
const { trace, traceSha256 } = await producer.exportCapture();
```

`scanoutSource.openWindow(binding, handlers)` receives private `candidate` and
`present` callbacks. A candidate is exactly
`{ sourceSequence, candidateId, sample }`, where `sample` is a 576-entry
`Uint32Array` of 24-bit RGB values captured at the uncapped QEMU
virtio-gpu damage boundary. A present is exactly
`{ sourceSequence, candidateId }`. The producer clones samples immediately,
encodes each 24-bit value as R, G, B in the fixed 32×18 row-major order,
computes SHA-256 and pixel deltas itself, mints `scanoutEpoch` and
`presentSequence`, and freezes an epoch's `latestGuestInputSequence` before
any presents. Therefore a later input acknowledgement cannot mutate a
duplicate present of an older candidate. The source binding fixes the sample
geometry and encoding for the whole window.

`inputDeliverySource.openWindow(binding, handlers)` receives separate
`virtioDelivered` and `guestAcknowledged` callbacks. Each carries exactly
`{ sourceSequence, receiptToken }`. The producer creates the single-use token
before dispatch and hard-codes the resulting `deliverySource` from the private
callback used; neither a caller nor a public message can assert it. The token
is bound internally to the run, window, challenge, input ID, action digest,
kind, and selected acknowledgement mode.

Both `openWindow` calls return a session with `close()`. Closing is a source
barrier and must resolve to exactly
`{ sourceEvents, droppedEvents: 0 }`. Sequence gaps, a lossy barrier, malformed
or stale candidates, receipt replay/downgrade, sampling drift, clock
regression, a late callback, an unacknowledged input, or event-buffer overflow
latches a terminal producer failure. No partial trace can then be exported.

## Current browser exposure fails closed

`ExposedRuntimeTelemetryAudit` records the browser data available today, but
deliberately never converts it into trace events:

- public `guestframe` is sampled at about 250 ms and contains a public
  sequence, dimensions, sample count, and non-black count, but no internal
  scanout epoch, content sample/digest, exact delta, or causal input sequence;
- `sdl-frame-presented` diagnostics count host presentation and are
  bounded/sampled diagnostics, not guest damage epochs;
- public `inputaccepted` means the production Worker accepted/queued the
  event; `input-key-processed` is at the SDL handler and is also bounded. Both
  precede the virtio-input event ring.

Consequently, constructing the producer without both private sources makes
`beginWindow()` fail with `REQUIRED_INTERNAL_TELEMETRY_UNAVAILABLE`, even if
arbitrarily many public frames, present diagnostics, or Worker queue
acknowledgements were observed. This is the expected result for the current
unmodified isolated full-guest runtime.

## Smallest runtime hook map

No runtime files are changed by this proof directory. The minimum follow-up to
make the real isolated guest produce a trace is:

1. In QEMU's software virtio-gpu path, mint a monotonically increasing
   candidate ID only when `hw/display/virtio-gpu.c::virtio_gpu_resource_flush`
   updates the active scanout before `dpy_gfx_update`. Propagate that ID to
   `ui/sdl2-2d.c::sdl2_2d_update`, capture the fixed 32×18 sample from its
   `DisplaySurface`, call the private producer `candidate` hook before
   `SDL_RenderPresent`, and call `present` afterward. A redraw with no new
   armed candidate may only present the prior ID; it must not mint an epoch.
2. In QEMU's `hw/input/virtio-input.c::virtio_input_send`, acknowledge a bound
   input receipt only after all events through `SYN_REPORT` have obtained
   guest event-virtqueue elements, been `virtqueue_push`ed, and the queue has
   been notified. Carry the receipt from the Emscripten SDL input entry point
   through the synchronous QEMU input route. An authenticated guest echo can
   instead invoke the producer's stronger `guestAcknowledged` callback.
3. Instantiate `BrowserPerformanceTraceProducer` privately in
   `runtime/web/production-worker.mjs`, beside the QEMU `Module` callbacks;
   arm it with the release identity and animation challenge, carry its receipt
   with each test input, wait for both source barriers, and export only the
   sealed capture. Forward that one bounded capture through a newly validated
   Worker/host message rather than relabeling existing public messages.

Existing diagnostic formats identify why none can substitute for those
hooks. `runtime/patches/qemu-wasm-runstate-guard.patch` emits
`sdl-frame-presented sequence=…` for the first 16/powers of two, while the
same patch emits `input-key-queued` and `input-key-processed` at the SDL
queue/handler. `runtime/web/production-worker.mjs` posts ordinary
`guestframe` from the 250 ms sampler and posts `inputaccepted` immediately
after it defers or dispatches host input. Those formats remain useful
diagnostics, but they cannot satisfy this gate.

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
