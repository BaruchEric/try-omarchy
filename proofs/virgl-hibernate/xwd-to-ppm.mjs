#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const XWD_CONTRACT = Object.freeze({
  headerBytes: 100,
  headerSize: 160,
  fileVersion: 7,
  pixmapFormat: 2,
  pixmapDepth: 24,
  width: 1600,
  height: 900,
  xoffset: 0,
  byteOrder: 0,
  bitmapUnit: 32,
  bitmapBitOrder: 0,
  bitmapPad: 32,
  bitsPerPixel: 32,
  bytesPerLine: 6400,
  visualClass: 4,
  redMask: 0x00ff0000,
  greenMask: 0x0000ff00,
  blueMask: 0x000000ff,
  bitsPerRgb: 8,
  colormapEntries: 256,
  colors: 256,
  colorBytes: 12,
  windowX: 0,
  windowY: 0,
  windowBorderWidth: 0,
});

const HEADER_FIELDS = Object.freeze([
  "headerSize",
  "fileVersion",
  "pixmapFormat",
  "pixmapDepth",
  "width",
  "height",
  "xoffset",
  "byteOrder",
  "bitmapUnit",
  "bitmapBitOrder",
  "bitmapPad",
  "bitsPerPixel",
  "bytesPerLine",
  "visualClass",
  "redMask",
  "greenMask",
  "blueMask",
  "bitsPerRgb",
  "colormapEntries",
  "colors",
  "windowWidth",
  "windowHeight",
  "windowX",
  "windowY",
  "windowBorderWidth",
]);

export const XWD_PIXEL_OFFSET =
  XWD_CONTRACT.headerSize + XWD_CONTRACT.colors * XWD_CONTRACT.colorBytes;
export const XWD_FILE_BYTES =
  XWD_PIXEL_OFFSET + XWD_CONTRACT.bytesPerLine * XWD_CONTRACT.height;
export const STABLE_CAPTURE_MODE = "xvfb-fbdir-sigstop-copy-stable-pair";

const digest = (value) => createHash("sha256").update(value).digest("hex");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function parseXwdHeader(buffer) {
  invariant(Buffer.isBuffer(buffer), "XWD input must be a Buffer");
  invariant(buffer.length === XWD_FILE_BYTES,
    `XWD byte length must be exactly ${XWD_FILE_BYTES}, got ${buffer.length}`);
  const header = Object.fromEntries(
    HEADER_FIELDS.map((field, index) => [field, buffer.readUInt32BE(index * 4)]),
  );
  for (const [field, expected] of Object.entries({
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
  })) {
    invariant(header[field] === expected,
      `XWD ${field} must be exactly ${expected}, got ${header[field]}`);
  }
  const nameBytes = buffer.subarray(XWD_CONTRACT.headerBytes, header.headerSize);
  const nul = nameBytes.indexOf(0);
  invariant(nul >= 5, "XWD window name is missing or unterminated");
  const windowName = nameBytes.subarray(0, nul).toString("utf8");
  invariant(windowName.startsWith("Xvfb "), "XWD window name is not an Xvfb framebuffer");
  invariant(nameBytes.subarray(nul + 1).every((byte) => byte === 0),
    "XWD fixed window-name slot has nonzero trailing bytes");
  return Object.freeze({ ...header, windowName, pixelOffset: XWD_PIXEL_OFFSET });
}

function captureFields(sourceSha256, capture = undefined) {
  if (capture === undefined) {
    return Object.freeze({
      captureMode: "offline-buffer-conversion",
      stabilitySampleCount: 0,
      stabilitySampleSha256: Object.freeze([]),
    });
  }
  invariant(capture?.mode === STABLE_CAPTURE_MODE,
    `capture mode must be exactly ${STABLE_CAPTURE_MODE}`);
  invariant(Array.isArray(capture.sampleSha256) && capture.sampleSha256.length === 2,
    "stable capture must bind exactly two samples");
  for (const sample of capture.sampleSha256) {
    invariant(/^[0-9a-f]{64}$/.test(sample), "stable capture sample SHA-256 is invalid");
    invariant(sample === sourceSha256,
      "stable capture sample SHA-256 differs from the converted XWD bytes");
  }
  return Object.freeze({
    captureMode: capture.mode,
    stabilitySampleCount: 2,
    stabilitySampleSha256: Object.freeze([...capture.sampleSha256]),
  });
}

export function xwdToPpm(buffer, capture = undefined) {
  const header = parseXwdHeader(buffer);
  const ppmHeader = Buffer.from(`P6\n${header.width} ${header.height}\n255\n`, "ascii");
  const ppm = Buffer.allocUnsafe(ppmHeader.length + header.width * header.height * 3);
  ppmHeader.copy(ppm);
  let target = ppmHeader.length;
  for (let y = 0; y < header.height; y += 1) {
    let source = header.pixelOffset + y * header.bytesPerLine;
    for (let x = 0; x < header.width; x += 1, source += 4) {
      const pixel = buffer.readUInt32LE(source);
      ppm[target++] = (pixel & header.redMask) >>> 16;
      ppm[target++] = (pixel & header.greenMask) >>> 8;
      ppm[target++] = pixel & header.blueMask;
    }
  }
  invariant(target === ppm.length, "internal PPM conversion length mismatch");
  const sourceSha256 = digest(buffer);
  const ppmSha256 = digest(ppm);
  return Object.freeze({
    ppm,
    metadata: Object.freeze({
      schemaVersion: 1,
      ...captureFields(sourceSha256, capture),
      sourceFormat: "XWD-v7-ZPixmap",
      sourceBytes: buffer.length,
      sourceSha256,
      width: header.width,
      height: header.height,
      bitsPerPixel: header.bitsPerPixel,
      bytesPerLine: header.bytesPerLine,
      byteOrder: "LSBFirst",
      redMask: header.redMask,
      greenMask: header.greenMask,
      blueMask: header.blueMask,
      windowName: header.windowName,
      ppmBytes: ppm.length,
      ppmSha256,
    }),
  });
}

export async function convertXwdFile(inputPath, outputPath, capture = undefined) {
  invariant(path.resolve(inputPath) !== path.resolve(outputPath),
    "XWD input and PPM output paths must differ");
  const inputStat = await stat(inputPath);
  invariant(inputStat.isFile(), "XWD input is not a regular file");
  invariant(inputStat.size === XWD_FILE_BYTES,
    `XWD file size must be exactly ${XWD_FILE_BYTES}, got ${inputStat.size}`);
  const { ppm, metadata } = xwdToPpm(await readFile(inputPath), capture);
  await writeFile(outputPath, ppm);
  return metadata;
}

async function main() {
  const [inputPath, outputPath, firstSampleSha256, secondSampleSha256, ...extra] = process.argv.slice(2);
  if (!inputPath || !outputPath || !firstSampleSha256 || !secondSampleSha256 || extra.length !== 0) {
    throw new Error("usage: xwd-to-ppm.mjs XVFB_SCREEN.xwd OUTPUT.ppm SAMPLE_1_SHA256 SAMPLE_2_SHA256");
  }
  const metadata = await convertXwdFile(inputPath, outputPath, {
    mode: STABLE_CAPTURE_MODE,
    sampleSha256: [firstSampleSha256, secondSampleSha256],
  });
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`VIRGL_HIBERNATE_XWD_CONVERSION_FAIL ${error.message}\n`);
    process.exitCode = 1;
  });
}
