import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  convertXwdFile,
  parseXwdHeader,
  STABLE_CAPTURE_MODE,
  XWD_CONTRACT,
  XWD_FILE_BYTES,
  XWD_PIXEL_OFFSET,
  xwdToPpm,
} from "./xwd-to-ppm.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

const HEADER_FIELDS = [
  "headerSize", "fileVersion", "pixmapFormat", "pixmapDepth", "width", "height",
  "xoffset", "byteOrder", "bitmapUnit", "bitmapBitOrder", "bitmapPad",
  "bitsPerPixel", "bytesPerLine", "visualClass", "redMask", "greenMask",
  "blueMask", "bitsPerRgb", "colormapEntries", "colors", "windowWidth",
  "windowHeight", "windowX", "windowY", "windowBorderWidth",
];

function fixture(overrides = {}) {
  const values = {
    headerSize: XWD_CONTRACT.headerSize,
    fileVersion: XWD_CONTRACT.fileVersion,
    pixmapFormat: XWD_CONTRACT.pixmapFormat,
    pixmapDepth: XWD_CONTRACT.pixmapDepth,
    width: XWD_CONTRACT.width,
    height: XWD_CONTRACT.height,
    xoffset: XWD_CONTRACT.xoffset,
    byteOrder: XWD_CONTRACT.byteOrder,
    bitmapUnit: XWD_CONTRACT.bitmapUnit,
    bitmapBitOrder: XWD_CONTRACT.bitmapBitOrder,
    bitmapPad: XWD_CONTRACT.bitmapPad,
    bitsPerPixel: XWD_CONTRACT.bitsPerPixel,
    bytesPerLine: XWD_CONTRACT.bytesPerLine,
    visualClass: XWD_CONTRACT.visualClass,
    redMask: XWD_CONTRACT.redMask,
    greenMask: XWD_CONTRACT.greenMask,
    blueMask: XWD_CONTRACT.blueMask,
    bitsPerRgb: XWD_CONTRACT.bitsPerRgb,
    colormapEntries: XWD_CONTRACT.colormapEntries,
    colors: XWD_CONTRACT.colors,
    windowWidth: XWD_CONTRACT.width,
    windowHeight: XWD_CONTRACT.height,
    windowX: XWD_CONTRACT.windowX,
    windowY: XWD_CONTRACT.windowY,
    windowBorderWidth: XWD_CONTRACT.windowBorderWidth,
    ...overrides,
  };
  const buffer = Buffer.alloc(XWD_FILE_BYTES);
  HEADER_FIELDS.forEach((field, index) => buffer.writeUInt32BE(values[field], index * 4));
  Buffer.from("Xvfb fixture-host:99.0\0").copy(buffer, XWD_CONTRACT.headerBytes);
  return buffer;
}

test("converter parses the big-endian XWD header and LSBFirst masked pixels", () => {
  const xwd = fixture();
  xwd.set([0x33, 0x22, 0x11, 0xaa], XWD_PIXEL_OFFSET);
  xwd.set([0xff, 0x00, 0x80, 0x55], XWD_PIXEL_OFFSET + 4);
  xwd.set([0x03, 0x02, 0x01, 0xff], XWD_FILE_BYTES - 4);
  const header = parseXwdHeader(xwd);
  assert.equal(header.windowName, "Xvfb fixture-host:99.0");
  assert.equal(header.pixelOffset, 3232);
  const { ppm, metadata } = xwdToPpm(xwd);
  const prefix = Buffer.from("P6\n1600 900\n255\n");
  assert.deepEqual(ppm.subarray(0, prefix.length), prefix);
  assert.deepEqual([...ppm.subarray(prefix.length, prefix.length + 6)], [0x11, 0x22, 0x33, 0x80, 0x00, 0xff]);
  assert.deepEqual([...ppm.subarray(-3)], [0x01, 0x02, 0x03]);
  assert.equal(ppm.length, prefix.length + 1600 * 900 * 3);
  assert.deepEqual(metadata, {
    schemaVersion: 1,
    captureMode: "offline-buffer-conversion",
    stabilitySampleCount: 0,
    stabilitySampleSha256: [],
    sourceFormat: "XWD-v7-ZPixmap",
    sourceBytes: XWD_FILE_BYTES,
    sourceSha256: digest(xwd),
    width: 1600,
    height: 900,
    bitsPerPixel: 32,
    bytesPerLine: 6400,
    byteOrder: "LSBFirst",
    redMask: 0x00ff0000,
    greenMask: 0x0000ff00,
    blueMask: 0x000000ff,
    windowName: "Xvfb fixture-host:99.0",
    ppmBytes: ppm.length,
    ppmSha256: digest(ppm),
  });
});

