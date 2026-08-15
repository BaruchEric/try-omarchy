#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const validationUrl = process.env.OMARCHY_REPO_ROOT
  ? pathToFileURL(path.join(process.env.OMARCHY_REPO_ROOT, "proofs/full-guest/validate.mjs"))
  : new URL("../full-guest/validate.mjs", import.meta.url);
const { compareFrameRegion, FOOT_OUTPUT_REGION, parsePpm } = await import(validationUrl);

const [beforePath, afterPath, mode, thresholdText] = process.argv.slice(2);
const threshold = Number(thresholdText);
if (!beforePath || !afterPath || !["minimum", "maximum"].includes(mode) || !Number.isFinite(threshold) || threshold < 0 || threshold >= 1) {
  throw new Error("usage: frame-change.mjs BEFORE_PPM AFTER_PPM minimum|maximum THRESHOLD");
}
const [before, after] = await Promise.all([readFile(beforePath), readFile(afterPath)]);
const ratio = compareFrameRegion(parsePpm(before, "baseline"), parsePpm(after, "candidate"));
const passed = mode === "minimum" ? ratio >= threshold : ratio <= threshold;
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: passed ? "PASS" : "FAIL", mode, ratio, threshold, region: FOOT_OUTPUT_REGION }, null, 2)}\n`);
if (!passed) process.exitCode = 1;
