#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DIAGNOSTIC_PREFIX = "OMARCHY_RUNTIME_DIAGNOSTIC ";
const DENSE_PRESENT_DIAGNOSTIC_LIMIT = 16;
const DEFAULT_DUPLICATE_WINDOW_MS = 100;

function valueOf(token) {
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(token)) return Number(token);
  return token;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function summarize(values) {
  const sorted = values.filter(Number.isFinite).toSorted((left, right) => left - right);
  if (sorted.length === 0) {
    return { count: 0, min: null, median: null, p95: null, max: null };
  }
  return {
    count: sorted.length,
    min: sorted[0],
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1),
  };
}

export function parseFrameDiagnostics(log) {
  const seen = new Set();
  const events = [];
  let mirroredLinesDropped = 0;

  for (const line of log.split(/\r?\n/)) {
    const prefix = line.indexOf(DIAGNOSTIC_PREFIX);
    if (prefix === -1) continue;
    const payload = line.slice(prefix + DIAGNOSTIC_PREFIX.length).trim();
    if (seen.has(payload)) {
      mirroredLinesDropped += 1;
      continue;
    }
    seen.add(payload);
    const [name, ...tokens] = payload.split(/\s+/);
    const fields = {};
    for (const token of tokens) {
      const separator = token.indexOf("=");
      if (separator <= 0) continue;
      fields[token.slice(0, separator)] = valueOf(token.slice(separator + 1));
    }
    events.push({ name, fields, payload });
  }

  return { events, mirroredLinesDropped };
}

function isDesktop(fields, width, height) {
  return fields.width === width && fields.height === height;
}

function isFullDesktopPresent(event, width, height) {
  return event.name === "sdl-frame-presented" &&
    isDesktop(event.fields, width, height) &&
    event.fields["update-x"] === 0 && event.fields["update-y"] === 0 &&
    event.fields["update-width"] === width && event.fields["update-height"] === height;
}

export function analyzeFramePath(log, {
  width = 1600,
  height = 900,
  duplicateWindowMs = DEFAULT_DUPLICATE_WINDOW_MS,
} = {}) {
  const { events, mirroredLinesDropped } = parseFrameDiagnostics(log);
  const timedEvents = events.filter((event) => Number.isFinite(event.fields["monotonic-ms"]));
  const switches = timedEvents.filter((event) =>
    event.name === "sdl-surface-switch" && isDesktop(event.fields, width, height));
  const presents = timedEvents.filter((event) =>
    event.name === "sdl-frame-presented" && isDesktop(event.fields, width, height));
  const densePresents = presents.filter((event) =>
    Number.isSafeInteger(event.fields.sequence) &&
    event.fields.sequence <= DENSE_PRESENT_DIAGNOSTIC_LIMIT);
  const densePresentationCutoff = densePresents.at(-1)?.fields["monotonic-ms"] ?? -Infinity;
  const switchIntervals = switches.slice(1).map((event, index) =>
    event.fields["monotonic-ms"] - switches[index].fields["monotonic-ms"]);
  const switchWindows = switches.map((event, index) => {
    const start = event.fields["monotonic-ms"];
    const end = switches[index + 1]?.fields["monotonic-ms"] ?? Infinity;
    const windowEvents = timedEvents.filter((candidate) => {
      const at = candidate.fields["monotonic-ms"];
      return at >= start && at < end;
    });
    const textureReused = windowEvents.some((candidate) => candidate.name === "sdl-texture-reused");
    const textureCreated = windowEvents.some((candidate) => candidate.name === "sdl-texture-created");
    const fullPresents = densePresents.filter((candidate) => {
      const at = candidate.fields["monotonic-ms"];
      return at >= start && at < end && isFullDesktopPresent(candidate, width, height);
    });
    return {
      start,
      textureReused,
      textureCreated,
      fullPresents,
      densePresentDiagnosticsAvailable: start <= densePresentationCutoff,
    };
  });
  const measuredReusedWindows = switchWindows.filter((window) =>
    window.textureReused && window.densePresentDiagnosticsAvailable);
  const immediateDoublePresents = measuredReusedWindows.filter((window) =>
    window.fullPresents.length >= 2 &&
    window.fullPresents[1].fields["monotonic-ms"] -
      window.fullPresents[0].fields["monotonic-ms"] <= duplicateWindowMs);
  const duplicateGaps = immediateDoublePresents.map((window) =>
    window.fullPresents[1].fields["monotonic-ms"] -
      window.fullPresents[0].fields["monotonic-ms"]);
  const switchToFirstPresent = switchWindows
    .filter((window) => window.fullPresents.length > 0)
    .map((window) => window.fullPresents[0].fields["monotonic-ms"] - window.start);
  const intervalSummary = summarize(switchIntervals);

  return {
    schemaVersion: 1,
    display: { width, height, pixels: width * height },
    diagnostics: {
      uniqueEvents: events.length,
      mirroredLinesDropped,
      densePresentSequenceLimit: DENSE_PRESENT_DIAGNOSTIC_LIMIT,
      maximumObservedPresentSequence: presents.reduce(
        (maximum, event) => Math.max(maximum, Number(event.fields.sequence) || 0), 0),
    },
    pageflips: {
      observedSwitches: switches.length,
      textureReusedSwitches: switchWindows.filter((window) => window.textureReused).length,
      measuredReusedSwitches: measuredReusedWindows.length,
      measuredReusedSwitchesWithImmediateDoublePresent: immediateDoublePresents.length,
      estimatedAvoidableFullFramePresents: immediateDoublePresents.length,
      estimatedAvoidableUploadedPixels: immediateDoublePresents.length * width * height,
      switchIntervalMs: intervalSummary,
      medianRateHzProxy: intervalSummary.median === null ? null : 1000 / intervalSummary.median,
      switchToFirstPresentMs: summarize(switchToFirstPresent),
      duplicateFollowupGapMs: summarize(duplicateGaps),
    },
  };
}

async function main(paths) {
  if (paths.length === 0) {
    throw new Error("usage: analyze-frame-path.mjs LOG [LOG ...]");
  }
  const results = [];
  for (const path of paths) {
    results.push({ path, analysis: analyzeFramePath(await readFile(path, "utf8")) });
  }
  process.stdout.write(`${JSON.stringify(results.length === 1 ? results[0] : results, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
