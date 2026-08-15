#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function nextToken(buffer, state) {
  while (state.cursor < buffer.length) {
    const byte = buffer[state.cursor];
    if (byte === 35) {
      while (state.cursor < buffer.length && buffer[state.cursor] !== 10) state.cursor += 1;
    } else if ([9, 10, 13, 32].includes(byte)) {
      state.cursor += 1;
    } else {
      break;
    }
  }
  const start = state.cursor;
  while (state.cursor < buffer.length && ![9, 10, 13, 32, 35].includes(buffer[state.cursor])) state.cursor += 1;
  return buffer.subarray(start, state.cursor).toString("ascii");
}

export function analyzePpm(buffer) {
  const state = { cursor: 0 };
  const magic = nextToken(buffer, state);
  const width = Number(nextToken(buffer, state));
  const height = Number(nextToken(buffer, state));
  const maximum = Number(nextToken(buffer, state));
  while (state.cursor < buffer.length && [9, 10, 13, 32].includes(buffer[state.cursor])) state.cursor += 1;
  const pixels = buffer.subarray(state.cursor);
  const payloadMatches = Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && pixels.length === width * height * 3;
  const topRows = payloadMatches ? Math.min(height, 64) : 0;
  let alertRed = 0;
  let nonBlack = 0;
  if (payloadMatches) {
    for (let offset = 0; offset < pixels.length; offset += 3) {
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      if (red > 8 || green > 8 || blue > 8) nonBlack += 1;
      if (offset < width * topRows * 3 && red >= 128 && red >= green + 48 && red >= blue + 32) alertRed += 1;
    }
  }
  const topAlertRedRatio = topRows > 0 ? alertRed / (width * topRows) : 1;
  const nonBlackRatio = payloadMatches ? nonBlack / (width * height) : 0;
  const result = {
    schemaVersion: 1,
    magic,
    width,
    height,
    maximum,
    payloadBytes: pixels.length,
    payloadMatches,
    nonBlackRatio,
    topRows,
    topAlertRedPixels: alertRed,
    topAlertRedRatio,
  };
  result.clean = magic === "P6" && width === 1600 && height === 900 && maximum === 255 && payloadMatches && nonBlackRatio >= 0.05 && topAlertRedRatio < 0.005;
  return result;
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("usage: frame-health.mjs FRAME.ppm");
  const result = analyzePpm(await readFile(file));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.clean) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`PREBOOT_FRAME_HEALTH_FAIL ${error.message}\n`);
    process.exitCode = 1;
  });
}
