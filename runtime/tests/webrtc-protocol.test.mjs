import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeStreamInput,
  encodeStreamInput,
  normalizeSessionDescription,
  normalizeSignalingEnvelope,
  normalizeStreamInput,
} from "../web/webrtc-protocol.mjs";

test("WebRTC signaling accepts only bounded exact SDP envelopes", () => {
  const description = { type: "offer", sdp: "v=0\r\na=ice-ufrag:test\r\n" };
  assert.deepEqual(normalizeSessionDescription(description, "offer"), description);
  assert.deepEqual(normalizeSignalingEnvelope({ schemaVersion: 1, description }, "offer"), {
    schemaVersion: 1,
    description,
  });
  assert.equal(normalizeSessionDescription({ ...description, extra: true }, "offer"), null);
  assert.equal(normalizeSessionDescription({ ...description, type: "answer" }, "offer"), null);
  assert.equal(normalizeSessionDescription({ ...description, sdp: "not-sdp" }, "offer"), null);
  assert.equal(normalizeSignalingEnvelope({ schemaVersion: 2, description }, "offer"), null);
});

test("stream input contract preserves key releases and normalized pointing", () => {
  const events = [
    { kind: "key", sequence: 1, code: "MetaLeft", down: true },
    { kind: "key", sequence: 2, code: "Space", down: false },
    { kind: "pointer", sequence: 3, x: 0.25, y: 0.75, buttons: 1 },
    { kind: "wheel", sequence: 4, deltaX: 0, deltaY: 120 },
    { kind: "release-all", sequence: 5 },
  ];
  for (const event of events) {
    assert.deepEqual(normalizeStreamInput(event), event);
    assert.deepEqual(decodeStreamInput(encodeStreamInput(event)), event);
  }
});

test("stream input rejects malformed, extra, unbounded, and unknown values", () => {
  for (const value of [
    null,
    { kind: "key", sequence: 1, code: "a", down: true },
    { kind: "key", sequence: 1, code: "KeyA", down: true, repeat: false },
    { kind: "pointer", sequence: 1, x: -0.1, y: 0.5, buttons: 0 },
    { kind: "pointer", sequence: 1, x: 0.1, y: 0.5, buttons: 32 },
    { kind: "wheel", sequence: 1, deltaX: 0, deltaY: 0 },
    { kind: "release-all", sequence: 0 },
  ]) {
    assert.equal(normalizeStreamInput(value), null);
  }
  assert.equal(decodeStreamInput("{"), null);
  assert.equal(decodeStreamInput("x".repeat(1025)), null);
});
