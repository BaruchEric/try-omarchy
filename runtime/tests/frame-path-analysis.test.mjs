import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeFramePath,
  parseFrameDiagnostics,
} from "../scripts/analyze-frame-path.mjs";

const diagnostics = [
  "sdl-surface-switch sequence=1 monotonic-ms=0 width=1600 height=900 format=537004168 running=1",
  "sdl-texture-created monotonic-ms=1 texture=0x1 width=1600 height=900 format=372645892 error=none",
  "sdl-frame-presented sequence=5 monotonic-ms=10 width=1600 height=900 update-x=0 update-y=0 update-width=1600 update-height=900 running=1",
  "sdl-frame-presented sequence=6 monotonic-ms=20 width=1600 height=900 update-x=0 update-y=0 update-width=1600 update-height=900 running=1",
  "sdl-surface-switch sequence=2 monotonic-ms=500 width=1600 height=900 format=537004168 running=1",
  "sdl-texture-reused monotonic-ms=501 texture=0x1 width=1600 height=900 format=372645892",
  "sdl-frame-presented sequence=7 monotonic-ms=510 width=1600 height=900 update-x=0 update-y=0 update-width=1600 update-height=900 running=1",
  "sdl-frame-presented sequence=8 monotonic-ms=520 width=1600 height=900 update-x=0 update-y=0 update-width=1600 update-height=900 running=1",
  "sdl-surface-switch sequence=3 monotonic-ms=1000 width=1600 height=900 format=537004168 running=1",
  "sdl-texture-reused monotonic-ms=1001 texture=0x1 width=1600 height=900 format=372645892",
  "sdl-frame-presented sequence=9 monotonic-ms=1010 width=1600 height=900 update-x=0 update-y=0 update-width=1600 update-height=900 running=1",
];

const mirroredLog = diagnostics.flatMap((payload) => [
  `[stderr] OMARCHY_RUNTIME_DIAGNOSTIC ${payload}`,
  `[runtime] OMARCHY_RUNTIME_DIAGNOSTIC ${payload}`,
]).join("\n");

test("frame-path diagnostics remove Worker mirrors without dropping real events", () => {
  const parsed = parseFrameDiagnostics(mirroredLog);
  assert.equal(parsed.events.length, diagnostics.length);
  assert.equal(parsed.mirroredLinesDropped, diagnostics.length);
});

test("frame-path analysis separates mode creation from duplicate reused page flips", () => {
  const result = analyzeFramePath(mirroredLog);

  assert.deepEqual(result.display, { width: 1600, height: 900, pixels: 1_440_000 });
  assert.equal(result.pageflips.observedSwitches, 3);
  assert.equal(result.pageflips.textureReusedSwitches, 2);
  assert.equal(result.pageflips.measuredReusedSwitches, 2);
  assert.equal(result.pageflips.measuredReusedSwitchesWithImmediateDoublePresent, 1);
  assert.equal(result.pageflips.estimatedAvoidableFullFramePresents, 1);
  assert.equal(result.pageflips.estimatedAvoidableUploadedPixels, 1_440_000);
  assert.equal(result.pageflips.switchIntervalMs.median, 500);
  assert.equal(result.pageflips.medianRateHzProxy, 2);
  assert.equal(result.pageflips.duplicateFollowupGapMs.median, 10);
});
