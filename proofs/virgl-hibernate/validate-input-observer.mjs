#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEVICE_NAME = "QEMU Virtio Keyboard";
const EXPECTED_SEQUENCE = [
  { code: 125, value: 1 },
  { code: 28, value: 1 },
  { code: 28, value: 0 },
  { code: 125, value: 0 },
];

const exactKeys = (value, keys, label) => {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} keys differ`);
};

export function validateInputObserverEvidence(device, event) {
  exactKeys(device, [
    "schemaVersion", "deviceName", "eventDevice", "sysfsEvent", "mode", "uid", "gid",
    "udevProperties", "nonExclusiveRead",
  ], "input device report");
  assert.equal(device.schemaVersion, 1);
  assert.equal(device.deviceName, DEVICE_NAME);
  assert.match(device.eventDevice, /^\/dev\/input\/event[0-9]+$/);
  assert.match(device.sysfsEvent, /^\/sys\/class\/input\/event[0-9]+$/);
  assert.match(device.mode, /^c[-rwxSsTt]{9}$/);
  assert.ok(Number.isInteger(device.uid) && device.uid >= 0);
  assert.ok(Number.isInteger(device.gid) && device.gid >= 0);
  assert.equal(device.nonExclusiveRead, true);
  assert.equal(typeof device.udevProperties, "object");
  assert.ok(device.udevProperties !== null && !Array.isArray(device.udevProperties));
  for (const value of Object.values(device.udevProperties)) assert.equal(typeof value, "string");
  assert.equal(device.udevProperties.DEVNAME, device.eventDevice);
  assert.equal(device.udevProperties.ID_INPUT, "1");
  assert.equal(device.udevProperties.ID_INPUT_KEYBOARD, "1");

  exactKeys(event, [
    "schemaVersion", "status", "eventDevice", "expectedSequence", "records", "nonExclusiveRead",
  ], "input event report");
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.status, "observed");
  assert.equal(event.eventDevice, device.eventDevice);
  assert.deepEqual(event.expectedSequence, EXPECTED_SEQUENCE);
  assert.equal(event.nonExclusiveRead, true);
  assert.ok(Array.isArray(event.records) && event.records.length > 0 && event.records.length <= 32);
  const keys = [];
  for (const record of event.records) {
    exactKeys(record, ["seconds", "microseconds", "type", "code", "value"], "input event record");
    assert.ok(Number.isSafeInteger(record.seconds) && record.seconds >= 0);
    assert.ok(Number.isInteger(record.microseconds) && record.microseconds >= 0 && record.microseconds < 1_000_000);
    assert.ok(record.type === 0 || record.type === 1);
    assert.ok(Number.isInteger(record.code) && record.code >= 0);
    assert.ok(Number.isInteger(record.value));
    if (record.type === 1) {
      assert.ok(record.code === 28 || record.code === 125);
      assert.ok(record.value === 0 || record.value === 1 || record.value === 2);
      keys.push({ code: record.code, value: record.value });
    }
  }
  let matched = 0;
  for (const key of keys) {
    if (key.code === EXPECTED_SEQUENCE[matched].code && key.value === EXPECTED_SEQUENCE[matched].value) {
      matched += 1;
      if (matched === EXPECTED_SEQUENCE.length) break;
    } else if (key.code === EXPECTED_SEQUENCE[0].code && key.value === EXPECTED_SEQUENCE[0].value) {
      matched = 1;
    }
  }
  assert.equal(matched, EXPECTED_SEQUENCE.length,
    "input event records do not contain exact Left Meta plus Enter press/release ordering");
  return {
    schemaVersion: 1,
    status: "PASS",
    eventDevice: device.eventDevice,
    expectedSequence: EXPECTED_SEQUENCE,
  };
}

async function main() {
  const [devicePath, eventPath] = process.argv.slice(2);
  if (!devicePath || !eventPath) {
    throw new Error("usage: validate-input-observer.mjs DEVICE_REPORT EVENT_REPORT");
  }
  const [device, event] = await Promise.all([
    readFile(devicePath, "utf8").then(JSON.parse),
    readFile(eventPath, "utf8").then(JSON.parse),
  ]);
  process.stdout.write(`${JSON.stringify(validateInputObserverEvidence(device, event), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
