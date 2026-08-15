#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { compareFrameRegion, FOOT_OUTPUT_REGION, parsePpm } from "./validate.mjs";

const [beforePath, afterPath, minimumText] = process.argv.slice(2);
const minimum = Number(minimumText);

if (!beforePath || !afterPath || !Number.isFinite(minimum) || minimum <= 0 || minimum >= 1) {
  throw new Error("Usage: frame-delta.mjs BEFORE_PPM AFTER_PPM MINIMUM_RATIO");
}

const [beforeBuffer, afterBuffer] = await Promise.all([readFile(beforePath), readFile(afterPath)]);
const ratio = compareFrameRegion(
  parsePpm(beforeBuffer, "frame-delta baseline"),
  parsePpm(afterBuffer, "frame-delta candidate"),
);
const passed = ratio >= minimum;

process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: passed ? "PASS" : "FAIL", ratio, minimum, region: FOOT_OUTPUT_REGION }, null, 2)}\n`);
if (!passed) process.exitCode = 1;
