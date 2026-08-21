import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const host = readFileSync(new URL("../web/webrtc-host.mjs", import.meta.url), "utf8");
const viewer = readFileSync(new URL("../web/webrtc-viewer.mjs", import.meta.url), "utf8");
const viewerHTML = readFileSync(new URL("../web/webrtc-viewer.html", import.meta.url), "utf8");

test("WebRTC host uses a real video track and reliable input channel", () => {
  assert.match(host, /getDisplayMedia/);
  assert.match(host, /captureStream\(60\)/);
  assert.match(host, /contentHint = "motion"/);
  assert.match(host, /degradationPreference = "maintain-framerate"/);
  assert.match(host, /createDataChannel\("omarchy-input", \{ ordered: true \}\)/);
  assert.match(host, /\/v1\/input/);
  assert.match(host, /\/v1\/stop/);
  assert.match(host, /nativeCapabilityIdentity/);
  assert.match(host, /bundleIdentity === bundleIdentity/);
  assert.match(host, /USER-SELECTED WINDOW · QUATTRO HELPER VERIFIED/);
  assert.doesNotMatch(host, /getUserMedia/);
});

test("WebRTC viewer gates readiness on video and input and releases controls", () => {
  assert.match(viewerHTML, /<video[^>]+autoplay[^>]+muted[^>]+playsinline[^>]+tabindex="0"/);
  assert.match(viewer, /connectionState === "connected"/);
  assert.match(viewer, /inputChannel\?\.readyState === "open"/);
  assert.match(viewer, /firstFrame/);
  assert.match(viewer, /requestVideoFrameCallback/);
  assert.match(viewer, /getStats\(\)/);
  assert.match(viewer, /requestAnimationFrame/);
  assert.match(viewer, /kind: "release-all"/);
  assert.match(viewer, /cancelPendingPointer/);
  assert.match(viewer, /setPointerCapture/);
  assert.match(viewer, /lostpointercapture/);
  assert.match(viewer, /value\.delivered/);
  assert.match(viewer, /performance\.now\(\) - lastFrameAt > 1200/);
  assert.match(viewerHTML, /data-shortcut="menu"/);
  assert.doesNotMatch(viewerHTML, /REAL QUATTRO SESSION/);
});
