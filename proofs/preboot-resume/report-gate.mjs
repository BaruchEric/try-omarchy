#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const verificationUrl = process.env.OMARCHY_REPO_ROOT
  ? pathToFileURL(path.join(process.env.OMARCHY_REPO_ROOT, "scripts/verification/verify-guest-report.mjs"))
  : new URL("../../scripts/verification/verify-guest-report.mjs", import.meta.url);
const markerUrl = process.env.OMARCHY_REPO_ROOT
  ? pathToFileURL(path.join(process.env.OMARCHY_REPO_ROOT, "scripts/verification/diagnostic-markers.mjs"))
  : new URL("../../scripts/verification/diagnostic-markers.mjs", import.meta.url);
const { verifyGuestReport } = await import(verificationUrl);
const { parseUniqueDiagnosticMarker } = await import(markerUrl);

const [diagnosticsPath, manifestPath] = process.argv.slice(2);
if (!diagnosticsPath || !manifestPath) throw new Error("usage: report-gate.mjs DIAGNOSTICS GUEST_MANIFEST");
const [diagnostics, manifest] = await Promise.all([
  readFile(diagnosticsPath, "utf8"),
  readFile(manifestPath, "utf8").then(JSON.parse),
]);
const prefix = "OMARCHY_GUEST_REPORT ";
const report = parseUniqueDiagnosticMarker(diagnostics, prefix);
const result = await verifyGuestReport(report, { manifest });
if (!result.passed) throw new Error(`guest report verification failed: ${JSON.stringify(result.toJSON())}`);
if (report.provenance?.commit !== manifest.upstream?.commit) throw new Error("guest report provenance differs from manifest");
const monitor = report.commands?.find((command) => command.argv?.join(" ") === "hyprctl monitors -j");
if (monitor?.exitCode !== 0) throw new Error("guest report lacks successful Hyprland monitor query");
const monitors = JSON.parse(monitor.stdout).filter((candidate) => candidate.disabled !== true);
if (monitors.length !== 1 || monitors[0].width !== 1600 || monitors[0].height !== 900) {
  throw new Error(`guest report monitor shape is not 1600x900: ${JSON.stringify(monitors)}`);
}
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: "PASS", report: result.toJSON(), provenance: report.provenance, monitor: monitors[0] }, null, 2)}\n`);
