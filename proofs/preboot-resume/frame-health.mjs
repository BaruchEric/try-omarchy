#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DISPLAY_WIDTH = 1600;
const DISPLAY_HEIGHT = 900;
const SHELL_RESERVATION_ROWS = 39;

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
  const separator = buffer[state.cursor];
  const separatorValid = [9, 10, 13, 32].includes(separator);
  if (separatorValid) state.cursor += separator === 13 && buffer[state.cursor + 1] === 10 ? 2 : 1;
  const pixels = buffer.subarray(state.cursor);
  const payloadMatches = Number.isInteger(width)
    && Number.isInteger(height)
    && width > 0
    && height > 0
    && pixels.length === width * height * 3;
  const colors = new Map();
  const reservationColors = new Map();
  const topRows = payloadMatches ? Math.min(height, 64) : 0;
  let alertRed = 0;
  let nonBlack = 0;
  let lumaSum = 0;
  let lumaSquareSum = 0;
  let reservationLumaSum = 0;
  let bodyLumaSum = 0;
  if (payloadMatches) {
    for (let offset = 0; offset < pixels.length; offset += 3) {
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const color = (red << 16) | (green << 8) | blue;
      colors.set(color, (colors.get(color) ?? 0) + 1);
      if (red > 8 || green > 8 || blue > 8) nonBlack += 1;
      if (offset < width * topRows * 3 && red >= 128 && red >= green + 48 && red >= blue + 32) alertRed += 1;
      const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      lumaSum += luma;
      lumaSquareSum += luma * luma;
      const row = Math.floor(offset / (width * 3));
      if (row < SHELL_RESERVATION_ROWS) {
        reservationColors.set(color, (reservationColors.get(color) ?? 0) + 1);
        reservationLumaSum += luma;
      } else {
        bodyLumaSum += luma;
      }
    }
  }
  const pixelCount = payloadMatches ? width * height : 0;
  const reservationPixelCount = payloadMatches ? width * SHELL_RESERVATION_ROWS : 0;
  const bodyPixelCount = pixelCount - reservationPixelCount;
  let dominantPixels = 0;
  let dominantReservationPixels = 0;
  for (const count of colors.values()) dominantPixels = Math.max(dominantPixels, count);
  for (const count of reservationColors.values()) dominantReservationPixels = Math.max(dominantReservationPixels, count);
  if (colors.size === 0) dominantPixels = pixelCount;
  if (reservationColors.size === 0) dominantReservationPixels = reservationPixelCount;
  const meanLuma = pixelCount > 0 ? lumaSum / pixelCount : 0;
  const lumaStandardDeviation = pixelCount > 0
    ? Math.sqrt(Math.max(0, lumaSquareSum / pixelCount - meanLuma * meanLuma))
    : 0;
  const reservationMeanLuma = reservationPixelCount > 0 ? reservationLumaSum / reservationPixelCount : 0;
  const bodyMeanLuma = bodyPixelCount > 0 ? bodyLumaSum / bodyPixelCount : 0;
  const topAlertRedRatio = topRows > 0 ? alertRed / (width * topRows) : 1;
  const nonBlackRatio = pixelCount > 0 ? nonBlack / pixelCount : 0;
  const thresholds = {
    maximumTopAlertRedRatio: 0.02,
    minimumNonBlackRatio: 0.05,
    minimumUniqueColors: 1024,
    maximumDominantPixelRatio: 0.95,
    minimumLumaStandardDeviation: 12,
    minimumReservationUniqueColors: 16,
    minimumReservationDominantPixelRatio: 0.15,
    minimumReservationBodyLumaDifference: 5,
  };
  const visualShellReservation = {
    rows: SHELL_RESERVATION_ROWS,
    uniqueColors: reservationColors.size,
    dominantPixelRatio: reservationPixelCount > 0 ? dominantReservationPixels / reservationPixelCount : 1,
    meanLuma: reservationMeanLuma,
    bodyMeanLuma,
    absoluteMeanLumaDifference: Math.abs(bodyMeanLuma - reservationMeanLuma),
  };
  const visualShellReservationHealthy = visualShellReservation.uniqueColors >= thresholds.minimumReservationUniqueColors
    && visualShellReservation.dominantPixelRatio >= thresholds.minimumReservationDominantPixelRatio
    && visualShellReservation.absoluteMeanLumaDifference >= thresholds.minimumReservationBodyLumaDifference;
  const result = {
    schemaVersion: 2,
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
    uniqueColors: colors.size,
    dominantPixelRatio: pixelCount > 0 ? dominantPixels / pixelCount : 1,
    meanLuma,
    lumaStandardDeviation,
    visualShellReservation,
    visualShellReservationHealthy,
    thresholds,
  };
  result.clean = magic === "P6"
    && width === DISPLAY_WIDTH
    && height === DISPLAY_HEIGHT
    && maximum === 255
    && separatorValid
    && payloadMatches
    && nonBlackRatio >= thresholds.minimumNonBlackRatio
    && topAlertRedRatio < thresholds.maximumTopAlertRedRatio
    && colors.size >= thresholds.minimumUniqueColors
    && result.dominantPixelRatio <= thresholds.maximumDominantPixelRatio
    && lumaStandardDeviation >= thresholds.minimumLumaStandardDeviation
    && visualShellReservationHealthy;
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
