import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  validateQcow2BackingFile,
  validateStandaloneQcow2Image,
} from "../qcow2-contract.mjs";
import {
  HIBERNATION_SWAP_VIRTUAL_BYTES,
  qcow2Fixture,
  standaloneQcow2Fixture,
} from "./checkpoint-fixture.mjs";

async function withFixture(t, bytes) {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarchy-qcow2-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "checkpoint-overlay.qcow2");
  await writeFile(filePath, bytes);
  return filePath;
}

test("bounded qcow2 parsing binds the actual relative raw rootfs backing", async (t) => {
  const bytes = qcow2Fixture();
  const filePath = await withFixture(t, bytes);
  assert.deepEqual(await validateQcow2BackingFile(filePath, {
    expectedFilename: "rootfs.ext4",
    expectedFormat: "raw",
    expectedBytes: bytes.byteLength,
    expectedVirtualBytes: 1024 * 1024,
  }), {
    version: 3,
    backingFilename: "rootfs.ext4",
    backingFormat: "raw",
    virtualBytes: 1024 * 1024,
  });
});

test("qcow2 backing validation rejects hostile headers without unbounded reads", async (t) => {
  const hostile = [
    ["magic", () => {
      const bytes = qcow2Fixture();
      bytes.writeUInt32BE(0, 0);
      return bytes;
    }, /not qcow2/],
    ["version", () => {
      const bytes = qcow2Fixture();
      bytes.writeUInt32BE(2, 4);
      return bytes;
    }, /qcow2 v3/],
    ["backing filename", () => qcow2Fixture({ backingFilename: "otherfs.ext4" }), /filename length|filename must/],
    ["backing format", () => qcow2Fixture({ backingFormat: "qcow2" }), /backing format must be raw/],
    ["virtual size", () => qcow2Fixture({ virtualBytes: 2 * 1024 * 1024 }), /virtual size/],
    ["unbounded offset", () => {
      const bytes = qcow2Fixture();
      bytes.writeBigUInt64BE(BigInt(2 * 1024 * 1024), 8);
      return bytes;
    }, /offsets are invalid or unbounded/],
    ["missing terminator", () => {
      const bytes = qcow2Fixture();
      bytes.writeUInt32BE(0x12345678, 128);
      return bytes;
    }, /no extension terminator/],
    ["truncated header", () => Buffer.alloc(32), /header is truncated/],
  ];

  for (const [name, createBytes, expected] of hostile) {
    await t.test(name, async (subtest) => {
      const bytes = createBytes();
      const filePath = await withFixture(subtest, bytes);
      await assert.rejects(validateQcow2BackingFile(filePath, {
        expectedFilename: "rootfs.ext4",
        expectedFormat: "raw",
        expectedBytes: bytes.byteLength,
        expectedVirtualBytes: 1024 * 1024,
      }), expected);
    });
  }
});

test("hibernation swap qcow2 is standalone and exact-sized", async (t) => {
  const bytes = standaloneQcow2Fixture();
  const filePath = await withFixture(t, bytes);
  assert.deepEqual(await validateStandaloneQcow2Image(filePath, {
    expectedBytes: bytes.byteLength,
    expectedVirtualBytes: HIBERNATION_SWAP_VIRTUAL_BYTES,
    label: "hibernation swap image",
  }), {
    version: 3,
    backingFilename: null,
    virtualBytes: HIBERNATION_SWAP_VIRTUAL_BYTES,
  });

  const withBacking = standaloneQcow2Fixture();
  withBacking.writeBigUInt64BE(104n, 8);
  withBacking.writeUInt32BE(4, 16);
  await writeFile(filePath, withBacking);
  await assert.rejects(
    validateStandaloneQcow2Image(filePath, {
      expectedBytes: withBacking.byteLength,
      expectedVirtualBytes: HIBERNATION_SWAP_VIRTUAL_BYTES,
      label: "hibernation swap image",
    }),
    /must not declare a backing file/,
  );
});
