import assert from "node:assert/strict";
import test from "node:test";
import { validateInputObserverEvidence } from "./validate-input-observer.mjs";

const device = () => ({
  schemaVersion: 1,
  deviceName: "QEMU Virtio Keyboard",
  eventDevice: "/dev/input/event4",
  sysfsEvent: "/sys/class/input/event4",
  mode: "crw-rw----",
  uid: 0,
  gid: 991,
  udevProperties: {
    DEVNAME: "/dev/input/event4",
    ID_INPUT: "1",
    ID_INPUT_KEYBOARD: "1",
    TAGS: ":seat:uaccess:",
  },
  nonExclusiveRead: true,
});

const event = () => ({
  schemaVersion: 1,
  status: "observed",
  eventDevice: "/dev/input/event4",
  expectedSequence: [
    { code: 125, value: 1 },
    { code: 28, value: 1 },
    { code: 28, value: 0 },
    { code: 125, value: 0 },
  ],
  records: [
    { seconds: 1, microseconds: 1, type: 1, code: 125, value: 0 },
    { seconds: 2, microseconds: 1, type: 1, code: 125, value: 1 },
    { seconds: 2, microseconds: 2, type: 1, code: 28, value: 1 },
    { seconds: 2, microseconds: 3, type: 0, code: 0, value: 0 },
    { seconds: 2, microseconds: 4, type: 1, code: 28, value: 0 },
    { seconds: 2, microseconds: 5, type: 1, code: 125, value: 0 },
  ],
  nonExclusiveRead: true,
});

test("input observer accepts exact non-exclusive Virtio keyboard delivery", () => {
  assert.equal(validateInputObserverEvidence(device(), event()).status, "PASS");
});

test("input observer rejects wrong key order and missing keyboard classification", () => {
  const wrongOrder = event();
  [wrongOrder.records[2], wrongOrder.records[4]] = [wrongOrder.records[4], wrongOrder.records[2]];
  assert.throws(() => validateInputObserverEvidence(device(), wrongOrder), /ordering/);
  const unclassified = device();
  delete unclassified.udevProperties.ID_INPUT_KEYBOARD;
  assert.throws(() => validateInputObserverEvidence(unclassified, event()));
});
