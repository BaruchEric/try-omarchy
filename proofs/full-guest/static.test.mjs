import assert from "node:assert/strict";
import test from "node:test";

import { verifyBuildSpecContract } from "./artifact-integrity.mjs";
import { explicitInputPayloadsForText, FOOT_PROOF_COMMAND, qcodesForCharacter } from "./qmp.mjs";
import {
  compareFrameRegion,
  compareFrames,
  FOOT_OUTPUT_REGION,
  parsePpm,
  parseRecordedCommand,
  qmpActionSessions,
} from "./validate.mjs";

function ppm(fill) {
  const header = Buffer.from("P6\n1600 900\n255\n");
  const pixels = Buffer.alloc(1600 * 900 * 3, fill);
  return Buffer.concat([header, pixels]);
}

test("QMP keyboard mapping covers the exact Foot proof command alphabet", () => {
  const command = `${FOOT_PROOF_COMMAND}\n`;
  for (const character of command) assert.ok(qcodesForCharacter(character).length >= 1, character);
  assert.deepEqual(qcodesForCharacter("i"), ["i"]);
  assert.deepEqual(qcodesForCharacter("|"), ["shift", "backslash"]);
  assert.deepEqual(qcodesForCharacter("\n"), ["ret"]);
});

test("Foot proof input uses explicit ordered key-down and key-up transitions", () => {
  assert.equal(FOOT_PROOF_COMMAND, "id;seq 1 20;id>/dev/virtio-ports/omarchy.web.diagnostics");
  assert.deepEqual(explicitInputPayloadsForText("id"), [
    { events: [
      { type: "key", data: { down: true, key: { type: "qcode", data: "i" } } },
      { type: "key", data: { down: false, key: { type: "qcode", data: "i" } } },
    ] },
    { events: [
      { type: "key", data: { down: true, key: { type: "qcode", data: "d" } } },
      { type: "key", data: { down: false, key: { type: "qcode", data: "d" } } },
    ] },
  ]);
  assert.deepEqual(explicitInputPayloadsForText("\n"), [
    { events: [
      { type: "key", data: { down: true, key: { type: "qcode", data: "ret" } } },
      { type: "key", data: { down: false, key: { type: "qcode", data: "ret" } } },
    ] },
  ]);
  assert.deepEqual(explicitInputPayloadsForText("|"), [
    { events: [
      { type: "key", data: { down: true, key: { type: "qcode", data: "shift" } } },
      { type: "key", data: { down: true, key: { type: "qcode", data: "backslash" } } },
      { type: "key", data: { down: false, key: { type: "qcode", data: "backslash" } } },
      { type: "key", data: { down: false, key: { type: "qcode", data: "shift" } } },
    ] },
  ]);
});

test("artifact contract pins the browser minimum and native-proof recommendation", () => {
  const spec = {
    runtime: {
      kernel: "vmlinuz-linux",
      initramfs: "initramfs-linux.img",
      disk: "rootfs.ext4",
      minimumMemoryMiB: 1024,
      recommendedMemoryMiB: 1536,
    },
    guest: { virtualDisplay: { width: 1600, height: 900 } },
  };
  assert.doesNotThrow(() => verifyBuildSpecContract(spec));
  assert.throws(
    () => verifyBuildSpecContract({ ...spec, runtime: { ...spec.runtime, minimumMemoryMiB: 1536 } }),
    /unexpected guest minimum memory/,
  );
  assert.throws(
    () => verifyBuildSpecContract({ ...spec, runtime: { ...spec.runtime, recommendedMemoryMiB: 2048 } }),
    /unexpected guest recommended memory/,
  );
});

test("PPM parser requires an exact complete 1600x900 QEMU framebuffer", () => {
  const before = parsePpm(ppm(20), "fixture before");
  const afterBuffer = ppm(20);
  afterBuffer.fill(120, afterBuffer.length - 1600 * 900 * 3, afterBuffer.length - 1600 * 800 * 3);
  const after = parsePpm(afterBuffer, "fixture after");
  assert.equal(before.width, 1600);
  assert.ok(compareFrames(before, after) > 0.05);
  assert.throws(() => parsePpm(ppm(20).subarray(0, -1), "truncated"), /truncated or oversized/);
});

test("Foot output delta excludes unrelated pixels outside its interior region", () => {
  const baseline = parsePpm(ppm(20), "region baseline");
  const outsideBuffer = ppm(20);
  const pixelStart = outsideBuffer.length - 1600 * 900 * 3;
  for (let row = 0; row < 900; row += 1) {
    const start = pixelStart + row * 1600 * 3;
    outsideBuffer.fill(120, start, start + 300 * 3);
  }
  const outside = parsePpm(outsideBuffer, "outside change");
  assert.equal(compareFrameRegion(baseline, outside), 0);

  const insideBuffer = ppm(20);
  for (let row = 0; row < 4; row += 1) {
    const start = pixelStart + (((FOOT_OUTPUT_REGION.y + row) * 1600 + FOOT_OUTPUT_REGION.x) * 3);
    insideBuffer.fill(120, start, start + 800 * 3);
  }
  const inside = parsePpm(insideBuffer, "inside change");
  assert.ok(compareFrameRegion(baseline, inside) > 0.0005);
});

test("recorded QEMU command parser decodes only strict printf-q escapes", () => {
  assert.deepEqual(
    parseRecordedCommand("qemu-system-x86_64 -m 1536M -smp 2\\,sockets=1 -append root=/dev/vda\\ rw\\ rootwait\n"),
    ["qemu-system-x86_64", "-m", "1536M", "-smp", "2,sockets=1", "-append", "root=/dev/vda rw rootwait"],
  );
  assert.throws(() => parseRecordedCommand("qemu-system-x86_64 $(bad)\n"), /unsupported shell syntax/);
});

test("QMP action sessions require capabilities first and retain exact order", () => {
  const qmp = [
    { direction: "connect", payload: {} },
    { direction: "send", payload: { execute: "qmp_capabilities" } },
    { direction: "send", payload: { execute: "query-status" } },
    { direction: "disconnect", payload: {} },
    { direction: "connect", payload: {} },
    { direction: "send", payload: { execute: "qmp_capabilities" } },
    { direction: "send", payload: { execute: "quit" } },
    { direction: "disconnect", payload: {} },
  ];
  assert.deepEqual(qmpActionSessions(qmp), [[{ execute: "query-status" }], [{ execute: "quit" }]]);
  assert.throws(() => qmpActionSessions([
    { direction: "connect", payload: {} },
    { direction: "send", payload: { execute: "query-status" } },
    { direction: "disconnect", payload: {} },
  ]), /capabilities negotiation/);
});
