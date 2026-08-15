#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateBrowserPerformanceTrace } from "./gate.mjs";

export async function evaluateTraceFiles(tracePath, identityPath, targetsPath = null) {
  const trace = JSON.parse(await readFile(resolve(tracePath), "utf8"));
  const expectedIdentity = JSON.parse(await readFile(resolve(identityPath), "utf8"));
  const targets = targetsPath === null
    ? {}
    : JSON.parse(await readFile(resolve(targetsPath), "utf8"));
  return evaluateBrowserPerformanceTrace(trace, targets, expectedIdentity);
}

async function main() {
  const [tracePath, identityPath, targetsPath] = process.argv.slice(2);
  if (!tracePath || !identityPath || process.argv.length > 5) {
    throw new Error(
      "usage: evaluate.mjs TRACE.json EXPECTED_IDENTITY.json [TARGETS.json]",
    );
  }
  const evidence = await evaluateTraceFiles(tracePath, identityPath, targetsPath ?? null);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (evidence.verdict !== "PASS") process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`BROWSER_PERFORMANCE_FAIL ${error.message}\n`);
    process.exitCode = 1;
  });
}
