#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  VerificationResult,
  finishCli,
  isFullGitSha,
  isIsoDate,
  isSha256,
  numeric,
  parseArguments,
  readContract,
  readJson,
} from "./lib.mjs";

function atMost(value, threshold) {
  return numeric(value) && value <= threshold;
}

function atLeast(value, threshold) {
  return numeric(value) && value >= threshold;
}

export async function verifyRuntimeReport(report) {
  const contract = await readContract();
  const thresholds = contract.thresholds;
  const result = new VerificationResult("five-minute runtime report");
  const environment = report?.environment;
  const authenticity = report?.authenticity;
  const display = report?.display;
  const input = report?.input;
  const journey = Array.isArray(report?.journey) ? report.journey : [];
  const performance = report?.performance;

  result.check(
    "RUNTIME-001",
    report?.schemaVersion === 1 && isIsoDate(report?.generatedAt),
    "report schema and generation timestamp are valid",
  );
  if (report?.artifactManifestSha256 !== undefined) {
    result.check(
      "RUNTIME-002",
      isSha256(report.artifactManifestSha256),
      "artifact manifest digest is a SHA-256",
    );
  }

  result.check(
    "WEB-001",
    environment?.crossOriginIsolated === true &&
      environment?.sharedArrayBuffer === true &&
      typeof environment?.browser === "string" &&
      environment.browser.length > 0 &&
      typeof environment?.browserVersion === "string" &&
      environment.browserVersion.length > 0,
    "browser run is cross-origin isolated with SharedArrayBuffer",
    environment,
  );
  result.check(
    "AUTH-004",
    authenticity?.evidenceSource === "guest-agent" &&
      authenticity?.guestArchitecture === "x86_64" &&
      isFullGitSha(authenticity?.omarchyCommit) &&
      authenticity?.framebufferSource === "qemu-guest",
    "identity comes from the guest agent and pixels come from QEMU",
    authenticity,
  );

  const expectedBackingWidth = Math.round(
    (display?.canvasCssWidth ?? Number.NaN) *
      (environment?.devicePixelRatio ?? Number.NaN),
  );
  const expectedBackingHeight = Math.round(
    (display?.canvasCssHeight ?? Number.NaN) *
      (environment?.devicePixelRatio ?? Number.NaN),
  );
  result.check(
    "DISP-001",
    display?.guestWidth === thresholds.guestWidth &&
      display?.guestHeight === thresholds.guestHeight &&
      display?.canvasBackingWidth === expectedBackingWidth &&
      display?.canvasBackingHeight === expectedBackingHeight &&
      display?.framebufferPixelFormat === "xrgb8888",
    "guest resolution and canvas backing store are device-pixel-correct",
    {
      display,
      expectedBackingWidth,
      expectedBackingHeight,
    },
  );

  const inputCapabilities = [
    "keyboard",
    "modifiers",
    "pointerMotion",
    "pointerButtons",
    "wheel",
    "focusRecovery",
    "shortcutAlternative",
  ];
  const missingInputs = inputCapabilities.filter(
    (capability) => input?.[capability] !== true,
  );
  result.check(
    "INP-001",
    missingInputs.length === 0,
    "required input paths were exercised successfully",
    { missingInputs },
  );
  result.check(
    "INP-002",
    atMost(performance?.inputLatencyP95Ms, thresholds.inputLatencyP95Ms),
    `input-to-frame p95 is at most ${thresholds.inputLatencyP95Ms} ms`,
    performance?.inputLatencyP95Ms,
  );

  const journeyById = new Map(journey.map((step) => [step?.id, step]));
  const failedJourneySteps = contract.journeySteps.filter((id) => {
    const step = journeyById.get(id);
    return !step || step.passed !== true || step.guestAck !== true;
  });
  result.check(
    "RUN-001",
    failedJourneySteps.length === 0 &&
      atLeast(report?.durationMs, thresholds.minimumJourneyMs) &&
      atMost(report?.durationMs, thresholds.maximumJourneyMs),
    "the complete five-minute journey passed with guest acknowledgement",
    {
      failedJourneySteps,
      durationMs: report?.durationMs,
      permittedDurationMs: [
        thresholds.minimumJourneyMs,
        thresholds.maximumJourneyMs,
      ],
    },
  );
  result.check(
    "BOOT-001",
    atMost(performance?.coldDesktopReadyMs, thresholds.coldDesktopReadyMs),
    `cold desktop-ready is at most ${thresholds.coldDesktopReadyMs} ms`,
    performance?.coldDesktopReadyMs,
  );
  result.check(
    "BOOT-002",
    atMost(performance?.cachedDesktopReadyMs, thresholds.cachedDesktopReadyMs),
    `cached desktop-ready is at most ${thresholds.cachedDesktopReadyMs} ms`,
    performance?.cachedDesktopReadyMs,
  );
  result.check(
    "PERF-001",
    atLeast(performance?.fpsP05, thresholds.fpsP05) &&
      atLeast(performance?.fpsP50, thresholds.fpsP50),
    `frame rate is at least ${thresholds.fpsP05} FPS p05 and ${thresholds.fpsP50} FPS p50`,
    { p05: performance?.fpsP05, p50: performance?.fpsP50 },
  );
  result.check(
    "PERF-002",
    atMost(performance?.memoryPeakMiB, thresholds.memoryPeakMiB) &&
      performance?.runtimeCrashCount === thresholds.runtimeCrashCount,
    `peak memory is at most ${thresholds.memoryPeakMiB} MiB with no runtime crash`,
    {
      memoryPeakMiB: performance?.memoryPeakMiB,
      runtimeCrashCount: performance?.runtimeCrashCount,
    },
  );
  result.check(
    "PERF-003",
    atMost(
      performance?.longestBlackFrameMs,
      thresholds.longestBlackFrameMs,
    ),
    `longest post-ready black frame is at most ${thresholds.longestBlackFrameMs} ms`,
    performance?.longestBlackFrameMs,
  );
  result.check(
    "WEB-003",
    performance?.consoleErrorCount === thresholds.consoleErrorCount &&
      performance?.pageErrorCount === 0 &&
      performance?.unexpectedGuestNetworkRequests === 0,
    "run has no browser errors or unexpected guest network traffic",
    {
      consoleErrorCount: performance?.consoleErrorCount,
      pageErrorCount: performance?.pageErrorCount,
      unexpectedGuestNetworkRequests:
        performance?.unexpectedGuestNetworkRequests,
    },
  );

  return result;
}

async function main() {
  const { values, positional } = parseArguments(process.argv.slice(2), {
    json: "boolean",
  });
  if (!positional[0]) {
    throw new Error("Usage: verify-runtime-report.mjs <report.json> [--json]");
  }
  const report = await readJson(path.resolve(positional[0]));
  const result = await verifyRuntimeReport(report);
  finishCli(result, { json: values.json });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