test("converter rejects any incompatible XWD geometry, mask, order, or layout", async (t) => {
  const mutations = [
    ["headerSize", 159],
    ["fileVersion", 6],
    ["pixmapFormat", 1],
    ["pixmapDepth", 32],
    ["width", 1599],
    ["height", 899],
    ["byteOrder", 1],
    ["bitmapPad", 16],
    ["bitsPerPixel", 24],
    ["bytesPerLine", 6396],
    ["visualClass", 5],
    ["redMask", 0x000000ff],
    ["greenMask", 0x00ff0000],
    ["blueMask", 0x0000ff00],
    ["colors", 0],
    ["windowWidth", 1599],
  ];
  for (const [field, value] of mutations) {
    await t.test(field, () => {
      assert.throws(() => parseXwdHeader(fixture({ [field]: value })), new RegExp(`XWD ${field}`));
    });
  }
  assert.throws(() => parseXwdHeader(fixture().subarray(0, -1)), /byte length must be exactly/);
  assert.throws(() => parseXwdHeader(Buffer.concat([fixture(), Buffer.from([0])])), /byte length must be exactly/);
  const badName = fixture();
  badName.fill(0x61, XWD_CONTRACT.headerBytes, XWD_CONTRACT.headerSize);
  assert.throws(() => parseXwdHeader(badName), /unterminated/);
  const badTrailingName = fixture();
  badTrailingName[XWD_CONTRACT.headerSize - 1] = 1;
  assert.throws(() => parseXwdHeader(badTrailingName), /nonzero trailing/);
});

test("file conversion writes exactly one deterministic P6 payload", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "omarchy-xwd-to-ppm-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "Xvfb_screen0");
  const output = path.join(directory, "frame.ppm");
  const xwd = fixture();
  xwd.set([0x30, 0x20, 0x10, 0], XWD_PIXEL_OFFSET);
  await writeFile(input, xwd);
  const xwdSha256 = digest(xwd);
  const capture = {
    mode: STABLE_CAPTURE_MODE,
    sampleSha256: [xwdSha256, xwdSha256],
  };
  const first = await convertXwdFile(input, output, capture);
  const firstBytes = await readFile(output);
  const second = await convertXwdFile(input, output, capture);
  const secondBytes = await readFile(output);
  assert.deepEqual(first, second);
  assert.deepEqual(firstBytes, secondBytes);
  const prefixBytes = Buffer.from("P6\n1600 900\n255\n").length;
  assert.deepEqual([...firstBytes.subarray(prefixBytes, prefixBytes + 3)], [0x10, 0x20, 0x30]);
  assert.equal(first.captureMode, STABLE_CAPTURE_MODE);
  assert.equal(first.stabilitySampleCount, 2);
  assert.deepEqual(first.stabilitySampleSha256, [xwdSha256, xwdSha256]);
  assert.equal(first.sourceSha256, xwdSha256);
  assert.equal(first.ppmSha256, digest(firstBytes));
  await assert.rejects(convertXwdFile(input, input), /paths must differ/);
  await assert.rejects(
    convertXwdFile(input, output, { mode: STABLE_CAPTURE_MODE, sampleSha256: [xwdSha256] }),
    /exactly two samples/,
  );
  await assert.rejects(
    convertXwdFile(input, output, {
      mode: STABLE_CAPTURE_MODE,
      sampleSha256: [xwdSha256, "0".repeat(64)],
    }),
    /differs from the converted XWD bytes/,
  );
});
