import assert from "node:assert/strict";
import test from "node:test";

import { qcodesForCharacter } from "./qmp.mjs";
import { compareFrames, parsePpm } from "./validate.mjs";

function ppm(fill) {
  const header = Buffer.from("P6\n1600 900\n255\n");
  const pixels = Buffer.alloc(1600 * 900 * 3, fill);
  return Buffer.concat([header, pixels]);
}

test("QMP keyboard mapping covers the exact Foot proof command alphabet", () => {
  const command = "id\n";
  for (const character of command) assert.ok(qcodesForCharacter(character).length >= 1, character);
  assert.deepEqual(qcodesForCharacter("i"), ["i"]);
  assert.deepEqual(qcodesForCharacter("\n"), ["ret"]);
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
